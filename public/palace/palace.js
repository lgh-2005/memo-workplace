/* 单词记忆宫殿 · 3D 子应用（v4.9.0）
 *
 * 为什么是一个「子应用」而不是主站的一个页签：
 *  - 它要 three.js（约 700KB 未压缩 / 170KB gzip），而主站首屏现在是 195KB gzip。
 *    挂成独立的 /palace/ 之后，主站只多一个 iframe 与一条 API，字节零增长。
 *  - 它自己的缓存策略与主站 SW 无关，发版互不影响。
 *
 * 为什么用程序化几何而不是 GLB：
 *  原项目要求用户先在 Blender 建好房子再导出 .glb，对「背单词」是纯负担，
 *  还自带 9.2MB 素材。这里按「房间 + 位置」两行文字生成墙壁地面，零素材、秒开，
 *  loci 的坐标也天然稳定（房间号 + 序号，不依赖模型重导出）。
 *
 * 为什么能力探测：Pointer Lock / Fullscreen 只在安全上下文（HTTPS / localhost）可用，
 *  线上当前是 http://IP。探测失败自动切「拖动转头 + 点地面走过去」，不报错、不白屏。
 */

import * as THREE from './vendor/three.module.min.js';

/* ============================ 常量 ============================ */
const EYE = 1.62;                // 视高（米）
const SPEED = 2.6;               // 走速（米/秒）
const TURN = 1.9;                // 拖动转头的灵敏度（弧度/像素 * 0.002 后约等于）
const NEAR_DIST = 1.9;           // 触发「靠近提示」的距离
const WALL_H = 2.9;
const ROOM_W = 5.4;              // 单间宽（x）
const ROOM_D = 6.2;              // 单间深（z）
const GAP = 4.2;                 // 房间之间的走廊宽
const GRADE_ORDER = ['again', 'hard', 'good'];

/* ============================ 状态 ============================ */
const S = {
  palace: null,
  stats: null,
  slots: [],            // [{id, room, label, num, pos:{x,z}, normal:{x,z}, word?}]
  rooms: [],            // [{name, x0,x1,z0,z1}]
  gradeQueue: [],       // 复习队列 [{slotId, word}]
  gradeIdx: 0,
  gradeLog: [],         // [{slotId, grade, startedAt}]
  canLock: false,
  locked: false,
  dragging: false,
  keys: new Set(),
  activeSlot: null,
  reviewOpen: false,
  cam: { x: 0, z: 0, yaw: 0, pitch: 0 },
  walkTarget: null,
  lastT: 0,
  revealed: false,
  reviewStartedAt: 0,
};

const $ = (id) => document.getElementById(id);

/* ============================ three 基础 ============================ */
let renderer, scene, camera, clock;
let markerGroup, hoveredMarker = null;
const markers = [];     // {slot, sprite, ring, mat}

function hasSecureContext() {
  return (typeof window.isSecureContext === 'boolean')
    ? window.isSecureContext
    : (location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x1a1917, 1);
  $('stage').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1917);
  scene.fog = new THREE.FogExp2(0x1a1917, 0.020);

  camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.06, 90);
  camera.position.set(0, EYE, 0);

  clock = new THREE.Clock();

  const hemi = new THREE.HemisphereLight(0xfff2df, 0x4a4238, 1.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe6c2, 1.15);
  key.position.set(6, 12, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fb4d8, 0.6);
  fill.position.set(-8, 6, -6);
  scene.add(fill);

  markerGroup = new THREE.Group();
  scene.add(markerGroup);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

/* ---------- 建屋子：房间按网格排布，相邻房间用短走廊连起来 ---------- */
function layoutGeometry(rooms) {
  // 一行排开：x 方向依次排列，房间之间留走廊
  const out = [];
  let cursorX = 0;
  rooms.forEach((r) => {
    const x0 = cursorX;
    const x1 = cursorX + ROOM_W;
    out.push({ name: r, x0, x1, z0: -ROOM_D / 2, z1: ROOM_D / 2 });
    cursorX = x1 + GAP;
  });
  return out;
}

function buildWorld() {
  // 地面基底（整片，避免房间之间露空）
  const total = S.rooms.length * (ROOM_W + GAP) + 6;
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 0.95, metalness: 0 });
  const base = new THREE.Mesh(new THREE.PlaneGeometry(total, ROOM_D + GAP * 2), floorMat);
  base.rotation.x = -Math.PI / 2;
  base.position.set((S.rooms.length * (ROOM_W + GAP)) / 2 - GAP / 2, -0.01, 0);
  scene.add(base);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x7a6a56, roughness: 0.9, metalness: 0 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x8d7a62, roughness: 0.8 });

  S.rooms.forEach((room, i) => {
    const cx = (room.x0 + room.x1) / 2;
    const cz = 0;
    const w = room.x1 - room.x0;
    const d = room.z1 - room.z0;

    // 房间地板（浅一点，视觉上分间）
    const f = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.06, d - 0.06), new THREE.MeshStandardMaterial({ color: 0x594e40, roughness: 0.9 }));
    f.rotation.x = -Math.PI / 2;
    f.position.set(cx, 0.005, cz);
    scene.add(f);

    // 四面墙（左右两侧留门洞：只有 i>0 的左墙与 i<n-1 的右墙开洞）
    const openLeft = i > 0;
    const openRight = i < S.rooms.length - 1;
    addWall(cx, cz - d / 2, w, 0, wallMat);                 // 后墙（-z）
    addWall(cx, cz + d / 2, w, 0, wallMat);                 // 前墙（+z）
    if (openLeft) { addDoorWall(room.x0, cz, d, 'left', wallMat, trimMat); }
    else { addWall(room.x0, cz, d, Math.PI / 2, wallMat); }
    if (openRight) { addDoorWall(room.x1, cz, d, 'right', wallMat, trimMat); }
    else { addWall(room.x1, cz, d, Math.PI / 2, wallMat); }
  });
}

/** 一面完整的墙（沿 x 方向）；rot=Math.PI/2 时沿 z 方向 */
function addWall(cx, cz, len, rot, mat) {
  const geo = new THREE.BoxGeometry(len, WALL_H, 0.12);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(cx, WALL_H / 2, cz);
  m.rotation.y = rot;
  scene.add(m);
}

/** 带门洞的侧墙：左右两段 + 上方门楣 */
function addDoorWall(x, cz, d, side, mat, trimMat) {
  const doorW = 1.5;
  const segLen = (d - doorW) / 2;
  const geoA = new THREE.BoxGeometry(segLen, WALL_H, 0.12);
  const back = new THREE.Mesh(geoA, mat);
  back.position.set(x, WALL_H / 2, cz - (doorW / 2 + segLen / 2));
  back.rotation.y = Math.PI / 2;
  scene.add(back);
  const front = new THREE.Mesh(geoA.clone(), mat);
  front.position.set(x, WALL_H / 2, cz + (doorW / 2 + segLen / 2));
  front.rotation.y = Math.PI / 2;
  scene.add(front);
  // 门楣
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.4, 0.42, 0.16), trimMat);
  lintel.position.set(x, WALL_H - 0.21, cz);
  lintel.rotation.y = Math.PI / 2;
  scene.add(lintel);
  // 走廊地面
  const pass = new THREE.Mesh(new THREE.PlaneGeometry(GAP + 0.2, doorW + 0.5), new THREE.MeshStandardMaterial({ color: 0x504638, roughness: 0.95 }));
  pass.rotation.x = -Math.PI / 2;
  pass.position.set(x + (side === 'right' ? GAP / 2 : -GAP / 2), 0.004, cz);
  scene.add(pass);
}

/* ---------- 编号标记：圆环 + 数字贴图 ---------- */
function makeNumberTexture(num) {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  g.fillStyle = 'rgba(163,74,50,0.92)';
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(255,241,226,0.9)';
  g.stroke();
  g.fillStyle = '#fff6ea';
  g.font = 'bold 62px Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(num), size / 2, size / 2 + 3);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildMarkers() {
  while (markerGroup.children.length) markerGroup.remove(markerGroup.children[0]);
  markers.length = 0;

  S.slots.forEach((slot) => {
    const tex = makeNumberTexture(slot.num);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.42, 0.42, 0.42);
    sprite.position.set(slot.pos.x, EYE + 0.02, slot.pos.z);
    markerGroup.add(sprite);

    const ringGeo = new THREE.RingGeometry(0.20, 0.28, 40);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xa34a32, transparent: true, opacity: 0.72, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(slot.pos.x, 0.02, slot.pos.z);
    ring.rotation.x = -Math.PI / 2;
    markerGroup.add(ring);

    markers.push({ slot, sprite, ring });
  });
}

function refreshMarkerLook() {
  const now = performance.now();
  markers.forEach(({ slot, sprite, ring }) => {
    const filled = !!slot.word;
    if (filled) {
      sprite.material.opacity = 1;
      sprite.scale.setScalar(0.42);
      ring.material.color.setHex(0xa34a32);
      ring.material.opacity = 0.72;
    } else {
      sprite.material.opacity = 0.34;
      sprite.scale.setScalar(0.32);
      ring.material.color.setHex(0x8b8378);
      ring.material.opacity = 0.35;
    }
    // 轻微呼吸（只对已放词的位置，避免整屏都在动）
    if (filled) {
      const k = 0.42 + Math.sin(now / 700 + slot.num) * 0.018;
      sprite.scale.setScalar(k);
    }
    const active = S.activeSlot && S.activeSlot.id === slot.id;
    ring.scale.setScalar(active ? 1.5 : 1);
  });
}

/* ============================ 数据 ============================ */
async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {}));
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) {
    const msg = (data && (data.error || data.reason)) || ('请求失败 (' + res.status + ')');
    throw new Error(msg);
  }
  return data;
}

async function loadState() {
  const data = await api('/api/palace/state', { method: 'GET' });
  S.palace = data.palace;
  S.stats = data.stats;
  rebuildSlots();
  updateHud();
}

/** 把 palace.slots + occupied 摊平成「带坐标与序号的槽位」，坐标由房间序号确定。 */
function rebuildSlots() {
  const roomNames = [];
  for (const s of S.palace.layout.slots) if (!roomNames.includes(s.room)) roomNames.push(s.room);
  S.rooms = layoutGeometry(roomNames);

  S.slots = S.palace.layout.slots.map((s, idx) => {
    const ri = roomNames.indexOf(s.room);
    const room = S.rooms[ri] || S.rooms[0];
    // 同一房间内按序号均分到前墙（-z 一侧），面向房间内部
    const sameRoom = S.palace.layout.slots.filter(x => x.room === s.room);
    const k = sameRoom.findIndex(x => x.id === s.id);
    const span = (room.x1 - room.x0) - 1.6;
    const x = room.x0 + 0.8 + (sameRoom.length === 1 ? span / 2 : (span * k) / (sameRoom.length - 1));
    const occ = S.palace.occupied[s.id];
    return {
      id: s.id, room: s.room, label: s.label, num: idx + 1,
      pos: { x, z: room.z0 + 0.55 },
      normal: { x: 0, z: 1 },
      word: occ ? occ.word : '',
      occ: occ || null,
    };
  });
}

function updateHud() {
  const st = S.stats || { occupied: 0, slots: 0, due: 0 };
  $('hudCount').textContent = `${st.occupied} / ${st.slots}`;
  $('hudDue').textContent = `${st.due} 词到期`;
  const room = nearestRoomName();
  if (room) $('hudRoom').textContent = room;
}

function nearestRoomName() {
  let best = null, bestD = Infinity;
  for (const r of S.rooms) {
    const cx = (r.x0 + r.x1) / 2;
    const d = Math.abs(S.cam.x - cx);
    if (d < bestD) { bestD = d; best = r.name; }
  }
  return best;
}

/* ============================ 移动与转向 ============================ */
function clampToWorld() {
  // 允许在房间与走廊内走，但不让玩家跑出整体范围
  const first = S.rooms[0], last = S.rooms[S.rooms.length - 1];
  const minX = first.x0 + 0.45, maxX = last.x1 - 0.45;
  const minZ = -ROOM_D / 2 + 0.45, maxZ = ROOM_D / 2 - 0.45;
  S.cam.x = Math.min(maxX, Math.max(minX, S.cam.x));
  S.cam.z = Math.min(maxZ, Math.max(minZ, S.cam.z));
}

function applyCamera() {
  camera.position.set(S.cam.x, EYE, S.cam.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = S.cam.yaw;
  camera.rotation.x = S.cam.pitch;
}

function forwardDir() {
  return { x: -Math.sin(S.cam.yaw), z: -Math.cos(S.cam.yaw) };
}

function stepMove(dt) {
  if (S.walkTarget) {
    const dx = S.walkTarget.x - S.cam.x;
    const dz = S.walkTarget.z - S.cam.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.12) { S.walkTarget = null; }
    else {
      const v = Math.min(SPEED * dt, dist);
      S.cam.x += (dx / dist) * v;
      S.cam.z += (dz / dist) * v;
      S.cam.yaw = Math.atan2(-dx, -dz);
    }
    return;
  }
  const k = S.keys;
  let mx = 0, mz = 0;
  const f = forwardDir();
  const r = { x: -f.z, z: f.x };
  if (k.has('w')) { mx += f.x; mz += f.z; }
  if (k.has('s')) { mx -= f.x; mz -= f.z; }
  if (k.has('a')) { mx -= r.x; mz -= r.z; }
  if (k.has('d')) { mx += r.x; mz += r.z; }
  const len = Math.hypot(mx, mz);
  if (len > 0) {
    S.cam.x += (mx / len) * SPEED * dt;
    S.cam.z += (mz / len) * SPEED * dt;
  }
}

/** 找出视线前方最近、且在触发距离内的槽位 */
function slotInSight() {
  const f = forwardDir();
  let best = null, bestScore = -Infinity;
  for (const s of S.slots) {
    const dx = s.pos.x - S.cam.x;
    const dz = s.pos.z - S.cam.z;
    const dist = Math.hypot(dx, dz);
    if (dist > NEAR_DIST + 1.4) continue;
    const dot = (dx / (dist || 1)) * f.x + (dz / (dist || 1)) * f.z;
    if (dot < 0.55) continue;                 // 大致朝它看才算
    const score = dot * 2 - dist * 0.25;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

/* ============================ 面板逻辑 ============================ */
function openSlot(slot) {
  S.activeSlot = slot;
  closeReview();
  $('slotPanel').hidden = false;
  $('slotWhere').textContent = `${slot.room} · ${slot.label} · 第 ${slot.num} 个位置`;
  $('slotWord').textContent = slot.word || '（空位）';
  $('slotGloss').textContent = slot.occ ? [slot.occ.phonetic, slot.occ.gloss].filter(Boolean).join('  ') : '把今天要记的词放进来';
  $('mnemonicInput').value = slot.occ ? slot.occ.mnemonic || '' : '';
  $('mnemonicCount').textContent = `${$('mnemonicInput').value.length} / 300`;
  $('slotRoute').textContent = slot.occ ? routeLabel(slot.occ.route) : '';
  $('swapInput').value = slot.word || '';
  $('swapMsg').textContent = '';
  $('candBox').hidden = true;
  $('candBox').innerHTML = '';
  $('btnClearSlot').disabled = !slot.occ;
  refreshMarkerLook();
}

function closeSlot() {
  S.activeSlot = null;
  $('slotPanel').hidden = true;
  refreshMarkerLook();
}

function routeLabel(r) {
  return { origin: '词源', sound: '谐音', scene: '画面' }[r] || '';
}

async function saveMnemonic() {
  const slot = S.activeSlot;
  if (!slot || !slot.occ) return;
  const text = $('mnemonicInput').value.trim();
  try {
    const data = await api('/api/palace/slot', {
      method: 'POST',
      body: JSON.stringify({ slotId: slot.id, mnemonic: text }),
    });
    slot.occ = data.placed;
    slot.word = data.placed.word;
    $('swapMsg').textContent = '已保存';
  } catch (e) {
    $('swapMsg').textContent = '保存失败：' + e.message;
  }
}

async function generateCandidates() {
  const slot = S.activeSlot;
  if (!slot || !slot.word) { $('swapMsg').textContent = '这个位置还没有词'; return; }
  const box = $('candBox');
  const btn = $('btnGenCand');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const data = await api('/api/palace/mnemonic', { method: 'POST', body: JSON.stringify({ word: slot.word }) });
    if (!data.ok) {
      box.hidden = false;
      box.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'msg';
      d.textContent = data.reason === 'no_llm' ? '还没配置 AI 服务商，先自己想一条也行。' : '这次没生成出来，可以再点一次。';
      box.appendChild(d);
      return;
    }
    box.hidden = false;
    box.innerHTML = '';
    data.candidates.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cand';
      const route = document.createElement('span');
      route.className = 'cand-route';
      route.textContent = routeLabel(c.route) || '候选';
      b.appendChild(route);
      b.appendChild(document.createTextNode(c.text));
      if (c.hook) {
        const h = document.createElement('span');
        h.className = 'cand-hook';
        h.textContent = '钩住：' + c.hook;
        b.appendChild(h);
      }
      b.addEventListener('click', () => {
        // 拍板这一步留给学习者：填入输入框，可再改
        $('mnemonicInput').value = c.text;
        $('mnemonicCount').textContent = `${c.text.length} / 300`;
        $('slotRoute').textContent = routeLabel(c.route);
        $('mnemonicInput').focus();
      });
      box.appendChild(b);
    });
  } catch (e) {
    box.hidden = false;
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'msg';
    d.textContent = '生成失败：' + e.message;
    box.appendChild(d);
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 出 3 条候选';
  }
}

async function swapWord() {
  const slot = S.activeSlot;
  if (!slot) return;
  const word = $('swapInput').value.trim();
  if (!word) return;
  try {
    const data = await api('/api/palace/assign', { method: 'POST', body: JSON.stringify({ slotId: slot.id, word }) });
    S.stats = data.stats;
    await loadState();
    const again = S.slots.find(s => s.id === slot.id);
    openSlot(again);
    updateHud();
    $('swapMsg').textContent = data.placed.gloss ? '已放入' : '已放入（本地词库没有这个词的释义）';
  } catch (e) {
    $('swapMsg').textContent = '放入失败：' + e.message;
  }
}

async function clearSlot() {
  const slot = S.activeSlot;
  if (!slot || !slot.occ) return;
  try {
    const data = await api('/api/palace/assign', { method: 'POST', body: JSON.stringify({ slotId: slot.id, word: '' }) });
    S.stats = data.stats;
    await loadState();
    const again = S.slots.find(s => s.id === slot.id);
    openSlot(again);
    updateHud();
    $('swapMsg').textContent = '已取下（词的复习记录不受影响）';
  } catch (e) {
    $('swapMsg').textContent = '取下失败：' + e.message;
  }
}

/* ============================ 复习 ============================ */
function startReview() {
  const filled = S.slots.filter(s => s.word);
  if (!filled.length) {
    $('proxLabel').textContent = '';
    closeSlot();
    $('doneBox').hidden = false;
    $('doneTitle').textContent = '宫殿里还没有词';
    $('doneSub').textContent = '先走到任意编号位置，点一下，把今天要记的词放进去。';
    return;
  }
  // 只复习「到期」的优先；没有到期的就全屋走一遍
  const due = filled.filter(s => {
    const srs = (S.palace.occupied[s.id] || {});
    return srs.word;
  });
  S.gradeQueue = due.map(s => ({ slotId: s.id }));
  S.gradeIdx = 0;
  S.gradeLog = [];
  S.reviewOpen = true;
  $('slotPanel').hidden = true;
  S.activeSlot = null;
  $('reviewPanel').hidden = false;
  showReviewStep();
}

function currentReviewSlot() {
  const q = S.gradeQueue[S.gradeIdx];
  if (!q) return null;
  return S.slots.find(s => s.id === q.slotId) || null;
}

function showReviewStep() {
  const slot = currentReviewSlot();
  if (!slot) return finishReview();
  S.revealed = false;
  S.reviewStartedAt = performance.now();
  // 站到它面前
  S.cam.x = slot.pos.x;
  S.cam.z = slot.pos.z + 1.7;
  S.cam.yaw = 0;
  S.cam.pitch = -0.05;
  applyCamera();
  $('rvWhere').textContent = `${slot.room} · ${slot.label} · 第 ${slot.num} 个位置`;
  $('rvProgress').textContent = `${S.gradeIdx + 1} / ${S.gradeQueue.length}`;
  $('rvCue').textContent = '看清这个位置，先在心里回想放了什么。';
  $('rvReveal').hidden = true;
  $('rvGrades').hidden = true;
  $('btnReveal').hidden = false;
  $('rvFoot').textContent = '';
}

function revealAnswer() {
  const slot = currentReviewSlot();
  if (!slot || S.revealed) return;
  S.revealed = true;
  $('rvWord').textContent = slot.word;
  $('rvGloss').textContent = [slot.occ?.phonetic, slot.occ?.gloss].filter(Boolean).join('  ');
  $('rvMnemonic').textContent = slot.occ?.mnemonic || '（这个位置还没写联想）';
  $('rvReveal').hidden = false;
  $('btnReveal').hidden = true;
  $('rvGrades').hidden = false;
  $('rvFoot').textContent = '想得起来 → 顺畅；想起来了但很费劲 → 费劲；想不起来 → 会排到明天再考。';
}

function gradeCurrent(grade) {
  const slot = currentReviewSlot();
  if (!slot) return;
  const elapsed = Math.round(performance.now() - S.reviewStartedAt);
  S.gradeLog.push({ slotId: slot.id, grade, startedAt: new Date(Date.now() - elapsed).toISOString(), durationMs: elapsed });
  S.gradeIdx += 1;
  showReviewStep();
}

async function finishReview() {
  const items = S.gradeLog.slice();
  S.reviewOpen = false;
  $('reviewPanel').hidden = true;
  if (!items.length) { $('doneBox').hidden = false; $('doneTitle').textContent = '这一轮没记分'; $('doneSub').textContent = ''; return; }
  try {
    const data = await api('/api/palace/settle', { method: 'POST', body: JSON.stringify({ items, mode: 'review' }) });
    const again = items.filter(i => i.grade === 'again').length;
    const hard = items.filter(i => i.grade === 'hard').length;
    const good = items.filter(i => i.grade === 'good').length;
    $('doneBox').hidden = false;
    $('doneTitle').textContent = '这一轮复习完成';
    $('doneSub').textContent = `共 ${items.length} 个位置：顺畅 ${good} · 费劲 ${hard} · 想不起来 ${again}\n`
      + (again ? '想不起来的词明天会回到复习队列，错题本也会记一笔。' : '全部想起来了，明天按记忆节奏再见。');
    await loadState();
    buildMarkers();
    refreshMarkerLook();
  } catch (e) {
    $('doneBox').hidden = false;
    $('doneTitle').textContent = '成绩没记上';
    $('doneSub').textContent = e.message;
  }
}

function closeReview() {
  S.reviewOpen = false;
  $('reviewPanel').hidden = true;
}

/* ============================ 输入 ============================ */
function bindInput() {
  const el = renderer.domElement;

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      const map = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd' };
      S.keys.add(map[k] || k);
      S.walkTarget = null;
      e.preventDefault();
      return;
    }
    if (k === 'e') {
      const s = slotInSight();
      if (s) openSlot(s);
      else if (!S.reviewOpen) closeSlot();
      e.preventDefault();
    } else if (k === 'r') {
      if (!S.reviewOpen) startReview();
      e.preventDefault();
    } else if (k === 'escape') {
      closeSlot(); closeReview();
      $('helpBox').hidden = true;
      $('doneBox').hidden = true;
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    const map = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd' };
    const k = e.key.toLowerCase();
    S.keys.delete(map[k] || k);
  });

  // 鼠标：安全上下文下用 Pointer Lock；否则拖动转头
  el.addEventListener('click', async (ev) => {
    if (S.reviewOpen || !$('slotPanel').hidden) return;
    const s = slotInSight();
    if (s) { openSlot(s); return; }
    // 点地面 → 走过去
    const hit = pickGround(ev);
    if (hit) { S.walkTarget = hit; return; }
    if (S.canLock && !S.locked) requestLock();
  });

  document.addEventListener('pointerlockchange', () => {
    S.locked = document.pointerLockElement === el;
    $('cross').hidden = !S.locked;
    $('lockHint').hidden = S.locked || !S.canLock;
  });

  document.addEventListener('mousemove', (e) => {
    if (S.locked) {
      S.cam.yaw -= e.movementX * 0.0022;
      S.cam.pitch = Math.max(-1.2, Math.min(1.2, S.cam.pitch - e.movementY * 0.0022));
    } else if (S.dragging) {
      S.cam.yaw -= e.movementX * 0.0032;
      S.cam.pitch = Math.max(-1.2, Math.min(1.2, S.cam.pitch - e.movementY * 0.0032));
    }
  });

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && !S.locked) S.dragging = true;
  });
  window.addEventListener('pointerup', () => { S.dragging = false; });

  // 触摸拖动转头
  let touchX = 0, touchY = 0, touchMoved = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; touchMoved = false;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - touchX, dy = t.clientY - touchY;
    if (Math.abs(dx) + Math.abs(dy) > 8) touchMoved = true;
    S.cam.yaw -= dx * 0.004;
    S.cam.pitch = Math.max(-1.2, Math.min(1.2, S.cam.pitch - dy * 0.004));
    touchX = t.clientX; touchY = t.clientY;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (touchMoved) return;
    const s = slotInSight();
    if (s) { openSlot(s); return; }
  }, { passive: true });
}

function pickGround(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pt = new THREE.Vector3();
  if (!ray.ray.intersectPlane(plane, pt)) return null;
  // 只允许走到地面范围内
  const first = S.rooms[0], last = S.rooms[S.rooms.length - 1];
  if (pt.x < first.x0 || pt.x > last.x1) return null;
  if (Math.abs(pt.z) > ROOM_D / 2) return null;
  return { x: pt.x, z: pt.z };
}

async function requestLock() {
  try {
    const p = renderer.domElement.requestPointerLock();
    if (p && typeof p.then === 'function') await p;
  } catch {
    S.canLock = false;
    $('lockHint').hidden = true;
  }
}

/* ============================ 主循环 ============================ */
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  stepMove(dt);
  clampToWorld();
  applyCamera();
  refreshMarkerLook();

  // 靠近提示
  const near = slotInSight();
  if (near && !S.reviewOpen && $('slotPanel').hidden) {
    $('proximity').hidden = false;
    $('proxNum').textContent = String(near.num);
    $('proxLabel').textContent = near.word ? `${near.room} · ${near.label}` : `${near.room} · ${near.label}（空位）`;
  } else {
    $('proximity').hidden = true;
  }

  // HUD 房间名
  const room = nearestRoomName();
  if (room && $('hudRoom').textContent !== room) $('hudRoom').textContent = room;

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

/* ============================ 启动 ============================ */
async function boot() {
  try {
    initThree();
    await loadState();
    buildWorld();
    buildMarkers();
    refreshMarkerLook();

    // 初始站在第一个房间门口，朝向 +z（房间内部）
    const first = S.rooms[0];
    S.cam.x = (first.x0 + first.x1) / 2;
    S.cam.z = first.z1 - 1.2;
    S.cam.yaw = 0;            // 面向 -z
    S.cam.pitch = 0;
    applyCamera();

    S.canLock = hasSecureContext();
    $('boot').hidden = true;
    $('hud').hidden = false;
    $('lockHint').hidden = S.canLock;   // 不支持的设备不用显示这条
    if (!S.canLock) {
      $('lockHintText').textContent = '当前是 HTTP 访问：拖动画面转头，点地面走过去。';
      $('btnLock').hidden = true;
      $('lockHint').hidden = false;
    } else {
      $('lockHintText').textContent = '点一下画面进入第一人称';
      $('btnLock').hidden = false;
    }

    // 没有词的时候先提示怎么开始
    if (!S.stats || !S.stats.occupied) {
      $('helpBox').hidden = false;
    }

    requestAnimationFrame(() => { clock.start(); tick(); });

    // 通知父页面（主站）：宫殿已就绪
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'palace:ready', stats: S.stats }, location.origin);
      }
    } catch { /* 忽略 */ }
  } catch (e) {
    $('bootMsg').textContent = e.message === 'UNAUTHORIZED'
      ? '登录已过期，请回到主站重新登录后再打开宫殿。'
      : ('打开失败：' + e.message);
  }
}

/* ============================ 界面事件绑定 ============================ */
function bindUI() {
  $('slotClose').addEventListener('click', closeSlot);
  $('btnSaveMnemonic').addEventListener('click', saveMnemonic);
  $('btnGenCand').addEventListener('click', generateCandidates);
  $('btnClearSlot').addEventListener('click', clearSlot);
  $('btnSwap').addEventListener('click', swapWord);
  $('swapInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) swapWord(); });
  $('mnemonicInput').addEventListener('input', () => {
    $('mnemonicCount').textContent = `${$('mnemonicInput').value.length} / 300`;
  });

  $('btnReview').addEventListener('click', () => { if (!S.reviewOpen) startReview(); });
  $('btnReveal').addEventListener('click', revealAnswer);
  $('rvQuit').addEventListener('click', () => { closeReview(); });
  document.querySelectorAll('#rvGrades .grade').forEach((b) => {
    b.addEventListener('click', () => gradeCurrent(b.dataset.grade));
  });

  $('btnHelp').addEventListener('click', () => { $('helpBox').hidden = false; });
  $('btnHelpClose').addEventListener('click', () => { $('helpBox').hidden = true; });
  $('btnDoneBack').addEventListener('click', () => { $('doneBox').hidden = true; });
  $('btnLock').addEventListener('click', requestLock);

  // 空格：复习时揭晓
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && S.reviewOpen && !S.revealed) {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      revealAnswer();
      e.preventDefault();
    }
  });

  // 主站发来的指令（例如「带我复习」）
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin) return;
    const d = ev.data || {};
    if (d.type === 'palace:command' && d.command === 'review') startReview();
  });
}

bindUI();
boot();
