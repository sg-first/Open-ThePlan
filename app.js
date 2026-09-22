/* ============================================================
   The Plan — 美术效果 three.js 还原
   数据来源：Unity 4.5.5p5 构建产物 (The Plan_Data) 直接解析
     scene.json  : 场景图 / 材质 / 相机 / 灯光 / 渲染设置
     mesh/*.json : 网格（顶点已转到 three.js 右手坐标系）
     tex/*.png   : 贴图（含 alpha）
   渲染管线按原版重建：
     15 级 renderQueue 手工深度分层 → HDR → BrightPass → 可分离模糊 → 合成(暗角/颗粒/色差)
   ============================================================ */
(function () {
'use strict';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------------------------------------------------------
   0. 状态
   --------------------------------------------------------------- */
const S = {
  fovScale: 1.0, sens: 1.0,
  pp: true, bloom: 0.55, brightThr: 0.88, vig: 0.5, grain: 0.022, ca: 0.4,
  wave: true, waveAmp: 0.5, waveSpd: 1.0, scroll: 1.0,
  ambMul: 1.0, plMul: 1.0,
  sortByQueue: true, wire: false,
  tour: false, loaded: false,
};

let renderer, scene, camera3, clock, envData;
const texCache = new Map();      // path -> THREE.Texture
const meshCache = new Map();     // path -> BufferGeometry
const matCache = new Map();      // materialName -> {mat, def}
const waveMats = [];             // 需要每帧更新 uTime 的材质
const tweenUniforms = [];        // 需要 uTime 的后期/滚动材质
let objectList = [];             // {obj, def, materialName}

/* ---------------------------------------------------------------
   1. 着色器
   --------------------------------------------------------------- */

// —— 场景物体：一次覆盖 unlit / lit / alpha / 摇摆 / UV 滚动 / 自发光 ——
const OBJ_VERT = `
  uniform float uTime, uWaveSpeedX, uWaveSpeedY, uWaveStrength, uWaveAmp;
  uniform float uUVXOffset, uUVYOffset, uUseWave;
  varying vec2 vUv;
  varying vec3 vWPos;
  void main(){
    vUv = uv;
    vec3 p = position;
    if (uUseWave > 0.5) {
      vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
      float sum = wp.x + wp.y + wp.z;
      // 原版：phase = -_WaveSpeed * _Time * 1.45 + dot(worldPos, 1) * _WaveStrength
      float sA = sin(-uWaveSpeedX * uTime * 1.45 + sum * uWaveStrength);
      float sB = sin(-uWaveSpeedY * uTime * 1.45 + sum * uWaveStrength);
      float wu = uv.x - uUVXOffset;
      float wv = uv.y - uUVYOffset;
      p.z += sA * wu * uWaveAmp;
      p.x += sB * wv * uWaveAmp;
    }
    vec4 wp4 = modelMatrix * vec4(p, 1.0);
    vWPos = wp4.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp4;
  }`;

const OBJ_FRAG = `
  uniform sampler2D uMap, uScrollMap;
  uniform vec3 uColor, uEmission, uAmbient, uLightColor, uLightPos;
  uniform float uAlpha, uCutoff, uUseMap, uUseScroll, uLit, uUseEmission;
  uniform float uLightRange, uTime, uScrollSpeed, uTile, uMultiplier, uBlackRGB;
  varying vec2 vUv;
  varying vec3 vWPos;

  vec4 tex(sampler2D s, vec2 uv){ return texture2D(s, uv); }

  void main(){
    vec4 c = (uUseMap > 0.5) ? tex(uMap, vUv) : vec4(1.0);
    if (uCutoff > 0.0 && c.a < uCutoff) discard;

    // End Light Shaft：原版片元程序（shaders/LightShaft-End.shader，8 个编译变体一致）
    // 实际输出 rgb = 0，alpha = 贴图 R 通道 × _Color.a —— 即一张"黑色遮罩"而非白色辉光。
    if (uBlackRGB > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, c.r * uAlpha); return; }

    vec3 rgb = c.rgb * uColor;
    float a = c.a * uAlpha;

    // 光束：叠加滚动纹理的 A 通道（原版 Light Shaft (Animated)）
    if (uUseScroll > 0.5) {
      vec2 suv = vUv * uTile + vec2(0.0, uTime * uScrollSpeed);
      rgb += vec3(tex(uScrollMap, suv).a) * uMultiplier;
    }

    // 自发光
    if (uUseEmission > 0.5) rgb += uEmission;

    // 受光物体：环境色 + 单点光衰减（场景仅有 1 盏 Point Light）
    if (uLit > 0.5) {
      float d = length(uLightPos - vWPos);
      float att = clamp(1.0 - d / uLightRange, 0.0, 1.0);
      rgb *= (uAmbient + uLightColor * att * att);
    }

    gl_FragColor = vec4(rgb, a);
  }`;

// —— 后期 ——
const QUAD_VERT = `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT_FRAG = `
  uniform sampler2D tDiffuse; uniform float uThr;
  varying vec2 vUv;
  void main(){
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = max(0.0, l - uThr) / max(l, 1e-4);
    gl_FragColor = vec4(c * k, 1.0);
  }`;

const BLUR_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uDir; uniform vec2 uTexel;
  varying vec2 vUv;
  void main(){
    vec2 d = uDir * uTexel;
    vec3 s = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
    s += texture2D(tDiffuse, vUv + d * 1.3846153846).rgb * 0.3162162162;
    s += texture2D(tDiffuse, vUv - d * 1.3846153846).rgb * 0.3162162162;
    s += texture2D(tDiffuse, vUv + d * 3.2307692308).rgb * 0.0702702703;
    s += texture2D(tDiffuse, vUv - d * 3.2307692308).rgb * 0.0702702703;
    gl_FragColor = vec4(s, 1.0);
  }`;

const COMP_FRAG = `
  uniform sampler2D tScene, tBloom, tVig;
  uniform vec2 uRes; uniform float uTime;
  uniform float uBloom, uVig, uGrain, uCA;
  varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123); }
  void main(){
    vec2 uv = vUv;
    vec2 d = uv - 0.5;
    float r2 = dot(d, d);
    // 色差：越靠边缘越明显
    float k = uCA * r2 * 3.0;
    vec3 base;
    base.r = texture2D(tScene, uv + d * k * 0.02).r;
    base.g = texture2D(tScene, uv).g;
    base.b = texture2D(tScene, uv - d * k * 0.02).b;

    // Bloom 叠加
    vec3 bl = texture2D(tBloom, uv).rgb;
    vec3 col = base + bl * uBloom;

    // 高光柔和滚降：>0.85 的部分按 hi/(1+a*hi) 渐进收敛到 1.0，
    // 避免 HDR 叠加后大面积削平成纯白（保留云层/光晕的层次）
    float KNEE = 0.85, ASYM = 1.0 / (1.0 - KNEE);
    vec3 hi = max(col - KNEE, 0.0);
    col = min(col, vec3(KNEE)) + hi / (1.0 + hi * ASYM);

    // 暗角（直接复用原包里的 Vignette.png）
    vec3 v = texture2D(tVig, uv).rgb;
    col *= mix(vec3(1.0), v, uVig);

    // 胶片颗粒
    float n = hash(uv * uRes + fract(uTime) * 137.0);
    col += (n - 0.5) * uGrain;

    gl_FragColor = vec4(col, 1.0);
  }`;

// —— 粒子 ——
const PART_VERT = `
  attribute float aSize; attribute float aPhase; attribute float aSeed;
  uniform float uTime, uViewH, uFovRad, uSizeScale, uRise;
  varying float vLife; varying float vSeed;
  void main(){
    vec3 p = position;
    float t = fract(uTime / 12.0 + aPhase);
    p.y += t * uRise;
    vLife = t;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(-mv.z, 0.001);
    gl_PointSize = aSize * uSizeScale * (uViewH / (2.0 * tan(uFovRad * 0.5))) / dist;
    gl_PointSize = clamp(gl_PointSize, 1.0, 220.0);
    gl_Position = projectionMatrix * mv;
  }`;

const PART_FRAG = `
  uniform sampler2D uMap; uniform vec3 uColor; uniform float uAlpha;
  uniform float uUseMap, uLifeFade;
  varying float vLife; varying float vSeed;
  void main(){
    vec2 uv = gl_PointCoord;
    vec4 c = (uUseMap > 0.5) ? texture2D(uMap, uv) : vec4(1.0);
    float fade = 1.0;
    if (uLifeFade > 0.5) fade = smoothstep(0.0, 0.18, vLife) * (1.0 - smoothstep(0.62, 1.0, vLife));
    float a = c.a * uAlpha * fade;
    if (a < 0.002) discard;
    gl_FragColor = vec4(c.rgb * uColor, a);
  }`;

/* ---------------------------------------------------------------
   2. 工具
   --------------------------------------------------------------- */
// 占位贴图：uniform 传 null 时 three.js 会用 image=undefined 的空纹理并每帧告警，
// 这里统一用 1×1 全透明贴图占位，着色器里 uUseMap=0 不会采样它。
let DUMMY_TEX = null;
function dummyTex() {
  if (!DUMMY_TEX) {
    DUMMY_TEX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    DUMMY_TEX.needsUpdate = true;
  }
  return DUMMY_TEX;
}

// 内嵌数据源（单文件版用）：window.__TP_DATA = {scene, meshes:{file:obj}, tex:{path:dataURI}}
// 存在时直接取用，避免 file:// 下 fetch / 贴图加载被浏览器同源策略拦掉。
const IDATA = window.__TP_DATA || null;

function loadTex(relPath) {
  if (texCache.has(relPath)) return texCache.get(relPath);
  let t;
  if (IDATA && IDATA.tex && IDATA.tex[relPath]) {
    t = new THREE.TextureLoader().load(IDATA.tex[relPath]);
  } else {
    t = new THREE.TextureLoader().load(relPath);
  }
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  texCache.set(relPath, t);
  return t;
}

function applyBlend(mat, def) {
  const b = def.blend || '';
  if (def.queue < 2450 && !b) { mat.transparent = false; return; }
  mat.transparent = true;
  if (b === 'Blend SrcAlpha One') {                       // 叠加
    mat.blending = THREE.AdditiveBlending;
  } else if (b === 'Blend Zero SrcColor') {               // 正片叠底
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.ZeroFactor;
    mat.blendDst = THREE.SrcColorFactor;
    mat.blendEquation = THREE.AddEquation;
  } else if (b === 'Blend One OneMinusSrcAlpha') {        // 预乘
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendEquation = THREE.AddEquation;
  } else if (b === 'Blend One One') {                     // 纯叠加
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendEquation = THREE.AddEquation;
  } else {
    mat.blending = THREE.NormalBlending;
  }
  mat.depthWrite = (def.zwrite === 'On');
}

function classify(def) {
  const sh = (def.shader || '').toLowerCase();
  if (sh.includes('waving')) return 'wave';
  if (sh.includes('light shaft')) return 'shaft';
  if (sh.includes('self-illumin')) return 'emissive';
  if (sh.includes('lightbulb')) return 'glass';
  if (sh.includes('spiderweb')) return 'web';
  if (sh.includes('multiply')) return 'multiply';
  return 'plain';
}

/** 亮度系数：_Multiplier 优先，其次 _Intensity，都没有则 1 */
function matMultiplier(f) {
  if (f._Multiplier !== undefined && f._Multiplier !== null) return f._Multiplier;
  if (f._Intensity !== undefined && f._Intensity !== null) return f._Intensity;
  return 1;
}

function buildMaterial(def) {
  if (matCache.has(def.name)) return matCache.get(def.name);

  const kind = classify(def);
  const c = def.colors || {};
  const f = def.floats || {};
  const col = c._Color || [1, 1, 1, 1];
  const mainSlot = def.textures._MainTex || def.textures._FXTex || null;
  const scrollSlot = def.textures._ScrollTex || null;

  const u = {
    uTime: { value: 0 },
    uMap: { value: mainSlot ? loadTex(mainSlot.file) : null },
    uScrollMap: { value: scrollSlot ? loadTex(scrollSlot.file) : null },
    uUseMap: { value: mainSlot ? 1 : 0 },
    uUseScroll: { value: kind === 'shaft' && scrollSlot ? 1 : 0 },
    uColor: { value: new THREE.Vector3(col[0], col[1], col[2]) },
    uAlpha: { value: col[3] === undefined ? 1 : col[3] },
    uCutoff: { value: Math.max(f._Cutoff || 0, def.alphatest || 0, 0) },
    uEmission: { value: new THREE.Vector3(0, 0, 0) },
    uUseEmission: { value: 0 },
    uAmbient: { value: new THREE.Vector3(0.2, 0.2, 0.2) },
    uLightColor: { value: new THREE.Vector3(0, 0, 0) },
    uLightPos: { value: new THREE.Vector3(0, 0, 0) },
    uLightRange: { value: 20 },
    uLit: { value: 0 },
    uUseWave: { value: 0 },
    uWaveSpeedX: { value: f._WaveSpeedX || 0 },
    uWaveSpeedY: { value: f._WaveSpeedY || 0 },
    uWaveStrength: { value: f._WaveStrength || 0 },
    uWaveAmp: { value: 0.5 },   // 原版顶点位移的固定系数即为 0.5
    uUVXOffset: { value: f._UVXOffset || 0 },
    uUVYOffset: { value: f._UVYOffset || 0 },
    uScrollSpeed: { value: (f._TimeScale === undefined ? 1 : f._TimeScale) },
    uTile: { value: f._Tile || 7 },
    // 原版里亮度系数有时叫 _Multiplier（TransparentWaving / Light Shaft），
    // 有时叫 _Intensity（End Light Shaft），两者等价，这里都认。
    uMultiplier: { value: matMultiplier(f) },
    // 原版 End Light Shaft 的 rgb 恒为 0（见 OBJ_FRAG 注释）
    uBlackRGB: { value: (/^end light shaft$/i.test(def.shader || '')) ? 1 : 0 },
  };

  // 贴图平铺 / 偏移
  if (mainSlot) {
    const sc = mainSlot.scale || [1, 1], of = mainSlot.offset || [0, 0];
    if (sc[0] !== 1 || sc[1] !== 1 || of[0] !== 0 || of[1] !== 0) {
      const cl = u.uMap.value.clone();
      cl.needsUpdate = true;
      cl.wrapS = cl.wrapT = THREE.RepeatWrapping;
      cl.repeat.set(sc[0], sc[1]);
      cl.offset.set(of[0], of[1]);
      u.uMap.value = cl;
    }
  }

  // 受光物体（Diffuse / Specular / Transparent-Diffuse）
  const sh = (def.shader || '').toLowerCase();
  const litish = /diffuse|specular|vertexlit/.test(sh) && !sh.includes('unlit');
  if (litish && kind !== 'wave') u.uLit.value = 1;

  // 自发光
  if (kind === 'emissive') {
    u.uUseEmission.value = 1;
    const mult = matMultiplier(f);
    u.uEmission.value.set(col[0] * mult, col[1] * mult, col[2] * mult);
    u.uAlpha.value = 1;
  } else if (c._Emission && (c._Emission[0] > 0.001 || c._Emission[1] > 0.001 || c._Emission[2] > 0.001)) {
    u.uUseEmission.value = 1;
    u.uEmission.value.set(c._Emission[0], c._Emission[1], c._Emission[2]);
  }

  if (kind === 'wave') u.uUseWave.value = 1;

  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: OBJ_VERT,
    fragmentShader: OBJ_FRAG,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
  applyBlend(mat, def);
  // 卡片类植被大量使用负缩放，DoubleSide 可避免绕序翻转导致的漏面
  mat.side = THREE.DoubleSide;

  mat.userData.baseScroll = (f._TimeScale === undefined ? 1 : f._TimeScale);
  if (u.uUseWave.value > 0.5 || u.uUseScroll.value > 0.5) waveMats.push(mat);

  const rec = { mat, def, uniforms: u, kind };
  matCache.set(def.name, rec);
  return rec;
}

/* ---------------------------------------------------------------
   3. 载入
   --------------------------------------------------------------- */
function setProgress(p, msg) {
  $('loadBar').style.width = (p * 100).toFixed(0) + '%';
  if (msg) $('loadMsg').textContent = msg;
}

async function boot() {
  envData = (IDATA && IDATA.scene) ? IDATA.scene : await (await fetch('scene.json')).json();
  setProgress(0.12, '场景图已解析');

  // 预取网格
  const meshFiles = [...new Set(envData.renderers.map(r => r.meshFile))];
  let done = 0;
  for (const mf of meshFiles) {
    const g = (IDATA && IDATA.meshes && IDATA.meshes[mf])
      ? IDATA.meshes[mf]
      : await (await fetch(mf)).json();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
    if (g.uvs && g.uvs.length) geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
    if (g.normals && g.normals.length === g.positions.length) {
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.normals, 3));
    }
    geo.setIndex(g.indices);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    geo.computeBoundingSphere();
    meshCache.set(mf, geo);
    done++;
    setProgress(0.12 + 0.38 * done / meshFiles.length, `网格 ${done}/${meshFiles.length}`);
  }

  buildScene();
  setProgress(0.72, '构建相机与后期链…');
  buildPost();
  buildUI();
  setProgress(1, '完成');
  S.loaded = true;
  $('load').classList.add('hidden');
  animate();
}

function buildScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const amb = envData.renderSettings.ambient || [0.2, 0.2, 0.2];
  const lit = envData.lights[0] || null;

  for (const r of envData.renderers) {
    const geo = meshCache.get(r.meshFile);
    if (!geo) continue;
    const def = envData.materials.find(m => m.name === r.materials[0]);
    if (!def) continue;
    const rec = buildMaterial(def);

    const m = new THREE.Mesh(geo, rec.mat);
    m.position.fromArray(r.pos);
    m.quaternion.set(r.quat[0], r.quat[1], r.quat[2], r.quat[3]);
    m.scale.fromArray(r.scale);
    m.renderOrder = S.sortByQueue ? def.queue : 0;
    m.name = r.name;
    scene.add(m);
    objectList.push({ obj: m, def, kind: rec.kind });

    if (rec.uniforms.uLit.value > 0.5) {
      rec.uniforms.uAmbient.value.set(amb[0], amb[1], amb[2]);
      if (lit) {
        rec.uniforms.uLightPos.value.fromArray(lit.pos);
        rec.uniforms.uLightRange.value = lit.range;
        rec.uniforms.uLightColor.value.set(
          lit.color[0] * lit.intensity, lit.color[1] * lit.intensity, lit.color[2] * lit.intensity);
      }
    }
  }

  buildParticles();

  camera3 = new THREE.PerspectiveCamera(15, 1, 0.3, 2000);
  clock = new THREE.Clock();
}

/* ---- 粒子：原版 12 个 ParticleSystem，用 billboard 点云近似 ---- */
function buildParticles() {
  const rnd = (s) => { let x = Math.sin(s * 12.9898) * 43758.5453; return x - Math.floor(x); };

  (envData.particles || []).forEach((p, pi) => {
    const def = envData.materials.find(m => m.name === p.materials[0]);
    if (!def) return;
    let size = 0.2;
    if (p.startSize && typeof p.startSize === 'object' && p.startSize.scalar !== undefined) {
      size = p.startSize.scalar;
    } else if (typeof p.startSize === 'number') size = p.startSize;
    if (!size || size <= 0) size = 0.05;

    const N = Math.min(140, Math.max(24, (p.maxParticles || 50)));
    const pos = new Float32Array(N * 3), sz = new Float32Array(N);
    const ph = new Float32Array(N), sd = new Float32Array(N);
    const spread = clamp(size * 14, 0.6, 26);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rnd(pi * 31 + i) - 0.5) * spread;
      pos[i * 3 + 1] = (rnd(pi * 57 + i * 7) - 0.5) * spread * 0.7;
      pos[i * 3 + 2] = (rnd(pi * 91 + i * 13) - 0.5) * spread;
      sz[i] = size * (0.45 + rnd(pi * 13 + i * 3) * 1.1);
      ph[i] = rnd(pi * 7 + i * 5);
      sd[i] = rnd(i + pi);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));

    const slot = def.textures._MainTex || null;
    const col = (def.colors._Color) || [1, 1, 1, 1];
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uViewH: { value: 800 }, uFovRad: { value: 0.26 },
        uSizeScale: { value: 1 }, uRise: { value: spread * 0.6 },
        uMap: { value: slot ? loadTex(slot.file) : null },
        uUseMap: { value: slot ? 1 : 0 },
        uColor: { value: new THREE.Vector3(col[0], col[1], col[2]) },
        uAlpha: { value: (col[3] === undefined ? 1 : col[3]) },
        uLifeFade: { value: 1 },
      },
      vertexShader: PART_VERT,
      fragmentShader: PART_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
    });
    applyBlend(m, def);
    m.blending = (def.blend === 'Blend Zero SrcColor') ? THREE.CustomBlending : m.blending;
    const pts = new THREE.Points(g, m);
    pts.position.fromArray(p.pos);
    pts.renderOrder = def.queue + 1;
    pts.frustumCulled = false;
    scene.add(pts);
    tweenUniforms.push({ m, kind: 'particle' });
  });
}

/* ---------------------------------------------------------------
   4. 后期链
   --------------------------------------------------------------- */
let RT = {}, postScene, postCam, postMesh, pMats;
let vignetteTex = null;

function makeRT(w, h, depth, type) {
  return new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: type || THREE.UnsignedByteType,
    depthBuffer: !!depth, stencilBuffer: false,
  });
}

function buildPost() {
  postScene = new THREE.Scene();
  postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  postMesh = new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2),
    new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }));
  postMesh.frustumCulled = false;
  postScene.add(postMesh);

  const Q = (frag, uniforms) => new THREE.ShaderMaterial({
    uniforms, vertexShader: QUAD_VERT, fragmentShader: frag,
    depthTest: false, depthWrite: false,
  });

  pMats = {
    bright: Q(BRIGHT_FRAG, { tDiffuse: { value: null }, uThr: { value: S.brightThr } }),
    blur: Q(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2() } }),
    comp: Q(COMP_FRAG, {
      tScene: { value: null }, tBloom: { value: null }, tVig: { value: null },
      uRes: { value: new THREE.Vector2() }, uTime: { value: 0 },
      uBloom: { value: S.bloom }, uVig: { value: S.vig },
      uGrain: { value: S.grain }, uCA: { value: S.ca },
    }),
  };

  vignetteTex = new THREE.TextureLoader().load('tex/Vignette.png');
  pMats.comp.uniforms.tVig.value = vignetteTex;
  resize();
}

function blit(mat, target) {
  postMesh.material = mat;
  renderer.setRenderTarget(target || null);
  renderer.clear(true, true, false);
  renderer.render(postScene, postCam);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera3.aspect = w / h;
  camera3.updateProjectionMatrix();

  const type = renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const hw = Math.max(2, Math.floor(w / 2)), hh = Math.max(2, Math.floor(h / 2));
  ['rtScene', 'rtA', 'rtB'].forEach(k => RT[k] && RT[k].dispose());
  RT.rtScene = makeRT(w, h, true, type);
  RT.rtA = makeRT(hw, hh, false, type);
  RT.rtB = makeRT(hw, hh, false, type);
  pMats.blur.uniforms.uTexel.value.set(1 / hw, 1 / hh);
  pMats.comp.uniforms.uRes.value.set(w, h);
  tweenUniforms.forEach(t => {
    if (t.kind === 'particle') {
      t.m.uniforms.uViewH.value = h;
    }
  });
}

/* ---------------------------------------------------------------
   5. 相机控制
   --------------------------------------------------------------- */
const CAM = { target: new THREE.Vector3(), radius: 12, theta: 0, phi: Math.PI / 2 };
const keys = {};
let dragging = 0, lastX = 0, lastY = 0;

function applyCamera() {
  const sp = new THREE.Spherical(CAM.radius, CAM.phi, CAM.theta);
  const off = new THREE.Vector3().setFromSpherical(sp);
  camera3.position.copy(CAM.target).add(off);
  camera3.lookAt(CAM.target);
}

function gotoPreset(idx) {
  const c = envData.cameras[idx];
  if (!c) return;
  camera3.fov = c.fov * S.fovScale;
  camera3.near = c.near; camera3.far = c.far;
  camera3.updateProjectionMatrix();
  const q = new THREE.Quaternion(c.quat[0], c.quat[1], c.quat[2], c.quat[3]);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  CAM.radius = 12;
  CAM.target.copy(new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2])).add(fwd.clone().multiplyScalar(CAM.radius));
  const off2 = fwd.clone().multiplyScalar(-CAM.radius);
  const s = new THREE.Spherical().setFromVector3(off2);
  CAM.theta = s.theta; CAM.phi = s.phi;
  applyCamera();
  syncFovUI();
}

function bindControls(dom) {
  dom.addEventListener('contextmenu', e => e.preventDefault());
  dom.addEventListener('pointerdown', e => {
    dragging = e.button === 0 ? 1 : 2;
    lastX = e.clientX; lastY = e.clientY;
    dom.setPointerCapture(e.pointerId);
    S.tour = false;
    $('tourBtn').classList.remove('on');
  });
  dom.addEventListener('pointerup', e => { dragging = 0; try { dom.releasePointerCapture(e.pointerId); } catch (x) { } });
  dom.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    const k = 0.0028 * S.sens;
    if (dragging === 1) {
      CAM.theta -= dx * k;
      CAM.phi = clamp(CAM.phi - dy * k, 0.02, Math.PI - 0.02);
    } else {
      const right = new THREE.Vector3().setFromMatrixColumn(camera3.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera3.matrix, 1);
      CAM.target.addScaledVector(right, -dx * CAM.radius * 0.0016 * S.sens);
      CAM.target.addScaledVector(up, dy * CAM.radius * 0.0016 * S.sens);
    }
    applyCamera();
  });
  dom.addEventListener('wheel', e => {
    e.preventDefault();
    CAM.radius = clamp(CAM.radius * (1 + Math.sign(e.deltaY) * 0.08), 0.4, 900);
    applyCamera();
  }, { passive: false });

  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'Space') {
      e.preventDefault();
      S.tour = !S.tour;
      $('tourBtn').classList.toggle('on', S.tour);
    }
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });
}

function updateFly(dt) {
  const sp = (keys.ShiftLeft || keys.ShiftRight ? 46 : 12) * dt;
  const f = new THREE.Vector3().subVectors(CAM.target, camera3.position).normalize();
  const r = new THREE.Vector3().crossVectors(f, camera3.up).normalize();
  let moved = false;
  const v = new THREE.Vector3();
  if (keys.KeyW) { v.addScaledVector(f, sp); moved = true; }
  if (keys.KeyS) { v.addScaledVector(f, -sp); moved = true; }
  if (keys.KeyA) { v.addScaledVector(r, -sp); moved = true; }
  if (keys.KeyD) { v.addScaledVector(r, sp); moved = true; }
  if (keys.KeyE) { v.y += sp; moved = true; }
  if (keys.KeyQ) { v.y -= sp; moved = true; }
  if (moved) { CAM.target.add(v); applyCamera(); }
}

/* 垂直巡游：沿场景里 7 台原始相机插值上升。
   注意航线不是一条竖直线——原版相机在上升过程中会横向漂移
   （x: 0 → -27.7，y≈107→180 之间；终点 z 拉到 120），
   走直线会在 y>150 之后飞进空区（全黑）。 */
const TOUR = {
  t: 0, dur: 78,
  // 按 y 升序排列的原始机位 [y, x, z, fov]
  wp: [
    [0.0, 0.0, 7.83, 15],
    [4.2, -1.6, 29.83, 15],
    [21.5, -0.2, 29.83, 15],
    [107.1, 0.4, 29.83, 20],
    [180.1, -27.7, 29.83, 30],
    [231.0, -27.7, 29.83, 30],
    [266.9, -21.5, 120.0, 15],
    // 以下两站为推断值：原始包里没有更高处的相机，
    // 但场景在 y≈542、x≈-23.6、z≈0 处放着那盏 Point Light（灯泡），
    // 第 5 个元素是这两站的注视目标（否则默认平视 -Z，会完全拍不到灯泡）。
    [430.0, -23.6, 60.0, 20, [-23.58, 541.94, 0.0]],
    [500.0, -23.6, 30.0, 20, [-23.58, 541.94, 0.0]],
  ],
};

function updateTour(dt) {
  if (!S.tour) return;
  TOUR.t = (TOUR.t + dt / TOUR.dur) % 1;
  const wp = TOUR.wp;
  const n = wp.length;

  // 按「段」等时推进（而不是按 y 等距）：y 300~430 之间几乎没有内容，
  // 按 y 等距会让巡游有 1/4 时间停在黑屏里。
  const seg = TOUR.t * (n - 1);
  let i = Math.floor(seg);
  if (i > n - 2) i = n - 2;
  const k = seg - i;
  const a = wp[i], b = wp[i + 1];
  const L = (v, j) => a[j] + (b[j] - a[j]) * k;
  const y = L(0, 0), x = L(0, 1), z = L(0, 2), fov = L(0, 3);

  camera3.fov = fov * S.fovScale;
  camera3.updateProjectionMatrix();
  camera3.position.set(x, y + 2, z);

  // 注视点：默认平视 -Z；若区段两端给了显式目标则插值过去
  const la = a[4] || [a[1], a[0], a[2] - 10];
  const lb = b[4] || [b[1], b[0], b[2] - 10];
  const look = new THREE.Vector3(
    la[0] + (lb[0] - la[0]) * k,
    la[1] + (lb[1] - la[1]) * k,
    la[2] + (lb[2] - la[2]) * k);
  camera3.lookAt(look);
  CAM.target.copy(look);
  const s = new THREE.Spherical().setFromVector3(
    new THREE.Vector3().subVectors(camera3.position, CAM.target));
  CAM.theta = s.theta; CAM.phi = s.phi;
}

/* ---------------------------------------------------------------
   6. UI
   --------------------------------------------------------------- */
function syncFovUI() { $('fov').value = Math.round(camera3.fov); $('fovV').textContent = camera3.fov.toFixed(0) + '°'; }

function slider(id, valId, key, fmt, after) {
  const el = $(id);
  el.value = S[key];
  const upd = () => {
    S[key] = parseFloat(el.value);
    $(valId).textContent = fmt(S[key]);
    after && after(S[key]);
  };
  el.addEventListener('input', upd);
  upd();
}

function buildUI() {
  // 相机下拉
  const sel = $('camPick');
  envData.cameras.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `#${i}  y=${c.pos[1].toFixed(0)}  z=${c.pos[2].toFixed(0)}  fov ${c.fov}°${c.hdr ? '  HDR' : ''}`;
    sel.appendChild(o);
  });
  sel.value = '1';
  sel.addEventListener('change', () => { S.tour = false; $('tourBtn').classList.remove('on'); gotoPreset(+sel.value); });

  $('tourBtn').addEventListener('click', () => {
    S.tour = !S.tour;
    $('tourBtn').classList.toggle('on', S.tour);
    if (S.tour) TOUR.t = 0;
  });
  $('resetBtn').addEventListener('click', () => { S.tour = false; $('tourBtn').classList.remove('on'); gotoPreset(+sel.value); });

  // 视场角滑块直接以角度为单位（原版长焦：15°/20°/30°）
  const fovEl = $('fov'); fovEl.value = 15; $('fovV').textContent = '15°';
  fovEl.addEventListener('input', () => {
    const d = parseFloat(fovEl.value);
    S.fovScale = d / 15;
    camera3.fov = d;
    camera3.updateProjectionMatrix();
    $('fovV').textContent = d.toFixed(0) + '°';
  });
  S.sens = 1.0; $('sens').value = 100; $('sensV').textContent = '100';
  $('sens').addEventListener('input', () => { S.sens = parseFloat($('sens').value) / 100; $('sensV').textContent = $('sens').value; });

  $('ppOn').addEventListener('change', e => { S.pp = e.target.checked; });
  slider('bloom', 'bloomV', 'bloom', v => v.toFixed(2), v => pMats.comp.uniforms.uBloom.value = v);
  slider('bthr', 'bthrV', 'brightThr', v => v.toFixed(2), v => pMats.bright.uniforms.uThr.value = v);
  slider('vig', 'vigV', 'vig', v => v.toFixed(2), v => pMats.comp.uniforms.uVig.value = v);
  slider('grain', 'grainV', 'grain', v => v.toFixed(3), v => pMats.comp.uniforms.uGrain.value = v);
  slider('ca', 'caV', 'ca', v => v.toFixed(2), v => pMats.comp.uniforms.uCA.value = v);

  $('waveOn').addEventListener('change', e => {
    S.wave = e.target.checked;
    S.waveAmp = S.wave ? parseFloat($('waveAmp').value) : 0;
    refreshWaveUniforms();
  });
  slider('waveAmp', 'waveAmpV', 'waveAmp', v => v.toFixed(2), refreshWaveUniforms);
  slider('waveSpd', 'waveSpdV', 'waveSpd', v => v.toFixed(2));
  slider('scroll', 'scrollV', 'scroll', v => v.toFixed(2));

  slider('amb', 'ambV', 'ambMul', v => v.toFixed(2), v => {
    const a = envData.renderSettings.ambient || [0.2, 0.2, 0.2];
    matCache.forEach(r => {
      if (r.uniforms.uLit && r.uniforms.uLit.value > 0.5) {
        r.uniforms.uAmbient.value.set(a[0] * v, a[1] * v, a[2] * v);
      }
    });
  });
  slider('plI', 'plIV', 'plMul', v => v.toFixed(1), v => {
    const l = envData.lights[0];
    if (!l) return;
    matCache.forEach(r => {
      if (r.uniforms.uLit && r.uniforms.uLit.value > 0.5) {
        r.uniforms.uLightColor.value.set(l.color[0] * l.intensity * v, l.color[1] * l.intensity * v, l.color[2] * l.intensity * v);
      }
    });
  });

  $('sortByQueue').addEventListener('change', e => {
    S.sortByQueue = e.target.checked;
    objectList.forEach(o => o.obj.renderOrder = S.sortByQueue ? o.def.queue : 0);
  });
  $('wire').addEventListener('change', e => { S.wire = e.target.checked; refreshWire(); });

  $('shotBtn').addEventListener('click', () => {
    renderFrame(0);
    const a = document.createElement('a');
    a.download = 'theplan_' + Date.now() + '.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  });

  // 初始值
  $('sortByQueue').checked = S.sortByQueue;
  gotoPreset(1);
  updateStats();
}

function refreshWaveUniforms() {
  waveMats.forEach(m => {
    if (m.uniforms.uUseWave.value > 0.5) m.uniforms.uWaveAmp.value = S.wave ? S.waveAmp : 0;
  });
}
function refreshWire() {
  matCache.forEach(r => { r.mat.wireframe = S.wire; r.mat.needsUpdate = true; });
}

const sceneInfo = { calls: 0, triangles: 0 };
let statTick = 0;
function updateStats() {
  const info = sceneInfo;
  const s = envData.stats;
  const total = envData.renderers.length;
  $('stats').innerHTML =
    `<b>提取自原包</b>　贴图 ${s.textures} · 网格 ${s.meshes} · 材质 ${s.materials}<br>` +
    `<b>场景实例</b>　渲染器 ${total} · 粒子 ${s.particles} · 相机 ${envData.cameras.length}<br>` +
    `<b>运行时</b>　draw ${info.calls} · 三角面 ${(info.triangles / 1000).toFixed(1)}k · ` +
    `队列分层 ${new Set(envData.materials.map(m => m.queue)).size} 级`;
}

/* ---------------------------------------------------------------
   7. 渲染循环
   --------------------------------------------------------------- */
function renderFrame(t) {
  camera3.updateMatrixWorld();

  // 每帧 uniform
  waveMats.forEach(m => {
    m.uniforms.uTime.value = (m.uniforms.uUseWave && m.uniforms.uUseWave.value > 0.5) ? t * S.waveSpd : t;
    if (m.uniforms.uUseScroll && m.uniforms.uUseScroll.value > 0.5) {
      m.uniforms.uScrollSpeed.value = (m.userData.baseScroll || 1) * S.scroll;
    }
  });
  tweenUniforms.forEach(x => {
    x.m.uniforms.uTime.value = t;
    if (x.kind === 'particle') {
      x.m.uniforms.uFovRad.value = camera3.fov * Math.PI / 180;
      x.m.uniforms.uSizeScale.value = S.fovScale;
    }
  });

  renderer.setRenderTarget(RT.rtScene);
  renderer.clear(true, true, false);
  renderer.render(scene, camera3);
  sceneInfo.calls = renderer.info.render.calls;
  sceneInfo.triangles = renderer.info.render.triangles;

  if (!S.pp) {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera3);
    return;
  }

  // BrightPass
  pMats.bright.uniforms.tDiffuse.value = RT.rtScene.texture;
  blit(pMats.bright, RT.rtA);

  // 可分离模糊 ×3
  for (let i = 0; i < 3; i++) {
    const r = 1 + i * 1.6;
    pMats.blur.uniforms.tDiffuse.value = RT.rtA.texture;
    pMats.blur.uniforms.uDir.value.set(r, 0);
    blit(pMats.blur, RT.rtB);
    pMats.blur.uniforms.tDiffuse.value = RT.rtB.texture;
    pMats.blur.uniforms.uDir.value.set(0, r);
    blit(pMats.blur, RT.rtA);
  }

  // 合成
  pMats.comp.uniforms.tScene.value = RT.rtScene.texture;
  pMats.comp.uniforms.tBloom.value = RT.rtA.texture;
  pMats.comp.uniforms.uTime.value = t;
  blit(pMats.comp, null);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.getElapsedTime();
  if (S.tour) updateTour(dt);
  else updateFly(dt);
  renderFrame(t);
  if ((statTick = (statTick + 1) % 30) === 0) updateStats();
}

/* ---------------------------------------------------------------
   8. 启动
   --------------------------------------------------------------- */
function init() {
  const dom = $('app');
  renderer = new THREE.WebGLRenderer({
    antialias: false, alpha: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.autoClear = false;
  dom.appendChild(renderer.domElement);
  bindControls(renderer.domElement);
  window.addEventListener('resize', () => { resize(); });
  boot().catch(e => {
    console.error(e);
    $('load').innerHTML = '<div id="err"><b>装载失败</b><br>' + (e && e.message ? e.message : e) +
      '<br><br>请通过本地 HTTP 服务打开（不能直接双击 file:// 打开），例如在 <code>theplan_web</code> 目录执行：<br>' +
      '<code>python -m http.server 8807</code><br>然后访问 <code>http://127.0.0.1:8807/</code></div>';
  });
}

/* ---------------------------------------------------------------
   9. 调试钩子（供控制台 / 自动化调参使用）
   --------------------------------------------------------------- */
window.__TP = {
  S, gotoPreset, TOUR,
  get cam() { return camera3; },
  get scene() { return scene; },
  get renderer() { return renderer; },
  get pMats() { return typeof pMats === 'undefined' ? null : pMats; },
  /** 读回当前画布像素并给出亮度统计 */
  stat() {
    const c = renderer.domElement;
    const w = 160, h = 90;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const g = tmp.getContext('2d');
    g.drawImage(c, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const n = w * h; const L = new Float32Array(n);
    let clip = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      L[i] = l; sum += l; if (l >= 253) clip++;
    }
    const s = Array.from(L).sort((a, b) => a - b);
    const q = (p) => s[Math.min(Math.floor(p * n), n - 1)];
    return {
      mean: +(sum / n).toFixed(1), clipPct: +(100 * clip / n).toFixed(1),
      q10: +q(0.1).toFixed(1), q50: +q(0.5).toFixed(1), q90: +q(0.9).toFixed(1), q99: +q(0.99).toFixed(1),
      calls: (typeof sceneInfo !== 'undefined' ? sceneInfo.calls : renderer.info.render.calls),
      tris: (typeof sceneInfo !== 'undefined' ? sceneInfo.triangles : renderer.info.render.triangles),
    };
  },
};

init();
})();
