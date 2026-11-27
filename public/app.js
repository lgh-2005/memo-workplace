/* 英语学习工作台 - 前端逻辑 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  filter: 'today',
  words: [],
  activeWord: null,
  chatHistory: [],      // [{role, content, word}]
  chatSessionId: null,  // v1.2.0：当前聊天会话 id（持久化用）
  sessionWords: new Set(),
  sessionErrorWords: new Set(),
  sessionStartedAt: new Date().toISOString(),
  llmPresets: {},
  providers: [],        // AI 服务商档案列表
  activeProvId: '',     // 默认服务商 id
  diyPrompts: {},       // v2.1.0：自定义提示词注册表（含索引/历史）
};

/* ---------------- 基础请求 ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  // v2.8.0：登录失效（401）→ 弹出登录遮罩（登录接口本身的 401 除外）
  if (res.status === 401 && !/^\/api\/auth\//.test(path)) {
    showLoginOverlay();
  }
  if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`);
  return json;
}

/* ================= v2.8.0：报错日志自动采集 ================= */

let _errReportQueue = [];
let _errReportTimer = null;
/** 前端错误上报到服务端报错日志（去抖动批量提交，失败静默） */
function reportError(payload) {
  try {
    _errReportQueue.push({
      source: payload.source || 'frontend',
      level: payload.level || 'error',
      message: String(payload.message || '').slice(0, 2000),
      stack: String(payload.stack || '').slice(0, 4000),
      url: payload.url || location.pathname,
      method: payload.method || '',
      status: payload.status || null,
    });
    if (_errReportQueue.length > 50) _errReportQueue = _errReportQueue.slice(-50);
    if (_errReportTimer) return;
    _errReportTimer = setTimeout(() => {
      _errReportTimer = null;
      const batch = _errReportQueue.slice();
      _errReportQueue = [];
      for (const item of batch) {
        try { fetch('/api/error/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) }); } catch { /* 静默 */ }
      }
    }, 800);
  } catch { /* 静默 */ }
}

window.addEventListener('error', (e) => {
  // 资源加载失败（图片等）不记为报错
  if (e.target && e.target !== window && e.target.tagName) return;
  reportError({ source: 'frontend', level: 'error', message: e.message, stack: e.error && e.error.stack, url: e.filename || location.pathname });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  reportError({ source: 'frontend', level: 'error', message: (r && (r.message || r)) || 'Unhandled promise rejection', stack: r && r.stack });
});

/* ================= v2.8.0：登录 / v3.1.0：多用户登录与注册 ================= */

/** 全局认证状态（v3.1.0）：多用户总开关 + 当前用户信息 */
const authState = {
  enabled: false,
  multiUser: false,
  authed: false,
  me: null,       // { id, username, role, createdAt, quotas }
  loaded: false,
};
function isAdminUser() { return !authState.multiUser || (authState.me && authState.me.role === 'admin'); }

function showLoginOverlay() {
  const ov = $('#loginOverlay');
  if (!ov) return;
  ov.style.display = 'flex';
  setTimeout(() => {
    const focus = authState.multiUser ? (loginTab === 'register' ? '#regUsername' : '#loginUsername') : '#loginToken';
    const t = $(focus);
    if (t) t.focus();
  }, 60);
}

function hideLoginOverlay() {
  const ov = $('#loginOverlay');
  if (ov) ov.style.display = 'none';
}

/** 切换登录遮罩标签：login（用户名+密码）/ register（注册）；单用户模式恒为 Token */
let loginTab = 'login';
function setLoginTab(tab) {
  loginTab = tab === 'register' ? 'register' : 'login';
  const tabs = $('#loginTabs');
  if (tabs) {
    $$('.login-tab').forEach(b => b.classList.toggle('active', b.dataset.loginTab === loginTab));
  }
  $('#loginPaneUser').style.display = loginTab === 'login' ? 'block' : 'none';
  $('#loginPaneRegister').style.display = loginTab === 'register' ? 'block' : 'none';
  const btn = $('#loginBtn');
  if (btn) btn.textContent = loginTab === 'register' ? '注册并进入' : '进入工作台';
  const out = $('#loginResult');
  if (out) out.textContent = '';
}

/** 依据服务端 auth/status 应用登录遮罩形态（多用户双标签 vs 单用户 Token） */
function applyAuthMode(s) {
  authState.enabled = !!s.enabled;
  authState.multiUser = !!s.multiUser;
  const tabs = $('#loginTabs');
  const paneToken = $('#loginPaneToken');
  const paneUser = $('#loginPaneUser');
  const paneReg = $('#loginPaneRegister');
  if (authState.multiUser) {
    if (tabs) tabs.style.display = 'flex';
    if (paneToken) paneToken.style.display = 'none';
    if (paneReg) paneReg.style.display = 'none';
    paneUser.style.display = 'block';
    setLoginTab('login');
  } else {
    if (tabs) tabs.style.display = 'none';
    if (paneToken) paneToken.style.display = 'block';
    if (paneUser) paneUser.style.display = 'none';
    if (paneReg) paneReg.style.display = 'none';
  }
  applyRoleVisibility();
}

/** v3.1.0：按角色显隐管理员专属设置区（普通用户隐藏） */
function applyRoleVisibility() {
  const admin = isAdminUser();
  $$('[data-admin-only]').forEach(el => { el.style.display = admin ? '' : 'none'; });
  const accSec = $('#accountSection');
  if (accSec) accSec.style.display = authState.multiUser ? '' : 'none';
  const usageSec = $('#usageSection');
  if (usageSec) usageSec.style.display = authState.multiUser ? '' : 'none';
  if (authState.multiUser && authState.me) {
    const nm = $('#accountName');
    if (nm) nm.textContent = authState.me.username || '—';
    const rl = $('#accountRole');
    if (rl) rl.textContent = authState.me.role === 'admin' ? '管理员（可配置全局服务）' : '普通用户';
    loadUsageDashboard();
  }
}

async function doLogin() {
  const out = $('#loginResult');
  if (authState.multiUser) {
    if (loginTab === 'register') return doRegister();
    const username = ($('#loginUsername') || {}).value || '';
    const password = ($('#loginPassword') || {}).value || '';
    if (!username.trim() || !password) { if (out) out.textContent = '请输入用户名与密码'; return; }
    if (out) out.textContent = '登录中…';
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { username: username.trim(), password } });
      authState.me = r.user || null;
      if (out) out.textContent = '';
      if ($('#loginPassword')) $('#loginPassword').value = '';
      hideLoginOverlay();
      initApp();
    } catch (e) {
      if (out) out.textContent = '❌ ' + e.message;
    }
    return;
  }
  // 单用户模式：Token 凭证
  const input = $('#loginToken');
  const token = input ? input.value : '';
  if (!token) { if (out) out.textContent = '请输入 Token 凭证'; return; }
  if (out) out.textContent = '登录中…';
  try {
    await api('/api/auth/login', { method: 'POST', body: { token } });
    if (out) out.textContent = '';
    if (input) input.value = '';
    hideLoginOverlay();
    initApp();
  } catch (e) {
    if (out) out.textContent = '❌ ' + e.message;
  }
}

/** v3.1.0：注册（用户名 + 密码 + 一次性邀请码），成功即登录 */
async function doRegister() {
  const out = $('#loginResult');
  const username = ($('#regUsername') || {}).value || '';
  const password = ($('#regPassword') || {}).value || '';
  const inviteCode = ($('#regInvite') || {}).value || '';
  if (!username.trim() || !password || !inviteCode.trim()) {
    if (out) out.textContent = '请填写用户名、密码与邀请码';
    return;
  }
  if (out) out.textContent = '注册中…';
  try {
    const r = await api('/api/auth/register', { method: 'POST', body: { username: username.trim(), password, inviteCode: inviteCode.trim() } });
    authState.me = r.user || null;
    if (out) out.textContent = '';
    if ($('#regPassword')) $('#regPassword').value = '';
    if ($('#regInvite')) $('#regInvite').value = '';
    hideLoginOverlay();
    initApp();
  } catch (e) {
    if (out) out.textContent = '❌ ' + e.message;
  }
}

/** v3.1.0：登出——清会话 + 用户数据（保留主题/风格等设备偏好） */
async function doLogout() {
  const out = $('#accountResult');
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch { /* 即便失败也清理本地并回登录页 */ }
  logoutCleanup();
  authState.me = null;
  authState.authed = false;
  try { await loadAuthStatus(); } catch { /* ignore */ }
  toast('已退出登录');
  showLoginOverlay();
}

/** 清理用户数据（保留设备偏好）：内存 state + 作文草稿 + 番茄钟进度；不删主题/风格/白噪音/禅模式 */
function logoutCleanup() {
  try {
    state.chatHistory = [];
    state.chatSessionId = null;
    state.sessionWords = new Set();
    state.sessionErrorWords = new Set();
    state.activeWord = null;
    state.words = [];
    resetCoachMap();
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('wrtDraft_')) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
    }
    try { localStorage.removeItem(POMO_KEY); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

/** 启动时校验登录状态：未启用或已登录 → 正常进入；否则显示登录遮罩 */
async function checkAuth() {
  try {
    const s = await api('/api/auth/status');
    applyAuthMode(s);
    authState.authed = !!s.authed;
    authState.me = s.me || null;
    authState.loaded = true;
    if (s.enabled && !s.authed) { showLoginOverlay(); return false; }
    return true;
  } catch { return true; }
}

/** v3.1.0：重新拉取认证状态（登录/注册/登出后调用），并刷新角色显隐 */
async function loadAuthStatus() {
  const s = await api('/api/auth/status');
  applyAuthMode(s);
  authState.authed = !!s.authed;
  authState.me = s.me || null;
  authState.loaded = true;
  return s;
}

function bindLoginUI() {
  const btn = $('#loginBtn');
  if (btn) btn.addEventListener('click', doLogin);
  const input = $('#loginToken');
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } });
  const up = $('#loginUsername');
  const pp = $('#loginPassword');
  [up, pp].forEach(el => { if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } }); });
  const rp = $('#regPassword');
  const ri = $('#regInvite');
  [rp, ri].forEach(el => { if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } }); });
  $$('.login-tab').forEach(b => b.addEventListener('click', () => setLoginTab(b.dataset.loginTab)));
  const lo = $('#logoutBtn');
  if (lo) lo.addEventListener('click', doLogout);
  const ur = $('#usageRefresh');
  if (ur) ur.addEventListener('click', loadUsageDashboard);
  const ug = $('#usageRange');
  if (ug) ug.addEventListener('change', loadUsageDashboard);
}

/* ================= v3.2.0：AI 用量看板（共享 LLM Key） ================= */

function fmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

async function loadUsageDashboard() {
  if (!authState.multiUser) return;
  const totalEl = $('#usageTotal');
  const seriesEl = $('#usageSeries');
  const allWrap = $('#usageAllWrap');
  const allEl = $('#usageAll');
  const out = $('#usageResult');
  const days = Number(($('#usageRange') || {}).value) || 14;
  if (out) out.textContent = '';
  try {
    const r = await api('/api/llm/usage?days=' + days);
    if (totalEl) {
      totalEl.innerHTML =
        `<span class="usage-kpi"><b>${fmtTok(r.total.totalTokens)}</b><i>总 Tokens</i></span>` +
        `<span class="usage-kpi"><b>${r.total.calls}</b><i>调用次数</i></span>` +
        `<span class="usage-kpi"><b>${fmtTok(r.total.promptTokens)}</b><i>输入</i></span>` +
        `<span class="usage-kpi"><b>${fmtTok(r.total.completionTokens)}</b><i>输出</i></span>`;
    }
    const max = Math.max(1, ...(r.series || []).map(s => s.totalTokens));
    if (seriesEl) {
      seriesEl.innerHTML = (r.series || []).map(s => {
        const h = Math.round((s.totalTokens / max) * 100);
        return `<div class="usage-bar" title="${s.date}：${s.totalTokens} tokens / ${s.calls} 次">
          <div class="usage-bar-fill" style="height:${h}%"></div>
          <div class="usage-bar-label">${esc(s.date.slice(5))}</div>
        </div>`;
      }).join('');
    }
    if (authState.me && authState.me.role === 'admin') {
      const a = await api('/api/llm/usage?days=' + days + '&scope=all');
      if (allWrap) allWrap.style.display = '';
      if (allEl) {
        allEl.innerHTML = `<table class="usage-table"><thead><tr><th>用户</th><th>角色</th><th>调用</th><th>Tokens</th></tr></thead><tbody>` +
          (a.users || []).map(u =>
            `<tr><td>${esc(u.username)}</td><td>${u.role === 'admin' ? '管理员' : '普通'}</td><td>${u.total.calls}</td><td>${fmtTok(u.total.totalTokens)}</td></tr>`
          ).join('') + `</tbody></table>`;
      }
    } else if (allWrap) {
      allWrap.style.display = 'none';
    }
  } catch (e) {
    if (out) out.textContent = '❌ ' + e.message;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/** v2.2.8：学习流水 kind 的展示标签，与服务端 VALID_ATTEMPT_KINDS 对齐 */
const ATTEMPT_KIND_LABELS = {
  word_quiz: '单词测验',
  unit_objective: '客观真题',
  translation: '真题翻译',
  writing: '真题写作',
  vocab_context: '语境选义',
  vocab_cloze: '搭配补全',
  sentence_analysis: '长难句三遍训练',
};

/** 语料中仅放行 <u>…</u>（阅读划线句忠实还原）；必须先 esc 再调用 */
function allowU(s) {
  return String(s ?? '').replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>');
}

/** 任何时间戳 → 北京时间 MM-DD HH:mm（服务器在哪个时区都不影响显示） */
function fmtBJ(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** 北京时间的 YYYY-MM-DD（前端本地统计用，如番茄钟按天归零） */
function bjDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}

/** 任意 ISO 时间 → 北京时间的 YYYY-MM-DD（用于「今天是否已同步」判断） */
function bjDateOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

/** v2.1.0a 补齐：右下角轻提示（此前 toast 未定义，禅模式/白噪音调用会抛错） */
function toast(msg) {
  try {
    const old = document.querySelector('.wb-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'wb-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { try { el.remove(); } catch { /* 静默 */ } }, 320);
    }, 2200);
  } catch { /* 静默 */ }
}

/**
 * v3.8.2：统一复制入口（先 Clipboard API，失败退 execCommand）。
 *
 * 为什么需要：线上以 `http://IP` 访问时页面不是「安全上下文」，浏览器根本不提供
 * `navigator.clipboard`（实测 window.isSecureContext=false、navigator.clipboard===undefined）。
 * 因此凡是直接写 `navigator.clipboard.writeText(...)` 的地方，在 HTTP 下要么抛 TypeError、
 * 要么落进空 catch 变成「点了没反应」——词文成章复制、划词精读卡复制、写作批改复制、
 * 范文复制四处都中招。
 *
 * 本函数先试异步 Clipboard API（HTTPS/localhost 下最快），失败再退到 `document.execCommand('copy')`
 * ——后者在 HTTP 下依然可用，是这条唯一可行的降级路径。替换选区前会保存用户原有 Range 并在
 * 结束后恢复，避免划词气泡复制把正在划的选区吞掉。
 *
 * @param {string} text 要复制的文本
 * @returns {Promise<boolean>} 是否复制成功（调用方据此给不同的提示语）
 */
async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch { /* 权限被拒或非安全上下文：落到下面的兜底 */ }
  }

  try {
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    const savedRanges = [];
    if (sel) {
      for (let i = 0; i < sel.rangeCount; i++) {
        try { savedRanges.push(sel.getRangeAt(i).cloneRange()); } catch { /* 静默 */ }
      }
    }
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try { ta.setSelectionRange(0, value.length); } catch { /* 部分浏览器不支持 */ }
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    try { document.body.removeChild(ta); } catch { /* 静默 */ }
    if (sel && savedRanges.length) {
      try {
        sel.removeAllRanges();
        savedRanges.forEach(r => sel.addRange(r));
      } catch { /* 静默 */ }
    }
    return ok;
  } catch {
    return false;
  }
}

/* ================= v2.4.2：通用可折叠卡片（所有占版大的板块均可折叠） ================= */

/** 按 CSS 选择器折叠/展开卡片内容体；state=true 折叠，false 展开 */
function collapseCard(targetSel, state) {
  const body = $(targetSel);
  if (!body) return;
  body.classList.toggle('collapsed', !!state);
  const card = body.closest('.card-collapsible');
  const toggle = card && card.querySelector('.card-collapse-toggle');
  if (toggle) setCollapseToggleLabel(toggle, !!state);
}

function expandCard(targetSel) {
  collapseCard(targetSel, false);
}

function setCollapseToggleLabel(btn, collapsed) {
  btn.textContent = collapsed ? '展开 ▾' : '收起 ▴';
}

/* 全站折叠按钮事件委托：点按切换 data-collapse-target 指向的内容体 */
document.addEventListener('click', e => {
  const btn = e.target.closest('.card-collapse-toggle');
  if (!btn) return;
  const targetSel = btn.dataset.collapseTarget;
  if (!targetSel) return;
  const body = $(targetSel);
  if (!body) return;
  const nowCollapsed = !body.classList.contains('collapsed');
  collapseCard(targetSel, nowCollapsed);
});

/* ---------------- 发音（v3.5.0：服务端神经语音 + 真实音源，浏览器 TTS 兜底） ---------------- */

let ttsAudio = null;
let ttsUnlocked = false;
let ttsServerAccent = 'en_US';
// 极短静音 wav，用于首次手势解锁音频元素（iOS/Safari 限制）
const TTS_SILENT_DATAURI = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

function ttsAudioEl() { if (!ttsAudio) ttsAudio = new Audio(); return ttsAudio; }

/* 首次用户手势时解锁音频：否则 await 网络请求后 play() 会被移动端拒绝 */
function unlockTtsAudio() {
  if (ttsUnlocked) return;
  ttsUnlocked = true;
  try {
    const a = ttsAudioEl();
    a.muted = true;
    a.src = TTS_SILENT_DATAURI;
    const p = a.play();
    if (p && typeof p.then === 'function') {
      p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    } else { a.pause(); a.muted = false; }
  } catch { /* 忽略 */ }
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', unlockTtsAudio, { once: true, passive: true });
  document.addEventListener('touchstart', unlockTtsAudio, { once: true, passive: true });
}

/** 当前口音偏好：设备本地设置优先，其次服务端默认 */
function ttsAccentPref() {
  try { const v = localStorage.getItem('wb-tts-accent'); if (v === 'en_US' || v === 'en_GB') return v; } catch { /* 忽略 */ }
  return ttsServerAccent === 'en_GB' ? 'en_GB' : 'en_US';
}

/** 浏览器兜底：优先挑高质量英文声，其次按语言前缀匹配 */
function pickBrowserVoice(lang) {
  try {
    const voices = speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    const prefix = String(lang || 'en-US').toLowerCase().slice(0, 2);
    const prefer = /natural|neural|online|google|microsoft|aria|jenny|guy|samantha|zira|david|mark|libby|sonia/i;
    const cand = voices.filter(v => (v.lang || '').toLowerCase().replace('_', '-').startsWith(prefix));
    if (!cand.length) return null;
    return cand.find(v => prefer.test(v.name) && v.localService === false)
      || cand.find(v => prefer.test(v.name))
      || cand.find(v => v.localService === false)
      || cand[0];
  } catch { return null; }
}

function browserSpeak(text, lang) {
  try {
    const u = new SpeechSynthesisUtterance(String(text));
    const voice = pickBrowserVoice(lang);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    else u.lang = lang || 'en-US';
    u.rate = 0.92;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* 浏览器不支持时静默 */ }
}

/**
 * 朗读文本：服务端合成音频（单词走真人发音、句子走神经语音）优先，
 * 失败自动回退浏览器 speechSynthesis。调用方式保持同步。
 */
async function speak(text, lang = 'en-US') {
  const s = String(text || '').trim();
  if (!s) return;
  const accent = ttsAccentPref();
  try {
    const a = ttsAudioEl();
    try { a.pause(); } catch { /* 忽略 */ }
    a.muted = false;
    a.src = '/api/tts?text=' + encodeURIComponent(s) + '&accent=' + encodeURIComponent(accent);
    await a.play();
  } catch (err) {
    // 快速重播导致的中断（AbortError）不视为失败，避免双声叠加
    if (err && err.name === 'AbortError') return;
    browserSpeak(s, lang);
  }
}

/** 从 AI 回复里提取英文句子朗读（例句场景），没有英文就读原词 */
function speakEnglishFrom(text, fallbackWord) {
  const sentences = String(text)
    .split(/[\n。！？!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 3 && (s.match(/[A-Za-z]/g) || []).length / s.replace(/\s/g, '').length > 0.6);
  if (sentences.length) speak(sentences.slice(0, 3).join(' '));
  else if (fallbackWord) speak(fallbackWord);
}

/* ---------------- 页签 ---------------- */

$$('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

/* ---------------- v4.3.1：左侧边栏折叠 ---------------- */
/** 侧栏折叠状态存本设备（localStorage），刷新后保持；手机端侧栏本就隐藏，不参与 */
const SIDEBAR_COLLAPSE_KEY = 'wb-sidebar-collapsed';

function applySidebarCollapse(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const btn = $('#sidebarToggle');
  if (!btn) return;
  const label = collapsed ? '展开侧边栏' : '折叠侧边栏';
  const icon = btn.querySelector('.sidebar-toggle-icon');
  const text = btn.querySelector('.sidebar-toggle-text');
  if (icon) icon.textContent = collapsed ? '»' : '«';
  if (text) text.textContent = collapsed ? '展开' : '收起';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!collapsed));
}

function initSidebarCollapse() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1'; } catch { /* 隐私模式：不记忆 */ }
  applySidebarCollapse(collapsed);
  const btn = $('#sidebarToggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = !document.body.classList.contains('sidebar-collapsed');
    applySidebarCollapse(next);
    try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, next ? '1' : '0'); } catch { /* 静默 */ }
  });
}

initSidebarCollapse();

// Query-param deep links are shared with the PWA shortcuts. Internal moves add history, not reloads.
function tabFromURL() {
  const name = new URLSearchParams(location.search).get('tab');
  return name && document.getElementById(`tab-${name}`)?.classList.contains('tab-page') ? name : 'dashboard';
}
window.addEventListener('popstate', () => switchTab(tabFromURL(), { history: false }));

function switchTab(name, { history: trackHistory = true } = {}) {
  const destination = document.getElementById('tab-' + name);
  if (!destination?.classList.contains('tab-page')) return;
  const changed = !destination.classList.contains('active');
  if (trackHistory && name !== tabFromURL()) {
    const url = new URL(location.href);
    if (name === 'dashboard') url.searchParams.delete('tab');
    else url.searchParams.set('tab', name);
    window.history.pushState(null, '', url);
  }
  if (name !== 'logs') state._prevTab = name;   // v2.8.0：记录日志版块前的页签，便于返回
  const navName = name;
  const moreTabs = ['reports', 'kb', 'notes', 'settings'];
  $$('.tab, .bottom-tab-item[data-tab], .more-sheet-item[data-tab]').forEach(button => {
    const current = button.dataset.tab === navName;
    button.classList.toggle('active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $$('.bottom-tab-item').forEach(b => b.classList.toggle('active', b.dataset.tab === navName || (b.id === 'bottomMoreBtn' && moreTabs.includes(name))));
  $$('.more-sheet-item[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));

  $$('.tab-page').forEach(p => p.classList.toggle('active', p === destination));
  if (changed) window.scrollTo(0, 0);
  if (name !== 'study' && typeof wordPanelOpen === 'function') wordPanelOpen(false);   // v4.2.0：离开学习页收起词表浮层
  if (name === 'dashboard') loadDashboard();
  if (name === 'reports') { loadDashboard(); loadLearningReport(state.reportDays || 7); loadQuizStats(); }
  if (name === 'study') loadWords();
  if (name === 'notes') loadNotes();
  if (name === 'kb') loadKb();

  if (name === 'settings') {
    loadConfig(); loadBackupList();
    refreshMistSettingsNav();
    setTimeout(refreshMistSettingsNav, 120);
    setTimeout(refreshMistSettingsNav, 900);   // 管理员分区由 loadConfig 异步点亮，再补一次
  }
  if (name === 'logs') loadLogs();
  if (name === 'quiz') { try { checkQuizResume(); } catch {}; try { loadQuizSourceCounts(); } catch {} }   // v2.11.0 续做检查 / v3.2.1 词源计数
  // quiz 页保持进行中的状态，不重置
}

$$('[data-report-view]').forEach(btn => btn.addEventListener('click', () => {
  const view = btn.dataset.reportView;
  $$('.report-source-panel').forEach(panel => { panel.hidden = panel.id !== `report-${view}`; });
  $$('[data-report-view]').forEach(item => {
    item.classList.toggle('primary', item === btn);
    item.setAttribute('aria-pressed', String(item === btn));
  });
}));


/* ================= v2.8.0：日志版块（开发日志 / 使用日志 / 报错日志） ================= */

let _logsLoaded = false;

function openLogs() { switchTab('logs'); }

function bindVersionClick() {
  for (const id of ['openLogsSidebar', 'openLogsMobile']) {
    const el = document.getElementById(id);
    if (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', openLogs);
    }
  }
}

function switchLogsPane(kind) {
  $$('#logsTabs .logs-tab').forEach(b => b.classList.toggle('active', b.dataset.logs === kind));
  $$('.logs-pane').forEach(p => p.classList.toggle('active', p.id === 'logsPane-' + kind));
  if (kind === 'error') loadErrorLogs();
}

async function loadLogs() {
  _logsLoaded = true;
  const back = $('#logsBackBtn');
  if (back && !back._bound) {
    back._bound = true;
    back.addEventListener('click', () => switchTab(state._prevTab && state._prevTab !== 'logs' ? state._prevTab : 'dashboard'));
  }
  $$('#logsTabs .logs-tab').forEach(b => {
    if (b._bound) return;
    b._bound = true;
    b.addEventListener('click', () => switchLogsPane(b.dataset.logs));
  });
  await Promise.all([loadDevLogs(), loadUsageLogs()]);
}

async function loadDevLogs() {
  const box = $('#devLogList');
  if (!box) return;
  try {
    const r = await api('/api/logs/dev');
    const badge = $('#logsVersionBadge');
    if (badge && r.version) badge.textContent = 'v' + r.version;
    const list = r.dev || [];
    if (!list.length) { box.innerHTML = '<div class="hint">暂无开发日志</div>'; return; }
    box.innerHTML = list.map(v => `
      <div class="log-entry">
        <div class="log-entry-head">
          <span class="log-ver">v${esc(v.version)}</span>
          <span class="log-title">${esc(v.title || '')}</span>
          <span class="log-date">${esc(v.date || '')}</span>
        </div>
        <ul class="log-items">${(v.items || []).map(it => `<li>${esc(it)}</li>`).join('')}</ul>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="hint">加载失败：${esc(e.message)}</div>`;
  }
}

const USAGE_KIND_META = { plan: { label: '🧭 更新方向', cls: 'plan' }, issue: { label: '🐞 已知小毛病', cls: 'issue' }, note: { label: '📝 备注', cls: 'note' } };

async function loadUsageLogs() {
  const box = $('#usageLogList');
  if (!box) return;
  try {
    const r = await api('/api/logs/usage');
    const list = r.usage || [];
    if (!list.length) { box.innerHTML = '<div class="hint">暂无使用日志，可在上方添加。</div>'; return; }
    box.innerHTML = list.map(u => {
      const meta = USAGE_KIND_META[u.kind] || USAGE_KIND_META.note;
      return `<div class="log-entry usage-${meta.cls}">
        <div class="log-entry-head">
          <span class="log-kind">${meta.label}</span>
          <span class="log-title">${esc(u.title || '')}</span>
          <span class="log-date">${fmtBJ(u.ts)}</span>
          <button class="btn ghost log-del" data-usage-del="${esc(u.id)}" title="删除">🗑</button>
        </div>
        ${u.content ? `<div class="log-content">${esc(u.content)}</div>` : ''}
      </div>`;
    }).join('');
    box.querySelectorAll('[data-usage-del]').forEach(btn => btn.addEventListener('click', async () => {
      try { await api('/api/logs/usage', { method: 'POST', body: { remove: btn.dataset.usageDel } }); loadUsageLogs(); toast('已删除'); }
      catch (e) { toast('删除失败：' + e.message); }
    }));
  } catch (e) {
    box.innerHTML = `<div class="hint">加载失败：${esc(e.message)}</div>`;
  }
}

async function loadErrorLogs() {
  const box = $('#errorLogList');
  if (!box) return;
  try {
    const r = await api('/api/logs/errors');
    const list = r.errors || [];
    if (!list.length) { box.innerHTML = '<div class="hint">✓ 暂无报错记录。</div>'; return; }
    box.innerHTML = list.map(e => `
      <div class="log-entry err-${esc(e.level || 'error')}">
        <div class="log-entry-head">
          <span class="log-kind">${esc(e.source)}</span>
          <span class="log-title">${esc(e.message || '(无消息)')}</span>
          <span class="log-date">${fmtBJ(e.ts)}</span>
        </div>
        <div class="log-meta">${esc(e.method || '')} ${esc(e.url || '')} ${e.status ? '· HTTP ' + esc(String(e.status)) : ''}</div>
        ${e.stack ? `<pre class="log-stack">${esc(e.stack)}</pre>` : ''}
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="hint">加载失败：${esc(e.message)}</div>`;
  }
}

// 快捷入口 / 链接跳转
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-jump]');
  if (!el) return;
  e.preventDefault();
  const { jump, filter } = el.dataset;
  if (jump === 'study' && filter) openStudyWords(filter);
  else {
    switchTab(jump);
    if (jump === 'quiz' && filter) {
      $('[data-submode="basic"]')?.click();
      $$('#quizSources .chip').find(chip => chip.dataset.src === filter)?.click();
    }
  }
});

/* ---------------- 仪表盘 ---------------- */

/* ---------------- 晨雾首页：复用真实词表、任务和样课 ---------------- */
let mistTasks = [];
let mistCards = [];
let mistWordIndex = 0;
let mistWordDate = '';
let mistWordAnimation;
let dashboardRequest = 0;
let studyTaskRevision = 0;
let savingStudyTask = false;

function openStudyWords(filter = 'today', search = '') {
  state.filter = filter;
  $('#wordSearch').value = search;
  $$('#wordFilters .chip').forEach(chip => chip.classList.toggle('active', chip.dataset.filter === filter));
  // switchTab is responsible for loading the list; don't request it again when selecting the subview.
  switchStudySub('vocab', { load: false });
  switchTab('study');
  wordPanelOpen(true, { load: false });
}

function openStudyTask(task) {
  if (task.id === 'vocab_today') { openStudyWords(); return; }
  if (task.id === 'exam_practice') {
    // Select the exam filter before the tab loads, even after the user last read an external article.
    kbState.filter = '真题';
    $$('#kbFilters .chip').forEach(chip => chip.classList.toggle('active', chip.dataset.kcat === '真题'));
  }
  switchTab(task.tab);
  if (task.id === 'review_due') $('[data-submode="srs"]')?.click();
}

function renderMistTasks(tasks) {
  mistTasks = tasks;
  const done = tasks.filter(task => task.done).length;
  const ratio = tasks.length ? Math.round(done * 100 / tasks.length) : 0;
  $('#mistTaskRing').setAttribute('stroke-dasharray', `${ratio} 100`);
  $('#mistTicketSummary').textContent = tasks.length ? `${done} / ${tasks.length} 项已完成` : '暂无任务';
  const title = { vocab_today: '今日词汇', review_due: '到期与错题', exam_practice: '真题训练' };
  // v4.4.1：票据格改成按钮——点一格直接进入对应任务（与下方「今日任务」共用同一份数据）
  $('#mistTaskCells').innerHTML = tasks.map(task => {
    const count = Number(task.count) || 0, target = Number(task.target) || 0;
    const progress = task.done ? 100 : target ? Math.min(100, Math.round(count * 100 / target)) : 0;
    const state = task.done ? '完成' : count ? '进行中' : '未开始';
    return `<button type="button" class="mist-ticket-cell${task.done ? ' done' : ''}" data-mist-task="${esc(task.id)}" aria-label="${esc(task.title)}：${esc(state)}">
      <span class="mist-cell-label">${esc(title[task.id] || task.title)}</span>
      <span class="mist-cell-count"><b>${count}</b><i>/ ${target}</i><small class="mist-cell-state">${state}</small></span>
      <span class="mist-cell-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}" aria-label="${esc(task.title)}进度"><i style="width:${progress}%"></i></span>
    </button>`;
  }).join('');
  if (!renderMistTasks.bound) {
    renderMistTasks.bound = true;
    $('#mistTaskCells').addEventListener('click', event => {
      const cell = event.target.closest('[data-mist-task]');
      if (cell) mistJumpTask(cell.dataset.mistTask);
    });
  }
  const next = tasks.find(task => !task.done);
  $('#mistNextTask').textContent = ({ vocab_today: '开始今日词汇', review_due: '继续词汇复习', exam_practice: '打开真题语料' })[next?.id] || '查看今日任务';
  $('#mistTodayLead').textContent = next ? `从「${next.title}」开始，接着完成今天的计划。`
    : tasks.length ? '今天的任务已完成。可以再练一节微课，或回看学习报告。' : '查看今日任务，再挑一组词练习。';
}

function mistJumpTask(id) {
  const task = mistTasks.find(item => item.id === id);
  if (task) openStudyTask(task);
}

/* v4.4.1：按时段给首页一句「时间感」——清晨 / 上午 / 正午 / 午后 / 黄昏 / 夜晚 / 深夜 */
const MIST_PHASES = [
  { until: 5, key: 'late-night', label: '深夜' },
  { until: 8, key: 'dawn', label: '清晨' },
  { until: 11, key: 'morning', label: '上午' },
  { until: 13, key: 'noon', label: '正午' },
  { until: 17, key: 'afternoon', label: '午后' },
  { until: 19, key: 'dusk', label: '黄昏' },
  { until: 22, key: 'evening', label: '夜晚' },
  { until: 24, key: 'night', label: '深夜' },
];
function mistPhase() {
  const hour = new Date(Date.now() + 8 * 3600000).getUTCHours();   // 北京时间口径，与墨墨统计一致
  return MIST_PHASES.find(item => hour < item.until) || MIST_PHASES[MIST_PHASES.length - 1];
}
function mistApplyPhase() {
  const hero = document.querySelector('.mist-hero');
  const label = $('#mistPhase');
  if (!hero || !label) return;
  const phase = mistPhase();
  hero.dataset.phase = phase.key;
  label.textContent = phase.label;
}

function renderMistWord() {
  const word = mistCards[mistWordIndex];
  $('#mistWordActions').hidden = !word;
  $('#mistWordNext').hidden = mistCards.length <= 1;
  $('#mistWordSource').textContent = word ? (word.source === 'today' ? '来自今日词表' : '来自顽固词') : '';
  $('#mistWordBody').innerHTML = word ? `<div class="mist-word" lang="en">${esc(word.spelling)}</div>
    <div class="mist-phonetic">${esc([word.phonetic, word.pos].filter(Boolean).join(' · '))}</div>
    <div class="mist-word-gloss md-body">${mdLite(word.gloss || '暂无本地释义。可在词表中进一步学习。')}</div>`
    : '<div class="mist-word-empty md-body">' + mdLite('同步墨墨后，这里会展示今日词或顽固词。也可以先试学一节词汇微课。') + '</div>';
  if (word) $('#mistWordSpeak').setAttribute('aria-label', `朗读 ${word.spelling}`);
}

function renderMistDashboard(data) {
  const date = data.todayStr || bjDate();
  mistApplyPhase();
  const time = $('#mistToday');
  time.dateTime = date;
  time.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' })
    .format(new Date(`${date}T00:00:00+08:00`));
  const exam = $('#mistExam');
  exam.hidden = !data.kaoyan;
  if (data.kaoyan) {
    const { daysLeft, custom, examType } = data.kaoyan;
    const label = ({ kaoyan1: '考研', cet6: '六级', custom: '考试' })[examType] || '考试';
    exam.textContent = daysLeft < 0 ? `${label}已结束` : daysLeft === 0 ? `${label}就在今天` : `距${label} ${daysLeft} 天${custom ? '' : '（估算）'}`;
  }
  const streak = $('#mistStreak');
  streak.hidden = !(data.streak > 0);
  streak.textContent = data.streak > 0 ? `连续学习 ${data.streak} 天` : '';
  const selected = mistWordDate === date ? mistCards[mistWordIndex]?.spelling : null;
  mistWordDate = date;
  mistCards = Array.isArray(data.wordCards) ? data.wordCards : [];
  mistWordIndex = Math.max(0, mistCards.findIndex(word => word.spelling === selected));
  renderMistWord();
}

$('#mistNextTask').addEventListener('click', () => {
  const next = mistTasks.find(task => !task.done);
  if (next) { openStudyTask(next); return; }
  $('#todayTasksCard').focus({ preventScroll: true });
  $('#todayTasksCard').scrollIntoView({ block: 'start' });
});
$('#mistOpenLesson').addEventListener('click', () => {
  switchStudySub('vocab', { load: false });
  switchTab('study');
});
$('#mistOpenSample').addEventListener('click', () => {
  switchStudySub('vocab', { load: false });
  switchTab('study');
  if (!coachBatch) beginCoachSample(); // 不覆盖已开始的真实学习。
});
$('#mistWordSpeak').addEventListener('click', () => speak(mistCards[mistWordIndex]?.spelling));
$('#mistWordNext').addEventListener('click', () => {
  if (mistCards.length <= 1) return;
  mistWordIndex = (mistWordIndex + 1) % mistCards.length;
  renderMistWord();
  mistWordAnimation?.cancel();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    mistWordAnimation = $('#mistWordBody').animate([{ opacity: .55, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
  }
});
$('#mistWordStudy').addEventListener('click', () => {
  const word = mistCards[mistWordIndex];
  if (word) openStudyWords(word.source, word.spelling);
});

/* ---------------- 今日任务中心 / 考试计划 ---------------- */
function renderStudyTasks(tasks) {
  const box = $('#todayTasksList');
  if (!box) return;
  const list = Array.isArray(tasks) ? tasks : [];
  renderMistTasks(list);
  const done = list.filter(x => x.done).length;
  const summary = $('#todayTasksSummary');
  if (summary) summary.textContent = `${done}/${list.length} 已完成`;
  box.innerHTML = list.map(t => `<div class="study-task ${t.done ? 'done' : ''}">
    <label class="study-task-check-wrap"><input class="study-task-check" type="checkbox" data-study-complete="${esc(t.id)}" aria-label="标记${esc(t.title)}完成" ${t.done ? 'checked' : ''} ${t.automatic ? 'disabled' : ''}></label>
    <span class="study-task-icon">${t.icon}</span><div class="study-task-main"><b>${esc(t.title)}</b><span>${esc(t.detail || '')}</span></div>
    <button class="btn mini ${t.done ? 'ghost' : 'primary'} study-task-btn" data-study-start="${esc(t.id)}" type="button">${t.done ? '查看' : '去练习'}</button>
  </div>`).join('');
  box.querySelectorAll('[data-study-complete]').forEach(input => input.addEventListener('change', async e => {
    e.preventDefault();
    e.stopPropagation();
    if (savingStudyTask) return;
    const id = input.dataset.studyComplete;
    const checked = input.checked;
    const returnFocus = document.activeElement === input;
    savingStudyTask = true;
    studyTaskRevision++;
    $$('#todayTasksList [data-study-complete]').forEach(toggle => { toggle.disabled = true; });
    let tasks = list;
    try {
      const r = await api('/api/study/tasks/complete', { method: 'POST', body: { taskId: id, completed: checked } });
      tasks = r.tasks;
    } catch (err) { toast('任务更新失败：' + err.message); }
    finally {
      savingStudyTask = false;
      studyTaskRevision++;
      renderStudyTasks(tasks);
      if (returnFocus && document.activeElement === document.body && $('#tab-dashboard').classList.contains('active')) {
        $$('#todayTasksList [data-study-complete]').find(toggle => toggle.dataset.studyComplete === id)?.focus({ preventScroll: true });
      }
    }
  }));
  box.querySelectorAll('[data-study-start]').forEach(btn => btn.addEventListener('click', () => {
    const task = list.find(x => x.id === btn.dataset.studyStart); if (!task) return;
    openStudyTask(task);
  }));
}
function renderStudyPlan(plan) {
  plan ||= {};
  const type = $('#studyPlanExamType'); if (type) type.value = plan.examType || 'kaoyan1';
  const date = $('#studyPlanExamDate'); if (date) date.value = plan.examDate || '';
  const words = $('#studyPlanWords'); if (words) words.value = plan.dailyWords || 30;
  const minutes = $('#studyPlanMinutes'); if (minutes) minutes.value = plan.dailyMinutes || 30;
  const summary = $('#studyPlanSummary');
  if (summary) {
    const exam = ({ kaoyan1: '考研英语一', cet6: '六级', custom: '自定义考试' })[plan.examType] || '考研英语一';
    summary.textContent = `${exam}${plan.examDate ? ` · ${plan.examDate}` : ''} · 每日 ${plan.dailyWords || 30} 词 / ${plan.dailyMinutes || 30} 分钟`;
  }
  renderStudyPlanCorpusTracks(plan);   // v3.6.0
}

/* v3.6.0：考试语料范围（外刊刊物轨）勾选器 */
let studyCorpusPubs = null;       // [{key,label,count}]
let studyCorpusAuto = null;       // 当前考试类型的自动轨集合
let studyCorpusOverride = null;   // null=自动；数组=手动指定
async function renderStudyPlanCorpusTracks(plan) {
  const box = $('#studyPlanCorpusTracks'); if (!box) return;
  studyCorpusOverride = Array.isArray(plan?.corpusTracks) ? plan.corpusTracks : null;
  try {
    if (!studyCorpusPubs) {
      const s = await api('/api/kb/status');
      studyCorpusPubs = (s.publications || []);
      studyCorpusAuto = s.corpusScope?.tracks || null;
    }
  } catch { /* 非阻断：拉不到刊物清单就不渲染 */ return; }
  const eff = new Set(studyCorpusOverride || studyCorpusAuto || []);
  const autoOn = !studyCorpusOverride;
  box.innerHTML = [
    `<label class="chip${autoOn ? ' active' : ''}"><input type="checkbox" id="studyCorpusAuto" ${autoOn ? 'checked' : ''}> 自动（按考试类型）</label>`,
    ...studyCorpusPubs.map(p => `<label class="chip${eff.has(p.key) ? ' active' : ''}"><input type="checkbox" class="study-corpus-track" data-track="${esc(p.key)}" ${eff.has(p.key) ? 'checked' : ''}> ${esc(p.label)} · ${p.count}</label>`),
  ].join('');
  box.querySelectorAll('input').forEach(inp => inp.addEventListener('change', onStudyCorpusChange));
}
function onStudyCorpusChange() {
  const auto = $('#studyCorpusAuto')?.checked;
  if (auto) { studyCorpusOverride = null; }
  else {
    const picked = [...$$('.study-corpus-track')].filter(x => x.checked).map(x => x.dataset.track);
    studyCorpusOverride = picked.length ? picked : null;   // 一个都不勾 = 回自动
    if (!picked.length) { const autoBox = $('#studyCorpusAuto'); if (autoBox) autoBox.checked = true; }
  }
  const box = $('#studyPlanCorpusTracks');
  if (box) box.querySelectorAll('.chip').forEach(c => { const i = c.querySelector('input'); if (i) c.classList.toggle('active', i.checked); });
}
async function saveStudyPlan() {
  const result = $('#studyPlanResult');
  try {
    const r = await api('/api/study/plan', { method: 'POST', body: {
      examType: $('#studyPlanExamType')?.value,
      examDate: $('#studyPlanExamDate')?.value || '',
      dailyWords: Number($('#studyPlanWords')?.value),
      dailyMinutes: Number($('#studyPlanMinutes')?.value),
      corpusTracks: studyCorpusOverride,   // v3.6.0：null=自动；数组=手动
    }});
    renderStudyPlan(r.plan); renderStudyTasks(r.tasks); loadDashboard();
    const planFold = $('#studyPlanCard'); if (planFold) planFold.open = false;
    if (result) { result.className = 'result ok'; result.textContent = '已保存'; }
  } catch (e) { if (result) { result.className = 'result err'; result.textContent = e.message; } }
}
if ($('#studyPlanSaveBtn')) $('#studyPlanSaveBtn').addEventListener('click', saveStudyPlan);

async function loadDashboard() {
  const request = ++dashboardRequest;
  const revision = studyTaskRevision;
  try {
    const d = await api('/api/dashboard');
    if (request !== dashboardRequest) return;
    if (!savingStudyTask && revision === studyTaskRevision) renderStudyTasks(d.studyTasks || []);
    renderMistDashboard(d);
    renderStudyPlan(d.studyPlan);
    // 同步引导条（v1.0.4）：从未同步 / 上次失败 / 今天没同步
    const banner = $('#syncBanner');
    const lastSyncDate = bjDateOf(d.lastSync);
    if (!d.lastSync) {
      $('#syncBannerText').textContent = '⚠️ 还没同步过数据——先同步一次，词表和进度才会出现';
      banner.style.display = 'flex';
    } else if (d.lastSyncOk === false) {
      $('#syncBannerText').textContent = `⚠️ 上次同步失败（${fmtBJ(d.lastSync)}），点击右侧重试`;
      banner.style.display = 'flex';
    } else if (lastSyncDate !== d.todayStr) {
      $('#syncBannerText').textContent = `⚠️ 今日数据未同步（上次同步 ${fmtBJ(d.lastSync)}），今日词表可能是空的`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
    // 统计卡
    if (d.progress) {
      $('#statProgress').textContent = `${d.progress.finished}/${d.progress.total}`;
      $('#statProgressSub').textContent = `还剩 ${Math.max(0, d.progress.total - d.progress.finished)} 个词`;
      const min = Math.round(d.progress.studyTimeMs / 60000);
      $('#statTime').textContent = min ? `${min} 分钟` : '—';
      $('#statTimeSub').textContent = min ? '继续保持 💪' : '今天还没开始学';
    } else {
      $('#statProgress').textContent = '—';
      $('#statProgressSub').textContent = '今天尚未同步';
      $('#statTime').textContent = '—';
      $('#statTimeSub').textContent = '';
    }
    $('#statSticky').textContent = d.counts.sticky;
    $('#statTotal').textContent = d.planTotal || '—';
    $('#statWordsSub').textContent = `本地已缓存 ${d.counts.words} 词 · 助记 ${d.counts.notes} 条`;

    // 复习量直方图
    const maxF = Math.max(1, ...d.forecast.map(x => x.count));
    $('#forecastBars').innerHTML = d.forecast.map(x => `
      <div class="bar-col">
        <div class="bar-num">${x.count || ''}</div>
        <div class="bar" style="height:${Math.max(2, x.count / maxF * 100)}%"></div>
        <div class="bar-label">${x.date.slice(5)}</div>
      </div>`).join('');

    // 进度曲线（移动端只显示最近 7 天，防止柱子过多拉扯布局）
    const isMobile = window.innerWidth <= 700;
    const histSlice = d.history.length ? (isMobile ? d.history.slice(-7) : d.history) : [{ date: '', finished: 0, total: 0 }];
    const maxH = Math.max(1, ...histSlice.map(x => x.finished));
    $('#historyBars').innerHTML = histSlice.map(x => `
      <div class="bar-col" title="${x.date}: ${x.finished}/${x.total}">
        <div class="bar-num">${x.finished || ''}</div>
        <div class="bar dim" style="height:${Math.max(2, x.finished / maxH * 100)}%"></div>
        <div class="bar-label">${x.date.slice(5)}</div>
      </div>`).join('');
    // 更新标题
    const histTitle = $('#historyBars')?.closest('.card')?.querySelector('.card-title');
    if (histTitle) histTitle.textContent = `墨墨学习成果（最近 ${histSlice.length} 天）`;

    // v1.2.1：考研倒计时
    const countdown = $('#kaoyanCountdown');
    if (countdown) countdown.style.display = d.kaoyan ? '' : 'none';
    if (d.kaoyan) {
      $('#countdownTitle').textContent = `距${({ kaoyan1: '考研初试', cet6: '六级考试', custom: '自定义考试' })[d.kaoyan.examType] || '考试'}${d.kaoyan.custom ? '' : '（估算）'}`;
      $('#countdownDays').textContent = d.kaoyan.daysLeft;
      $('#countdownDate').textContent = d.kaoyan.examDate;
      $('#streakDays').textContent = d.streak || 0;
    }

    // v1.2.1：词汇掌握度分布
    if (d.mastery) {
      const m = d.mastery;
      const total = m.wellFamiliar + m.sticky + m.forget + m.vague + m.other;
      const pct = v => total ? Math.round(v / total * 100) : 0;
      const bar = $('#masteryBar');
      if (bar && total) {
        bar.innerHTML = `<div class="mastery-seg seg-ok" style="width:${pct(m.wellFamiliar)}%"></div>` +
          `<div class="mastery-seg seg-other" style="width:${pct(m.other)}%"></div>` +
          `<div class="mastery-seg seg-vague" style="width:${pct(m.vague)}%"></div>` +
          `<div class="mastery-seg seg-forget" style="width:${pct(m.forget)}%"></div>` +
          `<div class="mastery-seg seg-sticky" style="width:${pct(m.sticky)}%"></div>`;
      } else if (bar) {
        bar.innerHTML = '<div class="empty">同步后显示</div>';
      }
      const leg = $('#masteryLegend');
      if (leg) {
        leg.innerHTML = [
          `<span class="ml-item"><i class="ml-dot seg-ok"></i>熟练 ${m.wellFamiliar}</span>`,
          `<span class="ml-item"><i class="ml-dot seg-other"></i>一般 ${m.other}</span>`,
          `<span class="ml-item"><i class="ml-dot seg-vague"></i>模糊 ${m.vague}</span>`,
          `<span class="ml-item"><i class="ml-dot seg-forget"></i>忘记 ${m.forget}</span>`,
          `<span class="ml-item"><i class="ml-dot seg-sticky"></i>顽固 ${m.sticky}</span>`,
        ].join('');
      }
    }

    // v1.2.1：测验与做题概况
    const qo = $('#quizOverview');
    if (qo) {
      const qs = d.quizStats || {};
      const us = d.unitStats || {};
      const parts = [];
      if (qs.total) parts.push(`<div><b>${qs.total}</b> 次单词测验 · <b>${qs.totalQ || 0}</b> 题 · 正确率 <b>${qs.avgRate || 0}%</b></div>`);
      if (us.total) parts.push(`<div><b>${us.total}</b> 次单元练习 · <b>${us.judged}</b> 题判分 · 正确 <b>${us.judged ? Math.round(us.correct / us.judged * 100) : 0}%</b></div>`);
      if (d.counts.sessions) parts.push(`<div><b>${d.counts.sessions}</b> 次 AI 学习会话 · <b>${d.counts.notes}</b> 条助记</div>`);
      qo.innerHTML = parts.length ? parts.join('') : '<div class="empty">还没做过测验，去试试吧</div>';
    }

    // 同步日志
    $('#syncLog').innerHTML = d.recentLog.length
      ? d.recentLog.map(l => `<li class="${l.ok ? 'log-ok' : 'log-fail'}">${fmtBJ(l.ts)} · ${esc(l.msg)}</li>`).join('')
      : '<li>暂无记录，点击右上角同步</li>';

    // 首次使用提示
    const status = await api('/api/status');
    $('#setupHint').style.display = (!status.hasToken || !status.llm.configured) ? 'block' : 'none';
    updateSyncBadge(status.lastSync ? 'ok' : 'err', status.lastSync ? formatTime(status.lastSync) : '未同步');
  } catch (e) {
    console.error(e);
  }
}

// v2.0.0.a：前端每 30 秒静默轮询状态，若后台定时任务完成同步则无感更新同步红绿灯
setInterval(async () => {
  try {
    const status = await api('/api/status');
    if (status && status.lastSync) {
      updateSyncBadge(status.lastSyncOk ? 'ok' : 'err', formatTime(status.lastSync));
    }
  } catch {}
}, 30000);

function formatTime(iso) { return fmtBJ(iso); }

function updateSyncBadge(dotClass, text) {
  const dot = $('#syncDot');
  const txt = $('#syncText');
  if (dot) dot.className = 'dot ' + dotClass;
  if (txt) txt.textContent = text;

  const mDot = $('#mobileSyncDot');
  const mTxt = $('#mobileSyncText');
  if (mDot) mDot.className = 'dot ' + dotClass;
  if (mTxt) mTxt.textContent = text;
}

$('#syncBadge').addEventListener('click', () => doSync(false));
$('#bannerSyncBtn').addEventListener('click', () => doSync(false));

async function doSync(silent) {
  if (!silent) updateSyncBadge('loading', '同步中…');
  try {
    const r = await api('/api/sync', { method: 'POST' });
    updateSyncBadge(r.ok ? 'ok' : 'err', formatTime(new Date().toISOString()));
    if (!silent) {
      alert(r.ok ? '✅ 同步完成\n' + r.msg : '⚠️ 部分失败\n' + r.msg);
      loadDashboard();
    }
  } catch (e) {
    updateSyncBadge('err', '同步失败');
    if (!silent) alert('❌ ' + e.message);
  }
}

/* ---------------- v2.2.3：学习诊断周报 ---------------- */

let reportRequest = 0;
async function loadLearningReport(days = 7) {
  const request = ++reportRequest;
  state.reportDays = days;
  const labelEl = $('#reportWinLabel');
  if (labelEl) labelEl.textContent = `最近 ${days} 天`;
  $$('.report-win-btn').forEach(b => {
    const current = Number(b.dataset.days) === days;
    b.classList.toggle('active', current);
    b.setAttribute('aria-pressed', String(current));
  });

  const bodyEl = $('#learningReportBody');
  if (!bodyEl) return;
  bodyEl.setAttribute('aria-busy', 'true');
  bodyEl.innerHTML = '<div class="hint">正在读取这个时段的学习记录…</div>';
  try {
    const r = await api(`/api/learning/report?days=${days}`);
    if (request !== reportRequest) return;
    renderLearningReport(r);
  } catch (err) {
    if (request !== reportRequest) return;
    bodyEl.innerHTML = `<div class="result err">⚠️ 加载学习诊断周报失败: ${esc(err.message)}</div>`;
  } finally {
    if (request === reportRequest) bodyEl.setAttribute('aria-busy', 'false');
  }
}

function renderLearningReport(data) {
  const bodyEl = $('#learningReportBody');
  if (!bodyEl) return;

  const ov = data.overview || {};
  if (!ov.totalAttempts) {
    bodyEl.innerHTML = `
      <div class="report-empty">
        <div class="report-empty-title">还没有工作台作答记录</div>
        <div class="report-empty-sub">完成单词测验或真题专项后，报告会显示薄弱项与作答表现。</div>
        <button type="button" class="btn" data-jump="quiz">开始单词测验</button>
      </div>`;
    return;
  }

  const accPct = ov.accuracy !== null ? Math.round(ov.accuracy * 100) + '%' : '—';
  const avgSec = ov.avgDurationMs ? (ov.avgDurationMs / 1000).toFixed(1) + 's' : '—';

  // 1. 核心指标网格
  const overviewHtml = `
    <div class="report-stat-grid">
      <div class="report-stat-box">
        <div class="report-stat-label">作答题量</div>
        <div class="report-stat-val">${ov.totalAttempts}</div>
        <div class="report-stat-sub">已判分: ${ov.judgedCount} 题</div>
      </div>
      <div class="report-stat-box">
        <div class="report-stat-label">客观准确率</div>
        <div class="report-stat-val ${ov.accuracy >= 0.7 ? 'ok' : 'warn'}">${accPct}</div>
        <div class="report-stat-sub">正确: ${ov.correctCount || 0} 题</div>
      </div>
      <div class="report-stat-box">
        <div class="report-stat-label">平均作答会话耗时</div>
        <div class="report-stat-val">${avgSec}</div>
        <div class="report-stat-sub">作答节奏</div>
      </div>
      <div class="report-stat-box">
        <div class="report-stat-label">主观输出</div>
        <div class="report-stat-val">${(data.subjective?.translationCount || 0) + (data.subjective?.essayCount || 0)}</div>
        <div class="report-stat-sub">翻译 ${data.subjective?.translationCount || 0} 篇 · 作文 ${data.subjective?.essayCount || 0} 篇</div>
      </div>
    </div>`;

  // 1b. 分题型统计（v2.2.8：六类 section 作答量/判分量/准确率）
  const secLabels = {
    vocabulary: '词汇',
    use_of_english: '完形填空',
    reading: '阅读理解',
    part_b: '新题型',
    translation: '翻译',
    writing: '写作',
  };
  const secOrder = ['vocabulary', 'use_of_english', 'reading', 'part_b', 'translation', 'writing'];
  const bySection = data.bySection || {};
  const bySecRows = secOrder
    .map(k => ({ k, v: bySection[k] || { total: 0, judged: 0, correct: 0, accuracy: null } }))
    .filter(x => x.v.total > 0 || x.v.judged > 0);
  const bySecHtml = bySecRows.length ? `
    <div class="report-section">
      <div class="report-sec-title">📚 分题型作答统计</div>
      <div class="report-sec-table">
        <div class="report-sec-row report-sec-head">
          <span class="sec-name">题型</span>
          <span class="sec-num">作答</span>
          <span class="sec-num">判分</span>
          <span class="sec-num">准确率</span>
        </div>
        ${bySecRows.map(({ k, v }) => `
          <div class="report-sec-row">
            <span class="sec-name">${esc(secLabels[k] || k)}</span>
            <span class="sec-num">${v.total}</span>
            <span class="sec-num">${v.judged}</span>
            <span class="sec-num ${v.accuracy !== null ? (v.accuracy >= 0.7 ? 'ok' : 'warn') : ''}">${v.accuracy !== null ? Math.round(v.accuracy * 100) + '%' : '—'}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // 2. 薄弱反复错词
  const repList = data.repeatedWords || [];  const repHtml = repList.length ? `
    <div class="report-section">
      <div class="report-sec-title">⚠️ 反复错词 / 顽固词（做错 ≥2 次）</div>
      <div class="report-tag-list">
        ${repList.map(w => `
          <button type="button" class="btn mini ghost report-word-tag" data-word="${esc(w.word)}">
            ${esc(w.word)} <span class="badge warn">${w.count}次</span>
          </button>`).join('')}
      </div>
    </div>` : '';

  // 3. 错因分布
  const reasonLabels = {
    unknown_word: '生词障碍',
    misread_stem: '看错题干',
    evidence_missed: '定位遗漏',
    over_inference: '过度推断',
    option_trap: '选项陷阱',
    careless: '粗心手滑',
    time_pressure: '时间紧张',
    other: '其他原因',
  };
  const reasons = data.errorReasons || {};
  const reasonEntries = Object.entries(reasons).filter(([k, v]) => v > 0);
  const reasonHtml = reasonEntries.length ? `
    <div class="report-section">
      <div class="report-sec-title">🎯 客观题错因归因分布</div>
      <div class="report-reason-grid">
        ${reasonEntries.map(([k, v]) => `
          <div class="report-reason-item">
            <span class="reason-name">${reasonLabels[k] || k}</span>
            <span class="reason-count">${v} 次</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // 4. 信心校准矩阵
  const cm = data.confidenceMatrix || {};
  const confLabels = { sure: '🎯 确定', unsure: '🤔 犹豫', guess: '🎲 猜测' };
  const confHtml = `
    <div class="report-section">
      <div class="report-sec-title">⚖️ 作答信心与准确率校准</div>
      <div class="report-conf-grid">
        ${['sure', 'unsure', 'guess'].map(k => {
          const item = cm[k] || { total: 0, accuracy: null, correct: 0 };
          const p = item.accuracy !== null ? Math.round(item.accuracy * 100) + '%' : '—';
          return `
            <div class="report-conf-box">
              <div class="conf-head">${confLabels[k]}</div>
              <div class="conf-acc">${p}</div>
              <div class="conf-detail">${item.correct}/${item.total} 题正确</div>
            </div>`;
        }).join('')}
      </div>
    </div>`;

  // 5. 助记有效性评估（可解释模型追踪）
  const mn = data.mnemonicEffect || {};
  const mnHtml = mn.samples > 0 ? `
    <div class="report-section">
      <div class="report-sec-title">💡 助记促学效果追踪</div>
      <div class="report-mn-row">
        <span class="mn-badge ok">初步有效 ${mn.initialEffective}</span>
        <span class="mn-badge warn">待重写 ${mn.needsRewrite}</span>
        <span class="mn-badge sub">待验证 ${mn.pending}</span>
        <span class="mn-tip">（基于助记创建后的后续首测作答表现）</span>
      </div>
    </div>` : '';

  // 6. 待复测长难句任务（v2.2.5）
  const dueList = data.dueReviews || [];
  const dueHtml = dueList.length ? `
    <div class="report-section">
      <div class="report-sec-title">📅 待复测长难句（3 天周期）</div>
      <div class="report-due-list">
        ${dueList.map(d => `
          <button type="button" class="report-due-item" data-review-id="${esc(d.id)}" data-prompt="${esc(String(d.prompt || '').slice(0, 600))}">
            <span class="due-sentence">${esc(String(d.prompt || '').slice(0, 80))}${String(d.prompt || '').length > 80 ? '…' : ''}</span>
            <span class="due-badge">复测</span>
          </button>`).join('')}
      </div>
    </div>` : '';

  // 5b. 待重试首答（v2.2.8：LLM 失败已存输入，尚未生成反馈，不计入作答统计）
  const retryList = data.pendingRetries || [];
  const pendingHtml = retryList.length ? `
    <div class="report-section">
      <div class="report-sec-title">⏳ 待重试长难句（AI 反馈未生成）</div>
      <div class="report-due-list">
        ${retryList.map(d => `
          <button type="button" class="report-retry-item" data-review-id="${esc(d.id)}" data-prompt="${esc(String(d.prompt || '').slice(0, 600))}">
            <span class="due-sentence">${esc(String(d.prompt || '').slice(0, 80))}${String(d.prompt || '').length > 80 ? '…' : ''}</span>
            <span class="due-badge warn">待重试</span>
          </button>`).join('')}
      </div>
    </div>` : '';

  bodyEl.innerHTML = overviewHtml + bySecHtml + repHtml + reasonHtml + confHtml + mnHtml + pendingHtml + dueHtml;

  // 绑定反复错词点击跳转去学
  $$('#learningReportBody .report-word-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      const sp = btn.dataset.word;
      if (sp) {
        switchTab('study');
        $('#wordSearch').value = sp;
        loadWords();
      }
    });
  });

  // 绑定待复测长难句点击进入训练弹层
  $$('#learningReportBody .report-due-item').forEach(btn => {
    btn.addEventListener('click', () => {
      stOpenReview(btn.dataset.reviewId, btn.dataset.prompt, {});
    });
  });

  // 绑定待重试首答点击进入训练弹层（复用首答重做入口）
  $$('#learningReportBody .report-retry-item').forEach(btn => {
    btn.addEventListener('click', () => {
      stOpenRetry(btn.dataset.reviewId, btn.dataset.prompt);
    });
  });
}

// 绑定周报时间窗口切换按钮
$$('.report-win-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const days = Number(btn.dataset.days || 7);
    loadLearningReport(days);
  });
});

// 查看全部流水弹层
if ($('#reportViewAllBtn')) {
  $('#reportViewAllBtn').addEventListener('click', () => openReportModal());
}
if ($('#reportModalClose')) {
  $('#reportModalClose').addEventListener('click', () => {
    $('#reportModal').style.display = 'none';
  });
}
if ($('#reportKindFilter')) {
  $('#reportKindFilter').addEventListener('change', (e) => {
    loadReportModalList(e.target.value);
  });
}

async function openReportModal() {
  $('#reportModal').style.display = 'flex';
  const filter = $('#reportKindFilter') ? $('#reportKindFilter').value : '';
  loadReportModalList(filter);
}

async function loadReportModalList(kind = '') {
  const listEl = $('#reportModalList');
  const totEl = $('#reportModalTotal');
  if (!listEl) return;
  listEl.innerHTML = '<div class="hint">加载流水明细…</div>';

  try {
    const url = kind ? `/api/learning/attempts?kind=${encodeURIComponent(kind)}&limit=100` : '/api/learning/attempts?limit=100';
    const r = await api(url);
    const attempts = r.attempts || [];
    if (totEl) totEl.textContent = `共 ${r.total} 条（显示前 ${attempts.length} 条）`;

    if (!attempts.length) {
      listEl.innerHTML = '<div class="report-empty" style="padding:20px 0">暂无对应流水记录</div>';
      return;
    }

    listEl.innerHTML = attempts.map(a => {
      const isOk = a.result === 'correct';
      const isBad = a.result === 'incorrect';
      const resClass = isOk ? 'u-ok' : isBad ? 'u-bad' : '';
      const resText = isOk ? '✓ 正确' : isBad ? '✗ 错误' : (a.result || '待定');
      const timeStr = a.submittedAt || a.startedAt || '';
      return `
        <div class="report-attempt-item">
          <div class="att-head">
            <span class="tag">${esc(ATTEMPT_KIND_LABELS[a.kind] || a.kind)}</span>
            <span class="att-res ${resClass}">${resText}</span>
            <span class="att-conf">${a.confidence ? '信心: ' + esc(a.confidence) : ''}</span>
            <span class="att-time">${timeStr ? fmtBJ(timeStr) : ''}</span>
          </div>
          <div class="att-prompt"><b>题干:</b> ${esc(String(a.prompt || '').slice(0, 120))}</div>
          <div class="att-ans"><b>作答:</b> ${esc(String(a.answer || '').slice(0, 100))}${a.expected ? ` · <b>标准:</b> ${esc(String(a.expected).slice(0, 80))}` : ''}</div>
          ${a.errorReason ? `<div class="att-reason">错因标记: <span class="badge warn">${esc(a.errorReason)}</span></div>` : ''}
        </div>`;
    }).join('');

  } catch (err) {
    listEl.innerHTML = `<div class="result err">加载失败: ${esc(err.message)}</div>`;
  }
}

/* ---------------- AI 学习页 ---------------- */

$$('#wordFilters .chip').forEach(c => c.addEventListener('click', () => {
  $$('#wordFilters .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  state.filter = c.dataset.filter;
  loadWords();
}));

const loadWordsDebounced = debounce(loadWords, 300);
$('#wordSearch').addEventListener('input', () => { updateCoachSelection(); loadWordsDebounced(); });
$('#wordSearch').addEventListener('keydown', e => { if (e.key === 'Enter') loadWords(); });

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const COACH_WORD_PAGE = 60;
let wordVisibleCount = COACH_WORD_PAGE, wordRequest = 0, wordResult = null;
const wordQuery = () => new URLSearchParams({ view: 'coach', filter: state.filter, q: $('#wordSearch').value.trim() }).toString();
const wordResultReady = () => wordResult === wordQuery();
async function loadWords() {
  const request = ++wordRequest;
  const query = wordQuery();
  wordResult = null;
  updateCoachSelection();
  try {
    const d = await api(`/api/words?${query}`);
    if (request !== wordRequest || query !== wordQuery()) return;
    state.words = d.words;
    wordResult = query;
    wordVisibleCount = COACH_WORD_PAGE;
    renderWordList();
    fetchGlosses();   // 后台补释义，不阻塞列表
  } catch (e) {
    if (request !== wordRequest || query !== wordQuery()) return;
    $('#coachMoreWords').hidden = true;
    $('#wordList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/** 批量补齐当前词表缺失的音标/释义（AI 词典缓存，失败静默） */
async function fetchGlosses() {
  const need = state.words.filter(w => !w.gloss).slice(0, 30).map(w => w.spelling);
  if (!need.length) return;
  try {
    const r = await api('/api/gloss', { method: 'POST', body: { spellings: need } });
    const got = r.glosses || {};
    if (!Object.keys(got).length) return;
    state.words.forEach(w => {
      if (!got[w.spelling]) return;
      w.gloss = got[w.spelling];
      const selected = coachSelection.get(coachChoice(w.spelling));
      if (selected && !selected.gloss) selected.gloss = w.gloss.gloss || '';
    });
    if ($('#tab-study').classList.contains('active')) renderWordList();
  } catch { /* 释义是增强功能，获取失败不影响主流程 */ }
}

function renderWordList() {
  updateCoachSelection();
  const list = $('#wordList');
  const total = state.words.length;
  const more = $('#coachMoreWords');
  more.hidden = total <= wordVisibleCount;
  more.textContent = `显示更多（${Math.min(total, wordVisibleCount)}/${total}）`;
  const fabCount = $('#wordFabCount'), panelCount = $('#wordPanelCount');
  if (fabCount) fabCount.textContent = String(total);
  if (panelCount) panelCount.textContent = total ? `· ${total} 词` : '';
  if (!state.words.length) {
    list.innerHTML = '<div class="empty">没有符合条件的单词，试试其他筛选或先同步</div>';
    return;
  }
  const todayStr = bjDate();
  list.innerHTML = state.words.slice(0, wordVisibleCount).map(w => {
    let badge = '';
    if (w.tags?.includes('STICKING') || w.quizResponse === 'FORGET') badge = '<span class="badge sticky">顽固</span>';
    else if (w.today?.date === todayStr && w.today?.isNew) badge = '<span class="badge new">新词</span>';
    else if (w.today?.date === todayStr && w.today?.isFinished) badge = '<span class="badge done">已完成</span>';
    // v3.5.1：今日作答结果徽标（忘记/模糊/熟知），只要限定今天，独立于上方状态徽标
    const isTodayResp = w.today?.date === todayStr;
    if (isTodayResp && w.today?.firstResponse === 'FORGET') badge += '<span class="badge sticky">今日忘</span>';
    else if (isTodayResp && w.today?.firstResponse === 'VAGUE') badge += '<span class="badge vague">今日模糊</span>';
    else if (isTodayResp && w.today?.firstResponse === 'WELL_FAMILIAR') badge += '<span class="badge done">今日熟</span>';
    const meta = w.studyCount != null ? `学过 ${w.studyCount} 次` : (w.nextStudyDate ? '到期 ' + w.nextStudyDate.slice(5, 10) : '');
    const phon = w.gloss?.phonetic ? `<span class="phonetic">${esc(w.gloss.phonetic)}</span>` : '';
    const glossLine = w.gloss?.gloss ? `<div class="gloss-line" title="${esc(w.gloss.gloss)}">${esc(w.gloss.gloss)}</div>` : '<div class="gloss-line dim">　</div>';
    const checked = coachSelection.has(coachChoice(w.spelling));
    return `<div class="word-item ${checked ? 'active' : ''}" data-sp="${esc(w.spelling)}">
      <input class="coach-check" type="checkbox" aria-label="勾选 ${esc(w.spelling)}" ${checked ? 'checked' : ''}>
      <span class="word-main">
        <span class="spelling">${esc(w.spelling)} ${phon}</span>
        ${glossLine}
      </span>
      <span style="text-align:right;flex-shrink:0">${badge}<div class="meta">${meta}</div><button class="speak-btn mini" data-speak="${esc(w.spelling)}" title="朗读">🔊</button></span>
    </div>`;
  }).join('');
  $$('.word-item').forEach(el => el.addEventListener('click', () => selectWord(el.dataset.sp, el)));
  $$('.word-item .speak-btn').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();   // 不触发选中
    speak(b.dataset.speak);
  }));
}

/* 词表使用浮层，勾选时保持打开。 */
function wordPanelOpen(open, { load = true } = {}) {
  const panel = $('#wordPanel'), fab = $('#wordFab');
  if (!panel) return;
  const on = !!open;
  panel.classList.toggle('open', on);
  if (!on && panel.contains(document.activeElement)) fab.focus({ preventScroll: true });
  panel.setAttribute('aria-hidden', on ? 'false' : 'true');
  panel.inert = !on;
  if (fab) fab.setAttribute('aria-expanded', on ? 'true' : 'false');
  document.body.classList.toggle('word-pop-open', on);
  if (on) {
    // 手机上不抢焦点（避免软键盘弹出来把列表顶走）；桌面端把光标直接放进搜索框
    const body = $('#wordPanelCollapseBody');
    if (body) body.scrollTop = 0;
    if (window.matchMedia && window.matchMedia('(min-width: 701px)').matches) {
      setTimeout(() => { if (panel.classList.contains('open')) $('#wordSearch').focus({ preventScroll: true }); }, 170);
    }
    if (load && !state.words.length) loadWords();
  }
}

function wordPanelToggle() {
  const panel = $('#wordPanel');
  wordPanelOpen(!(panel && panel.classList.contains('open')));
}

$('#wordFab').addEventListener('click', (e) => { e.stopPropagation(); wordPanelToggle(); });
$('#wordPanelClose').addEventListener('click', () => wordPanelOpen(false));
/* 点浮层外任意位置收起（词条、筛选、搜索都算「内部」，不误关） */
document.addEventListener('click', (e) => {
  const panel = $('#wordPanel');
  if (!panel || !panel.classList.contains('open')) return;
  if (e.target.closest('#wordPanel, #wordFab, #mistWordStudy, #mistNextTask, [data-study-start="vocab_today"], [data-jump="study"][data-filter]')) return;
  wordPanelOpen(false);
});
document.addEventListener('keydown', (e) => {
  const panel = $('#wordPanel');
  if (e.key === 'Escape' && panel && panel.classList.contains('open')) wordPanelOpen(false);
});

function selectWord(spelling, row) {
  if (!wordResultReady()) { row.querySelector('.coach-check').checked = coachSelection.has(coachChoice(spelling)); return; }
  const key = coachChoice(spelling);
  if (coachSelection.has(key)) coachSelection.delete(key);
  else {
    const word = state.words.find(w => w.spelling === spelling);
    coachSelection.set(key, { word: spelling, gloss: word?.gloss?.gloss || '' });
  }
  const checked = coachSelection.has(key);
  row.classList.toggle('active', checked);
  row.querySelector('.coach-check').checked = checked;
  state.activeWord = spelling;
  $('#speakWordBtn').style.display = 'inline-block';
  $('#chatHeader').textContent = '当前单词：' + spelling;
  updateCoachSelection();
}

function addMsg(role, content, word) {
  const box = $('#chatMessages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const tag = word ? `<span class="word-tag">📘 ${esc(word)}</span>` : '';
  const spk = role === 'ai'
    ? `<button class="speak-btn mini msg-speak" title="朗读其中的英文例句">🔊</button>` : '';
  div.innerHTML = tag + mdLite(content) + spk;
  if (role === 'ai') div.dataset.raw = content;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// 事件委托：AI 消息上的朗读按钮
$('#chatMessages').addEventListener('click', (e) => {
  const btn = e.target.closest('.msg-speak');
  if (!btn) return;
  const msg = btn.closest('.msg');
  speakEnglishFrom(msg.dataset.raw || '', state.activeWord);
});

/* v1.0.8 真人发音；v3.5.0：统一走服务端发音（单词真人音 + 口音切换 + 缓存） */
$('#speakWordBtn').addEventListener('click', () => {
  const w = state.activeWord;
  if (!w) return;
  unlockTtsAudio();
  speak(w);
});

/** Markdown 渲染器（v1.2.0，v2.9.1 增强）：加粗/斜体/删除线/行内高亮/行内代码/LaTeX公式脱壳/常见推导箭头与数学符号/代码块/表格/列表/引用/分隔线/链接/图片 */
function mdInline(s) {
  return s
    // 1. 链接与图片
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="md-img" src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>')
    // 2. 基础行内排版：加粗、斜体、删除线、行内高亮、行内代码
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(?<![*\w])\*([^*]+?)\*(?![*\w])/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/==(.+?)==/g, '<mark class="md-mark">$1</mark>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 3. LaTeX 行内公式脱壳：$ \rightarrow $ / $\to$ / $x \le y$
    .replace(/\$([^\$\n]+?)\$/g, '$1')
    // 4. LaTeX 常用推导箭头与数学符号映射（区分大小写：小写单线，大写双线）
    .replace(/\\(?:longleftrightarrow|leftrightarrow)\b/g, '↔')
    .replace(/\\(?:Longleftrightarrow|Leftrightarrow)\b/g, '⇔')
    .replace(/\\(?:longrightarrow|rightarrow|to)\b/g, '→')
    .replace(/\\(?:Longrightarrow|Rightarrow|implies)\b/g, '⇒')
    .replace(/\\(?:longleftarrow|leftarrow|gets)\b/g, '←')
    .replace(/\\(?:Longleftarrow|Leftarrow)\b/g, '⇐')
    .replace(/\\(?:approx|sim)\b/gi, '≈')
    .replace(/\\(?:neq|ne)\b/gi, '≠')
    .replace(/\\(?:leq|le)\b/gi, '≤')
    .replace(/\\(?:geq|ge)\b/gi, '≥')
    .replace(/\\times\b/gi, '×')
    .replace(/\\div\b/gi, '÷')
    .replace(/\\pm\b/gi, '±')
    .replace(/\\(?:cdot|cdots|ldots)\b/gi, '···')
    // 5. 文本型箭头（匹配被 esc() 转义后的 &gt; 和 &lt;，支持 ->, =>, <->, <=>）
    .replace(/&lt;[=-]+&gt;/g, m => m.includes('=') ? '⇔' : '↔')
    .replace(/=+&gt;/g, '⇒')
    .replace(/-+&gt;/g, '→')
    .replace(/&lt;=+/g, '⇐')
    .replace(/&lt;-+/g, '←');
}

function mdLite(text) {
  const lines = esc(text).split('\n');
  const html = [];
  let ulOpen = false, olOpen = false;
  let table = [];
  let inCode = false, codeLang = '', codeLines = [];
  const closeUl = () => { if (ulOpen) { html.push('</ul>'); ulOpen = false; } };
  const closeOl = () => { if (olOpen) { html.push('</ol>'); olOpen = false; } };
  const closeLists = () => { closeUl(); closeOl(); };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table
      .map(r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()))
      .filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ''));
    if (rows.length) {
      const [head, ...rest] = rows;
      html.push('<table class="md-table"><thead><tr>' +
        head.map(c => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead>' +
        (rest.length ? '<tbody>' + rest.map(r => '<tr>' + r.map(c => `<td>${mdInline(c)}</td>`).join('') + '</tr>').join('') + '</tbody>' : '') +
        '</table>');
    } else {
      html.push(`<div>${table.map(mdInline).join('<br>')}</div>`);
    }
    table = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    // fenced code block （三反引号开闭）
    if (/^`{3}/.test(line.trim())) {
      if (!inCode) {
        closeLists(); flushTable();
        inCode = true; codeLang = line.trim().slice(3).trim(); codeLines = [];
      } else {
        html.push(`<pre class="md-code-block${codeLang ? ' lang-' + codeLang : ''}"><code>${codeLines.join('\n')}</code></pre>`);
        inCode = false; codeLang = ''; codeLines = [];
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    // table
    if (/^\s*\|.*\|\s*$/.test(line)) { closeLists(); table.push(line.trim()); continue; }
    flushTable();
    // empty
    if (!line.trim()) { closeLists(); html.push('<div class="md-gap"></div>'); continue; }
    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeLists(); html.push('<hr class="md-hr">'); continue; }
    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeLists(); html.push(`<div class="md-h md-h${h[1].length}">${mdInline(h[2])}</div>`); continue; }
    // blockquote（> 被 esc() 转成 &gt;）
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) { closeLists(); html.push(`<blockquote class="md-quote">${mdInline(bq[1])}</blockquote>`); continue; }
    // unordered list
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) {
      closeOl();
      if (!ulOpen) { html.push('<ul>'); ulOpen = true; }
      html.push(`<li>${mdInline(ul[1])}</li>`);
      continue;
    }
    // ordered list
    const oli = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (oli) {
      closeUl();
      if (!olOpen) { html.push(`<ol start="${oli[1]}">`); olOpen = true; }
      html.push(`<li>${mdInline(oli[2])}</li>`);
      continue;
    }
    closeLists();
    html.push(`<div>${mdInline(line)}</div>`);
  }
  if (inCode) html.push(`<pre class="md-code-block"><code>${codeLines.join('\n')}</code></pre>`);
  closeLists();
  flushTable();
  return html.join('');
}

/* v2.3.4：视觉能力——默认服务商开启 vision 后，可随提问附图片（OpenAI 兼容 image_url 内容块） */
let chatImage = '';   // 待发送图片 dataURL

function activeVisionEnabled() {
  const p = state.providers.find(x => x.id === state.activeProvId);
  return !!(p && p.vision);
}

function refreshVisionUI() {
  const btn = $('#chatImageBtn');
  if (btn) btn.style.display = activeVisionEnabled() ? '' : 'none';
}

/** 压缩输入图片：最长边 ≤1024px、JPEG 0.85，产出 dataURL（≤1.5MB 服务端红线） */
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, 1024 / Math.max(img.width, img.height, 1));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const dataURL = canvas.toDataURL('image/jpeg', 0.85);
          if (!dataURL.startsWith('data:image/')) throw new Error('图片编码失败');
          resolve(dataURL);
        } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function setChatImagePreview(dataURL) {
  chatImage = dataURL || '';
  const row = $('#chatImagePreview');
  if (!row) return;
  if (dataURL) {
    $('#chatImagePreviewImg').src = dataURL;
    row.style.display = 'flex';
  } else {
    row.style.display = 'none';
  }
}

$('#chatImageBtn').addEventListener('click', () => { const f = $('#chatImageFile'); f.value = ''; f.click(); });
$('#chatImageFile').addEventListener('change', async () => {
  const f = $('#chatImageFile').files && $('#chatImageFile').files[0];
  if (!f) return;
  try { setChatImagePreview(await compressImageFile(f)); }
  catch (e) { toast('🖼️ ' + (e.message || '图片处理失败')); }
});
$('#chatImageClear').addEventListener('click', () => setChatImagePreview(''));

/* v3.8.1：会话在途锁——一次交互只允许一个请求在飞。
 * 旧版无此保护：上游慢时「回车 + 再点 chip」「连点两次词条」都会叠加成多次 LLM 调用，
 * 而多用户下写请求走 per-user 串行队列，叠加的请求只能排队逐个跑，表现为「只问了一次却等好几轮」。 */
let chatInFlight = false;

async function askAI(message, isErrorMark = false) {
  if (!message.trim()) return;
  if (chatInFlight) { toast('⏳ 上一条还在回答中，请稍候再发'); return; }
  chatInFlight = true;
  const sendBtnEl = $('#sendBtn');
  if (sendBtnEl) sendBtnEl.disabled = true;   // 显式禁用，避免用户误以为没点上而反复点
  const image = chatImage;               // v2.3.4：捕获待发送图片后立即清空预览
  if (image) setChatImagePreview('');
  /* v3.8.1：请求历史必须在「把本轮提问写入本地历史」之前取出。
   * 旧写法先 push 再 slice，而服务端会把 message 作为本轮提问追加在历史之后，
   * 同一条用户消息因此在请求体里出现两次（实测 roles=[system,user,user]，内容完全相同），
   * 每个回合的 prompt 都白多一份用户消息。 */
  const history = state.chatHistory.slice(-16).map(m => ({ role: m.role, content: m.content }));
  addMsg('user', message, state.activeWord);
  state.chatHistory.push({ role: 'user', content: message, word: state.activeWord });
  if (state.activeWord) {
    state.sessionWords.add(state.activeWord);
    if (isErrorMark) state.sessionErrorWords.add(state.activeWord);
    updateSessionInfo();
  }
  const loading = addMsg('ai', '思考中…');
  loading.classList.add('loading');
  try {
    const r = await api('/api/chat', {
      method: 'POST',
      body: {
        spelling: state.activeWord,
        message,
        history,                        // v3.8.1：不含本轮提问（服务端会追加），杜绝重复

        image: image || undefined,      // v2.3.4：视觉能力图片随问题发送
      },
    });
    loading.classList.remove('loading');
    let evidenceBadgeHtml = '';
    if (r.evidence) {
      const parts = [];
      if (r.evidence.examsCount > 0) parts.push(`<span class="evidence-pill exam" title="${esc(r.evidence.sampleExam || '真题库')}">🎓 真题 ×${r.evidence.examsCount}</span>`);
      if (r.evidence.externalCount > 0) parts.push(`<span class="evidence-pill external" title="${esc(r.evidence.sampleExternal || '外刊精选')}">📰 外刊 ×${r.evidence.externalCount}</span>`);
      if (r.evidence.corpusCount > 0) parts.push(`<span class="evidence-pill corpus" title="工作台手工语料">📚 语料 ×${r.evidence.corpusCount}</span>`);
      if (parts.length > 0) {
        evidenceBadgeHtml = `<div class="evidence-tags">${parts.join('')}</div>`;
      }
    }
    const currentWord = r.evidence?.spelling || state.activeWord;
    loading.innerHTML = (currentWord ? `<span class="word-tag">📘 ${esc(currentWord)}</span>` : '') + evidenceBadgeHtml + mdLite(r.reply);
    state.chatHistory.push({ role: 'assistant', content: r.reply, word: currentWord });
    autoSaveChat();   // v1.2.0：每次 AI 回复后自动持久化
  } catch (e) {
    loading.classList.remove('loading');
    loading.innerHTML = '❌ ' + esc(e.message) + (e.message.includes('AI 服务商') ? '（请到 设置 页配置）' : '');
  } finally {
    chatInFlight = false;             // v3.8.1：成功/失败都释放，避免一次异常把会话永久锁死
    if (sendBtnEl) sendBtnEl.disabled = false;
  }
}

function updateSessionInfo() {
  $('#sessionInfo').textContent = `本次会话已学 ${state.sessionWords.size} 词` +
    (state.sessionErrorWords.size ? `（${state.sessionErrorWords.size} 个易错）` : '');
  $('#finishBtn').disabled = state.sessionWords.size === 0;
}

/* v3.8.1：发送按钮与输入框共用同一发送入口。
 * Enter 判定补两道输入法保护：中文输入法组字态下按 Enter 是「确认候选/上屏」，
 * 浏览器仍会派发 keydown Enter（实测 isComposing=true、keyCode=13），旧写法只判 e.key，
 * 于是选词那一下就把半截内容当消息发了出去；确认候选后再按 Enter 又发一次，一次输入变两次请求。
 * keyCode 229 是部分输入法（含 Safari/旧版 Chrome）在组字期间上报的统一码。 */
function sendChatFromInput() {
  const input = $('#chatInput');
  const v = input.value.trim();
  input.value = '';
  askAI(v);
}
$('#sendBtn').addEventListener('click', sendChatFromInput);
$('#chatInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return;   // v3.8.1：输入法确认候选，不发送
  e.preventDefault();
  sendChatFromInput();
});

/* 同一批次、同一节点状态供横向导图与大纲使用。 */
const coachSelection = new Map();
let coachBatch = null;
let coachView = 'map';
let coachScale = 1;
const COACH_GROUP_PAGE = 24;
const COACH_PLAN_CHUNK = 48;

function resetCoachMap() {
  coachBatch = null;
  coachSelection.clear();
  renderWordList();
  $('#coachChat').open = false;
  renderCoachMap();
}

function coachChoice(word) { return word.trim().replace(/’/g, "'").replace(/\s+/g, ' ').toLowerCase(); }
function updateCoachSelection() {
  const count = coachSelection.size;
  $('#coachSelected').textContent = `已勾选 ${count} 词`;
  $('#coachScreenBtn').disabled = !count;
  $('#coachClearBtn').disabled = !count;
  const all = $('#coachSelectAllBtn');
  all.disabled = !wordResultReady() || !state.words.length;
  const checked = !all.disabled && state.words.every(w => coachSelection.has(coachChoice(w.spelling)));
  all.textContent = checked ? '取消全选当前结果' : '全选当前结果';
  all.setAttribute('aria-pressed', String(checked));
}

function beginCoachScreen() {
  if (!coachSelection.size) return;
  if (coachBatch && !coachBatch.sample && !confirm('开始新一轮会替换当前学习路径，继续吗？')) return;
  wordPanelOpen(false);
  coachBatch = { phase: 'screen', items: [...coachSelection.values()].map(({ word, gloss }) => ({ word, gloss })), active: 'screen', folded: new Set(), groups: [] };
  renderCoachMap(true);
}

function beginCoachSample() {
  coachBatch = {
    phase: 'study', sample: true, planned: true,
    items: ['address', 'solve'].map(word => ({ word, rating: 'unclear' })),
    active: 'g0', folded: new Set(), groups: [{ title: 'address / solve', words: ['address', 'solve'] }],
  };
  runCoachLesson('start');
}

const coachLessonTitles = { demo: '老师示范', guided: '跟着辨别', recall: '合上讲解回想', transfer: '换语境验证', retry: '再换一段语境' };
const coachLessonResults = { independent: '独立答对', assisted: '提示后答对', needs_work: '仍需补教' };
const coachFinished = group => group.lessonStage === 'done';

function coachCurrentGroup(batch = coachBatch) {
  const match = /^g(\d+)(?::(demo|guided|recall|transfer|retry)(:feedback)?)?$/.exec(batch?.active || '');
  if (!match) return {};
  const index = Number(match[1]);
  return { index, group: batch.groups[index], key: match[2], feedback: Boolean(match[3]) };
}

function coachLessonBlind(group) {
  return ['recall', 'transfer', 'retry'].includes(group.currentNode) && !coachFinished(group) && !group.result;
}

const coachInline = value => mdInline(esc(value));
const coachQuote = value => `<p>${esc(value)}</p>`;
function coachMarkedSentence(sentence, clue) {
  const at = sentence.indexOf(clue);
  if (!clue || at < 0) return coachQuote(sentence);
  return `<p>${esc(sentence.slice(0, at))}<mark>${esc(clue)}</mark>${esc(sentence.slice(at + clue.length))}</p>`;
}

function coachNode(id, title, meta, children = [], disabled = false) {
  const expanded = !coachBatch.folded.has(id);
  const fold = children.length ? `<button class="coach-fold" type="button" data-coach-fold="${id}" aria-label="${expanded ? '折叠' : '展开'}${esc(title)}" aria-expanded="${expanded}">${expanded ? '−' : '+'}</button>` : '';
  return `<li><div class="coach-node-row">${fold}<button class="coach-node" type="button" data-coach-node="${id}" aria-pressed="${id === coachBatch.active}" ${disabled ? 'disabled' : ''}><span class="coach-node-title">${coachInline(title)}</span>${meta ? `<span class="coach-node-meta">${esc(meta)}</span>` : ''}</button></div>${children.length && expanded ? `<ul>${children.join('')}</ul>` : ''}</li>`;
}

const coachAction = (id, label, primary = false, disabled = false) => `<button type="button" class="btn ${primary ? 'primary' : 'ghost'}" data-coach-action="${id}" ${disabled ? 'disabled' : ''}>${label}</button>`;
const coachLink = (id, label) => `<button type="button" class="btn primary" data-coach-node="${id}">${label}</button>`;


function coachRenderTree(batch) {
  const screened = batch.items.filter(i => i.rating).length;
  const skipped = batch.items.filter(i => i.rating === 'known').length;
  const start = (batch.groupPage || 0) * COACH_GROUP_PAGE;
  const groups = batch.groups.slice(start, start + COACH_GROUP_PAGE).map((group, offset) => {
    const index = start + offset;
    const id = `g${index}`;
    const nodes = Object.entries(coachLessonTitles).flatMap(([key, title]) => {
      const entry = group.entries?.[key];
      if (!entry) return [];
      const blind = coachLessonBlind(group);
      const past = blind && ['demo', 'guided', 'recall'].includes(key) && group.currentNode !== key;
      const children = entry.feedback ? [coachNode(`${id}:${key}:feedback`, '作答讲解', '', [], past)] : [];
      return [coachNode(`${id}:${key}`, title, '', children, past)];
    });
    const status = coachLessonResults[group.result] || (group.id ? '进行中' : '待开始');
    return coachNode(id, coachLessonBlind(group) ? `第 ${index + 1} 节微课` : group.title, `${group.words.length} 词 · ${status}`, nodes);
  });
  const children = [coachNode('screen', '熟悉度初筛', `${screened}/${batch.items.length}`)];
  if (skipped) children.push(coachNode('skipped', '本轮略过', `${skipped} 词`));
  if (batch.phase !== 'screen') children.push(coachNode('plan', '学习分组', batch.groups.length ? `${batch.groups.length} 组` : '待分组', groups));
  return `<ul class="coach-path">${coachNode('round', batch.sample ? '固定样课' : '本轮学习', `${batch.items.length} 词`, children)}</ul>`;
}

function coachSourceLabel(source) {
  return [{ exam: '真题', external: '外刊', corpus: '导入语料' }[source.sourceKind], source.title || source.publication, source.section, source.number].filter(Boolean).join(' · ');
}

function coachLessonMaterial(item, clue = '', note = '', sample = false, showSource = true) {
  if (!item.sentence) return '';
  const { source } = item;
  const label = source && showSource ? coachSourceLabel(source) : (source || item.material === 'corpus') ? '语料原句' : item.material === 'adaptation' ? '教学改编' : sample ? '固定样课语境' : 'AI 自拟语境';
  const sourceLink = showSource && source?.rid && ['exam', 'external', 'corpus'].includes(source.sourceKind) ?
    `<button type="button" class="btn small ghost" data-coach-rid="${esc(source.rid)}" data-coach-source-kind="${source.sourceKind}">查看出处</button>` : '';
  return `<div class="coach-source">${esc(label)}</div><div lang="en" class="coach-sentence">${coachMarkedSentence(item.sentence, clue)}</div>${note ? `<div class="coach-source">${coachInline(note)}</div>` : ''}${sourceLink}`;
}

function coachLessonAction(group, key, feedback) {
  if (group.currentNode !== key || coachFinished(group)) return '';
  if (feedback.status === 'pass') {
    const label = { guided: '收起讲解，开始回想', recall: '开始独立验证', transfer: '完成微课', retry: '完成微课' }[key];
    return coachAction('continue', label, true, group.busy);
  }
  if (key === 'retry') return coachAction('finish', '结束本轮', true, group.busy);
  return coachAction('retry', key === 'transfer' ? '换一段语境再试' : '重新说说你的判断', true, group.busy);
}

function renderCoachLesson(batch, group, index, key, viewingFeedback) {
  const root = `g${index}`;
  const entry = group.entries?.[key];
  if (!entry) return '';
  if (key === 'demo') {
    const { demo } = entry;
    return `<h3>老师示范</h3>${mdLite(group.objective)}${coachLessonMaterial(demo, demo.clue, '', batch.sample)}${mdLite(demo.translation)}${mdLite(demo.teaching)}
      <h4>教学改写</h4><div class="coach-contrast" lang="en">${demo.contrast.map(coachQuote).join('')}</div>${mdLite(demo.difference)}
      <h4>记住这条规则</h4>${mdLite(demo.rule)}<div class="coach-actions">${group.currentNode === 'demo' ? coachAction('continue', '我来辨别', true, group.busy) : coachLink(`${root}:${group.currentNode}`, '回到当前进度')}</div>`;
  }
  if (entry.feedback && viewingFeedback) {
    const f = entry.feedback;
    const score = (key === 'transfer' || key === 'retry') && f.status === 'pass' ? coachLessonResults[group.result] : f.status === 'pass' ? '判断有依据' : '补教';
    return `<h3>作答讲解 · ${score}</h3><h4>你的回答</h4>${mdLite(f.answer)}<h4>${f.status === 'pass' ? '老师反馈' : '老师补教'}</h4>${mdLite(f.coaching)}
      ${f.expected ? `<h4>参考判断</h4>${mdLite(f.expected)}` : ''}${f.translation ? `<h4>原文与译文</h4>${coachLessonMaterial({ ...entry.task, source: f.source }, f.clue, f.note, batch.sample)}${mdLite(f.translation)}` : ''}
      <div class="coach-actions">${coachLessonAction(group, key, f)}${coachFinished(group) ? coachLink(root, '回到本课') : ''}</div>`;
  }
  const { task } = entry;
  const previous = entry.feedback ? coachLink(`${root}:${key}:feedback`, '查看作答讲解') : '';
  const drafting = group.currentNode === key && !entry.feedback && !coachFinished(group);
  return `<h3>${coachLessonTitles[key]}</h3>${coachLessonMaterial(task, '', '', batch.sample, Boolean(entry.feedback))}${mdLite(task.question)}
    ${entry.hint ? `<div class="coach-lesson-hint"><h4>提示</h4>${mdLite(entry.hint)}</div>` : ''}
    ${drafting ? `<form class="coach-lesson-answer"><label for="coachAnswer">用自己的话作答</label><textarea id="coachAnswer" rows="3" maxlength="1500" required ${group.busy ? 'disabled' : ''}>${esc(entry.draft || '')}</textarea>
      <div class="coach-actions">${coachAction('submit-answer', '提交回答', true, group.busy)}${!entry.hint ? coachAction('hint', '给我一点提示', false, group.busy) : ''}</div></form>` : previous}
    ${entry.lastFeedback && drafting ? `<details class="coach-last-feedback"><summary>查看上次补教</summary>${mdLite(entry.lastFeedback.coaching)}</details>` : ''}`;
}

function renderCoachMap(focus = false) {
  const batch = coachBatch;
  $('#coachEmpty').hidden = !!batch;
  $('#coachWorkspace').hidden = !batch;
  $('#coachViews').hidden = !batch;
  $('#coachMapTools').hidden = !batch || coachView !== 'map';
  const detail = $('#coachDetail');
  if (!batch) { $('#coachTree').replaceChildren(); detail.replaceChildren(); $('#coachStatus').textContent = ''; return; }
  const tree = $('#coachTree');
  tree.dataset.view = coachView;
  for (const btn of $$('#coachViews [data-coach-view]')) btn.setAttribute('aria-pressed', String(btn.dataset.coachView === coachView));
  const left = tree.scrollLeft, top = tree.scrollTop;
  tree.innerHTML = coachRenderTree(batch);
  tree.style.setProperty('--coach-scale', coachScale);
  tree.scrollLeft = left;
  tree.scrollTop = top;
  const { group, index, key, feedback } = coachCurrentGroup();
  $('#coachStatus').textContent = batch.busy ? `正在分析词汇关系 · ${batch.plannedCount}/${batch.planTotal} 词` : group?.busy ? (group.id ? '正在处理本节微课…' : '正在准备微课…') : batch.sample ? '固定样课' : '';
  let content = '';
  if (batch.active === 'round') {
    content = `<h3>本轮学习</h3><p>${batch.items.length} 词 · ${batch.groups.filter(coachFinished).length}/${batch.groups.length} 组已完成</p>${coachLink(batch.phase === 'screen' ? 'screen' : 'plan', '继续学习')}${coachAction('pick', '打开词表')}`;
  } else if (batch.active === 'skipped') {
    const rows = batch.items.map((item, i) => item.rating === 'known' ? `<li><span>${coachInline(item.word)}</span><button type="button" class="btn ghost" data-coach-restore="${i}">拉回本轮</button></li>` : '').join('');
    content = `<h3>本轮略过</h3><ul class="coach-review-list">${rows || '<li>没有略过的词</li>'}</ul>${coachLink(batch.phase === 'screen' ? 'screen' : 'plan', '返回')}`;
  } else if (batch.active === 'screen') {
    const item = batch.items.find(i => !i.rating);
    if (!item) {
      const known = batch.items.filter(i => i.rating === 'known').length;
      content = `<h3>初筛完成</h3><p>保留 ${batch.items.length - known} 词，略过 ${known} 词。</p><div class="coach-actions">${known < batch.items.length && batch.phase === 'screen' ? coachAction('plan', batch.groups.length ? '继续分析剩余词' : '分析并分组', true, batch.busy) : ''}${known ? coachLink('skipped', '查看略过的词') : ''}${batch.phase === 'study' ? coachLink('plan', '查看学习分组') : ''}</div>`;
    } else {
      content = `<h3>回想词义 · ${batch.items.indexOf(item) + 1}/${batch.items.length}</h3><div class="coach-recall" lang="en">${coachInline(item.word)}</div>${item.revealed ? `<div class="coach-sentence">${mdLite(item.gloss || '暂无词表释义')}</div><div class="coach-actions">${coachAction('rate-known', '熟知')}${coachAction('rate-unclear', '模糊', true)}${coachAction('rate-unknown', '不会')}</div>` : coachAction('reveal', '揭晓释义', true)}`;
    }
  } else if (batch.active === 'plan') {
    const next = batch.groups.findIndex(g => !coachFinished(g));
    const page = batch.groupPage || 0, pages = Math.ceil(batch.groups.length / COACH_GROUP_PAGE);
    content = `<h3>学习分组</h3><p>${batch.groups.length} 组 · ${batch.groups.filter(coachFinished).length} 组完成</p>${pages > 1 ? `<div class="coach-actions coach-pages" aria-label="小组分页">${coachAction('prev-page', '上一页', false, page === 0)}<span>${page + 1}/${pages}</span>${coachAction('next-page', '下一页', false, page + 1 >= pages)}</div>` : ''}<div class="coach-actions">${next >= 0 ? coachLink(`g${next}`, '继续未完成小组') : ''}${!batch.planned ? coachAction('plan', batch.groups.length ? '继续分析剩余词' : '分析并分组', true, batch.busy) : ''}${!batch.planned && batch.error ? coachAction('singles', '剩余词暂时逐词练习') : ''}${batch.items.some(i => i.rating === 'known') ? coachLink('skipped', '查看略过的词') : ''}</div>`;
  } else if (group && key) {
    content = renderCoachLesson(batch, group, index, key, feedback);
  } else if (group) {
    const next = batch.groups.findIndex((g, i) => i !== index && !coachFinished(g));
    const id = `g${index}`;
    const blind = coachLessonBlind(group);
    const resume = group.currentNode;
    const suffix = group.entries?.[resume]?.feedback ? ':feedback' : '';
    content = `<h3>${blind ? '当前微课' : coachInline(group.title)}</h3>
      ${group.result ? `<p class="coach-lesson-result">${coachLessonResults[group.result]}</p>` : ''}
      ${!blind && !group.id && group.reason ? mdLite(group.reason) : ''}
      <div class="coach-actions">${group.id ? coachLink(`${id}:${resume}${suffix}`, coachFinished(group) ? '查看最后一次作答' : '继续微课') : coachAction('begin', '开始微课', true, group.busy)}
      ${next >= 0 && group.id ? coachLink(`g${next}`, '下一组') : ''}${batch.sample ? coachAction('sample', '重做样课') : coachLink('plan', '回到分组')}</div>`;
  }
  const error = group?.error || batch.error;
  detail.innerHTML = `${content}${error ? `<p class="coach-error" role="alert">${esc(error)}</p>` : ''}${group?.expired ? coachAction('begin', '重新开始本组', true, group.busy) : ''}`;
  if (focus) {
    detail.tabIndex = -1;
    detail.focus({ preventScroll: true });
    if (detail.getBoundingClientRect().top > innerHeight - 90) detail.scrollIntoView({ block: 'start' });
  }
}

function coachError(reason) {
  return ({ no_llm: '请在设置里配置 AI 服务商。', expired: '本节微课已过期，可以重新开始。', bad_lesson: '这次没有生成完整的微课，请重试。', bad_feedback: '暂时没能判断这份回答。你的答案已保留，可以再提交。', stale_lesson: '当前节点已经更新，请回到微课进度。', busy: '正在处理，请稍后再试。', bad_words: '部分词条格式暂不支持，请调整本轮勾选。' })[reason] || '暂时未能完成，请重试。';
}

async function planCoachBatch(singles = false) {
  const batch = coachBatch;
  const retained = batch.groups;
  const retainedWords = new Set(retained.flatMap(group => group.words.map(coachChoice)));
  const words = batch.items.filter(i => i.rating && i.rating !== 'known' && !retainedWords.has(coachChoice(i.word))).map(i => i.word);
  if (!words.length || batch.busy) return;
  batch.busy = true;
  batch.error = '';
  batch.phase = 'study';
  batch.active = 'plan';
  batch.folded.delete('plan');
  batch.folded.delete('round');
  batch.plannedCount = retainedWords.size;
  batch.planTotal = retainedWords.size + words.length;
  renderCoachMap();
  try {
    for (let start = 0; start < words.length; start += COACH_PLAN_CHUNK) {
      const chunk = words.slice(start, start + COACH_PLAN_CHUNK);
      const out = singles ? { ok: true, groups: chunk.map(word => ({ title: word, words: [word] })) } : await api('/api/tutor/map', { method: 'POST', body: { action: 'plan', words: chunk } });
      if (batch !== coachBatch) return;
      if (!out.ok) { batch.error = coachError(out.reason); return; }
      batch.groups.push(...out.groups);
      batch.plannedCount += chunk.length;
      if (!singles) renderCoachMap();
    }
    batch.planned = true;
  } catch (e) { batch.error = coachError(e.message); }
  finally { batch.busy = false; if (batch === coachBatch) renderCoachMap(true); }
}

function coachApplyLesson(group, out, move) {
  if (move === 'start') {
    group.id = out.roundId;
    group.objective = out.objective;
    group.entries = { demo: { demo: out.demo } };
    group.result = null;
    group.retried = false;
  }
  group.revision = out.revision;
  group.lessonStage = out.stage;
  group.result = out.result;
  if (out.stage === 'done') return;
  if (move === 'retry' && out.stage === 'transfer') group.retried = true;
  const key = out.stage === 'transfer' && group.retried ? 'retry' : out.stage;
  group.currentNode = key;
  if (out.task) {
    const entry = group.entries[key] ||= {};
    if (move === 'retry' && entry.feedback) {
      entry.lastFeedback = entry.feedback;
      entry.draft = '';
    }
    Object.assign(entry, { task: out.task, hint: out.hint, feedback: out.feedback });
  }
}

async function runCoachLesson(move) {
  const batch = coachBatch;
  const { group, index, key } = coachCurrentGroup();
  if (!group || group.busy || (move !== 'start' && group.currentNode !== key)) return;
  const entry = group.entries?.[key];
  const answer = move === 'answer' ? entry?.draft?.trim() : undefined;
  if (move === 'answer' && !answer) { $('#coachAnswer')?.focus(); return; }
  const id = `g${index}`;
  group.busy = true;
  group.error = '';
  group.expired = false;
  renderCoachMap();
  try {
    const body = move === 'start' ? { action: 'lesson', words: group.words, goal: [group.reason, group.exercise].filter(Boolean).join('；'), sample: batch.sample } :
      { action: 'lesson_turn', roundId: group.id, revision: group.revision, move, answer };
    const out = await api('/api/tutor/map', { method: 'POST', body });
    if (coachBatch !== batch || batch.groups[index] !== group) return;
    if (!out.ok) { group.expired = out.reason === 'expired'; group.error = coachError(out.reason); return; }
    coachApplyLesson(group, out, move);
    if (out.stage === 'done' && !batch.sample) {
      for (const word of group.words) {
        state.sessionWords.add(word);
        if (out.result === 'needs_work') state.sessionErrorWords.add(word);
      }
      updateSessionInfo();
    }
    if (coachCurrentGroup().group === group) {
      const current = group.currentNode;
      batch.active = out.stage === 'done' ? id : `${id}:${current}${out.feedback ? ':feedback' : ''}`;
      batch.folded.delete(id);
      batch.folded.delete(`${id}:${current}`);
    }
  } catch (e) { group.error = coachError(e.message); }
  finally {
    group.busy = false;
    if (batch === coachBatch) {
      renderCoachMap(coachCurrentGroup().group === group);
      if (['hint', 'retry'].includes(move) && !group.error) $('#coachAnswer')?.focus();
    }
  }
}

$('#coachDetail').addEventListener('input', e => {
  const { group, key } = coachCurrentGroup();
  if (e.target.id === 'coachAnswer' && group?.entries?.[key]) group.entries[key].draft = e.target.value;
});
$('#coachDetail').addEventListener('submit', e => {
  if (!e.target.matches('.coach-lesson-answer')) return;
  e.preventDefault();
  runCoachLesson('answer');
});

$('#coachScreenBtn').addEventListener('click', beginCoachScreen);
$('#coachClearBtn').addEventListener('click', () => { coachSelection.clear(); renderWordList(); });
$('#coachSelectAllBtn').addEventListener('click', () => {
  if (!wordResultReady() || !state.words.length) return;
  const clear = state.words.every(w => coachSelection.has(coachChoice(w.spelling)));
  for (const w of state.words) {
    const key = coachChoice(w.spelling);
    if (clear) coachSelection.delete(key);
    else if (!coachSelection.has(key)) coachSelection.set(key, { word: w.spelling, gloss: w.gloss?.gloss || '' });
  }
  renderWordList();
});
$('#coachMoreWords').addEventListener('click', () => { if (wordResultReady()) { wordVisibleCount += COACH_WORD_PAGE; renderWordList(); } });

const coachViewport = $('#coachTree');
function setCoachZoom(scale, x = coachViewport.clientWidth / 2, y = coachViewport.clientHeight / 2, anchorX = x, anchorY = y) {
  const next = Math.min(2, Math.max(.25, scale));
  const left = (coachViewport.scrollLeft + anchorX) / coachScale;
  const top = (coachViewport.scrollTop + anchorY) / coachScale;
  coachScale = next;
  coachViewport.style.setProperty('--coach-scale', next);
  $('#coachScale').textContent = `${Math.round(next * 100)}%`;
  coachViewport.scrollLeft = left * next - x;
  coachViewport.scrollTop = top * next - y;
}
let coachPinch = null;
// Native one-finger scrolling; intercept only a two-finger gesture inside the map.
coachViewport.addEventListener('touchmove', e => {
  if (coachView !== 'map' || e.touches.length !== 2 || !e.cancelable) return;
  e.preventDefault();
  const [a, b] = [e.touches[0], e.touches[1]], rect = coachViewport.getBoundingClientRect();
  const x = (a.clientX + b.clientX) / 2 - rect.left, y = (a.clientY + b.clientY) / 2 - rect.top;
  const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  if (coachPinch?.distance > 0) setCoachZoom(coachScale * distance / coachPinch.distance, x, y, coachPinch.x, coachPinch.y);
  coachPinch = { x, y, distance };
}, { passive: false });
for (const type of ['touchend', 'touchcancel']) coachViewport.addEventListener(type, () => { coachPinch = null; });
coachViewport.addEventListener('keydown', e => {
  if (coachView !== 'map' || !['+', '=', '-'].includes(e.key)) return;
  e.preventDefault();
  setCoachZoom(coachScale * (e.key === '-' ? .8 : 1.25));
});
$('#coachMap').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { coachAction: action, coachNode: node, coachView: view, coachFold: fold, coachRestore: restore } = btn.dataset;
  if (action === 'pick') { e.stopPropagation(); wordPanelOpen(true); return; }
  if (action === 'sample') { beginCoachSample(); return; }
  const batch = coachBatch;
  if (!batch) return;
  if (btn.dataset.coachRid) { switchTab('kb'); openKbRecord(btn.dataset.coachRid, btn.dataset.coachSourceKind); return; }
  const zoom = btn.dataset.coachZoom;
  if (zoom) {
    if (zoom === 'fit') {
      const path = coachViewport.querySelector('.coach-path');
      if (path) setCoachZoom(Math.min(1, (coachViewport.clientWidth - 10) * coachScale / path.getBoundingClientRect().width), 0, 0);
      coachViewport.scrollLeft = 0;
    } else setCoachZoom(coachScale * (zoom === 'in' ? 1.25 : .8));
    return;
  }
  if (action === 'prev-page' || action === 'next-page') {
    batch.groupPage = (batch.groupPage || 0) + (action === 'next-page' ? 1 : -1);
    coachViewport.scrollTo(0, 0);
    renderCoachMap();
    return;
  }
  if (view) { coachView = view; renderCoachMap(); return; }
  if (fold) { if (batch.folded.has(fold)) batch.folded.delete(fold); else batch.folded.add(fold); renderCoachMap(); [...$$('[data-coach-fold]')].find(b => b.dataset.coachFold === fold)?.focus(); return; }
  if (node) {
    batch.active = node;
    const parts = node.split(':');
    for (let i = 1; i <= parts.length; i++) batch.folded.delete(parts.slice(0, i).join(':'));
    if (node !== 'round') batch.folded.delete('round');
    if (/^g\d+$/.test(parts[0])) {
      batch.folded.delete('plan');
      batch.groupPage = Math.floor(Number(parts[0].slice(1)) / COACH_GROUP_PAGE);
    }
    renderCoachMap(true); return;
  }
  if (action === 'begin') { runCoachLesson('start'); return; }
  if (action === 'submit-answer') { btn.closest('form')?.requestSubmit(); return; }
  if (['continue', 'hint', 'retry', 'finish'].includes(action)) { runCoachLesson(action); return; }
  if (action === 'plan' || action === 'singles') { planCoachBatch(action === 'singles'); return; }
  if (restore !== undefined && !batch.busy && !batch.groups.some(g => g.busy)) {
    batch.items[Number(restore)].rating = 'unclear';
    batch.planned = false;
    batch.phase = 'screen';
    batch.active = 'screen';
    batch.error = '';
    renderCoachMap(true); return;
  }
  const item = batch.items.find(i => !i.rating);
  if (item && action === 'reveal') item.revealed = true;
  else if (item?.revealed && action?.startsWith('rate-')) item.rating = action.slice(5);
  else return;
  renderCoachMap(true);
});

/* ================= v2.4.0：词文成章 —— 选词生成记忆文章 ================= */

const storyState = {
  quick: 'today', theme: '随缘',
  length: 'short',     // v2.4.3：唯一写入来源=AI 分析采纳（篇幅 chips 已删除）
  pool: [],            // 已选词（小写）
  current: null,       // 当前文章对象
  hist: [],            // 历史列表
  analysis: null,      // v2.4.2: AI词汇分析建议缓存
};
const STORY_TIP = {
  vocab: '选词 · 初筛 · 语境辨析',
  story: '把选中的词写进一篇连贯短文：语境记忆 + 记忆钩子 + 检索自测，三管齐下',

};

async function switchStudySub(sub, { load = true } = {}) {
  $$('#studySubbar .study-sub-item').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  const vocab = $('#vocabPane'), story = $('#storyPane');
  if (vocab) vocab.style.display = sub === 'vocab' ? '' : 'none';
  if (story) story.style.display = sub === 'story' ? '' : 'none';
  const tip = $('#studySubTip');
  if (tip) tip.textContent = STORY_TIP[sub] || '';
  if (sub === 'story') {
    /* v2.4.1：首次进入词文成章时若无题材 chips，先拉取题材渲染（loadConfig 只在设置页触发） */
    if (!$('#storyThemeRow .chip')) {
      try {
        const cfg = await api('/api/config');
        state.storyThemes = Array.isArray(cfg.storyThemes) ? cfg.storyThemes : null;
      } catch { /* 题材拉取失败回退前端内置清单 */ }
      renderStoryThemeRow(state.storyThemes);
    }
    if (!storyState.hist.length) loadStoryHist();
  } else if (sub === 'writing') {
    wrtInitOnce();
    loadWrtHist();
  } else if (load) loadWords();
}

$$('#studySubbar .study-sub-item').forEach(b => b.addEventListener('click', () => switchStudySub(b.dataset.sub)));

/* 快选词源 → 按墨墨筛选口径拉词，整组全部加入词池（不限数量） */
$$('#storyQuickRow .chip').forEach(c => c.addEventListener('click', () => {
  $$('#storyQuickRow .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  storyState.quick = c.dataset.quick;
  storyQuickFill();
}));

/* v2.4.1：题材 chips 改为动态渲染（renderStoryThemeRow），静态绑定移除 */
/* v2.4.3：篇幅规格 chips 已删除——篇幅全权由 AI 分析建议约束（storyState.length 仅由采纳建议写入） */

async function storyQuickFill() {
  const out = $('#storyAnalyzeResult') || $('#storyGenResult');
  try {
    const chipText = $('#storyQuickRow .chip.active')?.textContent || '当前词源';
    if (out) {
      out.textContent = '⏳ 正在按「' + chipText + '」抓取所有词汇…';
      out.className = 'result';
    }
    const d = await api(`/api/words?filter=${storyState.quick}`);
    const list = (d.words || []).map(w => w.spelling.toLowerCase());
    if (!list.length) {
      if (out) {
        out.textContent = '⚠️ 该词源下暂无单词，请先在仪表盘同步或切换词源';
        out.className = 'result err';
      }
      return;
    }
    // v2.4.2：直接将该词源下的全部词汇与当前词池合并去重，不设数量截断
    const next = [...new Set([...storyState.pool, ...list])];
    const addedCount = next.length - storyState.pool.length;
    storyState.pool = next;
    renderStoryPool();
    // 词池变动后，重置分析状态
    resetStoryAnalysis();
    if (out) {
      out.textContent = `✅ 成功载入「${chipText}」：新加入 ${addedCount} 词，当前词池共 ${storyState.pool.length} 词`;
      out.className = 'result ok';
    }
  } catch (e) {
    if (out) {
      out.textContent = '❌ ' + e.message;
      out.className = 'result err';
    }
  }
}

function renderStoryPool() {
  const pool = $('#storyPool');
  const clearBtn = $('#storyPoolClear');
  if (!storyState.pool.length) {
    pool.innerHTML = '<div class="hint">词池为空，先快选或搜索加入</div>';
    if (clearBtn) clearBtn.style.display = 'none';
    $('#storyPoolCount').textContent = '(0)';
    return;
  }
  pool.innerHTML = storyState.pool.map(w =>
    `<span class="story-pool-word" data-pw="${esc(w)}">${esc(w)}<button class="story-pool-x" data-pwx="${esc(w)}" title="移除" type="button">✕</button></span>`
  ).join('');
  $('#storyPoolCount').textContent = `(${storyState.pool.length})`;
  if (clearBtn) clearBtn.style.display = '';
  $$('#storyPool [data-pwx]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    storyState.pool = storyState.pool.filter(w => w !== b.dataset.pwx);
    renderStoryPool();
  }));
}

$('#storyAddBtn').addEventListener('click', () => {
  const inp = $('#storySearch');
  const raw = (inp.value || '').trim();
  if (!raw) return;
  // v2.4.2：支持逗号/空格/分号批量粘贴，统一小写去重加入（不限数量）
  const tokens = raw.split(/[,，;；\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return;
  const bad = tokens.filter(w => !/^[a-z][a-z''\-]{0,39}$/.test(w));
  if (bad.length >= tokens.length) { toast('⚠️ 仅支持英文单词（字母/撇号/连字符）'); return; }
  if (bad.length) toast(`⚠️ 跳过 ${bad.length} 个非法词：${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`);
  const before = storyState.pool.length;
  storyState.pool = [...new Set([...storyState.pool, ...tokens.filter(w => /^[a-z][a-z''\-]{0,39}$/.test(w))])];
  const added = storyState.pool.length - before;
  inp.value = '';
  renderStoryPool();
  resetStoryAnalysis();
  if (added) toast(`➕ 新加 ${added} 词，词池共 ${storyState.pool.length} 词`);
  else toast('已在词池中');
});
$('#storySearch').addEventListener('keydown', e => { if (e.key === 'Enter') $('#storyAddBtn').click(); });
$('#storyPoolClear').addEventListener('click', () => {
  storyState.pool = [];
  renderStoryPool();
  resetStoryAnalysis();
});

/* ================= v2.4.2：AI 词汇分析与规划（两阶段工作流·步骤一） ================= */

function resetStoryAnalysis() {
  storyState.analysis = null;
  const box = $('#storyAnalysisBox');
  if (box) box.style.display = 'none';
}

async function analyzeStoryWords() {
  const btn = $('#storyAnalyzeBtn'), out = $('#storyAnalyzeResult');
  if (!storyState.pool.length) {
    out.textContent = '⚠️ 词池为空——先点击上方词源快速选词或手动加入';
    out.className = 'result err';
    return;
  }
  btn.disabled = true;
  out.textContent = `🤖 AI 正在分析 ${storyState.pool.length} 个词汇的语义关联与考研场景…（约 10-30 秒）`;
  out.className = 'result';
  try {
    const r = await api('/api/story/analyze', { method: 'POST', body: { words: storyState.pool } });
    storyState.analysis = r.analysis || null;
    renderStoryAnalysis(storyState.analysis);
    out.textContent = '✅ 分析完成——请查阅建议并采纳，或手动微调下方参数';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ 分析失败：' + e.message;
    out.className = 'result err';
  } finally {
    btn.disabled = false;
  }
}
$('#storyAnalyzeBtn').addEventListener('click', analyzeStoryWords);

/** 渲染 AI 分析建议 */
function renderStoryAnalysis(a) {
  if (!a) return;
  const box = $('#storyAnalysisBox');
  if (!box) return;
  box.style.display = '';
  $('#storyAnalysisSummary').textContent = '💡 ' + (a.summary || '（无整体分析）');
  $('#storyLenRec').innerHTML =
    `<b>${esc(a.lengthLabel || '自适应篇幅')}</b>` +
    (a.lengthReason ? `<div style="margin-top:4px">${esc(a.lengthReason)}</div>` : '');
  const groups = Array.isArray(a.groups) ? a.groups : [];
  $('#storyGroupsList').innerHTML = groups.map(g => `
    <div class="story-group-item">
      <div class="story-group-title">🧩 ${esc(g.name || '未命名组')} <span class="story-hist-meta">题材建议：${esc(g.theme || '随缘')}</span></div>
      <div class="story-group-words">${esc((g.words || []).join(', '))}</div>
      <div class="story-group-plot">📖 ${esc(g.suggestedPlot || '')}</div>
    </div>`).join('') || '<div class="hint">无分组建议</div>';
}

/** 一键采纳：篇幅写入 storyState（v2.4.3 篇幅已无 chips，全权由 AI 建议约束）；题材按首选分组建议映射 */
$('#storyAdoptAdviceBtn').addEventListener('click', () => {
  const a = storyState.analysis;
  if (!a) { toast('⚠️ 请先完成分析'); return; }
  // 篇幅采纳（唯一来源：AI 建议）
  const lenKey = ['short', 'medium', 'long'].includes(a.recommendedLength) ? a.recommendedLength : null;
  if (lenKey) storyState.length = lenKey;
  // 题材采纳：第一个分组的 theme 与题材清单做包含匹配（如“校园/科技”→“校园”）
  const row = $('#storyThemeRow');
  const chips = row ? $$('#storyThemeRow .chip') : [];
  const suggested = (Array.isArray(a.groups) && a.groups[0] && a.groups[0].theme) || '';
  let matched = null;
  if (suggested) {
    for (const c of chips) {
      const t = c.dataset.theme || c.textContent.trim();
      if (suggested.includes(t) || (t && t.includes(suggested.split(/[\/／]/)[0].trim()))) { matched = c; break; }
    }
  }
  if (matched) {
    chips.forEach(x => x.classList.remove('active'));
    matched.classList.add('active');
    storyState.theme = matched.dataset.theme || matched.textContent.trim();
  }
  toast(`✅ 已采纳：篇幅=${lenKey || storyState.length}，题材=${storyState.theme}`);
});

/* 生成文章（v2.4.3：按 AI 分组逐篇生成，一次多篇；篇幅全权来自分析建议） */
async function generateStory() {
  const btn = $('#storyGenBtn'), out = $('#storyGenResult');
  if (storyState.pool.length < 1) {
    out.textContent = '⚠️ 词池为空，先点击上方词源快速选词';
    out.className = 'result err';
    return;
  }
  if (!storyState.analysis) {
    out.textContent = '⚠️ 请先完成「步骤一：AI 分析」——篇幅与分组由分析建议全权约束';
    out.className = 'result err';
    return;
  }
  btn.disabled = true;
  const a = storyState.analysis;
  const lenLabel = ({ short: '短篇', medium: '中篇', long: '长篇' })[storyState.length] || '短篇';
  const userInstruction = (a.summary || '') + (Array.isArray(a.groups) && a.groups.length ? ' 分组建议：' + a.groups.map(g => `${g.name}(${(g.words || []).length}词,${g.theme || ''}):${g.suggestedPlot || ''}`).join('；') : '');
  // v2.4.3：分组 ≥2 时按分组逐篇生成；否则全词池单篇
  const groups = (Array.isArray(a.groups) && a.groups.length >= 2)
    ? a.groups.map(g => ({ name: g.name || '', theme: g.theme || '', words: g.words || [], suggestedPlot: g.suggestedPlot || '' }))
    : [];
  const useGroups = groups.length >= 2 && groups.reduce((n, g) => n + g.words.length, 0) > 0;
  const totalPieces = useGroups ? groups.length : 1;
  out.textContent = useGroups
    ? `✨ AI 正在按 ${totalPieces} 个分组逐篇创作（0/${totalPieces}）…每篇约 20-60 秒`
    : `✨ AI 正在把 ${storyState.pool.length} 个词写进${storyState.theme}故事…（约 10-60 秒）`;
  out.className = 'result';
  try {
    const r = await api('/api/story/generate', {
      method: 'POST',
      body: {
        words: storyState.pool,
        groups: useGroups ? groups : undefined,
        theme: storyState.theme,
        length: storyState.length,
        lengthLabel: lenLabel,
        userInstruction,
      },
    });
    const stories = r.stories || (r.story ? [r.story] : []);
    const partialNote = r.partial ? `（${r.failed ? '「' + r.failed.group + '」失败：' + r.failed.error : ''}）` : '';
    out.textContent = `✅ 生成完成：共 ${stories.length} 篇${partialNote}`;
    out.className = 'result ok';
    if (stories.length) renderStory(stories[0]);
    loadStoryHist();
    // 折叠生成参数卡与选词卡，突出文章成果
    collapseCard('#storyParamBody', true);
    collapseCard('#storySelectBody', true);
    expandCard('#storyResultBody');
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  } finally {
    btn.disabled = false;
  }
}
$('#storyGenBtn').addEventListener('click', generateStory);

/** 高亮正文中的目标词（含基本变形）：整词匹配加粗 */
function highlightStoryWords(passage, words) {
  let html = esc(passage);
  const pats = words
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .map(w => `\\b${w}(?:s|es|ed|d|ing|ly)?\\b`)
    .sort((a, b) => b.length - a.length);
  for (const p of pats) {
    html = html.replace(new RegExp(p, 'gi'), m => `<b class="story-word" data-sw="${esc(m.toLowerCase())}">${m}</b>`);
  }
  return html.replace(/\n/g, '<br>');
}

function renderStory(s) {
  storyState.current = s;
  $('#storyResultCard').style.display = '';
  // v2.4.3：完成态徽章——done=true 绿色已完成 / false 黄色待做
  const badge = s.done ? '<span class="story-done-badge ok">✅ 已完成</span>' : '<span class="story-done-badge todo">📝 待做</span>';
  $('#storyTitle').innerHTML = `📖 ${esc(s.title)}（${esc(s.theme)} · ${s.words.length} 词）${badge}`;
  $('#storyPassage').innerHTML = highlightStoryWords(s.passage, s.words);
  $('#storyTranslation').textContent = s.translation || '（无翻译）';
  $('#storyHooks').innerHTML = (s.hooks || []).map(h => `
    <div class="story-hook">
      <b class="story-hook-word" data-sw="${esc(h.word.toLowerCase())}">${esc(h.word)}</b>
      <span class="story-hook-meta">${esc(h.phonetic || '')} ${esc(h.pos || '')}</span>
      <span class="story-hook-meaning">${esc(h.meaning || '')}</span>
      <button class="speak-btn mini story-hook-speak" data-spw="${esc(h.word)}" title="朗读">🔊</button>
      <div class="story-hook-line">🪝 ${esc(h.hook || '')}</div>
    </div>`).join('') || '<div class="hint">无钩子数据</div>';
  $$('#storyHooks [data-spw]').forEach(b => b.addEventListener('click', () => speak(b.dataset.spw)));
  renderStoryQuiz(s);
  $('#storyResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* 检索自测渲染与判分（v2.4.3：题数不限，全部作答后文章置「已完成」） */
function renderStoryQuiz(s) {
  const box = $('#storyQuiz'), res = $('#storyQuizResult');
  res.textContent = '';
  res.className = 'result';
  box.innerHTML = (s.quiz || []).map((q, i) => `
    <div class="story-quiz-item" data-qi="${i}">
      <div class="story-quiz-q">${i + 1}. ${esc(q.q)}</div>
      <div class="story-quiz-opts">${(q.options || []).map((o, j) =>
        `<button class="story-quiz-opt" data-qi="${i}" data-oj="${j + 1}" type="button">${'ABCD'[j]}. ${esc(o)}</button>`).join('')}</div>
    </div>`).join('') || '<div class="hint">无自测题</div>';
  const answers = (s.quiz || []).map(q => q.answer);
  const picked = {};
  let completedReported = false;
  $$('#storyQuiz .story-quiz-opt').forEach(b => b.addEventListener('click', () => {
    const qi = Number(b.dataset.qi), oj = Number(b.dataset.oj);
    if (picked[qi] !== undefined) return;   // 每题只答一次
    picked[qi] = oj;
    const correct = answers[qi] === oj;
    b.classList.add(correct ? 'correct' : 'wrong');
    if (!correct) {
      const opts = $$('#storyQuiz [data-qi="' + qi + '"] .story-quiz-opt');
      (opts.find ? opts.find(x => Number(x.dataset.oj) === answers[qi]) : opts.filter(x => Number(x.dataset.oj) === answers[qi])[0])?.classList.add('correct');
    }
    const done = Object.keys(picked).length;
    const right = Object.keys(picked).filter(k => picked[k] === answers[k]).length;
    res.textContent = `📊 已答 ${done}/${answers.length}，答对 ${right} 题`;
    res.className = 'result ' + (done === answers.length ? (right >= answers.length - 1 ? 'ok' : 'warn') : '');
    // v2.4.3：全部作答 → 上报完成态，标题徽章切换为绿色「已完成」
    if (done === answers.length && !completedReported && s.id) {
      completedReported = true;
      api(`/api/story/${s.id}/done`, { method: 'POST' })
        .then(() => {
          if (storyState.current && storyState.current.id === s.id) storyState.current.done = true;
          const badge = $('#storyTitle .story-done-badge');
          if (badge) { badge.textContent = '✅ 已完成'; badge.className = 'story-done-badge ok'; }
          toast('🎉 自测完成，文章已标记「已完成」');
          loadStoryHist();
        })
        .catch(() => {});
    }
  }));
}

/* 点词查义（正文加粗词/钩子词）：本地释义缓存优先，悬停小提示 + 朗读 */
document.addEventListener('click', e => {
  const w = e.target.closest('.story-word, .story-hook-word');
  if (!w) return;
  const word = w.dataset.sw || w.textContent.trim();
  speak(word);
  api('/api/gloss', { method: 'POST', body: { spellings: [word] } })
    .then(r => {
      const g = r.glosses?.[word];
      toast(g ? `📘 ${word} ${g.phonetic || ''} ${g.pos || ''} ${g.gloss || ''}` : '📘 ' + word + '（暂无释义缓存）');
    })
    .catch(() => {});
});

$('#storySpeakBtn').addEventListener('click', () => {
  const s = storyState.current;
  if (!s) return;
  speakEnglishFrom(s.passage, s.words[0]);
});
$('#storyCopyBtn').addEventListener('click', async () => {
  const s = storyState.current;
  if (!s) return;
  try {
    const hooks = (s.hooks || []).map(h => `- ${h.word} ${h.pos || ''} ${h.meaning || ''}｜钩子：${h.hook || ''}`).join('\n');
    const ok = await copyText(`${s.title}\n\n${s.passage}\n\n【词汇钩子】\n${hooks}\n\n【译文】\n${s.translation || ''}`);
    toast(ok ? '📋 已复制全文+钩子' : '❌ 复制失败，请长按选中文章正文手动复制');
  } catch { toast('复制失败'); }
});
$('#storyDelBtn').addEventListener('click', async () => {
  const s = storyState.current;
  if (!s) return;
  if (!confirm('删除这篇文章？')) return;
  try {
    await api('/api/story/' + s.id, { method: 'DELETE' });
    $('#storyResultCard').style.display = 'none';
    storyState.current = null;
    toast('🗑 已删除');
    loadStoryHist();
  } catch (e) { toast('❌ ' + e.message); }
});

/* 历史文章列表与回看 */
async function loadStoryHist() {
  try {
    const d = await api('/api/story/list');
    storyState.hist = d.list || [];
    const box = $('#storyHistList');
    if (!storyState.hist.length) {
      box.innerHTML = '<div class="hint">还没有生成过文章</div>';
      return;
    }
    box.innerHTML = storyState.hist.map(s => `
      <div class="story-hist-item${s.done ? ' done' : ''}" data-sid="${esc(s.id)}">
        <div class="story-hist-main">
          <b>${esc(s.title)}</b>
          <span class="story-hist-meta">${esc(s.theme)} · ${s.words.length} 词 · ${s.quizCount || 0} 题 · ${fmtBJ(s.createdAt)}</span>
          <span class="story-hist-words">${esc(s.words.slice(0, 8).join(', '))}${s.words.length > 8 ? '…' : ''}</span>
        </div>
        <span class="story-done-badge ${s.done ? 'ok' : 'todo'}">${s.done ? '✅ 已完成' : '📝 待做'}</span>
        <button class="btn small" data-sload="${esc(s.id)}">查看</button>
      </div>`).join('');
    $$('#storyHistList [data-sload]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await api('/api/story/' + b.dataset.sload);
        renderStory(r.story);
      } catch (e) { toast('❌ ' + e.message); }
    }));
  } catch (e) {
    $('#storyHistList').innerHTML = `<div class="result err">加载失败: ${esc(e.message)}</div>`;
  }
}
$('#storyHistRefresh').addEventListener('click', loadStoryHist);

$('#storyRegenBtn').addEventListener('click', generateStory);



/* v1.2.0：聊天记录自动持久化 —— 每次 AI 回复后自动保存到服务端 */
const _chatSaveTimer = { t: null };
function autoSaveChat() {
  clearTimeout(_chatSaveTimer.t);
  _chatSaveTimer.t = setTimeout(() => {
    if (state.chatHistory.length < 2) return;   // 至少一问一答才保存
    const title = state.activeWord
      ? `学习：${state.activeWord}`
      : (state.chatHistory.find(m => m.role === 'user')?.content?.slice(0, 30) || '对话');
    api('/api/chat/save', {
      method: 'POST',
      body: {
        id: state.chatSessionId,
        title,
        messages: state.chatHistory,
        createdAt: state.sessionStartedAt,
      },
    }).then(r => {
      if (r.id && !state.chatSessionId) state.chatSessionId = r.id;
    }).catch(() => { /* 保存失败静默 */ });
  }, 1500);   // 防抖 1.5s
}

/* v1.2.0：聊天历史面板 —— 查看/搜索/加载/删除历史对话 */
async function loadChatHistoryPanel() {
  const panel = $('#chatHistoryPanel');
  if (!panel) return;
  const q = $('#chatHistorySearch')?.value?.trim() || '';
  panel.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const d = await api('/api/chat/history' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!d.total) {
      panel.innerHTML = '<div class="empty">暂无历史对话' + (q ? '（试试其他搜索词）' : '') + '</div>';
      return;
    }
    let html = '';
    const days = Object.keys(d.groups).sort().reverse();
    for (const day of days) {
      const items = d.groups[day];
      html += `<div class="ch-day-header">${day === bjDate() ? '今天' : day}</div>`;
      for (const s of items) {
        const wordTags = (s.words || []).slice(0, 5).map(w => `<span class="tag type">${esc(w)}</span>`).join(' ');
        html += `<div class="ch-item" data-sid="${esc(s.id)}">
          <div class="ch-item-head">
            <b>${esc(s.title)}</b>
            <span class="ch-meta">${s.msgCount} 条消息 · ${fmtBJ(s.updatedAt || s.createdAt)}</span>
          </div>
          <div class="ch-words">${wordTags}</div>
          ${s.preview ? `<div class="ch-preview">${esc(s.preview)}</div>` : ''}
          <div class="ch-actions">
            <button class="btn small" data-load-chat="${esc(s.id)}">加载对话</button>
            <button class="btn small danger" data-del-chat="${esc(s.id)}">删除</button>
          </div>
        </div>`;
      }
    }
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function loadChatSession(id) {
  try {
    const d = await api(`/api/chat/session/${id}`);
    const s = d.session;
    // 恢复到当前聊天
    state.chatHistory = s.messages || [];
    state.chatSessionId = s.id;
    state.sessionStartedAt = s.createdAt;
    state.sessionWords = new Set(s.words || []);
    state.sessionErrorWords.clear();
    // 渲染消息
    const box = $('#chatMessages');
    box.innerHTML = '';
    for (const m of state.chatHistory) {
      addMsg(m.role === 'assistant' ? 'ai' : m.role, m.content, m.word);
    }
    if (s.words?.length) {
      state.activeWord = s.words[s.words.length - 1];
      $('#chatHeader').textContent = '当前学习：' + state.activeWord;
      $('#speakWordBtn').style.display = 'inline-block';
    }
    updateSessionInfo();
    // 切回聊天页
    if ($('#chatHistoryOverlay')) $('#chatHistoryOverlay').style.display = 'none';
  } catch (e) {
    alert('加载会话失败：' + e.message);
  }
}

async function deleteChatSession(id) {
  if (!confirm('确定删除这条聊天记录？')) return;
  try {
    await api(`/api/chat/session/${id}`, { method: 'DELETE' });
    loadChatHistoryPanel();
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

// 事件委托：聊天历史面板
document.addEventListener('click', (e) => {
  const loadBtn = e.target.closest('[data-load-chat]');
  if (loadBtn) { loadChatSession(loadBtn.dataset.loadChat); return; }
  const delBtn = e.target.closest('[data-del-chat]');
  if (delBtn) { deleteChatSession(delBtn.dataset.delChat); return; }
});

/* 结束会话 -> 生成助记 */
$('#finishBtn').addEventListener('click', async () => {
  if (!state.sessionWords.size) return;
  const btn = $('#finishBtn');
  btn.disabled = true;
  btn.textContent = '🤖 AI 正在总结助记…';
  try {
    const r = await api('/api/session/finish', {
      method: 'POST',
      body: {
        startedAt: state.sessionStartedAt,
        endedAt: new Date().toISOString(),
        words: [...state.sessionWords],
        errorWords: [...state.sessionErrorWords],
        messages: state.chatHistory,
      },
    });
    addMsg('ai', `🎉 本次学习结束！已为你生成 **${r.saved}** 条个性化助记，可在「助记库」查看并推送到墨墨 App。\n\n` +
      r.notes.map(n => `**${n.spelling}**（${n.noteType}）：${n.content}`).join('\n\n'));
    // 重置会话
    state.sessionWords.clear();
    state.sessionErrorWords.clear();
    state.chatHistory = [];
    state.chatSessionId = null;   // v1.2.0：重置持久化 id
    state.sessionStartedAt = new Date().toISOString();
    updateSessionInfo();
    btn.textContent = '✅ 结束本次学习并生成助记';
  } catch (e) {
    alert('生成助记失败：' + e.message);
    btn.textContent = '✅ 结束本次学习并生成助记';
    btn.disabled = state.sessionWords.size === 0;
  }
});

/* ---------------- 助记库 ---------------- */

async function loadNotes() {
  try {
    const q = $('#noteSearch').value.trim();
    const d = await api('/api/notes' + (q ? '?q=' + encodeURIComponent(q) : ''));
    $('#notesCount').textContent = d.notes.length;
    const list = $('#notesList');
    if (!d.notes.length) {
      list.innerHTML = '<div class="empty">还没有助记。去「AI 学习」页学习几个单词，结束后会自动生成。</div>';
      return;
    }
    list.innerHTML = d.notes.map(n => `
      <div class="note-item">
        <div class="note-word">${esc(n.spelling)}<small>${esc(n.source)} · ${fmtBJ(n.createdAt)}</small></div>
        <div class="note-body">
          <span class="tag type">${esc(n.noteType)}</span>
          <span class="tag ${n.synced ? 'synced' : 'pending'}">${n.synced ? '已推送墨墨' : '待推送'}</span>
          ${n.pushError ? `<div class="hint" style="margin:0;color:var(--warn)">${esc(n.pushError)}</div>` : ''}
          <div>${esc(n.content)}</div>
        </div>
        <div class="note-actions">
          ${n.synced ? '' : `<button class="btn small" data-push="${n.id}">推送到墨墨</button>`}
          <button class="btn small danger" data-del="${n.id}">删除</button>
        </div>
      </div>`).join('');

    $$('[data-push]').forEach(b => b.addEventListener('click', () => pushNote(b.dataset.push)));
    $$('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('确定删除这条助记？（本地删除，不影响墨墨 App 中已推送的）')) return;
      await api('/api/notes/' + b.dataset.del, { method: 'DELETE' });
      loadNotes();
    }));
  } catch (e) {
    $('#notesList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

$('#noteSearch').addEventListener('input', debounce(loadNotes, 300));

async function pushNote(id) {
  try {
    await api(`/api/notes/${id}/push`, { method: 'POST' });
    loadNotes();
  } catch (e) {
    alert('推送失败：' + e.message);
    loadNotes();
  }
}

/* 手动添加助记弹层 */
$('#addNoteBtn').addEventListener('click', () => {
  $('#noteModalTitle').textContent = '添加助记';
  $('#noteModalWord').value = state.activeWord || '';
  $('#noteModalContent').value = '';
  $('#noteModal').style.display = 'flex';
});
$('#noteModalCancel').addEventListener('click', () => $('#noteModal').style.display = 'none');
$('#noteModalSave').addEventListener('click', async () => {
  const word = $('#noteModalWord').value.trim();
  const content = $('#noteModalContent').value.trim();
  if (!word || !content) return alert('单词和内容都要填哦');
  try {
    await api('/api/notes', { method: 'POST', body: { spelling: word, noteType: $('#noteModalType').value, content } });
    $('#noteModal').style.display = 'none';
    loadNotes();
  } catch (e) { alert(e.message); }
});

/* ---------------- 主题（黑夜模式） ---------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = $('#themeToggle');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
  const mBtn = $('#mobileThemeToggle');
  if (mBtn) mBtn.textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('wb-theme', t);
  updateThemeColor();
}

$('#themeToggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ---------------- 界面风格（v4.5.0：只保留晨雾） ---------------- */

function updateThemeColor() {
  const theme = document.documentElement.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#111316' : '#f1ede6';
}

function applyStyle() {
  document.documentElement.dataset.style = 'mist';
  try { localStorage.removeItem('wb-style'); } catch (error) { /* 旧设备迁移，忽略隐私模式报错 */ }
  updateThemeColor();
  // 晨雾专属的功能壳（设置横列导航 / 首页时段）在初始化时重建
  setTimeout(() => { try { refreshMistSettingsNav(); mistApplyPhase(); } catch (error) { console.debug(error); } }, 0);
}

/* ---------------- 设置页 ---------------- */

let provPresets = {};

async function loadConfig() {
  try {
    const c = await api('/api/config');
    provPresets = c.presets || {};
    state.providers = c.llm.providers || [];
    state.activeProvId = c.llm.activeId;
    $('#provPreset').innerHTML = '<option value="">— 选择服务商 —</option>' +
      Object.entries(provPresets).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    $('#cfgMock').checked = !!c.llm.mock;
    if (c.hasToken) $('#cfgToken').placeholder = c.maimemoToken;
    $('#cfgAutoSync').checked = !!c.autoSync.enabled;
    $('#cfgSyncMinutes').value = c.autoSync.minutes || 60;
    /* v2.1.0：DIY 模型提示词注册表回填 */
    if (c.diyPrompts) {
      state.diyPrompts = c.diyPrompts;
      renderPromptRegistry();
    }
    /* v1.0.7：搜索服务配置回填 */
    if (c.searchPresets) {
      $('#cfgSearchPreset').innerHTML = '<option value="">— 手动填写 —</option>' +
        Object.entries(c.searchPresets).map(([k, v]) => `<option value="${esc(v.url)}">${esc(v.label)}</option>`).join('');
    }
    $('#cfgSearchUrl').value = c.webSearch?.url || '';
    if (c.webSearch?.hasKey) $('#cfgSearchKey').placeholder = '已保存 ✓（留空 = 沿用）';
    /* v1.0.8：韦氏词典 Key 状态提示 */
    if (c.dict?.hasLearners) $('#cfgDictLearners').placeholder = '已保存 ✓（留空 = 沿用）';
    if (c.mineru?.hasKey) $('#cfgMineruKey').placeholder = '已保存 ✓（留空 = 沿用）';
    if (c.dict?.hasCollegiate) $('#cfgDictCollegiate').placeholder = '已保存 ✓（留空 = 沿用）';
    /* v3.5.0：发音朗读默认口音与服务端语音能力 */
    if (c.tts) {
      ttsServerAccent = c.tts.accent === 'en_GB' ? 'en_GB' : 'en_US';
      renderTtsSettings(c.tts);
    }
    /* v2.0.0.a：云词库回填与长期绑定状态持久化显示 */
    if (c.maimemoNotepadId) {
      const title = c.notepadTitle || '已绑定云词库';
      $('#cfgNotepad').innerHTML = `<option value="${esc(c.maimemoNotepadId)}" selected>${esc(title)}</option>`;
      $('#notepadResult').textContent = `✅ 当前已稳定绑定：${title}`;
      $('#notepadResult').className = 'result ok';
    } else {
      $('#cfgNotepad').innerHTML = '<option value="">— 未绑定 —</option>';
      $('#notepadResult').textContent = '';
      $('#notepadResult').className = 'result';
    }
    /* v1.1.7：AI 审核专用服务商回填 + v2.3.4：划词助手专用模型回填 */
    if (c.review) {
      const revSel = $('#cfgReviewProvider');
      if (revSel) {
        revSel.innerHTML = '<option value="">— 同默认服务商 —</option>' +
          (c.llm.providers || []).map(p => `<option value="${esc(p.id)}"${p.id === c.review.providerId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
      }
      const revModel = $('#cfgReviewModel');
      if (revModel) revModel.value = c.review.model || '';
      /* v2.4.1：审核专项「启用深度思考」开关已删除（统一收敛到服务商档案思考等级），不再回填 */
    }
    if (c.selection) {
      const selSel = $('#cfgSelectionProvider');
      if (selSel) {
        selSel.innerHTML = '<option value="">— 同默认服务商 —</option>' +
          (c.llm.providers || []).map(p => `<option value="${esc(p.id)}"${p.id === c.selection.providerId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
      }
      const selModel = $('#cfgSelectionModel');
      if (selModel) selModel.value = c.selection.model || '';
    }
    /* v2.4.1：词文成章专用模型回填 + DIY 文章题材编辑器回填 */
    if (c.story) {
      const storySel = $('#cfgStoryProvider');
      if (storySel) {
        storySel.innerHTML = '<option value="">— 同默认服务商 —</option>' +
          (c.llm.providers || []).map(p => `<option value="${esc(p.id)}"${p.id === c.story.providerId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
      }
      const storyModel = $('#cfgStoryModel');
      if (storyModel) storyModel.value = c.story.model || '';
    }
    state.storyThemes = Array.isArray(c.storyThemes) ? c.storyThemes : null;   // null = 内置默认
    renderStoryThemesEditor();
    renderStoryThemeRow(state.storyThemes);
    /* v2.8.0：Token 凭证登录配置回填 */
    if (c.auth) {
      const en = $('#cfgAuthEnabled');
      if (en) en.checked = !!c.auth.enabled;
      const tok = $('#cfgAuthToken');
      if (tok) tok.placeholder = c.auth.hasToken ? '已保存 ✓（留空 = 沿用）' : '尚未设置，请填写 Token 凭证';
      const st = $('#authCfgState');
      if (st) st.textContent = c.auth.enabled
        ? (c.auth.hasToken ? '✅ 已开启（访问需登录）' : '⚠️ 已开启但未设置 Token')
        : '🔓 未开启（无需登录）';
    }
    renderProviders();
    refreshVisionUI();   // v2.3.4：默认服务商视觉能力变化后同步图片按钮显隐
  } catch (e) { console.error(e); }
}

function renderProviders() {
  const list = $('#provList');
  if (!state.providers.length) {
    list.innerHTML = '<div class="empty-prov">还没有服务商，点右上角「＋ 添加服务商」</div>';
    return;
  }
  list.innerHTML = state.providers.map(p => `
    <div class="prov-item">
      <div class="prov-info">
        <div class="prov-name">${esc(p.name)} ${p.id === state.activeProvId ? '<span class="tag active">⭐ 默认</span>' : ''}</div>
        <div class="prov-meta">${esc(p.baseUrl || '未填 Base URL')} · ${esc(p.model || '未选模型')} · ${p.hasKey ? '🔑 已存 Key' : '⚠️ 无 Key'}${p.vision ? ' · <span class="prov-tag-mini">👁️ 视觉</span>' : ''}${p.thinking && p.thinking !== 'off' ? ` · <span class="prov-tag-mini">🧠 ${esc((THINK_META[p.thinking] || [p.thinking])[0])}</span>` : ''}${p.extraBody ? ' · <span class="prov-tag-mini">🔧 JSON</span>' : ''}</div>
      </div>
      <div class="prov-actions">
        ${p.id === state.activeProvId ? '' : `<button class="btn small" data-prov-active="${p.id}">设为默认</button>`}
        <button class="btn small" data-prov-test="${p.id}">测试</button>
        <button class="btn small" data-prov-edit="${p.id}">编辑</button>
        <button class="btn small danger" data-prov-del="${p.id}">删除</button>
      </div>
    </div>`).join('');

  $$('[data-prov-active]').forEach(b => b.addEventListener('click', () => setDefaultProvider(b.dataset.provActive)));
  $$('[data-prov-test]').forEach(b => b.addEventListener('click', () => testProvider(b.dataset.provTest, b)));
  $$('[data-prov-edit]').forEach(b => b.addEventListener('click', () => openProvModal(b.dataset.provEdit)));
  $$('[data-prov-del]').forEach(b => b.addEventListener('click', () => deleteProvider(b.dataset.provDel)));
}

async function saveProviders(providers) {
  await api('/api/config', { method: 'POST', body: { llm: { providers } } });
  await loadConfig();
}

/* v2.1.0：DIY 模型提示词注册表渲染 */
function renderPromptRegistry() {
  const box = $('#promptRegistry');
  if (!box) return;
  const entries = Object.entries(state.diyPrompts || {});
  if (!entries.length) {
    box.innerHTML = '<div class="hint">暂无可配置的提示词。</div>';
    return;
  }
  box.innerHTML = entries.map(([key, p]) => {
    const cur = p.current || p.template || '';
    const isCustom = p.current && p.current !== p.template;
    const history = Array.isArray(p.history) ? p.history : [];
    const historyHtml = history.length
      ? `<details class="prompt-history"><summary class="prompt-history-title">🕘 最近 ${history.length} 条历史版本</summary>` +
        history.map(h => `<div class="prompt-history-entry"><span class="ph-time">${esc(fmtBJ(h.time))}</span>${esc(String(h.text || '').slice(0, 400))}</div>`).join('') +
        '</details>'
      : '';
    return `
      <div class="prompt-item" data-pkey="${esc(key)}">
        <div class="prompt-item-head">
          <div>
            <span class="prompt-item-title">${esc(p.title || key)}</span>
            <span class="prompt-item-index">${esc(p.id || key)}</span>
          </div>
          ${isCustom ? '<span class="badge kb-badge-year">已自定义</span>' : '<span class="badge">默认</span>'}
        </div>
        <div class="prompt-item-desc">${esc(p.desc || '')}</div>
        <textarea data-prompt-text="${esc(key)}">${esc(cur)}</textarea>
        <div class="prompt-item-actions">
          <button class="btn small primary" data-prompt-save="${esc(key)}">💾 保存</button>
          <button class="btn small" data-prompt-preview="${esc(key)}">👀 预览默认</button>
          <button class="btn small ghost" data-prompt-reset="${esc(key)}">↺ 恢复默认</button>
          <span class="result" id="promptResult-${esc(key)}"></span>
        </div>
        ${historyHtml}
      </div>`;
  }).join('');

  $$('[data-prompt-save]').forEach(b => b.addEventListener('click', () => savePrompt(b.dataset.promptSave)));
  $$('[data-prompt-reset]').forEach(b => b.addEventListener('click', () => resetPrompt(b.dataset.promptReset)));
  $$('[data-prompt-preview]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.promptPreview;
    const p = state.diyPrompts[key];
    alert('【默认提示词 · ' + key + '】\n\n' + (p?.template || ''));
  }));
  const resetAll = $('#promptResetAllBtn');
  if (resetAll) resetAll.onclick = resetAllPrompts;
}

async function savePrompt(key) {
  const ta = $(`textarea[data-prompt-text="${key}"]`);
  const out = $('#promptResult-' + key);
  if (!ta || !out) return;
  try {
    await api('/api/config', { method: 'POST', body: { diyPrompts: { [key]: ta.value } } });
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
    await loadConfig();
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

async function resetPrompt(key) {
  if (!confirm('确定恢复「' + key + '」为默认提示词？当前自定义内容会存入历史。')) return;
  try {
    await api('/api/config', { method: 'POST', body: { diyPrompts: { [key]: { reset: true } } } });
    await loadConfig();
  } catch (e) { alert(e.message); }
}

async function resetAllPrompts() {
  if (!confirm('确定将所有提示词恢复为默认？当前自定义内容会存入各自历史。')) return;
  try {
    const body = {};
    const promptKeys = Object.keys(state.diyPrompts || {});
    for (const key of promptKeys) body[key] = { reset: true };
    await api('/api/config', { method: 'POST', body: { diyPrompts: body } });
    await loadConfig();
  } catch (e) { alert(e.message); }
}

async function setDefaultProvider(id) {
  try {
    await api('/api/config', { method: 'POST', body: { llm: { activeId: id } } });
    await loadConfig();
  } catch (e) { alert(e.message); }
}

async function deleteProvider(id) {
  if (!confirm('确定删除该服务商档案？（其 API Key 也会一并删除）')) return;
  try {
    const rest = state.providers.filter(p => p.id !== id);
    await saveProviders(rest);
  } catch (e) { alert(e.message); }
}

/* 服务商弹层（新增 / 编辑） */
let provEditId = '';
let provReturnFocus = null;

// 软键盘弹起时按实际可见视口收缩弹窗，表单仍在标题与保存栏之间滚动。
function syncProvViewport() {
  const modal = $('#provModal');
  if (modal.style.display === 'none') return;
  const viewport = window.visualViewport;
  modal.style.setProperty('--prov-viewport-height', `${viewport?.height || window.innerHeight}px`);
  modal.style.setProperty('--prov-viewport-top', `${viewport?.offsetTop || 0}px`);
}
window.visualViewport?.addEventListener('resize', syncProvViewport);
window.visualViewport?.addEventListener('scroll', syncProvViewport);
window.addEventListener('resize', syncProvViewport);

function closeProvModal() {
  $('#provModal').style.display = 'none';
  const returnFocus = provReturnFocus?.isConnected ? provReturnFocus
    : $$('[data-prov-edit]').find(el => el.dataset.provEdit === provEditId) || $('#addProvBtn');
  returnFocus?.focus({ preventScroll: true });
}

/* v2.4.4：思考强度 7 档滑块——档位字符串 ↔ 刻度互转与徽章渲染（2026-09 官方档案核实档位）
   唯一调节入口=设置页滑块；功能板块不注入思考参数（服务端只读档案 thinking 字段） */
const THINK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const THINK_META = {
  off: ['关闭', '直出答案不思考；会显式下发关闭参数，兼容默认思考的模型'],
  minimal: ['极简', '极速浅思考，牺牲深度换取最快首字延迟'],
  low: ['低', '轻量思考，速度与成本均衡，适合多步决断与工具调用'],
  medium: ['中', '平衡档，多数任务的理想起点（规划 / 推理 / 判断）'],
  high: ['高', '高强度思考，复杂推理、深度规划与高价值任务'],
  xhigh: ['超高', '极深思考，面向深度研究与长程智能体任务'],
  max: ['拉满', '最深思考档，最复杂任务；与超高档建议对比后选用'],
};
function thinkStrToIdx(v) {
  const i = THINK_LEVELS.indexOf(String(v || 'off'));
  return i < 0 ? 0 : i;
}
function renderThinkBadge() {
  const el = $('#provThinking');
  if (!el) return;
  const idx = thinkStrToIdx(THINK_LEVELS[Number(el.value)] ? THINK_LEVELS[Number(el.value)] : 'off');
  const key = THINK_LEVELS[idx] || 'off';
  const [label, desc] = THINK_META[key] || THINK_META.off;
  const badge = $('#provThinkingBadge'), descEl = $('#provThinkingDesc');
  const wrap = $('#thinkSliderWrap');
  if (badge) { badge.textContent = label; badge.dataset.level = key; }
  if (descEl) descEl.textContent = desc;
  if (wrap) wrap.style.setProperty('--think-pct', (idx / (THINK_LEVELS.length - 1) * 100).toFixed(1) + '%');
}

function openProvModal(id) {
  provReturnFocus = document.activeElement;
  provEditId = id || '';
  const p = id ? state.providers.find(x => x.id === id) : null;
  $('#provModalTitle').textContent = p ? '编辑服务商：' + p.name : '添加服务商';
  $('#provName').value = p?.name || '';
  $('#provPreset').value = '';
  $('#provUrl').value = p?.baseUrl || '';
  $('#provKey').value = '';
  $('#provKey').placeholder = p?.hasKey ? '已保存 Key（留空 = 沿用）' : '粘贴 API Key';
  $('#provModel').value = p?.model || '';
  $('#provTemp').value = p?.temperature !== undefined ? p.temperature : '';
  $('#provMaxTokens').value = p?.max_tokens !== undefined ? p.max_tokens : '';
  /* v2.3.4：模型服务高级三项回填；v2.4.4：思考等级改由滑块承载 */
  $('#provThinking').value = thinkStrToIdx(p?.thinking || 'off');
  renderThinkBadge();
  $('#provVision').checked = !!p?.vision;
  $('#provExtraBody').value = p?.extraBody || '';
  $('#provModelSelect').style.display = 'none';
  $('#provTestResult').textContent = '';
  $('#provTestResult').className = 'result';
  $('#provAdvanced').open = false;
  $('#provModal').style.display = 'flex';
  syncProvViewport();
  $('#provModalBody').scrollTop = 0;
  $('#provClose').focus({ preventScroll: true });
}

$('#addProvBtn').addEventListener('click', () => openProvModal(''));
$('#provCancel').addEventListener('click', closeProvModal);
$('#provClose').addEventListener('click', closeProvModal);
$('#provModal').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeProvModal(); }
  if (e.key !== 'Tab') return;
  const controls = [...$('#provModal').querySelectorAll('button, input, select, textarea, summary')]
    .filter(el => !el.disabled && el.getClientRects().length > 0);
  const first = controls[0], last = controls[controls.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
});
$('#provThinking').addEventListener('input', renderThinkBadge);   // v2.4.4：滑块拖动实时刷徽章与进度底色

$('#provPreset').addEventListener('change', () => {
  const pr = provPresets[$('#provPreset').value];
  if (pr) {
    // v2.1.0：预设自带完整模型参数（参考 Cherry Studio），一键填入地址、模型、温度与最大 token
    $('#provUrl').value = pr.baseUrl || '';
    $('#provModel').value = pr.model || '';
    $('#provTemp').value = pr.temperature !== undefined ? pr.temperature : '';
    $('#provMaxTokens').value = pr.max_tokens !== undefined ? pr.max_tokens : '';
    if (!$('#provName').value.trim()) $('#provName').value = pr.label || $('#provPreset').value;
  }
});

$('#provFetchBtn').addEventListener('click', async () => {
  const btn = $('#provFetchBtn'), sel = $('#provModelSelect');
  const baseUrl = $('#provUrl').value.trim();
  if (!baseUrl) return alert('请先填写 Base URL');
  btn.textContent = '拉取中…'; btn.disabled = true;
  try {
    const r = await api('/api/llm/models', {
      method: 'POST',
      body: {
        baseUrl,
        apiKey: $('#provKey').value.trim() || undefined,
        providerId: provEditId || undefined,
      },
    });
    if (!r.models.length) throw new Error('服务商返回了空列表');
    sel.style.display = 'block';
    sel.innerHTML = `<option value="">— 共 ${r.models.length} 个模型，点选自动填入 —</option>` +
      r.models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  } catch (e) {
    sel.style.display = 'none';
    alert('拉取失败：' + e.message);
  }
  btn.textContent = '🔄 拉取'; btn.disabled = false;
});

$('#provModelSelect').addEventListener('change', () => {
  if ($('#provModelSelect').value) $('#provModel').value = $('#provModelSelect').value;
});

$('#provTestBtn').addEventListener('click', async () => {
  $('#provTestResult').textContent = '测试中…';
  $('#provTestResult').className = 'result';
  try {
    const r = await api('/api/test/llm', {
      method: 'POST',
      body: {
        baseUrl: $('#provUrl').value.trim() || undefined,
        apiKey: $('#provKey').value.trim() || undefined,
        model: $('#provModel').value.trim() || undefined,
        providerId: provEditId || undefined,
      },
    });
    $('#provTestResult').textContent = '✅ ' + r.msg;
    $('#provTestResult').className = 'result ok';
  } catch (e) {
    $('#provTestResult').textContent = '❌ ' + e.message;
    $('#provTestResult').className = 'result err';
  }
});

$('#provSave').addEventListener('click', async () => {
  const name = $('#provName').value.trim();
  const baseUrl = $('#provUrl').value.trim();
  const model = $('#provModel').value.trim();
  if (!name) return alert('给服务商起个名字');
  if (!baseUrl || !model) return alert('Base URL 和模型都要填');
  const key = $('#provKey').value.trim();
  const item = { name, baseUrl, model };
  const tempVal = $('#provTemp').value.trim();
  const maxTokVal = $('#provMaxTokens').value.trim();
  if (tempVal !== '') item.temperature = Number(tempVal);
  if (maxTokVal !== '') item.max_tokens = Number(maxTokVal);
  /* v2.3.4：模型服务高级三项保存（透传 JSON 先本地校验，防打手误存）；v2.4.4：思考强度读滑块刻度 */
  item.thinking = THINK_LEVELS[Number($('#provThinking').value) || 0] || 'off';
  item.vision = $('#provVision').checked;
  const extraRaw = $('#provExtraBody').value.trim();
  if (extraRaw) {
    try {
      const parsed = JSON.parse(extraRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
    } catch (e) { return alert('透传 JSON 参数格式错误：' + e.message); }
  }
  item.extraBody = extraRaw;
  if (provEditId) item.id = provEditId;
  if (key) item.apiKey = key;
  const providers = provEditId
    ? state.providers.map(p => (p.id === provEditId ? { ...p, ...item } : { ...p }))
    : [...state.providers, item];
  try {
    await saveProviders(providers);
    closeProvModal();
  } catch (e) { alert(e.message); }
});

$('#cfgMock').addEventListener('change', async () => {
  try { await api('/api/config', { method: 'POST', body: { llm: { mock: $('#cfgMock').checked } } }); }
  catch (e) { alert(e.message); }
});
/* v1.1.7：保存 AI 审核专用服务商 */
/* v2.8.0：保存 Token 凭证登录配置 */
if ($('#saveAuthCfgBtn')) $('#saveAuthCfgBtn').addEventListener('click', async () => {
  const btn = $('#saveAuthCfgBtn');
  const out = $('#authCfgResult');
  const prev = btn.textContent;
  const body = { enabled: $('#cfgAuthEnabled').checked };
  const tok = $('#cfgAuthToken').value.trim();
  if (tok) body.token = tok;
  try {
    btn.disabled = true;
    await api('/api/config', { method: 'POST', body: { auth: body } });
    if (out) { out.textContent = '✅ 登录配置已保存'; out.className = 'result ok'; }
    if (tok) $('#cfgAuthToken').value = '';
    btn.textContent = '✅ 已保存';
    loadConfig();
    setTimeout(() => { btn.textContent = prev; }, 2000);
  } catch (e) {
    if (out) { out.textContent = '❌ ' + e.message; out.className = 'result err'; }
  } finally {
    btn.disabled = false;
  }
});

/* v2.8.0：清除已存 Token 凭证 */
if ($('#clearAuthTokenBtn')) $('#clearAuthTokenBtn').addEventListener('click', async () => {
  const out = $('#authCfgResult');
  if (!confirm('确定清除已保存的 Token 凭证？清除后需重新设置才能开启登录。')) return;
  try {
    await api('/api/config', { method: 'POST', body: { auth: { enabled: false, clearToken: true } } });
    if (out) { out.textContent = '🧹 已清除 Token（登录已关闭）'; out.className = 'result ok'; }
    loadConfig();
  } catch (e) {
    if (out) { out.textContent = '❌ ' + e.message; out.className = 'result err'; }
  }
});

$('#saveModelAssignmentsBtn')?.addEventListener('click', async () => {
  const btn = $('#saveModelAssignmentsBtn');
  const result = $('#modelAssignmentsResult');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  if (result) { result.className = 'result'; result.textContent = '正在保存…'; }
  const assignment = prefix => ({ providerId: $(`#cfg${prefix}Provider`)?.value || '', model: $(`#cfg${prefix}Model`)?.value.trim() || '' });
  try {
    await api('/api/config', { method: 'POST', body: {
      review: assignment('Review'), selection: assignment('Selection'),
      story: assignment('Story'),
    } });
    if (result) { result.className = 'result ok'; result.textContent = '模型分配已保存'; }
  } catch (e) {
    if (result) { result.className = 'result err'; result.textContent = `保存失败：${e.message}`; }
  } finally { btn.disabled = false; }
});

/* ================= v2.4.1：DIY · 文章题材编辑器（词文成章题材自定义） ================= */

const STORY_THEMES_FALLBACK = ['随缘', '校园', '科幻', '悬疑', '职场', '旅行', '童话', '冒险', '美食', '体育', '侦探', '西部', '宫斗', '末日', '神话', '赛博朋克'];

function storyThemesWorking() {
  return [...(state.storyThemesEdit || state.storyThemes || STORY_THEMES_FALLBACK)];
}

/** DIY 编辑器渲染（增/删，保存时统一提交） */
function renderStoryThemesEditor() {
  const list = $('#storyThemesList');
  if (!list) return;
  const items = storyThemesWorking();
  if (!items.length) {
    list.innerHTML = '<div class="hint">列表为空——保存后将回退到内置 16 题材</div>';
    return;
  }
  list.innerHTML = items.map((t, i) => `
    <span class="story-theme-tag${t === '随缘' ? ' locked' : ''}" data-ti="${i}">${esc(t)}
      ${t === '随缘' ? '<span class="story-theme-lock" title="默认题材，不可删除">🔒</span>' : `<button class="story-theme-x" data-tx="${i}" title="移除" type="button">✕</button>`}
    </span>`).join('');
  $$('#storyThemesList [data-tx]').forEach(b => b.addEventListener('click', () => {
    const cur = storyThemesWorking();
    cur.splice(Number(b.dataset.tx), 1);
    state.storyThemesEdit = cur;
    renderStoryThemesEditor();
  }));
}

$('#storyThemeAddBtn').addEventListener('click', () => {
  const inp = $('#storyThemeInput');
  const t = (inp.value || '').trim();
  if (!t) return;
  const cur = storyThemesWorking();
  if (cur.includes(t)) { toast('题材已存在'); return; }
  if (t.length > 12) { toast('题材 ≤12 字'); return; }
  if (cur.length >= 40) { toast('最多 40 个题材'); return; }
  cur.push(t);
  state.storyThemesEdit = cur;
  inp.value = '';
  renderStoryThemesEditor();
});
$('#storyThemeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#storyThemeAddBtn').click(); });

$('#storyThemesSaveBtn').addEventListener('click', async () => {
  const btn = $('#storyThemesSaveBtn'), out = $('#storyThemesResult');
  try {
    btn.disabled = true;
    const cur = storyThemesWorking();
    await api('/api/config', { method: 'POST', body: { storyThemes: cur.length >= 2 ? cur : null } });
    state.storyThemes = cur.length >= 2 ? cur : null;
    state.storyThemesEdit = null;
    renderStoryThemesEditor();
    renderStoryThemeRow(state.storyThemes);
    out.textContent = '✅ 题材已保存，词文成章页已生效';
    out.className = 'result ok';
    setTimeout(() => { out.textContent = ''; }, 2500);
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  } finally {
    btn.disabled = false;
  }
});

$('#storyThemesResetBtn').addEventListener('click', async () => {
  const out = $('#storyThemesResult');
  try {
    await api('/api/config', { method: 'POST', body: { storyThemes: null } });
    state.storyThemes = null;
    state.storyThemesEdit = null;
    renderStoryThemesEditor();
    renderStoryThemeRow(null);
    out.textContent = '↺ 已恢复内置题材';
    out.className = 'result ok';
    setTimeout(() => { out.textContent = ''; }, 2500);
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/** 词文成章页题材 chips 动态渲染（自定义列表优先，随缘固定首位） */
function renderStoryThemeRow(customList) {
  const row = $('#storyThemeRow');
  if (!row) return;
  const themes = (Array.isArray(customList) && customList.length >= 2 ? customList : STORY_THEMES_FALLBACK);
  const ordered = ['随缘', ...themes.filter(t => t !== '随缘')];
  const cur = storyState.theme && ordered.includes(storyState.theme) ? storyState.theme : ordered[0];
  storyState.theme = cur;
  row.innerHTML = ordered.map(t => `<button class="chip${t === cur ? ' active' : ''}" data-theme="${esc(t)}" type="button">${esc(t)}</button>`).join('');
  $$('#storyThemeRow .chip').forEach(c => c.addEventListener('click', () => {
    $$('#storyThemeRow .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    storyState.theme = c.dataset.theme;
  }));
}

/* v1.0.6：云词库绑定 */
$('#loadNotepadsBtn').addEventListener('click', async () => {
  const btn = $('#loadNotepadsBtn'), sel = $('#cfgNotepad'), out = $('#notepadResult');
  btn.textContent = '拉取中…'; btn.disabled = true;
  out.textContent = ''; out.className = 'result';
  try {
    const r = await api('/api/notepads');
    if (!r.notepads.length) {
      sel.innerHTML = '<option value="">— 账号下没有云词库 —</option>';
      out.textContent = '⚠️ 账号下没有云词库/收藏本，请先在墨墨 App 里创建一个，再回来绑定';
      out.className = 'result err';
      return;
    }
    const typeLabel = t => (t === 'FAVORITE' ? '收藏本' : t === 'NOTEPAD' ? '云词本' : (t || ''));
    sel.innerHTML = '<option value="">— 未绑定 —</option>' + r.notepads.map(np =>
      `<option value="${esc(np.id)}" ${np.id === r.boundId ? 'selected' : ''}>${esc(np.title)}（${typeLabel(np.type)}）</option>`
    ).join('');
    out.textContent = `✅ 共 ${r.notepads.length} 个，选择后自动保存绑定`;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  } finally {
    btn.textContent = '拉取云词库列表'; btn.disabled = false;
  }
});

$('#cfgNotepad').addEventListener('change', async () => {
  const sel = $('#cfgNotepad'), out = $('#notepadResult');
  const id = sel.value;
  const title = id ? (sel.options[sel.selectedIndex]?.textContent || '').trim() : '';
  try {
    await api('/api/config', { method: 'POST', body: { maimemoNotepadId: id, notepadTitle: title } });
    out.textContent = id ? `✅ 已永久绑定云词库「${title}」，之后推送助记会自动将单词入库` : '已解绑';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* v1.0.6：生图服务商配置 */
$('#saveImageBtn').addEventListener('click', async () => {
  const out = $('#imageTestResult');
  try {
    await api('/api/config', {
      method: 'POST',
      body: {
        imageGen: {
          baseUrl: $('#cfgImgUrl').value.trim(),
          model: $('#cfgImgModel').value.trim(),
          apiKey: $('#cfgImgKey').value.trim() || undefined,   // 留空沿用
        },
      },
    });
    $('#cfgImgKey').value = '';
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

$('#testImageBtn').addEventListener('click', async () => {
  const out = $('#imageTestResult');
  // 先保存表单里的值再测（允许不先保存直接测）
  try {
    await api('/api/config', {
      method: 'POST',
      body: {
        imageGen: {
          baseUrl: $('#cfgImgUrl').value.trim(),
          model: $('#cfgImgModel').value.trim(),
          apiKey: $('#cfgImgKey').value.trim() || undefined,
        },
      },
    });
    $('#cfgImgKey').value = '';
  } catch { /* 测试时如实暴露错误 */ }
  out.textContent = '🎨 生成测试图中…（约 10-30 秒）';
  out.className = 'result';
  try {
    const r = await api('/api/test/image', { method: 'POST' });
    out.innerHTML = `✅ 生图成功！<img class="test-img" src="${esc(r.url)}" alt="测试图">`;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* v1.0.7：网络搜索服务配置 */
function buildSearchBody() {
  return {
    webSearch: {
      url: $('#cfgSearchUrl').value.trim(),
      apiKey: $('#cfgSearchKey').value.trim() || undefined,   // 留空沿用
    },
  };
}

$('#cfgSearchPreset').addEventListener('change', () => {
  const url = $('#cfgSearchPreset').value;
  if (url) $('#cfgSearchUrl').value = url;
});

$('#saveSearchBtn').addEventListener('click', async () => {
  const out = $('#searchTestResult');
  try {
    await api('/api/config', { method: 'POST', body: buildSearchBody() });
    $('#cfgSearchKey').value = '';
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

$('#testSearchBtn').addEventListener('click', async () => {
  const out = $('#searchTestResult');
  // 先保存表单里的值再测（允许不先保存直接测）
  try { await api('/api/config', { method: 'POST', body: buildSearchBody() }); $('#cfgSearchKey').value = ''; }
  catch { /* 测试时如实暴露错误 */ }
  out.textContent = '🔍 搜索测试中…';
  out.className = 'result';
  try {
    const r = await api('/api/test/search', { method: 'POST' });
    out.textContent = `✅ ${r.msg} · 首条：${r.sample}`;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* v3.5.0：发音与朗读设置 */
const TTS_ACCENT_LABEL = { en_US: '美音', en_GB: '英音' };
function renderTtsSettings(tts) {
  const sel = $('#cfgTtsAccent');
  if (sel) sel.value = ttsAccentPref();
  const st = tts?.status;
  const out = $('#ttsStatus');
  if (!out) return;
  if (!st) { out.textContent = ''; return; }
  const roles = (st.piper?.voicesReady || []).map(k => TTS_ACCENT_LABEL[k] || k);
  const engine = st.piper?.installed
    ? `句子神经语音 ${st.piper.running ? '已就绪' : '待启用'}${roles.length ? `（${roles.join(' / ')}）` : '（模型未就绪）'}`
    : '未部署服务端神经语音（句子将回退浏览器朗读）';
  out.textContent = `✅ 单词：真人发音 · ${engine}`;
  out.className = 'result ok';
}
async function refreshTtsStatus() {
  try {
    const r = await api('/api/tts/status');
    renderTtsSettings({ accent: ttsServerAccent, status: r.status });
  } catch { /* 静默 */ }
}
if ($('#cfgTtsAccent')) {
  $('#cfgTtsAccent').addEventListener('change', async () => {
    const accent = $('#cfgTtsAccent').value;
    try { localStorage.setItem('wb-tts-accent', accent); } catch { /* 忽略 */ }
    ttsServerAccent = accent;
    try { await api('/api/config', { method: 'POST', body: { tts: { accent } } }); } catch { /* 非管理员时忽略，本地偏好仍生效 */ }
  });
}
if ($('#testTtsBtn')) {
  $('#testTtsBtn').addEventListener('click', async () => {
    unlockTtsAudio();
    const out = $('#ttsStatus');
    if (out) { out.textContent = '🔊 播放示例：「resilient / Learning English opens the door.」'; out.className = 'result'; }
    await speak('resilient');
    setTimeout(() => speak('Learning English opens the door to a wider world.'), 900);
    setTimeout(refreshTtsStatus, 1800);
  });
}

/* v1.0.8：韦氏词典双 Key 配置 */
function buildDictBody() {
  return {
    dict: {
      learnersKey: $('#cfgDictLearners').value.trim() || undefined,     // 留空沿用
      collegiateKey: $('#cfgDictCollegiate').value.trim() || undefined,
    },
  };
}

$('#saveDictBtn').addEventListener('click', async () => {
  const out = $('#dictTestResult');
  try {
    await api('/api/config', { method: 'POST', body: buildDictBody() });
    $('#cfgDictLearners').value = '';
    $('#cfgDictCollegiate').value = '';
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

$('#testDictBtn').addEventListener('click', async () => {
  const out = $('#dictTestResult');
  // 先保存表单里的值再测（允许不先保存直接测）
  try { await api('/api/config', { method: 'POST', body: buildDictBody() }); $('#cfgDictLearners').value = ''; $('#cfgDictCollegiate').value = ''; }
  catch { /* 测试时如实暴露错误 */ }
  out.textContent = '📖 查询「resilient」测试中…';
  out.className = 'result';
  try {
    const r = await api('/api/test/dict', { method: 'POST' });
    out.textContent = '✅ ' + r.msg;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* v2.1.0a：墨墨 Token 自动保存（失焦或粘贴后即保存，无需手动点保存） */
async function saveMaimemoTokenSilent() {
  const val = $('#cfgToken').value.trim();
  if (!val) return;                      // 空值不覆盖已存 Token
  const out = $('#tokenSaveResult');
  try {
    await api('/api/config', { method: 'POST', body: { maimemoToken: val } });
    $('#cfgToken').value = '';
    $('#cfgToken').placeholder = '已保存 ✓（留空 = 沿用）';
    if (out) { out.textContent = '✅ Token 已自动保存'; out.className = 'result ok'; }
  } catch (e) {
    if (out) { out.textContent = '❌ ' + e.message; out.className = 'result err'; }
  }
}
if ($('#cfgToken')) {
  $('#cfgToken').addEventListener('change', saveMaimemoTokenSilent);
  $('#cfgToken').addEventListener('blur', saveMaimemoTokenSilent);
  $('#cfgToken').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveMaimemoTokenSilent(); } });
}

/* v2.1.0a：自动同步配置自动保存（勾选/改间隔即时生效） */
async function saveAutoSyncSilent() {
  try {
    await api('/api/config', {
      method: 'POST',
      body: { autoSync: { enabled: $('#cfgAutoSync').checked, minutes: Number($('#cfgSyncMinutes').value) || 60 } },
    });
  } catch (e) { console.error(e); }
}
if ($('#cfgAutoSync')) $('#cfgAutoSync').addEventListener('change', saveAutoSyncSilent);
if ($('#cfgSyncMinutes')) $('#cfgSyncMinutes').addEventListener('change', saveAutoSyncSilent);

$('#testMaimemoBtn').addEventListener('click', async () => {
  if ($('#cfgToken').value.trim()) await saveMaimemoTokenSilent();
  $('#maimemoTestResult').textContent = '测试中…';
  $('#maimemoTestResult').className = 'result';
  try {
    const r = await api('/api/test/maimemo', { method: 'POST' });
    $('#maimemoTestResult').textContent = '✅ ' + r.msg;
    $('#maimemoTestResult').className = 'result ok';
  } catch (e) {
    $('#maimemoTestResult').textContent = '❌ ' + e.message;
    $('#maimemoTestResult').className = 'result err';
  }
});

$('#syncNowBtn').addEventListener('click', async () => {
  if ($('#cfgToken').value.trim()) await saveMaimemoTokenSilent();
  switchTab('dashboard');
  doSync(false);
});

/* ---------------- 语料库（v2.0.1：手工上传外刊 + 自动发布源 + 真题） ---------------- */

const KB_SECTION_LABEL = {
  use_of_english: '完形填空', reading: '阅读 A', part_b: '新题型',
  translation: '翻译', writing: '写作',
};
const kbState = { records: [], filter: '', loaded: false, page: 1, pageSize: 10, searchResults: null, pubTrack: '', examIds: new Set() };   // v4.0.0：examIds = 真题整卷条目（并入语料库只读阅读）   // v1.1.2：filter = 来源分类（外刊/教材/真题/直录）；v2.0.0.a 分页；v3.6.0：pubTrack = 刊物数据轨

function renderPaginationBar(containerId, currentPage, totalPages, totalCount, onPageChange) {
  const container = $(containerId);
  if (!container) return;
  if (totalPages <= 1) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'flex';
  let html = '';
  html += `<button class="page-btn" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>`;
  
  // 生成页码序列（显示第 1 页、当前页前后各 1 页、最后一页，中间省略号）
  const pages = [];
  pages.push(1);
  const left = Math.max(2, currentPage - 1);
  const right = Math.min(totalPages - 1, currentPage + 1);
  if (left > 2) pages.push('...');
  for (let p = left; p <= right; p++) {
    if (!pages.includes(p)) pages.push(p);
  }
  if (right < totalPages - 1) pages.push('...');
  if (totalPages > 1 && !pages.includes(totalPages)) pages.push(totalPages);

  for (const p of pages) {
    if (p === '...') {
      html += `<span class="page-ellipsis">…</span>`;
    } else {
      html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }
  }

  html += `<button class="page-btn" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>`;
  html += `<span class="page-info">第 ${currentPage} / ${totalPages} 页（共 ${totalCount} 篇）</span>`;
  container.innerHTML = html;

  container.onclick = e => {
    const btn = e.target.closest('.page-btn');
    if (!btn || btn.disabled) return;
    const targetPage = parseInt(btn.dataset.page, 10);
    if (targetPage && targetPage >= 1 && targetPage <= totalPages && targetPage !== currentPage) {
      onPageChange(targetPage);
    }
  };
}

async function loadKb() {
  if (kbState.loaded) return;
  try {
    const r = await api('/api/kb/records');
    kbState.records = r.records || [];
    // v4.0.0：真题并入语料库——整卷记录以「真题」条目落在同一列表里（只读阅读，不再提供做题）
    try {
      const ex = await api('/api/kb/exams');
      kbState.examIds = new Set((ex.records || []).map(x => x.id));
      kbState.records = kbState.records.concat(ex.records || []);
    } catch { kbState.examIds = new Set(); }
    kbState.loaded = true;
    if (r.external?.count) {
      const release = r.external.manifest?.release_id ? ` · release ${r.external.manifest.release_id}` : '';
      const updated = r.external.manifest?.updated_at ? ` · 更新 ${String(r.external.manifest.updated_at).slice(0, 10)}` : '';
      $('#kbListResult').textContent = `外刊发布源 ${r.external.count} 篇${release}${updated}（自动同步）`;
      $('#kbListResult').className = 'result';
    }
    if (!r.exists) {
      $('#kbListResult').textContent = '⚠️ 未找到语料库文件：' + r.file + '（把导入工程的 records.jsonl 同步到 corpus/ 即可）';
      $('#kbListResult').className = 'result err';
    }
    renderKbTrackFilters();
    renderKbList();
  } catch (e) { console.error(e); }
}

/** v3.6.0：按当前记录聚合「刊物数据轨」chip（每个外刊一条独立轨）。 */
function renderKbTrackFilters() {
  const box = $('#kbTrackFilters');
  if (!box) return;
  const counts = new Map();
  for (const r of kbState.records) {
    if (!r.pubTrack) continue;
    const cur = counts.get(r.pubTrack) || { label: r.pubTrackLabel || r.pubTrack, count: 0 };
    cur.count++; counts.set(r.pubTrack, cur);
  }
  const chips = [`<button class="chip${kbState.pubTrack === '' ? ' active' : ''}" data-ptrack="">全部刊物</button>`];
  for (const [key, v] of [...counts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    chips.push(`<button class="chip${kbState.pubTrack === key ? ' active' : ''}" data-ptrack="${esc(key)}">${esc(v.label)} · ${v.count}</button>`);
  }
  box.innerHTML = chips.join('');
  box.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    kbState.pubTrack = c.dataset.ptrack || '';
    kbState.page = 1;
    box.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c));
    renderKbList();
  }));
}

function renderKbList() {
  const box = $('#kbList');
  const list = kbState.records.filter(r =>
    (!kbState.filter || (r.source && r.source.category) === kbState.filter)
    && (!kbState.pubTrack || r.pubTrack === kbState.pubTrack)   // v3.6.0：刊物数据轨筛选
  );
  const totalCount = list.length;
  const totalPages = Math.ceil(totalCount / kbState.pageSize) || 1;
  if (kbState.page > totalPages) kbState.page = totalPages;
  if (kbState.page < 1) kbState.page = 1;
  // v4.4.1：页头图版上的语料规模（随筛选联动，不额外请求）
  const bandCount = document.getElementById('kbBandCount');
  if (bandCount) bandCount.textContent = totalCount ? totalCount.toLocaleString('zh-CN') : '0';

  if (!list.length) {
    box.innerHTML = '<div class="empty-prov">该类型下暂无记录。可用下方「📥 导入语料」直接导入文件或粘贴文本。</div>';
    renderPaginationBar('#kbPagination', 1, 0, 0, () => {});
    return;
  }

  const startIdx = (kbState.page - 1) * kbState.pageSize;
  const pageList = list.slice(startIdx, startIdx + kbState.pageSize);

    box.innerHTML = pageList.map(r => `
    <div class="kb-item" data-rid="${esc(r.id)}">
      <div class="kb-item-head">
        <span class="badge kb-badge kb-badge-${esc(r.rtype)}">${esc(r.rtypeLabel)}</span>
        ${r.external ? '<span class="badge kb-badge-year">自动发布</span>' : (r.source?.managed === 'manual' && r.source?.category === '外刊' ? '<span class="badge kb-badge-year">用户上传</span>' : '')}
        ${r.year ? `<span class="badge kb-badge-year">${r.year} 年</span>` : ''}
        <b>${esc(r.title)}</b>
      </div>
      <div class="kb-item-meta">${[
        r.questions ? r.questions + ' 题' : '',
        r.itemCount ? r.itemCount + ' 个条目' : '',
        r.source?.publication ? esc(r.source.publication) : '',
        r.source?.parser ? '解析器 ' + esc(r.source.parser) : '',
        r.source?.published_at ? '发布 ' + esc(String(r.source.published_at).slice(0, 10)) : (r.source?.imported_at ? '导入 ' + esc(String(r.source.imported_at).slice(0, 10)) : ''),
      ].filter(Boolean).join(' · ')}</div>
      ${r.preview ? `<div class="kb-item-preview">${esc(r.preview)}…</div>` : ''}
    </div>`).join('');

  box.onclick = e => {
    const item = e.target.closest('.kb-item');
    if (item && item.dataset.rid) openKbRecord(item.dataset.rid);
  };

  renderPaginationBar('#kbPagination', kbState.page, totalPages, totalCount, newPage => {
    kbState.page = newPage;
    renderKbList();
    $('#tab-kb').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/** 〖N〗 锚点渲染：〖N〗…〖/N〗 配对 = 翻译划线句；独立 〖N〗 = 挖空/答题框 */
function kbText(text) {
  let s = allowU(esc(String(text || '')));
  s = s.replace(/〖(\d+)〗([\s\S]*?)〖\/\1〗/g,
    (m, n, inner) => `<span class="kb-underline"><span class="kb-blank-n">${n}</span>${inner.trim()}</span>`);
  s = s.replace(/〖(\d+)〗/g, (m, n) => `<span class="kb-blank">${n}</span>`);
  return s.split(/\n+/).filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
}

/** v4.0.0：真题精读——解析降级为板块级（译文 / 重点词汇 / 长难句 / 范文 / 采分点）。
 *  逐题解析（为什么选它、干扰项）随做题面一起下线；解析缺失时静默跳过，绝不阻断读原文。 */
async function kbAppendExamReading(rid) {
  try {
    const a = await api('/api/exam/analysis/' + rid);
    const units = (a.units || []).filter(u => u && u.analysis);
    if (!units.length) return;
    const txt = v => String(v == null ? '' : v).trim();
    const blocks = units.map(u => {
      const an = u.analysis || {};
      const parts = [];
      if (txt(an.translation)) parts.push(`<div class="kb-an-block"><b>全文译文</b><div>${kbText(txt(an.translation))}</div></div>`);
      if (Array.isArray(an.vocab) && an.vocab.length) {
        const vs = an.vocab.map(v => (typeof v === 'string' ? esc(v)
          : `${esc(txt(v.word))}${txt(v.meaning || v.zh) ? '：' + esc(txt(v.meaning || v.zh)) : ''}`));
        parts.push(`<div class="kb-an-block"><b>重点词汇</b><div>${vs.join('；')}</div></div>`);
      }
      if (Array.isArray(an.longSentences) && an.longSentences.length) {
        const ls = an.longSentences.map(s => `<p>${esc(txt(s.en || s.sentence))}${txt(s.zh || s.translation) ? '<br><span class="hint">' + esc(txt(s.zh || s.translation)) + '</span>' : ''}</p>`);
        parts.push(`<div class="kb-an-block"><b>长难句拆解</b>${ls.join('')}</div>`);
      }
      if (txt(an.sample)) parts.push(`<div class="kb-an-block"><b>参考范文</b><div>${kbText(txt(an.sample))}</div></div>`);
      if (Array.isArray(an.points) && an.points.length) {
        parts.push(`<div class="kb-an-block"><b>采分点</b><div>${an.points.map(p => esc(typeof p === 'string' ? p : txt(p.text || p.point))).join('；')}</div></div>`);
      }
      if (!parts.length) return '';
      return `<details class="hint-fold kb-an-fold"><summary>📖 ${esc(u.sectionLabel || u.section || '板块')} · 精读</summary><div>${parts.join('')}</div></details>`;
    }).filter(Boolean);
    if (!blocks.length) return;
    const el = document.createElement('div');
    el.className = 'card kb-an-card';
    el.innerHTML = `<div class="card-title">📖 参考解析（精读）</div><div class="hint" style="margin-bottom:8px">逐题解析已随做题面下线，此处只保留板块级精读：译文 / 重点词汇 / 长难句 / 范文 / 采分点。</div>${blocks.join('')}`;
    $('#kbDetail').appendChild(el);
  } catch { /* 解析缺失或接口失败时静默降级 */ }
}

async function openKbRecord(rid, sourceKind) {
  const card = $('#kbDetailCard');
  card.style.display = 'block';
  $('#kbDetail').innerHTML = '<div class="hint">加载中…</div>';
  try {
    const isExamRec = sourceKind ? sourceKind === 'exam' : !!kbState.examIds?.has(rid);
    const r = await api('/api/kb/' + (isExamRec ? 'exam/' : 'record/') + encodeURIComponent(rid));
    const rec = r.record;
    kbDetailState = { prefix: 'kb', id: rid, rec: null };
    kbCloseEditor();
    // v2.2.8：给详情根节点打上记录来源标记，供划选精读/三遍训练取真实 sourceRef
    $('#kbDetail').dataset.rid = rid;
    $('#kbDetail').dataset.sourceKind = rec.external ? 'external' : (rec.rtype === 'qa_set' ? 'exam' : 'corpus');
    $('#kbDetail').dataset.year = rec.meta?.year != null ? String(rec.meta.year) : '';
    $('#kbDetail').dataset.section = '';
    $('#kbDetailTitle').textContent = rec.title || rec.id;
    const readonly = rec.source?.managed === 'external' || rec.external;
    $('#kbEditBtn').style.display = readonly ? 'none' : '';
    $('#kbDelBtn').style.display = readonly ? 'none' : '';
    $('#kbHistoryBtn').style.display = readonly ? 'none' : '';
    $('#kbDetailMeta').textContent = [
      rec.rtypeLabel, rec.meta?.year ? rec.meta.year + ' 年' : '',
      rec.meta?.questions ? rec.meta.questions + ' 题' : '',
      rec.external ? '自动外刊发布源' : (rec.source?.managed === 'manual' && rec.source?.category === '外刊' ? '用户上传外刊' : ''),
      rec.source?.publication || '',
      rec.source?.canonical_url || '',
      rec.source ? `${rec.source.file || ''} · ${rec.source.parser || ''} · ${rec.source.published_at ? '发布 ' + String(rec.source.published_at).slice(0, 10) : '导入 ' + String(rec.source.imported_at || '').slice(0, 10)}` : '',
    ].filter(Boolean).join(' · ');

    let html = '';
    const items = rec.items || [];
    if (!items.length && rec.text) {
      html = `<div class="kb-passage">${kbText(rec.text)}</div>`;
    } else {
      let lastSec = null;
      for (const [ix, it] of items.entries()) {
        if (it.section !== lastSec) {
          lastSec = it.section;
          html += `<div class="kb-sec-title">${esc(KB_SECTION_LABEL[it.section] || it.section || '内容')}</div>`;
        }
        if (it.type === 'passage') {
          html += `<div class="kb-passage" data-itemidx="${ix}">${kbText(it.text)}</div>`;
        } else if (it.type === 'writing') {
          html += `<div class="kb-question" data-itemidx="${ix}"><div class="kb-q-head">✍️ 作文题${it.part ? ' · Part ' + esc(it.part) : ''}${it.score ? ' · ' + esc(String(it.score)) + ' 分' : ''}</div><div class="kb-q-text">${kbText(it.text)}</div></div>`;
        } else {
          const opts = it.options
            ? Object.entries(it.options).map(([k, v]) => `<span class="kb-opt"><b>${esc(k)}.</b> ${esc(v)}</span>`).join('')
            : '';
          html += `<div class="kb-question" data-itemidx="${ix}"><div class="kb-q-head">第 ${esc(String(it.number ?? '—'))} 题 · ${esc(it.qtype || '客观题')}${it.score != null ? ' · ' + esc(String(it.score)) + ' 分' : ''}${it.answer ? ` · <span class="kb-ans">答案：${esc(it.answer)}</span>` : ''}</div><div class="kb-q-text">${kbText(it.text)}</div>${opts ? `<div class="kb-opts">${opts}</div>` : ''}</div>`;
        }
      }
    }
    $('#kbDetail').innerHTML = html || '<div class="hint">（无条目）</div>';
    if (isExamRec) kbAppendExamReading(rid);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#kbDetail').innerHTML = '❌ ' + esc(e.message);
  }
}

async function kbDoSearch() {
  const q = $('#kbSearchInput').value.trim();
  const out = $('#kbListResult');
  if (!q) return;
  out.textContent = '搜索中…';
  out.className = 'result';
  try {
    const r = await api('/api/kb/search?q=' + encodeURIComponent(q));
    if (!r.results.length) {
      out.textContent = `「${q}」全库无匹配`;
      out.className = 'result';
      return;
    }
    out.textContent = `✅ 命中 ${r.count} 条语料（点击可跳原文）`;
    out.className = 'result ok';
    $('#kbList').innerHTML = r.results.map(h => `
      <div class="kb-item" data-rid="${esc(h.rid)}">
        <div class="kb-sentence">${esc(h.s)}</div>
        <div class="kb-item-meta">${h.sourceKind === 'exam' ? esc(h.trackLabel || '考研真题') : h.sourceKind === 'external' ? esc(h.pubTrackLabel || '外刊真实语境') : '工作台语料'}：${esc(h.title)}${h.publication ? ' · ' + esc(h.publication) : ''}${h.year ? ' · ' + h.year + ' 年' : ''}${h.section ? ' · ' + esc(KB_SECTION_LABEL[h.section] || h.section) : ''}${h.number ? ' · 第 ' + h.number + ' 题' : ''}</div>
      </div>`).join('');
    renderPaginationBar('#kbPagination', 1, 0, 0, () => {});
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

$('#kbSearchBtn').addEventListener('click', kbDoSearch);
$('#kbSearchInput').addEventListener('keydown', e => { if (e.key === 'Enter') kbDoSearch(); });
$('#kbBackBtn').addEventListener('click', () => {
  $('#kbDetailCard').style.display = 'none';
  renderKbList();
  $('#kbListResult').textContent = '';
  $('#kbListResult').className = 'result';
});
$$('#kbFilters .chip').forEach(c => c.addEventListener('click', () => {
  kbState.filter = c.dataset.kcat || '';
  kbState.page = 1; // 切换分类重置回第 1 页
  $$('#kbFilters .chip').forEach(x => x.classList.toggle('active', x === c));
  $('#kbSearchInput').value = '';
  renderKbList();
}));

/* ---------------- v1.1.1：语料导入（三层契约：投放 -> 解析 -> 归档/隔离） ---------------- */

function kbFileToB64(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('读取失败: ' + f.name));
    r.readAsDataURL(f);
  });
}

async function kbDoImport(kind) {
  const out = $('#kbImportResult');
  const category = $('#kbImportCategory').value;
  const items = [];
  let paste = null;
  if (kind === 'files') {
    for (const f of $('#kbImportFile').files) {
      if (f.size > 30 * 1024 * 1024) {
        out.textContent = `❌ ${f.name} 超过 30MB 上限`;
        out.className = 'result err';
        return;
      }
      items.push({ name: f.name, data64: await kbFileToB64(f) });
    }
    if (!items.length) {
      out.textContent = '⚠️ 请先选择文件';
      out.className = 'result err';
      return;
    }
  } else {
    paste = { title: $('#kbPasteTitle').value, text: $('#kbPasteText').value };
    if (!paste.text.trim()) {
      out.textContent = '⚠️ 请先粘贴文本内容';
      out.className = 'result err';
      return;
    }
  }
  out.textContent = '解析中…（TeX / PDF 需要几秒钟）';
  out.className = 'result';
  try {
    const r = await api('/api/kb/import', { method: 'POST', body: { category, items, paste } });
    const lines = r.results.map(x => x.ok
      ? `✅ ${esc(x.file)} → ${x.records} 条记录（${esc((x.rtypes || []).join('/'))} · 解析器 ${esc(x.parser || '')}）`
      : `⛔ ${esc(x.file)} 已隔离：${esc(x.reason || '')}${x.hint ? '（' + esc(x.hint) + '）' : ''}`);
    out.innerHTML = lines.join('<br>') + `<br>合计：成功 ${r.imported} · 隔离 ${r.quarantined}`;
    out.className = r.quarantined ? 'result err' : 'result ok';
    if (kind === 'files') $('#kbImportFile').value = '';
    else { $('#kbPasteText').value = ''; $('#kbPasteTitle').value = ''; }
    kbState.loaded = false;   // 重新拉取列表（含新记录）
    loadKb();
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

async function kbShowLog(targetId = '#kbImportResult') {
  const out = $(targetId);
  out.textContent = '加载中…';
  out.className = 'result';
  try {
    const r = await api('/api/kb/importlog');
    out.innerHTML = r.log.length
      ? r.log.map(e => {
          const ok = e.status === 'imported';
          const store = e.store ? ` · ${e.store.includes('exam') ? '🗂真题库' : ''}${e.store.includes('corpus') ? '📚语料库' : ''}` : '';
          return `<div>${ok ? '✅' : '⛔'} ${esc(String(e.time || '').slice(0, 19))} · ${esc(e.file || '')} · ${esc(e.category || '')}${esc(store)} · ${ok ? esc(e.parser || '') + ' · ' + e.records + ' 条' : '隔离：' + esc(e.reason || '')}</div>`;
        }).join('')
      : '暂无导入日志（records.jsonl 所在目录下的 import_log.jsonl）';
    out.className = 'result';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

$('#kbImportBtn').addEventListener('click', () => kbDoImport('files'));
$('#kbPasteBtn').addEventListener('click', () => kbDoImport('paste'));
$('#kbLogBtn').addEventListener('click', kbShowLog);


/* ---------------- v1.1.4：MinerU 云端解析 + 记录编辑/删除/AI 审读 ---------------- */

let kbDetailState = { prefix: 'kb', id: null, rec: null };

function kbCloseEditor() {
  ['kb', 'ex'].forEach(px => {
    const p = $('#' + px + 'EditPanel');
    if (p) { p.style.display = 'none'; p.innerHTML = ''; }
  });
  kbDetailState.rec = null;
}

function buildMineruBody() {
  return { mineru: { apiKey: $('#cfgMineruKey').value.trim() || undefined } };   // 留空沿用
}

$('#saveMineruBtn').addEventListener('click', async () => {
  const out = $('#mineruTestResult');
  try {
    await api('/api/config', { method: 'POST', body: buildMineruBody() });
    $('#cfgMineruKey').value = '';
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

$('#testMineruBtn').addEventListener('click', async () => {
  const out = $('#mineruTestResult');
  try { await api('/api/config', { method: 'POST', body: buildMineruBody() }); $('#cfgMineruKey').value = ''; }
  catch { /* 测试时如实暴露错误 */ }
  out.textContent = '🛰 MinerU 连接测试中…';
  out.className = 'result';
  try {
    const r = await api('/api/test/mineru', { method: 'POST' });
    out.textContent = '✅ ' + r.msg;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* MinerU 云端导入：逐文件上传（云端解析约 1-2 分钟/文件），产出文本记录入库 */
async function mineruDoImport(store) {
  const out = $('#kbImportResult');
  const fileInput = $('#kbMineruFile');
  const ocr = $('#kbMineruOcr').checked;
  const category = $('#kbImportCategory').value;
  const files = [...fileInput.files];
  if (!files.length) {
    out.textContent = '⚠️ 请先选择 PDF 文件';
    out.className = 'result err';
    return;
  }
  for (const f of files) {
    if (f.size > 30 * 1024 * 1024) {
      out.textContent = `❌ ${esc(f.name)} 超过 30MB 上限`;
      out.className = 'result err';
      return;
    }
  }
  const lines = [];
  out.className = 'result';
  for (const f of files) {
    out.textContent = `🛰 ${f.name} 已提交 MinerU 云端解析…（约 1-2 分钟/文件，请勿关闭页面）`;
    try {
      const r = await api('/api/mineru/parse', { method: 'POST', body: { items: [{ name: f.name, data64: await kbFileToB64(f) }], ocr, category, store: 'corpus' } });
      lines.push(r.ok
        ? `✅ ${esc(f.name)} → ${r.records} 条记录（${esc((r.rtypes || []).join('/'))} · MinerU 云端解析）`
        : `⛔ ${esc(f.name)}：${esc(r.reason || '解析失败')}`);
    } catch (e) {
      lines.push(`⛔ ${esc(f.name)}：${esc(e.message)}`);
    }
  }
  out.innerHTML = lines.join('<br>');
  out.className = 'result ok';
  fileInput.value = '';
  kbState.loaded = false; loadKb();
}

$('#kbMineruBtn').addEventListener('click', () => mineruDoImport('corpus'));


/* 记录编辑：编辑面板基于 ?raw=1 的原始条目顺序；删条目/改文字在内存标记，保存时一次性提交 */
async function kbToggleEditor() {
  const { prefix, id } = kbDetailState;
  if (!id) return;
  const panel = $('#' + prefix + 'EditPanel');
  if (panel.style.display === 'block') { kbCloseEditor(); return; }
  panel.innerHTML = '<div class="hint">加载原始记录…</div>';
  panel.style.display = 'block';
  try {
    const r = await api('/api/kb/record/' + id + '?raw=1');
    kbDetailState.rec = r.record;
    kbRenderEditor(prefix, r.record);
  } catch (e) {
    panel.innerHTML = '<div class="result err">❌ ' + esc(e.message) + '</div>';
  }
}

function kbRenderEditor(prefix, rec) {
  const panel = $('#' + prefix + 'EditPanel');
  const items = rec.items || [];
  const rows = items.map((it, i) => `
    <div class="kb-edit-item">
      <div class="kb-edit-head"><b>#${i + 1}</b><span>${esc(it.type || '')}${it.section ? ' · ' + esc(KB_SECTION_LABEL[it.section] || it.section) : ''}${it.number != null ? ' · 第 ' + esc(String(it.number)) + ' 题' : ''}</span>
        <button class="btn ghost" style="padding:2px 10px;font-size:12px" data-del="${i}">✕ 删此条</button></div>
      <textarea class="input kb-item-text" data-i="${i}" rows="${Math.min(10, Math.max(3, Math.ceil(((it.text || '').length) / 90)))}">${esc(it.text || '')}</textarea>
    </div>`).join('');
  panel.innerHTML = `
    <label class="field-label">标题</label>
    <input type="text" class="input" id="${prefix}EditTitle" value="${esc(rec.title || '')}">
    ${items.length
      ? `<label class="field-label" style="margin-top:8px">条目（${items.length} 条 · 改文字或删条目，保存后生效）</label><div>${rows}</div>`
      : `<label class="field-label" style="margin-top:8px">正文</label><textarea class="input" id="${prefix}EditText" rows="10">${esc(rec.text || '')}</textarea>`}
    <div class="row-gap" style="margin-top:10px">
      <button class="btn primary" id="${prefix}EditSave">💾 保存修改</button>
      <button class="btn ghost" id="${prefix}EditCancel">取消编辑</button>
    </div>
    <div class="result" id="${prefix}EditResult"></div>`;
  $$('#' + prefix + 'EditPanel .kb-item-text').forEach(t =>
    t.addEventListener('input', () => { items[+t.dataset.i]._newText = t.value; }));
  $$('#' + prefix + 'EditPanel [data-del]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.del;
    items[i]._del = !items[i]._del;
    b.textContent = items[i]._del ? '↩ 恢复' : '✕ 删此条';
    b.closest('.kb-edit-item').style.opacity = items[i]._del ? '.45' : '';
  }));
  $('#' + prefix + 'EditCancel').addEventListener('click', kbCloseEditor);
  $('#' + prefix + 'EditSave').addEventListener('click', async () => {
    const out = $('#' + prefix + 'EditResult');
    const body = { id: kbDetailState.id, title: $('#' + prefix + 'EditTitle').value };
    if (items.length) {
      body.items = items.filter(it => !it._del).map(it => {
        const o = {};
        for (const k of ['type', 'section', 'number', 'passage_id', 'options', 'qtype', 'score', 'part', 'answer']) {
          if (it[k] !== undefined && it[k] !== null) o[k] = it[k];
        }
        o.text = it._newText !== undefined ? it._newText : (it.text || '');
        return o;
      });
    } else {
      body.text = $('#' + prefix + 'EditText').value;
    }
    out.textContent = '保存中…';
    out.className = 'result';
    try {
      const r = await api('/api/kb/record/update', { method: 'POST', body });
      out.textContent = '✅ 已保存（' + esc(r.title) + '）';
      out.className = 'result ok';
      kbCloseEditor();
      kbState.loaded = false; loadKb(); openKbRecord(kbDetailState.id);
    } catch (e) {
      out.textContent = '❌ ' + e.message;
      out.className = 'result err';
    }
  });
}

/* 记录删除：确认框 + 写导入日志（解析原件仍在 archive/，可重导恢复） */
async function kbDeleteCurrent() {
  const { prefix, id } = kbDetailState;
  if (!id) return;
  if (!confirm('确定删除这条记录吗？\n（解析原件仍保留在 archive/，可重新导入恢复；删除会写入导入日志）')) return;
  try {
    const r = await api('/api/kb/record/delete', { method: 'POST', body: { id } });
    alert('已删除：' + r.title);
    kbCloseEditor();
    $('#kbDetailCard').style.display = 'none';
    kbState.loaded = false; loadKb();
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

/* ---------------- v1.1.7b：疑点弹窗直编 ---------------- */

/* 题型编辑规则参考（按 itemTag 前缀匹配：type·section·题N） */
const KB_FIX_RULES = {
  'passage·use_of_english': '完形原文：挖空处必须保留 〖N〗 标记（N=1~20）；段落间空行分隔；不要改动挖空位置与数量。',
  'question·use_of_english': '完形选项：text 一般为空（(blank N) 占位即可）；options 必须是 A/B/C/D 四项；score=0.5。',
  'passage·reading': '阅读原文：划线句用 〖N〗…〖/N〗 包裹（仅翻译/指代题）；Text 间空行分隔；passage_id 标识所属篇。',
  'question·reading': '阅读题目：题干以题号自然顺序排布；options 为 A/B/C/D；score=2；passage_id 指向所属原文篇。',
  'passage·part_b': '新题型原文：空位必须保留 〖4x〗 标记（41~45）；options 池为 7 项数组（A~G）；score=null（按题给分）。',
  'passage·translation': '翻译原文：待译句用 〖4N〗…〖/4N〗 划线包裹（46~50）；划线句需与翻译题干完全一致。',
  'question·translation': '翻译题干：text 即划线句原文（与原文 〖N〗…〖/N〗 内文本一致）；score=2；answer=书写。',
  'writing·writing': '写作 Part A：小作文（10 分），text 含题目要求与字数；Part B：大作文（20 分），text 含图画描述指令。',
  'article': '文章：标题/正文自由文本，段落空行分隔；无 〖N〗 体系。',
  'note': '笔记：自由文本。',
  'document': '文档：自由文本。',
};
function kbFixRuleFor(tag) {
  const t = String(tag || '');
  if (!t) return '';
  const hit = Object.entries(KB_FIX_RULES).find(([k]) => t === k || t.startsWith(k + '·') || t.startsWith(k));
  return hit ? hit[1] : '';
}

/* v1.1.7c：弹窗预览高亮——AI 摘录(quote)在原文中标红。先精确 includes，
   失败用去空白规范化+位置映射（quote 跨 〖N〗 锚点或含换行差异时仍能命中） */
function kbFixHighlight(text, quote) {
  const raw = String(text || '');
  const q = String(quote || '').trim();
  let hit = -1, qlen = 0;
  if (q) {
    hit = raw.indexOf(q);
    if (hit >= 0) {
      qlen = q.length;
    } else {
      const map = [];   // norm 下标 -> raw 下标（跳过空白）
      let norm = '';
      for (let i = 0; i < raw.length; i++) {
        if (!/\s/.test(raw[i])) { norm += raw[i]; map.push(i); }
      }
      const nq = q.replace(/\s+/g, '');
      if (nq.length >= 4) {
        const at = norm.indexOf(nq);
        if (at >= 0) {
          hit = map[at];
          qlen = (at + nq.length < map.length) ? (map[at + nq.length] - hit) : (raw.length - hit);
        }
      }
    }
  }
  const html = (hit >= 0 && qlen > 0)
    ? esc(raw.slice(0, hit)) + '<mark class="kb-fix-hl">' + esc(raw.slice(hit, hit + qlen)) + '</mark>' + esc(raw.slice(hit + qlen))
    : esc(raw);
  return { html, hit };
}

/** v1.1.7d：就地更新详情页中该条目块的文本 */
function kbUpdateDetailItem(prefix, x, newText) {
  if (x.itemIdx == null) return;
  const el = $('#' + prefix + 'Detail [data-itemidx="' + x.itemIdx + '"]');
  if (!el) return;
  const qt = el.querySelector('.kb-q-text');
  if (qt) qt.innerHTML = kbText(newText);
  else el.innerHTML = kbText(newText);
}

/** 保存后右下角 toast（v2.6.2：原「回到 AI 审读」语义改为提示已保存） */
function kbShowBackToast(prefix, ok, msg) {
  toast(msg || (ok ? '✅ 已保存' : '⚠️ 已保存'));
}

/* 疑点直编弹窗：textarea 改的即原始 itemText，保存走 /api/kb/record/update（整体 items 替换）*/
async function kbOpenFixModal(prefix, rid, x, cardIdx = -1) {
  kbCloseEditor();   // 关闭旧式全量编辑面板，避免状态交叉
  let rec = kbDetailState.rec;
  try {
    const r = await api('/api/kb/record/' + rid + '?raw=1');
    rec = kbDetailState.rec = r.record;
  } catch (e) { /* 拉取失败用已有 rec 兜底 */ }
  const items = (rec && rec.items) || [];
  /* v1.1.7b：rawIdx 由服务端 locate 回写（itemRawIdx，ordered 引用 == 原始 items 元素，indexOf 精确） */
  const rawIdx = (x.itemRawIdx != null && rec && Array.isArray(rec.items) && x.itemRawIdx < rec.items.length) ? x.itemRawIdx : -1;
  const origText = rawIdx >= 0 ? String(rec.items[rawIdx].text || '') : String(x.itemText || '');
  const rule = kbFixRuleFor(x.itemTag);
  const sevCls = { high: 'kb-issue-high', mid: 'kb-issue-mid', low: 'kb-issue-low' }[x.severity] || 'kb-issue-mid';
  let dlg = $('#kbFixModal');
  if (dlg) dlg.remove();
  dlg = document.createElement('div');
  dlg.id = 'kbFixModal';
  dlg.className = 'kb-fix-modal';
  dlg.innerHTML = `
    <div class="kb-fix-dialog">
      <div class="kb-fix-head">
        <div class="kb-fix-title">📍 疑点直编 · ${esc(x.itemTag || x.loc)} <span class="kb-issue-tag ${sevCls}">${esc(x.severity || 'mid')}</span></div>
        <button class="kb-fix-close" title="关闭">✕</button>
      </div>
      <div class="kb-fix-issue">${esc(x.desc || '')}${x.quote ? `<div class="kb-issue-quote">“${esc(x.quote)}”</div>` : ''}</div>
      ${rule ? `<div class="kb-fix-rule">📐 ${esc(rule)}</div>` : ''}
      <label class="field-label">🔍 疑点定位预览 <span style="font-weight:400">（<mark class="kb-fix-hl">红底纹</mark> = AI 认为有误处，随下方编辑实时更新）</span></label>
      <div id="kbFixPreview" class="kb-fix-preview"></div>
      <label class="field-label">条目原文（可直接修改，保存后同步题库；改动会写入 edited_at 留痕）</label>
      <textarea id="kbFixText" class="input kb-fix-text" rows="14">${esc(origText)}</textarea>
      <div class="kb-fix-actions">
        <button class="btn primary" id="kbFixSave">💾 保存到题库</button>
        <button class="btn ghost" id="kbFixCancel">关闭</button>
        ${rawIdx < 0 ? '<span class="hint">⚠️ 该疑点未能对齐到原始条目（定位降级），保存将不可用——请用「编辑」全量面板改。</span>' : ''}
      </div>
      <div class="result" id="kbFixResult"></div>
    </div>`;
  document.body.appendChild(dlg);
  /* v1.1.7e：滚动隔离——弹窗内滚动不穿透主界面（可滚元素内部放行，到边界/遮罩一律拦截） */
  dlg.addEventListener('wheel', e => {
    const scrollers = [$('#kbFixPreview'), $('#kbFixText'), dlg.querySelector('.kb-fix-dialog')].filter(Boolean);
    const t = scrollers.find(el => el === e.target || el.contains(e.target));
    if (t && t.scrollHeight > t.clientHeight) {
      const atTop = t.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = t.scrollTop + t.clientHeight >= t.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) return;
    }
    e.preventDefault();
  }, { passive: false });
  /* v1.1.7c：预览区渲染——AI 摘录标红；编辑时节流刷新（改对了红纹即消失，直观反馈） */
  const pv = $('#kbFixPreview');
  const ta = $('#kbFixText');
  const renderPv = () => {
    const { html, hit } = kbFixHighlight(ta.value, x.quote);
    pv.innerHTML = (x.quote && hit < 0 ? '<div class="kb-fix-miss">⚠️ AI 摘录未在当前文本命中（可能已被修改或跨段截断）</div>' : '') + html;
    pv.scrollTop = 0;
  };
  renderPv();
  /* v1.1.8：移动端预览区默认折叠，点一下展开全文 */
  if (window.innerWidth <= 700) {
    pv.classList.add('kb-collapsed');
    pv.addEventListener('click', () => pv.classList.remove('kb-collapsed'), { once: true });
  }
  let pvTimer = null;
  ta.addEventListener('input', () => { clearTimeout(pvTimer); pvTimer = setTimeout(renderPv, 200); });

  const close = () => dlg.remove();
  dlg.querySelector('.kb-fix-close').addEventListener('click', close);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  $('#kbFixCancel').addEventListener('click', close);
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape' && document.body.contains(dlg)) { close(); document.removeEventListener('keydown', escClose); }
  });
  if (rawIdx < 0) return;   // 无法对齐：仅浏览，不出保存
  $('#kbFixSave').addEventListener('click', async () => {
    const out = $('#kbFixResult');
    const newText = $('#kbFixText').value;
    const body = { id: rid, items: rec.items.map((it, i) => {
      const o = {};
      for (const k of ['type', 'section', 'number', 'passage_id', 'options', 'qtype', 'score', 'part', 'answer']) {
        if (it[k] !== undefined && it[k] !== null) o[k] = it[k];
      }
      o.text = i === rawIdx ? newText : (it.text || '');
      return o;
    }) };
    out.textContent = '保存中…';
    out.className = 'result';
    try {
      await api('/api/kb/record/update', { method: 'POST', body });
      /* v2.6.2：AI 复核通道已废弃——保存后直接标记完成 */
      if (prefix === 'kb') kbState.loaded = false; else examState.loaded = false;
      kbUpdateDetailItem(prefix, x, newText);
      out.innerHTML = '✅ 已保存';
      out.className = 'result ok';
      close();
      kbShowBackToast(prefix, true, '✅ 修改已保存');
    } catch (e) {
      out.textContent = '❌ ' + esc(e.message);
      out.className = 'result err';
    }
  });
}

/* ---------------- v2.6.2：历史版本回溯（原 AI 修正采纳板块已废弃，kbAdoptFix/kbDoReview 已移除） ---------------- */

async function kbOpenHistory() {
  const { prefix, id } = kbDetailState;
  if (!id) return;
  let dlg = $('#kbHistoryModal');
  if (dlg) dlg.remove();
  dlg = document.createElement('div');
  dlg.id = 'kbHistoryModal';
  dlg.className = 'kb-fix-modal';
  dlg.innerHTML = `
    <div class="kb-fix-dialog kb-history-dialog">
      <div class="kb-fix-head">
        <div class="kb-fix-title">🕘 历史版本（最近 ${5} 个，改前自动留存）</div>
        <button class="kb-fix-close" title="关闭">✕</button>
      </div>
      <div id="kbHistoryBody" class="kb-history-body"><div class="hint">加载中…</div></div>
    </div>`;
  document.body.appendChild(dlg);
  const close = () => dlg.remove();
  dlg.querySelector('.kb-fix-close').addEventListener('click', close);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.addEventListener('wheel', e => {
    const t = e.target.closest('.kb-history-body');
    if (t && t.scrollHeight > t.clientHeight) {
      const atTop = t.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = t.scrollTop + t.clientHeight >= t.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) return;
    }
    if (!e.target.closest('.kb-history-body')) e.preventDefault();
  }, { passive: false });
  const body = $('#kbHistoryBody');
  try {
    const r = await api('/api/kb/versions?id=' + encodeURIComponent(id));
    if (!r.versions.length) {
      body.innerHTML = '<div class="hint">暂无历史版本——每次保存修改时会自动留存旧版本（最多 5 个）。</div>';
      return;
    }
    body.innerHTML = r.versions.map(v => `
      <div class="kb-history-item">
        <div class="kb-history-head">
          <b>${esc(fmtBJ(v.ts))}</b>
          <span class="hint">${esc(v.title || '')} · ${v.itemCount ? v.itemCount + ' 条目 · ' : ''}${v.chars} 字符</span>
        </div>
        <div class="hint">${esc(v.note || '')}</div>
        <div class="row-gap" style="margin-top:6px">
          <button class="btn small" data-restore="${v.index}">↩ 回退到此版本</button>
        </div>
      </div>`).join('');
    $$('#kbHistoryBody [data-restore]').forEach(b => b.addEventListener('click', async () => {
      const vi = +b.dataset.restore;
      const v = r.versions[vi];
      if (!confirm('回退到 ' + v.ts + ' 的版本？\n\n当前内容会先存入历史，可再次回退。')) return;
      b.disabled = true; b.textContent = '回退中…';
      try {
        await api('/api/kb/version/restore', { method: 'POST', body: { id, store: 'corpus', versionIndex: vi } });
        close();
        toast('↩ 已回退到历史版本');
        kbState.loaded = false; loadKb(); openKbRecord(id);
      } catch (e) {
        alert('回退失败：' + e.message);
        b.disabled = false; b.textContent = '↩ 回退到此版本';
      }
    }));
  } catch (e) {
    body.innerHTML = '<div class="result err">❌ ' + esc(e.message) + '</div>';
  }
}

$('#kbEditBtn').addEventListener('click', kbToggleEditor);

$('#kbDelBtn').addEventListener('click', kbDeleteCurrent);

$('#kbHistoryBtn').addEventListener('click', kbOpenHistory);


/* ---------------- v2.1.2：划选精读学习（单词/词组/句子，PC 浮动 + 移动端底部卡片） ---------------- */
/* v2.3.3：借鉴 nextai-translator / Saladict / 沉浸式翻译——
   ① 解析卡片多模式 Tab（释义/直译/语法/例句）；② 双击查词；③ Esc 关闭；④ 一键收进墨墨云词库（Saladict 生词本交互 × 墨墨生态） */
/* v2.4.1：划词助手扩展到全站——不再限定容器白名单，正文/文章/词表/笔记等任意页面文本皆可划选；
   仍排除输入框、textarea、精读卡自身与编辑弹窗，交互控件区域不受影响。 */

const SEL_LEARN_READABLE = null;   // v2.4.1：null = 全站放行（原白名单 ['#kbDetail', '#exDetail', '#unitDetail'] 已弃用）
const SEL_LEARN_MODES = [
  { id: 'define', label: '📖 释义' },
  { id: 'translate', label: '🌐 直译' },
  { id: 'grammar', label: '🌳 语法' },
  { id: 'example', label: '💡 例句' },
];
let selLearnBtn = null;      // 选区旁的「精读」浮动按钮
let selLearnCard = null;     // 解析结果卡片
let selDictCard = null;      // v3.7.0：本地词典卡片（ECDICT 秒出）
let selDictGlossCache = new Map();   // 小写词 -> 查词结果（含未收录）
let selLearnState = null;    // { text, context, title, kind, rect, mode }
let selLearnReqSeq = 0;      // 并发保护：只认最后一次请求
let selLearnBubbleBornAt = 0; // v2.7.2.a：气泡生成时刻（长按取词后浏览器会补发 click，短暂豁免防止气泡被立刻收起）

function selLearnKindOf(text) {
  const t = String(text || '').trim();
  if (!t) return 'sentence';
  if (/^[A-Za-z][A-Za-z'-]*$/.test(t)) return 'word';
  const words = t.split(/\s+/).filter(Boolean);
  if (/^[A-Za-z0-9'’\-–—.,;:!?()\s]+$/.test(t) && words.length <= 5) return 'phrase';
  return 'sentence';
}

function selLearnInReadable(node) {
  /* v2.4.1：全站放行——按 DOM 结构判定“可读正文”：处于 body 内且不在编辑/交互件中即视为可读 */
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!el || !document.body.contains(el)) return null;
  if (el.closest('input, textarea, select, [contenteditable], .sel-learn-card, .kb-fix-modal, .modal-mask, nav.tab-group, .sidebar, .mobile-header, .mobile-bottom-bar, button, .btn')) return null;
  return el.closest('#kbDetail') || el.closest('#exDetail') || el.closest('#unitDetail') || el;
}

function selLearnContextOf(range, root) {
  try {
    const node = range.startContainer;
    const host = (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-itemidx]') ||
      (node.nodeType === 1 ? node : node.parentElement)?.closest('.kb-passage, .kb-question, .unit-q, .story-passage, .sel-learn-body, p, li, .card') || root;
    return String(host?.innerText || '').replace(/\s+\n/g, '\n').trim().slice(0, 3000);
  } catch { return ''; }
}

function selLearnTitleOf(root) {
  /* v2.4.1：全站场景取当前激活页签标题兜底 */
  const prefix = root.id === 'exDetail' ? 'ex' : (root.id === 'unitDetail' ? 'unit' : (root.id === 'kbDetail' ? 'kb' : ''));
  if (prefix) {
    const t = $(`#${prefix}DetailTitle`);
    if (t) return t.textContent.trim().slice(0, 100);
  }
  const active = document.querySelector('.tab.active');
  return active ? ('工作台 · ' + active.textContent.trim().slice(0, 60)) : '';
}

/* v2.7.2.a：触摸端原生选择已禁用，用自绘高亮框给出「划线」视觉反馈（支持跨行多段矩形） */
let selLearnHlNodes = [];
function selLearnShowHighlight(rects) {
  const list = (Array.isArray(rects) ? rects : [rects]).filter(r => r && (r.width || r.height));
  while (selLearnHlNodes.length < list.length) {
    const d = document.createElement('div');
    d.className = 'sel-learn-hl';
    document.body.appendChild(d);
    selLearnHlNodes.push(d);
  }
  const pad = 2;
  selLearnHlNodes.forEach((d, i) => {
    const r = list[i];
    if (!r) { d.style.display = 'none'; return; }
    d.style.left = Math.round(r.left - pad) + 'px';
    d.style.top = Math.round(r.top - pad) + 'px';
    d.style.width = Math.round(r.width + pad * 2) + 'px';
    d.style.height = Math.round(r.height + pad * 2) + 'px';
    d.style.display = 'block';
  });
}
function selLearnRemoveHighlight() {
  selLearnHlNodes.forEach(d => d.remove());
  selLearnHlNodes = [];
}

/* v2.7.2.c：触摸端「可拖拽端点手柄」——原生选择手柄已被禁用，自绘两只手柄实现自由拉伸选区 */
let selLearnHandleStart = null, selLearnHandleEnd = null, selLearnDragIdx = null;
function selLearnEnsureHandles() {
  if (selLearnHandleStart && selLearnHandleEnd) return;
  const mk = () => {
    const h = document.createElement('div');
    h.className = 'sel-learn-handle';
    h.innerHTML = '<span class="sel-learn-handle-knob"></span>';
    document.body.appendChild(h);
    return h;
  };
  selLearnHandleStart = mk();
  selLearnHandleEnd = mk();
  selLearnHandleStart.classList.add('start');
  selLearnHandleEnd.classList.add('end');
  selLearnHandleStart.dataset.idx = '0';
  selLearnHandleEnd.dataset.idx = '1';
  [selLearnHandleStart, selLearnHandleEnd].forEach(h => {
    h.addEventListener('touchstart', selLearnHandleTouchStart, { passive: false });
    h.addEventListener('touchmove', selLearnHandleTouchMove, { passive: false });
    h.addEventListener('touchend', selLearnHandleTouchEnd, { passive: false });
    h.addEventListener('touchcancel', selLearnHandleTouchEnd, { passive: false });
    h.addEventListener('mousedown', e => e.preventDefault());
  });
}
function selLearnRemoveHandles() {
  [selLearnHandleStart, selLearnHandleEnd].forEach(h => { if (h) h.remove(); });
  selLearnHandleStart = null;
  selLearnHandleEnd = null;
  selLearnDragIdx = null;
}
function selLearnPositionHandle(el, rect, isStart) {
  if (!el) return;
  if (!rect) { el.style.display = 'none'; return; }
  const half = 11;
  const x = isStart ? rect.left : rect.right;
  const y = rect.bottom;
  el.style.display = 'block';
  el.style.left = Math.round(x - half) + 'px';
  el.style.top = Math.round(y - half) + 'px';
}

function selLearnRemoveBtn() {
  if (selLearnBtn) { selLearnBtn.remove(); selLearnBtn = null; }
  selLearnRemoveHighlight();
  selLearnRemoveHandles();
}

/* ---------------- v3.7.0：离线词库（ECDICT）划词秒查 ---------------- */
const SEL_DICT_POS_RE = /^((?:vt|vi|v|n|adj|adv|prep|conj|pron|num|art|int|aux|abbr|pl|a)\.)\s*(.*)$/i;

/** 是否值得查本地词典：英文单词或 1~5 词短词组（句子不查）。 */
function selDictEligible(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 48) return false;
  if (!/^[A-Za-z][A-Za-z'’\-\s]*$/.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length <= 5;
}

/** 查本地词库（内存缓存 + 去重请求）；失败静默返回 null，不阻断划词。 */
const selDictInflight = new Map();
async function selDictLookup(text) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return null;
  if (selDictGlossCache.has(key)) return selDictGlossCache.get(key);
  if (selDictInflight.has(key)) return selDictInflight.get(key);
  const task = (async () => {
    try {
      const res = await fetch('/api/dict/ecdict?word=' + encodeURIComponent(key));
      if (!res.ok) return null;
      const r = await res.json();
      const out = (r && r.found) ? r : null;
      selDictGlossCache.set(key, out);
      if (selDictGlossCache.size > 2000) selDictGlossCache.delete(selDictGlossCache.keys().next().value);
      return out;
    } catch {
      return null;
    } finally {
      selDictInflight.delete(key);
    }
  })();
  selDictInflight.set(key, task);
  return task;
}

function selDictTagsHtml(entry) {
  const tags = (entry.tags || []).map(t => `<span class="sel-gloss-tag">${esc(t.name)}</span>`).join('');
  const stars = entry.collins > 0 ? `<span class="sel-gloss-tag star">${'★'.repeat(Math.min(5, entry.collins))}</span>` : '';
  return tags + stars;
}

/** 气泡内的简要释义（首条中文释义 + 音标 + 考试标签）。 */
function selDictBriefHtml(entry) {
  const first = (entry.translation || []).find(Boolean) || '';
  const phon = entry.phonetic ? `<span class="sel-gloss-phon">/${esc(entry.phonetic.replace(/^\/+|\/+$/g, ''))}/</span>` : '';
  const lemma = entry.lemmaOf ? `<span class="sel-gloss-lemma">→ ${esc(entry.lemmaOf)}</span>` : '';
  const body = first
    ? `<span class="sel-gloss-def">${esc(first.length > 72 ? first.slice(0, 72) + '…' : first)}</span>`
    : '<span class="sel-gloss-def muted">暂无中文释义</span>';
  return `${phon}<span class="sel-gloss-word">${esc(entry.word)}</span>${lemma}${selDictTagsHtml(entry)}${body}`;
}

let selGlossSeq = 0;
/** 为气泡补上本地释义（异步；序号保护避免旧请求覆盖新选区）。 */
function selDictFillGloss(bubble) {
  const row = bubble && bubble.querySelector('[data-sel-gloss]');
  if (!row) return;
  const st = selLearnState;
  const seq = ++selGlossSeq;
  if (!st || !SEL_DICT_READY || !selDictEligible(st.text)) {
    row.innerHTML = '';
    row.style.display = 'none';
    bubble.classList.remove('has-gloss');
    return;
  }
  row.style.display = '';
  row.innerHTML = '<span class="sel-gloss-loading">查词中…</span>';
  bubble.classList.add('has-gloss');
  selDictLookup(st.text).then(data => {
    if (seq !== selGlossSeq || !bubble.parentNode) return;
    if (!data || !data.data) {
      row.style.display = 'none';
      row.innerHTML = '';
      bubble.classList.remove('has-gloss');
      selLearnRepositionBubble(bubble);
      return;
    }
    const entry = data.data;
    row.innerHTML = selDictBriefHtml(entry);
    row.dataset.act = 'dict';
    row.title = '点击查看完整词条';
    selLearnRepositionBubble(bubble);
  });
}

/** 气泡高度变化后重新贴靠选区（避免释义撑高后压住文字）。 */
function selLearnRepositionBubble(bubble) {
  const st = selLearnState;
  if (!st || !bubble) return;
  const rect = bubble.__anchorRect || st.rect;
  if (!rect) return;
  const isMobile = window.innerWidth <= 700;
  const bw = bubble.offsetWidth || 150;
  const bh = bubble.offsetHeight || 38;
  const winW = window.innerWidth;
  let x = rect.left + (rect.width / 2) - (bw / 2);
  x = Math.max(10, Math.min(x, winW - bw - 10));
  const gap = isMobile ? 14 : 10;
  let y = rect.top - bh - gap;
  if (y < 8) y = rect.bottom + gap;
  bubble.style.left = Math.round(x) + 'px';
  bubble.style.top = Math.round(y) + 'px';
}

/** 本地词库是否就绪（启动时探测一次；未安装则气泡不显示释义行）。 */
let SEL_DICT_READY = false;
let SEL_DICT_FP = '';
(async function selDictProbe() {
  try {
    // 用裸 fetch：探测失败（未登录/未安装）不应触发登录遮罩或报错提示
    const res = await fetch('/api/dict/ecdict/status');
    if (!res.ok) return;
    const r = await res.json();
    SEL_DICT_READY = Boolean(r && r.status && r.status.ready);
    SEL_DICT_FP = (r && r.status && r.status.fingerprint) || '';
  } catch { SEL_DICT_READY = false; }
})();

/** 完整词典卡片（本地词库；点击气泡释义行打开）。 */
function selDictCloseCard() {
  if (selDictCard) { selDictCard.remove(); selDictCard = null; }
}

function selDictTranslationHtml(entry) {
  const lines = (entry.translation || []).filter(Boolean);
  if (!lines.length) return '<div class="hint">暂无中文释义</div>';
  const groups = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(SEL_DICT_POS_RE);
    if (m) {
      cur = { pos: m[1], items: m[2] ? [m[2]] : [] };
      groups.push(cur);
    } else if (cur) {
      cur.items.push(line);
    } else {
      cur = { pos: '', items: [line] };
      groups.push(cur);
    }
  }
  return groups.map(g => `<div class="sel-dict-pos">${g.pos ? `<span class="sel-dict-pos-label">${esc(g.pos)}</span>` : ''}${g.items.map(it => `<div class="sel-dict-def">${esc(it)}</div>`).join('')}</div>`).join('');
}

async function selDictOpen() {
  if (!selLearnState) return;
  const text = selLearnState.text;
  const data = await selDictLookup(text);
  selLearnRemoveBtn();
  selDictCloseCard();
  const isMobile = window.innerWidth <= 700;
  const card = document.createElement('div');
  card.className = 'sel-learn-card sel-dict-card' + (isMobile ? ' mobile' : '');
  if (!data || !data.data) {
    card.innerHTML = `
      <div class="sel-learn-head">
        <span class="sel-learn-kind">📖 词典</span>
        <span class="sel-learn-text">${esc(text)}</span>
        <button class="sel-learn-x" title="关闭">✕</button>
      </div>
      <div class="sel-learn-body"><div class="hint">本地词库未收录该词（可能是专有名词、缩写或拼写变形）。</div></div>
      <div class="sel-learn-foot">
        <button class="btn small" data-sel-learn>🔍 AI 精读</button>
        <button class="btn small ghost" data-sel-speak>🔊 朗读</button>
      </div>`;
  } else {
    const entry = data.data;
    const phon = entry.phonetic ? `/${esc(entry.phonetic.replace(/^\/+|\/+$/g, ''))}/` : '';
    const lemmaHint = entry.lemmaOf ? `<div class="sel-dict-lemma">原形：<b>${esc(entry.word)}</b></div>` : '';
    const defs = (entry.definition || []).slice(0, 5);
    card.innerHTML = `
      <div class="sel-learn-head">
        <span class="sel-learn-kind">📖 词典</span>
        <span class="sel-learn-text">${esc(entry.word)}${phon ? ' <span class="sel-dict-phon">' + phon + '</span>' : ''}</span>
        <button class="sel-learn-x" title="关闭">✕</button>
      </div>
      <div class="sel-learn-body">
        ${selDictTagsHtml(entry) ? `<div class="sel-dict-tags">${selDictTagsHtml(entry)}</div>` : ''}
        ${lemmaHint}
        ${selDictTranslationHtml(entry)}
        ${defs.length ? `<details class="sel-dict-en"><summary>英文释义</summary>${defs.map(d => `<div class="sel-dict-def en">${esc(d)}</div>`).join('')}</details>` : ''}
      </div>
      <div class="sel-learn-foot">
        <button class="btn small" data-sel-speak>🔊 朗读</button>
        <button class="btn small ghost" data-sel-learn>🔍 AI 精读</button>
        <button class="btn small" data-sel-collect>➕ 收进墨墨</button>
      </div>`;
  }
  document.body.appendChild(card);
  selDictCard = card;
  card.querySelector('.sel-learn-x').addEventListener('click', selDictCloseCard);
  card.querySelector('[data-sel-speak]')?.addEventListener('click', () => speak(text));
  card.querySelector('[data-sel-learn]')?.addEventListener('click', () => {
    selDictCloseCard();
    selLearnOpen();
  });
  const collectBtn = card.querySelector('[data-sel-collect]');
  if (collectBtn) collectBtn.addEventListener('click', async () => {
    try {
      await api('/api/selection/collect', { method: 'POST', body: { spelling: text } });
      collectBtn.textContent = '✔ 已收进';
      collectBtn.disabled = true;
      toast('✅ 已收进墨墨云词库');
    } catch (e) {
      toast('❌ ' + e.message);
    }
  });
}

function selLearnCloseCard() {
  if (selLearnCard) { selLearnCard.remove(); selLearnCard = null; }
  selLearnReqSeq++;
}

function selLearnShowBtn(rect, rects) {
  const isMobile = window.innerWidth <= 700;

  // 若气泡已存在，直接复用并更新定位，避免频繁销毁重建导致选区丢失和移动端闪烁
  let bubble = selLearnBtn;
  if (!bubble || !bubble.parentNode) {
    selLearnRemoveBtn();
    selLearnBubbleBornAt = Date.now();
    bubble = document.createElement('div');
    bubble.className = 'sel-learn-bubble';
    bubble.innerHTML = `
      <div class="sel-gloss" data-sel-gloss style="display:none"></div>
      <div class="sel-bubble-actions">
        <button type="button" class="sel-bubble-btn primary" data-act="learn">🔍 精读</button>
        <button type="button" class="sel-bubble-btn" data-act="expand" style="display:none">↔️ 整句</button>
        <span class="sel-bubble-divider"></span>
        <button type="button" class="sel-bubble-btn" data-act="copy">📋 复制</button>
      </div>
    `;
    document.body.appendChild(bubble);

    // 关键：仅阻止 mousedown 默认行为（桌面端防止点击气泡时原生选区内塌）；
    // 移动端不可 preventDefault touchstart，否则浏览器不会再合成 click，按钮将彻底点不动。
    bubble.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    bubble.addEventListener('touchstart', e => {
      e.stopPropagation(); // 只阻止冒泡（避免触发全局长按取词/收起逻辑），保留 click 合成
    }, { passive: true });

    // v3.7.0：点击释义行 → 打开本地词典完整卡片
    bubble.querySelector('[data-sel-gloss]').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      selDictOpen();
    });

    bubble.querySelector('[data-act="learn"]').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      selLearnOpen();
    });

    // v2.7.2.a：触摸端无自由划线，提供「整句」一键把取词扩展为整句再精读
    bubble.querySelector('[data-act="expand"]').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (selLearnExpandToSentence()) {
        const ex = bubble.querySelector('[data-act="expand"]');
        if (ex) ex.style.display = 'none';
      }
    });

    bubble.querySelector('[data-act="copy"]').addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      const copyBtn = bubble.querySelector('[data-act="copy"]');
      const textToCopy = selLearnState?.text || '';
      // v3.8.2：改用统一复制入口（HTTP 下 navigator.clipboard 不存在，必须走 execCommand 兜底）
      const success = await copyText(textToCopy);
      if (copyBtn) copyBtn.innerHTML = success ? '✓ 已复制' : '✗ 复制失败';
      toast(success ? '📋 文本已复制到剪贴板' : '❌ 复制失败，请长按选中文本手动复制');
      setTimeout(() => {
        selLearnRemoveBtn();
      }, 700);
    });

    selLearnBtn = bubble;
  }

  // 「整句」按钮仅在触摸端且当前取词为单词/词组时显示
  const expandBtn = bubble.querySelector('[data-act="expand"]');
  if (expandBtn) {
    const canExpand = SEL_TOUCH_DEVICE && selLearnState && selLearnState.kind !== 'sentence' &&
      selLearnState.anchor && selLearnState.focus && selLearnState.anchor.node === selLearnState.focus.node;
    expandBtn.style.display = canExpand ? '' : 'none';
  }

  /* v2.7.2：高精度自适应浮动定位算法（PC & 移动端统一跟随选区） */
  const bubbleW = bubble.offsetWidth || 150;
  const bubbleH = bubble.offsetHeight || 38;
  const winW = window.innerWidth;

  // 水平居中计算并进行左右边界 clamp 保护
  let x = rect.left + (rect.width / 2) - (bubbleW / 2);
  x = Math.max(10, Math.min(x, winW - bubbleW - 10));

  // 垂直方向：移动端预留 14px 呼吸间隙避开系统光标水滴手柄；PC 端 10px
  const gap = isMobile ? 14 : 10;
  let y = rect.top - bubbleH - gap;
  // 若选区靠顶（上方空间不足），翻转至下方
  if (y < 8) {
    y = rect.bottom + gap;
  }

  bubble.style.left = Math.round(x) + 'px';
  bubble.style.top = Math.round(y) + 'px';
  bubble.__anchorRect = rect;

  // v3.7.0：本地词库释义（单词/短词组，命中即显示；未就绪或句子则隐藏）
  selDictFillGloss(bubble);

  // 触摸端：原生选择已禁用，自绘高亮框 + 可拖拽端点手柄提供「划线/拉伸」能力
  if (SEL_TOUCH_DEVICE) {
    const list = (rects && rects.length) ? rects : [rect];
    selLearnShowHighlight(list);
    selLearnEnsureHandles();
    const first = list[0], last = list[list.length - 1];
    selLearnPositionHandle(selLearnHandleStart, first, true);
    selLearnPositionHandle(selLearnHandleEnd, last, false);
  }
}

/** v2.3.3：以指定模式请求解析结果（并发保护：只认最后一次请求） */
function selLearnRequest(card, mode, seq) {
  if (!selLearnState || !card) return;
  const bodyEl = card.querySelector('.sel-learn-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = '<div class="hint">AI 精读解析中…</div>';
  api('/api/selection/learn', {
    method: 'POST',
    body: { text: selLearnState.text, context: selLearnState.context, title: selLearnState.title, kind: selLearnState.kind, mode },
  })
    .then(r => {
      if (seq !== selLearnReqSeq || selLearnCard !== card) return;
      bodyEl.innerHTML = mdLite(r.reply || '（无解析结果）');
    })
    .catch(e => {
      if (seq !== selLearnReqSeq || selLearnCard !== card) return;
      bodyEl.innerHTML = '<div class="result err">❌ ' + esc(e.message) + '</div>';
    });
}

function selLearnOpen() {
  if (!selLearnState) return;
  const { text, context, title } = selLearnState;
  const kind = selLearnKindOf(text);
  selLearnRemoveBtn();
  selLearnCloseCard();
  const seq = ++selLearnReqSeq;
  const isMobile = window.innerWidth <= 700;
  const card = document.createElement('div');
  card.className = 'sel-learn-card' + (isMobile ? ' mobile' : '');
  card.innerHTML = `
    <div class="sel-learn-head">
      <span class="sel-learn-kind">${kind === 'word' ? '📖 单词' : kind === 'phrase' ? '🧩 词组' : '📝 句子'}</span>
      <span class="sel-learn-text">${esc(text.length > 120 ? text.slice(0, 120) + '…' : text)}</span>
      <button class="sel-learn-x" title="关闭">✕</button>
    </div>
    <div class="sel-learn-modes">
      ${SEL_LEARN_MODES.map(m => `<button class="sel-mode${m.id === 'define' ? ' active' : ''}" data-mode="${m.id}" type="button">${m.label}</button>`).join('')}
    </div>
    <div class="sel-learn-body"><div class="hint">AI 精读解析中…</div></div>
    <div class="sel-learn-foot">
      <button class="btn small" data-sel-speak>🔊 朗读</button>
      <button class="btn small ghost" data-sel-copy>📋 复制解析</button>
      <button class="btn small" data-sel-sentence>🧩 加入三遍训练</button>
      ${kind !== 'sentence' ? '<button class="btn small" data-sel-collect>➕ 收进墨墨</button>' : ''}
    </div>`;
  document.body.appendChild(card);
  selLearnCard = card;
  card.addEventListener('wheel', e => {
    const b = card.querySelector('.sel-learn-body');
    if (b && b.scrollHeight > b.clientHeight) {
      const atTop = b.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) return;
    }
    if (!e.target.closest('.sel-learn-body')) e.preventDefault();
  }, { passive: false });
  card.querySelector('.sel-learn-x').addEventListener('click', selLearnCloseCard);
  card.querySelector('[data-sel-speak]').addEventListener('click', () => speak(text));
  card.querySelector('[data-sel-sentence]').addEventListener('click', () => {
    selLearnCloseCard();
    stOpen({ text, context, title, sourceRef: selLearnState?.sourceRef || null });
  });
  card.querySelector('[data-sel-copy]').addEventListener('click', async () => {
    const c = card.querySelector('.sel-learn-body')?.innerText || '';
    const ok = await copyText(c);
    toast(ok ? '📋 已复制' : '❌ 复制失败，请长按选中内容手动复制');
  });
  /* v2.3.3：多模式切换——以新模式重新请求，并发序号保证只显示最后一次结果 */
  card.querySelectorAll('.sel-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      card.querySelectorAll('.sel-mode').forEach(b => b.classList.toggle('active', b === btn));
      selLearnRequest(card, btn.dataset.mode, ++selLearnReqSeq);
    });
  });
  /* v2.3.3：一键收进墨墨云词库（Saladict 生词本交互） */
  const collectBtn = card.querySelector('[data-sel-collect]');
  if (collectBtn) collectBtn.addEventListener('click', async () => {
    try {
      await api('/api/selection/collect', { method: 'POST', body: { spelling: text } });
      collectBtn.textContent = '✔ 已收进';
      collectBtn.disabled = true;
      toast('✅ 已收进墨墨云词库');
    } catch (e) {
      toast('❌ ' + e.message);
    }
  });
  selLearnRequest(card, 'define', seq);
}

/* v2.7.2：多端深度拦截长按上下文菜单（捕获阶段强力拦截，阻止出现与气泡抢焦点的系统复制/全选菜单） */
document.addEventListener('contextmenu', e => {
  const target = e.target;
  // 答题框、输入框和弹窗编辑区域不受限制，允许用户正常使用系统原生粘贴/编辑
  if (target && target.closest && target.closest('input, textarea, [contenteditable]')) {
    return;
  }
  // 非输入控件一律拦截原生菜单（气泡内部也一并拦截，避免与自研操作冲突）
  e.preventDefault();
  // v2.7.2.a：Android/部分浏览器长按会稳定触发 contextmenu，这是比 JS 计时器更可靠的 OS 级长按信号；
  // 用它兜底触发取词，避免部分真机 touchstart 计时器被 touchcancel/滚动手势吞掉导致「划线不显示」。
  if (!SEL_TOUCH_DEVICE) return;
  if (selLearnBtn && (e.target === selLearnBtn || selLearnBtn.contains(e.target))) return;
  if (selLearnCard && selLearnCard.contains(e.target)) return;
  if (selDictCard && selDictCard.contains(e.target)) return;
  if (selLearnPickAtPoint(e.clientX, e.clientY)) {
    selLearnSuppressNextClick = true;
    if (touchPickTimer) { clearTimeout(touchPickTimer); touchPickTimer = null; }
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
  }
}, { capture: true }); // 使用 capture 捕获阶段，防止被子元素冒泡阻止

/* v2.7.2.a：点按气泡/卡片以外的空白处 → 收起浮动气泡（触摸端无原生选区事件可依赖）
   注意：长按取词抬手时浏览器会补发一次 click，必须跳过它，否则气泡会被立即收起（真机「划线不显示」真凶）。
   用一次性标志而非时间窗判定，兼容任意时长的长按。 */
let selLearnSuppressNextClick = false;
document.addEventListener('click', e => {
  if (e.target === selLearnBtn || selLearnBtn?.contains(e.target)) return;
  if (e.target === selLearnCard || selLearnCard?.contains(e.target)) return;
  if (e.target === selDictCard || selDictCard?.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.sel-learn-handle')) return;
  if (selLearnSuppressNextClick) { selLearnSuppressNextClick = false; return; }
  if (selLearnBtn) selLearnRemoveBtn();
}, true);

/* 选区变化 → 显示浮动按钮（PC 鼠标 / 移动端长按划选均覆盖） */
function selLearnOnSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selLearnRemoveBtn();
    return;
  }
  const text = sel.toString().trim();
  if (!text || text.length < 1 || text.length > 600) {
    selLearnRemoveBtn();
    return;
  }
  if (!/[\u4e00-\u9fa5]/.test(text) && !/[A-Za-z]/.test(text)) {
    selLearnRemoveBtn();
    return;
  }
  const range = sel.getRangeAt(0);
  const root = selLearnInReadable(range.commonAncestorContainer);
  if (!root) {
    selLearnRemoveBtn();
    return;
  }
  const cac = range.commonAncestorContainer;
  const cacEl = cac.nodeType === 1 ? cac : cac.parentElement;
  if (cacEl?.closest('input, textarea, .sel-learn-card, .kb-fix-modal')) {
    selLearnRemoveBtn();
    return;
  }
  let rect;
  try { rect = range.getBoundingClientRect(); } catch { return; }
  if (!rect || (!rect.width && !rect.height)) return;
  const ridEl = cacEl?.closest?.('[data-rid]');
  let sourceRef = null;
  if (ridEl && ridEl.dataset.rid) {
    sourceRef = {
      rid: ridEl.dataset.rid,
      sourceKind: ridEl.dataset.sourceKind || null,
      year: ridEl.dataset.year ? Number(ridEl.dataset.year) : null,
      section: ridEl.dataset.section || null,
      sentence: text,
    };
  }
  selLearnState = { text, context: selLearnContextOf(range, root), title: selLearnTitleOf(root), kind: selLearnKindOf(text), rect, sourceRef, mode: 'define' };
  selLearnShowBtn(rect);
}

/* ---------- v2.7.2.a：触摸设备「长按取词」——原生文本选择已全局禁用，改由长按手势接管 ---------- */
const SEL_TOUCH_DEVICE = (() => {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return 'ontouchstart' in window; }
})();

function selLearnCaretAt(x, y) {
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) return r;
  }
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { const r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); return r; }
  }
  return null;
}

/** v2.7.2.a：部分真机 caretRangeFromPoint 返回元素节点，回退到 elementFromPoint 内的最近文本节点 */
function selLearnTextNodeAt(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  let node = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue || '';
    if (t.trim()) { node = n; break; }
  }
  if (node) return { node, offset: 0 };
  return null;
}

/** v2.7.2.c：取触点处的 {node, offset}（caret 命中优先，真机返回元素节点时按水平距离估算）
    自绘手柄/高亮/气泡浮在文字之上会挡住命中测试，故测量期间临时让其 pointer-events:none。 */
function selLearnPointAt(clientX, clientY) {
  const overlays = [selLearnHandleStart, selLearnHandleEnd, selLearnBtn, ...selLearnHlNodes].filter(Boolean);
  const saved = overlays.map(el => el.style.pointerEvents);
  overlays.forEach(el => { el.style.pointerEvents = 'none'; });
  let caret = null, fb = null;
  try {
    caret = selLearnCaretAt(clientX, clientY);
    if (!(caret && caret.startContainer && caret.startContainer.nodeType === 3)) {
      fb = selLearnTextNodeAt(clientX, clientY);
    }
  } finally {
    overlays.forEach((el, i) => { el.style.pointerEvents = saved[i]; });
  }
  if (caret && caret.startContainer && caret.startContainer.nodeType === 3) {
    return { node: caret.startContainer, offset: caret.startOffset };
  }
  if (!fb) return null;
  const n = fb.node, t = n.nodeValue || '';
  let best = 0, bestDx = Infinity;
  try {
    for (let i = 0; i <= t.length; i++) {
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, Math.min(t.length, i + 1));
      const rc = r.getBoundingClientRect();
      if (!rc || (!rc.width && !rc.height)) continue;
      const dx = Math.abs(rc.left - clientX);
      if (dx < bestDx) { bestDx = dx; best = i; }
    }
  } catch { best = 0; }
  return { node: n, offset: best };
}

/** v2.7.2.c：比较两个 {node,offset} 的文档顺序（-1/0/1） */
function selLearnCmpPoint(a, b) {
  try {
    const ra = document.createRange(); ra.setStart(a.node, a.offset); ra.collapse(true);
    const rb = document.createRange(); rb.setStart(b.node, b.offset); rb.collapse(true);
    return ra.compareBoundaryPoints(Range.START_TO_START, rb);
  } catch { return 0; }
}

/** v2.7.2.c：按 anchor/focus 构建规范化的 DOM Range */
function selLearnBuildRange() {
  const st = selLearnState;
  if (!st || !st.anchor || !st.focus) return null;
  const cmp = selLearnCmpPoint(st.anchor, st.focus);
  const a = cmp <= 0 ? st.anchor : st.focus;
  const b = cmp <= 0 ? st.focus : st.anchor;
  const r = document.createRange();
  try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch { return null; }
  return r;
}

function selLearnRectsOf(range) {
  try {
    const list = Array.from(range.getClientRects()).filter(r => r.width || r.height);
    if (list.length) return list;
    const b = range.getBoundingClientRect();
    return (b && (b.width || b.height)) ? [b] : [];
  } catch { return []; }
}

/** v2.7.2.c：把当前 anchor/focus 同步到 state / 高亮 / 手柄 / 气泡（拖拽与扩展共用） */
function selLearnSyncSelection() {
  const st = selLearnState;
  const range = selLearnBuildRange();
  if (!st || !range) return false;
  const picked = range.toString().trim();
  if (!picked) return false;
  st.range = range.cloneRange();
  st.text = picked;
  st.kind = selLearnKindOf(picked);
  const rects = selLearnRectsOf(range);
  const bounding = range.getBoundingClientRect();
  st.rect = (bounding && (bounding.width || bounding.height)) ? bounding : (rects[0] || st.rect);
  st.rects = rects;
  if (st.sourceRef) st.sourceRef.sentence = picked;
  selLearnShowBtn(st.rect, rects);
  return true;
}

/** 触摸长按取词：判定触点下的单词/中文短语，构建选区并升起浮动气泡+可拖拽端点手柄 */
function selLearnPickAtPoint(clientX, clientY) {
  const pt = selLearnPointAt(clientX, clientY);
  if (!pt) return false;
  const node = pt.node;
  const root = selLearnInReadable(node);
  if (!root) return false;
  const cacEl = node.parentElement;
  if (cacEl?.closest('input, textarea, .sel-learn-card, .kb-fix-modal')) return false;

  const text = node.nodeValue || '';
  let offset = Math.min(pt.offset, Math.max(0, text.length - 1));
  const LATIN = /[A-Za-z0-9'’\-]/;
  const CN = /[\u4e00-\u9fa5]/;
  const isWord = ch => LATIN.test(ch) || CN.test(ch);
  if (!isWord(text[offset] || '') && offset > 0 && isWord(text[offset - 1] || '')) offset--;

  let start = offset, end = offset + 1;
  if (LATIN.test(text[offset] || '')) {
    // 英文/数字：整词扩展
    while (start > 0 && LATIN.test(text[start - 1])) start--;
    while (end < text.length && LATIN.test(text[end])) end++;
  } else if (CN.test(text[offset] || '')) {
    // 中文：取以标点/空白分隔的短句（最多 10 字）
    const BREAK = /[\s，。！？；：、“”‘’（）()《》【】,.!?;:]/;
    while (start > 0 && !BREAK.test(text[start - 1]) && offset - start < 10) start--;
    while (end < text.length && !BREAK.test(text[end]) && end - start < 10) end++;
  } else {
    // 标点/空白：选中整个非空白串
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    while (end < text.length && !/\s/.test(text[end])) end++;
  }
  const picked = text.slice(start, end).trim();
  if (!picked) return false;

  const ridEl = cacEl?.closest?.('[data-rid]');
  let sourceRef = null;
  if (ridEl && ridEl.dataset.rid) {
    sourceRef = {
      rid: ridEl.dataset.rid,
      sourceKind: ridEl.dataset.sourceKind || null,
      year: ridEl.dataset.year ? Number(ridEl.dataset.year) : null,
      section: ridEl.dataset.section || null,
      sentence: picked,
    };
  }
  selLearnState = {
    text: picked,
    context: selLearnContextOf({ startContainer: node }, root),
    title: selLearnTitleOf(root),
    kind: selLearnKindOf(picked),
    rect: null, rects: null, range: null,
    anchor: { node, offset: start },
    focus: { node, offset: end },
    root,
    sourceRef, mode: 'define',
  };
  return selLearnSyncSelection();
}

/** v2.7.2.c：把一个 {node,offset} 扩展为所在整句的 [start,end] */
function selLearnSentenceSpanAt(node, offset) {
  const full = node.nodeValue || '';
  const BREAK = /[.!?。！？…\n]/;
  let s = Math.min(offset, full.length), e = Math.min(offset, full.length);
  while (s > 0 && !BREAK.test(full[s - 1])) s--;
  while (e < full.length && !BREAK.test(full[e])) e++;
  while (s < e && /\s/.test(full[s])) s++;
  while (e > s && /\s/.test(full[e - 1])) e--;
  return { start: s, end: e };
}

/** v2.7.2.a/c：把当前取词双向扩展到整句（触摸端「整句」按钮） */
function selLearnExpandToSentence() {
  const st = selLearnState;
  if (!st || !st.anchor || !st.focus) return false;
  if (st.anchor.node !== st.focus.node) return false;
  const node = st.anchor.node;
  const a = Math.min(st.anchor.offset, st.focus.offset);
  const b = Math.max(st.anchor.offset, st.focus.offset);
  const full = node.nodeValue || '';
  const BREAK = /[.!?。！？…\n]/;
  let s = a, e = b;
  while (s > 0 && !BREAK.test(full[s - 1])) s--;
  while (e < full.length && !BREAK.test(full[e])) e++;
  while (s < e && /\s/.test(full[s])) s++;
  while (e > s && /\s/.test(full[e - 1])) e--;
  if (e <= s) return false;
  st.anchor = { node, offset: s };
  st.focus = { node, offset: e };
  return selLearnSyncSelection();
}

/* v2.7.2.c：端点手柄拖拽 → 自由拉伸选区（原生选择手柄已被禁用，自绘替代） */
function selLearnHandleTouchStart(e) {
  if (!selLearnState || !selLearnState.anchor) return;
  e.preventDefault();
  e.stopPropagation();
  selLearnDragIdx = e.currentTarget.dataset.idx;
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
}
function selLearnHandleTouchMove(e) {
  if (selLearnDragIdx == null || !selLearnState) return;
  e.preventDefault();
  e.stopPropagation();
  const t = e.touches[0];
  if (!t) return;
  const pt = selLearnPointAt(t.clientX, t.clientY);
  if (!pt) return;
  const st = selLearnState;
  const root = st.root;
  if (!root || !root.contains(pt.node)) return;
  if (selLearnDragIdx === '0') st.anchor = pt; else st.focus = pt;
  selLearnSyncSelection();
}
function selLearnHandleTouchEnd(e) {
  if (selLearnDragIdx == null) return;
  e.preventDefault();
  e.stopPropagation();
  selLearnDragIdx = null;
  if (selLearnState) selLearnSyncSelection();
}

/* 滚动时清除触摸端高亮/手柄/气泡（fixed 定位不会跟随滚动，避免残留错位） */
window.addEventListener('scroll', () => {
  if (!SEL_TOUCH_DEVICE) return;
  if (selLearnBtn || selLearnHandleStart) selLearnRemoveBtn();
}, { passive: true });

let touchPickTimer = null, touchStartPt = null, touchMoved = false;
document.addEventListener('touchstart', e => {
  // 点按气泡/精读卡/端点手柄：交给其自身处理，不参与长按取词，也不关闭气泡
  if (selLearnBtn && (e.target === selLearnBtn || selLearnBtn.contains(e.target))) return;
  if (selLearnCard && selLearnCard.contains(e.target)) return;
  if (selDictCard && selDictCard.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.sel-learn-handle, input, textarea, select, [contenteditable], button, .btn')) return;
  if (!SEL_TOUCH_DEVICE) return;
  selLearnSuppressNextClick = false;   // 新手势开始，清掉上一次的补发 click 豁免
  if (e.touches.length !== 1) { if (touchPickTimer) clearTimeout(touchPickTimer); touchPickTimer = null; return; }
  const t = e.touches[0];
  touchStartPt = { x: t.clientX, y: t.clientY };
  touchMoved = false;
  if (touchPickTimer) clearTimeout(touchPickTimer);
  touchPickTimer = setTimeout(() => {
    touchPickTimer = null;
    if (touchMoved || !touchStartPt) return;
    const ok = selLearnPickAtPoint(touchStartPt.x, touchStartPt.y);
    if (ok) {
      // 长按取词成功后抬手会补发一次 click，标记跳过，避免气泡被立即收起
      selLearnSuppressNextClick = true;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
    }
  }, 420);
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (!touchStartPt) return;
  const t = e.touches[0];
  if (!t) return;
  if (Math.abs(t.clientX - touchStartPt.x) > 10 || Math.abs(t.clientY - touchStartPt.y) > 10) {
    touchMoved = true;
    if (touchPickTimer) { clearTimeout(touchPickTimer); touchPickTimer = null; }
  }
}, { passive: true });

function selLearnTouchReset() {
  if (touchPickTimer) { clearTimeout(touchPickTimer); touchPickTimer = null; }
  touchStartPt = null;
}
document.addEventListener('touchend', selLearnTouchReset, { passive: true });
document.addEventListener('touchcancel', selLearnTouchReset, { passive: true });

/* ---------- 桌面端：鼠标划选 / 双击查词（触摸设备走上面的长按取词） ---------- */
document.addEventListener('mouseup', e => {
  if (SEL_TOUCH_DEVICE) return;
  if (selLearnBtn && (e.target === selLearnBtn || selLearnBtn.contains(e.target))) return;
  setTimeout(selLearnOnSelection, 10);
});

// 选区变化：仅桌面端跟随；触摸设备不再依赖原生选区
let selChangeTimer = null;
document.addEventListener('selectionchange', () => {
  if (SEL_TOUCH_DEVICE) return;
  if (selChangeTimer) clearTimeout(selChangeTimer);
  selChangeTimer = setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      selLearnRemoveBtn();
    } else {
      selLearnOnSelection();
    }
  }, 200);
});

document.addEventListener('mousedown', e => {
  if (SEL_TOUCH_DEVICE) return;
  if (selLearnBtn && (e.target === selLearnBtn || selLearnBtn.contains(e.target))) return;
  if (selLearnCard && selLearnCard.contains(e.target)) return;
  if (selDictCard && selDictCard.contains(e.target)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { selLearnRemoveBtn(); }
  }, 120);
});
/* v2.3.3：双击查词（Saladict 经典交互）——双击选词后自动弹出精读条 */
/* v2.4.1：全站放行——不在编辑件/弹窗内即可触发 */
document.addEventListener('dblclick', e => {
  if (SEL_TOUCH_DEVICE) return;   // v2.7.2.a：触摸端走「长按取词」，避免双击/双指缩放误触发
  if (!e.target || typeof e.target.closest !== 'function') return;
  if (e.target.closest('input, textarea, select, [contenteditable], .sel-learn-card, .kb-fix-modal, .modal-mask, button, .btn')) return;
  setTimeout(selLearnOnSelection, 30);
});
/* v2.3.3：Esc 关闭解析卡片（nextai-translator / 沉浸式翻译通用手势） */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && selLearnCard) {
    selLearnCloseCard();
    selLearnRemoveBtn();
  }
});

/* ---------------- v2.2.5：长难句三遍法训练 ---------------- */

const stState = {
  attemptId: null,
  mode: 'first',       // first | review
  text: '',
  context: '',
  title: '',
  sourceRef: null,
  triggeredBy: null,
};

function stEl(id) { return document.getElementById(id); }

function stOpen(opts = {}) {
  const overlay = stEl('stOverlay');
  if (!overlay) return;
  stState.mode = opts.mode || 'first';
  stState.attemptId = opts.attemptId || null;
  stState.text = opts.text || '';
  stState.context = opts.context || '';
  stState.title = opts.title || '';
  stState.sourceRef = opts.sourceRef || null;
  stState.triggeredBy = opts.triggeredBy || document.activeElement;

  stEl('stSource').textContent = opts.title ? `材料：${opts.title}` : (opts.sourceLabel || '');
  stEl('stSentence').textContent = opts.text || '';
  stEl('stStructure').value = opts.structure || '';
  stEl('stTranslation').value = opts.translation || '';
  stEl('stMsg').textContent = '';
  stEl('stMsg').className = 'result';
  stEl('stInputPane').style.display = 'block';
  stEl('stFeedbackPane').style.display = 'none';
  stEl('stFeedback').innerHTML = '';
  stEl('stSubmitBtn').disabled = false;
  stEl('stSubmitBtn').textContent = stState.mode === 'review' ? '提交复测，看对比反馈' : '提交，看 AI 分层反馈';
  overlay.style.display = 'flex';
  setTimeout(() => { const s = stEl('stStructure'); if (s) s.focus(); }, 30);
}

function stClose() {
  const overlay = stEl('stOverlay');
  if (overlay) overlay.style.display = 'none';
  const back = stState.triggeredBy;
  if (back && back.focus) { try { back.focus(); } catch {} }
}

/** 从仪表盘待复测任务打开（attemptId 为待复测记录 id） */
function stOpenReview(reviewAttemptId, prompt, meta) {
  const m = meta || {};
  stOpen({
    mode: 'review',
    attemptId: reviewAttemptId,
    text: prompt,
    title: m.title || '',
    sourceLabel: m.verifiedSource ? '真题/语料复测' : '手动选句复测',
    triggeredBy: document.activeElement,
  });
}

/** v2.2.8：从仪表盘待重试首答打开（attemptId 为 LLM 失败的首答记录，重做首答） */
function stOpenRetry(attemptId, prompt) {
  stOpen({
    mode: 'first',
    attemptId,
    text: prompt,
    sourceLabel: '首答重做（上次 AI 反馈生成失败）',
    triggeredBy: document.activeElement,
  });
}

async function stEnsureAttempt() {
  if (stState.attemptId) return stState.attemptId;
  const sourceRef = stState.sourceRef || null;
  const r = await api('/api/learning/sentence/start', {
    method: 'POST',
    body: {
      text: stState.text,
      context: stState.context || '',
      title: stState.title || '',
      sourceRef,
    },
  });
  stState.attemptId = r.attemptId;
  return r.attemptId;
}

async function stSubmit() {
  const structure = stEl('stStructure').value.trim();
  const translation = stEl('stTranslation').value.trim();
  const msg = stEl('stMsg');
  if (structure.length < 2 || translation.length < 2) {
    msg.textContent = '⚠️ 结构和自译都要填写后再提交';
    msg.className = 'result err';
    return;
  }
  const btn = stEl('stSubmitBtn');
  msg.textContent = 'AI 正在生成分层反馈…';
  msg.className = 'result';
  btn.disabled = true;
  let attemptId;
  try {
    attemptId = await stEnsureAttempt();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
    btn.disabled = false;
    return;
  }
  try {
    const r = await api('/api/learning/sentence/submit', {
      method: 'POST',
      body: {
        attemptId,
        structure,
        translation,
        startedAt: new Date().toISOString(),
      },
    });
    stEl('stFeedback').innerHTML = mdLite(r.feedback || '（无反馈）');
    stEl('stInputPane').style.display = 'none';
    stEl('stFeedbackPane').style.display = 'block';
    stEl('stReviewNote').innerHTML = r.isReview
      ? '<div class="hint">✅ 复测完成，对比结果见「复测对比」小节。</div>'
      : (r.dueAt ? `<div class="hint">📅 已安排 3 天后复测（${fmtBJ(r.dueAt)} 到期），届时可从仪表盘「待复测」进入。</div>` : '');
    // 反馈后不提供修改，防止刷分
    stState.attemptId = attemptId;
  } catch (e) {
    msg.textContent = '❌ ' + e.message + (e.message.includes('已保存') ? '（可再次点击提交重试）' : '');
    msg.className = 'result err';
    btn.disabled = false;
  }
}

if (stEl('stSubmitBtn')) stEl('stSubmitBtn').addEventListener('click', stSubmit);
if (stEl('stCloseBtn')) stEl('stCloseBtn').addEventListener('click', stClose);
if (stEl('stContinueBtn')) stEl('stContinueBtn').addEventListener('click', stClose);
if (stEl('stOverlay')) {
  stEl('stOverlay').addEventListener('click', e => { if (e.target === stEl('stOverlay')) stClose(); });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && stEl('stOverlay') && stEl('stOverlay').style.display !== 'none') {
    stClose();
  }
});
/* ---------------- 单词测验（v1.0.4：主动回忆 / v2.2.1：单题流水与三级信心） ---------------- */

const quiz = {
  running: false,
  src: 'today',
  mode: 'flash',
  items: [],
  idx: 0,
  results: [],
  distractorPool: [],
  lastConfidence: 'unsure',   // v3.2.1：最近一题智能推断的信心（供会话暂存）
  itemStartedAt: null,
  submode: 'basic',
  advanceTimer: null,
  sessionStartedAt: null,
  pausedMs: 0,
  pauseStartedAt: null,
  srsMeta: {},        // v2.10.0：spelling -> { mastery, wrongStage, source }
  adaptive: false,    // v2.11.0：是否为自适应组卷会话
  sessionId: null,    // v2.11.0：服务端会话 ID（会话韧性）
  difficulty: 'normal',
  adaptiveKinds: ['flash', 'choice'],   // v2.11.0：交错题型开关（默认与「标准」档一致）
  saveTimer: null,
  aiDistractors: false,                 // v2.12.0：AI 增强干扰项
};

/* v2.12.0：统计看板状态 */
const stats = { days: 7, data: null };

/* v2.10.0：错题复练状态（自维护 SRS + 错题本） */
const srs = {
  running: false,
  filter: 'all',
  items: [],
  idx: 0,
  results: [],
  itemStartedAt: null,
  advanceTimer: null,
  overview: null,
  sessionStartedAt: null,
  pausedMs: 0,
  pauseStartedAt: null,
};

/** 4 档评分定义（Anki 式） */
const QUIZ_GRADES = [
  { key: 'again', label: '😵 忘记', cls: 'g-again', hint: '完全想不起，再来' },
  { key: 'hard', label: '😕 吃力', cls: 'g-hard', hint: '想起来了但很费劲' },
  { key: 'good', label: '😊 掌握', cls: 'g-good', hint: '顺利想起' },
  { key: 'easy', label: '😎 轻松', cls: 'g-easy', hint: '脱口而出，太简单' },
];

/* v2.2.4：真题迁移训练状态 */
const transfer = {
  running: false,
  src: 'forget',
  kinds: { context: true, cloze: true },
  questions: [],
  idx: 0,
  results: [],
  itemStartedAt: null,
  confidence: 'unsure',
  answered: false,
  advanceTimer: null,
};

// 二级模式切换
$$('#quizSubmode .quiz-submode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#quizSubmode .quiz-submode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    quiz.submode = btn.dataset.submode;
    $('#quizBasicPane').style.display = quiz.submode === 'basic' ? 'block' : 'none';
    $('#quizSrsPane').style.display = quiz.submode === 'srs' ? 'block' : 'none';
    $('#quizTransferPane').style.display = quiz.submode === 'transfer' ? 'block' : 'none';
    if (quiz.submode === 'srs') loadSrsOverview();
    try { loadQuizSourceCounts(); } catch {}   // v3.2.1：切子模式刷新词源/复练计数
  });
});

/* v2.10.0：错题复练 —— 概览 / 错题本列表 */
$$('#quizSrsFilter .chip').forEach(c => c.addEventListener('click', () => {
  $$('#quizSrsFilter .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  srs.filter = c.dataset.sfilter;
  loadSrsOverview();
}));
if ($('#quizSrsRefreshBtn')) $('#quizSrsRefreshBtn').addEventListener('click', loadSrsOverview);
if ($('#quizSrsStartBtn')) $('#quizSrsStartBtn').addEventListener('click', startSrs);

function renderSrsOverview(data) {
  const box = $('#quizSrsOverview');
  if (!box) return;
  const ov = data.overview || {};
  const dist = ov.masteryDist || {};
  const total = Number(ov.trackedWords || 0);
  const distBar = [0, 1, 2, 3, 4].map(lv => {
    const n = Number(dist[String(lv)] || 0);
    const pct = total > 0 ? Math.round(n / total * 100) : 0;
    return `<div class="srs-dist-seg lv-${lv}" style="width:${pct}%" title="掌握度 ${lv}：${n} 词"></div>`;
  }).join('');
  box.innerHTML = `
    <div class="srs-stat-row">
      <span class="srs-stat"><b>${total}</b> 追踪词</span>
      <span class="srs-stat ${ov.dueCount ? 'warn' : ''}"><b>${ov.dueCount || 0}</b> 记忆到期</span>
      <span class="srs-stat ${ov.wrongBookDue ? 'warn' : ''}"><b>${ov.wrongBookDue || 0}</b> 错题待复练</span>
      <span class="srs-stat"><b>${ov.wrongBookTotal || 0}</b> 错题本在册</span>
      <span class="srs-stat">平均易度 <b>${ov.avgEase == null ? '—' : ov.avgEase}</b></span>
    </div>
    <div class="srs-dist-bar">${total > 0 ? distBar : '<div class="hint">尚无记忆数据，先做一轮基础测验或复练</div>'}</div>
    <div class="srs-dist-legend">
      <span class="lv-0">错题 0</span><span class="lv-1">1 级</span><span class="lv-2">2 级</span>
      <span class="lv-3">3 级</span><span class="lv-4">已掌握 4</span>
    </div>`;
  renderWrongbookList(data.wrongbook || []);
}

function renderWrongbookList(items) {
  const box = $('#quizWrongbookList');
  if (!box) return;
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="card-title" style="margin-top:12px">📕 错题本（${items.length}）</div>
    <div class="wb-list">${items.map(it => `
      <div class="wb-item wb-item-rich" data-word="${esc(it.spelling)}">
        <div class="wb-line">
          <span class="wb-word">${esc(it.spelling)}</span>
          <span class="wb-meta">错 ${it.wrongCount || 0} 次 · 阶段 ${it.stage || 0}/4${it.nextDueAt ? ' · 下次 ' + fmtBJ(it.nextDueAt).slice(5, 16) : ''}</span>
          <span class="wb-actions">
            <button type="button" class="btn mini ghost wb-explain" data-word="${esc(it.spelling)}">💡 讲解</button>
            <button type="button" class="btn mini ghost wb-mnemonic" data-word="${esc(it.spelling)}">📝 助记</button>
            <button type="button" class="btn mini ghost wb-example" data-word="${esc(it.spelling)}">📚 例句</button>
            <button type="button" class="btn mini ghost wb-resolve" data-word="${esc(it.spelling)}">✓ 已掌握</button>
            <button type="button" class="btn mini ghost wb-remove" data-word="${esc(it.spelling)}">✕</button>
          </span>
        </div>
        <div class="ai-explain-box" style="display:none"></div>
        <div class="ai-example-box" style="display:none"></div>
      </div>`).join('')}</div>`;
  $$('#quizWrongbookList .wb-resolve').forEach(b => b.addEventListener('click', async () => {
    try { await api('/api/quiz/wrongbook/resolve', { method: 'POST', body: { spelling: b.dataset.word } }); toast('已标记掌握'); loadSrsOverview(); }
    catch (e) { toast('操作失败：' + e.message); }
  }));
  $$('#quizWrongbookList .wb-remove').forEach(b => b.addEventListener('click', async () => {
    try { await api('/api/quiz/wrongbook/remove', { method: 'POST', body: { spelling: b.dataset.word } }); toast('已移除'); loadSrsOverview(); }
    catch (e) { toast('操作失败：' + e.message); }
  }));
  $$('#quizWrongbookList .wb-explain').forEach(b => b.addEventListener('click', () => {
    const box = b.closest('.wb-item-rich').querySelector('.ai-explain-box');
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    aiExplainInto(b.dataset.word, box, { correct: false });
  }));
  $$('#quizWrongbookList .wb-mnemonic').forEach(b => b.addEventListener('click', () => aiMnemonicFor(b.dataset.word, b)));
  $$('#quizWrongbookList .wb-example').forEach(b => b.addEventListener('click', () => {
    const box = b.closest('.wb-item-rich').querySelector('.ai-example-box');
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    box.style.display = '';
    loadQuizExamples(b.dataset.word, box);
  }));
}

async function loadSrsOverview() {
  const box = $('#quizSrsOverview');
  if (box) box.innerHTML = '<div class="hint">加载记忆状态…</div>';
  try {
    const filter = srs.filter === 'all' ? 'all' : srs.filter;
    const data = await api('/api/quiz/srs?filter=' + encodeURIComponent(filter));
    srs.overview = data.overview;
    // 错题本列表始终展示全量（不受 filter 影响）：错题本单独拉取
    const wb = await api('/api/quiz/wrongbook');
    data.wrongbook = wb.items || [];
    renderSrsOverview(data);
  } catch (e) {
    if (box) box.innerHTML = `<div class="result err">记忆状态加载失败：${esc(e.message)}</div>`;
  }
}

/* ================= v2.12.0：统计看板 + AI 增强 ================= */

const QUIZ_KIND_LABELS = { flash: '🃏 闪卡', choice: '🔤 四选一', spell: '⌨️ 拼写', zh2en: '🀄 看中选英', audio: '🔊 听音辨义', srs: '🔁 复练' };

$$('#quizStatsPane [data-statsdays]').forEach(c => c.addEventListener('click', () => {
  $$('#quizStatsPane [data-statsdays]').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  stats.days = Number(c.dataset.statsdays) || 7;
  loadQuizStats();
}));
if ($('#quizStatsRefreshBtn')) $('#quizStatsRefreshBtn').addEventListener('click', loadQuizStats);

async function loadQuizStats() {
  const box = $('#quizStatsBoard');
  const msg = $('#quizStatsMsg');
  if (box) box.innerHTML = '<div class="hint">加载统计…</div>';
  if (msg) msg.textContent = '';
  try {
    const d = await api('/api/quiz/stats?days=' + stats.days);
    stats.data = d;
    renderQuizStats(d);
  } catch (e) {
    if (box) box.innerHTML = `<div class="result err">统计加载失败：${esc(e.message)}</div>`;
  }
}

function renderQuizStats(d) {
  const box = $('#quizStatsBoard');
  if (!box) return;
  const dist = d.masteryDist || {};
  const total = Number(d.trackedWords || 0);
  const distBar = [0, 1, 2, 3, 4].map(lv => {
    const n = Number(dist[String(lv)] || 0);
    const pct = total > 0 ? Math.round(n / total * 100) : 0;
    return `<div class="srs-dist-seg lv-${lv}" style="width:${pct}%" title="掌握度 ${lv}：${n} 词"></div>`;
  }).join('');

  // 正确率趋势（迷你柱状图）
  const trend = d.accuracyTrend || [];
  const maxRate = 100;
  const bars = trend.map(t => {
    const h = t.rate == null ? 0 : Math.max(4, Math.round(t.rate / maxRate * 72));
    const cls = t.rate == null ? 'empty' : (t.rate >= 80 ? 'good' : t.rate >= 60 ? 'mid' : 'low');
    const label = t.date.slice(5);
    const tip = t.total ? `${label}：${t.correct}/${t.total}（${t.rate}%）` : `${label}：无作答`;
    return `<div class="acc-bar-wrap" title="${esc(tip)}"><div class="acc-bar ${cls}" style="height:${h}px"></div><span class="acc-lbl">${esc(label.slice(3))}</span></div>`;
  }).join('');

  // 题型正确率
  const kindRows = (d.kindRates || []).map(k => {
    const rate = k.rate == null ? '—' : k.rate + '%';
    return `<div class="kind-rate-row"><span class="kr-name">${QUIZ_KIND_LABELS[k.kind] || esc(k.kind)}</span>
      <span class="kr-bar"><i style="width:${k.rate == null ? 0 : k.rate}%"></i></span>
      <span class="kr-val">${rate} <span class="kr-sub">(${k.correct}/${k.total})</span></span></div>`;
  }).join('') || '<div class="hint">尚无题型作答数据</div>';

  const wb = d.wrongBook || {};
  const wc = wb.byWrongCount || {};
  const stageBars = (wb.byStage || []).map((n, i) =>
    `<div class="wb-stage-seg s${i}" style="flex:${n}"><span>${n}</span></div>`).join('');

  box.innerHTML = `
    <div class="stats-grid">
      <div class="stats-card">
        <div class="stats-card-title">🧠 掌握度分布</div>
        <div class="srs-dist-bar">${total > 0 ? distBar : '<div class="hint">尚无记忆数据</div>'}</div>
        <div class="srs-dist-legend">
          <span class="lv-0">错题 ${dist['0'] || 0}</span><span class="lv-1">1级 ${dist['1'] || 0}</span>
          <span class="lv-2">2级 ${dist['2'] || 0}</span><span class="lv-3">3级 ${dist['3'] || 0}</span>
          <span class="lv-4">已掌握 ${dist['4'] || 0}</span>
        </div>
        <div class="stats-sub">追踪 ${total} 词 · <b class="${d.dueCount ? 'warn' : ''}">${d.dueCount || 0}</b> 记忆到期</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-title">🔥 连续学习 <b>${d.streakDays || 0}</b> 天</div>
        <div class="stats-sub">错题本在册 <b>${wb.active || 0}</b> · 已掌握 <b>${wb.resolved || 0}</b></div>
        <div class="wb-count-row">
          <span class="wb-count-item">错 1 次 <b>${wc['1'] || 0}</b></span>
          <span class="wb-count-item">错 2 次 <b>${wc['2'] || 0}</b></span>
          <span class="wb-count-item">错 3+ 次 <b>${wc['3+'] || 0}</b></span>
        </div>
        <div class="stats-card-title" style="font-size:12.5px;margin-top:8px">复练阶段分布（0→3）</div>
        <div class="wb-stage-bar">${wb.active ? stageBars : '<div class="hint">错题本为空</div>'}</div>
      </div>
    </div>
    <div class="stats-card">
      <div class="stats-card-title">📈 近 ${d.windowDays} 天正确率趋势</div>
      <div class="acc-chart">${bars || '<div class="hint">无数据</div>'}</div>
      <div class="acc-legend"><span class="lg good"></span>≥80% <span class="lg mid"></span>60–79% <span class="lg low"></span>&lt;60%</div>
    </div>
    <div class="stats-card">
      <div class="stats-card-title">🎯 分题型正确率</div>
      <div class="kind-rate-list">${kindRows}</div>
    </div>`;
}

/** ⑤ 外刊/真题真实例句 */
async function loadQuizExamples(spelling, container) {
  try {
    const d = await api('/api/quiz/ai/examples?spelling=' + encodeURIComponent(spelling));
    const ex = d.examples || [];
    if (!ex.length) { container.innerHTML = '<div class="hint">暂无真题/外刊真实例句</div>'; return; }
    container.innerHTML = ex.map(e => `
      <div class="ai-example">
        <div class="ai-example-text">${esc(e.sentence)}</div>
        <div class="ai-example-src">— ${esc(e.sourceLabel)}${e.title ? ' · ' + esc(e.title) : ''}</div>
      </div>`).join('');
  } catch (e) { container.innerHTML = `<div class="hint">例句加载失败：${esc(e.message)}</div>`; }
}

/** ② 错题讲解（结果页/错题本内联展开） */
async function aiExplainInto(spelling, container, opts = {}) {
  container.style.display = '';
  container.innerHTML = '<div class="hint">🧠 AI 讲解生成中…</div>';
  try {
    const d = await api('/api/quiz/ai/explain', { method: 'POST', body: { spelling, gloss: opts.gloss, userAnswer: opts.userAnswer, correct: opts.correct } });
    if (!d.ok || !d.explain) {
      container.innerHTML = '<div class="hint">讲解暂不可用（AI 未就绪或配额不足），可稍后再试。</div>';
      return;
    }
    container.innerHTML = `<div class="ai-explain md-body">${mdLite(d.explain)}</div>`;
  } catch (e) { container.innerHTML = `<div class="hint">讲解失败：${esc(e.message)}</div>`; }
}

/** ③ 一键助记 */
async function aiMnemonicFor(spelling, btn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '生成中…';
  try {
    const d = await api('/api/quiz/ai/mnemonic', { method: 'POST', body: { spelling } });
    const tag = d.source === 'ai' ? 'AI' : '兜底';
    toast(`已生成助记（${tag}），可在「助记库」查看`);
  } catch (e) { toast('助记生成失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}

/** v2.12.0：结果页 AI 复盘区事件绑定 */
function wireAiReview() {
  const list = $('#aiReviewList');
  if (!list) return;
  list.querySelectorAll('.ai-review-item').forEach(item => {
    const word = item.dataset.word;
    const exBox = item.querySelector('.ai-explain-box');
    const egBox = item.querySelector('.ai-example-box');
    const eb = item.querySelector('.ai-explain-btn');
    const mb = item.querySelector('.ai-mnemonic-btn');
    const gb = item.querySelector('.ai-example-btn');
    if (eb) eb.addEventListener('click', () => {
      if (exBox.style.display !== 'none') { exBox.style.display = 'none'; return; }
      aiExplainInto(word, exBox, { correct: false });
    });
    if (mb) mb.addEventListener('click', () => aiMnemonicFor(word, mb));
    if (gb) gb.addEventListener('click', () => {
      if (egBox.style.display !== 'none') { egBox.style.display = 'none'; return; }
      egBox.style.display = '';
      loadQuizExamples(word, egBox);
    });
  });
}

// 迁移训练词源与题型开关
$$('#transferSources .chip').forEach(c => c.addEventListener('click', () => {
  $$('#transferSources .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  transfer.src = c.dataset.tsrc;
}));
$$('#transferKinds .chip').forEach(c => c.addEventListener('click', () => {
  c.classList.toggle('active');
  transfer.kinds[c.dataset.kind] = c.classList.contains('active');
}));

/* v3.2.1：作答信心由用户手选改为「根据行为智能判断」（耗时 + 正误）。
   真题迁移仍保留手动信心组，不受本改动影响。 */
const CONFIDENCE_LABELS = { sure: '🎯 确定', unsure: '🤔 犹豫', guess: '🎲 猜测' };

function confidenceLabel(conf) { return CONFIDENCE_LABELS[conf] || CONFIDENCE_LABELS.unsure; }

/** 该词的「快答基准时长」：按词长伸缩，用于判定相对快慢 */
function quizConfidenceBaselineMs(spelling) {
  const len = Math.max(1, String(spelling || '').length);
  return Math.min(8000, Math.max(2500, 1200 + len * 180));
}

/**
 * 智能信心推断（纯函数）：
 *  - easy → 确定；
 *  - good → 相对快答→确定，偏慢→犹豫；
 *  - hard → 犹豫（想起来了但吃力）；
 *  - again → 极快→猜测（纯蒙），偏慢→犹豫（有思考仍错）。
 */
function inferQuizConfidence({ grade, durationMs, spelling }) {
  const base = quizConfidenceBaselineMs(spelling);
  const d = Number.isFinite(Number(durationMs)) && Number(durationMs) >= 0 ? Number(durationMs) : base;
  if (grade === 'easy') return 'sure';
  if (grade === 'good') return d <= base ? 'sure' : 'unsure';
  if (grade === 'hard') return 'unsure';
  if (grade === 'again') return d <= base * 0.6 ? 'guess' : 'unsure';
  return 'unsure';
}

/* v3.2.1：自动播报单词（浏览器 TTS）。
   仅对「看英/听音」类题型自动朗读；zh2en（看中选英）与 spell（拼写）会泄露答案，不自动播报。 */
const QUIZ_AUTOSPEAK_KINDS = new Set(['flash', 'choice', 'audio', 'srs']);
const AUTOSPEAK_KEY = 'wb-quiz-autospeak';

function quizAutoSpeakEnabled() {
  try { return localStorage.getItem(AUTOSPEAK_KEY) !== '0'; } catch { return true; }
}

function autoSpeakQuizWord(kind, spelling) {
  if (!spelling) return;
  if (!QUIZ_AUTOSPEAK_KINDS.has(kind)) return;
  if (!quizAutoSpeakEnabled()) return;
  speak(spelling);
}

/* v3.2.1：词源/复练范围 chip 显示具体数目 */
function setChipCount(chip, n) {
  if (!chip) return;
  if (!chip.dataset.baseLabel) chip.dataset.baseLabel = chip.textContent.trim();
  const base = chip.dataset.baseLabel;
  chip.textContent = Number.isFinite(n) ? `${base} · ${n}` : base;
}

async function loadQuizSourceCounts() {
  try {
    const d = await api('/api/quiz/sources');
    const src = d.sources || {};
    $$('#quizSources .chip').forEach(c => {
      const key = c.dataset.src;
      if (key && src[key] != null) setChipCount(c, src[key]);
    });
    const sf = d.srsFilters || {};
    $$('#quizSrsFilter .chip').forEach(c => {
      const key = c.dataset.sfilter;
      if (key && sf[key] != null) setChipCount(c, sf[key]);
    });
    // v4.4.1：页头图版显示「记忆到期 / 错题本」规模
    const dueEl = document.getElementById('quizBandDue');
    const wrongEl = document.getElementById('quizBandWrong');
    if (dueEl && sf.srs_due != null) dueEl.textContent = Number(sf.srs_due).toLocaleString('zh-CN');
    if (wrongEl && sf.wrongbook != null) wrongEl.textContent = Number(sf.wrongbook).toLocaleString('zh-CN');
  } catch { /* 计数失败静默，不阻断测验 */ }
}

/* v2.2.8：迁移训练独立信心组（与基础测验互不复用，避免隐藏状态互相干扰） */
function resetTransferConfidence() {
  transfer.confidence = 'unsure';
  $$('#transferConfidenceGroup .transfer-conf-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.conf === 'unsure');
  });
}

$$('#transferConfidenceGroup .transfer-conf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#transferConfidenceGroup .transfer-conf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    transfer.confidence = btn.dataset.conf || 'unsure';
  });
});

$$('#quizSources .chip').forEach(c => c.addEventListener('click', () => {
  $$('#quizSources .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  quiz.src = c.dataset.src;
}));
$$('#quizModes .chip').forEach(c => c.addEventListener('click', () => {
  $$('#quizModes .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  quiz.mode = c.dataset.mode;
}));

/* v2.11.0：自适应组卷 —— 难度档与交错题型开关 */
$$('#quizDifficulty .chip').forEach(c => c.addEventListener('click', () => {
  $$('#quizDifficulty .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  quiz.difficulty = c.dataset.diff;
  // 联动题型开关到该难度档的默认集合，用户仍可再手动增减
  const preset = { easy: ['flash', 'choice'], normal: ['flash', 'choice', 'spell'], hard: ['flash', 'choice', 'spell', 'zh2en', 'audio'] }[quiz.difficulty] || ['flash'];
  quiz.adaptiveKinds = preset.slice();
  syncAdaptiveKindChips();
}));
$$('#quizAdaptiveKinds .chip').forEach(c => c.addEventListener('click', () => {
  c.classList.toggle('active');
  const k = c.dataset.akind;
  if (c.classList.contains('active')) { if (!quiz.adaptiveKinds.includes(k)) quiz.adaptiveKinds.push(k); }
  else quiz.adaptiveKinds = quiz.adaptiveKinds.filter(x => x !== k);
}));
function syncAdaptiveKindChips() {
  $$('#quizAdaptiveKinds .chip').forEach(c =>
    c.classList.toggle('active', quiz.adaptiveKinds.includes(c.dataset.akind)));
}
if ($('#quizAssembly')) {
  const updateQuizAssembly = () => {
    const adaptive = $('#quizAssembly').value === 'adaptive';
    $('#quizFixedOptions').hidden = adaptive;
    $('#quizAdaptiveFold').hidden = !adaptive;
  };
  $('#quizAssembly').addEventListener('change', updateQuizAssembly);
  updateQuizAssembly();
}
if ($('#quizAiDistractors')) $('#quizAiDistractors').addEventListener('change', e => { quiz.aiDistractors = !!e.target.checked; });

/* v3.2.1：自动播报开关（浏览器本地偏好，默认开启） */
if ($('#quizAutoSpeak')) {
  $('#quizAutoSpeak').checked = quizAutoSpeakEnabled();
  $('#quizAutoSpeak').addEventListener('change', e => {
    try { localStorage.setItem(AUTOSPEAK_KEY, e.target.checked ? '1' : '0'); } catch { /* 忽略 */ }
  });
}

/* v2.11.0：启动时检查是否有可续做的会话 */
async function checkQuizResume() {
  const box = $('#quizResume');
  if (!box) return;
  try {
    const d = await api('/api/quiz/session');
    if (!d.resume || d.resume.expired) { box.style.display = 'none'; return; }
    const r = d.resume;
    box.style.display = '';
    box.innerHTML = `
      <span class="qr-text">📌 上次自适应组卷未完成（${r.idx}/${r.total} 题${r.answered ? ` · 已答 ${r.answered}` : ''}）</span>
      <span class="qr-actions">
        <button type="button" class="btn small primary" id="quizResumeBtn">▶ 继续上次</button>
        <button type="button" class="btn small ghost" id="quizResumeDrop">✕ 放弃</button>
      </span>`;
    $('#quizResumeBtn').addEventListener('click', () => resumeAdaptive());
    $('#quizResumeDrop').addEventListener('click', async () => {
      try { await api('/api/quiz/session/clear', { method: 'POST' }); } catch {}
      box.style.display = 'none';
    });
  } catch { box.style.display = 'none'; }
}

async function resumeAdaptive() {
  const msg = $('#quizMsg');
  msg.textContent = '正在恢复上次组卷…';
  msg.className = 'result';
  try {
    const d = await api('/api/quiz/session');
    if (!d.session || !d.session.items?.length) {
      msg.textContent = '⚠️ 上次会话已失效，请重新组卷';
      msg.className = 'result err';
      checkQuizResume();
      return;
    }
    const sess = d.session;
    quiz.items = sess.items;
    quiz.idx = Math.min(sess.idx || 0, sess.items.length);
    quiz.results = Array.isArray(sess.results) ? sess.results : [];
    quiz.mode = 'adaptive';
    quiz.adaptive = true;
    quiz.sessionId = sess.sessionId;
    quiz.difficulty = sess.config?.difficulty || 'normal';
    quiz.adaptiveKinds = sess.config?.kinds || quiz.adaptiveKinds;
    quiz.sessionStartedAt = sess.sessionStartedAt || new Date().toISOString();
    quiz.pausedMs = sess.pausedMs || 0;
    quiz.pauseStartedAt = null;
    quiz.running = true;
    quiz.srsMeta = {};
    await loadQuizSrsMeta(quiz.items.map(w => w.spelling));
    msg.textContent = '';
    $('#quizSetup').style.display = 'none';
    $('#quizRun').style.display = 'block';
    $('#quizMasteryRow').style.display = 'flex';
    startQuizTimer();
    if (quiz.idx >= quiz.items.length) finishQuiz(); else renderQuizItem();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
  }
}

/** v2.11.0：调服务端自适应组卷并开测 */
async function startAdaptive() {
  const msg = $('#quizMsg');
  msg.textContent = '正在自适应组卷…';
  msg.className = 'result';
  try {
    const count = Math.max(1, Math.floor(Number($('#quizCount').value) || 10));
    const d = await api('/api/quiz/generate', {
      method: 'POST',
      body: { source: quiz.src, count, difficulty: quiz.difficulty, kinds: quiz.adaptiveKinds, aiDistractors: quiz.aiDistractors },
    });
    if (!d.ok) {
      msg.textContent = d.reason === 'too_few_words'
        ? '⚠️ 该词源下单词太少，换个词源或先去学习/同步'
        : '⚠️ 可用释义不足（请检查设置页的 AI 服务商），暂时出不了题';
      msg.className = 'result err';
      return;
    }
    quiz.items = d.items || [];
    quiz.idx = 0;
    quiz.results = [];
    quiz.mode = 'adaptive';
    quiz.adaptive = true;
    quiz.sessionId = d.sessionId;
    quiz.sessionStartedAt = new Date().toISOString();
    quiz.pausedMs = 0;
    quiz.pauseStartedAt = null;
    quiz.running = true;
    quiz.srsMeta = {};
    await loadQuizSrsMeta(quiz.items.map(w => w.spelling));
    msg.textContent = '';
    $('#quizSetup').style.display = 'none';
    $('#quizRun').style.display = 'block';
    $('#quizMasteryRow').style.display = 'flex';
    startQuizTimer();
    renderQuizItem();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
  }
}

/** v2.11.0：会话进度暂存（去抖动，前端逐题调用） */
function scheduleSessionSave() {
  if (!quiz.adaptive || !quiz.sessionId) return;
  if (quiz.saveTimer) { clearTimeout(quiz.saveTimer); quiz.saveTimer = null; }
  quiz.saveTimer = setTimeout(() => { saveSessionNow(); }, 400);
}
async function saveSessionNow() {
  if (!quiz.adaptive || !quiz.sessionId) return;
  try {
    await api('/api/quiz/session/save', {
      method: 'POST',
      body: {
        sessionId: quiz.sessionId,
        idx: quiz.idx,
        results: quiz.results,
        confidence: quiz.lastConfidence || 'unsure',
        pausedMs: quiz.pausedMs || 0,
        pauseStartedAt: quiz.pauseStartedAt || null,
      },
    });
  } catch { /* 静默：暂存失败不打断测验 */ }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

$('#quizStartBtn').addEventListener('click', () => $('#quizAssembly')?.value === 'adaptive' ? startAdaptive() : startQuiz());
$('#quizQuitBtn').addEventListener('click', quitQuiz);

// 测验区的朗读按钮（事件委托）
$('#quizArea').addEventListener('click', (e) => {
  const b = e.target.closest('[data-speak]');
  if (b) speak(b.dataset.speak);
});

async function startQuiz() {
  const msg = $('#quizMsg');
  msg.textContent = '正在准备题目…';
  msg.className = 'result';
  try {
    const d = await api(`/api/words?filter=${quiz.src}`);
    let pool = d.words || [];
    if (pool.length < 3) {
      msg.textContent = '⚠️ 该词源下单词太少（不足 3 个），换个词源或先去学习/同步';
      msg.className = 'result err';
      return;
    }
    const count = Math.max(1, Math.floor(Number($('#quizCount').value) || 10));
    pool = shuffle(pool).slice(0, count);
    // 补齐释义（判分依赖），获取不到的词跳过
    const missing = pool.filter(w => !w.gloss).map(w => w.spelling);
    if (missing.length) {
      const g = await api('/api/gloss', { method: 'POST', body: { spellings: missing } });
      pool.forEach(w => { if (g.glosses?.[w.spelling]) w.gloss = g.glosses[w.spelling]; });
    }
    const withGloss = pool.filter(w => w.gloss?.gloss);
    if (withGloss.length < 3) {
      msg.textContent = '⚠️ 释义获取失败（请检查设置页的 AI 服务商），暂时出不了题';
      msg.className = 'result err';
      return;
    }
    quiz.items = withGloss.map(w => ({ ...w, kind: quiz.mode }));
    quiz.idx = 0;
    quiz.results = [];
    quiz.running = true;
    quiz.adaptive = false;
    quiz.sessionId = null;
    quiz.sessionStartedAt = new Date().toISOString();
    quiz.pausedMs = 0;
    quiz.pauseStartedAt = null;
    // v2.10.0：拉取这些词的现行 SRS 掌握度（供掌握度条展示）
    await loadQuizSrsMeta(quiz.items.map(w => w.spelling));
    // 四选一的干扰项池
    if (quiz.mode === 'choice') {
      const all = await api('/api/words?filter=all');
      quiz.distractorPool = (all.words || []).filter(w => w.gloss?.gloss);
    }
    msg.textContent = '';
    $('#quizSetup').style.display = 'none';
    $('#quizRun').style.display = 'block';
    $('#quizMasteryRow').style.display = 'flex';
    startQuizTimer();
    renderQuizItem();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
  }
}

/** v2.10.0：批量获取词的 SRS 元数据（掌握度/错题阶段） */
async function loadQuizSrsMeta(spellings) {
  quiz.srsMeta = {};
  try {
    const data = await api('/api/quiz/srs?filter=all');
    const map = data.words || {};
    for (const sp of spellings) if (map[sp]) quiz.srsMeta[sp] = map[sp];
  } catch { /* 静默：SRS 状态不可用不影响出题 */ }
}

function quitQuiz() {
  quiz.running = false;
  transfer.running = false;
  transfer.answered = false;
  srs.running = false;
  if (quiz.advanceTimer) { clearTimeout(quiz.advanceTimer); quiz.advanceTimer = null; }
  if (quiz.saveTimer) { clearTimeout(quiz.saveTimer); quiz.saveTimer = null; }
  if (transfer.advanceTimer) { clearTimeout(transfer.advanceTimer); transfer.advanceTimer = null; }
  if (srs.advanceTimer) { clearTimeout(srs.advanceTimer); srs.advanceTimer = null; }
  stopQuizTimer();
  $('#quizRun').style.display = 'none';
  $('#quizSetup').style.display = 'block';
  $('#transferConfidenceGroup').style.display = 'none';
  $('#quizMasteryRow').style.display = 'none';
  // v2.11.0：自适应会话退出不是放弃——保留进度供续做，只刷新「继续上次」提示
  // 注意：saveSessionNow 在首个 await 前同步读取 sessionId，故须先调用再清空标志
  const wasAdaptive = quiz.adaptive && quiz.sessionId;
  if (wasAdaptive) { saveSessionNow().catch(() => {}); }
  quiz.adaptive = false;
  quiz.sessionId = null;
  if (wasAdaptive) checkQuizResume();
  try { loadQuizSourceCounts(); } catch {}   // v3.2.1：退出后刷新词源计数
}

/* ---- v2.10.0：会话计时（含暂停） ---- */
let quizTimerHandle = null;
function startQuizTimer() {
  stopQuizTimer();
  quizTimerHandle = setInterval(() => { const el = $('#quizTimer'); if (el) el.textContent = fmtDuration(currentSessionElapsedMs()); }, 500);
}
function stopQuizTimer() { if (quizTimerHandle) { clearInterval(quizTimerHandle); quizTimerHandle = null; } }
function currentSessionElapsedMs() {
  const session = srs.running ? srs : quiz;
  if (!session.sessionStartedAt) return 0;
  let ms = Date.now() - new Date(session.sessionStartedAt).getTime() - (session.pausedMs || 0);
  if (session.pauseStartedAt) ms -= Date.now() - new Date(session.pauseStartedAt).getTime();
  return Math.max(0, ms);
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
if ($('#quizPauseBtn')) $('#quizPauseBtn').addEventListener('click', () => {
  const session = srs.running ? srs : quiz;
  const btn = $('#quizPauseBtn');
  if (session.pauseStartedAt) {
    session.pausedMs = (session.pausedMs || 0) + (Date.now() - new Date(session.pauseStartedAt).getTime());
    session.pauseStartedAt = null;
    btn.textContent = '⏸ 暂停';
  } else {
    session.pauseStartedAt = new Date().toISOString();
    btn.textContent = '▶ 继续';
  }
});

/** v2.10.0：渲染掌握度条（0–4） */
function renderMasteryBar(spelling, srsMeta) {
  const bar = $('#quizMasteryBar'), text = $('#quizMasteryText');
  if (!bar || !text) return;
  const meta = srsMeta || {};
  const lv = Number(meta.mastery || 0);
  $$('#quizMasteryBar .qm-seg').forEach(seg => {
    seg.classList.toggle('on', Number(seg.dataset.lv) <= lv);
    seg.classList.toggle('max', Number(seg.dataset.lv) === lv);
  });
  let label = lv === 0 ? '未掌握' : lv >= 4 ? '已掌握' : `${lv} 级`;
  if (meta.wrongStage != null && !meta.resolved) label += `（错题阶段 ${meta.wrongStage}/4）`;
  text.textContent = label;
}

function quizAdvance() {
  if (!quiz.running) return;
  quiz.idx++;
  if (quiz.idx >= quiz.items.length) return finishQuiz();
  renderQuizItem();
}

function quizRecord(resp, extra = {}) {
  const it = quiz.items[quiz.idx];
  const now = Date.now();
  const startT = quiz.itemStartedAt ? new Date(quiz.itemStartedAt).getTime() : now;
  const durationMs = Math.max(0, Math.min(14400000, now - startT));

  // v2.10.0：若为 4 档评分，映射为旧版 response 以兼容，同时保留 grade 交给 SRS 引擎
  const grade = extra.grade || null;
  const mappedResp = grade
    ? { again: 'FORGET', hard: 'VAGUE', good: 'FAMILIAR', easy: 'FAMILIAR' }[grade]
    : resp;

  const itemKind = it.kind || quiz.mode;
  // v3.2.1：信心由行为智能推断（耗时 + 正误），不再由用户手选
  const confidence = inferQuizConfidence({ grade, durationMs, spelling: it.spelling });
  quiz.results.push({
    spelling: it.spelling,
    response: mappedResp,
    grade,
    mode: itemKind,
    prompt: itemKind === 'zh2en' ? (it.gloss?.gloss || '') : it.spelling,
    expected: it.gloss?.gloss || '',
    userAnswer: extra.userAnswer !== undefined ? String(extra.userAnswer) : mappedResp,
    confidence,
    startedAt: quiz.itemStartedAt || new Date(now - durationMs).toISOString(),
    submittedAt: new Date(now).toISOString(),
    durationMs,
  });
  quiz.lastConfidence = confidence;
  scheduleSessionSave();
  return confidence;
}

function renderQuizItem() {
  const it = quiz.items[quiz.idx];
  quiz.itemStartedAt = new Date().toISOString();
  renderMasteryBar(it.spelling, quiz.srsMeta[it.spelling]);
  const kind = it.kind || quiz.mode;
  const kindLabel = { flash: '🃏 闪卡', choice: '🔤 四选一', spell: '⌨️ 拼写', zh2en: '🀄 看中选英', audio: '🔊 听音辨义' }[kind] || '';
  $('#quizProgress').innerHTML = `第 ${quiz.idx + 1} / ${quiz.items.length} 题${quiz.adaptive && kindLabel ? ` <span class="quiz-kind-badge">${kindLabel}</span>` : ''}`;
  $('#quizBar').style.width = (quiz.idx / quiz.items.length * 100) + '%';
  const area = $('#quizArea');
  autoSpeakQuizWord(kind, it.spelling);   // v3.2.1：flash/choice/audio 自动播报（zh2en/spell 不播）

  if (kind === 'flash') {
    area.innerHTML = `
      <div class="quiz-word">${esc(it.spelling)} <button class="speak-btn mini" data-speak="${esc(it.spelling)}">🔊</button>
        ${it.gloss?.phonetic ? `<div class="phonetic">${esc(it.gloss.phonetic)}</div>` : ''}</div>
      <div class="quiz-hint">想一想它的中文意思，再翻面对答案</div>
      <div class="quiz-flip-zone" id="quizFlipZone">
        <button class="btn primary" id="quizFlipBtn">🔄 翻面看答案</button>
      </div>`;
    $('#quizFlipBtn').addEventListener('click', () => {
      $('#quizFlipZone').innerHTML = `
        <div class="quiz-answer"><span class="pos">${esc(it.gloss.pos || '')}</span>${esc(it.gloss.gloss)}</div>
        <div class="grade-row grade-row-4">
          ${QUIZ_GRADES.map(g => `<button class="btn grade ${g.cls}" data-grade="${g.key}" title="${esc(g.hint)}">${esc(g.label)}</button>`).join('')}
        </div>`;
      $$('#quizFlipZone .grade').forEach(b =>
        b.addEventListener('click', () => {
          const conf = quizRecord(null, { grade: b.dataset.grade });
          toast(`本题判定：${confidenceLabel(conf)}`);
          quizAdvance();
        }));
    });
    return;
  }

  if (kind === 'choice' || kind === 'audio') {
    // 自适应组卷自带 options（服务端确定性生成）；固定模式则用词库现造
    let opts;
    if (it.options && it.options.length) {
      opts = it.options.map(t => ({ ok: t === (it.answer || it.gloss.gloss), text: t }));
    } else {
      const distractors = shuffle(quiz.distractorPool.filter(w => w.spelling !== it.spelling))
        .slice(0, 3).map(w => w.gloss.gloss);
      opts = shuffle([{ ok: true, text: it.gloss.gloss }, ...distractors.map(t => ({ ok: false, text: t }))]);
    }
    const head = kind === 'audio'
      ? `<div class="quiz-word quiz-audio"><button class="speak-btn large" data-speak="${esc(it.spelling)}">🔊</button><div class="phonetic">${esc(it.gloss?.phonetic || '')}</div></div>
         <div class="quiz-hint">听发音，选出正确释义</div>`
      : `<div class="quiz-word">${esc(it.spelling)} <button class="speak-btn mini" data-speak="${esc(it.spelling)}">🔊</button></div>
         <div class="quiz-hint">选出正确的释义</div>`;
    area.innerHTML = `
      ${head}
      <div class="quiz-opts">${opts.map((o, i) => `<button class="btn quiz-opt" data-i="${i}">${esc(o.text)}</button>`).join('')}</div>
      <div class="quiz-feedback" id="quizFeedback"></div>`;
    let answered = false;
    $$('#quizArea .quiz-opt').forEach(b => b.addEventListener('click', () => {
      if (answered) return;
      answered = true;
      const pickedOpt = opts[Number(b.dataset.i)];
      const ok = pickedOpt.ok;
      b.classList.add(ok ? 'correct' : 'wrong');
      // v4.4.1：答错时同时点亮正确项，让「对在哪」一眼可见
      if (!ok) {
        const rightIndex = opts.findIndex(option => option.ok);
        const rightBtn = $$('#quizArea .quiz-opt')[rightIndex];
        if (rightBtn) rightBtn.classList.add('correct');
      }
      const conf = quizRecord(null, { grade: ok ? 'good' : 'again', userAnswer: pickedOpt.text });
      $('#quizFeedback').innerHTML = (ok
        ? '<span class="fb-ok">✅ 答对了</span>'
        : `<span class="fb-bad">❌ 正确答案：<b>${esc(it.gloss.gloss)}</b></span>`)
        + ` <span class="fb-conf">本题判定：${esc(confidenceLabel(conf))}</span>`;
      quiz.advanceTimer = setTimeout(quizAdvance, ok ? 700 : 1800);
    }));
    return;
  }

  if (kind === 'zh2en') {
    // 看中文选英文：题干给中文释义，选项为英文单词
    const opts = (it.options || []).map(t => ({ ok: t === (it.answer || it.spelling), text: t }));
    area.innerHTML = `
      <div class="quiz-answer quiz-cn-prompt"><span class="pos">${esc(it.gloss?.pos || '')}</span>${esc(it.gloss?.gloss || '')}</div>
      <div class="quiz-hint">选出对应的英文单词</div>
      <div class="quiz-opts">${opts.map((o, i) => `<button class="btn quiz-opt" data-i="${i}">${esc(o.text)}</button>`).join('')}</div>
      <div class="quiz-feedback" id="quizFeedback"></div>`;
    let answered = false;
    $$('#quizArea .quiz-opt').forEach(b => b.addEventListener('click', () => {
      if (answered) return;
      answered = true;
      const picked = opts[Number(b.dataset.i)];
      b.classList.add(picked.ok ? 'correct' : 'wrong');
      if (!picked.ok) {
        const rightIndex = opts.findIndex(option => option.ok);
        const rightBtn = $$('#quizArea .quiz-opt')[rightIndex];
        if (rightBtn) rightBtn.classList.add('correct');   // v4.4.1：答错时点亮正确项
      }
      const conf = quizRecord(null, { grade: picked.ok ? 'good' : 'again', userAnswer: picked.text });
      $('#quizFeedback').innerHTML = (picked.ok
        ? `<span class="fb-ok">✅ 答对了！${esc(it.spelling)}</span>`
        : `<span class="fb-bad">❌ 正确答案：<b>${esc(it.spelling)}</b></span>`)
        + ` <span class="fb-conf">本题判定：${esc(confidenceLabel(conf))}</span>`;
      quiz.advanceTimer = setTimeout(quizAdvance, picked.ok ? 700 : 1800);
    }));
    return;
  }

  // 拼写模式：给中文释义，拼出单词
  area.innerHTML = `
    <div class="quiz-answer"><span class="pos">${esc(it.gloss.pos || '')}</span>${esc(it.gloss.gloss)}</div>
    <div class="quiz-hint">根据释义拼出这个单词（按回车提交）</div>
    <div class="quiz-spell-row">
      <input type="text" id="quizSpellInput" class="input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入拼写…">
      <button class="btn primary" id="quizSpellBtn">提交</button>
    </div>
    <div class="quiz-feedback" id="quizFeedback"></div>`;
  const input = $('#quizSpellInput');
  input.focus();
  const submit = () => {
    const val = input.value.trim();
    if (!val) return;
    const ok = val.toLowerCase() === it.spelling.toLowerCase();
    input.disabled = true;
    $('#quizSpellBtn').disabled = true;
    const conf = quizRecord(null, { grade: ok ? 'good' : 'again', userAnswer: val });
    $('#quizFeedback').innerHTML = (ok
      ? `<span class="fb-ok">✅ 拼对了！${esc(it.spelling)}</span>`
      : `<span class="fb-bad">❌ 正确拼写：<b>${esc(it.spelling)}</b> <button class="speak-btn mini" data-speak="${esc(it.spelling)}">🔊</button></span>`)
      + ` <span class="fb-conf">本题判定：${esc(confidenceLabel(conf))}</span>`;
    quiz.advanceTimer = setTimeout(quizAdvance, ok ? 700 : 2000);
  };
  $('#quizSpellBtn').addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

async function finishQuiz() {
  quiz.running = false;
  stopQuizTimer();
  if (quiz.saveTimer) { clearTimeout(quiz.saveTimer); quiz.saveTimer = null; }
  $('#quizBar').style.width = '100%';
  $('#quizProgress').textContent = '测验完成 🎉';
  const r = quiz.results;
  const cnt = k => r.filter(x => x.response === k).length;
  const gcnt = g => r.filter(x => x.grade === g).length;
  const elapsed = fmtDuration(currentSessionElapsedMs());
  const wasAdaptive = quiz.adaptive;
  const sessionId = quiz.sessionId;
  quiz.adaptive = false;
  quiz.sessionId = null;
  let submitNote = '';
  let srsNote = '';
  try {
    const body = { results: r, mode: quiz.mode };
    if (wasAdaptive && sessionId) body.sessionId = sessionId;
    const res = await api('/api/quiz/submit', { method: 'POST', body });
    if (res.engine === 'srs') {
      srsNote = `🧠 记忆引擎已更新${res.wrongBooked ? ` · 新入错题本 ${res.wrongBooked}` : ''}${res.resolved ? ` · 已掌握移出 ${res.resolved}` : ''}。`;
    }
    submitNote = '忘记/模糊的词自动进入了对应筛选，回「AI 学习」页可针对性攻克。';
  } catch {
    submitNote = '（结果上报失败，本次不计入错词统计）';
  }
  // v2.11.0：本轮为自适应组卷 → 结果页额外展示题型分布
  let kindNote = '';
  if (wasAdaptive) {
    const kindCnt = {};
    for (const x of r) kindCnt[x.mode] = (kindCnt[x.mode] || 0) + 1;
    const kindLabels = { flash: '闪卡', choice: '四选一', spell: '拼写', zh2en: '看中选英', audio: '听音辨义' };
    kindNote = Object.keys(kindCnt).map(k => `${kindLabels[k] || k} ${kindCnt[k]}`).join(' · ');
  }
  const gc = QUIZ_GRADES.map(g => `<span class="gd ${g.cls}">${esc(g.label)} ${gcnt(g.key)}</span>`).join('');

  // v2.12.0：答错/遗忘的词 → AI 复盘区（讲解 / 助记 / 真实例句）
  const wrongItems = r.filter(x => x.response !== 'FAMILIAR');
  let aiReview = '';
  if (wrongItems.length) {
    aiReview = `<div class="stats-card ai-review-card">
      <div class="stats-card-title">🧠 AI 复盘（本轮回炉 ${wrongItems.length} 词）</div>
      <div class="ai-review-list" id="aiReviewList">
        ${wrongItems.map((x, i) => `
          <div class="ai-review-item" data-word="${esc(x.spelling)}" data-idx="${i}">
            <div class="ai-review-head">
              <b>${esc(x.spelling)}</b>
              <span class="ai-review-actions">
                <button class="btn small ghost ai-explain-btn">💡 讲解</button>
                <button class="btn small ghost ai-mnemonic-btn">📝 助记</button>
                <button class="btn small ghost ai-example-btn">📚 例句</button>
              </span>
            </div>
            <div class="ai-explain-box" style="display:none"></div>
            <div class="ai-example-box" style="display:none"></div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  $('#quizArea').innerHTML = `
    <div class="quiz-done">
      <div class="quiz-score">${cnt('FAMILIAR')} / ${r.length}</div>
      <div class="quiz-score-sub">用时 ${elapsed}</div>
      ${kindNote ? `<div class="quiz-score-sub">题型分布：${esc(kindNote)}</div>` : ''}
      <div class="quiz-grade-summary">${gc}</div>
      <div class="hint" style="text-align:center">${esc(srsNote)}</div>
      <div class="hint" style="text-align:center">${esc(submitNote)}</div>
      <div class="row-gap" style="justify-content:center">
        <button class="btn primary" id="quizAgainBtn">🔁 再来一轮</button>
        <button class="btn" id="quizToWrongbookBtn">📕 去错题复练</button>
        <button class="btn" data-jump="study" data-filter="forget">去学错词</button>
      </div>
      ${aiReview}
    </div>`;
  wireAiReview();
  $('#quizAgainBtn').addEventListener('click', quitQuiz);
  $('#quizToWrongbookBtn').addEventListener('click', () => {
    quitQuiz();
    $$('#quizSubmode .quiz-submode-btn').forEach(b => b.classList.toggle('active', b.dataset.submode === 'srs'));
    quiz.submode = 'srs';
    $('#quizBasicPane').style.display = 'none';
    $('#quizSrsPane').style.display = 'block';
    $('#quizTransferPane').style.display = 'none';
    loadSrsOverview();
  });
}

/* ---------------- v2.10.0：错题复练（自维护 SRS） ---------------- */

async function startSrs() {
  const msg = $('#quizSrsMsg');
  msg.textContent = '正在准备复练题…';
  msg.className = 'result';
  try {
    const data = await api('/api/quiz/srs?filter=' + encodeURIComponent(srs.filter));
    const due = data.due || [];
    if (!due.length) {
      msg.textContent = '⚠️ 当前没有到期的复练词。可先做基础测验积累记忆数据，或稍后再来。';
      msg.className = 'result err';
      return;
    }
    const count = Math.max(1, Math.floor(Number($('#quizSrsCount').value) || 10));
    const spellings = due.slice(0, count).map(d => d.spelling);
    // 拉取词详情 + 释义
    const words = await api('/api/words?filter=all');
    const bySpelling = new Map((words.words || []).map(w => [w.spelling, w]));
    let items = spellings.map(sp => {
      const w = bySpelling.get(sp) || { spelling: sp, gloss: null };
      return { ...w, _srs: data.words[sp] || {} };
    });
    const missing = items.filter(w => !w.gloss).map(w => w.spelling);
    if (missing.length) {
      const g = await api('/api/gloss', { method: 'POST', body: { spellings: missing } });
      items.forEach(w => { if (g.glosses?.[w.spelling]) w.gloss = g.glosses[w.spelling]; });
    }
    items = items.filter(w => w.gloss?.gloss);
    if (!items.length) {
      msg.textContent = '⚠️ 到期词的释义获取失败（请检查设置页的 AI 服务商）';
      msg.className = 'result err';
      return;
    }
    srs.items = items;
    srs.idx = 0;
    srs.results = [];
    srs.running = true;
    srs.sessionStartedAt = new Date().toISOString();
    srs.pausedMs = 0;
    srs.pauseStartedAt = null;
    quiz.srsMeta = { ...(data.words || {}) };
    msg.textContent = '';
    $('#quizSetup').style.display = 'none';
    $('#quizRun').style.display = 'block';
    $('#quizMasteryRow').style.display = 'flex';
    startQuizTimer();
    renderSrsItem();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
  }
}

function srsAdvance() {
  if (!srs.running) return;
  srs.idx++;
  if (srs.idx >= srs.items.length) return finishSrs();
  renderSrsItem();
}

function srsRecord(grade, extra = {}) {
  const it = srs.items[srs.idx];
  const now = Date.now();
  const startT = srs.itemStartedAt ? new Date(srs.itemStartedAt).getTime() : now;
  const durationMs = Math.max(0, Math.min(14400000, now - startT));
  // v3.2.1：信心由行为智能推断（耗时 + 评分）
  const confidence = inferQuizConfidence({ grade, durationMs, spelling: it.spelling });
  srs.results.push({
    spelling: it.spelling,
    grade,
    mode: 'flash',
    prompt: it.spelling,
    expected: it.gloss?.gloss || '',
    userAnswer: extra.userAnswer !== undefined ? String(extra.userAnswer) : grade,
    confidence,
    startedAt: srs.itemStartedAt || new Date(now - durationMs).toISOString(),
    submittedAt: new Date(now).toISOString(),
    durationMs,
  });
  return confidence;
}

function renderSrsItem() {
  const it = srs.items[srs.idx];
  srs.itemStartedAt = new Date().toISOString();
  const meta = quiz.srsMeta[it.spelling] || it._srs || {};
  renderMasteryBar(it.spelling, meta);
  $('#quizProgress').textContent = `复练 第 ${srs.idx + 1} / ${srs.items.length} 题`;
  $('#quizBar').style.width = (srs.idx / srs.items.length * 100) + '%';
  const srcBadge = meta.source === 'wrongbook'
    ? `<span class="transfer-kind-badge cloze">错题本 · 阶段 ${meta.wrongStage || 0}/4</span>`
    : '<span class="transfer-kind-badge">记忆到期</span>';
  const area = $('#quizArea');
  autoSpeakQuizWord('srs', it.spelling);   // v3.2.1：复练自动播报（单词题面可见）
  area.innerHTML = `
    <div class="transfer-meta">${srcBadge}${meta.wrongCount ? `<span class="tag">错 ${meta.wrongCount} 次</span>` : ''}</div>
    <div class="quiz-word">${esc(it.spelling)} <button class="speak-btn mini" data-speak="${esc(it.spelling)}">🔊</button>
      ${it.gloss?.phonetic ? `<div class="phonetic">${esc(it.gloss.phonetic)}</div>` : ''}</div>
    <div class="quiz-hint">回忆它的中文意思，再翻面自评</div>
    <div class="quiz-flip-zone" id="srsFlipZone">
      <button class="btn primary" id="srsFlipBtn">🔄 翻面看答案</button>
    </div>`;
  $('#srsFlipBtn').addEventListener('click', () => {
    $('#srsFlipZone').innerHTML = `
      <div class="quiz-answer"><span class="pos">${esc(it.gloss.pos || '')}</span>${esc(it.gloss.gloss)}</div>
      <div class="grade-row grade-row-4">
        ${QUIZ_GRADES.map(g => `<button class="btn grade ${g.cls}" data-grade="${g.key}" title="${esc(g.hint)}">${esc(g.label)}</button>`).join('')}
      </div>`;
    $$('#srsFlipZone .grade').forEach(b =>
      b.addEventListener('click', () => {
        const conf = srsRecord(b.dataset.grade);
        toast(`本题判定：${confidenceLabel(conf)}`);
        srsAdvance();
      }));
  });
}

async function finishSrs() {
  srs.running = false;
  stopQuizTimer();
  $('#quizBar').style.width = '100%';
  $('#quizProgress').textContent = '复练完成 🎯';
  const r = srs.results;
  const gcnt = g => r.filter(x => x.grade === g).length;
  const elapsed = fmtDuration(currentSessionElapsedMs());
  let note = '';
  try {
    const res = await api('/api/quiz/submit', { method: 'POST', body: { results: r, mode: 'srs' } });
    const parts = [];
    if (res.wrongBooked) parts.push(`新入错题本 ${res.wrongBooked}`);
    if (res.resolved) parts.push(`已掌握移出 ${res.resolved}`);
    note = `记忆引擎已更新${parts.length ? ' · ' + parts.join(' · ') : ''}。`;
  } catch {
    note = '（结果上报失败，本次不计入记忆引擎）';
  }
  const gc = QUIZ_GRADES.map(g => `<span class="gd ${g.cls}">${esc(g.label)} ${gcnt(g.key)}</span>`).join('');
  $('#quizArea').innerHTML = `
    <div class="quiz-done">
      <div class="quiz-score">${gcnt('good') + gcnt('easy')} / ${r.length}</div>
      <div class="quiz-score-sub">掌握+轻松 / 总数 · 用时 ${elapsed}</div>
      <div class="quiz-grade-summary">${gc}</div>
      <div class="hint" style="text-align:center">${esc(note)}</div>
      <div class="row-gap" style="justify-content:center">
        <button class="btn primary" id="srsAgainBtn">🔁 继续复练</button>
        <button class="btn" id="srsBackBtn">↩ 返回设置</button>
      </div>
    </div>`;
  $('#srsAgainBtn').addEventListener('click', () => { $('#quizRun').style.display = 'none'; $('#quizSetup').style.display = 'block'; $('#quizMasteryRow').style.display = 'none'; startSrs(); });
  $('#srsBackBtn').addEventListener('click', () => { quitQuiz(); loadSrsOverview(); });
}

/* ---------------- v2.2.4：真题迁移训练 ---------------- */

async function startTransfer() {
  const msg = $('#transferMsg');
  const kinds = transfer.kinds;
  if (!kinds.context && !kinds.cloze) {
    msg.textContent = '⚠️ 请至少开启一种题型（语境选义或搭配补全）';
    msg.className = 'result err';
    return;
  }
  const count = Math.max(1, Math.floor(Number($('#transferCount').value) || 6));
  msg.textContent = '正在从真题句中生成迁移题…';
  msg.className = 'result';
  try {
    const r = await api('/api/learning/vocab/generate', {
      method: 'POST',
      body: { filter: transfer.src, count, context: kinds.context, cloze: kinds.cloze },
    });
    const questions = r.questions || [];
    if (!questions.length) {
      msg.textContent = '⚠️ ' + (r.message || '暂无可生成的迁移题');
      msg.className = 'result err';
      return;
    }
    transfer.questions = questions;
    transfer.idx = 0;
    transfer.results = [];
    transfer.running = true;
    transfer.answered = false;
    if (transfer.advanceTimer) { clearTimeout(transfer.advanceTimer); transfer.advanceTimer = null; }
    msg.textContent = '';
    $('#quizSetup').style.display = 'none';
    $('#quizRun').style.display = 'block';
    // 迁移训练使用独立信心组（v3.2.1：基础测验信心组已移除，改为自动判断）
    $('#transferConfidenceGroup').style.display = '';
    renderTransferItem();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
  }
}

function transferAdvance() {
  if (!transfer.running) return;
  transfer.idx++;
  if (transfer.idx >= transfer.questions.length) return finishTransfer();
  renderTransferItem();
}

function renderTransferItem() {
  const q = transfer.questions[transfer.idx];
  transfer.itemStartedAt = new Date().toISOString();
  transfer.answered = false;
  resetTransferConfidence();   // 每题重置为 unsure
  $('#quizProgress').textContent = `第 ${transfer.idx + 1} / ${transfer.questions.length} 题`;
  $('#quizBar').style.width = (transfer.idx / transfer.questions.length * 100) + '%';
  const area = $('#quizArea');

  const kindBadge = q.kind === 'vocab_cloze'
    ? '<span class="transfer-kind-badge cloze">搭配补全</span>'
    : '<span class="transfer-kind-badge">语境选义</span>';
  const srcLabel = [q.sourceLabel, q.title].filter(Boolean).join(' · ');

  if (q.kind === 'vocab_context') {
    const optHtml = (q.options || []).map((text, i) =>
      `<button type="button" class="btn quiz-opt transfer-opt" data-i="${i}">${esc(text)}</button>`).join('');
    area.innerHTML = `
      <div class="transfer-meta">${kindBadge}<span class="tag">${esc(srcLabel)}</span></div>
      <div class="transfer-source-sentence">${esc(q.sentence)}</div>
      <div class="quiz-hint">选出 <b>${esc(q.word)}</b> 在这句真题中的正确释义</div>
      <div class="quiz-opts" id="transferOpts">${optHtml}</div>
      <div class="quiz-feedback" id="quizFeedback"></div>`;
    let done = false;
    $$('#quizArea .transfer-opt').forEach(b => b.addEventListener('click', () => {
      if (done) return;
      done = true;
      transfer.answered = true;
      const picked = q.options[Number(b.dataset.i)];
      submitTransfer(q, picked);
    }));
    return;
  }

  // 搭配补全：文本输入
  area.innerHTML = `
    <div class="transfer-meta">${kindBadge}<span class="tag">${esc(srcLabel)}</span></div>
    <div class="transfer-source-sentence">${esc(q.sentence)}</div>
    <div class="quiz-hint">根据句意与词形，补全横线处的单词（原形：<b>${esc(q.word)}</b>）</div>
    <div class="quiz-spell-row">
      <input type="text" id="transferInput" class="input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入缺失的单词…">
      <button class="btn primary" id="transferSubmitBtn">提交</button>
    </div>
    <div class="quiz-feedback" id="quizFeedback"></div>`;
  const input = $('#transferInput');
  input.focus();
  const doSubmit = () => {
    if (transfer.answered) return;
    const val = input.value.trim();
    if (!val) return;
    transfer.answered = true;
    input.disabled = true;
    $('#transferSubmitBtn').disabled = true;
    submitTransfer(q, val);
  };
  $('#transferSubmitBtn').addEventListener('click', doSubmit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSubmit(); });
}

async function submitTransfer(q, answer) {
  const now = Date.now();
  const startT = transfer.itemStartedAt ? new Date(transfer.itemStartedAt).getTime() : now;
  const durationMs = Math.max(0, Math.min(14400000, now - startT));
  let correct = false;
  let expected = '';
  try {
    const r = await api('/api/learning/vocab/submit', {
      method: 'POST',
      body: {
        token: q.token,
        answer,
        confidence: transfer.confidence || 'unsure',   // v2.2.8：发送真实信心，不再固定 unsure
        startedAt: transfer.itemStartedAt,
        durationMs,
      },
    });
    correct = !!r.correct;
    expected = r.expected || '';
  } catch (e) {
    $('#quizFeedback').innerHTML = `<span class="fb-bad">❌ 提交失败：${esc(e.message)}</span>`;
    // 允许重试
    transfer.answered = false;
    return;
  }

  transfer.results.push({ word: q.word, kind: q.kind, answer, expected, correct });

  // 高亮反馈
  if (q.kind === 'vocab_context') {
    $$('#quizArea .transfer-opt').forEach(b => {
      const text = q.options[Number(b.dataset.i)];
      if (text === expected) b.classList.add('correct');
      else if (text === answer && !correct) b.classList.add('wrong');
    });
  }
  $('#quizFeedback').innerHTML = correct
    ? '<span class="fb-ok">✅ 正确</span>'
    : `<span class="fb-bad">❌ 正确答案：<b>${esc(expected)}</b></span>`;
  transfer.advanceTimer = setTimeout(transferAdvance, correct ? 800 : 1800);
}

async function finishTransfer() {
  transfer.running = false;
  if (transfer.advanceTimer) { clearTimeout(transfer.advanceTimer); transfer.advanceTimer = null; }
  $('#quizBar').style.width = '100%';
  $('#quizProgress').textContent = '迁移训练完成 🎯';
  $('#transferConfidenceGroup').style.display = 'none';
  const r = transfer.results;
  const correctN = r.filter(x => x.correct).length;
  const ctx = r.filter(x => x.kind === 'vocab_context');
  const cloze = r.filter(x => x.kind === 'vocab_cloze');
  const wrongWords = [...new Set(r.filter(x => !x.correct).map(x => x.word))];

  const wrongHtml = wrongWords.length
    ? `<div class="transfer-wrong-list">${wrongWords.map(w => `<button type="button" class="transfer-wrong-chip" data-word="${esc(w)}">${esc(w)}</button>`).join('')}</div>`
    : '<div class="hint" style="text-align:center">本轮全部答对，状态不错 👏</div>';

  $('#quizArea').innerHTML = `
    <div class="quiz-done">
      <div class="quiz-score">${correctN} / ${r.length}</div>
      <div class="transfer-done-sub">
        语境选义 ${ctx.filter(x => x.correct).length}/${ctx.length} · 搭配补全 ${cloze.filter(x => x.correct).length}/${cloze.length}
      </div>
      <div class="hint" style="text-align:center">${wrongWords.length ? '错词已计入「忘记词」，点击下方词或去 AI 学习攻克：' : ''}</div>
      ${wrongHtml}
      <div class="row-gap" style="justify-content:center">
        <button class="btn primary" id="transferAgainBtn">🔁 再来一组</button>
        <button class="btn" id="transferToStudyBtn" data-jump="study" data-filter="forget">去学错词</button>
      </div>
    </div>`;
  $('#transferAgainBtn').addEventListener('click', () => {
    $('#quizRun').style.display = 'none';
    $('#quizSetup').style.display = 'block';
    $('#transferConfidenceGroup').style.display = 'none';
  });
  $$('#quizArea .transfer-wrong-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      switchTab('study');
      $('#wordSearch').value = chip.dataset.word;
      loadWords();
    });
  });
}

if ($('#transferStartBtn')) $('#transferStartBtn').addEventListener('click', startTransfer);

/* ---------------- 启动 ---------------- */

/** v2.8.0：应用初始化/刷新（登录成功后也会再次调用） */
async function initApp() {
  // v3.1.0：刷新认证状态与角色显隐（登录/注册成功后进入时同步 me 与管理员设置可见性）
  try { await loadAuthStatus(); } catch { /* 未登录或服务未就绪时静默 */ }
  // v2.1.0：启动即拉取 DIY 提示词，使学习页首句开场等自定义提示词无需进设置页即可生效
  try {
    const cfg = await api('/api/config');
    if (cfg.diyPrompts) state.diyPrompts = cfg.diyPrompts;
    // v2.3.4：启动拉取服务商档案（含视觉能力），控制学习页图片按钮显隐
    state.providers = cfg.llm?.providers || [];
    state.activeProvId = cfg.llm?.activeId || '';
  } catch { /* 服务未就绪或未登录时静默 */ }
  refreshVisionUI();
  try {
    const status = await api('/api/status');
    updateSyncBadge(status.lastSync ? 'ok' : 'err', status.lastSync ? formatTime(status.lastSync) : '未同步');
    if (!status.hasToken || !status.llm.configured) {
      $('#setupHint').style.display = 'block';
    }
  } catch { /* 服务未就绪或未登录时静默 */ }
  loadDashboard();
  try { pwaHandleShortcutTab(); } catch { /* v3.3.0：PWA 快捷方式直达页签 */ }
}

(async function init() {
  applyTheme(localStorage.getItem('wb-theme') || 'light');
  applyStyle();
  bindLoginUI();
  bindVersionClick();
  // v2.8.0：日志版块事件
  const usageAdd = $('#usageAddBtn');
  if (usageAdd) usageAdd.addEventListener('click', async () => {
    const kind = $('#usageKind') ? $('#usageKind').value : 'note';
    const title = $('#usageTitle') ? $('#usageTitle').value.trim() : '';
    const content = $('#usageContent') ? $('#usageContent').value.trim() : '';
    const out = $('#usageResult');
    if (!title && !content) { if (out) out.textContent = '请填写标题或内容'; return; }
    try {
      await api('/api/logs/usage', { method: 'POST', body: { add: { kind, title, content } } });
      if ($('#usageTitle')) $('#usageTitle').value = '';
      if ($('#usageContent')) $('#usageContent').value = '';
      if (out) out.textContent = '✓ 已添加';
      loadUsageLogs();
    } catch (e) { if (out) out.textContent = '❌ ' + e.message; }
  });
  const errClear = $('#errorClearBtn');
  if (errClear) errClear.addEventListener('click', async () => {
    try { await api('/api/logs/errors', { method: 'DELETE' }); loadErrorLogs(); toast('报错日志已清空'); }
    catch (e) { toast('清空失败：' + e.message); }
  });
  // v2.8.0：先校验登录状态，未登录则只显示登录遮罩
  const ok = await checkAuth();
  if (!ok) return;
  await initApp();
})();

/* ============ v1.1.9c：禅意专注视界 + 视线探照灯 + 原生白噪音心流场 ============ */

/* 1. 禅意专注模式 (Zen Mode) */
function toggleZenMode() {
  const isZen = document.body.classList.toggle('zen-mode');
  localStorage.setItem('wb-zen', isZen ? '1' : '0');
  const btn = $('#zenToggle');
  if (btn) btn.textContent = isZen ? '🧘‍♂️' : '🧘';
  if (isZen) {
    toast('已进入禅意专注视界（按 Esc 或 Z 退出）');
  } else {
    toast('已退出专注视界');
  }
}

if ($('#zenToggle')) $('#zenToggle').addEventListener('click', toggleZenMode);
if ($('#zenFloatingExit')) $('#zenFloatingExit').addEventListener('click', toggleZenMode);

/* 2. 考研段落探照灯 (Spotlight Focus) */
function toggleSpotlight() {
  const isActive = document.body.classList.toggle('spotlight-active');
  localStorage.setItem('wb-spotlight', isActive ? '1' : '0');
  const btn = $('#spotlightToggleFloating');
  if (btn) btn.classList.toggle('active', isActive);
  toast(isActive ? '已开启段落探照灯（长难句防跳行）' : '已关闭段落探照灯');
}

if ($('#spotlightToggleFloating')) $('#spotlightToggleFloating').addEventListener('click', toggleSpotlight);

/* 快捷键监听：Z 键切换禅模式，S 键切换探照灯，Esc 退出禅模式 */
window.addEventListener('keydown', e => {
  const tag = e.target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    toggleZenMode();
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    toggleSpotlight();
  } else if (e.key === 'Escape' && document.body.classList.contains('zen-mode')) {
    e.preventDefault();
    toggleZenMode();
  }
});


/* ======================================================================
   v4.4.1 · 快捷面板（Ctrl / ⌘ + K）、键盘导航与设置分区索引
   —— 全部走 DOM 事件委托，不新增内联处理器（CSP 仍无 unsafe-inline script）。
   ====================================================================== */
const MIST_TAB_ACTIONS = [
  { tab: 'dashboard', icon: '📊', title: '今日学习', hint: '今日任务、词卡与墨墨概况', kbd: 'Alt+1' },
  { tab: 'study', icon: '💬', title: 'AI 学习', hint: '词汇微课、词文成章与自由提问', kbd: 'Alt+2' },
  { tab: 'quiz', icon: '📝', title: '测验', hint: '基础回忆 / 错题复练 / 真题迁移', kbd: 'Alt+3' },
  { tab: 'kb', icon: '📚', title: '语料库', hint: '外刊、教材与真题整卷检索', kbd: 'Alt+4' },
  { tab: 'notes', icon: '📖', title: '助记库', hint: '回看助记并推送到墨墨', kbd: 'Alt+5' },
  { tab: 'reports', icon: '📈', title: '学习报告', hint: '练习量、正确率与薄弱点', kbd: 'Alt+6' },
  { tab: 'settings', icon: '⚙️', title: '设置', hint: 'AI 服务、发音、墨墨连接与备份', kbd: 'Alt+7' },
];
const MIST_ACTION_ITEMS = [
  { icon: '🃏', title: '打开悬浮词表', hint: '回到 AI 学习页的词表浮层', keywords: '词表 word vocab 选词', run: () => { switchStudySub('vocab', { load: false }); switchTab('study'); setTimeout(() => { const fab = $('#wordFab'); if (fab) fab.click(); }, 80); } },
  { icon: '🔄', title: '立即同步墨墨', hint: '拉取今日词表、进度与顽固词', keywords: '同步 sync 刷新', run: () => { const badge = $('#syncBadge'); if (badge) badge.click(); } },
  { icon: '🔁', title: '开始错题复练', hint: '直接进入测验的错题复练模式', keywords: '错题 srs 复练 wrongbook', run: () => { switchTab('quiz'); const btn = $('[data-submode="srs"]'); if (btn) btn.click(); } },
  { icon: '📋', title: '整理考试计划', hint: '打开「调整考试计划」并聚焦', keywords: '计划 plan 考试 每日', run: () => { switchTab('dashboard'); const card = $('#studyPlanCard'); if (card) { card.open = true; card.scrollIntoView({ block: 'center' }); } } },
  { icon: '🌙', title: '切换昼夜主题', hint: '在白天与夜晚之间来回切换', keywords: '主题 theme 黑夜 白天 dark', run: () => { const btn = $('#themeToggle'); if (btn) btn.click(); } },
  { icon: '🧘', title: '专注禅模式', hint: '收起导航，只留正文（快捷键 Z）', keywords: '禅 zen focus 专注', run: () => { const btn = $('#zenToggle'); if (btn) btn.click(); } },
  { icon: '🗒', title: '日志版块', hint: '开发日志、使用日志与报错日志', keywords: '日志 log 报错 版本', run: () => openLogs() },
];
let mistPaletteRows = [];
let mistPaletteIndex = 0;

function mistPaletteOptions(query = '') {
  const q = query.trim().toLowerCase();
  const all = [
    ...MIST_TAB_ACTIONS.map(item => ({ icon: item.icon, title: item.title, hint: item.hint, kbd: item.kbd, run: () => switchTab(item.tab), search: `${item.title} ${item.hint} ${item.tab}` })),
    ...MIST_ACTION_ITEMS.map(item => ({ icon: item.icon, title: item.title, hint: item.hint, kbd: '', run: item.run, search: `${item.title} ${item.hint} ${item.keywords}` })),
  ];
  return q ? all.filter(item => item.search.toLowerCase().includes(q)) : all;
}

function mistPaletteRender() {
  const box = $('#mistPaletteList');
  if (!box) return;
  mistPaletteRows = mistPaletteOptions($('#mistPaletteInput')?.value || '');
  if (!mistPaletteRows.length) {
    box.innerHTML = '<div class="mist-palette-empty">没有匹配的页面或动作，换个说法试试。</div>';
    return;
  }
  mistPaletteIndex = Math.min(mistPaletteIndex, mistPaletteRows.length - 1);
  box.innerHTML = mistPaletteRows.map((row, i) => `
    <button type="button" class="mist-palette-row" role="option" data-palette-index="${i}" aria-selected="${i === mistPaletteIndex}">
      <span class="mist-palette-row-icon" aria-hidden="true">${row.icon}</span>
      <span class="mist-palette-row-main"><span class="mist-palette-row-title">${esc(row.title)}</span><span class="mist-palette-row-hint">${esc(row.hint)}</span></span>
      ${row.kbd ? `<kbd class="mist-palette-row-kbd">${esc(row.kbd)}</kbd>` : ''}
    </button>`).join('');
  const active = box.querySelector('.mist-palette-row[aria-selected="true"]');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function mistPaletteSetOpen(open) {
  const overlay = $('#mistPalette');
  if (!overlay) return;
  overlay.hidden = !open;
  document.body.classList.toggle('palette-open', open);
  if (open) {
    mistPaletteIndex = 0;
    const input = $('#mistPaletteInput');
    if (input) { input.value = ''; }
    mistPaletteRender();
    setTimeout(() => input?.focus(), 20);
  }
}
function mistPaletteMove(delta) {
  if (!mistPaletteRows.length) return;
  mistPaletteIndex = (mistPaletteIndex + delta + mistPaletteRows.length) % mistPaletteRows.length;
  $$('#mistPaletteList .mist-palette-row').forEach((row, i) => row.setAttribute('aria-selected', String(i === mistPaletteIndex)));
  const active = $('#mistPaletteList .mist-palette-row[aria-selected="true"]');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function mistPaletteRun(index) {
  const row = mistPaletteRows[index];
  if (!row) return;
  mistPaletteSetOpen(false);
  try { row.run(); } catch (error) { console.error(error); }
}

if ($('#paletteToggle')) {
  $('#paletteToggle').addEventListener('click', () => mistPaletteSetOpen(true));
}
if ($('#mistPalette')) {
  $('#mistPalette').addEventListener('click', event => {
    if (event.target.closest('[data-palette-close]')) { mistPaletteSetOpen(false); return; }
    const row = event.target.closest('[data-palette-index]');
    if (row) mistPaletteRun(Number(row.dataset.paletteIndex));
  });
  $('#mistPaletteInput').addEventListener('input', () => { mistPaletteIndex = 0; mistPaletteRender(); });
  $('#mistPaletteInput').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); mistPaletteMove(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); mistPaletteMove(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); mistPaletteRun(mistPaletteIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); mistPaletteSetOpen(false); }
  });
}

/* 设置：一行横列导航 + 单分区显示（v4.5.0）
   旧版顶部索引与竖排折叠列表并存，同一批分区出现两次；现只保留横列，
   点哪一项就只显示该分区，选区记忆在本设备。 */
const MIST_SETTINGS_TAB_KEY = 'wb-settings-tab';
let mistSettingsActiveId = '';
function mistSettingsSections() {
  // 只看管理员/多用户逻辑写入的内联 display，不看本函数切换用的 hidden
  return $$('#tab-settings > section.settings-panel').filter(section => section.style.display !== 'none');
}
function mistSettingsLabel(section) {
  const raw = section.dataset.settingsLabel || section.querySelector('.settings-panel-title')?.textContent || '';
  return raw.trim().replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 12) || '分区';
}
function mistSettingsSetActive(id, opts = {}) {
  const sections = mistSettingsSections();
  if (!sections.length) return;
  const target = sections.find(section => section.id === id) || sections[0];
  mistSettingsActiveId = target.id;
  sections.forEach(section => { section.hidden = section !== target; });
  try { localStorage.setItem(MIST_SETTINGS_TAB_KEY, target.id); } catch (error) { /* 隐私模式忽略 */ }
  $$('#settingsNavItems .mist-page-nav-btn').forEach(btn => {
    const active = btn.dataset.settingsJump === target.id;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  if (opts.scroll) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }
}
function refreshMistSettingsNav() {
  const box = $('#settingsNavItems');
  if (!box) return;
  const sections = mistSettingsSections();
  let stored = '';
  try { stored = localStorage.getItem(MIST_SETTINGS_TAB_KEY) || ''; } catch (error) { /* 忽略 */ }
  box.innerHTML = sections.map((section, index) => {
    if (!section.id) section.id = `settings-panel-${index}`;
    return `<button type="button" class="mist-page-nav-btn" role="tab" id="settings-tab-${esc(section.id)}" aria-controls="${esc(section.id)}" aria-selected="false" tabindex="-1" data-settings-jump="${esc(section.id)}">${esc(mistSettingsLabel(section))}</button>`;
  }).join('');
  if (!box.dataset.bound) {
    box.dataset.bound = '1';
    box.addEventListener('click', event => {
      const btn = event.target.closest('[data-settings-jump]');
      if (!btn) return;
      mistSettingsSetActive(btn.dataset.settingsJump, { scroll: true });
    });
    box.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = $$('#settingsNavItems .mist-page-nav-btn');
      const current = tabs.indexOf(document.activeElement);
      if (current < 0 || !tabs.length) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      mistSettingsSetActive(tabs[next].dataset.settingsJump);
    });
  }
  mistSettingsSetActive(mistSettingsActiveId || stored || sections[0]?.id);
}

/* 键盘：Ctrl/⌘+K 面板、Alt+1..7 跳页、/ 聚焦搜索、←/→ 换词 */
window.addEventListener('keydown', event => {
  const target = event.target;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 'k') {
    event.preventDefault();
    mistPaletteSetOpen($('#mistPalette')?.hidden !== false);
    return;
  }
  if (event.key === 'Escape' && $('#mistPalette')?.hidden === false) { event.preventDefault(); mistPaletteSetOpen(false); return; }
  // Alt+数字 在输入框里也不会打出字符，因此不受「正在输入」限制
  if (event.altKey && /^[1-7]$/.test(event.key)) {
    const action = MIST_TAB_ACTIONS[Number(event.key) - 1];
    if (action) { event.preventDefault(); switchTab(action.tab); }
    return;
  }
  if (typing || event.metaKey || event.ctrlKey) return;
  if (event.key === '/' ) {
    const search = $('#tab-kb.active #kbSearchInput') || $('#tab-notes.active #noteSearch') || $('#wordSearch');
    if (search && search.offsetParent !== null) { event.preventDefault(); search.focus(); if (search.select) search.select(); }
    return;
  }
  if (!$('#tab-dashboard')?.classList.contains('active')) return;
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    if (mistCards.length <= 1) return;
    event.preventDefault();
    mistWordIndex = (mistWordIndex + (event.key === 'ArrowRight' ? 1 : -1) + mistCards.length) % mistCards.length;
    renderMistWord();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      $('#mistWordBody').animate([{ opacity: .5, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
    }
  }
});

/* 恢复本地存储的偏好 */
if (localStorage.getItem('wb-spotlight') === '1') {
  document.body.classList.add('spotlight-active');
  const btn = $('#spotlightToggleFloating');
  if (btn) btn.classList.add('active');
}


/* ============ v1.2.0：数据备份管理 ============ */
async function loadBackupList() {
  const el = $('#backupList');
  if (!el) return;
  try {
    const d = await api('/api/backup/list');
    if (!d.backups?.length) { el.innerHTML = '<div class="empty">暂无备份</div>'; return; }
    el.innerHTML = d.backups.map(b => `
      <div class="backup-item">
        <div class="backup-meta">
          <b>${esc(b.name)}</b>
          <span>${b.files} 个文件</span>
        </div>
        <button class="btn small" data-restore="${esc(b.name)}">恢复此备份</button>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

if ($('#backupCreateBtn')) {
  $('#backupCreateBtn').addEventListener('click', async () => {
    const res = $('#backupResult');
    res.textContent = '正在备份…'; res.className = 'result';
    try {
      const d = await api('/api/backup/create', { method: 'POST' });
      res.textContent = `✅ 备份完成：${d.name}（${d.files} 个文件）`;
      res.className = 'result ok';
      loadBackupList();
    } catch (e) {
      res.textContent = '❌ ' + e.message;
      res.className = 'result err';
    }
  });
}
if ($('#backupRefreshBtn')) $('#backupRefreshBtn').addEventListener('click', loadBackupList);

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-restore]');
  if (!btn) return;
  const name = btn.dataset.restore;
  if (!confirm(`确定恢复备份「${name}」？当前数据将被覆盖！`)) return;
  const res = $('#backupResult');
  res.textContent = '正在恢复…'; res.className = 'result';
  try {
    const d = await api('/api/backup/restore', { method: 'POST', body: { name } });
    res.textContent = `✅ 已恢复 ${d.restored} 个文件，刷新页面生效`;
    res.className = 'result ok';
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    res.textContent = '❌ ' + e.message;
    res.className = 'result err';
  }
});

/* ============ v1.2.0：聊天历史面板事件绑定 ============ */
if ($('#chatHistoryBtn')) {
  $('#chatHistoryBtn').addEventListener('click', () => {
    const overlay = $('#chatHistoryOverlay');
    if (!overlay) return;
    overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
    if (overlay.style.display !== 'none') loadChatHistoryPanel();
  });
}
if ($('#chatHistoryClose')) {
  $('#chatHistoryClose').addEventListener('click', () => {
    $('#chatHistoryOverlay').style.display = 'none';
  });
}
if ($('#chatHistorySearch')) {
  $('#chatHistorySearch').addEventListener('input', debounce(loadChatHistoryPanel, 400));
}

/* ============ 手机端原生 App 级导航与折叠抽屉交互 (v1.1.9e) ============ */
const bottomMoreBtn = $('#bottomMoreBtn');
const moreSheet = $('#moreSheet');
const moreSheetBackdrop = $('#moreSheetBackdrop');

function openMoreSheet() {
  if (moreSheet && moreSheetBackdrop) {
    moreSheet.classList.add('open');
    moreSheetBackdrop.classList.add('open');
  }
}

function closeMoreSheet() {
  if (moreSheet && moreSheetBackdrop) {
    moreSheet.classList.remove('open');
    moreSheetBackdrop.classList.remove('open');
  }
}

if (bottomMoreBtn) bottomMoreBtn.addEventListener('click', openMoreSheet);
if (moreSheetBackdrop) moreSheetBackdrop.addEventListener('click', closeMoreSheet);

// 手机端底部金刚位与更多抽屉切换
$$('.bottom-tab-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
    closeMoreSheet();
  });
});

$$('.more-sheet-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
    closeMoreSheet();
  });
});

// 手机顶栏主题切换与同步绑定
if ($('#mobileThemeToggle')) {
  $('#mobileThemeToggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
}
if ($('#mobileZenToggle')) {
  $('#mobileZenToggle').addEventListener('click', toggleZenMode);
}
if ($('#mobileSyncBadge')) {
  $('#mobileSyncBadge').addEventListener('click', () => {
    if ($('#syncBadge')) $('#syncBadge').click();
  });
}

// 移动端主题与同步状态由 applyTheme 与 updateSyncBadge 统一定向更新

/* ============ v3.3.0：PWA 可安装（添加到主屏幕 / 桌面应用） ============
 * v4.3.1：设置里的「安装到桌面」入口已移除，安装引导 UI 与 beforeinstallprompt
 * 拦截逻辑一并下线；manifest 与 Service Worker 保留，仍可用浏览器菜单安装。 */

/** 注册 Service Worker：仅在安全上下文（HTTPS/localhost）生效；HTTP/IP 下浏览器会拒绝，这里主动跳过避免控制台报错 */
function pwaRegisterSW() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;   // http://IP 非安全上下文：跳过（无副作用）
  // 先探测 /sw.js 是否存在：缺失时直接跳过，避免浏览器在控制台抛 404 资源错误
  fetch('/sw.js', { method: 'HEAD' }).then((r) => {
    if (!r.ok) return;
    return navigator.serviceWorker.register('/sw.js');
  }).then((reg) => {
    if (!reg) return;
    // 新版本就绪时提示刷新（应用外壳已更新）
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('发现新版本，刷新后生效');
        }
      });
    });
  }).catch(() => { /* 静默：SW 注册失败不影响主流程 */ });
}

/* v4.3.1：PWA 内核（manifest + Service Worker）保留，仅注册外壳缓存 */
pwaRegisterSW();

/* 支持 PWA 快捷方式 ?tab=xxx 直达对应页签（在 initApp 登录成功后调用） */
function pwaHandleShortcutTab() {
  try {
    const tab = tabFromURL();
    if (tab !== 'dashboard') switchTab(tab, { history: false });
  } catch { /* 忽略 */ }
}

