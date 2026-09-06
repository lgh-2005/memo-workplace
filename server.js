/**
 * 英语学习工作台 - 本地服务
 * 零依赖 Node.js (>=22)，单文件后端
 *
 * 职责：
 *  1. 墨墨背单词 Open API 同步（进度 / 今日词 / 学习记录全量）
 *  2. 本地 JSON 持久化（学习数据 / 学习会话 / 助记内容 / 配置）
 *  3. LLM 代理（OpenAI-compatible /v1/chat/completions，可插拔服务商）
 *  4. 助记生成（会话总结 -> 按词保存）+ 推回墨墨 notes API
 *     v1.0.6：推送前自动绑定云词库（notepad）——词不在库中先追加，再写助记
 *  5. AI 生图（v1.0.6）：LLM 把单词+对话场景改写成画面提示词，
 *     调 OpenAI 兼容 /images/generations 出图，落盘 data/images 供前端展示
 *  6. 网络搜索服务（v1.0.7）：通用 url+密钥 搜索 API 代理，供 AI 联网等板块复用
 *  7. 墨墨频控合规（v1.0.7）：按官方文档实现全局限流——10s/20 次、60s/40 次、
 *     5h/2000 次（滑动窗口护栏），内容创建 600 条/天（例句+助记+释义合并）
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
const IMAGES_DIR = path.join(DATA_DIR, 'images');   // v1.0.6：AI 生图落盘目录
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
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
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
  kaoyanMode: false,   // v1.0.5：考研英语一模式（默认关闭）
  maimemoNotepadId: '',   // v1.0.6：绑定的云词库 id（助记推送前提）
  notepadTitle: '',
  imageGen: { baseUrl: '', apiKey: '', model: '' },   // v1.0.6：生图服务商（OpenAI 兼容 images API）
  webSearch: { url: '', apiKey: '' },   // v1.0.7：网络搜索服务（通用 url + 密钥）
});
if (config.kaoyanMode === undefined) config.kaoyanMode = false;   // 旧配置兼容
// v1.0.6 迁移：云词库绑定与生图配置缺省补齐
if (config.maimemoNotepadId === undefined) config.maimemoNotepadId = '';
if (config.notepadTitle === undefined) config.notepadTitle = '';
if (!config.imageGen || typeof config.imageGen !== 'object') config.imageGen = { baseUrl: '', apiKey: '', model: '' };
// v1.0.7 迁移：搜索服务配置缺省补齐
if (!config.webSearch || typeof config.webSearch !== 'object') config.webSearch = { url: '', apiKey: '' };

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
  lastSyncOk: true,
  syncLog: [],            // [{ts, ok, msg}]
  progressHistory: [],    // [{date, finished, total, studyTimeMs}]
  planTotal: 0,           // 学习计划总词数
  words: {},              // vocId -> {vocId, spelling, studyCount, tags[], lastResponse, nextStudyDate, lastStudyDate, addDate, today:{firstResponse,isNew,isFinished}, quizResponse?, quizWrong?, quizLastAt?}
  glosses: {},            // spelling -> {phonetic, pos, gloss}（AI 词典缓存，v1.0.4）
  todayItems: [],         // 最近一次同步的今日词表
  notes: [],              // 助记 {id, spelling, vocId?, noteType, content, createdAt, sessionId, source, synced, maimemoNoteId?, pushError?}
  sessions: [],           // 学习会话 {id, startedAt, endedAt, words[], messages[], errorWords[]}
  quizLog: [],            // 测验记录 [{ts, mode, total, familiar, vague, forget}]（v1.0.4）
  contentCreated: { date: '', count: 0 },   // v1.0.7：当日已创建内容数（例句+助记+释义，官方上限 600/天）
});
// 旧 db.json 兼容：缺失字段补默认值
if (!db.glosses) db.glosses = {};
if (!Array.isArray(db.quizLog)) db.quizLog = [];
if (db.lastSyncOk === undefined) db.lastSyncOk = true;
if (!db.contentCreated || typeof db.contentCreated !== 'object') db.contentCreated = { date: '', count: 0 };   // v1.0.7

function persistConfig() { saveJSON(CONFIG_FILE, config); }
function persistDB() { saveJSON(DB_FILE, db); }

/* ------------------------------------------------------------------ */
/* 墨墨 API 客户端（v1.0.7：按官方频控文档实现全局滑动窗口限流）          */
/* 官方规则（open.maimemo.com，2026-09 核对）：                          */
/*   10 秒 20 次 / 60 秒 40 次 / 5 小时 2000 次（墨墨背单词）            */
/*   内容创建（例句+助记+释义合并）每天最多 600 条                       */
/* ------------------------------------------------------------------ */

// v1.0.7：全局请求时间戳滑动窗口（官方未说明按端点独立计数，保守按全局计）
const callTimestamps = [];
const WIN_10S = 10_000, WIN_60S = 60_000, WIN_5H = 5 * 3600_000;
const LIMIT_10S = 18, LIMIT_60S = 38, LIMIT_5H = 1900;   // 官方 20/40/2000，各留约 10% 余量
// v1.0.5：自适应间隔——触发限流后全局上调（各接口一起降速），连续成功后缓慢回落
let baseGapMs = 650;          // 基础间隔（窗口护栏兜底，短同步可快速通过）
const GAP_MIN = 650, GAP_MAX = 8000;
let throttledCount = 0;       // 本次进程内 429 计数（同步日志里如实汇报）

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 全局限流：滑动窗口护栏 + 基础间隔，任一约束命中即等待（分段睡，可响应收紧） */
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (callTimestamps.length && now - callTimestamps[0] > WIN_5H) callTimestamps.shift();
    let wait = 0;
    if (callTimestamps.length >= LIMIT_10S) {
      wait = Math.max(wait, WIN_10S - (now - callTimestamps[callTimestamps.length - LIMIT_10S]));
    }
    if (callTimestamps.length >= LIMIT_60S) {
      wait = Math.max(wait, WIN_60S - (now - callTimestamps[callTimestamps.length - LIMIT_60S]));
    }
    if (callTimestamps.length >= LIMIT_5H) {
      wait = Math.max(wait, WIN_5H - (now - callTimestamps[0]));
    }
    const last = callTimestamps[callTimestamps.length - 1] || 0;
    wait = Math.max(wait, baseGapMs - (now - last));
    if (wait <= 0) { callTimestamps.push(now); return; }
    await sleep(Math.min(wait, 2000));
  }
}

function tightenGap() { baseGapMs = Math.min(GAP_MAX, Math.round(baseGapMs * 1.6)); throttledCount++; }
function relaxGap() { if (baseGapMs > GAP_MIN) baseGapMs = Math.max(GAP_MIN, Math.round(baseGapMs / 1.15)); }

/**
 * 调用墨墨 API。自动剥信封、限流自适应退避、网络/5xx 错误重试。
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

  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle();
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
      // 网络抖动：指数退避后重试
      if (attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error('网络错误：' + err.message);
    }

    // 429 限流：上调全局间隔 + 按 retry-after 退避重试
    if (res.status === 429) {
      tightenGap();
      if (attempt < 3) {
        const ra = Number(res.headers.get('retry-after-short') || res.headers.get('retry-after') || 2);
        await sleep((ra + 0.5 + Math.random()) * 1000);
        continue;
      }
      throw new Error('墨墨限流(429)：已自动退避 3 次仍未恢复，请几分钟后再试');
    }

    // 5xx 服务端抖动：退避重试
    if (res.status >= 500) {
      if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
    }

    relaxGap();
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

/**
 * 学习记录全量导出（v1.0.7：二分切窗抓取）
 * 旧版逐月 as_count 探针：2019 起约 100 次探测 + 抓取，请求数多、耗时长。
 * 新版：宽窗口直接抓（limit=1000），返回满 1000 条说明可能截断，就把窗口二分
 * 递归下钻。请求数只花在真正有数据的地方（约 15-25 次），分片不重叠不遗漏。
 */
async function syncStudyRecords() {
  const start = new Date(Date.UTC(2019, 0, 1));
  const end = new Date(Date.now() + 400 * 86400000);

  let fetched = 0, windows = 0, truncated = 0;
  const seen = new Set();          // 去重计数（窗口边界重合的记录会抓到两次，按词去重）
  const queue = [[start, end]];
  while (queue.length) {
    const [ws, we] = queue.shift();
    windows++;
    let records;
    try {
      const data = await mm('/study/query_study_records', {
        method: 'POST',
        body: { next_study_date: { start: toMM(ws), end: toMM(we) }, limit: 1000 },
      });
      records = data.records || [];
    } catch (e) {
      // 单窗失败不拖垮全量同步：计入截断数，同步日志如实汇报
      truncated++;
      continue;
    }
    for (const r of records) {
      upsertWordFromRecord(r);
      if (!seen.has(r.voc_id)) { seen.add(r.voc_id); fetched++; }
    }
    if (records.length < 1000) continue;
    // 满 1000：可能截断，二分下钻（墨墨 count 探针已不需要）
    const mid = new Date(Math.floor((ws.getTime() + we.getTime()) / 2));
    if (mid <= ws || mid >= we) { truncated++; continue; }   // 窗口已到最小粒度仍满页（极端情况）
    queue.push([ws, mid], [mid, we]);
  }
  return { fetched, windows, truncated };
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
      steps.push(`学习记录 ${r.fetched} 条/${r.windows} 次请求${r.truncated ? `（${r.truncated} 个窗口截断）` : ''}`);
    }
  } catch (e) { steps.push('学习记录失败: ' + e.message); }

  // 学习计划总量
  try {
    const data = await mm('/study/query_study_records', { method: 'POST', body: { as_count: true } });
    db.planTotal = data.count || 0;
    steps.push(`计划总量 ${db.planTotal}`);
  } catch { /* 非致命 */ }

  db.lastSync = new Date().toISOString();
  db.lastSyncOk = ok;
  if (throttledCount > 0) steps.push(`（期间触发限流 ${throttledCount} 次，已自动退避恢复）`);
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
  if (sys.includes('英汉词典')) {
    const words = user.split('\n').map(s => s.trim()).filter(Boolean);
    return JSON.stringify({
      glosses: words.map(w => ({
        spelling: w, phonetic: '/mɒk/', pos: 'n.',
        gloss: `[MOCK] ${w} 的核心释义（自测数据）`,
      })),
    });
  }
  if (sys.includes('美术指导')) {   // v1.0.6：生图提示词 mock
    const word = (user.match(/当前单词：(.+)/) || [])[1] || 'word';
    return JSON.stringify({
      prompt: `A flat-style mock mnemonic illustration for the word "${word.trim()}", bright colors`,
      caption: '[MOCK] 占位画面说明（自测数据）',
    });
  }
  return `[MOCK] 收到！这是一个自测回复。（词义、例句、用法讲解在配置真实 AI 服务商后可用）\n\n关于你的问题「${user.slice(0, 60)}」：本回复来自内置 mock 模式，仅用于验证闭环。`;
}

/* ---------- v1.0.6：AI 生图（助记图） ---------- */

const IMAGE_PRESETS = {
  zhipu: { label: '智谱 CogView', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-4' },
  openai: { label: 'OpenAI DALL·E', baseUrl: 'https://api.openai.com/v1', model: 'dall-e-3' },
};

const IMAGE_PROMPT_SYSTEM = [
  '你是记忆图片的美术指导，面向中国英语学习者。',
  '根据当前学习的单词和最近的对话场景，构思一幅"助记图"：把单词的核心义项/记忆钩子画成一个具体、夸张、好记的画面。',
  '只输出 JSON，不要任何多余文字，格式：{"prompt":"英文画面提示词","caption":"中文一句话说明画面与记忆点"}',
  '规则：prompt 用英文、一个场景、主体明确、风格统一（明快扁平插画），60 词以内；caption 30 字内点出记忆钩子。',
].join('\n');

/** 调 OpenAI 兼容 /images/generations 出一张图，落盘后返回本地 URL */
async function callImageAPI(prompt) {
  const ig = config.imageGen || {};
  const baseUrl = (ig.baseUrl || '').trim();
  const model = (ig.model || '').trim();
  if (!baseUrl || !model) {
    const e = new Error('尚未配置生图服务商，请到「设置」页填写 Base URL 与模型');
    e.code = 'NO_IMG';
    throw e;
  }
  const url = baseUrl.replace(/\/+$/, '') + '/images/generations';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ig.apiKey ? { 'Authorization': 'Bearer ' + ig.apiKey } : {}),
      },
      body: JSON.stringify({ model, prompt: String(prompt).slice(0, 2000), n: 1, size: '1024x1024' }),
    });
  } catch {
    throw new Error(`无法连接生图服务（${baseUrl}），请到「设置」检查地址与网络`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`生图请求失败 (HTTP ${res.status}) ${text.slice(0, 300)}`);
  }
  const j = await res.json();
  const item = (Array.isArray(j.data) && j.data[0]) || {};

  // b64 直接落盘；url 则下载缓存（远端 URL 常带时效，落盘后本地可长期回看）
  if (item.b64_json) {
    return saveImageFile(Buffer.from(item.b64_json, 'base64'), 'png');
  }
  if (item.url) {
    try {
      const imgRes = await fetch(item.url);
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const ct = (imgRes.headers.get('content-type') || '').split('/')[1];
      const ext = ['png', 'jpg', 'jpeg', 'webp'].includes(ct) ? (ct === 'jpeg' ? 'jpg' : ct) : 'png';
      return saveImageFile(buf, ext);
    } catch {
      return { url: item.url };   // 下载失败退回远端 URL，至少能看到图
    }
  }
  throw new Error('生图服务返回内容无法识别（缺少 url / b64_json）');
}

function saveImageFile(buf, ext) {
  const name = `img_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
  return { url: '/images/' + name };
}

/** mock 模式的占位图：本地画一张 SVG，保证全链路可测 */
function mockImageFile(spelling) {
  const safe = String(spelling).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="32" fill="#e8f4fd"/>
  <circle cx="256" cy="210" r="120" fill="#9cd3f5"/>
  <ellipse cx="256" cy="415" rx="170" ry="26" fill="#bcdff5"/>
  <text x="256" y="120" font-size="44" text-anchor="middle" fill="#2b6cb0" font-family="sans-serif">MOCK 助记图</text>
  <text x="256" y="235" font-size="64" font-weight="bold" text-anchor="middle" fill="#1a365d" font-family="sans-serif">${safe}</text>
  <text x="256" y="310" font-size="26" text-anchor="middle" fill="#4a7aa8" font-family="sans-serif">[MOCK] 自测占位画面</text>
</svg>`;
  return saveImageFile(Buffer.from(svg, 'utf8'), 'svg');
}

/** 生图主流程：LLM 改写画面提示词（失败用模板兜底）→ 出图 → 返回 {url, prompt, caption} */
async function generateMnemonicImage({ spelling, context = [] }) {
  if (!spelling) throw new Error('请先选中一个单词');

  let prompt = `A creative flat-style mnemonic illustration for the English word "${spelling}", one clear vivid scene, bright colors`;
  let caption = `${spelling} 的助记图`;
  try {
    const recent = context.slice(-6).map(m => `[${m.role === 'user' ? '学习者' : 'AI'}] ${String(m.content).slice(0, 120)}`).join('\n');
    const text = await llmChat([
      { role: 'system', content: IMAGE_PROMPT_SYSTEM },
      { role: 'user', content: `当前单词：${spelling}\n最近对话（可能为空）：\n${recent || '（无）'}` },
    ], { maxTokens: 400 });
    const parsed = parseMnemonicJSON(text);
    if (parsed?.prompt) prompt = String(parsed.prompt).slice(0, 800);
    if (parsed?.caption) caption = String(parsed.caption).slice(0, 80);
  } catch (e) {
    if (e.code === 'NO_LLM') throw e;   // 连对话模型都没有且非 mock：如实报错
    // LLM 改写失败不阻塞，用兜底提示词继续出图
  }

  const img = (config.llm.mock || config.imageGen?.mock)
    ? mockImageFile(spelling)
    : await callImageAPI(prompt);
  return { ...img, prompt, caption, spelling };
}

/* ---------- v1.0.7：网络搜索服务（通用 url + 密钥，供现有/后续板块复用） ---------- */

const SEARCH_PRESETS = {
  bocha: { label: '博查 Bocha', url: 'https://api.bochaai.com/v1/web-search' },
  tavily: { label: 'Tavily', url: 'https://api.tavily.com/search' },
  serper: { label: 'Serper（Google）', url: 'https://google.serper.dev/search' },
  zhipu: { label: '智谱搜索', url: 'https://open.bigmodel.cn/api/paas/v4/web_search' },
};

/**
 * 通用搜索代理：POST 配置的 url，Bearer 密钥鉴权。
 * 请求体与响应解析做主流服务商兼容（博查/Tavily/Serper/智谱及 OpenAI 风格中转），
 * 统一返回 [{title, url, snippet}]，后续板块零成本接入。
 */
async function webSearch(query, count = 5) {
  const ws = config.webSearch || {};
  // mock 模式优先：无需配置即可验证全链路（与 LLM/生图 mock 行为一致）
  if (config.llm.mock) {
    return Array.from({ length: Math.min(count, 3) }, (_, i) => ({
      title: `[MOCK] 「${query}」搜索结果 ${i + 1}`,
      url: 'https://example.com/mock#' + (i + 1),
      snippet: '这是 mock 模式下的占位搜索结果，用于验证搜索链路（配置真实搜索服务后可联网）。',
    }));
  }
  if (!ws.url) {
    const e = new Error('尚未配置网络搜索服务，请到「设置」页填写 URL 与密钥');
    e.code = 'NO_SEARCH';
    throw e;
  }
  let res;
  try {
    res = await fetch(ws.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ws.apiKey ? { 'Authorization': 'Bearer ' + ws.apiKey, 'X-API-KEY': ws.apiKey } : {}),
      },
      // 字段超集：覆盖博查(query/count/summary)、Tavily(query/max_results)、Serper(q)、智谱(search_query)
      body: JSON.stringify({ query, q: query, search_query: query, count, max_results: count, summary: true }),
    });
  } catch {
    throw new Error(`无法连接搜索服务（${ws.url}），请到「设置」检查地址与网络`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`搜索请求失败 (HTTP ${res.status}) ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  // 兼容多种返回结构：博查 data.webPages.value / Tavily results / Serper organic / 通用 data[]
  const raw = j?.data?.webPages?.value || j?.webPages?.value || j?.results || j?.organic
    || (Array.isArray(j?.data) ? j.data : []);
  return (Array.isArray(raw) ? raw : []).slice(0, count).map(r => ({
    title: r.name || r.title || '',
    url: r.url || r.link || '',
    snippet: String(r.summary || r.snippet || r.content || r.description || '').slice(0, 500),
  })).filter(r => r.title || r.snippet);
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
  if (config.kaoyanMode) {
    lines.push(
      '【🎓 考研英语一模式已开启】讲解必须对标考研英语一：',
      '- 优先讲考研高频义项，特别注意熟词僻义（真题最爱考的往往不是第一义项）。',
      '- 例句模仿历年真题（阅读/翻译）的句式难度与话题风格（经济/科技/社会/教育等），并标注话题领域；不确定是真题原文就不要编造年份。',
      '- 主动补充：该词在真题中的常见考法（完形填空/阅读/翻译）、易混词对比、写作可用的搭配。'
    );
  }
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

/* ---------- v1.0.4：AI 词典缓存（音标/词性/核心释义） ---------- */

async function ensureGlosses(spellings) {
  const missing = [...new Set(spellings)].filter(sp => sp && !db.glosses[sp]);
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    try {
      const text = await llmChat([
        { role: 'system', content: GLOSS_SYSTEM + (config.kaoyanMode ? '\n当前用户开启了考研英语一模式：gloss 优先给考研高频义项，熟词僻义放在第一位。' : '') },
        { role: 'user', content: chunk.join('\n') },
      ], { maxTokens: 1600, providerId: 'gloss' });
      const parsed = parseMnemonicJSON(text);
      for (const g of (parsed?.glosses || [])) {
        if (g && g.spelling && g.gloss) {
          db.glosses[String(g.spelling)] = {
            phonetic: String(g.phonetic || '').slice(0, 60),
            pos: String(g.pos || '').slice(0, 40),
            gloss: String(g.gloss).slice(0, 120),
          };
        }
      }
    } catch { /* 失败的块静默跳过，下次请求再试 */ }
  }
  persistDB();
}

const GLOSS_SYSTEM = [
  '你是一本英汉词典，面向中国考研学生。',
  '对用户给出的每个单词（每行一个）输出极简词典信息。',
  '只输出 JSON，不要任何多余文字，格式：',
  '{"glosses":[{"spelling":"单词","phonetic":"/美式音标/，不确定就给空串","pos":"词性缩写如 n. v. adj.","gloss":"最核心的 1-2 个中文释义，30 字内"}]}',
  '规则：每个输入单词都必须有一条；音标不确定给空串，严禁编造；释义要优先考研高频义项。',
].join('\n');

/** 记录测验结果：反哺「我又忘了」体系（写入 word.quizResponse，供忘记词/模糊词筛选） */
function applyQuizResults(results, mode) {
  let applied = 0;
  for (const r of results) {
    const sp = String(r.spelling || '').trim();
    const resp = ['FAMILIAR', 'VAGUE', 'FORGET'].includes(r.response) ? r.response : null;
    if (!sp || !resp) continue;
    const w = Object.values(db.words).find(x => x.spelling === sp);
    if (!w) continue;
    w.quizResponse = resp;
    if (resp === 'FORGET') w.quizWrong = (w.quizWrong || 0) + 1;
    w.quizLastAt = new Date().toISOString();
    applied++;
  }
  db.quizLog.unshift({
    ts: new Date().toISOString(), mode: String(mode || '').slice(0, 20),
    total: results.length,
    familiar: results.filter(r => r.response === 'FAMILIAR').length,
    vague: results.filter(r => r.response === 'VAGUE').length,
    forget: results.filter(r => r.response === 'FORGET').length,
  });
  db.quizLog = db.quizLog.slice(0, 100);
  persistDB();
  return applied;
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

  let system = [
    '你是英语学习教练。学习者刚结束一次单词学习会话。',
    '请根据会话内容和易错点，为每个学习过的单词生成一条个性化助记。',
    '要求：',
    '1. 助记要结合学习者在会话中暴露的具体问题（混淆的词、忘掉的义项、拼错的点），而不是泛泛的词根拆解。',
    '2. 每条助记 80 字以内，可以直接背。',
    '3. noteType 从这些里选一个最贴切的：联想/谐音/词根词缀/近反义词/辨析/固定搭配/词源/口诀/其他。',
    '4. 只输出 JSON，不要多余文字，格式：{"notes":[{"spelling":"单词","noteType":"联想","content":"助记内容"}]}',
    '5. 每个学习过的单词都要有一条。',
  ];
  if (config.kaoyanMode) {
    system.push('6. 考研英语一模式：助记要突出熟词僻义、真题考法与写作可用搭配，风格贴合考研备考场景。');
  }
  system = system.join('\n');

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

/* ---------- v1.0.6：云词库（notepad）绑定 ---------- */

// notepad 内容词缓存（5 分钟）：避免每次推送都全量拉取
let notepadCache = { id: '', at: 0, words: new Set(), notepad: null };

/** 拉取账号下全部云词库/收藏本（GET /notepads limit 上限 10，翻页到取完为止） */
async function listNotepads() {
  const out = [];
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const data = await mm('/notepads', { query: { limit: 10, offset } });
    const list = data?.notepads || [];
    for (const np of list) {
      out.push({
        id: np.id, title: np.title, brief: np.brief || '', type: np.type,
        status: np.status, updatedAt: np.updated_time,
      });
    }
    if (list.length < 10) break;
    offset += 10;
  }
  return out;
}

/** 确保单词在绑定的云词库中：不在则把拼写追加到 content 末尾并全量更新。
 *  这是助记能写进墨墨的前提（实测：词不在云词库时 POST /notes 会被拒）。
 *  注意 POST /notepads/{id} 更新要求 title/brief/content/tags/status 全量携带。 */
async function ensureWordInNotepad(spelling) {
  const nid = (config.maimemoNotepadId || '').trim();
  if (!nid) return;   // 未绑定则不阻塞旧流程（推送仍可能因云词库缺失失败，错误如实上报）

  const now = Date.now();
  if (notepadCache.id !== nid || now - notepadCache.at > 5 * 60 * 1000) {
    const data = await mm(`/notepads/${encodeURIComponent(nid)}`);
    const np = data?.notepad || null;
    if (!np) throw new Error('云词库不存在或已被删除，请到「设置」重新绑定');
    const words = (Array.isArray(np.list) ? np.list : [])
      .filter(it => it?.type === 'WORD')
      .map(it => String(it?.data?.word || '').toLowerCase());
    notepadCache = { id: nid, at: now, words: new Set(words), notepad: np };
  }

  if (notepadCache.words.has(String(spelling).toLowerCase())) return;

  const np = notepadCache.notepad;
  const content = (np.content || '') + (np.content && !np.content.endsWith('\n') ? '\n' : '') + spelling;
  await mm(`/notepads/${encodeURIComponent(nid)}`, {
    method: 'POST',
    body: {
      notepad: {
        title: np.title || '工作台云词库',
        brief: np.brief || '',
        content,
        tags: Array.isArray(np.tags) ? np.tags : [],
        status: np.status || 'PUBLISHED',
      },
    },
  });
  // 更新缓存（content 换新，list 由下次全量拉取重建）
  notepadCache.notepad.content = content;
  notepadCache.words.add(String(spelling).toLowerCase());
}

/** 把助记推回墨墨 notes API（关联 voc_id；v1.0.6 起先确保词在绑定的云词库中） */
/** v1.0.7：官方内容创建频控——例句、助记、释义合并，每天最多 600 条。返回今日剩余额度 */
function contentQuotaLeft() {
  const today = bjDate();
  if (db.contentCreated?.date !== today) db.contentCreated = { date: today, count: 0 };
  return Math.max(0, 600 - (db.contentCreated.count || 0));
}
function countContentCreated(n = 1) {
  contentQuotaLeft();   // 顺带触发跨日重置
  db.contentCreated.count += n;
}

async function pushNoteToMaimemo(noteId) {
  const note = db.notes.find(n => n.id === noteId);
  if (!note) throw new Error('助记不存在');
  if (note.synced) return note;

  // v1.0.7：官方内容创建频控（600 条/天），超限如实报错而不是被墨墨打回
  if (contentQuotaLeft() <= 0) {
    note.pushError = '已达官方内容创建频控（例句+助记+释义共 600 条/天），明天再推';
    persistDB();
    throw new Error(note.pushError);
  }

  const vocId = note.vocId || await resolveVocId(note.spelling);
  if (!vocId) {
    note.pushError = `词库中查不到「${note.spelling}」（注意大小写），无法推送`;
    persistDB();
    throw new Error(note.pushError);
  }
  note.vocId = vocId;

  // v1.0.6：词不在云词库中先追加（这是 notes 写入的前提，失败则中断并如实报错）
  try {
    await ensureWordInNotepad(note.spelling);
  } catch (e) {
    note.pushError = `云词库同步失败：${e.message}`;
    persistDB();
    throw new Error(note.pushError);
  }

  const data = await mm('/notes', {
    method: 'POST',
    body: { note: { voc_id: vocId, note_type: note.noteType, note: note.content } },
  });
  note.synced = true;
  note.maimemoNoteId = data?.note?.id || null;
  note.pushError = null;
  countContentCreated(1);   // v1.0.7：计入官方 600 条/天创建配额
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

  // 最近 14 天进度曲线（不足的天数补零，保证标题与数据窗口一致）
  const history = [];
  for (let i = -13; i <= 0; i++) {
    const key = bjDate(i);
    const rec = db.progressHistory.find(x => x.date === key);
    history.push({ date: key, finished: rec?.finished || 0, total: rec?.total || 0 });
  }

  return {
    lastSync: db.lastSync,
    lastSyncOk: db.lastSyncOk,
    todayStr: today,
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
          lastSyncOk: db.lastSyncOk,
          kaoyanMode: !!config.kaoyanMode,
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
          kaoyanMode: !!config.kaoyanMode,
          maimemoNotepadId: config.maimemoNotepadId || '',
          notepadTitle: config.notepadTitle || '',
          imageGen: {
            baseUrl: config.imageGen.baseUrl || '',
            model: config.imageGen.model || '',
            hasKey: !!config.imageGen.apiKey,
          },
          webSearch: {
            url: config.webSearch.url || '',
            hasKey: !!config.webSearch.apiKey,
          },
          searchPresets: SEARCH_PRESETS,
          imagePresets: IMAGE_PRESETS,
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
        if (body.kaoyanMode != null) config.kaoyanMode = !!body.kaoyanMode;
        // v1.0.6：云词库绑定
        if (body.maimemoNotepadId !== undefined) {
          config.maimemoNotepadId = String(body.maimemoNotepadId || '').trim().slice(0, 120);
        }
        if (typeof body.notepadTitle === 'string') {
          config.notepadTitle = body.notepadTitle.slice(0, 60);
        }
        // v1.0.6：生图服务商（apiKey 留空沿用已存 Key）
        if (body.imageGen && typeof body.imageGen === 'object') {
          const oldImg = config.imageGen || {};
          config.imageGen = {
            baseUrl: String(body.imageGen.baseUrl ?? oldImg.baseUrl ?? '').trim(),
            model: String(body.imageGen.model ?? oldImg.model ?? '').trim(),
            apiKey: (typeof body.imageGen.apiKey === 'string' && body.imageGen.apiKey.trim())
              ? body.imageGen.apiKey.trim() : (oldImg.apiKey || ''),
          };
        }
        // v1.0.7：网络搜索服务配置（Key 留空 = 沿用已存）
        if (body.webSearch && typeof body.webSearch === 'object') {
          const oldWs = config.webSearch || {};
          config.webSearch = {
            url: String(body.webSearch.url ?? oldWs.url ?? '').trim(),
            apiKey: (typeof body.webSearch.apiKey === 'string' && body.webSearch.apiKey.trim())
              ? body.webSearch.apiKey.trim() : (oldWs.apiKey || ''),
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

      // 同步（失败自动退避重试一次，v1.0.4）
      if (p === '/api/sync' && req.method === 'POST') {
        let result = await runSync('manual');
        if (!result.ok) {
          await sleep(3000);
          result = await runSync('manual-retry');
        }
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
        else if (filter === 'forget') words = words.filter(w => w.lastResponse === 'FORGET' || w.today?.firstResponse === 'FORGET' || w.quizResponse === 'FORGET');
        else if (filter === 'vague') words = words.filter(w => w.lastResponse === 'VAGUE' || w.today?.firstResponse === 'VAGUE' || w.quizResponse === 'VAGUE');
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
        // 搜索：拼写或已缓存的中文释义（v1.0.4）
        if (q) words = words.filter(w =>
          w.spelling.toLowerCase().includes(q) ||
          (db.glosses[w.spelling]?.gloss || '').toLowerCase().includes(q));
        words.sort((a, b) => (b.lastStudyDate || '').localeCompare(a.lastStudyDate || ''));
        return sendJSON(res, 200, {
          words: words.slice(0, 500).map(w => ({ ...w, gloss: db.glosses[w.spelling] || null })),
        });
      }

      // AI 词典缓存：批量获取/返回 音标+词性+核心释义（v1.0.4）
      if (p === '/api/gloss' && req.method === 'POST') {
        const body = await readBody(req);
        const spellings = (Array.isArray(body.spellings) ? body.spellings : [])
          .map(s => String(s).trim()).filter(Boolean).slice(0, 60);
        if (!spellings.length) return sendJSON(res, 200, { glosses: {} });
        await ensureGlosses(spellings);
        const out = {};
        for (const sp of spellings) if (db.glosses[sp]) out[sp] = db.glosses[sp];
        return sendJSON(res, 200, { glosses: out });
      }

      // 测验结果提交：计入错词体系（v1.0.4）
      if (p === '/api/quiz/submit' && req.method === 'POST') {
        const body = await readBody(req);
        const results = Array.isArray(body.results) ? body.results.slice(0, 500) : [];
        const applied = applyQuizResults(results, body.mode);
        return sendJSON(res, 200, { ok: true, applied });
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

        // v1.0.7：联网搜索——开启时先搜索实时资料注入 system prompt；失败不阻塞对话
        if (body.useSearch) {
          try {
            const results = await webSearch(spelling ? `${spelling} ${message}` : message, 5);
            if (results.length) {
              const block = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   来源: ${r.url}`).join('\n');
              msgs[0].content += '\n\n【联网搜索结果（实时资料，可能比你的训练数据更新）】\n' + block +
                '\n\n回答时可自然引用以上资料并注明来源；若与你的既有知识冲突，以搜索结果为准并明确指出。';
            } else {
              msgs[0].content += '\n\n（联网搜索无结果，请基于自身知识回答）';
            }
          } catch (e) {
            msgs[0].content += `\n\n（联网搜索失败：${e.message}。请基于自身知识回答，并在开头提醒用户本次未联网。）`;
          }
        }

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

      // 云词库列表（v1.0.6：设置页绑定用）
      if (p === '/api/notepads' && req.method === 'GET') {
        const notepads = await listNotepads();
        return sendJSON(res, 200, {
          notepads,
          boundId: config.maimemoNotepadId || '',
          boundTitle: config.notepadTitle || '',
        });
      }

      // AI 生图（v1.0.6）：单词 + 会话场景 → 助记图
      if (p === '/api/image/gen' && req.method === 'POST') {
        const body = await readBody(req);
        const spelling = String(body.spelling || '').trim().slice(0, 60);
        const context = Array.isArray(body.context) ? body.context.slice(-8) : [];
        const result = await generateMnemonicImage({ spelling, context });
        return sendJSON(res, 200, { ok: true, ...result });
      }

      // 生图连通性测试（v1.0.6）
      if (p === '/api/test/image' && req.method === 'POST') {
        const result = await generateMnemonicImage({ spelling: 'memory', context: [] });
        return sendJSON(res, 200, { ok: true, msg: '生图成功！', ...result });
      }

      // 网络搜索（v1.0.7）：通用 url+密钥 搜索代理，供现有/后续板块复用
      if (p === '/api/search' && req.method === 'POST') {
        const body = await readBody(req);
        const query = String(body.query || '').trim().slice(0, 200);
        const count = Math.min(10, Math.max(1, Number(body.count) || 5));
        if (!query) return sendJSON(res, 400, { error: '搜索词不能为空' });
        const results = await webSearch(query, count);
        return sendJSON(res, 200, { ok: true, query, results });
      }

      // 搜索连通性测试（v1.0.7）
      if (p === '/api/test/search' && req.method === 'POST') {
        const results = await webSearch('考研英语 高频词汇', 3);
        return sendJSON(res, 200, {
          ok: true,
          msg: `搜索成功！返回 ${results.length} 条结果`,
          sample: results[0] ? `${results[0].title}（${results[0].url}）` : '（无结果）',
        });
      }

      return sendJSON(res, 404, { error: '接口不存在: ' + p });
    }

    /* ---- 静态文件 ---- */
    // v1.0.6：生成的助记图（/images/*，从 data/images 提供）
    if (p.startsWith('/images/')) {
      const imgPath = path.join(IMAGES_DIR, p.slice('/images/'.length));
      if (!imgPath.startsWith(IMAGES_DIR) || !fs.existsSync(imgPath)) { res.writeHead(404); return res.end('Not Found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(imgPath).toLowerCase()] || 'application/octet-stream' });
      return fs.createReadStream(imgPath).pipe(res);
    }
    let filePath = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not Found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (p.startsWith('/api/')) {
      return sendJSON(res, ['NO_TOKEN', 'NO_LLM', 'NO_IMG', 'NO_SEARCH'].includes(err.code) ? 400 : 500, { error: err.message, code: err.code });
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
