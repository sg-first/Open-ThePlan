/* ============================================================
   扑火 TOWARD THE LIGHT — 基于 The Plan 美术管线的弹幕射击
   管线复用（与 app.js 同源的数据与手法）：
     scene.json / mesh/*.json / tex/*.png  (Unity 4.5.5p5 提取)
     · renderQueue 手工深度分层（15 级队列 → renderOrder）
     · TransparentWaving 顶点摆动 / Light Shaft UV 滚动
     · HDR → BrightPass → 可分离模糊 → Bloom 合成
     · Vignette.png 暗角 + 胶片颗粒 + 色差（事件尖峰）
   玩法：纵版弹幕。苍蝇向上爬向 542m 处的灯泡，
        擦弹充能「光爆」，在织网者与灯之下活下去。
   ============================================================ */
(function () {
'use strict';

/* ============ 0. 常量与状态 ============ */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

const BAND_H = 120;          // 森林平铺周期
const CAM_Z = 44;            // 相机距离（32° 广角 + 拉远，扩大景别便于规避）
const FOV = 32;
const HALF_H = 11.9;         // z=0 平面可玩半高（视野半高 12.6，几乎全屏可玩，仅顶部留 HUD 边）
const GOAL_STEP = 600;       // 每 NG+ 周期 600m
const MINI_ALTS = [150, 330, 480];

const CYAN = [0.55, 0.97, 1.0], MAG = [1.0, 0.45, 0.86], AMBER = [1.0, 0.74, 0.38],
      GREEN = [0.55, 1.0, 0.62], WHITE = [1, 1, 1], VIOLET = [0.72, 0.55, 1.0];

const S = {
  state: 'loading', paused: false, muted: false,
  camY: 0, climb: 0, time: 0, realTime: 0,
  score: 0, hi: +(localStorage.getItem('ttl_hi') || 0),
  lives: 3, bombs: 3, gauge: 0, power: 1, kills: 0, graze: 0,
  combo: 0, comboT: 0, ng: 0,
  shake: 0, flash: 0, caSpike: 0, hitstop: 0,
  bloom: 0.5, bloomBoost: 0,
};

const PLAY = { halfW: 8 };

/* ============ 1. 着色器 ============ */

// —— 场景物（摆动 / 光束滚动 / 自发光 / 点光）——
const OBJ_VERT = `
  uniform float uTime,uWaveSpeedX,uWaveSpeedY,uWaveStrength,uWaveAmp,uUVXOffset,uUVYOffset,uUseWave;
  varying vec2 vUv; varying vec3 vWPos;
  void main(){
    vUv=uv; vec3 p=position;
    if(uUseWave>0.5){
      vec3 wp=(modelMatrix*vec4(p,1.0)).xyz;
      float sum=wp.x+wp.y+wp.z;
      p.z+=sin(-uWaveSpeedX*uTime*1.45+sum*uWaveStrength)*(uv.x-uUVXOffset)*uWaveAmp;
      p.x+=sin(-uWaveSpeedY*uTime*1.45+sum*uWaveStrength)*(uv.y-uUVYOffset)*uWaveAmp;
    }
    vec4 wp4=modelMatrix*vec4(p,1.0); vWPos=wp4.xyz;
    gl_Position=projectionMatrix*viewMatrix*wp4;
  }`;
const OBJ_FRAG = `
  uniform sampler2D uMap,uScrollMap;
  uniform vec3 uColor,uEmission,uAmbient,uLightColor,uLightPos;
  uniform float uAlpha,uCutoff,uUseMap,uUseScroll,uLit,uUseEmission,uLightRange,uTime,uScrollSpeed,uTile,uMultiplier;
  varying vec2 vUv; varying vec3 vWPos;
  void main(){
    vec4 c=(uUseMap>0.5)?texture2D(uMap,vUv):vec4(1.0);
    if(uCutoff>0.0&&c.a<uCutoff) discard;
    vec3 rgb=c.rgb*uColor; float a=c.a*uAlpha;
    if(uUseScroll>0.5){
      vec2 suv=vUv*uTile+vec2(0.0,uTime*uScrollSpeed);
      rgb+=vec3(texture2D(uScrollMap,suv).a)*uMultiplier;
    }
    if(uUseEmission>0.5) rgb+=uEmission;
    if(uLit>0.5){
      float d=length(uLightPos-vWPos);
      float att=clamp(1.0-d/uLightRange,0.0,1.0);
      rgb*=(uAmbient+uLightColor*att*att);
    }
    gl_FragColor=vec4(rgb,a);
  }`;

// —— 点精灵（弹幕 / 粒子）：THREE.Points + 程序化形状，无图集 ——
const SH_DOT = 0, SH_BULLET = 1, SH_RING = 2, SH_STAR = 3;
const PT_VERT = `
  attribute float aSize; attribute vec4 aCol; attribute float aShape;
  uniform float uViewH, uFovRad;
  varying vec4 vCol; varying float vShape;
  void main(){
    vCol=aCol; vShape=aShape;
    vec4 mv=viewMatrix*vec4(position,1.0);
    float dist=max(-mv.z,0.001);
    gl_PointSize=clamp(aSize*(uViewH/(2.0*tan(uFovRad*0.5)))/dist,1.0,900.0);
    gl_Position=projectionMatrix*mv;
  }`;

const PT_FRAG = `
  varying vec4 vCol; varying float vShape;
  void main(){
    vec2 p=gl_PointCoord*2.0-1.0;
    float d=length(p);
    float a;
    if(vShape<0.5){ a=smoothstep(1.0,0.0,d); a*=a; }
    else if(vShape<1.5){ a=smoothstep(0.55,0.18,d)+smoothstep(0.5,0.45,d)*0.5; }
    else if(vShape<2.5){ a=smoothstep(0.16,0.02,abs(d-0.78))*smoothstep(1.0,0.82,d); }
    else {
      float sx=pow(max(0.0,1.0-2.4*abs(p.x)),9.0);
      float sy=pow(max(0.0,1.0-2.4*abs(p.y)),9.0);
      a=max(max(sx,sy),smoothstep(0.5,0.0,d)*0.55);
    }
    a*=vCol.a;
    if(a<0.004) discard;
    gl_FragColor=vec4(vCol.rgb*a,a);
  }`;

// —— 后期 ——
const QUAD_VERT = `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;
const BRIGHT_FRAG = `
  uniform sampler2D tDiffuse;uniform float uThr;varying vec2 vUv;
  void main(){
    vec3 c=texture2D(tDiffuse,vUv).rgb;
    float l=dot(c,vec3(0.2126,0.7152,0.0722));
    float k=max(0.0,l-uThr)/max(l,1e-4);
    gl_FragColor=vec4(c*k,1.0);
  }`;
const BLUR_FRAG = `
  uniform sampler2D tDiffuse;uniform vec2 uDir,uTexel;varying vec2 vUv;
  void main(){
    vec2 d=uDir*uTexel;
    vec3 s=texture2D(tDiffuse,vUv).rgb*0.2270270270;
    s+=texture2D(tDiffuse,vUv+d*1.3846153846).rgb*0.3162162162;
    s+=texture2D(tDiffuse,vUv-d*1.3846153846).rgb*0.3162162162;
    s+=texture2D(tDiffuse,vUv+d*3.2307692308).rgb*0.0702702703;
    s+=texture2D(tDiffuse,vUv-d*3.2307692308).rgb*0.0702702703;
    gl_FragColor=vec4(s,1.0);
  }`;
const COMP_FRAG = `
  uniform sampler2D tScene,tBloom,tVig;
  uniform vec2 uRes;uniform float uTime,uBloom,uVig,uGrain,uCA,uFlash,uLift;
  varying vec2 vUv;
  float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453123);}
  void main(){
    vec2 uv=vUv; vec2 d=uv-0.5; float r2=dot(d,d);
    float k=uCA*r2*3.0;
    vec3 base;
    base.r=texture2D(tScene,uv+d*k*0.02).r;
    base.g=texture2D(tScene,uv).g;
    base.b=texture2D(tScene,uv-d*k*0.02).b;
    vec3 col=base+texture2D(tBloom,uv).rgb*uBloom;
    float KNEE=0.85,ASYM=1.0/(1.0-KNEE);
    vec3 hi=max(col-KNEE,0.0);
    col=min(col,vec3(KNEE))+hi/(1.0+hi*ASYM);
    col=mix(col,vec3(1.0),uFlash);
    col=pow(max(col,0.0),vec3(0.92))*(1.0+uLift);
    vec3 v=texture2D(tVig,uv).rgb;
    col*=mix(vec3(1.0),v,uVig);
    col+=(hash(uv*uRes+fract(uTime)*137.0)-0.5)*uGrain;
    gl_FragColor=vec4(col,1.0);
  }`;

// —— 贴图卡片（敌人 / 远景）——
const CARD_VERT = `
  varying vec2 vUv;
  void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const CARD_FRAG = `
  uniform sampler2D uMap;uniform vec3 uTint;uniform float uAlpha;varying vec2 vUv;
  void main(){
    vec4 c=texture2D(uMap,vUv);
    if(c.a<0.01) discard;
    gl_FragColor=vec4(c.rgb*uTint,c.a*uAlpha);
  }`;

/* ============ 2. 资产 ============ */
let renderer, scene, camera3, clock, envData;
const texCache = new Map(), meshCache = new Map();
const waveMats = [];
const IMAGE = {};   // 原始 JSON / 图片缓存（供 atlas 使用）

function loadTexture(path) {
  if (texCache.has(path)) return texCache.get(path);
  const t = new THREE.TextureLoader().load(path);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  texCache.set(path, t);
  return t;
}
function loadMesh(name) {
  if (meshCache.has(name)) return meshCache.get(name);
  const raw = IMAGE['mesh:' + name];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(raw.positions, 3));
  if (raw.uvs && raw.uvs.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(raw.uvs, 2));
  if (raw.normals && raw.normals.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(raw.normals, 3));
  g.setIndex(raw.indices);
  if (!g.attributes.normal) g.computeVertexNormals();
  g.computeBoundingSphere();
  meshCache.set(name, g);
  return g;
}

function matMultiplier(f) {
  if (f._Multiplier !== undefined && f._Multiplier !== null) return f._Multiplier;
  if (f._Intensity !== undefined && f._Intensity !== null) return f._Intensity;
  return 1;
}
function matDef(name) { return envData.materials.find(m => m.name === name); }

function buildMaterial(def) {
  const kind = /waving/i.test(def.shader) ? 'wave'
    : /light shaft/i.test(def.shader) ? 'shaft'
    : /self-illumin/i.test(def.shader) ? 'emissive' : 'plain';
  const c = def.colors || {}, f = def.floats || {};
  const col = c._Color || [1, 1, 1, 1];
  const slots = Object.values(def.textures || {});
  const mainSlot = def.textures._MainTex || slots[0] || null;
  const scrollSlot = def.textures._ScrollTex || null;

  const u = {
    uTime: { value: 0 },
    uMap: { value: mainSlot ? loadTexture(mainSlot.file) : null },
    uScrollMap: { value: scrollSlot ? loadTexture(scrollSlot.file) : null },
    uUseMap: { value: mainSlot ? 1 : 0 },
    uUseScroll: { value: kind === 'shaft' && scrollSlot ? 1 : 0 },
    uColor: { value: new THREE.Vector3(col[0], col[1], col[2]) },
    uAlpha: { value: col[3] === undefined ? 1 : col[3] },
    uCutoff: { value: Math.max(f._Cutoff || 0, def.alphatest || 0) },
    uEmission: { value: new THREE.Vector3(0, 0, 0) },
    uUseEmission: { value: 0 },
    uAmbient: { value: new THREE.Vector3(0.38, 0.42, 0.46) },
    uLightColor: { value: new THREE.Vector3(0, 0, 0) },
    uLightPos: { value: new THREE.Vector3(0, 0, 0) },
    uLightRange: { value: 20 },
    uLit: { value: 0 },
    uUseWave: { value: kind === 'wave' ? 1 : 0 },
    uWaveSpeedX: { value: f._WaveSpeedX || 0 },
    uWaveSpeedY: { value: f._WaveSpeedY || 0 },
    uWaveStrength: { value: f._WaveStrength || 0 },
    uWaveAmp: { value: 0.5 },
    uUVXOffset: { value: f._UVXOffset || 0 },
    uUVYOffset: { value: f._UVYOffset || 0 },
    uScrollSpeed: { value: f._TimeScale === undefined ? 1 : f._TimeScale },
    uTile: { value: f._Tile || 7 },
    uMultiplier: { value: matMultiplier(f) },
  };
  if (mainSlot) {
    const sc = mainSlot.scale || [1, 1], of = mainSlot.offset || [0, 0];
    if (sc[0] !== 1 || sc[1] !== 1 || of[0] !== 0 || of[1] !== 0) {
      const cl = u.uMap.value.clone(); cl.needsUpdate = true;
      cl.wrapS = cl.wrapT = THREE.RepeatWrapping;
      cl.repeat.set(sc[0], sc[1]); cl.offset.set(of[0], of[1]);
      u.uMap.value = cl;
    }
  }
  const sh = (def.shader || '').toLowerCase();
  if (/diffuse|specular/.test(sh) && !sh.includes('unlit') && kind !== 'wave') u.uLit.value = 1;
  if (kind === 'emissive') {
    u.uUseEmission.value = 1;
    const m = matMultiplier(f);
    u.uEmission.value.set(col[0] * m, col[1] * m, col[2] * m);
    u.uAlpha.value = 1;
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: u, vertexShader: OBJ_VERT, fragmentShader: OBJ_FRAG,
    side: THREE.DoubleSide, depthWrite: true,
  });
  // 混合状态（与原管线一致）
  const b = def.blend || '';
  if (def.queue < 2450 && !b) { mat.transparent = false; }
  else {
    mat.transparent = true;
    if (b === 'Blend SrcAlpha One' || b === 'Blend One One') mat.blending = THREE.AdditiveBlending;
    else if (b === 'Blend Zero SrcColor') {
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = THREE.ZeroFactor; mat.blendDst = THREE.SrcColorFactor;
    } else mat.blending = THREE.NormalBlending;
    mat.depthWrite = def.zwrite === 'On';
  }
  if (kind === 'wave' || kind === 'shaft') waveMats.push(mat);
  return mat;
}

/* ---- 精灵图集 ---- */
const CELL = { dot: 0, star: 1, soft: 2, bokeh: 3, puff: 4, ring: 5, glow: 6, shard: 7 };
let atlasTex = null;

function ringCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 34, 64, 64, 62);
  rg.addColorStop(0, 'rgba(255,255,255,0)');
  rg.addColorStop(0.62, 'rgba(255,255,255,0)');
  rg.addColorStop(0.8, 'rgba(255,255,255,1)');
  rg.addColorStop(0.95, 'rgba(255,255,255,0.25)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  return c;
}
function shardCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.filter = 'blur(7px)';
  g.fillStyle = '#fff';
  g.beginPath(); g.ellipse(64, 64, 14, 52, 0, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(64, 64, 6, 60, 0, 0, TAU); g.fill();
  return c;
}
function buildAtlas() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  const put = (img, i) => { g.drawImage(img, (i % 4) * 128, Math.floor(i / 4) * 128, 128, 128); };
  put(IMAGE.dot, 0); put(IMAGE.star, 1); put(IMAGE.soft, 2); put(IMAGE.bokeh, 3);
  put(IMAGE.puff, 4); put(ringCanvas(), 5); put(IMAGE.glow, 6); put(shardCanvas(), 7);
  atlasTex = new THREE.CanvasTexture(c);
  atlasTex.minFilter = THREE.LinearMipmapLinearFilter;
  atlasTex.magFilter = THREE.LinearFilter;
  return atlasTex;
}

/* ============ 3. 精灵批次 ============ */
class PointBatch {
  constructor(cap, blending, order) {
    this.cap = cap; this.n = 0;
    this.aPos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aShape = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aCol', this.aCol);
    geo.setAttribute('aShape', this.aShape);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uViewH: { value: 800 }, uFovRad: { value: 0.35 } },
      vertexShader: PT_VERT, fragmentShader: PT_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending,
    });
    this.mesh = new THREE.Points(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
  }
  begin() { this.n = 0; }
  push(x, y, z, size, r, g, b, a, shape) {
    if (this.n >= this.cap || a <= 0.004) return;
    const i = this.n;
    this.aPos.array[i * 3] = x; this.aPos.array[i * 3 + 1] = y; this.aPos.array[i * 3 + 2] = z;
    this.aSize.array[i] = size;
    this.aCol.array[i * 4] = r; this.aCol.array[i * 4 + 1] = g; this.aCol.array[i * 4 + 2] = b; this.aCol.array[i * 4 + 3] = a;
    this.aShape.array[i] = shape === undefined ? SH_DOT : shape;
    this.n++;
  }
  flush() {
    this.geo.setDrawRange(0, this.n);
    this.aPos.needsUpdate = this.aSize.needsUpdate = this.aCol.needsUpdate = this.aShape.needsUpdate = true;
  }
}
let bAdd, bHalo;   // 加色批 / 弹芯暗晕批（在亮背景上保住弹的轮廓）

/* ============ 4. 世界（无限滚动森林） ============ */
const PMOTES = [];
const worldGroup = new THREE.Group();
const slots = [];
let backdropMat, starMat, nebulaMat, lowMat, topMat;

function isJunk(name) {
  return /background|Background|LowPoly_fly|Fly_|LightBulb|LightShaft_Piece|SpiderWeb|lightbulb|EscToExit|Splash|Watermark/i.test(name);
}
/** 把几何按矩阵烘焙进合并数组 */
function bake(dst, geo, m) {
  const p = geo.attributes.position.array;
  const n = geo.attributes.normal ? geo.attributes.normal.array : null;
  const uv = geo.attributes.uv ? geo.attributes.uv.array : null;
  const idx = geo.index.array;
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const base = dst.vc;
  for (let i = 0; i < p.length; i += 3) {
    v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
    dst.pos.push(v.x, v.y, v.z);
    if (n) {
      v.set(n[i], n[i + 1], n[i + 2]).applyMatrix3(nm).normalize();
      dst.nor.push(v.x, v.y, v.z);
    }
    if (uv) dst.uv.push(uv[i / 3 * 2], uv[i / 3 * 2 + 1]);
    dst.vc++;
  }
  for (let i = 0; i < idx.length; i++) dst.idx.push(idx[i] + base);
}

/** 原场景的 12 个粒子系统：挑出落在平铺带内的，用加色精灵近似 */
function buildSceneParticles() {
  for (const p of (envData.particles || [])) {
    if (p.pos[1] < 0 || p.pos[1] >= BAND_H) continue;
    const def = matDef(p.materials[0]);
    if (!def) continue;
    const c = (def.colors && def.colors._Color) || [1, 1, 1, 1];
    const slot = def.textures && (def.textures._MainTex || Object.values(def.textures)[0]);
    let size = 0.2;
    if (p.startSize && typeof p.startSize === "object" && p.startSize.scalar !== undefined) size = p.startSize.scalar;
    else if (typeof p.startSize === "number") size = p.startSize;
    const n = Math.min(90, Math.max(18, (p.maxParticles || 40)));
    const spread = Math.max(0.8, size * 12);
    const cell = /bokeh/i.test(p.name) ? CELL.bokeh : /wind|streak/i.test(p.name) ? CELL.puff : CELL.dot;
    for (let i = 0; i < n; i++) {
      PMOTES.push({
        x: p.pos[0] + (Math.random() - 0.5) * spread,
        base: p.pos[1] + (Math.random() - 0.5) * spread * 0.8,
        z: p.pos[2] + (Math.random() - 0.5) * spread * 0.5,
        s: size * (0.5 + Math.random() * 1.3),
        ph: Math.random() * TAU,
        c: [c[0], c[1], c[2]],
        a: (c[3] === undefined ? 1 : c[3]) * 0.45,
        cell,
      });
    }
  }
}

function buildWorld() {
  scene.add(worldGroup);
  const CH = 24;                      // 分块高度（frustum culling）
  const buckets = new Map();          // matName -> {def, chunks}

  const band = [];
  for (const r of envData.renderers) {
    if (r.mesh.includes('Combined')) continue;      // 合并网格单独处理
    if (r.pos[1] < 0 || r.pos[1] >= BAND_H) continue;
    if (isJunk(r.name)) continue;
    band.push(r);
  }

  for (const r of band) {
    const def = matDef(r.materials[0]);
    if (!def || !IMAGE['mesh:' + r.mesh]) continue;
    let b = buckets.get(def.name);
    if (!b) { b = { def, chunks: new Map() }; buckets.set(def.name, b); }
    const cy = clamp(Math.floor(r.pos[1] / CH), 0, BAND_H / CH - 1);
    let dst = b.chunks.get(cy);
    if (!dst) { dst = { pos: [], nor: [], uv: [], idx: [], vc: 0 }; b.chunks.set(cy, dst); }
    const geo = loadMesh(r.mesh);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(r.pos),
      new THREE.Quaternion(r.quat[0], r.quat[1], r.quat[2], r.quat[3]),
      new THREE.Vector3().fromArray(r.scale));
    bake(dst, geo, m);
  }

  // 组装槽位：3 个槽循环上移，奇数槽 X 镜像以打散重复感
  for (let k = 0; k < 3; k++) {
    const g = new THREE.Group();
    for (const b of buckets.values()) {
      const mat = buildMaterial(b.def);
      for (const [cy, dst] of b.chunks) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(dst.pos, 3));
        if (dst.uv.length) geo.setAttribute('uv', new THREE.Float32BufferAttribute(dst.uv, 2));
        if (dst.nor.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(dst.nor, 3));
        geo.setIndex(dst.idx);
        if (!geo.attributes.normal) geo.computeVertexNormals();
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = cy * CH;
        mesh.renderOrder = b.def.queue;
        g.add(mesh);
      }
    }
    // 合并静态网格（整片森林的枝叶烘焙体）：按 Y 切块，套 3 种植被贴图形成层叠
    const combined = IMAGE['mesh:Combined'];
    if (combined) {
      const CHC = 30;
      const parts = new Map();
      const P = combined.positions, IDX = combined.indices;
      for (let i = 0; i < IDX.length; i += 3) {
        const y = P[IDX[i] * 3 + 1];
        if (y < -6 || y > BAND_H + 6) continue;
        const ck = clamp(Math.floor((y + 6) / CHC), 0, 5);
        let d = parts.get(ck);
        if (!d) { d = []; parts.set(ck, d); }
        d.push(IDX[i], IDX[i + 1], IDX[i + 2]);
      }
      for (const texName of ['bush_02v1', 'branch_08v1', 'Leaves_01v3']) {
        const def = matDef(texName); if (!def) continue;
        const mat = buildMaterial(def);
        for (const [ck, idx] of parts) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
          geo.setAttribute('uv', new THREE.Float32BufferAttribute(combined.uvs, 2));
          geo.setAttribute('normal', new THREE.Float32BufferAttribute(combined.normals, 3));
          geo.setIndex(idx);
          geo.computeBoundingSphere();
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = def.queue;
          g.add(mesh);
        }
      }
    }
    worldGroup.add(g);
    slots.push(g);
  }

  buildBackdrop();
  buildAmbient();
  buildMist();
}

/** 远景幕布 + 星空过渡（跟随相机、纹理偏移伪造视差） */
function buildBackdrop() {
  const mk = (texPath, repeat, additive, order, z) => {
    const t = loadTexture(texPath);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: t }, uTint: { value: new THREE.Vector3(1, 1, 1) },
        uAlpha: { value: 1 }, uOff: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: `varying vec2 vUv;uniform vec2 uOff;
        void main(){vUv=uv+uOff;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: CARD_FRAG,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(150, 100), mat);
    mesh.position.z = z; mesh.renderOrder = order;
    scene.add(mesh);
    return { mesh, mat, t };
  };
  backdropMat = mk('tex/background_test_tiled_square.png', [3.2, 2.4], false, 2800, -69);
  lowMat = mk('tex/background_test.png', [1.4, 1.1], false, 2799, -70);
  topMat = mk('tex/background_top.png', [2.0, 1.2], false, 2800, -69.5);
  starMat = mk('tex/TiledStars.png', [2.5, 1.6], true, 2801, -68.5);
  nebulaMat = mk('tex/HorseheadNebula.png', [1, 1], true, 2802, -68.2);
  nebulaMat.mesh.scale.set(1.5, 1.2, 1);
  starMat.mat.uniforms.uAlpha.value = 0;
  nebulaMat.mat.uniforms.uAlpha.value = 0;
  lowMat.mat.uniforms.uTint.value.set(0.72, 0.80, 0.90);
  topMat.mat.uniforms.uAlpha.value = 0;
}

function updateBackdrop() {
  const cy = S.camY;
  const bds = [backdropMat, starMat, nebulaMat, lowMat, topMat];
  const spd = [0.03, 0.012, 0.008, 0.02, 0.016];
  for (let i = 0; i < bds.length; i++) {
    const bd = bds[i];
    bd.mesh.position.y = cy;
    bd.mesh.position.x = camera3.position.x * 0.2;
    bd.mat.uniforms.uOff.value.set(0, -(cy * spd[i]) % 1);
  }
  lowMat.mat.uniforms.uAlpha.value = clamp(1 - cy / 45, 0, 1) * 0.45;
  topMat.mat.uniforms.uAlpha.value = clamp((cy - 300) / 240, 0, 1);
  starMat.mat.uniforms.uAlpha.value = clamp((cy - 260) / 220, 0, 1);
  nebulaMat.mat.uniforms.uAlpha.value = clamp((cy - 380) / 260, 0, 1) * 0.85;
}

/* ---- 环境光尘（加色微粒，跟随视口循环） + 体积雾 ---- */
const MOTES = [];
const MIST = [];
function buildAmbient() {
  for (let i = 0; i < 150; i++) {
    MOTES.push({
      x: rand(-11, 11), oy: rand(-6.5, 6.5), z: rand(-8, 2),
      vx: rand(-0.15, 0.15), vy: rand(0.05, 0.35),
      s: rand(0.05, 0.22), ph: rand(0, TAU),
      c: Math.random() < 0.75 ? CYAN : AMBER, a: rand(0.06, 0.3),
    });
  }
}
function buildMist() {
  for (let i = 0; i < 9; i++) {
    MIST.push({
      base: rand(0, BAND_H), x: rand(-16, 16), z: rand(-40, -18),
      s: rand(2.2, 5), ph: rand(0, TAU), a: rand(0.006, 0.016),
      c: Math.random() < 0.6 ? CYAN : AMBER, drift: rand(-0.4, 0.4),
    });
  }
}
function updateAmbient(dt, t) {
  for (const m of MOTES) {
    m.x += (m.vx + Math.sin(t * 0.7 + m.ph) * 0.12) * dt;
    m.oy += m.vy * dt;
    if (m.oy > HALF_H + 1.5) m.oy = -HALF_H - 1.5;
    if (m.x > 12) m.x = -12;
    if (m.x < -12) m.x = 12;
    bAdd.push(m.x, S.camY + m.oy, m.z, m.s * 2.4,
      m.c[0], m.c[1], m.c[2], m.a * (0.6 + 0.4 * Math.sin(t * 1.7 + m.ph)));
  }
  // 体积雾（大尺寸加色软片，营造林中光雾）
  for (const f of MIST) {
    const y = f.base + BAND_H * Math.round((S.camY - f.base) / BAND_H);
    const x = f.x + Math.sin(t * 0.13 + f.ph) * 2.4 + f.drift * t % 6;
    const a = f.a * (0.7 + 0.3 * Math.sin(t * 0.5 + f.ph));
    bAdd.push(x, y, f.z, f.s, f.c[0], f.c[1], f.c[2], a, SH_DOT);
  }
  // 场景原始粒子（TinasDOT / 光尘 / 风），按平铺周期重复
  for (const p of PMOTES) {
    const y = p.base + BAND_H * Math.round((S.camY - p.base) / BAND_H) + Math.sin(t * 0.4 + p.ph) * 0.6;
    bAdd.push(p.x, y, p.z, p.s * 2.2, p.c[0], p.c[1], p.c[2], p.a, SH_DOT);
  }
}

function updateSlots() {
  const base0 = Math.floor(S.camY / BAND_H);
  for (let k = 0; k < 3; k++) {
    const s = base0 + k - 1;
    slots[k].position.y = s * BAND_H;
    const flip = (((s % 2) + 2) % 2) === 1;
    slots[k].scale.x = flip ? -1 : 1;
  }
}

/* ============ 5. 自机 ============ */
const player = {
  x: 0, ry: -3, y: 0, inv: 0, fireT: 0, alive: true,
  wx: 0, wy: 0, focus: false, group: null, wings: null, px: 0,
};

function buildPlayer() {
  const g = new THREE.Group();
  const bodyDef = matDef('Fly_Body'), wingDef = matDef('Fly_Wing');
  const body = new THREE.Mesh(loadMesh('LowPoly_fly'), buildMaterial(bodyDef));
  const wings = new THREE.Mesh(loadMesh('LowPoly_fly_WINGS'), buildMaterial(wingDef));
  body.renderOrder = 3020; wings.renderOrder = 3021;
  body.material.transparent = true;
  wings.material.transparent = true;
  g.add(body); g.add(wings);
  // 原版苍蝇朝向：取场景里 Fly 渲染器的四元数作基准
  const fr = envData.renderers.find(r => /fly/i.test(r.name) && r.mesh.includes('LowPoly_fly') && !r.mesh.includes('WING'));
  if (fr) g.quaternion.set(fr.quat[0], fr.quat[1], fr.quat[2], fr.quat[3]);
  g.scale.setScalar(4.2);
  scene.add(g);
  player.group = g;
  player.wings = wings;
}

function updatePlayer(dt) {
  const p = player;
  if (!p.alive) return;
  updateMouseTarget();   // 每帧重算鼠标目标（相机随自机移动）
  p.inv = Math.max(0, p.inv - dt);
  p.focus = !!(keys.ShiftLeft || keys.ShiftRight);
  const spd = (p.focus ? 7 : 18.5) * dt;

  let dx = 0, dy = 0;
  if (keys.KeyA || keys.ArrowLeft) dx -= 1;
  if (keys.KeyD || keys.ArrowRight) dx += 1;
  if (keys.KeyW || keys.ArrowUp) dy += 1;
  if (keys.KeyS || keys.ArrowDown) dy -= 1;
  if (dx || dy) {
    const l = Math.hypot(dx, dy);
    p.x += dx / l * spd; p.ry += dy / l * spd;
    mouse.active = false;
  } else if (mouse.active) {
    p.x = lerp(p.x, p.wx, Math.min(1, dt * 14));
    p.ry = lerp(p.ry, p.wy - S.camY, Math.min(1, dt * 14));   // wy 是世界坐标，ry 是相对相机高度
  }
  p.x = clamp(p.x, -PLAY.halfW + 0.6, PLAY.halfW - 0.6);
  p.ry = clamp(p.ry, -HALF_H + 0.85, HALF_H - 0.85);
  p.y = S.camY + p.ry;

  p.fireT -= dt;
  if (p.fireT <= 0) { firePlayer(); p.fireT = 0.075; }

  const g = p.group;
  g.position.set(p.x, p.y, 0);
  g.rotation.z = clamp((p.x - p.px) * -2.2, -0.45, 0.45);
  p.px = p.x;
  const flap = Math.sin(S.time * 46) * 0.55;
  if (p.wings) {
    p.wings.rotation.x = flap;
    p.wings.rotation.z = flap * 0.3;
  }
  g.visible = (p.inv <= 0 || Math.sin(S.realTime * 40) > -0.2);

  bAdd.push(p.x, p.y, -0.3, 2.2, 0.55, 0.85, 1, 0.22, SH_DOT);
  if (p.focus) {
    bAdd.push(p.x, p.y, 0.5, 0.3, 1, 1, 1, 0.95, SH_BULLET);
    bAdd.push(p.x, p.y, 0.5, 1.0, 1, 0.4, 0.6, 0.75, SH_RING);
  }
  if (Math.random() < 0.7) {
    bAdd.push(p.x + rand(-0.12, 0.12), p.y - 0.55, -0.2, rand(0.25, 0.5),
      0, CELL.soft, 0.5, 0.85, 1, rand(0.15, 0.4));
  }
}

function firePlayer() {
  const p = player, pw = S.power, up = 24;
  const conv = p.focus ? 0 : 1;
  let shots;
  if (pw === 1) shots = [[0, 0]];
  else if (pw === 2) shots = [[-0.2, 0], [0.2, 0]];
  else if (pw === 3) shots = [[-0.26, -0.02], [0, 0], [0.26, 0.02]];
  else shots = [[-0.3, -0.05], [-0.13, 0], [0.13, 0], [0.3, 0.05], [0, 0]];
  for (const [ox, vx] of shots) {
    shotLists.player.push({
      x: p.x + ox * (1 - conv * 0.6), y: p.y + 0.35, z: 0,
      vx: vx * up * conv, vy: up,
      age: 0, life: 2, size: 0.3, ang: 0, angV: 0,
      cell: CELL.star, col: [0.7, 0.95, 1], a: 0.95, r: 0.14, dmg: 1,
    });
  }
  bAdd.push(p.x, p.y + 0.45, 0.1, 0.9, 0.6, 0.9, 1, 0.5, SH_DOT);
  AU.shoot();
}

/* ============ 6. 弹幕 / 实体池 ============ */
const shotLists = { enemy: [], player: [] };
const enemies = [];
const lasers = [];
const fx = [];

function eShot(x, y, vx, vy, opt) {
  const o = opt || {};
  const size = o.size || 0.42;
  if (shotLists.enemy.length > 1600) return;
  shotLists.enemy.push({
    x, y, z: o.z || 0, vx, vy,
    age: 0, life: o.life || 14,
    size, ang: Math.atan2(vy, vx) + Math.PI / 2, angV: o.angV || 0,
    cell: o.cell !== undefined ? o.cell : CELL.dot,
    col: o.col || CYAN, a: o.a !== undefined ? o.a : 1,
    r: size * 0.42, grazed: false, halo: o.halo !== false,
    drag: o.drag,
  });
}
function ring(x, y, n, speed, phase, opt) {
  for (let i = 0; i < n; i++) {
    const a = phase + i / n * TAU;
    eShot(x, y, Math.cos(a) * speed, Math.sin(a) * speed, opt);
  }
}
function fan(x, y, aim, n, spread, speed, opt) {
  for (let i = 0; i < n; i++) {
    const a = aim + (n > 1 ? (i / (n - 1) - 0.5) * spread : 0);
    eShot(x, y, Math.cos(a) * speed, Math.sin(a) * speed, opt);
  }
}
function aimAt(x, y) { return Math.atan2(player.y - y, player.x - x); }

function spark(x, y, col, n, spd, size) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), v = rand(spd * 0.3, spd);
    fx.push({
      x, y, z: rand(-0.5, 0.5), vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      age: 0, life: rand(0.25, 0.7), size: rand(size * 0.5, size), sizeV: 0,
      ang: a, angV: rand(-6, 6), cell: Math.random() < 0.5 ? CELL.soft : CELL.dot,
      col, a: 1, drag: 3.2,
    });
  }
}
function explode(x, y, big) {
  spark(x, y, AMBER, big ? 26 : 12, big ? 7 : 4.5, big ? 0.5 : 0.32);
  spark(x, y, CYAN, big ? 14 : 7, big ? 5 : 3, big ? 0.4 : 0.26);
  fx.push({ x, y, z: 0, vx: 0, vy: 0, age: 0, life: big ? 0.5 : 0.32,
    size: big ? 1.6 : 0.9, sizeV: big ? 14 : 7, ang: 0, angV: 0,
    cell: CELL.ring, col: WHITE, a: 0.9, drag: 0 });
  AU.boom(big);
  S.shake = Math.max(S.shake, big ? 0.5 : 0.16);
  S.bloomBoost = Math.max(S.bloomBoost, big ? 0.5 : 0.2);
}

/* ---- 敌人 ---- */
const cardGeo = new THREE.PlaneGeometry(1, 1);
function makeCard(texPath, tint, size, additive) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: loadTexture(texPath) },
      uTint: { value: new THREE.Vector3(tint[0], tint[1], tint[2]) },
      uAlpha: { value: 1 },
    },
    vertexShader: CARD_VERT, fragmentShader: CARD_FRAG,
    transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(cardGeo, mat);
  m.scale.set(size, size, 1);
  m.renderOrder = 3050;
  return m;
}
function makeWebMesh(scale) {
  const mat = buildMaterial(matDef('SpiderWeb1'));
  const m = new THREE.Mesh(loadMesh('SpiderWeb_Mesh'), mat);
  m.scale.setScalar(scale);
  m.renderOrder = 3051;
  return m;
}

function D() { return 1 + S.camY / GOAL_STEP + S.ng * 0.55; }  // 难度系数

function spawnEnemy(type, x, y, opt) {
  const o = opt || {};
  const e = {
    type, x, y, z: o.z !== undefined ? o.z : -1.2,
    vx: 0, vy: 0, t: 0, fireT: rand(0.3, 0.9), dead: false,
    data: {}, r: 0.6, hp: 1, score: 100, dropPower: 1,
  };
  if (type === 'moth') {
    e.hp = 6; e.r = 0.62; e.score = 300; e.vy = -0.4;
    e.sway = rand(0.8, 1.6); e.ph = rand(0, TAU);
    e.mesh = makeCard('tex/Mushroom03.png', [1, 0.72, 0.78], 1.35);
  } else if (type === 'leaf') {
    e.hp = 4; e.r = 0.5; e.score = 200;
    e.vx = (x > 0 ? -1 : 1) * (3.4 + D() * 0.7) * (S.hsc || 1);
    e.ph = rand(0, TAU);
    e.mesh = makeCard('tex/Leaf_Particle_Blurred.png', [0.65, 1, 0.8], 1.15, true);
    e.mesh.scale.set(1.7, 0.85, 1);
  } else if (type === 'drone') {
    e.hp = 3; e.r = 0.55; e.score = 150;
    e.vx = (x > 0 ? -1 : 1) * (5.2 + D() * 0.6) * (S.hsc || 1);
    e.mesh = makeCard('tex/bokehBlur.png', [1, 0.62, 0.3], 1.5, true);
  } else if (type === 'web') {
    e.hp = 18; e.r = 0.85; e.score = 800; e.dropPower = 2;
    e.ty = o.ty !== undefined ? o.ty : S.camY + rand(2, 3.6);
    e.life = 10;
    e.mesh = makeWebMesh(2.4);
  } else if (type === 'mini') { setupWeaver(e); }
  else if (type === 'bulb') { setupBulb(e); }
  e.maxHp = e.hp;
  if (e.mesh) { e.mesh.position.z = e.z; scene.add(e.mesh); }
  enemies.push(e);
  return e;
}

function removeEnemyVisual(e) {
  if (e.mesh) scene.remove(e.mesh);
  if (e.core) scene.remove(e.core);
  if (e.orbs) e.orbs.forEach(o => scene.remove(o));
}

function updateEnemies(dt) {
  const scroll = S.climb;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    e.t += dt;
    switch (e.type) {
      case 'moth': {
        e.x += Math.sin(e.t * e.sway + e.ph) * 0.9 * (S.hsc || 1) * dt;
        e.y += (e.vy - scroll) * dt;
        e.fireT -= dt;
        if (e.fireT <= 0 && Math.abs(e.y - S.camY) < HALF_H) {
          e.fireT = 1.7 / Math.min(D(), 2.2);
          fan(e.x, e.y, aimAt(e.x, e.y), 3, 0.5, 3.2 + D() * 0.8, { col: CYAN });
          AU.eshot();
        }
        if (e.mesh) { e.mesh.position.set(e.x, e.y, e.z); e.mesh.rotation.z = Math.sin(e.t * 2 + e.ph) * 0.15; }
        break;
      }
      case 'leaf': {
        e.x += e.vx * dt;
        e.y += (Math.sin(e.t * 2.4 + e.ph) * 1.3 - scroll) * dt;
        e.fireT -= dt;
        if (e.fireT <= 0 && Math.abs(e.y - S.camY) < HALF_H) {
          e.fireT = 0.24;
          e.data.sp = (e.data.sp || 0) + 0.42;
          eShot(e.x, e.y, Math.cos(e.data.sp) * 2.6, Math.sin(e.data.sp) * 2.6, { col: GREEN, size: 0.34 });
        }
        if (e.mesh) { e.mesh.position.set(e.x, e.y, e.z); e.mesh.rotation.z = Math.sin(e.t * 3 + e.ph) * 0.4; }
        if (Math.abs(e.x) > PLAY.halfW + 2) e.dead = true;
        break;
      }
      case 'drone': {
        e.x += e.vx * dt;
        e.y += (Math.sign(player.y - e.y) * 0.8 - scroll) * dt;
        e.fireT -= dt;
        if (e.fireT <= 0 && Math.abs(e.x) < PLAY.halfW) {
          e.fireT = 0.55;
          for (let k = -1; k <= 2; k++)
            eShot(e.x + k * 0.55, e.y, 0, -2.4 - D() * 0.5, { col: AMBER, size: 0.36 });
        }
        if (e.mesh) {
          e.mesh.position.set(e.x, e.y, e.z);
          const s = 1.5 + Math.sin(e.t * 5) * 0.15; e.mesh.scale.set(s, s, 1);
        }
        if (Math.abs(e.x) > PLAY.halfW + 2.5) e.dead = true;
        break;
      }
      case 'web': {
        if (e.y > e.ty) e.y -= 2.2 * dt; else e.y -= scroll * dt;
        e.fireT -= dt;
        if (e.fireT <= 0 && e.y <= e.ty + 0.2) {
          e.fireT = 1.5 / Math.min(D(), 1.9);
          e.data.ph = (e.data.ph || 0) + 0.35;
          ring(e.x, e.y, 10, 2.5 + D() * 0.4, e.data.ph, { col: MAG, size: 0.38 });
          AU.eshot();
        }
        e.life -= dt;
        if (e.life <= 0) { e.y += (6 - scroll) * dt; if (e.y > S.camY + HALF_H + 3) e.dead = true; }
        if (e.mesh) { e.mesh.position.set(e.x, e.y, e.z); e.mesh.rotation.z += dt * 0.6; }
        break;
      }
      case 'mini': updateWeaver(e, dt); break;
      case 'bulb': updateBulb(e, dt); break;
    }
    if (e.type !== 'mini' && e.type !== 'bulb') {
      if (e.dead || e.y < S.camY - HALF_H - 7) {
        removeEnemyVisual(e);
        enemies.splice(i, 1);
      }
    }
  }
}

function killEnemy(e, byBomb) {
  const idx = enemies.indexOf(e);
  if (idx >= 0) enemies.splice(idx, 1);
  removeEnemyVisual(e);
  e.dead = true;
  S.kills++;
  S.combo++; S.comboT = 2.2;
  const big = e.type === 'mini' || e.type === 'bulb';
  S.score += Math.round(e.score * comboMult());
  if (!big) S.gauge = Math.min(100, S.gauge + 2.2);
  explode(e.x, e.y, big);
  if (Math.random() < 0.18 && !byBomb) S.gauge = Math.min(100, S.gauge + 6);
  S.power = Math.min(4, 1 + Math.floor(S.kills / 22));
}
function comboMult() { return 1 + 0.15 * Math.min(S.combo, 15); }

/* ---- 小 Boss：织网者 ---- */
function setupWeaver(e) {
  e.hp = 260 * (1 + S.ng * 0.4); e.r = 1.9; e.score = 5000; e.dropPower = 0;
  e.ty = S.camY + 5; e.x = 0; e.phase = 0; e.pt = 0; e.fireT = 1.2;
  e.sp = 0; e.inving = true; e.entering = true; e.y = S.camY + HALF_H + 3;
  e.mesh = makeWebMesh(6.5);
  e.core = makeCard('tex/LightBulb_Glow.png', [1, 0.55, 0.75], 2.4, true);
  scene.add(e.core);
}
function tickInv(e, dt) {
  if (e.invT !== undefined && e.invT > 0) { e.invT -= dt; if (e.invT <= 0) e.inving = false; }
}
function updateWeaver(e, dt) {
  e.pt += dt;
  if (e.entering) {
    e.y = lerp(e.y, e.ty, Math.min(1, dt * 1.4));
    if (Math.abs(e.y - e.ty) < 0.1) { e.entering = false; e.inving = false; }
  } else {
    e.x = Math.sin(e.pt * 0.5) * 2.2;
  }
  if (e.mesh) { e.mesh.position.set(e.x, e.y, e.z); e.mesh.rotation.z += dt * 0.5; }
  if (e.core) {
    e.core.position.set(e.x, e.y, e.z + 0.3);
    const s = 2.4 + Math.sin(e.pt * 4) * 0.3; e.core.scale.set(s, s, 1);
    e.core.material.uniforms.uAlpha.value = e.inving ? 0.3 : 0.85;
  }
  if (e.entering || e.inving) { tickInv(e, dt); return; }
  weaverFire(e, dt);
}
function weaverFire(e, dt) {
  e.fireT -= dt;
  const hpr = e.hp / e.maxHp;
  const ph = hpr > 0.66 ? 0 : hpr > 0.33 ? 1 : 2;
  if (ph !== e.phase) {
    e.phase = ph; e.inving = true; e.invT = 0.8;
    clearBullets(true);
    S.flash = Math.max(S.flash, 0.35);
    AU.alarm();
    return;
  }
  if (ph === 0) {
    if (e.fireT <= 0) {
      e.fireT = 0.11; e.sp += 0.19;
      for (const dir of [1, -1]) {
        const a = e.sp * dir;
        eShot(e.x, e.y, Math.cos(a) * 3.0, Math.sin(a) * 3.0, { col: MAG, size: 0.4 });
      }
    }
    e.data.fT = (e.data.fT || 2) - dt;
    if (e.data.fT <= 0) {
      e.data.fT = 3.2;
      fan(e.x, e.y, aimAt(e.x, e.y), 5, 0.9, 4.4, { col: CYAN, size: 0.44 });
      AU.eshot();
    }
  } else if (ph === 1) {
    if (e.fireT <= 0) {
      e.fireT = 1.15;
      e.data.n = (e.data.n || 0) + 1;
      const gap = e.data.n % 2 === 0 ? 2 : 9;
      for (let i = 0; i < 16; i++) {
        if (i >= gap && i < gap + 3) continue;
        const a = i / 16 * TAU + e.pt;
        eShot(e.x, e.y, Math.cos(a) * 2.7, Math.sin(a) * 2.7, { col: VIOLET, size: 0.42 });
      }
      AU.eshot();
      if (enemies.length < 8) spawnEnemy('drone', Math.random() < 0.5 ? PLAY.halfW + 1 : -PLAY.halfW - 1, e.y - 1);
    }
  } else {
    if (e.fireT <= 0) {
      e.fireT = 0.09; e.sp += 0.23;
      for (let k = 0; k < 3; k++) {
        const a = e.sp + k * TAU / 3;
        eShot(e.x, e.y, Math.cos(a) * 3.3, Math.sin(a) * 3.3, { col: MAG, size: 0.38 });
      }
    }
    e.data.lT = (e.data.lT || 4) - dt;
    if (e.data.lT <= 0) { e.data.lT = 5.5; fireLaser(e, rand(0, TAU), 0.55); }
    e.data.rT = (e.data.rT || 1) - dt;
    if (e.data.rT <= 0) {
      e.data.rT = 0.3;
      eShot(rand(-PLAY.halfW, PLAY.halfW), S.camY + HALF_H + 1, 0, -3.4, { col: AMBER, size: 0.36 });
    }
  }
}

/* ---- 最终 Boss：灯 ---- */
function setupBulb(e) {
  e.hp = 950 * (1 + S.ng * 0.45); e.r = 2.0; e.score = 20000; e.dropPower = 0;
  e.ty = S.camY + 5.2; e.x = 0; e.phase = 0; e.pt = 0; e.fireT = 1.5;
  e.inving = true; e.entering = true; e.y = S.camY + HALF_H + 3;
  const g = new THREE.Group();
  const parts = [['Lamp Lightbulb Glass', 'LightBulb_Glass'], ['Lamp Metal', 'LightBulb_Metal'],
                 ['Lamp Ceramic Inside', 'LightBulb_Ceramic'],
                 ['Lightbulb Wire Glow', 'LightBulb_GlowingThread'], ['Lamp Screen', 'LightBulb_Screen']];
  for (const [matName, meshName] of parts) {
    const def = matDef(matName);
    if (!def || !IMAGE['mesh:' + meshName]) continue;
    g.add(new THREE.Mesh(loadMesh(meshName), buildMaterial(def)));
  }
  g.scale.setScalar(4.5);
  e.mesh = g;
  e.core = makeCard('tex/LightBulb_Glow.png', [1, 0.9, 0.6], 3.2, true);
  scene.add(e.core);
  e.orbs = [];
  for (let i = 0; i < 3; i++) {
    const orb = makeCard('tex/bokehBlur.png', CYAN, 1.6, true);
    scene.add(orb); e.orbs.push(orb);
  }
}

function updateBulb(e, dt) {
  e.pt += dt;
  if (e.entering) {
    e.y = lerp(e.y, e.ty, Math.min(1, dt * 1.1));
    if (Math.abs(e.y - e.ty) < 0.1) { e.entering = false; e.inving = false; }
  }
  e.x = Math.sin(e.pt * 0.4) * 1.6;
  if (e.mesh) { e.mesh.position.set(e.x, e.y, e.z - 0.5); e.mesh.rotation.y += dt * 0.4; }
  if (e.core) {
    e.core.position.set(e.x, e.y, e.z);
    const s = 3.2 + Math.sin(e.pt * 2.4) * 0.4 + Math.sin(e.pt * 11) * 0.12;
    e.core.scale.set(s, s, 1);
  }
  for (let i = 0; i < e.orbs.length; i++) {
    const a = e.pt * (0.7 + i * 0.23) + i * TAU / 3;
    const rr = 3.4 + Math.sin(e.pt * 0.9 + i) * 0.8;
    e.orbs[i].position.set(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr * 0.6, e.z + 0.4);
    if (e.phase >= 1 && !e.entering && !e.inving) bulbOrbFire(e, i, a, dt);
  }
  if (e.entering || e.inving) { tickInv(e, dt); return; }
  bulbFire(e, dt);
}

function bulbOrbFire(e, i, a, dt) {
  e.data['oT' + i] = (e.data['oT' + i] || 0) + dt;
  if (e.data['oT' + i] > 0.16) {
    e.data['oT' + i] = 0;
    e.data['oA' + i] = (e.data['oA' + i] || a) + 0.5;
    const oa = e.data['oA' + i];
    const p = e.orbs[i].position;
    eShot(p.x, p.y, Math.cos(oa) * 2.9, Math.sin(oa) * 2.9, { col: CYAN, size: 0.4 });
  }
}
function bulbFire(e, dt) {
  const hpr = e.hp / e.maxHp;
  const ph = hpr > 0.66 ? 0 : hpr > 0.33 ? 1 : 2;
  if (ph !== e.phase) {
    e.phase = ph; e.inving = true; e.invT = 1.0;
    clearBullets(true); clearLasers();
    S.flash = Math.max(S.flash, 0.5); S.shake = Math.max(S.shake, 0.6);
    AU.alarm();
    showBanner(ph === 1 ? '第 二 阶 段' : '最 终 阶 段',
      ph === 1 ? 'PHASE II — THE LIGHT AWAKENS' : 'PHASE III — BURNING',
      ph === 1 ? '#8fe8ff' : '#ff7ad9', 1.8);
    return;
  }
  e.fireT -= dt;
  bulbPatterns(e, ph, dt);
}

function bulbPatterns(e, ph, dt) {
  if (ph === 0) {
    if (e.fireT <= 0) {
      e.fireT = 1.3;
      e.data.n = (e.data.n || 0) + 1;
      ring(e.x, e.y, 20, 2.9, e.data.n * 0.35, { col: AMBER, size: 0.46 });
      fan(e.x, e.y - 0.5, aimAt(e.x, e.y), 3, 0.35, 4.6, { col: WHITE, size: 0.4 });
      AU.eshot();
    }
  } else if (ph === 1) {
    if (e.fireT <= 0) {
      e.fireT = 0.95;
      ring(e.x, e.y, 14, 3.1, e.pt * 1.3, { col: MAG, size: 0.42 });
      fan(e.x, e.y, aimAt(e.x, e.y), 5, 0.8, 5.0, { col: CYAN, size: 0.4 });
      AU.eshot();
    }
    e.data.lT = (e.data.lT || 3) - dt;
    if (e.data.lT <= 0) {
      e.data.lT = 4.5;
      fireLaser(e, e.pt % TAU, 0.5);
      fireLaser(e, e.pt % TAU + Math.PI, 0.5);
    }
  } else {
    if (e.fireT <= 0) {
      e.fireT = 0.8;
      e.data.n = (e.data.n || 0) + 1;
      const gapA = e.data.n * 1.1;
      for (let i = 0; i < 22; i++) {
        const a = i / 22 * TAU;
        let da = (a - gapA) % TAU; if (da < 0) da += TAU;
        if (da > 0.9 && da < 2.1) continue;
        eShot(e.x, e.y, Math.cos(a) * 3.4, Math.sin(a) * 3.4, { col: AMBER, size: 0.44 });
      }
      fan(e.x, e.y, aimAt(e.x, e.y), 5, 0.6, 5.4, { col: MAG, size: 0.4 });
      if (e.data.n % 3 === 0) ring(e.x, e.y, 26, 2.2, rand(0, TAU), { col: WHITE, size: 0.34, life: 9 });
      AU.eshot();
    }
    e.data.lT = (e.data.lT || 5) - dt;
    if (e.data.lT <= 0) { e.data.lT = 5; fireLaser(e, aimAt(e.x, e.y), 0.6); }
  }
}

const laserPool = [];
const LASER_FRAG = 'uniform float uA;varying vec2 vUv;\n' +
  'void main(){\n' +
  '  float y=abs(vUv.y-0.5)*2.0;\n' +
  '  float core=smoothstep(0.22,0.0,y);\n' +
  '  float glow=smoothstep(1.0,0.0,y)*0.45;\n' +
  '  float a=(core+glow)*uA;\n' +
  '  gl_FragColor=vec4(vec3(1.0,0.72,0.95)*a,a);\n' +
  '}';
function getLaserMesh() {
  for (const m of laserPool) if (!m.userData.used) return m;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 1 } },
    vertexShader: CARD_VERT, fragmentShader: LASER_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(cardGeo, mat);
  m.renderOrder = 4020;
  m.visible = false;
  scene.add(m);
  laserPool.push(m);
  return m;
}
function fireLaser(src, ang, angV) {
  const m = getLaserMesh();
  m.userData.used = true;
  lasers.push({ src, x: src.x, y: src.y, ang, angV: angV || 0, width: 0.42, t: 0, tele: 0.85, dur: 3.4, mesh: m });
  AU.charge();
}
function clearLasers() {
  for (const L of lasers) { L.mesh.visible = false; L.mesh.userData.used = false; }
  lasers.length = 0;
}
function updateLasers(dt) {
  for (let i = lasers.length - 1; i >= 0; i--) {
    const L = lasers[i];
    L.t += dt;
    L.ang += L.angV * dt;
    if (L.src) { L.x = L.src.x; L.y = L.src.y; }
    if (L.t > L.tele + L.dur) {
      L.mesh.visible = false; L.mesh.userData.used = false;
      lasers.splice(i, 1); continue;
    }
    const active = L.t > L.tele;
    const w = active ? L.width * (1 + 0.12 * Math.sin(S.time * 30)) : 0.06;
    const a = active ? 1.0 : 0.25 + 0.15 * Math.sin(S.time * 20);
    L.mesh.visible = true;
    L.mesh.position.set(L.x + Math.cos(L.ang) * 12, L.y + Math.sin(L.ang) * 12, -0.6);
    L.mesh.rotation.z = L.ang;
    L.mesh.scale.set(24, w, 1);
    L.mesh.material.uniforms.uA.value = a;
    if (active && player.alive && player.inv <= 0) {
      const dx = player.x - L.x, dy = player.y - L.y;
      const proj = dx * Math.cos(L.ang) + dy * Math.sin(L.ang);
      if (proj > 0 && proj < 24) {
        const d = Math.abs(-dx * Math.sin(L.ang) + dy * Math.cos(L.ang));
        if (d < w / 2 + 0.3) killPlayer();
      }
    }
  }
}

function clearBullets(toScore) {
  for (const b of shotLists.enemy) {
    if (toScore) {
      S.score += 10;
      fx.push({ x: b.x, y: b.y, z: 0, vx: rand(-1, 1), vy: rand(1, 3), age: 0, life: 0.4,
        size: 0.3, sizeV: 0, ang: 0, angV: 0, cell: CELL.star, col: b.col, a: 0.9, drag: 2 });
    }
    b.age = b.life + 1;
  }
}

let bombWave = null;
function useBomb() {
  if (S.state !== 'play' || S.paused || S.bombs <= 0 || !player.alive || bombWave) return;
  S.bombs--;
  bombWave = { r: 0.5, t: 0 };
  player.inv = Math.max(player.inv, 2.6);
  S.flash = 0.55; S.caSpike = 2.4; S.shake = 0.7;
  S.bloomBoost = 1.0;
  AU.bomb();
  for (const e of [...enemies]) {
    const d = Math.hypot(e.x - player.x, e.y - player.y);
    if (d < 15 && !e.inving) { e.hp -= 70; if (e.hp <= 0) killEnemy(e, true); }
  }
}
function updateBombWave(dt) {
  if (!bombWave) return;
  bombWave.t += dt;
  bombWave.r = 0.5 + bombWave.t * 26;
  const R = bombWave.r;
  for (const b of shotLists.enemy) {
    if (b.age <= b.life && Math.hypot(b.x - player.x, b.y - player.y) < R) {
      b.age = b.life + 1; S.score += 10;
    }
  }
  bAdd.push(player.x, player.y, 0.3, R * 1.3, 1, 0.85, 0.7, clamp(1.2 - bombWave.t, 0, 1), SH_RING);
  bAdd.push(player.x, player.y, 0.3, R, 1, 0.9, 0.8, clamp(1.4 - bombWave.t * 1.5, 0, 1), SH_DOT);
  if (bombWave.t > 1.1) bombWave = null;
}

function killPlayer() {
  if (!player.alive || player.inv > 0) return;
  player.alive = false;
  S.lives--;
  S.hitstop = 0.3;
  S.flash = 0.7; S.caSpike = 3; S.shake = 1;
  explode(player.x, player.y, true);
  spark(player.x, player.y, WHITE, 30, 8, 0.5);
  clearBullets(true);
  AU.death();
  setTimeout(() => {
    if (S.state !== 'play') return;
    if (S.lives < 0) { gameOver(); return; }
    player.alive = true; player.inv = 3;
    S.power = Math.max(1, S.power - 1);
    S.combo = 0;
  }, 900);
}

/* ============ 7. 波次导演 ============ */
let nextSpawn = 2.5, nextMiniIdx = 0, bossActive = null, zoneShown = -1;
function cycleAlt() { return S.camY - S.ng * GOAL_STEP; }

function director(dt) {
  const ca = cycleAlt();
  const zone = ca < 150 ? 0 : ca < 330 ? 1 : ca < 480 ? 2 : ca < GOAL_STEP ? 3 : 4;
  if (zone !== zoneShown) {
    zoneShown = zone;
    if (!bossActive) {
      const names = [
        ['第 一 区 · 林 间', 'THE UNDERGROWTH'],
        ['第 二 区 · 光 尘', 'THE LIGHT DUST'],
        ['第 三 区 · 枝 影', 'BRANCH & SHADOW'],
        ['第 四 区 · 星 尘', 'STARDUST'],
        ['突 破 天 际', 'BEYOND THE CANOPY — NG+' + (S.ng + 1)],
      ];
      showBanner(names[zone][0], names[zone][1], '#8fe8ff', 2);
    }
  }
  if (bossActive) return;
  if (nextMiniIdx < MINI_ALTS.length && ca >= MINI_ALTS[nextMiniIdx]) {
    nextMiniIdx++;
    startBoss('mini', '织 网 者 · THE WEAVER');
    return;
  }
  if (ca >= GOAL_STEP) { startBoss('bulb', '灯 · THE LIGHT'); return; }
  nextSpawn -= dt;
  if (nextSpawn <= 0) {
    nextSpawn = Math.max(1.0, 2.5 - D() * 0.5) * rand(0.8, 1.2);
    pickFormation();
  }
}

function pickFormation() {
  const ca = cycleAlt();
  const pool = [['arcMoths', 3]];
  if (ca > 50) pool.push(['sideLeaf', 3]);
  if (ca > 100) pool.push(['droneSweep', 2]);
  if (ca > 140) pool.push(['webTurret', 2]);
  if (ca > 240) pool.push(['mothRain', 2]);
  let sum = 0; for (const p of pool) sum += p[1];
  let r = Math.random() * sum, fn = pool[0][0];
  for (const p of pool) { r -= p[1]; if (r <= 0) { fn = p[0]; break; } }
  FORMATIONS[fn]();
}

const FORMATIONS = {
  arcMoths() {
    const n = 3 + Math.floor(Math.min(D(), 3));
    for (let i = 0; i < n; i++) {
      const x = lerp(-PLAY.halfW + 1.5, PLAY.halfW - 1.5, (i + 0.5) / n) + rand(-0.5, 0.5);
      spawnEnemy('moth', x, S.camY + HALF_H + 2 + rand(0, 2.5));
    }
  },
  sideLeaf() {
    const n = 3 + Math.floor(Math.min(D(), 3));
    const side = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < n; i++)
      spawnEnemy('leaf', side * (PLAY.halfW + 1.2), S.camY + HALF_H - 1 - i * 1.4 + rand(-0.3, 0.3));
  },
  droneSweep() {
    const n = 2 + Math.floor(Math.min(D(), 2.5));
    for (let i = 0; i < n; i++)
      spawnEnemy('drone', (i % 2 ? 1 : -1) * (PLAY.halfW + 1), S.camY + HALF_H - i * 1.8);
  },
  webTurret() {
    const n = 1 + (D() > 2.2 ? 1 : 0);
    for (let i = 0; i < n; i++)
      spawnEnemy('web', rand(-PLAY.halfW + 1.5, PLAY.halfW - 1.5), S.camY + HALF_H + 3,
        { ty: S.camY + rand(1.5, 3.5) });
  },
  mothRain() {
    for (let i = 0; i < 7; i++)
      spawnEnemy('moth', rand(-PLAY.halfW, PLAY.halfW), S.camY + HALF_H + 2 + i * 1.6);
  },
};

function startBoss(type, name) {
  const e = spawnEnemy(type, 0, S.camY + HALF_H + 3);
  bossActive = { type, name, e };
  showBanner(name, type === 'bulb' ? 'THE FINAL LIGHT — 542M' : 'MINI BOSS', '#ff7ad9', 2.2);
  AU.alarm();
  $('bossbar').classList.add('on');
  $('bossname').textContent = name;
}
function endBoss(e) {
  bossActive = null;
  $('bossbar').classList.remove('on');
  clearBullets(true); clearLasers();
  if (e.type === 'bulb') {
    S.ng++;
    S.score += 20000;
    S.bombs = Math.min(6, S.bombs + 2); S.lives = Math.min(5, S.lives + 1);
    S.hitstop = 0.6; S.caSpike = 2.5;
    showBanner('计 划 完 成', 'THE PLAN IS COMPLETE — NG+' + S.ng, '#ffb37a', 3);
  } else {
    S.bombs = Math.min(6, S.bombs + 1);
    showBanner('击 破', '+1 BOMB', '#ffb37a', 1.4);
  }
  nextMiniIdx = 0;
  nextSpawn = 2.5;
}

/* ============ 8. 弹更新与判定 ============ */
function updateShots(dt) {
  const scroll = S.climb;
  const px = player.x, py = player.y, alive = player.alive && player.inv <= 0;
  const eb = shotLists.enemy, pb = shotLists.player;

  for (let i = eb.length - 1; i >= 0; i--) {
    const b = eb[i];
    b.age += dt;
    if (b.drag) { const k = Math.max(0, 1 - b.drag * dt); b.vx *= k; b.vy *= k; }
    b.x += b.vx * dt; b.y += (b.vy - scroll) * dt;
    b.ang += b.angV * dt;
    if (b.age > b.life || b.y < S.camY - HALF_H - 5 || b.y > S.camY + HALF_H + 7 ||
        Math.abs(b.x) > PLAY.halfW + 5) { eb.splice(i, 1); continue; }
    const fadeIn = Math.min(1, b.age * 6);
    if (b.halo) bHalo.push(b.x, b.y, b.z, b.size * 3.2,
      0.015, 0.04, 0.09, 0.6 * fadeIn, SH_DOT);
    bAdd.push(b.x, b.y, b.z, b.size * 1.5, b.col[0], b.col[1], b.col[2], b.a * fadeIn, SH_BULLET);
    if (alive) {
      const dx = b.x - px, dy = b.y - py, d2 = dx * dx + dy * dy;
      const rr = b.r + 0.3;
      if (d2 < rr * rr) { killPlayer(); continue; }
      if (!b.grazed && d2 < (b.r + 0.95) * (b.r + 0.95)) {
        b.grazed = true;
        S.graze++; S.score += 12;
        S.gauge = Math.min(100, S.gauge + 0.9);
        fx.push({ x: (b.x + px) / 2, y: (b.y + py) / 2, z: 0.2, vx: rand(-1, 1), vy: rand(0.5, 2),
          age: 0, life: 0.3, size: 0.22, sizeV: 0, ang: 0, angV: 0,
          cell: CELL.dot, col: MAG, a: 0.9, drag: 2 });
        AU.graze();
      }
    }
  }

  for (let i = pb.length - 1; i >= 0; i--) {
    const b = pb[i];
    b.age += dt;
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.age > b.life || b.y > S.camY + HALF_H + 4) { pb.splice(i, 1); continue; }
    bAdd.push(b.x, b.y, b.z, b.size * 3.4, b.col[0], b.col[1], b.col[2], b.a, SH_STAR);
    for (const e of enemies) {
      if (e.inving || e.entering) continue;
      const dx = b.x - e.x, dy = b.y - e.y, rr = b.r + e.r;
      if (dx * dx + dy * dy < rr * rr) {
        e.hp -= b.dmg;
        b.age = b.life + 1;
        fx.push({ x: b.x, y: b.y, z: 0.1, vx: rand(-1.5, 1.5), vy: rand(1, 3), age: 0, life: 0.22,
          size: 0.2, sizeV: 0, ang: 0, angV: 0, cell: CELL.dot, col: WHITE, a: 0.9, drag: 2 });
        if (e.hp <= 0) {
          killEnemy(e);
          if (bossActive && bossActive.e === e) endBoss(e);
        }
        break;
      }
    }
  }
}

function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const p = fx[i];
    p.age += dt;
    if (p.age > p.life) { fx.splice(i, 1); continue; }
    if (p.drag) { const k = Math.max(0, 1 - p.drag * dt); p.vx *= k; p.vy *= k; }
    p.x += p.vx * dt; p.y += (p.vy - S.climb * 0.5) * dt;
    p.ang += p.angV * dt;
    const k = 1 - p.age / p.life;
    const sz = p.size * (1 + (p.sizeV || 0) * p.age);
    const shp = p.cell === CELL.ring ? SH_RING : (p.cell === CELL.star ? SH_STAR : SH_DOT);
    bAdd.push(p.x, p.y, p.z, shp === SH_RING ? sz * 1.6 : sz * 1.8, p.col[0], p.col[1], p.col[2], p.a * k, shp);
  }
}

/* ============ 9. 音频（WebAudio 程序合成） ============ */
const AU = {
  ctx: null, master: null, musicGain: null, sfxGain: null,
  started: false, step: 0, nextT: 0, bpm: 118,

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6;
    this.master = this.ctx.createGain();
    this.master.gain.value = S.muted ? 0 : 0.85;
    this.master.connect(comp); comp.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.6;
    this.sfxGain.connect(this.master);
    this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.34;
    this.musicGain.connect(this.master);
    // 延迟回声（给琶音一点森林空间感）
    this.delay = this.ctx.createDelay(1);
    this.delay.delayTime.value = 60 / this.bpm * 0.75;
    this.dfb = this.ctx.createGain(); this.dfb.gain.value = 0.32;
    this.delay.connect(this.dfb); this.dfb.connect(this.delay);
    this.delay.connect(this.musicGain);
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  tone(freq, dur, type, vol, slide, dest) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.sfxGain);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, vol, freq, q) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq || 900; f.Q.value = q || 0.8;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.sfxGain);
    src.start(t);
  },
  shoot() { if (Math.random() < 0.5) this.tone(920 + rand(-40, 40), 0.05, 'square', 0.028, 620); },
  eshot() { this.tone(340, 0.07, 'triangle', 0.05, 240); },
  hit() { this.noise(0.05, 0.1, 1800, 1.5); },
  boom(big) {
    this.noise(big ? 0.5 : 0.25, big ? 0.5 : 0.28, big ? 300 : 650, 0.6);
    this.tone(big ? 160 : 240, big ? 0.5 : 0.28, 'sine', big ? 0.4 : 0.22, 40);
  },
  graze() {
    const now = performance.now();
    if (now - (this._gT || 0) < 55) return;
    this._gT = now;
    this.tone(1900 + rand(-120, 120), 0.035, 'sine', 0.06, 2400);
  },
  bomb() {
    this.tone(90, 0.9, 'sawtooth', 0.3, 720);
    this.noise(0.9, 0.45, 500, 0.4);
    this.tone(1400, 0.6, 'sine', 0.14, 200);
  },
  death() { this.tone(420, 0.7, 'sawtooth', 0.3, 55); this.noise(0.5, 0.35, 400, 0.5); },
  alarm() {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) {
      setTimeout(() => { this.tone(660, 0.14, 'square', 0.12); this.tone(440, 0.14, 'square', 0.12); }, i * 260);
    }
  },
  charge() { this.tone(220, 0.85, 'sawtooth', 0.1, 880); },

  /* --- 程序化 BGM：小调琶音 + 低音 + 垫底（随难度升滤波） --- */
  CHORDS: [[45, 57, 60, 64], [41, 53, 57, 60], [48, 60, 64, 67], [43, 55, 59, 62]],
  ARP: [0, 1, 2, 3, 2, 1, 2, 3, 0, 2, 1, 3, 2, 3, 1, 2],
  midi(m) { return 440 * Math.pow(2, (m - 69) / 12); },
  startMusic() {
    if (!this.ctx || this.started) return;
    this.started = true;
    this.nextT = this.ctx.currentTime + 0.1;
  },
  tick() {
    if (!this.started || !this.ctx || S.muted) return;
    if (this.nextT < this.ctx.currentTime - 0.2) this.nextT = this.ctx.currentTime + 0.05;
    const spb = 60 / this.bpm;
    while (this.nextT < this.ctx.currentTime + 0.16) {
      const t = this.nextT, st = this.step;
      const ch = this.CHORDS[Math.floor(st / 16) % 4];
      const inten = clamp((D() - 1) / 2.2, 0, 1);
      // 琶音
      const note = ch[this.ARP[st % 16] % ch.length] + 12;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'triangle'; o.frequency.value = this.midi(note);
      g.gain.setValueAtTime(0.11, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + spb / 4 * 0.9);
      o.connect(g); g.connect(this.delay); g.connect(this.musicGain);
      o.start(t); o.stop(t + spb / 4);
      // 低音（每 4 步）
      if (st % 4 === 0) {
        const b = this.ctx.createOscillator(), bg = this.ctx.createGain();
        b.type = 'sine'; b.frequency.value = this.midi(ch[0] - 12);
        bg.gain.setValueAtTime(0.22, t);
        bg.gain.exponentialRampToValueAtTime(0.0001, t + spb / 2);
        b.connect(bg); bg.connect(this.musicGain);
        b.start(t); b.stop(t + spb / 2);
      }
      // 高强度 hat
      if (inten > 0.35 && st % 2 === 1) {
        const n = Math.floor(this.ctx.sampleRate * 0.03);
        const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
        const src = this.ctx.createBufferSource(); src.buffer = buf;
        const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
        const hg = this.ctx.createGain(); hg.gain.value = 0.05 + inten * 0.05;
        src.connect(f); f.connect(hg); hg.connect(this.musicGain);
        src.start(t);
      }
      // 垫底和弦（每 16 步）
      if (st % 16 === 0) {
        for (const m of ch.slice(1)) {
          const p = this.ctx.createOscillator(), pg = this.ctx.createGain();
          const lp = this.ctx.createBiquadFilter();
          lp.type = 'lowpass'; lp.frequency.value = 350 + inten * 900;
          p.type = 'sawtooth'; p.frequency.value = this.midi(m);
          p.detune.value = rand(-8, 8);
          pg.gain.setValueAtTime(0.0001, t);
          pg.gain.linearRampToValueAtTime(0.035, t + 0.6);
          pg.gain.linearRampToValueAtTime(0.0001, t + spb * 4);
          p.connect(lp); lp.connect(pg); pg.connect(this.musicGain);
          p.start(t); p.stop(t + spb * 4 + 0.1);
        }
      }
      this.nextT += spb / 4;
      this.step++;
    }
  },
  setMute(m) { if (this.master) this.master.gain.value = m ? 0 : 0.85; },
};

/* ============ 10. UI / 输入 ============ */
let bannerT = 0;
function showBanner(main, sub, color, dur) {
  const b = $('banner');
  b.innerHTML = main + '<span class="sub">' + (sub || '') + '</span>';
  b.style.color = color || '#fff';
  b.classList.add('on');
  bannerT = dur || 2;
}

const hudCache = {};
function setTxt(id, v) {
  if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; }
}
function updateHUD() {
  setTxt('score', S.score.toLocaleString());
  setTxt('hi', 'HI ' + Math.max(S.hi, S.score).toLocaleString());
  setTxt('graze', '' + S.graze);
  setTxt('power', '◆'.repeat(S.power) + '◇'.repeat(4 - S.power));
  setTxt('alt', Math.floor(S.camY) + ' m');
  $('railFill').style.height = clamp(cycleAlt() / GOAL_STEP * 100, 0, 100) + '%';
  const lv = $('lives');
  if (hudCache.lives !== S.lives) {
    hudCache.lives = S.lives;
    lv.innerHTML = '';
    for (let i = 0; i < Math.max(0, S.lives); i++) lv.appendChild(document.createElement('span'));
  }
  const bo = $('bombs');
  if (hudCache.bombs !== S.bombs) {
    hudCache.bombs = S.bombs;
    bo.innerHTML = '';
    for (let i = 0; i < S.bombs; i++) bo.appendChild(document.createElement('span'));
  }
  const cb = $('combo');
  const mult = comboMult();
  if (S.combo > 2) {
    cb.classList.add('on');
    setTxt('combo', 'COMBO ×' + mult.toFixed(2) + '  (' + S.combo + ')');
  } else cb.classList.remove('on');
  if (bossActive && bossActive.e) {
    $('bossfill').style.width = clamp(bossActive.e.hp / bossActive.e.maxHp * 100, 0, 100) + '%';
  }
  // 擦弹充能 → 自动补充炸弹
  if (S.gauge >= 100) { S.gauge = 0; S.bombs = Math.min(6, S.bombs + 1); AU.tone(1200, 0.3, 'sine', 0.15, 1800); }
}

const keys = {};
const mouse = { active: false };
function bindInput() {
  $('startBtn').addEventListener('click', startGame);
  $('retryBtn').addEventListener('click', startGame);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.preventDefault();
    keys[e.code] = true;
    AU.init(); AU.resume();
    if (e.code === 'KeyM') { S.muted = !S.muted; AU.setMute(S.muted); }
    if (S.state === 'title' && (e.code === 'KeyZ' || e.code === 'Enter' || e.code === 'Space')) startGame();
    else if (S.state === 'over' && (e.code === 'KeyZ' || e.code === 'Enter')) startGame();
    if (S.state === 'play' && (e.code === 'KeyP' || e.code === 'Escape')) togglePause();
    if (S.state === 'play' && !S.paused && (e.code === 'KeyX' || e.code === 'KeyK')) useBomb();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const dom = $('app');
  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  dom.addEventListener('pointerdown', (e) => {
    AU.init(); AU.resume();
    if (e.button === 2) { useBomb(); return; }
    mouse.active = true;
    setMouseWorld(e);
  });
  dom.addEventListener('pointermove', (e) => { if (mouse.active || e.pointerType === 'mouse') setMouseWorld(e); });
  dom.addEventListener('pointerup', () => { mouse.active = false; });
  $('bombBtn').addEventListener('pointerdown', (e) => { e.stopPropagation(); useBomb(); });
  if ('ontouchstart' in window) $('bombBtn').classList.add('on');
  window.addEventListener('blur', () => { if (S.state === 'play' && !S.paused) togglePause(); });
}
function setMouseWorld(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.nx = (e.clientX - rect.left) / rect.width * 2 - 1;
  mouse.ny = -((e.clientY - rect.top) / rect.height * 2 - 1);
  updateMouseTarget();
  mouse.active = true;
}
// 每帧用当前相机把鼠标 NDC 反投影到 z=0 平面（消除相机跟随视差）
function updateMouseTarget() {
  if (mouse.nx === undefined) return;
  camera3.updateMatrixWorld();
  const v = new THREE.Vector3(mouse.nx, mouse.ny, 0.5).unproject(camera3);
  const dir = v.sub(camera3.position).normalize();
  if (Math.abs(dir.z) > 1e-4) {
    const t = -camera3.position.z / dir.z;
    if (t > 0) {
      player.wx = camera3.position.x + dir.x * t;
      player.wy = camera3.position.y + dir.y * t;
    }
  }
}
function togglePause() {
  S.paused = !S.paused;
  $('pauseOv').classList.toggle('hidden', !S.paused);
}

/* ============ 11. 后期链 ============ */
const RT = {};
let postScene, postCam, postMesh, pMats;
function makeRT(w, h, depth, type) {
  return new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: type || THREE.UnsignedByteType,
    depthBuffer: !!depth, stencilBuffer: false,
  });
}
function buildPost() {
  bHalo = new PointBatch(1600, THREE.NormalBlending, 3990);
  bAdd = new PointBatch(3000, THREE.AdditiveBlending, 4000);
  scene.add(bHalo.mesh);
  scene.add(bAdd.mesh);
  postScene = new THREE.Scene();
  postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  postMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }));
  postMesh.frustumCulled = false;
  postScene.add(postMesh);
  const Q = (frag, uniforms) => new THREE.ShaderMaterial({
    uniforms, vertexShader: QUAD_VERT, fragmentShader: frag, depthTest: false, depthWrite: false,
  });
  pMats = {
    bright: Q(BRIGHT_FRAG, { tDiffuse: { value: null }, uThr: { value: 0.82 } }),
    blur: Q(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2() } }),
    comp: Q(COMP_FRAG, {
      tScene: { value: null }, tBloom: { value: null },
      tVig: { value: loadTexture('tex/Vignette.png') },
      uRes: { value: new THREE.Vector2() }, uTime: { value: 0 },
      uBloom: { value: S.bloom }, uVig: { value: 0.42 }, uGrain: { value: 0.03 }, uLift: { value: 0.06 },
      uCA: { value: 0.5 }, uFlash: { value: 0 },
    }),
  };
  resize();
}
function blit(mat, target) {
  postMesh.material = mat;
  renderer.setRenderTarget(target || null);
  renderer.clear(true, true, false);
  renderer.render(postScene, postCam);
}
function resize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  if (camera3) {
    camera3.aspect = w / h;
    camera3.updateProjectionMatrix();
  }
  PLAY.halfW = clamp(HALF_H * (w / h) - 0.5, 6, 24);
  S.hsc = Math.max(1, PLAY.halfW / 13);   // 横向速度缩放（战场变宽，敌人横向同步加速）
  const type = renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const hw = Math.max(2, Math.floor(w / 2)), hh = Math.max(2, Math.floor(h / 2));
  ['rtScene', 'rtA', 'rtB'].forEach(k => RT[k] && RT[k].dispose());
  RT.rtScene = makeRT(w, h, true, type);
  RT.rtA = makeRT(hw, hh, false, type);
  RT.rtB = makeRT(hw, hh, false, type);
  if (pMats) {
    pMats.blur.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    pMats.comp.uniforms.uRes.value.set(w, h);
  }
}

/* ============ 12. 游戏状态 ============ */
function resetGame() {
  for (const e of enemies) removeEnemyVisual(e);
  enemies.length = 0;
  shotLists.enemy.length = 0;
  shotLists.player.length = 0;
  fx.length = 0;
  lasers.length = 0;
  bombWave = null;
  bossActive = null;
  Object.assign(S, {
    camY: 0, climb: 0, score: 0, lives: 3, bombs: 3, gauge: 0, power: 1,
    kills: 0, graze: 0, combo: 0, comboT: 0, ng: 0,
    shake: 0, flash: 0, caSpike: 0, hitstop: 0, bloomBoost: 0,
  });
  nextSpawn = 2.2; nextMiniIdx = 0; zoneShown = -1;
  player.alive = true; player.inv = 2.5;
  player.x = 0; player.ry = -3; player.px = 0;
  $('bossbar').classList.remove('on');
  hudCache.lives = hudCache.bombs = null;
}
function startGame() {
  AU.init(); AU.resume(); AU.startMusic();
  resetGame();
  S.state = 'play'; S.paused = false;
  $('title').classList.add('hidden');
  $('over').classList.add('hidden');
  $('pauseOv').classList.add('hidden');
  $('hud').classList.add('on');
  showBanner('起 飞', 'TOWARD THE LIGHT — 600M', '#8fe8ff', 2);
}
function gameOver() {
  S.state = 'over';
  $('hud').classList.remove('on');
  const isRec = S.score > S.hi;
  if (isRec) { S.hi = S.score; localStorage.setItem('ttl_hi', S.hi); }
  $('rScore').textContent = S.score.toLocaleString();
  $('rAlt').textContent = Math.floor(S.camY) + ' m';
  $('rGraze').textContent = S.graze;
  $('rLv').textContent = 'NG+' + S.ng;
  $('rHi').textContent = S.hi.toLocaleString();
  $('newRec').classList.toggle('on', isRec);
  $('cause').textContent = bossActive ? '被光吞没' : '坠落黑暗';
  $('over').classList.remove('hidden');
  AU.tone(240, 1.2, 'sawtooth', 0.2, 60);
}

/* ============ 13. 主循环 ============ */
function updateCamera(dt) {
  const shx = (Math.random() - 0.5) * S.shake * 0.5;
  const shy = (Math.random() - 0.5) * S.shake * 0.5;
  // 固定朝前：屏幕坐标 ↔ 世界坐标严格线性，鼠标映射零偏差
  camera3.position.set(shx, S.camY + shy, CAM_Z);
  camera3.lookAt(shx, S.camY + shy, 0);
  S.shake = Math.max(0, S.shake - dt * 2.2);
}
function renderFrame(t) {
  camera3.updateMatrixWorld();
  waveMats.forEach(m => { m.uniforms.uTime.value = t; });
  const vh = renderer.domElement.height, frv = FOV * Math.PI / 180;
  bAdd.mat.uniforms.uViewH.value = vh;
  bAdd.mat.uniforms.uFovRad.value = frv;
  bHalo.mat.uniforms.uViewH.value = vh;
  bHalo.mat.uniforms.uFovRad.value = frv;

  renderer.setRenderTarget(RT.rtScene);
  renderer.clear(true, true, false);
  renderer.render(scene, camera3);

  pMats.bright.uniforms.tDiffuse.value = RT.rtScene.texture;
  blit(pMats.bright, RT.rtA);
  for (let i = 0; i < 3; i++) {
    const r = 1 + i * 1.7;
    pMats.blur.uniforms.tDiffuse.value = RT.rtA.texture;
    pMats.blur.uniforms.uDir.value.set(r, 0);
    blit(pMats.blur, RT.rtB);
    pMats.blur.uniforms.tDiffuse.value = RT.rtB.texture;
    pMats.blur.uniforms.uDir.value.set(0, r);
    blit(pMats.blur, RT.rtA);
  }
  const u = pMats.comp.uniforms;
  u.tScene.value = RT.rtScene.texture;
  u.tBloom.value = RT.rtA.texture;
  u.uTime.value = t;
  S.bloomBoost = Math.max(0, S.bloomBoost - S.dt * 1.6);
  u.uBloom.value = S.bloom + S.bloomBoost;
  S.flash = Math.max(0, S.flash - S.dt * 1.8);
  u.uFlash.value = S.flash;
  S.caSpike = Math.max(0, S.caSpike - S.dt * 2.4);
  u.uCA.value = 0.5 + S.caSpike;
  blit(pMats.comp, null);
}

function stepGame(dt) {
  S.time += dt;
  // 爬升（Boss 战时悬停）
  const bossHold = !!bossActive;
  const ramp = clamp(S.time / 3, 0, 1);
  const target = bossHold ? 0 : ramp * (5.5 + Math.min(S.ng, 3) * 1.2 + cycleAlt() / GOAL_STEP * 2.4);
  S.climb = lerp(S.climb, target, Math.min(1, dt * 3));
  S.camY += S.climb * dt;

  if (player.alive) { updatePlayer(dt); }
  else if (player.group) player.group.visible = false;
  director(dt);
  updateEnemies(dt);
  updateShots(dt);
  updateLasers(dt);
  updateBombWave(dt);
  updateFx(dt);
  updateSlots();
  updateBackdrop();
  updateCamera(dt);

  // 连击衰减
  if (S.comboT > 0) { S.comboT -= dt; if (S.comboT <= 0) S.combo = 0; }
  // Boss 血条
  if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) $('banner').classList.remove('on'); }
}

function animate() {
  requestAnimationFrame(animate);
  let dt = Math.min(0.05, clock.getDelta());
  S.realTime += dt;
  S.dt = dt;
  AU.tick();
  bAdd.begin(); bHalo.begin();
  if (S.state === 'play' && !S.paused) {
    if (S.hitstop > 0) { S.hitstop -= dt; dt *= 0.15; }
    stepGame(dt);
    updateAmbient(dt, S.realTime);
    updateHUD();
  } else if (S.state === 'title' || S.state === 'over') {
    // 标题 / 结算画面：森林缓慢巡游
    S.camY += dt * 1.2;
    S.time += dt;
    updateSlots(); updateBackdrop(); updateAmbient(dt, S.time);
    updateCamera(dt);
    const g = player.group;
    if (g) {
      g.visible = S.state === 'title';
      g.position.set(Math.sin(S.time * 0.7) * 1.5, S.camY - 1.5 + Math.sin(S.time * 1.1) * 0.5, 0);
      if (player.wings) player.wings.rotation.x = Math.sin(S.time * 40) * 0.5;
    }
    if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) $('banner').classList.remove('on'); }
  }
  bHalo.flush(); bAdd.flush();
  renderFrame(S.realTime);
}

/* ============ 14. 启动 ============ */
function setProgress(p, msg) {
  $('loadBar').style.width = (p * 100).toFixed(0) + '%';
  if (msg) $('loadMsg').textContent = msg;
}
function fetchJSON(url) {
  return fetch(url).then(r => {
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.json();
  });
}
function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('img ' + url));
    im.src = url;
  });
}

async function boot() {
  renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.autoClear = false;
  $('app').appendChild(renderer.domElement);
  window.addEventListener('resize', resize);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  camera3 = new THREE.PerspectiveCamera(FOV, 1, 0.3, 400);
  clock = new THREE.Clock();

  setProgress(0.08, '场景图…');
  envData = await fetchJSON('scene.json');

  setProgress(0.15, '贴图…');
  const texList = {
    dot: 'tex/TinasDOT.png', star: 'tex/Star_2.png', soft: 'tex/Soft.png',
    bokeh: 'tex/bokehBlur.png', puff: 'tex/Default-Particle.png', glow: 'tex/LightBulb_Glow.png',
  };
  const imgs = await Promise.all(Object.entries(texList).map(([k, u]) => loadImg(u).then(im => [k, im])));
  for (const [k, im] of imgs) IMAGE[k] = im;
  buildAtlas();

  setProgress(0.3, '网格…');
  const meshFiles = ['Combined Mesh _root_ scene_', 'LowPoly_fly', 'LowPoly_fly_WINGS', 'SpiderWeb_Mesh',
    'LightBulb_Glass', 'LightBulb_Metal', 'LightBulb_Ceramic', 'LightBulb_GlowingThread', 'LightBulb_Screen'];
  const used = new Set();
  for (const r of envData.renderers) {
    if (r.mesh.includes('Combined')) continue;
    if (r.pos[1] < 0 || r.pos[1] >= BAND_H || isJunk(r.name)) continue;
    used.add(r.mesh);
  }
  const all = [...new Set([...used, ...meshFiles])];
  let done = 0;
  for (const mf of all) {
    const name = mf;
    const file = 'mesh/' + name + '.json';
    try {
      const data = await fetchJSON(file);
      IMAGE['mesh:' + name] = data;
    } catch (e) { console.warn('skip mesh', name, e.message); }
    done++;
    setProgress(0.3 + 0.5 * done / all.length, '网格 ' + done + '/' + all.length);
  }
  IMAGE['mesh:Combined'] = IMAGE['mesh:Combined Mesh _root_ scene_'];

  buildSceneParticles();
  setProgress(0.85, '构建森林…');
  buildWorld();
  buildPlayer();
  setProgress(0.94, '后期链…');
  buildPost();
  bindInput();
  $('titleHi').textContent = S.hi.toLocaleString();

  setProgress(1, '完成');
  S.state = 'title';
  $('load').style.display = 'none';
  animate();
}

boot().catch(e => {
  console.error(e);
  $('load').innerHTML = '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#05070a;color:#eee">' +
    '<div style="max-width:520px;padding:16px;background:#141a22;border-radius:10px"><b>装载失败</b><br>' +
    (e && e.message ? e.message : e) +
    '<br><br>请通过本地 HTTP 服务打开，例如：<code>python -m http.server 8807</code></div></div>';
});

/* 调试钩子 */
window.__G = {
  S, player, enemies, shotLists, FORMATIONS,
  get cam() { return camera3; }, get scene() { return scene; },
  get renderer() { return renderer; }, get pMats() { return pMats; }, get slots() { return slots; },
  get bAdd() { return bAdd; }, get bHalo() { return bHalo; },
  bomb: useBomb, kill: killPlayer, boss: () => startBoss('mini', '织 网 者'),
  bulb: () => startBoss('bulb', '灯'),
  warp(alt) { S.camY = alt; },
};
})();

