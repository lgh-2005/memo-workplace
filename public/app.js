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
  providers: [],        // AI 服务商档案列表
  activeProvId: '',     // 默认服务商 id
  useSearch: false,     // v1.0.7：联网搜索开关
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

/** 任意 ISO 时间 → 北京时间的 YYYY-MM-DD（用于「今天是否已同步」判断） */
function bjDateOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

/* ---------------- 发音（浏览器 TTS，零成本） ---------------- */

function speak(text, lang = 'en-US') {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = lang; u.rate = 0.92;
    speechSynthesis.speak(u);
  } catch { /* 浏览器不支持时静默 */ }
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

function switchTab(name) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'dashboard') loadDashboard();
  if (name === 'study') loadWords();
  if (name === 'notes') loadNotes();
  if (name === 'kb') loadKb();
  if (name === 'exam') loadExamList();
  if (name === 'unit') loadUnits();
  if (name === 'settings') loadConfig();
  // quiz 页保持进行中的状态，不重置
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
    fetchGlosses();   // 后台补释义，不阻塞列表
  } catch (e) {
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
    state.words.forEach(w => { if (got[w.spelling]) w.gloss = got[w.spelling]; });
    if ($('#tab-study').classList.contains('active')) renderWordList();
  } catch { /* 释义是增强功能，获取失败不影响主流程 */ }
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
    if (w.tags?.includes('STICKING') || w.quizResponse === 'FORGET') badge = '<span class="badge sticky">顽固</span>';
    else if (w.today?.date === todayStr && w.today?.isNew) badge = '<span class="badge new">新词</span>';
    else if (w.today?.date === todayStr && w.today?.isFinished) badge = '<span class="badge done">已完成</span>';
    const meta = w.studyCount != null ? `学过 ${w.studyCount} 次` : (w.nextStudyDate ? '到期 ' + w.nextStudyDate.slice(5, 10) : '');
    const phon = w.gloss?.phonetic ? `<span class="phonetic">${esc(w.gloss.phonetic)}</span>` : '';
    const glossLine = w.gloss?.gloss ? `<div class="gloss-line" title="${esc(w.gloss.gloss)}">${esc(w.gloss.gloss)}</div>` : '<div class="gloss-line dim">　</div>';
    return `<div class="word-item ${state.activeWord === w.spelling ? 'active' : ''}" data-sp="${esc(w.spelling)}">
      <span class="word-main">
        <span class="spelling">${esc(w.spelling)} ${phon}</span>
        ${glossLine}
      </span>
      <span style="text-align:right;flex-shrink:0">${badge}<div class="meta">${meta}</div><button class="speak-btn mini" data-speak="${esc(w.spelling)}" title="朗读">🔊</button></span>
    </div>`;
  }).join('');
  $$('.word-item').forEach(el => el.addEventListener('click', () => selectWord(el.dataset.sp)));
  $$('.word-item .speak-btn').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();   // 不触发选中
    speak(b.dataset.speak);
  }));
}

function selectWord(spelling) {
  state.activeWord = spelling;
  renderWordList();
  $('#chatHeader').textContent = '当前学习：' + spelling;
  $('#speakWordBtn').style.display = 'inline-block';
  addMsg('ai', `📖 已切换到 **${spelling}**。想问什么？`, spelling);
  // 直接替用户发起一个开场
  askAI(`请用一句话介绍「${spelling}」的核心含义和最常用的一个搭配，然后等我提问。`);
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

/* v1.0.8：发音优先韦氏真人 mp3（免费、官方 CDN），失败回退 TTS */
$('#speakWordBtn').addEventListener('click', async () => {
  const w = state.activeWord;
  if (!w) return;
  try {
    const r = await api('/api/dict/lookup?word=' + encodeURIComponent(w));
    if (r.entry?.audio) {
      new Audio(r.entry.audio).play().catch(() => speak(w));
      return;
    }
  } catch { /* 未配置词典 / 网络失败：TTS 兜底 */ }
  speak(w);
});

/** 轻量 Markdown（v1.0.5）：标题 / 加粗 / 行内代码 / 无序列表 / 简单表格 / 空行分段 */
function mdInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function mdLite(text) {
  const lines = esc(text).split('\n');
  const html = [];
  let listOpen = false;
  let table = [];   // 收集连续的表格行
  const closeList = () => { if (listOpen) { html.push('</ul>'); listOpen = false; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table
      .map(r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()))
      .filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ''));   // 去掉 |---|---| 分隔行
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
    if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); table.push(line.trim()); continue; }
    flushTable();
    if (!line.trim()) { closeList(); html.push('<div class="md-gap"></div>'); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); html.push(`<div class="md-h md-h${h[1].length}">${mdInline(h[2])}</div>`); continue; }
    const li = line.match(/^\s*[-*•]\s+(.*)$/);
    if (li) {
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      html.push(`<li>${mdInline(li[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<div>${mdInline(line)}</div>`);
  }
  closeList();
  flushTable();
  return html.join('');
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
  const loading = addMsg('ai', state.useSearch ? '🌐 正在联网搜索资料，然后思考中…' : '思考中…');
  loading.classList.add('loading');
  try {
    const r = await api('/api/chat', {
      method: 'POST',
      body: {
        spelling: state.activeWord,
        message,
        history: state.chatHistory.slice(-16).map(m => ({ role: m.role, content: m.content })),
        useSearch: !!state.useSearch,   // v1.0.7：联网搜索开关
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
  if (c.id === 'imgGenChip') return;   // 生图走独立流程
  if (c.dataset.error && !state.activeWord) {
    addMsg('ai', '⚠️ 请先在左侧词表选中一个单词，再标记「我又忘了」。');
    return;
  }
  askAI(c.dataset.q, !!c.dataset.error);
}));

/* v1.0.6：AI 生图助记 —— 结合当前对话场景生成助记图并内联展示 */
$('#imgGenChip').addEventListener('click', async () => {
  if (!state.activeWord) {
    addMsg('ai', '⚠️ 请先在左侧词表选中一个单词，再生成助记图。');
    return;
  }
  const chip = $('#imgGenChip');
  chip.disabled = true;
  const loading = addMsg('ai', '🎨 正在结合当前对话场景生成助记图…（首次生成约需 10-30 秒）');
  loading.classList.add('loading');
  try {
    const r = await api('/api/image/gen', {
      method: 'POST',
      body: {
        spelling: state.activeWord,
        context: state.chatHistory.slice(-8).map(m => ({ role: m.role, content: m.content })),
      },
    });
    loading.classList.remove('loading');
    loading.innerHTML = `<span class="word-tag">📘 ${esc(state.activeWord)}</span>
      <div class="img-note">
        <img src="${esc(r.url)}" alt="${esc(state.activeWord)} 助记图" loading="lazy">
        ${r.caption ? `<div class="img-caption">🖼️ ${esc(r.caption)}</div>` : ''}
        <div class="img-prompt">画面提示词：${esc(r.prompt)}</div>
      </div>`;
    state.chatHistory.push({
      role: 'assistant', word: state.activeWord,
      content: `🎨 生成了「${state.activeWord}」的助记图：${r.caption || ''}`,
    });
  } catch (e) {
    loading.classList.remove('loading');
    loading.innerHTML = '❌ ' + esc(e.message) + (e.message.includes('生图服务商') ? '（请到 设置 页配置）' : '');
  } finally {
    chip.disabled = false;
  }
});

/* v1.0.7：联网搜索开关 —— 开启后每次提问先让服务端搜索实时资料注入上下文 */
$('#webSearchChip').addEventListener('click', () => {
  state.useSearch = !state.useSearch;
  $('#webSearchChip').classList.toggle('active', state.useSearch);
  addMsg('ai', state.useSearch
    ? '🌐 已开启联网搜索：之后每次提问会先搜索实时资料再回答（需在 设置 页配置搜索服务）。'
    : '🌐 已关闭联网搜索。');
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

/* ---------------- 界面风格（白天模式主题） ---------------- */

function applyStyle(t) {
  document.documentElement.dataset.style = t;
  localStorage.setItem('wb-style', t);
  $$('#styleGrid .style-opt').forEach(b => b.classList.toggle('active', b.dataset.style === t));
}

$$('#styleGrid .style-opt').forEach(b => b.addEventListener('click', () => applyStyle(b.dataset.style)));

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
    $('#cfgKaoyan').checked = !!c.kaoyanMode;
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
    /* v1.1.7：AI 审核专用服务商回填 */
    if (c.review) {
      const revSel = $('#cfgReviewProvider');
      if (revSel) {
        revSel.innerHTML = '<option value="">— 同默认服务商 —</option>' +
          (c.llm.providers || []).map(p => `<option value="${esc(p.id)}"${p.id === c.review.providerId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
      }
      const revModel = $('#cfgReviewModel');
      if (revModel) revModel.value = c.review.model || '';
      const revThink = $('#cfgReviewThinking');
      if (revThink) revThink.checked = !!c.review.thinking;
    }
    renderProviders();
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
        <div class="prov-meta">${esc(p.baseUrl || '未填 Base URL')} · ${esc(p.model || '未选模型')} · ${p.hasKey ? '🔑 已存 Key' : '⚠️ 无 Key'}</div>
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

function openProvModal(id) {
  provEditId = id || '';
  const p = id ? state.providers.find(x => x.id === id) : null;
  $('#provModalTitle').textContent = p ? '编辑服务商：' + p.name : '添加服务商';
  $('#provName').value = p?.name || '';
  $('#provPreset').value = '';
  $('#provUrl').value = p?.baseUrl || '';
  $('#provKey').value = '';
  $('#provKey').placeholder = p?.hasKey ? '已保存 Key（留空 = 沿用）' : '粘贴 API Key';
  $('#provModel').value = p?.model || '';
  $('#provModelSelect').style.display = 'none';
  $('#provTestResult').textContent = '';
  $('#provTestResult').className = 'result';
  $('#provModal').style.display = 'flex';
}

$('#addProvBtn').addEventListener('click', () => openProvModal(''));
$('#provCancel').addEventListener('click', () => $('#provModal').style.display = 'none');

$('#provPreset').addEventListener('change', () => {
  const pr = provPresets[$('#provPreset').value];
  if (pr) { $('#provUrl').value = pr.baseUrl; $('#provModel').value = pr.model; }
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
  if (provEditId) item.id = provEditId;
  if (key) item.apiKey = key;
  const providers = provEditId
    ? state.providers.map(p => (p.id === provEditId ? { ...p, ...item } : { ...p }))
    : [...state.providers, item];
  try {
    await saveProviders(providers);
    $('#provModal').style.display = 'none';
  } catch (e) { alert(e.message); }
});

$('#cfgMock').addEventListener('change', async () => {
  try { await api('/api/config', { method: 'POST', body: { llm: { mock: $('#cfgMock').checked } } }); }
  catch (e) { alert(e.message); }
});
/* v1.1.7：保存 AI 审核专用服务商 */
$('#saveReviewCfgBtn').addEventListener('click', async () => {
  const btn = $('#saveReviewCfgBtn');
  const prev = btn.textContent;
  try {
    btn.disabled = true;
    await api('/api/config', { method: 'POST', body: { review: {
      providerId: $('#cfgReviewProvider').value,
      model: $('#cfgReviewModel').value.trim(),
      thinking: $('#cfgReviewThinking').checked,
    } } });
    btn.textContent = '✅ 已保存';
    setTimeout(() => { btn.textContent = prev; }, 2000);
  } catch (e) {
    alert('保存失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

/* 考研模式：即时生效并持久化，聊天页徽章同步 */
$('#cfgKaoyan').addEventListener('change', async () => {
  const on = $('#cfgKaoyan').checked;
  try {
    await api('/api/config', { method: 'POST', body: { kaoyanMode: on } });
    $('#kaoyanBadge').style.display = on ? 'inline-block' : 'none';
  } catch (e) {
    alert(e.message);
    $('#cfgKaoyan').checked = !on;
  }
});

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
  const title = id ? (sel.options[sel.selectedIndex]?.textContent || '') : '';
  try {
    await api('/api/config', { method: 'POST', body: { maimemoNotepadId: id, notepadTitle: title } });
    out.textContent = id ? '✅ 已绑定云词库，之后推送助记会自动确保单词在库中' : '已解绑';
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

$('#saveConfigBtn').addEventListener('click', async () => {
  try {
    await api('/api/config', {
      method: 'POST',
      body: {
        maimemoToken: $('#cfgToken').value.trim() || undefined,
        autoSync: { enabled: $('#cfgAutoSync').checked, minutes: Number($('#cfgSyncMinutes').value) || 60 },
      },
    });
    $('#saveResult').textContent = '✅ 已保存';
    $('#saveResult').className = 'result ok';
    $('#cfgToken').value = '';
    loadConfig();
  } catch (e) {
    $('#saveResult').textContent = '❌ ' + e.message;
    $('#saveResult').className = 'result err';
  }
});

$('#testMaimemoBtn').addEventListener('click', async () => {
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

$('#syncNowBtn').addEventListener('click', async () => {
  if ($('#cfgToken').value.trim()) await saveConfigSilent();
  switchTab('dashboard');
  doSync(false);
});

async function saveConfigSilent() {
  await api('/api/config', {
    method: 'POST',
    body: { maimemoToken: $('#cfgToken').value.trim() || undefined },
  });
}

/* ---------------- 语料库（v1.1.0：题库 + 语料，读 corpus/records.jsonl） ---------------- */

const KB_SECTION_LABEL = {
  use_of_english: '完形填空', reading: '阅读 A', part_b: '新题型',
  translation: '翻译', writing: '写作',
};
const kbState = { records: [], filter: '', loaded: false };   // v1.1.2：filter = 来源分类（外刊/教材/真题/直录）

async function loadKb() {
  if (kbState.loaded) return;
  try {
    const r = await api('/api/kb/records');
    kbState.records = r.records || [];
    kbState.loaded = true;
    if (!r.exists) {
      $('#kbListResult').textContent = '⚠️ 未找到语料库文件：' + r.file + '（把导入工程的 records.jsonl 同步到 corpus/ 即可）';
      $('#kbListResult').className = 'result err';
    }
    renderKbList();
  } catch (e) { console.error(e); }
}

function renderKbList() {
  const box = $('#kbList');
  const list = kbState.records.filter(r => !kbState.filter || (r.source && r.source.category) === kbState.filter);
  if (!list.length) {
    box.innerHTML = '<div class="empty-prov">该类型下暂无记录。可用下方「📥 导入语料」直接导入文件或粘贴文本。</div>';
    return;
  }
  box.innerHTML = list.map(r => `
    <div class="kb-item" data-rid="${esc(r.id)}">
      <div class="kb-item-head">
        <span class="badge kb-badge kb-badge-${esc(r.rtype)}">${esc(r.rtypeLabel)}</span>
        ${r.year ? `<span class="badge kb-badge-year">${r.year} 年</span>` : ''}
        <b>${esc(r.title)}</b>
      </div>
      <div class="kb-item-meta">${[
        r.questions ? r.questions + ' 题' : '',
        r.itemCount ? r.itemCount + ' 个条目' : '',
        r.source?.parser ? '解析器 ' + esc(r.source.parser) : '',
        r.source?.imported_at ? '导入 ' + esc(String(r.source.imported_at).slice(0, 10)) : '',
      ].filter(Boolean).join(' · ')}</div>
      ${r.preview ? `<div class="kb-item-preview">${esc(r.preview)}…</div>` : ''}
    </div>`).join('');
  $$('#kbList .kb-item').forEach(el => el.addEventListener('click', () => openKbRecord(el.dataset.rid)));
}

/** 〖N〗 锚点渲染：〖N〗…〖/N〗 配对 = 翻译划线句；独立 〖N〗 = 挖空/答题框 */
function kbText(text) {
  let s = esc(String(text || ''));
  s = s.replace(/〖(\d+)〗([\s\S]*?)〖\/\1〗/g,
    (m, n, inner) => `<span class="kb-underline"><span class="kb-blank-n">${n}</span>${inner.trim()}</span>`);
  s = s.replace(/〖(\d+)〗/g, (m, n) => `<span class="kb-blank">${n}</span>`);
  return s.split(/\n+/).filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
}

async function openKbRecord(rid) {
  const card = $('#kbDetailCard');
  card.style.display = 'block';
  $('#kbDetail').innerHTML = '<div class="hint">加载中…</div>';
  try {
    const r = await api('/api/kb/record/' + rid);
    const rec = r.record;
    kbDetailState = { prefix: 'kb', id: rid, rec: null };
    kbCloseEditor();
    $('#kbIssuesPanel').innerHTML = '';
    $('#kbDetailTitle').textContent = rec.title || rec.id;
    $('#kbDetailMeta').textContent = [
      rec.rtypeLabel, rec.meta?.year ? rec.meta.year + ' 年' : '',
      rec.meta?.questions ? rec.meta.questions + ' 题' : '',
      rec.source ? `${rec.source.file || ''} · ${rec.source.parser || ''} · 导入 ${String(rec.source.imported_at || '').slice(0, 10)}` : '',
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
    out.textContent = `✅ 命中 ${r.count} 条真实语料（点击可跳原文）`;
    out.className = 'result ok';
    $('#kbList').innerHTML = r.results.map(h => `
      <div class="kb-item" data-rid="${esc(h.rid)}">
        <div class="kb-sentence">${esc(h.s)}</div>
        <div class="kb-item-meta">来源：${esc(h.title)}${h.year ? ' · ' + h.year + ' 年' : ''}${h.section ? ' · ' + esc(KB_SECTION_LABEL[h.section] || h.section) : ''}${h.number ? ' · 第 ' + h.number + ' 题' : ''}</div>
      </div>`).join('');
    $$('#kbList .kb-item').forEach(el => el.addEventListener('click', () => openKbRecord(el.dataset.rid)));
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

/* ---------------- 真题库（v1.1.2：qa_set 分库 +「考试-题型」专项处理） ---------------- */

const examState = { records: [], loaded: false };

const EXAM_TYPE_FALLBACK = {
  use_of_english: '考研-完形填空', reading: '考研-阅读理解', part_b: '考研-新题型',
  translation: '考研-翻译', writing: '考研-写作',
};

/* 「考试-题型」处理器注册表：每个题型一个独立模块，统一契约——
   { icon, analyze(items) -> 统计行, render(items) -> html }
   板块展示名以服务端下发的 label 为准（考试-题型 格式）。 */
const EXAM_PROCESSORS = {
  use_of_english: {
    icon: '🔲',
    analyze(items) {
      const blanks = new Set();
      let qs = 0, opts = 0;
      for (const it of items) {
        if (it.type === 'passage') for (const m of String(it.text || '').matchAll(/〖(\d+)〗/g)) blanks.add(+m[1]);
        if (it.type === 'question') { qs++; if (it.options) opts++; }
      }
      return `挖空 ${blanks.size} 处 · 题目 ${qs} 题 · 带选项 ${opts} 题`;
    },
    render: kbExamPassageAndQuestions,
  },
  reading: {
    icon: '📖',
    analyze(items) {
      const pids = new Set(items.filter(i => i.type === 'passage' && i.passage_id != null).map(i => i.passage_id));
      const qs = items.filter(i => i.type === 'question').length;
      const per = pids.size ? qs / pids.size : 0;
      return `${pids.size || '—'} 篇文章 · ${qs} 题 · 每篇 ${per && Number.isInteger(per) ? per : per ? per.toFixed(1) : '—'} 题`;
    },
    render: kbExamPassageAndQuestions,
  },
  part_b: {
    icon: '🧩',
    analyze(items) {
      const blanks = new Set();
      let pool = 0, qs = 0;
      for (const it of items) {
        if (it.type === 'passage') for (const m of String(it.text || '').matchAll(/〖(4[1-5])〗/g)) blanks.add(+m[1]);
        if (it.type === 'question' && it.number == null && it.options) pool = Object.keys(it.options).length;
        if (it.type === 'question' && it.number != null) qs++;
      }
      return `空位 ${blanks.size} 处 · 选项池 ${pool || '—'} 项 · 待选 ${qs} 空`;
    },
    render(items, base = 0) {
      let html = '';
      for (const [ix, it] of items.entries()) {
        if (it.type === 'passage') {
          html += `<div class="kb-passage" data-itemidx="${base + ix}">${kbText(it.text)}</div>`;
        } else if (it.type === 'question' && it.number == null) {
          const opts = it.options
            ? Object.entries(it.options).map(([k, v]) => `<span class="kb-opt"><b>${esc(k)}.</b> ${esc(v)}</span>`).join('')
            : esc(it.text || '');
          html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">🧩 选项池（含干扰项）</div><div class="kb-opts">${opts}</div></div>`;
        } else if (it.type === 'question') {
          html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">第 ${esc(String(it.number ?? '—'))} 空 · 从选项池中选出填入</div><div class="exm-slot">答题位（在线作答后续版本开放）</div></div>`;
        }
      }
      return html;
    },
  },
  translation: {
    icon: '🖊',
    analyze(items) {
      const ul = new Set();
      let qs = 0;
      for (const it of items) {
        if (it.type === 'passage') for (const m of String(it.text || '').matchAll(/〖(\d+)〗/g)) ul.add(+m[1]);
        if (it.type === 'question') qs++;
      }
      return `划线句 ${ul.size} 句 · 待译 ${qs} 题（每题 2 分 · 手写译文）`;
    },
    render(items, base = 0) {
      let html = '';
      for (const [ix, it] of items.entries()) {
        if (it.type === 'passage') {
          html += `<div class="kb-passage" data-itemidx="${base + ix}">${kbText(it.text)}</div>`;
        } else {
          html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">🖊 第 ${esc(String(it.number ?? '—'))} 题 · 将划线句译成中文（2 分）</div><div class="exm-slot">答题位（在线作答后续版本开放）</div></div>`;
        }
      }
      return html;
    },
  },
  writing: {
    icon: '📝',
    analyze(items) {
      const ws = items.filter(i => i.type === 'writing');
      const score = ws.reduce((a, b) => a + (Number(b.score) || 0), 0);
      return `${ws.length} 道写作题 · 合计 ${score || '—'} 分`;
    },
    render(items, base = 0) {
      let html = '';
      for (const [ix, it] of items.entries()) {
        if (it.type !== 'writing') continue;
        html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">✍️ 作文题${it.part ? ' · Part ' + esc(it.part) : ''}${it.score ? ' · ' + esc(String(it.score)) + ' 分' : ''}</div><div class="kb-q-text">${kbText(it.text)}</div></div>`;
      }
      return html;
    },
  },
};

function examProcessor(section) {
  return EXAM_PROCESSORS[section] || {
    icon: '🧩',
    analyze(items) { return `${items.length} 个条目`; },
    render: kbExamPassageAndQuestions,
  };
}

/** 通用题型渲染：原文（〖N〗锚点）在前，题目（题干+选项+答案）在后 */
function kbExamPassageAndQuestions(items, base = 0) {
  let html = '';
  for (const [ix, it] of items.entries()) {
    if (it.type === 'passage') {
      html += `<div class="kb-passage" data-itemidx="${base + ix}">${kbText(it.text)}</div>`;
    } else if (it.type === 'writing') {
      html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">✍️ 作文题${it.part ? ' · Part ' + esc(it.part) : ''}${it.score ? ' · ' + esc(String(it.score)) + ' 分' : ''}</div><div class="kb-q-text">${kbText(it.text)}</div></div>`;
    } else {
      const opts = it.options
        ? Object.entries(it.options).map(([k, v]) => `<span class="kb-opt"><b>${esc(k)}.</b> ${esc(v)}</span>`).join('')
        : '';
      html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">第 ${esc(String(it.number ?? '—'))} 题 · ${esc(it.qtype || '客观题')}${it.score != null ? ' · ' + esc(String(it.score)) + ' 分' : ''}${it.answer ? ` · <span class="kb-ans">答案：${esc(it.answer)}</span>` : ''}</div><div class="kb-q-text">${kbText(it.text)}</div>${opts ? `<div class="kb-opts">${opts}</div>` : ''}</div>`;
    }
  }
  return html;
}

async function loadExamList() {
  if (examState.loaded) return;
  try {
    const r = await api('/api/exam/records');
    examState.records = r.records || [];
    examState.loaded = true;
    if (!r.exists) {
      $('#exListResult').textContent = '⚠️ 未找到真题库文件：' + r.file;
      $('#exListResult').className = 'result err';
    }
    renderExamList();
  } catch (e) { console.error(e); }
}

function renderExamList() {
  const box = $('#exList');
  if (!examState.records.length) {
    box.innerHTML = '<div class="empty-prov">真题库还是空的。用上方「🗂 导入真题」导入 tex / pdf 真题源。</div>';
    return;
  }
  box.innerHTML = examState.records.map(r => `
    <div class="kb-item" data-exid="${esc(r.id)}">
      <div class="kb-item-head">
        <span class="badge kb-badge kb-badge-qa_set">${esc(r.rtypeLabel)}</span>
        ${r.year ? `<span class="badge kb-badge-year">${r.year} 年</span>` : ''}
        <b>${esc(r.title)}</b>
      </div>
      <div class="kb-item-meta">${[
        r.questions ? r.questions + ' 题' : '',
        r.source?.parser ? '解析器 ' + esc(r.source.parser) : '',
        r.source?.imported_at ? '导入 ' + esc(String(r.source.imported_at).slice(0, 10)) : '',
      ].filter(Boolean).join(' · ')}</div>
      ${(r.sections || []).length ? `<div class="exm-chips">${r.sections.map(s => `<span class="chip exm-chip">${esc(s.label)} ${s.questions || s.writings || s.passages || ''}</span>`).join('')}</div>` : ''}
      ${r.preview ? `<div class="kb-item-preview">${esc(r.preview)}…</div>` : ''}
    </div>`).join('');
  $$('#exList .kb-item').forEach(el => el.addEventListener('click', () => openExamRecord(el.dataset.exid)));
}

async function openExamRecord(exid) {
  const card = $('#exDetailCard');
  card.style.display = 'block';
  $('#exDetail').innerHTML = '<div class="hint">加载中…</div>';
  try {
    const r = await api('/api/exam/record/' + exid);
    const rec = r.record;
    kbDetailState = { prefix: 'ex', id: exid, rec: null };
    kbCloseEditor();
    $('#exIssuesPanel').innerHTML = '';
    $('#exDetailTitle').textContent = rec.title || rec.id;
    $('#exDetailMeta').textContent = [
      rec.rtypeLabel, rec.meta?.year ? rec.meta.year + ' 年' : '',
      rec.meta?.questions ? rec.meta.questions + ' 题' : '',
      rec.source ? `${rec.source.file || ''} · ${rec.source.parser || ''} · 导入 ${String(rec.source.imported_at || '').slice(0, 10)}` : '',
    ].filter(Boolean).join(' · ');

    // 按「考试-题型」分块：每块交给独立处理器（统一 analyze + render 契约）
    const blocks = [];
    for (const it of (rec.items || [])) {
      const s = it.section || 'misc';
      if (!blocks.length || blocks[blocks.length - 1].key !== s) {
        const label = (rec.sections || []).find(x => x.key === s)?.label
          || EXAM_TYPE_FALLBACK[s] || ('考研-' + (s === 'misc' ? '其他' : s));
        blocks.push({ key: s, label, items: [] });
      }
      blocks[blocks.length - 1].items.push(it);
    }
    let html = '';
    let ixBase = 0;
    for (const b of blocks) {
      const proc = examProcessor(b.key);
      html += `<div class="exm-block"><div class="kb-sec-title">${proc.icon} ${esc(b.label)}</div><div class="exm-stats">${esc(proc.analyze(b.items))}</div>${proc.render(b.items, ixBase)}</div>`;
      ixBase += b.items.length;
    }
    $('#exDetail').innerHTML = html || '<div class="hint">（无条目）</div>';
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#exDetail').innerHTML = '❌ ' + esc(e.message);
  }
}

async function exDoImport() {
  const out = $('#exImportResult');
  const files = [...$('#exImportFile').files];
  if (!files.length) {
    out.textContent = '⚠️ 请先选择 tex / pdf 文件';
    out.className = 'result err';
    return;
  }
  const items = [];
  for (const f of files) {
    if (f.size > 30 * 1024 * 1024) {
      out.textContent = `❌ ${f.name} 超过 30MB 上限`;
      out.className = 'result err';
      return;
    }
    items.push({ name: f.name, data64: await kbFileToB64(f) });
  }
  out.textContent = '拆题解析中…（TeX 秒级，PDF 视大小而定）';
  out.className = 'result';
  try {
    const r = await api('/api/exam/import', { method: 'POST', body: { items } });
    const lines = r.results.map(x => x.ok
      ? `✅ ${esc(x.file)} → ${x.records} 条记录（${esc((x.rtypes || []).join('/'))} · 解析器 ${esc(x.parser || '')}${x.store && x.store.includes('corpus') ? ' · 拆题未达阈值，整卷落入语料库（真题正文）' : ''}）`
      : `⛔ ${esc(x.file)} 已隔离：${esc(x.reason || '')}${x.hint ? '（' + esc(x.hint) + '）' : ''}`);
    out.innerHTML = lines.join('<br>') + `<br>合计：成功 ${r.imported} · 隔离 ${r.quarantined}`;
    out.className = r.quarantined ? 'result err' : 'result ok';
    $('#exImportFile').value = '';
    examState.loaded = false;   // 重新拉取真题列表
    loadExamList();
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

$('#exImportBtn').addEventListener('click', exDoImport);
$('#exLogBtn').addEventListener('click', () => kbShowLog('#exImportResult'));
$('#exBackBtn').addEventListener('click', () => {
  $('#exDetailCard').style.display = 'none';
  renderExamList();
  $('#exListResult').textContent = '';
  $('#exListResult').className = 'result';
});

/* ---------------- v1.1.5：单元题库（整卷切片 + 分题型做题规则） ---------------- */

const unitState = { units: [], loaded: false, filter: '' };
const UNIT_SEC_LABEL = { use_of_english: '完形填空', reading: '阅读理解', part_b: '新题型', translation: '翻译', writing: '写作' };

async function loadUnits() {
  if (unitState.loaded) return;
  try {
    const r = await api('/api/unit/records');
    unitState.units = r.units || [];
    unitState.loaded = true;
    renderUnitList();
  } catch (e) { console.error(e); }
}

function renderUnitList() {
  const box = $('#unitList');
  const list = unitState.units.filter(u => !unitState.filter || u.section === unitState.filter);
  if (!list.length) {
    box.innerHTML = '<div class="empty-prov">还没有单元。到「🗂 真题库」导入 tex / 文字层 PDF，拆题成功后单元自动生成。</div>';
    return;
  }
  box.innerHTML = list.map(u => `
    <div class="kb-item" data-uid="${esc(u.unitId)}">
      <div class="kb-item-head">
        <span class="badge kb-badge kb-badge-qa_set">${esc(u.label)}</span>
        ${u.year ? `<span class="badge kb-badge-year">${u.year} 年</span>` : ''}
        <b>${esc(u.title)}</b>
        ${u.hasAnswer ? '<span class="badge kb-badge-year">有答案</span>' : ''}
      </div>
      <div class="kb-item-meta">${[u.qCount ? u.qCount + ' 题' : '', u.itemCount + ' 个条目', u.scored ? '可判分' : '主观题'].filter(Boolean).join(' · ')}</div>
      ${u.preview ? `<div class="kb-item-preview">${esc(u.preview)}…</div>` : ''}
    </div>`).join('');
  $$('#unitList .kb-item').forEach(el => el.addEventListener('click', () => openUnit(el.dataset.uid)));
}

$$('#unitFilters .chip').forEach(c => c.addEventListener('click', () => {
  unitState.filter = c.dataset.usec || '';
  $$('#unitFilters .chip').forEach(x => x.classList.toggle('active', x === c));
  renderUnitList();
}));

$('#unitBackBtn').addEventListener('click', () => {
  $('#unitDetailCard').style.display = 'none';
  renderUnitList();
});

/* 分题型生题规则：把单元条目渲染成真实做题形态（完形=挖空内联选词 / 阅读=逐题单选 /
   新题型=空位+选项池 / 翻译=划线句+译文框 / 写作=题干+作文框） */
function unitPracticeHtml(unit, items) {
  const passage = items.find(it => it.type === 'passage');
  const writings = items.filter(it => it.type === 'writing');
  const qs = items.filter(it => it.type === 'question');

  if (unit.section === 'use_of_english' && passage) {
    const qByNum = {};
    qs.forEach(q => { qByNum[q.number] = q; });
    let s = esc(passage.text || '').replace(/〖\/\d+〗/g, '');
    s = s.replace(/〖(\d+)〗/g, (m, n) => {
      const q = qByNum[Number(n)];
      const opts = q && q.options
        ? Object.entries(q.options).map(([k, v]) => `<option value="${esc(k)}">${esc(k)}. ${esc(String(v).slice(0, 42))}</option>`).join('')
        : '';
      return `<span class="u-blank"><b>${n}</b><select class="input u-pick" data-num="${n}"><option value="">—</option>${opts}</select></span>`;
    });
    const html = s.split(/\n+/).filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
    return { body: `<div class="kb-passage">${html}</div>` };
  }
  if (unit.section === 'part_b' && passage) {
    let s = esc(passage.text || '').replace(/〖\/\d+〗/g, '');
    s = s.replace(/〖(\d+)〗/g, (m, n) =>
      `<span class="u-gap"><b>${n}</b><select class="input u-pick" data-num="${n}"><option value="">—</option>${'ABCDEFG'.split('').map(k => `<option value="${k}">${k}</option>`).join('')}</select></span>`);
    const html = s.split(/\n+/).filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
    const src = qs.find(q => q.options);
    const poolHtml = src ? `<div class="kb-sec-title">选项池</div><div class="kb-opts">${Object.entries(src.options).map(([k, v]) => `<span class="kb-opt"><b>${esc(k)}.</b> ${esc(v)}</span>`).join('')}</div>` : '';
    return { body: `<div class="kb-passage">${html}</div>${poolHtml}` };
  }
  if (unit.section === 'reading') {
    let html = passage ? `<div class="kb-passage">${kbText(passage.text)}</div>` : '';
    html += qs.map(q => {
      const opts = q.options ? Object.entries(q.options).map(([k, v]) =>
        `<label class="u-opt"><input type="radio" name="q${esc(String(q.number))}" value="${esc(k)}" data-num="${esc(String(q.number))}"><b>${esc(k)}.</b> ${esc(v)}</label>`).join('')
        : '';
      return `<div class="kb-question"><div class="kb-q-head">第 ${esc(String(q.number ?? '—'))} 题</div><div class="kb-q-text">${kbText(q.text)}</div><div class="u-opts">${opts}</div></div>`;
    }).join('');
    return { body: html };
  }
  if (unit.section === 'translation') {
    let html = passage ? `<div class="kb-passage">${kbText(passage.text)}</div>` : '';
    html += qs.map(q => `<div class="kb-question"><div class="kb-q-head">第 ${esc(String(q.number ?? '—'))} 题 · 将划线句译成中文</div><textarea class="input u-trans" data-num="${esc(String(q.number ?? ''))}" rows="3" placeholder="写下你的译文…"></textarea></div>`).join('');
    return { body: html };
  }
  if (unit.section === 'writing') {
    const w = writings[0] || items[0] || {};
    return { body: `<div class="kb-question"><div class="kb-q-head">✍️ ${esc(w.part ? 'Part ' + w.part : '作文')}${w.score ? ' · ' + esc(String(w.score)) + ' 分' : ''}</div><div class="kb-q-text">${kbText(w.text || '')}</div><textarea class="input u-essay" rows="12" placeholder="在纸上写完再对照解析，或直接在此打草稿…"></textarea></div>` };
  }
  return { body: items.map(it => `<div class="kb-passage">${kbText(it.text)}</div>`).join('') };
}

async function openUnit(uid) {
  const card = $('#unitDetailCard');
  card.style.display = 'block';
  $('#unitDetail').innerHTML = '<div class="hint">加载中…</div>';
  try {
    const r = await api('/api/unit/detail/' + encodeURIComponent(uid));
    const unit = r.unit, items = r.items, answerState = r.answerState;
    $('#unitDetailTitle').textContent = unit.title;
    $('#unitDetailMeta').textContent = [
      unit.label, unit.year ? unit.year + ' 年' : '',
      unit.qCount + ' 题',
      answerState.has ? '已录标准答案（' + answerState.keys.length + ' 题）' : '未录标准答案',
    ].filter(Boolean).join(' · ');

    const { body } = unitPracticeHtml(unit, items);
    $('#unitDetail').innerHTML = body + `
      <div class="row-gap" style="margin-top:14px">
        <button class="btn primary" id="unitSubmitBtn">✅ 提交答案</button>
        <button class="btn" id="unitAnswerBtn">📝 录入标准答案</button>
        <button class="btn ghost" id="unitBackBtn2">← 返回列表</button>
      </div>
      <div class="result" id="unitResult"></div>
      <div id="unitAnswerPanel" style="display:none"></div>`;

    $('#unitBackBtn2').addEventListener('click', () => {
      card.style.display = 'none';
      renderUnitList();
    });

    $('#unitSubmitBtn').addEventListener('click', async () => {
      const answers = {};
      $$('#unitDetail .u-pick').forEach(s => { if (s.value) answers[s.dataset.num] = s.value; });
      $$('#unitDetail .u-opt input:checked').forEach(r2 => { answers[r2.dataset.num] = r2.value; });
      $$('#unitDetail .u-trans').forEach(t => { if (t.value.trim()) answers[t.dataset.num] = '[译] ' + t.value.trim().slice(0, 500); });
      const out = $('#unitResult');
      out.textContent = '判分中…';
      out.className = 'result';
      try {
        const r2 = await api('/api/unit/answers/submit', { method: 'POST', body: { unitId: uid, answers } });
        const lines = r2.results.map(x => x.ok === null
          ? (x.picked ? `<div>· 第 ${esc(String(x.number))} 题：作答已记录（无标准答案，不判分）</div>` : '')
          : `<div class="${x.ok ? 'u-ok' : 'u-bad'}">第 ${esc(String(x.number))} 题：${x.ok ? '✓ 正确' : '✗ 错误'}${!x.ok && x.correct ? ' · 正确答案 ' + esc(x.correct) : ''}${!x.ok && x.picked ? ' · 你选了 ' + esc(x.picked) : ''}</div>`);
        out.innerHTML = (r2.hasStd
          ? `<b>客观题：${r2.correct}/${r2.judged} 正确</b><br>`
          : '该单元尚未录入标准答案——点「📝 录入标准答案」后即可判分（作答已记录）<br>') + lines.join('');
        out.className = r2.hasStd && r2.judged && r2.correct === r2.judged ? 'result ok' : 'result';
      } catch (e) {
        out.textContent = '❌ ' + e.message;
        out.className = 'result err';
      }
    });

    $('#unitAnswerBtn').addEventListener('click', () => {
      const panel = $('#unitAnswerPanel');
      if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
      const qws = items.filter(it => it.type === 'question' && it.options);
      if (!qws.length) { panel.innerHTML = '<div class="hint">该单元没有可判分的客观题。</div>'; panel.style.display = 'block'; return; }
      panel.innerHTML = `<div class="card-title" style="margin-top:10px">📝 录入标准答案（请用权威版答案人工录入；标准答案不影响本机数据，仅存 data/answers.json）</div>
        <div class="u-ans-grid">${qws.map(q => {
          const keys = Object.keys(q.options || {});
          return `<span class="u-ans-item">第 ${esc(String(q.number))} 题 <select class="input u-std" data-num="${esc(String(q.number))}"><option value="">—</option>${keys.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}</select>${answerState.keys.includes(String(q.number)) ? '<span class="u-ok">已有</span>' : ''}</span>`;
        }).join('')}</div>
        <div class="row-gap" style="margin-top:8px"><button class="btn primary" id="unitAnsSave">💾 保存答案</button></div>
        <div class="result" id="unitAnsResult"></div>`;
      panel.style.display = 'block';
      $('#unitAnsSave').addEventListener('click', async () => {
        const answers = {};
        $$('#unitAnswerPanel .u-std').forEach(s => { if (s.value) answers[s.dataset.num] = s.value; });
        const out = $('#unitAnsResult');
        try {
          const r2 = await api('/api/unit/answers/save', { method: 'POST', body: { unitId: uid, answers } });
          out.textContent = '✅ 已保存 ' + r2.saved + ' 条标准答案';
          out.className = 'result ok';
          unitState.loaded = false;
        } catch (e) {
          out.textContent = '❌ ' + e.message;
          out.className = 'result err';
        }
      });
    });

    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#unitDetail').innerHTML = '❌ ' + esc(e.message);
  }
}

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
  const isExam = store === 'exam';
  const out = isExam ? $('#exImportResult') : $('#kbImportResult');
  const fileInput = isExam ? $('#exMineruFile') : $('#kbMineruFile');
  const ocr = isExam ? $('#exMineruOcr').checked : $('#kbMineruOcr').checked;
  const category = isExam ? '真题' : $('#kbImportCategory').value;
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
      const r = await api('/api/mineru/parse', { method: 'POST', body: { items: [{ name: f.name, data64: await kbFileToB64(f) }], ocr, category } });
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
  if (isExam) { examState.loaded = false; loadExamList(); }
  else { kbState.loaded = false; loadKb(); }
}

$('#kbMineruBtn').addEventListener('click', () => mineruDoImport('corpus'));
$('#exMineruBtn').addEventListener('click', () => mineruDoImport('exam'));

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
      if (prefix === 'kb') { kbState.loaded = false; loadKb(); openKbRecord(kbDetailState.id); }
      else { examState.loaded = false; loadExamList(); openExamRecord(kbDetailState.id); }
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
    $('#' + (prefix === 'kb' ? 'kbDetailCard' : 'exDetailCard')).style.display = 'none';
    if (prefix === 'kb') { kbState.loaded = false; loadKb(); }
    else { examState.loaded = false; loadExamList(); }
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

/* AI 审读：LLM 找解析疑点，只出清单不改数据（建议者，不是提交者）。
   v1.1.6：审核对象 = 整理后题库内容（与页面一致）+ 真题原件参考；疑点带 quote 逐字摘录与
   服务端定位（itemIdx/itemTag/itemText），「📍 定位到此」滚动高亮题库对应条目。 */
async function kbDoReview() {
  const { prefix, id } = kbDetailState;
  if (!id) return;
  const out = $('#' + prefix + 'IssuesPanel');
  out.innerHTML = '<div class="hint kb-busy">AI 审读中…（报告生成后本行自动消失）</div>';
  try {
    const r = await api('/api/kb/review', { method: 'POST', body: { id } });
    const cls = { high: 'kb-issue-high', mid: 'kb-issue-mid', low: 'kb-issue-low' };
    const located = r.issues.filter(x => x.itemIdx != null).length;
    const modelTag = r.modelUsed ? (r.modelUsed.model ? ` · ${esc(r.modelUsed.model)}` : '') : '';
    const head = `<div class="card-title" style="margin-top:10px">🤖 AI 审读报告 · ${esc(String(r.reviewed_at).replace('T', ' '))}${r.mock ? ' · mock' : ''}${modelTag}</div>` +
      (r.materialStats ? `<details class="hint-fold" style="margin:4px 0 0"><summary>📊 审核范围 · 定位成功 ${located}/${r.issues.length}</summary><div class="hint">审核对象：整理后题库内容 ${r.materialStats.items} 个条目 / ${r.materialStats.chars} 字符${r.materialStats.truncated ? '，<b>超长已截断</b>' : ''}${r.materialStats.hasRef ? ' + 真题原件参考' : ''}。</div></details>` : '');
    /* v1.1.7e：按题型板块分组汇总（完形/阅读/翻译…），便于集中修改同一板块 */
    const secOf = x => {
      const m = String(x.itemTag || '').match(/^[a-z_]+·([a-z_]+)/);
      return m ? m[1] : (x.itemIdx != null ? 'misc' : 'unlocated');
    };
    const GROUP_ICON = { use_of_english: '🔲 完形填空', reading: '📖 阅读理解', part_b: '🧩 新题型', translation: '🖊 翻译', writing: '📝 写作', misc: '📌 其他条目', unlocated: '🔍 未定位疑点' };
    const groups = [];
    const bySec = new Map();
    r.issues.forEach((x, i) => {
      const s = secOf(x);
      if (!bySec.has(s)) { const g = { sec: s, idxs: [] }; bySec.set(s, g); groups.push(g); }
      bySec.get(s).idxs.push(i);
    });
    const cardHtml = (x, i) => `
        <div class="kb-issue ${cls[x.severity] || 'kb-issue-mid'}">
          <div class="kb-issue-head"><b>${esc(x.loc)}</b>${x.itemTag ? `<span>· ${esc(x.itemTag)}</span>` : ''}<span>· ${esc(x.severity)}</span>${x.itemIdx != null ? `<button class="btn ghost" style="padding:2px 10px;font-size:12px;margin-left:auto" data-locate="${i}">📍 定位到此</button>` : ''}</div>
          <div>${esc(x.desc)}</div>
          ${x.quote ? `<div class="kb-issue-quote">“${esc(x.quote)}”</div>` : ''}
        </div>`;
    const body = r.issues.length
      ? groups.map(g => `
        <div class="kb-issue-group" data-kb-sec="${g.sec}">
          <div class="kb-issue-group-head"><b>${GROUP_ICON[g.sec] || '📌 其他'}</b><span>· ${g.idxs.length} 处疑点</span><span class="kb-group-fixed" style="display:none;color:var(--ok);font-weight:600"></span></div>
          ${g.idxs.map(i => cardHtml(r.issues[i], i)).join('')}
        </div>`).join('')
      : '<div class="hint">✅ 未发现明显疑点（仅供参考，改动走人工编辑）</div>';
    out.innerHTML = head + body + `<div id="${prefix}LocateBox"></div>`;
    /* v1.1.7b：定位到此 → 弹窗直编（textarea 可改原文，保存同步库），附题型规则参考 */
    $$('#' + prefix + 'IssuesPanel [data-locate]').forEach(b => b.addEventListener('click', () => {
      const x = r.issues[+b.dataset.locate];
      kbOpenFixModal(prefix, id, x, +b.dataset.locate);
      if (x.itemIdx != null) {
        const el = $('#kbDetail [data-itemidx="' + x.itemIdx + '"]') || $('#exDetail [data-itemidx="' + x.itemIdx + '"]');
        if (el) {
          $$('#kbDetail .kb-locate, #exDetail .kb-locate').forEach(e2 => e2.classList.remove('kb-locate'));
          el.classList.add('kb-locate');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }));
  } catch (e) {
    out.innerHTML = '<div class="result err">❌ ' + esc(e.message) + '</div>';
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

/** v1.1.7d：就地更新详情页中该条目块的文本（不重建详情、不毁 AI 报告现场） */
function kbUpdateDetailItem(prefix, x, newText) {
  if (x.itemIdx == null) return;
  const el = $('#' + prefix + 'Detail [data-itemidx="' + x.itemIdx + '"]');
  if (!el) return;
  const qt = el.querySelector('.kb-q-text');
  if (qt) qt.innerHTML = kbText(newText);
  else el.innerHTML = kbText(newText);
}

/** v1.1.7e：疑点卡片状态标记——fixed=✅淡出+组头进度 / still=追加复核反馈与修改建议 */
function markIssueCard(prefix, cardIdx, state, newDesc, sug) {
  if (cardIdx == null || cardIdx < 0) return;
  const btn = document.querySelector('#' + prefix + 'IssuesPanel [data-locate="' + cardIdx + '"]');
  const card = btn && btn.closest('.kb-issue');
  if (!card) return;
  if (state === 'fixed') {
    card.style.transition = 'opacity .8s'; card.style.opacity = '.45';
    const head = card.querySelector('.kb-issue-head');
    if (head && !card.querySelector('.kb-issue-fixed-tag')) {
      const t = document.createElement('span');
      t.className = 'kb-issue-fixed-tag';
      t.textContent = '✅ 已修复';
      head.appendChild(t);
    }
    const lb = card.querySelector('[data-locate]');
    if (lb) lb.disabled = true;
    const grp = card.closest('.kb-issue-group');
    if (grp) {
      const fixedEl = grp.querySelector('.kb-group-fixed');
      const total = grp.querySelectorAll('.kb-issue').length;
      const done = grp.querySelectorAll('.kb-issue-fixed-tag').length;
      if (fixedEl) { fixedEl.textContent = `· 已修复 ${done}/${total}`; fixedEl.style.display = ''; }
      if (done === total) grp.style.opacity = '.55';
    }
  } else if (state === 'still' && newDesc) {
    const d = document.createElement('div');
    d.className = 'kb-fix-miss';
    d.textContent = '🔁 AI 复核：' + newDesc;
    card.appendChild(d);
    if (sug) {
      const s = document.createElement('div');
      s.className = 'kb-fix-sug';
      s.textContent = '💡 修改建议：' + sug;
      card.appendChild(s);
    }
  }
}

/* v1.1.7e：保存后右下角 toast——一键回到 AI 审读板块 */
function kbShowBackToast(prefix, ok, msg) {
  const old = document.querySelector('.kb-back-toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className = 'kb-back-toast' + (ok ? ' ok' : ' warn');
  t.innerHTML = `<div class="kb-back-msg">${esc(msg)}</div><button class="btn small primary">📋 回到审读报告</button>`;
  t.querySelector('button').addEventListener('click', () => {
    const panel = $('#' + prefix + 'IssuesPanel');
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (panel.animate) panel.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 900 });
    }
    t.remove();
  });
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 12000);
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
      /* v1.1.7d：不重建详情、不退回列表——就地更新该条目块，保留 AI 审读现场 */
      if (prefix === 'kb') kbState.loaded = false; else examState.loaded = false;
      kbUpdateDetailItem(prefix, x, newText);
      out.innerHTML = '✅ 已保存 · 🤖 AI 复核中…';
      out.className = 'result';
      let rv = null;
      try { rv = await api('/api/kb/review/item', { id: rid, store: prefix === 'ex' ? 'exam' : 'corpus', rawIdx, text: newText, origText }); }
      catch (e2) { /* 复核异常不阻塞保存结果 */ }
      if (rv && rv.ok) {
        out.innerHTML = '✅ 已保存 · AI 复核通过，疑点已标记修复';
        out.className = 'result ok';
        markIssueCard(prefix, cardIdx, 'fixed');
        $('#kbFixPreview').innerHTML = '<div class="kb-fix-miss" style="color:var(--ok)">✅ AI 复核通过：该疑点已修复</div>';
        close();
        kbShowBackToast(prefix, true, '✅ 修改已保存，AI 复核通过');
      } else {
        const sug = (rv && rv.issues && rv.issues[0] && rv.issues[0].suggestion) || '';
        const d = (rv && rv.issues && rv.issues[0] && rv.issues[0].desc) || 'AI 复核未通过，请检查该条目';
        out.innerHTML = '✅ 已保存 · ⚠️ AI 复核仍有疑点：' + esc(d) + (sug ? `<div class="kb-fix-sug">💡 修改建议：${esc(sug)}</div>` : '');
        out.className = 'result err';
        markIssueCard(prefix, cardIdx, 'still', d, sug);
        kbShowBackToast(prefix, false, '⚠️ 已保存，AI 复核发现新问题');
      }
    } catch (e) {
      out.textContent = '❌ ' + esc(e.message);
      out.className = 'result err';
    }
  });
}

$('#kbEditBtn').addEventListener('click', kbToggleEditor);
$('#exEditBtn').addEventListener('click', kbToggleEditor);
$('#kbDelBtn').addEventListener('click', kbDeleteCurrent);
$('#exDelBtn').addEventListener('click', kbDeleteCurrent);
$('#kbReviewBtn').addEventListener('click', kbDoReview);
$('#exReviewBtn').addEventListener('click', kbDoReview);

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
  const rem = pomoRemaining();
  const sec = Math.ceil(rem / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const card = $('.pomo-card');
  if (card) card.classList.toggle('running', !!pomo.running);

  // 更新呼吸能量环进度 (周长 2 * PI * 70 ≈ 440)
  const ring = $('#pomoRingProgress');
  if (ring && pomo.fullMs > 0) {
    const totalMs = pomo.fullMs;
    const progress = Math.min(1, Math.max(0, rem / totalMs));
    const offset = 440 * (1 - progress);
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = pomo.mode === 'work' ? 'var(--primary)' : 'var(--ok)';
  }

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

/* ---------------- 单词测验（v1.0.4：主动回忆） ---------------- */

const quiz = { running: false, src: 'today', mode: 'flash', items: [], idx: 0, results: [], distractorPool: [] };

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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

$('#quizStartBtn').addEventListener('click', startQuiz);
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
    const count = Math.min(50, Math.max(3, Number($('#quizCount').value) || 10));
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
    quiz.items = withGloss;
    quiz.idx = 0;
    quiz.results = [];
    quiz.running = true;
    // 四选一的干扰项池
    if (quiz.mode === 'choice') {
      const all = await api('/api/words?filter=all');
      quiz.distractorPool = (all.words || []).filter(w => w.gloss?.gloss);
    }
    msg.textContent = '';
    $('#quizSetup').style.display = 'none';
    $('#quizRun').style.display = 'block';
    renderQuizItem();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
  }
}

function quitQuiz() {
  quiz.running = false;
  $('#quizRun').style.display = 'none';
  $('#quizSetup').style.display = 'block';
}

function quizAdvance() {
  quiz.idx++;
  if (quiz.idx >= quiz.items.length) return finishQuiz();
  renderQuizItem();
}

function quizRecord(resp) {
  quiz.results.push({ spelling: quiz.items[quiz.idx].spelling, response: resp });
}

function renderQuizItem() {
  const it = quiz.items[quiz.idx];
  $('#quizProgress').textContent = `第 ${quiz.idx + 1} / ${quiz.items.length} 题`;
  $('#quizBar').style.width = (quiz.idx / quiz.items.length * 100) + '%';
  const area = $('#quizArea');

  if (quiz.mode === 'flash') {
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
        <div class="grade-row">
          <button class="btn grade g-ok" data-r="FAMILIAR">😊 认识</button>
          <button class="btn grade g-mid" data-r="VAGUE">😐 模糊</button>
          <button class="btn grade g-bad" data-r="FORGET">😵 忘记</button>
        </div>`;
      $$('#quizFlipZone .grade').forEach(b =>
        b.addEventListener('click', () => { quizRecord(b.dataset.r); quizAdvance(); }));
    });
    return;
  }

  if (quiz.mode === 'choice') {
    const distractors = shuffle(quiz.distractorPool.filter(w => w.spelling !== it.spelling))
      .slice(0, 3).map(w => w.gloss.gloss);
    const opts = shuffle([{ ok: true, text: it.gloss.gloss }, ...distractors.map(t => ({ ok: false, text: t }))]);
    area.innerHTML = `
      <div class="quiz-word">${esc(it.spelling)} <button class="speak-btn mini" data-speak="${esc(it.spelling)}">🔊</button></div>
      <div class="quiz-hint">选出正确的释义</div>
      <div class="quiz-opts">${opts.map((o, i) => `<button class="btn quiz-opt" data-i="${i}">${esc(o.text)}</button>`).join('')}</div>
      <div class="quiz-feedback" id="quizFeedback"></div>`;
    let answered = false;
    $$('#quizArea .quiz-opt').forEach(b => b.addEventListener('click', () => {
      if (answered) return;
      answered = true;
      const ok = opts[Number(b.dataset.i)].ok;
      b.classList.add(ok ? 'correct' : 'wrong');
      $('#quizFeedback').innerHTML = ok
        ? '<span class="fb-ok">✅ 答对了</span>'
        : `<span class="fb-bad">❌ 正确答案：<b>${esc(it.gloss.gloss)}</b></span>`;
      quizRecord(ok ? 'FAMILIAR' : 'FORGET');
      setTimeout(quizAdvance, ok ? 700 : 1800);
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
    const val = input.value.trim().toLowerCase();
    if (!val) return;
    const ok = val === it.spelling.toLowerCase();
    $('#quizFeedback').innerHTML = ok
      ? `<span class="fb-ok">✅ 拼对了！${esc(it.spelling)}</span>`
      : `<span class="fb-bad">❌ 正确拼写：<b>${esc(it.spelling)}</b> <button class="speak-btn mini" data-speak="${esc(it.spelling)}">🔊</button></span>`;
    input.disabled = true;
    $('#quizSpellBtn').disabled = true;
    quizRecord(ok ? 'FAMILIAR' : 'FORGET');
    setTimeout(quizAdvance, ok ? 700 : 2000);
  };
  $('#quizSpellBtn').addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

async function finishQuiz() {
  quiz.running = false;
  $('#quizBar').style.width = '100%';
  $('#quizProgress').textContent = '测验完成 🎉';
  const r = quiz.results;
  const cnt = k => r.filter(x => x.response === k).length;
  let submitNote = '';
  try {
    await api('/api/quiz/submit', { method: 'POST', body: { results: r, mode: quiz.mode } });
    submitNote = '结果已记录：忘记/模糊的词自动进入了对应筛选，回「AI 学习」页可针对性攻克。';
  } catch {
    submitNote = '（结果上报失败，本次不计入错词统计）';
  }
  $('#quizArea').innerHTML = `
    <div class="quiz-done">
      <div class="quiz-score">${cnt('FAMILIAR')} / ${r.length}</div>
      <div class="quiz-score-sub">认识 ${cnt('FAMILIAR')} · 模糊 ${cnt('VAGUE')} · 忘记 ${cnt('FORGET')}</div>
      <div class="hint" style="text-align:center">${esc(submitNote)}</div>
      <div class="row-gap" style="justify-content:center">
        <button class="btn primary" id="quizAgainBtn">🔁 再来一轮</button>
        <button class="btn" data-jump="study" data-filter="forget">去学错词</button>
      </div>
    </div>`;
  $('#quizAgainBtn').addEventListener('click', quitQuiz);
}

/* ---------------- 启动 ---------------- */

(async function init() {
  applyTheme(localStorage.getItem('wb-theme') || 'light');
  applyStyle(localStorage.getItem('wb-style') || '');
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
    if (status.kaoyanMode) $('#kaoyanBadge').style.display = 'inline-block';
  } catch { /* 服务未就绪时静默 */ }
  loadDashboard();
})();

/* ============ v1.1.9c：禅意专注视界 + 视线探照灯 + 原生白噪音心流场 ============ */

/* 1. 禅意专注模式 (Zen Mode) */
function toggleZenMode() {
  const isZen = document.body.classList.toggle('zen-mode');
  localStorage.setItem('wb-zen', isZen ? '1' : '0');
  const btn = $('#zenToggle');
  if (btn) btn.textContent = isZen ? '🧘‍♂️' : '🧘';
  toast(isZen ? '已进入禅意专注视界（按 Esc 或 Z 退出）' : '已退出专注视界');
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

/* 3. 纯原生 Web Audio 算法白噪音心流发生器（零外链、零音频文件下载） */
let audioCtx = null;
let noiseNode = null;
let gainNode = null;
let currentNoiseMode = 'off'; // 'off' | 'rain' | 'cafe'

const noiseModes = ['off', 'rain', 'cafe'];
const noiseNames = { off: '已关闭', rain: '雨落窗台 🌧', cafe: '深空自习室 ☕' };
const noiseIcons = { off: '🌧', rain: '🌧', cafe: '☕' };

function createNoiseBuffer(type) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const bufferSize = audioCtx.sampleRate * 2;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);

  if (type === 'rain') {
    // 粉红噪声算法：雨声质感
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
      b6 = white * 0.115926;
    }
  } else if (type === 'cafe') {
    // 布朗噪声算法：自习室厚重遮噪
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      data[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = data[i];
      data[i] *= 0.8;
    }
  }
  return buffer;
}

function startNoise(type) {
  stopNoise();
  if (type === 'off') return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const buffer = createNoiseBuffer(type);
    noiseNode = audioCtx.createBufferSource();
    noiseNode.buffer = buffer;
    noiseNode.loop = true;

    // 低通滤波器柔化高频刺耳声
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = type === 'rain' ? 1200 : 600;

    gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(0.01, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 1.2); // 柔和淡入

    noiseNode.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    noiseNode.start();
  } catch (err) {
    console.warn('AudioContext failed:', err);
  }
}

function stopNoise() {
  if (noiseNode) {
    try {
      if (gainNode && audioCtx) {
        gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.5); // 淡出
        setTimeout(() => {
          try { noiseNode.stop(); noiseNode.disconnect(); } catch (e) {}
          noiseNode = null;
        }, 500);
      } else {
        noiseNode.stop();
        noiseNode = null;
      }
    } catch (e) { noiseNode = null; }
  }
}

function cycleWhiteNoise() {
  const curIdx = noiseModes.indexOf(currentNoiseMode);
  const nextIdx = (curIdx + 1) % noiseModes.length;
  currentNoiseMode = noiseModes[nextIdx];

  const btn = $('#whiteNoiseToggle');
  const hint = $('#pomoAudioState');
  if (btn) btn.textContent = noiseIcons[currentNoiseMode];
  if (hint) hint.textContent = noiseNames[currentNoiseMode];

  startNoise(currentNoiseMode);
  toast(`🎧 白噪音伴读：${noiseNames[currentNoiseMode]}`);
}

if ($('#whiteNoiseToggle')) $('#whiteNoiseToggle').addEventListener('click', cycleWhiteNoise);

/* 恢复本地存储的偏好 */
if (localStorage.getItem('wb-spotlight') === '1') {
  document.body.classList.add('spotlight-active');
  const btn = $('#spotlightToggleFloating');
  if (btn) btn.classList.add('active');
}
