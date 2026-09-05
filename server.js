/**
 * 英语学习工作台 - 本地服务
 * 零依赖 Node.js (>=22)，单文件后端
 *
 * 职责：
 *  1. 墨墨背单词 Open API 同步（进度 / 今日词 / 学习记录全量）
 *  2. 本地 JSON 持久化（学习数据 / 学习会话 / 助记内容 / 配置）
 *  3. LLM 代理（OpenAI-compatible /v1/chat/completions，可插拔服务商）
 *  4. 助记生成（会话总结 -> 按词保存）+ 可选推回墨墨 notes API
 *
 * 启动：node server.js  （默认端口 5178）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = process.env.PORT ? Number(process.env.PORT) : 5178;
// 本机默认只监听 127.0.0.1；云服务器部署时设置 HOST=0.0.0.0（建议配合 nginx/防火墙）
const HOST = process.env.HOST || '127.0.0.1';

/** 北京时间（Asia/Shanghai）的 YYYY-MM-DD，offsetDays 为偏移天数 */
function bjDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}

const MM_BASE = 'https://open.maimemo.com/open/api/v1/memo';

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let config = loadJSON(CONFIG_FILE, {
  maimemoToken: process.env.MAIMEMO_TOKEN || '',
  llm: { mock: false, activeId: 'default', providers: [{ id: 'default', name: '默认服务商', baseUrl: '', apiKey: '', model: '' }] },
  autoSync: { enabled: false, minutes: 60 },
});

// v1.0.2 迁移：旧的单服务商结构自动升级为多服务商列表（老配置无痛升级）
if (!Array.isArray(config.llm?.providers)) {
  const old = config.llm || {};
  config.llm = {
    mock: !!old.mock,
    activeId: 'default',
    providers: [{ id: 'default', name: '默认服务商', baseUrl: old.baseUrl || '', apiKey: old.apiKey || '', model: old.model || '' }],
  };
  persistConfig();
}

let db = loadJSON(DB_FILE, {
  lastSync: null,
  syncLog: [],            // [{ts, ok, msg}]
  progressHistory: [],    // [{date, finished, total, studyTimeMs}]
  planTotal: 0,           // 学习计划总词数
  words: {},              // vocId -> {vocId, spelling, studyCount, tags[], lastResponse, nextStudyDate, lastStudyDate, addDate, today:{firstResponse,isNew,isFinished}}
  todayItems: [],         // 最近一次同步的今日词表
  notes: [],              // 助记 {id, spelling, vocId?, noteType, content, createdAt, sessionId, source, synced, maimemoNoteId?, pushError?}
  sessions: [],           // 学习会话 {id, startedAt, endedAt, words[], messages[], errorWords[]}
});

function persistConfig() { saveJSON(CONFIG_FILE, config); }
function persistDB() { saveJSON(DB_FILE, db); }

/* ------------------------------------------------------------------ */
/* 墨墨 API 客户端（按报告实测结论实现）                                 */
/* ------------------------------------------------------------------ */

const lastCallByPath = new Map();
const MIN_GAP_MS = 700; // 限流 20/10s，留足余量

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function throttle(pathname) {
  const last = lastCallByPath.get(pathname) || 0;
  const wait = MIN_GAP_MS - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastCallByPath.set(pathname, Date.now());
}

/**
 * 调用墨墨 API。自动剥信封、处理 429 退避。
 * @returns {object} envelope.data
 */
async function mm(pathname, { method = 'GET', body, query } = {}) {
  if (!config.maimemoToken) {
    const e = new Error('尚未配置墨墨 Token，请先到「设置」页填写');
    e.code = 'NO_TOKEN';
    throw e;
  }
  const url = new URL(MM_BASE + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, item));
      else url.searchParams.append(k, String(v));
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle(pathname);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'Authorization': 'Bearer ' + config.maimemoToken,
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error('网络错误：' + err.message);
    }

    // 429：读 retry-after-short 退避重试
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after-short') || res.headers.get('retry-after') || 2);
      if (attempt < 2) { await sleep((ra + 0.5) * 1000); continue; }
      throw new Error('触发墨墨限流(429)，请稍后再试');
    }

    let json;
    try { json = await res.json(); } catch { throw new Error(`响应解析失败 (HTTP ${res.status})`); }

    // 墨墨用 success 布尔判成败，不看 HTTP 码；成功码可能是 200 或 201
    if (!json.success) {
      const err = (json.errors && json.errors[0]) || {};
      const e = new Error(`${err.code || 'unknown'}: ${err.msg || '请求失败'}${err.info ? ' (' + err.info + ')' : ''}`);
      e.code = err.code;
      e.httpStatus = res.status;
      throw e;
    }
    return json.data || {};
  }
}

/** 查单词 voc_id；查不到返回 null（墨墨返回 200 + 空对象，须判空） */
async function resolveVocId(spelling) {
  const data = await mm('/vocabulary', { query: { spelling } });
  if (data && data.voc && data.voc.id) return data.voc.id;
  return null;
}

/** 批量解析 voc_id（≤1000/次），返回 spelling -> vocId 映射（缺失的词不在映射中） */
async function resolveVocIdsBatch(spellings) {
  const map = {};
  for (let i = 0; i < spellings.length; i += 1000) {
    const chunk = spellings.slice(i, i + 1000);
    try {
      const data = await mm('/vocabulary/query', { method: 'POST', body: { spellings: chunk } });
      (data.voc || []).forEach(v => { map[v.spelling] = v.id; });
    } catch { /* 批量失败则跳过该批 */ }
  }
  return map;
}

/* ---------- 同步逻辑 ---------- */

function logSync(ok, msg) {
  db.syncLog.unshift({ ts: new Date().toISOString(), ok, msg });
  db.syncLog = db.syncLog.slice(0, 100);
}

async function syncProgress() {
  const data = await mm('/study/get_study_progress', { method: 'POST', body: {} });
  const p = data.progress || {};
  const today = bjDate();
  const rec = {
    date: today,
    finished: p.finished || 0,
    total: p.total || 0,
    studyTimeMs: p.study_time || 0,
  };
  const idx = db.progressHistory.findIndex(x => x.date === today);
  if (idx >= 0) db.progressHistory[idx] = rec; else db.progressHistory.push(rec);
  if (db.progressHistory.length > 180) db.progressHistory = db.progressHistory.slice(-180);
  return rec;
}

async function syncTodayItems() {
  const data = await mm('/study/get_today_items', { method: 'POST', body: { limit: 1000 } });
  const items = data.today_items || [];
  db.todayItems = items;
  const dateStr = bjDate();
  for (const it of items) {
    const w = db.words[it.voc_id] || { vocId: it.voc_id };
    w.vocId = it.voc_id;
    w.spelling = it.voc_spelling || w.spelling;
    w.today = { date: dateStr, firstResponse: it.first_response, isNew: it.is_new, isFinished: it.is_finished };
    db.words[it.voc_id] = w;
  }
  return items.length;
}

/** 学习记录全量导出：as_count 探针 + next_study_date 月度切片（每片 ≤1000） */
async function syncStudyRecords() {
  const start = new Date(Date.UTC(2019, 0, 1));
  const end = new Date(Date.now() + 400 * 86400000);

  // 生成月度窗口
  const windows = [];
  let cur = new Date(start);
  while (cur < end) {
    const wStart = new Date(cur);
    const wEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    windows.push({ start: wStart, end: wEnd });
    cur = wEnd;
  }

  // 先用 as_count 探每片的量（墨墨 count 恒 0 当 as_count=false，见报告 §5-13）
  const nonEmpty = [];
  for (const w of windows) {
    const body = {
      next_study_date: { start: toMM(w.start), end: toMM(w.end) },
      as_count: true,
    };
    try {
      const data = await mm('/study/query_study_records', { method: 'POST', body });
      if ((data.count || 0) > 0) nonEmpty.push({ ...w, count: data.count });
    } catch { /* 跳过失败窗口 */ }
  }

  let fetched = 0, truncated = false;
  for (const w of nonEmpty) {
    let cursor = new Date(w.start);
    while (cursor < w.end) {
      const body = {
        next_study_date: { start: toMM(cursor), end: toMM(w.end) },
        limit: 1000,
      };
      const data = await mm('/study/query_study_records', { method: 'POST', body });
      const records = data.records || [];
      for (const r of records) upsertWordFromRecord(r);
      fetched += records.length;
      if (records.length < 1000) break;
      // 接近 1000 说明可能截断：把游标推进到本批最大 next_study_date 之后再切
      const maxDate = records.reduce((m, r) => (r.next_study_date > m ? r.next_study_date : m), '');
      if (!maxDate) { truncated = true; break; }
      const next = new Date(maxDate);
      if (next <= cursor) { truncated = true; break; }
      cursor = next;
    }
  }
  return { fetched, windows: nonEmpty.length, truncated };
}

function toMM(d) {
  // 北京时间 ISO：YYYY-MM-DDTHH:mm:ss+08:00
  const bj = new Date(d.getTime() + 8 * 3600000);
  return bj.toISOString().replace('Z', '+08:00');
}

function upsertWordFromRecord(r) {
  const w = db.words[r.voc_id] || { vocId: r.voc_id };
  w.vocId = r.voc_id;
  w.spelling = r.voc_spelling || w.spelling;
  w.studyCount = r.study_count ?? w.studyCount;
  w.tags = Array.isArray(r.tags) ? r.tags : (r.tags ? [r.tags] : (w.tags || []));
  w.lastResponse = r.last_response || w.lastResponse;
  w.nextStudyDate = r.next_study_date || w.nextStudyDate;
  w.lastStudyDate = r.last_study_date || w.lastStudyDate;
  w.addDate = r.add_date || w.addDate;
  db.words[r.voc_id] = w;
}

async function runSync(trigger = 'manual') {
  const steps = [];
  let ok = true;
  try {
    const p = await syncProgress();
    steps.push(`今日进度 ${p.finished}/${p.total}`);
  } catch (e) { ok = false; steps.push('进度失败: ' + e.message); }
  try {
    const n = await syncTodayItems();
    steps.push(`今日词表 ${n} 条`);
  } catch (e) { steps.push('今日词表失败: ' + e.message); }
  try {
    if (!config.maimemoToken) {
      steps.push('学习记录跳过（未配置 Token）');
    } else {
      const r = await syncStudyRecords();
      steps.push(`学习记录 ${r.fetched} 条/${r.windows} 个窗口${r.truncated ? '（部分截断）' : ''}`);
    }
  } catch (e) { steps.push('学习记录失败: ' + e.message); }

  // 学习计划总量
  try {
    const data = await mm('/study/query_study_records', { method: 'POST', body: { as_count: true } });
    db.planTotal = data.count || 0;
    steps.push(`计划总量 ${db.planTotal}`);
  } catch { /* 非致命 */ }

  db.lastSync = new Date().toISOString();
  logSync(ok, steps.join('；') + ` [${trigger}]`);
  persistDB();
  return { ok, msg: steps.join('；') };
}

/* ------------------------------------------------------------------ */
/* LLM 客户端（OpenAI-compatible，可插拔）                              */
/* ------------------------------------------------------------------ */

const LLM_PRESETS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  ollama: { label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
};

/** 取服务商档案：指定 id 优先，其次全局默认，兜底第一个；供不同功能板块分别指定 */
function getProvider(id) {
  const llm = config.llm;
  return llm.providers.find(p => p.id === id)
    || llm.providers.find(p => p.id === llm.activeId)
    || llm.providers[0];
}

async function llmChat(messages, { maxTokens = 1600, providerId, llmOverride } = {}) {
  if (config.llm.mock) {
    return mockLLM(messages);
  }
  const base = getProvider(providerId) || {};
  const llm = { ...base, ...(llmOverride || {}) };
  if (!llm.baseUrl || !llm.model) {
    const e = new Error('尚未配置 AI 服务商，请到「设置」页添加服务商并填写 API Key');
    e.code = 'NO_LLM';
    throw e;
  }
  const url = llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(llm.apiKey ? { 'Authorization': 'Bearer ' + llm.apiKey } : {}),
      },
      body: JSON.stringify({ model: llm.model, messages, max_tokens: maxTokens, temperature: 0.7 }),
    });
  } catch {
    throw new Error(`无法连接 AI 服务（${llm.baseUrl}），请到「设置」检查 Base URL 与网络`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI 请求失败 (HTTP ${res.status}) ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回为空');
  return content;
}

/** 本地自测用的假 LLM（config.llm.mock=true 时启用） */
function mockLLM(messages) {
  const sys = messages.find(m => m.role === 'system')?.content || '';
  const user = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  if (sys.includes('个性化助记')) {
    const words = [...user.matchAll(/### ([\w'-]+)/g)].map(m => m[1]);
    return JSON.stringify({
      notes: words.map(w => ({
        spelling: w,
        noteType: '联想',
        content: `[MOCK] ${w} 的助记：结合本次对话易错点，把拼写拆成熟悉块并联想一句中文口诀。（自测数据）`,
      })),
    });
  }
  return `[MOCK] 收到！这是一个自测回复。（词义、例句、用法讲解在配置真实 AI 服务商后可用）\n\n关于你的问题「${user.slice(0, 60)}」：本回复来自内置 mock 模式，仅用于验证闭环。`;
}

/* ------------------------------------------------------------------ */
/* 业务：AI 互动学习 / 助记生成 / 推送                                  */
/* ------------------------------------------------------------------ */

function wordBrief(w) {
  if (!w) return '';
  const parts = [];
  if (w.studyCount != null) parts.push(`已学习 ${w.studyCount} 次`);
  if (w.tags?.includes('STICKING')) parts.push('顽固词（反复忘记）');
  if (w.tags?.includes('WELL_FAMILIAR')) parts.push('已熟练');
  if (w.lastResponse) parts.push(`最近反应: ${w.lastResponse}`);
  if (w.today?.firstResponse) parts.push(`今日首反应: ${w.today.firstResponse}`);
  return parts.join('，');
}

function buildTutorSystemPrompt(spelling, extraNotes) {
  const w = Object.values(db.words).find(x => x.spelling === spelling);
  const lines = [
    '你是一位耐心的英语单词学习助手，面向中国学习者。',
    '规则：',
    '1. 用简体中文讲解，术语可保留英文；简洁、有重点，别写长篇大论。',
    '2. 词义、例句、搭配要准确；不确定就说不确定，不要编造。',
    '3. 例句中的目标词要自然出现，并配中文翻译。',
    '4. 主动呼应学习者的薄弱点（如给出易混词对比、记忆钩子）。',
    '5. 回复用 Markdown 轻量排版。',
  ];
  if (w) lines.push(`当前学习单词：${w.spelling}（墨墨数据：${wordBrief(w) || '暂无记录'}）`);
  else if (spelling) lines.push(`当前学习单词：${spelling}`);
  if (extraNotes) lines.push(`学习者已有的助记笔记：\n${extraNotes}`);
  return lines.join('\n');
}

function localNotesFor(spelling) {
  const notes = db.notes.filter(n => n.spelling === spelling);
  if (!notes.length) return '';
  return notes.map(n => `- [${n.noteType}] ${n.content}`).join('\n');
}

/** 从 LLM 输出解析助记 JSON（带容错） */
function parseMnemonicJSON(text) {
  // 提取第一个 {...} 或 [...]
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (Array.isArray(obj)) return { notes: obj };
    return obj;
  } catch {
    return null;
  }
}

async function finishSession(payload) {
  const { messages = [], words = [], errorWords = [], startedAt, endedAt } = payload;
  if (!words.length) throw new Error('本次会话没有学习任何单词');

  const wordBlocks = words.map(sp => {
    const w = Object.values(db.words).find(x => x.spelling === sp);
    const errs = errorWords.includes(sp) ? '（学习者标记：本次又忘了/记混了）' : '';
    return `### ${sp}\n墨墨数据：${wordBrief(w) || '无'}${errs}`;
  }).join('\n\n');

  const transcript = messages.slice(-40).map(m =>
    `[${m.role === 'user' ? '学习者' : 'AI'}] ${m.word ? '(' + m.word + ') ' : ''}${m.content}`
  ).join('\n');

  const system = [
    '你是英语学习教练。学习者刚结束一次单词学习会话。',
    '请根据会话内容和易错点，为每个学习过的单词生成一条个性化助记。',
    '要求：',
    '1. 助记要结合学习者在会话中暴露的具体问题（混淆的词、忘掉的义项、拼错的点），而不是泛泛的词根拆解。',
    '2. 每条助记 80 字以内，可以直接背。',
    '3. noteType 从这些里选一个最贴切的：联想/谐音/词根词缀/近反义词/辨析/固定搭配/词源/口诀/其他。',
    '4. 只输出 JSON，不要多余文字，格式：{"notes":[{"spelling":"单词","noteType":"联想","content":"助记内容"}]}',
    '5. 每个学习过的单词都要有一条。',
  ].join('\n');

  const user = `学习过的单词：\n${wordBlocks}\n\n会话记录（可能截断）：\n${transcript || '（无详细记录）'}`;

  const text = await llmChat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 2000 });

  const parsed = parseMnemonicJSON(text);
  const notesIn = parsed?.notes;
  if (!Array.isArray(notesIn) || !notesIn.length) {
    throw new Error('AI 返回的助记格式无法解析，请重试');
  }

  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId, startedAt, endedAt: endedAt || new Date().toISOString(),
    words, errorWords, messages,
  };
  db.sessions.unshift(session);
  if (db.sessions.length > 200) db.sessions = db.sessions.slice(0, 200);

  const saved = [];
  for (const n of notesIn) {
    if (!n.spelling || !n.content) continue;
    const note = {
      id: crypto.randomUUID(),
      spelling: n.spelling,
      noteType: n.noteType || '其他',
      content: String(n.content).slice(0, 500),
      createdAt: new Date().toISOString(),
      sessionId,
      source: 'AI',
      synced: false,
    };
    db.notes.unshift(note);
    saved.push(note);
  }
  persistDB();
  return { sessionId, saved, raw: text };
}

/** 把助记推回墨墨 notes API（关联 voc_id） */
async function pushNoteToMaimemo(noteId) {
  const note = db.notes.find(n => n.id === noteId);
  if (!note) throw new Error('助记不存在');
  if (note.synced) return note;

  const vocId = note.vocId || await resolveVocId(note.spelling);
  if (!vocId) {
    note.pushError = `词库中查不到「${note.spelling}」（注意大小写），无法推送`;
    persistDB();
    throw new Error(note.pushError);
  }
  note.vocId = vocId;
  const data = await mm('/notes', {
    method: 'POST',
    body: { note: { voc_id: vocId, note_type: note.noteType, note: note.content } },
  });
  note.synced = true;
  note.maimemoNoteId = data?.note?.id || null;
  note.pushError = null;
  persistDB();
  return note;
}

/* ------------------------------------------------------------------ */
/* 自动同步                                                            */
/* ------------------------------------------------------------------ */

let autoTimer = null;
function armAutoSync() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (config.autoSync?.enabled && config.maimemoToken) {
    const ms = Math.max(5, Number(config.autoSync.minutes) || 60) * 60000;
    autoTimer = setInterval(() => {
      runSync('auto').catch(e => logSync(false, '自动同步异常: ' + e.message));
    }, ms);
    logSync(true, `已开启自动同步，每 ${config.autoSync.minutes} 分钟`);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 5e6) reject(new Error('body too large')); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** 仪表盘聚合数据 */
function dashboardData() {
  const today = bjDate();
  const progress = db.progressHistory.find(p => p.date === today) || null;
  const words = Object.values(db.words);
  const sticky = words.filter(w => w.tags?.includes('STICKING'));
  const wellFamiliar = words.filter(w => w.tags?.includes('WELL_FAMILIAR'));

  // 未来 7 天复习量直方图（北京时间）
  const forecast = [];
  for (let i = 0; i < 7; i++) {
    const key = bjDate(i);
    const cnt = words.filter(w => (w.nextStudyDate || '').slice(0, 10) === key).length;
    forecast.push({ date: key, count: cnt });
  }

  // 最近 14 天进度曲线
  const history = db.progressHistory.slice(-14);

  return {
    lastSync: db.lastSync,
    planTotal: db.planTotal,
    progress,
    counts: {
      words: words.length,
      sticky: sticky.length,
      wellFamiliar: wellFamiliar.length,
      notes: db.notes.length,
      pendingNotes: db.notes.filter(n => !n.synced).length,
      sessions: db.sessions.length,
    },
    forecast,
    history,
    todayItems: db.todayItems.length,
    recentLog: db.syncLog.slice(0, 5),
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  try {
    /* ---- API ---- */
    if (p.startsWith('/api/')) {
      // 状态
      if (p === '/api/status' && req.method === 'GET') {
        return sendJSON(res, 200, {
          hasToken: !!config.maimemoToken,
          llm: {
            configured: !!config.llm?.mock || (config.llm?.providers || []).some(p => p.baseUrl && p.model),
            mock: !!config.llm?.mock,
            activeId: config.llm?.activeId,
            activeName: getProvider()?.name || '',
          },
          lastSync: db.lastSync,
          counts: { words: Object.keys(db.words).length, notes: db.notes.length },
          autoSync: config.autoSync,
        });
      }

      // 配置读写
      if (p === '/api/config' && req.method === 'GET') {
        return sendJSON(res, 200, {
          maimemoToken: config.maimemoToken ? '••••（已保存，留空则不修改）' : '',
          hasToken: !!config.maimemoToken,
          llm: {
            activeId: config.llm.activeId,
            mock: !!config.llm.mock,
            providers: (config.llm.providers || []).map(pr => ({
              id: pr.id, name: pr.name, baseUrl: pr.baseUrl, model: pr.model, hasKey: !!pr.apiKey,
            })),
          },
          autoSync: config.autoSync,
          presets: LLM_PRESETS,
        });
      }
      if (p === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.maimemoToken === 'string' && body.maimemoToken && !body.maimemoToken.startsWith('••')) {
          config.maimemoToken = body.maimemoToken.trim();
        }
        if (body.maimemoToken === '') config.maimemoToken = '';
        if (body.llm) {
          // 多服务商：数组整体替换；apiKey 留空表示沿用该档案已保存的 Key
          if (Array.isArray(body.llm.providers)) {
            const usedIds = new Set();
            config.llm.providers = body.llm.providers.slice(0, 20).map((pr, i) => {
              let id = pr.id ? String(pr.id).slice(0, 40) : '';
              if (!id || usedIds.has(id)) id = 'p' + Date.now().toString(36) + '_' + i;  // 空id或重复id → 重新生成
              usedIds.add(id);
              const old = (config.llm.providers || []).find(x => x.id === id);
              return {
                id,
                name: String(pr.name || '服务商').slice(0, 30),
                baseUrl: String(pr.baseUrl || '').trim(),
                model: String(pr.model || '').trim(),
                apiKey: (typeof pr.apiKey === 'string' && pr.apiKey.trim()) ? pr.apiKey.trim() : (old?.apiKey || ''),
              };
            });
            if (!config.llm.providers.find(x => x.id === config.llm.activeId)) {
              config.llm.activeId = config.llm.providers[0]?.id || 'default';
            }
          }
          if (typeof body.llm.activeId === 'string' && config.llm.providers.find(x => x.id === body.llm.activeId)) {
            config.llm.activeId = body.llm.activeId;
          }
          if (body.llm.mock != null) config.llm.mock = !!body.llm.mock;
        }
        if (body.autoSync) {
          config.autoSync = {
            enabled: !!body.autoSync.enabled,
            minutes: Math.max(5, Number(body.autoSync.minutes) || 60),
          };
        }
        persistConfig();
        armAutoSync();
        return sendJSON(res, 200, { ok: true });
      }

      // 拉取模型列表（OpenAI-compatible GET /models，支持中转站）
      // 传 providerId 则用已保存档案的 key/baseUrl 兜底；直接传 baseUrl/apiKey 优先
      if (p === '/api/llm/models' && req.method === 'POST') {
        const body = await readBody(req);
        const prov = body.providerId ? getProvider(body.providerId) : null;
        const baseUrl = (body.baseUrl || prov?.baseUrl || '').trim();
        const apiKey = (body.apiKey || prov?.apiKey || '').trim();
        if (!baseUrl) return sendJSON(res, 400, { error: '请先填写 Base URL' });
        const url = baseUrl.replace(/\/+$/, '') + '/models';
        let r;
        try {
          r = await fetch(url, { headers: apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {} });
        } catch {
          throw new Error(`无法连接 ${baseUrl} —— 请检查 Base URL 是否正确、网络是否可达（中转站地址一般形如 https://xxx.example.com/v1）`);
        }
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          throw new Error(`拉取模型列表失败 (HTTP ${r.status}) ${t.slice(0, 200)}`);
        }
        const j = await r.json();
        // 兼容 OpenAI {data:[{id}]} 与部分中转站 {data:[{id}]} / {models:[...]} 格式
        const raw = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
        const models = [...new Set(raw.map(m => m.id || m.name || m).filter(x => typeof x === 'string'))].sort();
        return sendJSON(res, 200, { models });
      }

      // 连通性测试
      if (p === '/api/test/maimemo' && req.method === 'POST') {
        const data = await mm('/study/get_study_progress', { method: 'POST', body: {} });
        const pr = data.progress || {};
        return sendJSON(res, 200, { ok: true, msg: `连接成功！今日进度 ${pr.finished}/${pr.total}` });
      }
      if (p === '/api/test/llm' && req.method === 'POST') {
        // 允许直接用表单值测试（不依赖先保存）；也可传 providerId 测试已保存档案
        const body = await readBody(req);
        const opts = { maxTokens: 20 };
        if (body.providerId) opts.providerId = body.providerId;
        const override = {};
        if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) override.baseUrl = body.baseUrl.trim();
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) override.apiKey = body.apiKey.trim();
        if (typeof body.model === 'string' && body.model.trim()) override.model = body.model.trim();
        if (Object.keys(override).length) opts.llmOverride = override;
        const reply = await llmChat([{ role: 'user', content: '请只回复：连接成功' }], opts);
        return sendJSON(res, 200, { ok: true, msg: reply.slice(0, 100) });
      }

      // 同步
      if (p === '/api/sync' && req.method === 'POST') {
        const result = await runSync('manual');
        return sendJSON(res, result.ok ? 200 : 207, result);
      }

      // 仪表盘
      if (p === '/api/dashboard' && req.method === 'GET') {
        return sendJSON(res, 200, dashboardData());
      }

      // 单词列表：?filter=sticky|wellfamiliar|forget|vague|newtoday|unfinished|today|due7|all&q=
      if (p === '/api/words' && req.method === 'GET') {
        const filter = u.searchParams.get('filter') || 'all';
        const q = (u.searchParams.get('q') || '').toLowerCase();
        let words = Object.values(db.words);
        const todayStr = bjDate();
        if (filter === 'sticky') words = words.filter(w => w.tags?.includes('STICKING'));
        else if (filter === 'wellfamiliar') {
          // 注意：tags 过滤参数服务端只认 STICKING，WELL_FAMILIAR 必须本地过滤
          words = words.filter(w => w.tags?.includes('WELL_FAMILIAR') || w.today?.firstResponse === 'WELL_FAMILIAR');
        }
        else if (filter === 'forget') words = words.filter(w => w.lastResponse === 'FORGET' || w.today?.firstResponse === 'FORGET');
        else if (filter === 'vague') words = words.filter(w => w.lastResponse === 'VAGUE' || w.today?.firstResponse === 'VAGUE');
        else if (filter === 'newtoday') words = words.filter(w => w.today?.date === todayStr && w.today?.isNew);
        else if (filter === 'unfinished') words = words.filter(w => w.today?.date === todayStr && w.today?.isFinished === false);
        else if (filter === 'today') words = words.filter(w => w.today?.date === todayStr);
        else if (filter === 'due7') {
          const end = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
          words = words.filter(w => {
            const d = (w.nextStudyDate || '').slice(0, 10);
            return d && d <= end;
          });
        }
        if (q) words = words.filter(w => w.spelling.toLowerCase().includes(q));
        words.sort((a, b) => (b.lastStudyDate || '').localeCompare(a.lastStudyDate || ''));
        return sendJSON(res, 200, { words: words.slice(0, 500) });
      }

      // 单词详情（含本地助记）
      if (p === '/api/word' && req.method === 'GET') {
        const sp = u.searchParams.get('spelling');
        const w = Object.values(db.words).find(x => x.spelling === sp) || null;
        const notes = db.notes.filter(n => n.spelling === sp);
        const sessions = db.sessions.filter(s => s.words?.includes(sp)).slice(0, 5);
        return sendJSON(res, 200, { word: w, notes, sessions });
      }

      // AI 对话
      if (p === '/api/chat' && req.method === 'POST') {
        const body = await readBody(req);
        const spelling = (body.spelling || '').trim();
        const message = (body.message || '').trim();
        const history = Array.isArray(body.history) ? body.history.slice(-16) : [];
        if (!message) return sendJSON(res, 400, { error: '消息不能为空' });

        const msgs = [
          { role: 'system', content: buildTutorSystemPrompt(spelling, localNotesFor(spelling)) },
          ...history.map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: message },
        ];
        const reply = await llmChat(msgs);
        return sendJSON(res, 200, { reply });
      }

      // 结束会话 -> 生成助记
      if (p === '/api/session/finish' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await finishSession(body);
        return sendJSON(res, 200, { ok: true, saved: result.saved.length, notes: result.saved });
      }

      // 助记库
      if (p === '/api/notes' && req.method === 'GET') {
        const q = (u.searchParams.get('q') || '').toLowerCase();
        let notes = db.notes;
        if (q) notes = notes.filter(n => n.spelling.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
        return sendJSON(res, 200, { notes: notes.slice(0, 500) });
      }
      if (p === '/api/notes' && req.method === 'POST') {
        // 手动新建/编辑助记
        const body = await readBody(req);
        if (!body.spelling || !body.content) return sendJSON(res, 400, { error: '单词和内容必填' });
        const note = {
          id: crypto.randomUUID(),
          spelling: body.spelling.trim(),
          noteType: body.noteType || '其他',
          content: String(body.content).slice(0, 500),
          createdAt: new Date().toISOString(),
          source: '手动',
          synced: false,
        };
        db.notes.unshift(note);
        persistDB();
        return sendJSON(res, 201, { note });
      }
      if (p.startsWith('/api/notes/') && req.method === 'DELETE') {
        const id = p.split('/')[3];
        db.notes = db.notes.filter(n => n.id !== id);
        persistDB();
        return sendJSON(res, 200, { ok: true });
      }
      if (p.startsWith('/api/notes/') && p.endsWith('/push') && req.method === 'POST') {
        const id = p.split('/')[3];
        const note = await pushNoteToMaimemo(id);
        return sendJSON(res, 200, { ok: true, note });
      }

      return sendJSON(res, 404, { error: '接口不存在: ' + p });
    }

    /* ---- 静态文件 ---- */
    let filePath = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not Found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (p.startsWith('/api/')) {
      return sendJSON(res, err.code === 'NO_TOKEN' || err.code === 'NO_LLM' ? 400 : 500, { error: err.message, code: err.code });
    }
    res.writeHead(500); res.end('Server Error');
  }
});

ensureDataDir();
armAutoSync();
server.listen(PORT, HOST, () => {
  console.log(`\n  英语学习工作台已启动`);
  console.log(`  ➜  http://localhost:${PORT}  (listening on ${HOST})`);
  console.log(`  数据目录: ${DATA_DIR}\n`);
  if (!config.maimemoToken) console.log('  [提示] 尚未配置墨墨 Token，请打开网页在「设置」中填写\n');
});
