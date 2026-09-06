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
    if (c.dict?.hasCollegiate) $('#cfgDictCollegiate').placeholder = '已保存 ✓（留空 = 沿用）';
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
