/* 英语学习工作台 - 前端逻辑 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  filter: 'today',
  words: [],
  activeWord: null,
  chatHistory: [],      // [{role, content, word}]
  sessionWords: new Set(),
  sessionErrorWords: new Set(),
  sessionStartedAt: new Date().toISOString(),
  llmPresets: {},
};

/* ---------------- 基础请求 ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`);
  return json;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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

/* ---------------- 页签 ---------------- */

$$('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

function switchTab(name) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'dashboard') loadDashboard();
  if (name === 'study') loadWords();
  if (name === 'notes') loadNotes();
  if (name === 'settings') loadConfig();
}

// 快捷入口 / 链接跳转
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-jump]');
  if (!el) return;
  e.preventDefault();
  switchTab(el.dataset.jump);
  if (el.dataset.filter) {
    state.filter = el.dataset.filter;
    $$('#wordFilters .chip').forEach(c => c.classList.toggle('active', c.dataset.filter === state.filter));
    loadWords();
  }
});

/* ---------------- 仪表盘 ---------------- */

async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
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

    // 进度曲线
    const maxH = Math.max(1, ...d.history.map(x => x.finished));
    $('#historyBars').innerHTML = (d.history.length ? d.history : [{ date: '', finished: 0, total: 0 }]).map(x => `
      <div class="bar-col" title="${x.date}: ${x.finished}/${x.total}">
        <div class="bar-num">${x.finished || ''}</div>
        <div class="bar dim" style="height:${Math.max(2, x.finished / maxH * 100)}%"></div>
        <div class="bar-label">${x.date.slice(5)}</div>
      </div>`).join('');

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

function formatTime(iso) { return fmtBJ(iso); }

function updateSyncBadge(dotClass, text) {
  $('#syncDot').className = 'dot ' + dotClass;
  $('#syncText').textContent = text;
}

$('#syncBadge').addEventListener('click', () => doSync(false));

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

/* ---------------- AI 学习页 ---------------- */

$$('#wordFilters .chip').forEach(c => c.addEventListener('click', () => {
  $$('#wordFilters .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  state.filter = c.dataset.filter;
  loadWords();
}));

$('#wordSearch').addEventListener('input', debounce(loadWords, 300));
$('#wordSearch').addEventListener('keydown', e => { if (e.key === 'Enter') loadWords(); });

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function loadWords() {
  try {
    const q = $('#wordSearch').value.trim();
    const d = await api(`/api/words?filter=${state.filter}${q ? '&q=' + encodeURIComponent(q) : ''}`);
    state.words = d.words;
    renderWordList();
  } catch (e) {
    $('#wordList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderWordList() {
  const list = $('#wordList');
  if (!state.words.length) {
    list.innerHTML = '<div class="empty">没有符合条件的单词，试试其他筛选或先同步</div>';
    return;
  }
  const todayStr = bjDate();
  list.innerHTML = state.words.map(w => {
    let badge = '';
    if (w.tags?.includes('STICKING')) badge = '<span class="badge sticky">顽固</span>';
    else if (w.today?.date === todayStr && w.today?.isNew) badge = '<span class="badge new">新词</span>';
    else if (w.today?.date === todayStr && w.today?.isFinished) badge = '<span class="badge done">已完成</span>';
    const meta = w.studyCount != null ? `学过 ${w.studyCount} 次` : (w.nextStudyDate ? '到期 ' + w.nextStudyDate.slice(5, 10) : '');
    return `<div class="word-item ${state.activeWord === w.spelling ? 'active' : ''}" data-sp="${esc(w.spelling)}">
      <span class="spelling">${esc(w.spelling)}</span>
      <span style="text-align:right">${badge}<div class="meta">${meta}</div></span>
    </div>`;
  }).join('');
  $$('.word-item').forEach(el => el.addEventListener('click', () => selectWord(el.dataset.sp)));
}

function selectWord(spelling) {
  state.activeWord = spelling;
  renderWordList();
  $('#chatHeader').textContent = '当前学习：' + spelling;
  addMsg('ai', `📖 已切换到 **${spelling}**。想问什么？`, spelling === null ? null : spelling);
  // 直接替用户发起一个开场
  askAI(`请用一句话介绍「${spelling}」的核心含义和最常用的一个搭配，然后等我提问。`);
}

function addMsg(role, content, word) {
  const box = $('#chatMessages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const tag = word ? `<span class="word-tag">📘 ${esc(word)}</span>` : '';
  div.innerHTML = tag + mdLite(content);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

/** 轻量 Markdown（粗体/换行/列表） */
function mdLite(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^### (.+)$/gm, '<b>$1</b>')
    .replace(/^- (.+)$/gm, '· $1');
}

async function askAI(message, isErrorMark = false) {
  if (!message.trim()) return;
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
        history: state.chatHistory.slice(-16).map(m => ({ role: m.role, content: m.content })),
      },
    });
    loading.classList.remove('loading');
    loading.innerHTML = (state.activeWord ? `<span class="word-tag">📘 ${esc(state.activeWord)}</span>` : '') + mdLite(r.reply);
    state.chatHistory.push({ role: 'assistant', content: r.reply, word: state.activeWord });
  } catch (e) {
    loading.classList.remove('loading');
    loading.innerHTML = '❌ ' + esc(e.message) + (e.message.includes('AI 服务商') ? '（请到 设置 页配置）' : '');
  }
}

function updateSessionInfo() {
  $('#sessionInfo').textContent = `本次会话已学 ${state.sessionWords.size} 词` +
    (state.sessionErrorWords.size ? `（${state.sessionErrorWords.size} 个易错）` : '');
  $('#finishBtn').disabled = state.sessionWords.size === 0;
}

$('#sendBtn').addEventListener('click', () => {
  const v = $('#chatInput').value.trim();
  $('#chatInput').value = '';
  askAI(v);
});
$('#chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const v = $('#chatInput').value.trim(); $('#chatInput').value = ''; askAI(v); }
});

$$('#quickRow .chip.q').forEach(c => c.addEventListener('click', () => {
  askAI(c.dataset.q, !!c.dataset.error);
}));

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
  $('#themeToggle').textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('wb-theme', t);
}

$('#themeToggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ---------------- 设置页 ---------------- */

async function loadConfig() {
  try {
    const c = await api('/api/config');
    state.llmPresets = c.presets;
    const sel = $('#cfgPreset');
    sel.innerHTML = '<option value="">— 选择服务商 —</option>' +
      Object.entries(c.presets).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    if (c.hasToken) $('#cfgToken').placeholder = c.maimemoToken;
    $('#cfgLLMUrl').value = c.llm.baseUrl || '';
    $('#cfgLLMModel').value = c.llm.model || '';
    $('#cfgMock').checked = !!c.llm.mock;
    $('#cfgAutoSync').checked = !!c.autoSync.enabled;
    $('#cfgSyncMinutes').value = c.autoSync.minutes || 60;
  } catch (e) { console.error(e); }
}

$('#cfgPreset').addEventListener('change', () => {
  const p = state.llmPresets[$('#cfgPreset').value];
  if (p) { $('#cfgLLMUrl').value = p.baseUrl; $('#cfgLLMModel').value = p.model; }
});

/* 拉取模型列表（支持中转站） */
$('#fetchModelsBtn').addEventListener('click', async () => {
  const btn = $('#fetchModelsBtn');
  const sel = $('#modelSelect');
  const baseUrl = $('#cfgLLMUrl').value.trim();
  if (!baseUrl) return alert('请先填写 Base URL');
  btn.textContent = '拉取中…';
  btn.disabled = true;
  try {
    const r = await api('/api/llm/models', {
      method: 'POST',
      body: { baseUrl, apiKey: $('#cfgLLMKey').value.trim() },
    });
    if (!r.models.length) throw new Error('服务商返回了空列表');
    sel.style.display = 'block';
    sel.innerHTML = `<option value="">— 共 ${r.models.length} 个模型，点选自动填入 —</option>` +
      r.models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  } catch (e) {
    sel.style.display = 'none';
    alert('拉取失败：' + e.message);
  }
  btn.textContent = '🔄 拉取列表';
  btn.disabled = false;
});

$('#modelSelect').addEventListener('change', () => {
  if ($('#modelSelect').value) $('#cfgLLMModel').value = $('#modelSelect').value;
});

$('#saveConfigBtn').addEventListener('click', async () => {
  const body = {
    maimemoToken: $('#cfgToken').value.trim() ? $('#cfgToken').value.trim() : undefined,
    llm: {
      baseUrl: $('#cfgLLMUrl').value.trim(),
      model: $('#cfgLLMModel').value.trim(),
      mock: $('#cfgMock').checked,
    },
    autoSync: { enabled: $('#cfgAutoSync').checked, minutes: Number($('#cfgSyncMinutes').value) || 60 },
  };
  if ($('#cfgLLMKey').value.trim()) body.llm.apiKey = $('#cfgLLMKey').value.trim();
  try {
    await api('/api/config', { method: 'POST', body });
    $('#saveResult').textContent = '✅ 已保存';
    $('#saveResult').className = 'result ok';
    $('#cfgToken').value = '';
    $('#cfgLLMKey').value = '';
    loadConfig();
  } catch (e) {
    $('#saveResult').textContent = '❌ ' + e.message;
    $('#saveResult').className = 'result err';
  }
});

$('#testMaimemoBtn').addEventListener('click', async () => {
  // 若输入框填了新 token，先保存再测试
  if ($('#cfgToken').value.trim()) await saveConfigSilent();
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

$('#testLLMBtn').addEventListener('click', async () => {
  $('#llmTestResult').textContent = '测试中…';
  $('#llmTestResult').className = 'result';
  try {
    // 直接用表单当前值测试（key/baseUrl 未保存也能测），保证所见即所测
    const r = await api('/api/test/llm', {
      method: 'POST',
      body: {
        baseUrl: $('#cfgLLMUrl').value.trim() || undefined,
        apiKey: $('#cfgLLMKey').value.trim() || undefined,
        model: $('#cfgLLMModel').value.trim() || undefined,
        mock: $('#cfgMock').checked,
      },
    });
    $('#llmTestResult').textContent = '✅ ' + r.msg;
    $('#llmTestResult').className = 'result ok';
    // 测试通过后顺手把配置（含 key）存下来
    await saveConfigSilent();
  } catch (e) {
    $('#llmTestResult').textContent = '❌ ' + e.message;
    $('#llmTestResult').className = 'result err';
  }
});

$('#syncNowBtn').addEventListener('click', async () => {
  if ($('#cfgToken').value.trim()) await saveConfigSilent();
  switchTab('dashboard');
  doSync(false);
});

async function saveConfigSilent() {
  const key = $('#cfgLLMKey').value.trim();
  await api('/api/config', {
    method: 'POST',
    body: {
      maimemoToken: $('#cfgToken').value.trim() || undefined,
      llm: {
        baseUrl: $('#cfgLLMUrl').value.trim(),
        model: $('#cfgLLMModel').value.trim(),
        mock: $('#cfgMock').checked,
        ...(key ? { apiKey: key } : {}),
      },
    },
  });
}

/* ---------------- 番茄钟 ---------------- */

const POMO_KEY = 'wb-pomo';
let pomo = (() => {
  try { return JSON.parse(localStorage.getItem(POMO_KEY)) || {}; } catch { return {}; }
})();
pomo = Object.assign({
  running: false, mode: 'work', endsAt: 0, remainingMs: 25 * 60000,
  workMin: 25, breakMin: 5, sessions: {},
}, pomo);

function pomoSave() { localStorage.setItem(POMO_KEY, JSON.stringify(pomo)); }
function pomoToday() { return pomo.sessions[bjDate()] || { count: 0, minutes: 0 }; }
function pomoRemaining() { return pomo.running ? Math.max(0, pomo.endsAt - Date.now()) : pomo.remainingMs; }

function pomoRender() {
  const ms = pomoRemaining();
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  $('#pomoTime').textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  $('#pomoTime').classList.toggle('break-mode', pomo.mode === 'break');
  const pill = $('#pomoMode');
  const state = pomo.running ? '' : (pomoRemaining() < pomo.fullMs ? '已暂停 · ' : '待开始 · ');
  pill.textContent = state + (pomo.mode === 'work' ? '专注' : '休息');
  pill.classList.toggle('break', pomo.mode === 'break');
  $('#pomoStartBtn').textContent = pomo.running ? '⏸ 暂停' : '▶ 开始';
}

function pomoRenderStats() {
  const t = pomoToday();
  $('#pomoCount').textContent = t.count;
  $('#pomoMinutes').textContent = t.minutes;
}

function pomoBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.3, 0.6].forEach(delay => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; osc.type = 'sine';
      gain.gain.setValueAtTime(0.25, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.25);
      osc.start(ctx.currentTime + delay); osc.stop(ctx.currentTime + delay + 0.25);
    });
  } catch { /* 无音频设备时静默 */ }
}

function pomoNext(counted) {
  if (pomo.mode === 'work') {
    if (counted) {
      const key = bjDate();
      const d = pomo.sessions[key] || { count: 0, minutes: 0 };
      d.count++; d.minutes += pomo.workMin;
      pomo.sessions[key] = d;
    }
    pomo.mode = 'break';
    pomo.fullMs = pomo.breakMin * 60000;
  } else {
    pomo.mode = 'work';
    pomo.fullMs = pomo.workMin * 60000;
  }
  pomo.remainingMs = pomo.fullMs;
  pomo.running = true;               // 自动进入下一段
  pomo.endsAt = Date.now() + pomo.fullMs;
  pomoSave(); pomoRender(); pomoRenderStats();
}

function pomoStartPause() {
  if (pomo.running) {
    pomo.remainingMs = Math.max(0, pomo.endsAt - Date.now());
    pomo.running = false;
  } else {
    if (!pomo.fullMs) pomo.fullMs = pomo.remainingMs;
    pomo.endsAt = Date.now() + pomo.remainingMs;
    pomo.running = true;
  }
  pomoSave(); pomoRender();
}

function pomoSkip() { pomoNext(false); }

function pomoReset() {
  pomo.mode = 'work';
  pomo.fullMs = pomo.workMin * 60000;
  pomo.remainingMs = pomo.fullMs;
  pomo.running = false;
  pomoSave(); pomoRender();
}

$('#pomoStartBtn').addEventListener('click', pomoStartPause);
$('#pomoSkipBtn').addEventListener('click', pomoSkip);
$('#pomoResetBtn').addEventListener('click', pomoReset);

$('#pomoWorkMin').addEventListener('change', () => {
  const v = Math.min(120, Math.max(1, Number($('#pomoWorkMin').value) || 25));
  $('#pomoWorkMin').value = v; pomo.workMin = v;
  if (pomo.mode === 'work' && !pomo.running) { pomo.fullMs = v * 60000; pomo.remainingMs = pomo.fullMs; }
  pomoSave(); pomoRender();
});
$('#pomoBreakMin').addEventListener('change', () => {
  const v = Math.min(60, Math.max(1, Number($('#pomoBreakMin').value) || 5));
  $('#pomoBreakMin').value = v; pomo.breakMin = v;
  if (pomo.mode === 'break' && !pomo.running) { pomo.fullMs = v * 60000; pomo.remainingMs = pomo.fullMs; }
  pomoSave(); pomoRender();
});

// 全局滴答：页面在哪个标签都照常计时
setInterval(() => {
  if (pomo.running && Date.now() >= pomo.endsAt) { pomoBeep(); pomoNext(true); }
  else if (!$('#tab-pomo').classList.contains('active')) return;
  pomoRender();
}, 500);

/* ---------------- 启动 ---------------- */

(async function init() {
  applyTheme(localStorage.getItem('wb-theme') || 'light');
  // 番茄钟初始化：恢复上次进度（若页面关闭期间已到点，计入完成）
  if (!pomo.fullMs) pomo.fullMs = pomo.workMin * 60000;
  pomoRender();
  pomoRenderStats();
  try {
    const status = await api('/api/status');
    updateSyncBadge(status.lastSync ? 'ok' : 'err', status.lastSync ? formatTime(status.lastSync) : '未同步');
    if (!status.hasToken || !status.llm.configured) {
      $('#setupHint').style.display = 'block';
    }
  } catch { /* 服务未就绪时静默 */ }
  loadDashboard();
})();
