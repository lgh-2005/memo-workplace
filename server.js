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
 *  8. 韦氏词典（v1.0.8）：Merriam-Webster 双 key 代理（学习者版+大学版并行合并），
 *     本地缓存 data/dict/，真人发音 mp3，权威释义/词源注入 AI 教练上下文
 *  9. 题库/语料库（v1.1.0）：读 corpus/records.jsonl（导入工程产出），
 *     契约化浏览/搜索 API，真题原句注入 AI 教练（带来源标注）
 * 10. 语料导入（v1.1.1）：网页端导入按钮——投放(imports) -> 解析 -> 归档(archive)/
 *     隔离(quarantine) + 导入日志，同名重导覆盖；TeX/PDF 走 corpus_tools/ 内置
 *     Python 适配器，txt/md/html/docx 纯 Node 解析；取消板块固定排序（模块化）
 * 11. 真题库分库（v1.1.2）：qa_set 独立到 corpus/exams.jsonl（语料库只留外刊/教材/
 *     真题正文等纯文本），启动时自动迁移；/api/exam/* 浏览与 tex/pdf 导入；
 *     按「考试-题型」（考研-完形填空/阅读理解/新题型/翻译/写作）统计各题型板块
 *
 * 启动：node server.js  （默认端口 5178）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const IMAGES_DIR = path.join(DATA_DIR, 'images');   // v1.0.6：AI 生图落盘目录
const DICT_DIR = path.join(DATA_DIR, 'dict');       // v1.0.8：韦氏词典本地缓存（一词终身只查一次）
// v1.1.0：题库/语料库——默认读仓库内 corpus/records.jsonl（随 git 部署）；
// 可在设置里指定 kbDir 直接指向导入工程（如 ../importer/kb）实现实时联动
const CORPUS_FILE = path.join(ROOT, 'corpus', 'records.jsonl');
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
  if (!fs.existsSync(DICT_DIR)) fs.mkdirSync(DICT_DIR, { recursive: true });
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
  dict: { learnersKey: '', collegiateKey: '' },   // v1.0.8：韦氏词典双 key（learners=学习者词典 / collegiate=大学版）
  mineru: { apiKey: '', mock: false },   // v1.1.4：MinerU 精准解析 API（扫描件 PDF -> Markdown，mineru.net）
});
if (config.kaoyanMode === undefined) config.kaoyanMode = false;   // 旧配置兼容
// v1.0.6 迁移：云词库绑定与生图配置缺省补齐
if (config.maimemoNotepadId === undefined) config.maimemoNotepadId = '';
if (config.notepadTitle === undefined) config.notepadTitle = '';
if (!config.imageGen || typeof config.imageGen !== 'object') config.imageGen = { baseUrl: '', apiKey: '', model: '' };
// v1.0.7 迁移：搜索服务配置缺省补齐
if (!config.webSearch || typeof config.webSearch !== 'object') config.webSearch = { url: '', apiKey: '' };
// v1.0.8 迁移：韦氏词典 key 缺省补齐
if (!config.dict || typeof config.dict !== 'object') config.dict = { learnersKey: '', collegiateKey: '' };
// v1.1.4 迁移：MinerU 解析配置缺省补齐
if (!config.mineru || typeof config.mineru !== 'object') config.mineru = { apiKey: '', mock: false };
// v1.1.7 迁移：AI 审核专用服务商配置缺省补齐
if (!config.review || typeof config.review !== 'object') config.review = { providerId: '', model: '', thinking: false };

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
  unitLog: [],            // 单元做题记录 [{ts, unitId, title, total, judged, correct}]（v1.1.5，为错题统计铺路）
});
// 旧 db.json 兼容：缺失字段补默认值
if (!db.glosses) db.glosses = {};
if (!Array.isArray(db.quizLog)) db.quizLog = [];
if (db.lastSyncOk === undefined) db.lastSyncOk = true;
if (!db.contentCreated || typeof db.contentCreated !== 'object') db.contentCreated = { date: '', count: 0 };   // v1.0.7
if (!Array.isArray(db.unitLog)) db.unitLog = [];   // v1.1.5：单元做题记录缺省补齐

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
      body: JSON.stringify(Object.assign(
        { model: llm.model, messages, max_tokens: llm.max_tokens || maxTokens, temperature: llm.temperature !== undefined ? llm.temperature : 0.7 },
        llm._thinking ? { thinking: llm._thinking } : {}
      )),
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
  if (sys.includes('质检审读员')) {   // v1.1.6：mock 审读从送审材料抽真实文本做 quote，验证定位回写链路
    const seg = user.match(/【条目#1｜[^】]*】\n([^\n【]{10,80})/);
    const quote2 = seg ? seg[1].replace(/\s+/g, ' ').trim().slice(0, 30) : '';
    return JSON.stringify({ issues: [
      { loc: '条目#2', quote: quote2, severity: 'low', desc: '[mock] 该条目首行疑似混入页眉' },
      { loc: '通篇', quote: '', severity: 'mid', desc: '[mock] 无摘录的疑点示例（应无法定位）' },
    ] });
  }
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

/* ---------- v1.0.8：韦氏词典（Merriam-Webster 双 key，权威释义 + 真人发音） ---------- */
/* 官方 API（dictionaryapi.com）免费档约 1000 次/天/key。
   Learner's（学习者词典：简单词写完整句释义、例句多）与 Collegiate（大学版：词源全）
   并行查询合并；结果落盘 data/dict/{word}.json —— 词典内容基本不变，一词终身只查一次。
   真人发音 mp3 走官方媒体 CDN（不算 API 次数）。Key 只存本机 config，前端不可见。 */

/** 清理韦氏返回文本里的排版标记：{it} {/it} {bc} {ldquo} [_bs] 等 */
function mwClean(s) {
  return String(s || '')
    .replace(/\{[a-zA-Z_]+\|([^{}]*)\}/g, '$1')   // {variant|内容} 保留内容
    .replace(/\{\/?[a-zA-Z_]+\}/g, '')            // 普通 {tag}
    .replace(/\[\/?[a-z-]+\]/g, '')               // [_bs] [it] 等
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 真人发音 mp3 地址（官方规则：数字开头→number，bix/gg 开头→同名目录，其余→首字母） */
function mwAudioUrl(audio) {
  const a = String(audio || '').replace(/\.(mp3|wav)$/i, '');
  if (!a) return '';
  let dir;
  if (/^\d/.test(a)) dir = 'number';
  else if (/^bix/.test(a)) dir = 'bix';
  else if (/^gg/.test(a)) dir = 'gg';
  else dir = a[0];
  return `https://media.merriam-webster.com/audio/prons/en/us/mp3/${dir}/${a}.mp3`;
}

/** 递归收集韦氏词条里的例句（dt 的 "vis" 字段） */
function collectVis(node, out = [], depth = 0) {
  if (out.length >= 4 || !node || typeof node !== 'object' || depth > 9) return out;
  if (Array.isArray(node)) {
    if (node.length === 2 && node[0] === 'vis' && typeof node[1] === 'string') {
      out.push(mwClean(node[1]).slice(0, 200));
    } else node.forEach(n => collectVis(n, out, depth + 1));
    return out;
  }
  for (const v of Object.values(node)) collectVis(v, out, depth + 1);
  return out;
}

/** 递归收集同义词（learners 的 syn_list / syn 字段） */
function collectSyns(node, out = [], depth = 0) {
  if (out.length >= 8 || !node || typeof node !== 'object' || depth > 9) return out;
  if (Array.isArray(node)) {
    if (node.length === 2 && node[0] === 'syn' && node[1] && typeof node[1] === 'object') {
      const t = node[1].ws?.text || node[1].text || '';
      if (t) out.push(mwClean(t));
    } else node.forEach(n => collectSyns(n, out, depth + 1));
    return out;
  }
  for (const v of Object.values(node)) collectSyns(v, out, depth + 1);
  return out;
}

async function fetchMWApi(ref, word, key) {
  const url = `https://dictionaryapi.com/api/v3/references/${ref}/json/${encodeURIComponent(word)}?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`韦氏词典 ${ref} 请求失败 (HTTP ${res.status})`);
  const j = await res.json();
  return Array.isArray(j) ? j : [];
}

/** 合并学习者版 + 大学版为一个统一词条 */
function mergeMWEntry(word, lr, cg) {
  const le = lr.find(e => typeof e === 'object' && e) || null;
  const ce = cg.find(e => typeof e === 'object' && e) || null;
  const suggestions = [...new Set([...lr, ...cg].filter(x => typeof x === 'string'))].slice(0, 6);
  const base = le || ce;
  if (!base) return { word, found: false, suggestions };

  const prs = (base.hwi?.prs || []).map(x => x.mw).filter(Boolean);
  const defs = (base.shortdef || []).map(d => mwClean(d)).filter(Boolean).slice(0, 4);
  const examples = collectVis(le || ce);
  const synonyms = [...new Set([...collectSyns(le), ...collectSyns(ce)])]
    .filter(s => s.toLowerCase() !== word.toLowerCase()).slice(0, 6);
  const etRaw = ce?.et?.find(x => x?.[0] === 'text')?.[1] || le?.et?.find(x => x?.[0] === 'text')?.[1] || '';
  const audioFile = (base.hwi?.prs || []).find(x => x.sound?.audio)?.sound?.audio || '';

  return {
    word,
    found: true,
    source: le && ce ? 'learners+collegiate' : (le ? 'learners' : 'collegiate'),
    headword: mwClean(base.hwi?.hw || word),
    phonetic: prs.map(p => `\\ ${p} \\`).join(' / '),
    pos: base.fl || '',
    def: defs[0] || '',
    defs,
    examples,
    synonyms,
    etymology: mwClean(etRaw).slice(0, 400),
    audio: mwAudioUrl(audioFile),
  };
}

function dictCacheFile(word) {
  return path.join(DICT_DIR, String(word || '').toLowerCase().replace(/[^a-z'\-]/g, '_') + '.json');
}

/** 只读缓存（不打 API），供词表/详情等低延迟场景使用 */
function dictCached(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return null;
  return loadJSON(dictCacheFile(w), null);
}

/**
 * 查韦氏词典：缓存优先；未命中则双 key 并行查、合并、落盘。
 * mock 模式（与 LLM/生图/搜索一致）返回占位词条，保证全链路可测。
 */
async function dictLookup(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w || !/^[a-zA-Z][a-zA-Z'\- ]{0,59}$/.test(w)) {
    const e = new Error('仅支持英文单词/词组查询');
    e.code = 'BAD_WORD';
    throw e;
  }
  if (config.llm.mock) {
    return {
      word: w, found: true, source: 'mock', headword: w,
      phonetic: '\\ ˈmɒk \\', pos: 'n.',
      def: `[MOCK] ${w} 的权威释义占位（自测数据）`,
      defs: [`[MOCK] ${w} 的权威释义占位（自测数据）`],
      examples: [`[MOCK] This is a mock example sentence for "${w}".`],
      synonyms: ['mocksyn'], etymology: '[MOCK] mock etymology', audio: '',
    };
  }
  if (fs.existsSync(dictCacheFile(w))) return loadJSON(dictCacheFile(w), null);

  const d = config.dict || {};
  if (!d.learnersKey && !d.collegiateKey) {
    const e = new Error('尚未配置韦氏词典 Key，请到「设置」页填写（学习者版 / 大学版至少一个）');
    e.code = 'NO_DICT';
    throw e;
  }
  const tasks = [];
  if (d.learnersKey) tasks.push(fetchMWApi('learners', w, d.learnersKey).catch(() => []));
  if (d.collegiateKey) tasks.push(fetchMWApi('collegiate', w, d.collegiateKey).catch(() => []));
  const [lr = [], cg = []] = await Promise.all(tasks);
  const entry = mergeMWEntry(w, lr, cg);
  saveJSON(dictCacheFile(w), entry);
  return entry;
}

/* ---------- v1.1.0：题库 / 语料库（导入工程产出的 records.jsonl） ---------- */
/* 数据契约见《导入解析-经验总结.md》：rtype=qa_set|article|document|note，
   items 用 〖N〗（挖空/新题型答题框）/ 〖N〗…〖/N〗（翻译划线）做交互锚点。
   v1.1.1：取消「完形→阅读→新题型→翻译→写作」固定板块排序——真题与语料有多样性，
   工作台做模块化渲染而非限制顺序；条目顺序尊重数据层（板块按首次出现，
   板块内题干在前、题目按题号，带 passage_id 的题目跟随所属原文）。 */

const KB_SECTION_LABEL = {
  use_of_english: '完形填空', reading: '阅读 A', part_b: '新题型',
  translation: '翻译', writing: '写作', misc: '其他',
};
const RTYPE_LABEL = { qa_set: '题库', article: '文章', document: '文档', note: '笔记' };

let kbCache = { mtime: 0, records: [], sentences: null, sentencesKey: '' };

function kbFile() {
  const dir = (config.kb && config.kb.dir || '').trim();
  return dir ? path.resolve(dir, 'records.jsonl') : CORPUS_FILE;
}

/** 加载语料记录（按文件 mtime 缓存；坏行跳过不炸） */
function loadKb() {
  const file = kbFile();
  if (!fs.existsSync(file)) { kbCache = { mtime: 0, records: [], sentences: null }; return []; }
  const mtime = fs.statSync(file).mtimeMs;
  if (kbCache.mtime !== mtime) {
    let records = [];
    try {
      records = fs.readFileSync(file, 'utf8').split('\n')
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(r => r && r.id && r.rtype);
    } catch { records = []; }
    kbCache = { mtime, records, sentences: null };
  }
  return kbCache.records;
}

/** 渲染排序（v1.1.1 模块化版）：不预设板块顺序，按语料自身顺序渲染；
 *  板块内仅保证题干（passage/writing）在前、题目按题号在后，题目跟随所属原文。 */
function kbOrderedItems(record) {
  const items = Array.isArray(record.items) ? [...record.items] : [];
  // 板块按首次出现顺序编号（数据即语义，不做全局重排）
  const secRank = new Map();
  for (const it of items) {
    const s = it.section || '';
    if (!secRank.has(s)) secRank.set(s, secRank.size);
  }
  // 板块内原文按首次出现编号，题目（passage_id）跟随所属原文
  const psgRank = new Map();
  for (const it of items) {
    if (it.type === 'passage' && it.passage_id != null && !psgRank.has(it.passage_id)) {
      psgRank.set(it.passage_id, psgRank.size);
    }
  }
  items.sort((a, b) => {
    const sr = (secRank.get(a.section || '') ?? 999) - (secRank.get(b.section || '') ?? 999);
    if (sr !== 0) return sr;
    const pr = ((a.passage_id != null && psgRank.has(a.passage_id)) ? psgRank.get(a.passage_id) : 9999)
             - ((b.passage_id != null && psgRank.has(b.passage_id)) ? psgRank.get(b.passage_id) : 9999);
    if (pr !== 0) return pr;
    const lead = x => (x.type === 'passage' || x.type === 'writing') ? 0 : 1;
    if (lead(a) !== lead(b)) return lead(a) - lead(b);
    return (a.number || 0) - (b.number || 0);
  });
  return items;
}

/** 句子级索引（懒构建，供搜索与 AI 真题语料注入）：去掉 〖N〗 标记后按句切分 */
function kbSentenceSplit(text) {
  return String(text || '')
    .replace(/〖\/?\d+〗/g, '')
    .split(/\n+/)
    .flatMap(par => par.split(/(?<=[.!?。！？])\s+/))
    .map(s => s.replace(/\s{2,}/g, ' ').trim())
    .filter(s => s.length >= 15);
}

function kbSentences() {
  // v1.1.2：索引覆盖语料库 + 真题库（真题原句在 exams.jsonl），任一文件变化即重建
  const key = `${fileMtime(kbFile())}|${fileMtime(examsFile())}`;
  if (kbCache.sentences && kbCache.sentencesKey === key) return kbCache.sentences;
  const out = [];
  for (const r of [...loadKb(), ...loadExams()]) {
    const year = r.meta?.year || null;
    const title = r.title || '';
    const items = Array.isArray(r.items) && r.items.length
      ? r.items
      : [{ type: 'passage', section: null, number: null, text: r.text || '' }];
    for (const it of items) {
      for (const s of kbSentenceSplit(it.text || '')) {
        out.push({ rid: r.id, title, year, section: it.section || null, number: it.number ?? null, s });
      }
    }
  }
  kbCache.sentences = out;
  kbCache.sentencesKey = key;
  return out;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 全库句子搜索。英文词组按词边界匹配（兼容少量词尾变化 -s/-ed/-ing），
 * 中文按包含匹配。返回 [{rid,title,year,section,number,s}]。
 */
function kbSearch(query, limit = 30) {
  const q = String(query || '').trim();
  if (!q || q.length > 100) return [];
  const lower = q.toLowerCase();
  const isAscii = /^[\x20-\x7e]+$/.test(q);
  const re = isAscii ? new RegExp(`\\b${escapeRegExp(q.toLowerCase())}(?:s|es|ed|d|ing)?\\b`, 'i') : null;
  const out = [];
  const seen = new Map();   // 同句去重（翻译原文与题干可能重复收录），优先保留带题号的来源
  for (const item of kbSentences()) {
    const hit = re ? re.test(item.s) : item.s.toLowerCase().includes(lower);
    if (!hit) continue;
    const key = item.s.toLowerCase();
    const prev = seen.get(key);
    if (prev === undefined) { seen.set(key, out.length); out.push(item); }
    else if (item.number != null && out[prev].number == null) out[prev] = item;
    if (out.length >= limit) break;
  }
  return out;
}

/** AI 真题语料注入：当前单词在真实考试语料里的句子（最多 4 条，带来源） */
function kbCorpusForWord(word, limit = 4) {
  const w = String(word || '').trim();
  if (!w || !/^[a-zA-Z][a-zA-Z'\-]{1,29}$/.test(w)) return [];
  return kbSearch(w, limit);
}

/** 记录摘要（列表页用，不含全文） */
function kbSummary(r) {
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    id: r.id,
    rtype: r.rtype,
    rtypeLabel: RTYPE_LABEL[r.rtype] || r.rtype,
    title: r.title || '(无标题)',
    year: r.meta?.year || null,
    questions: r.meta?.questions || items.filter(i => i.type === 'question').length || null,
    itemCount: items.length,
    sections: (r.meta?.sections || [...new Set(items.map(i => i.section).filter(Boolean))]) || [],
    source: r.source ? { file: r.source.file, parser: r.source.parser, imported_at: r.source.imported_at, category: r.source.category } : null,
    preview: String(r.text || (items[0] && items[0].text) || '').replace(/〖\/?\d+〗/g, '').slice(0, 90),
  };
}

/* ---------- v1.1.2：真题库（qa_set 分库到 exams.jsonl） ---------- */

const EXAM_TYPE_LABEL = {
  use_of_english: '考研-完形填空', reading: '考研-阅读理解', part_b: '考研-新题型',
  translation: '考研-翻译', writing: '考研-写作',
};

function examsFile() { return path.join(path.dirname(kbFile()), 'exams.jsonl'); }

let examCache = { mtime: 0, records: [] };

function readJsonlRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.id && r.rtype);
  } catch { return []; }
}

function fileMtime(file) { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }

function loadExams() {
  const file = examsFile();
  if (!fs.existsSync(file)) { examCache = { mtime: 0, records: [] }; return []; }
  const mtime = fileMtime(file);
  if (examCache.mtime !== mtime) examCache = { mtime, records: readJsonlRaw(file) };
  return examCache.records;
}

/** v1.1.2 迁移：records.jsonl 里残留的 qa_set 全部移到 exams.jsonl（幂等，可重复调用） */
function ensureKbSplit() {
  try {
    const file = kbFile();
    if (!fs.existsSync(file)) return { moved: 0 };
    const raw = fs.readFileSync(file, 'utf8').split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const qa = raw.filter(r => r.rtype === 'qa_set');
    if (!qa.length) return { moved: 0 };
    const rest = raw.filter(r => r.rtype !== 'qa_set');
    const efile = examsFile();
    const byId = new Map(readJsonlRaw(efile).map(r => [r.id, r]));
    for (const r of qa) if (!byId.has(r.id)) byId.set(r.id, r);
    const writeAtomic = (f, recs) => {
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, recs.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, f);
    };
    writeAtomic(efile, [...byId.values()]);
    writeAtomic(file, rest);
    kbCache = { mtime: 0, records: [], sentences: null, sentencesKey: '' };
    examCache = { mtime: 0, records: [] };
    kbLog({ time: new Date().toISOString().slice(0, 19), file: '(migration)', status: 'migrated', store: 'exam', records: qa.length });
    console.log(`[v1.1.2] 已迁移 ${qa.length} 条 qa_set 记录 -> exams.jsonl`);
    return { moved: qa.length };
  } catch (e) {
    console.error('kb split failed:', e.message);
    return { moved: 0, error: e.message };
  }
}

/** 真题记录摘要：按「考试-题型」板块统计（处理模块的服务端数据源） */
function examSummary(r) {
  const items = Array.isArray(r.items) ? r.items : [];
  const bySec = new Map();
  for (const it of items) {
    const s = it.section || 'misc';
    if (!bySec.has(s)) {
      bySec.set(s, { key: s, label: EXAM_TYPE_LABEL[s] || ('考研-' + (KB_SECTION_LABEL[s] || s)), questions: 0, passages: 0, writings: 0 });
    }
    const b = bySec.get(s);
    if (it.type === 'question') b.questions++;
    else if (it.type === 'passage') b.passages++;
    else if (it.type === 'writing') b.writings++;
  }
  return {
    id: r.id,
    rtype: r.rtype,
    rtypeLabel: RTYPE_LABEL[r.rtype] || r.rtype,
    title: r.title || '(无标题)',
    year: r.meta?.year || null,
    questions: r.meta?.questions || items.filter(i => i.type === 'question').length || null,
    sections: [...bySec.values()],
    source: r.source ? { file: r.source.file, parser: r.source.parser, imported_at: r.source.imported_at, category: r.source.category } : null,
    preview: String(r.text || (items[0] && items[0].text) || '').replace(/〖\/?\d+〗/g, '').slice(0, 90),
  };
}

/* ================= v1.1.5：单元题库（整卷切片视图 + 分题型生题规则） ================= */

/* 单元 = 整卷数据的切片视图（数据零迁移）：板块为切片键，阅读按 passage_id 分篇、写作按 Part。
   每个单元的「生题规则」由 section 决定，前端按 UNIT_PRACTICE 规则渲染成真实做题形态：
   完形=原文挖空内联选词 / 阅读=Text+逐题单选 / 新题型=空位+选项池 / 翻译=划线句+译文框 / 写作=题干+作文框。
   标准答案存 data/answers.json（人工录入权威答案，绝不由 LLM 生成）。 */

const UNIT_SECTIONS = {
  use_of_english: '完形填空',
  reading: '阅读理解',
  part_b: '新题型',
  translation: '翻译',
  writing: '写作',
};

const ANSWERS_FILE = path.join(DATA_DIR, 'answers.json');   // { unitId: { 题号: 'A' } }

function loadAnswers() { return loadJSON(ANSWERS_FILE, {}); }

function saveAnswers(a) { saveJSON(ANSWERS_FILE, a); }

let unitCache = { mtime: 0, units: [] };

/** 整卷 -> 单元切片（懒构建，mtime 缓存；整卷导入/编辑/删除后自动重建） */
function buildUnits() {
  const mtime = fileMtime(examsFile());
  if (unitCache.mtime === mtime && unitCache.units.length) return unitCache.units;
  const units = [];
  for (const rec of loadExams()) {
    const items = Array.isArray(rec.items) ? rec.items : [];
    const year = rec.meta?.year || null;
    const groups = [];
    const gkey = it => {
      if (it.section === 'reading') return 'reading~' + (it.passage_id ?? 0);
      if (it.section === 'writing') return 'writing~' + (it.part || 'A');
      return (it.section || 'misc') + '~0';
    };
    items.forEach((it, i) => {
      const k = gkey(it);
      let g = groups.find(x => x.key === k);
      if (!g) { g = { key: k, section: it.section || 'misc', passageId: it.passage_id ?? null, part: it.part || null, idx: [] }; groups.push(g); }
      g.idx.push(i);
    });
    for (const g of groups) {
      const secName = UNIT_SECTIONS[g.section] || (g.section === 'misc' ? '其他' : g.section);
      let title = `考研-${secName}-${year ? year + '年' : rec.title}`;
      if (g.section === 'reading') title += `-第${g.passageId || '?'}篇`;
      if (g.section === 'writing') title += `-Part ${g.part || 'A'}`;
      const gitems = g.idx.map(i => items[i]);
      const qs = gitems.filter(it => it.type === 'question');
      units.push({
        unitId: `${rec.id}~${g.key}`,
        examId: rec.id,
        year,
        section: g.section,
        label: '考研-' + secName,
        title,
        itemCount: gitems.length,
        qCount: qs.length,
        scored: qs.length > 0 && qs.every(it => it.options && Object.keys(it.options).length >= 2),
        firstNum: qs[0]?.number ?? null,
        lastNum: qs[qs.length - 1]?.number ?? null,
        preview: String(gitems.find(it => it.type === 'passage' || it.type === 'writing')?.text || '').replace(/〖\/\d+〗/g, '').replace(/〖\d+〗/g, ' ').slice(0, 80),
      });
    }
  }
  units.sort((a, b) => (b.year || 0) - (a.year || 0) || (a.unitId < b.unitId ? -1 : 1));
  unitCache = { mtime, units };
  return units;
}

function findUnit(unitId) {
  return buildUnits().find(u => u.unitId === unitId) || null;
}

/** 单元的原始条目切片（保持整卷内原始顺序：题干在前、题目按号） */
function unitItems(unitId) {
  const unit = findUnit(unitId);
  if (!unit) return null;
  const rec = loadExams().find(x => x.id === unit.examId);
  if (!rec) return null;
  const items = Array.isArray(rec.items) ? rec.items : [];
  const key = unitId.slice(unitId.indexOf('~') + 1);
  const gkey = it => {
    if (it.section === 'reading') return 'reading~' + (it.passage_id ?? 0);
    if (it.section === 'writing') return 'writing~' + (it.part || 'A');
    return (it.section || 'misc') + '~0';
  };
  return { unit, rec, items: items.map((it, i) => ({ it, i })).filter(x => gkey(x.it) === key).map(x => x.it) };
}

/* ---------- v1.1.1：语料导入（投放 -> 解析 -> 归档/隔离 + 日志） ---------- */
/* 目录契约（相对 records.jsonl 所在目录，参照《导入解析-经验总结.md》）：
   imports/<分类>/   投放区（上传先落这里）
   archive/<分类>/   原件层（解析成功后归档，不可变）
   quarantine/       识别失败隔离区，绝不静默丢弃
   import_log.jsonl  流水：每次导入/隔离都有痕迹
   去重：以源文件名为键，同名重导覆盖旧记录（replace-by-source）。 */

const KB_CATEGORIES = ['真题', '外刊', '教材', '直录'];
const KB_IMPORT_MAX = 30 * 1024 * 1024;   // 单文件上限 30MB

function kbBaseDir() { return path.dirname(kbFile()); }

function kbDir(...segs) {
  const dir = path.join(kbBaseDir(), ...segs);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function kbLog(entry) {
  try {
    fs.appendFileSync(path.join(kbBaseDir(), 'import_log.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* 日志失败不影响导入主流程 */ }
}

function kbSafeName(name) {
  const s = path.basename(String(name || '')).replace(/[\\/:*?"<>|\u0000]/g, '_').trim();
  return s && s !== '.' && s !== '..' ? s.slice(0, 120) : '';
}

/** 文本解码：UTF-8 优先，替换符过多时回退 GBK（中文 txt 常见） */
function kbDecode(buf) {
  const s = buf.toString('utf8');
  if ((s.match(/\uFFFD/g) || []).length > s.length * 0.01) {
    try { return new TextDecoder('gbk').decode(buf); } catch { /* 无 GBK 支持则原样返回 */ }
  }
  return s;
}

function kbEntities(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
}

/** HTML -> 纯文本（去 script/style 等噪声块，块级标签转换行） */
function kbParseHtml(raw) {
  const tm = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? kbEntities(tm[1]).replace(/\s+/g, ' ').trim() : null;
  const text = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return {
    title: title || null,
    text: kbEntities(text).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim(),
  };
}

/** 最小 zip 读取（走中央目录）：返回指定条目的解压内容，找不到返回 null */
function kbUnzipEntry(buf, wantName) {
  let i = buf.length - 22;
  for (; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) break;
  }
  if (i < 0) return null;
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === wantName) {
      const lnLen = buf.readUInt16LE(lho + 26);
      const leLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnLen + leLen;
      const data = buf.slice(start, start + csize);
      return method === 0 ? data : require('zlib').inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

/** docx -> 纯文本（word/document.xml，零依赖） */
function kbParseDocx(buf) {
  const xml = kbUnzipEntry(buf, 'word/document.xml');
  if (!xml) throw Object.assign(new Error('docx 缺少 word/document.xml（不是有效的 .docx？）'), { code: 'KB_IMPORT' });
  return kbEntities(xml.toString('utf8')
    .replace(/<w:tab[^>]*\/?>/g, '\t')
    .replace(/<w:br[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

let kbPyCmd = { tried: false, cmd: null };

/** 探测可用的 Python（TeX/PDF 适配器需要；可在 config.kb.pythonPath 指定路径） */
function kbPython() {
  if (kbPyCmd.tried) return kbPyCmd.cmd;
  kbPyCmd.tried = true;
  const list = [];
  if (config.kb && config.kb.pythonPath) list.push(config.kb.pythonPath);
  list.push(...(process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']));
  for (const cmd of list) {
    try {
      const r = spawnSync(cmd, ['-c', 'print(1)'], { timeout: 8000 });
      if (r.status === 0) { kbPyCmd.cmd = cmd; break; }
    } catch { /* 下一个候选 */ }
  }
  return kbPyCmd.cmd;
}

/** 调 corpus_tools/import_cli.py 解析 TeX/PDF（单文件 -> JSON 记录） */
function kbParseWithPython(fmt, file) {
  return new Promise(resolve => {
    const cmd = kbPython();
    if (!cmd) {
      return resolve({
        ok: false,
        reason: '未找到可用的 Python（TeX/PDF 解析需要）',
        hint: '可在 data/config.json 里配置 kb.pythonPath；或改用 TXT/MD/HTML/DOCX 源（无需 Python）',
      });
    }
    const p = spawn(cmd, ['-X', 'utf8', path.join(ROOT, 'corpus_tools', 'import_cli.py'), fmt, file], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => resolve({ ok: false, reason: 'Python 启动失败: ' + e.message }));
    p.on('close', () => {
      const s = out.trim();
      try { resolve(JSON.parse(s)); return; } catch { /* 尝试最后一行 */ }
      try { resolve(JSON.parse(s.split('\n').pop())); return; } catch { /* 放弃 */ }
      resolve({ ok: false, reason: (err || '解析器无输出（可能缺少依赖）').slice(0, 300) });
    });
  });
}

/** 分库写入：store=exam -> exams.jsonl（真题）；store=corpus -> records.jsonl（语料） */
function kbMergeStore(store, records) {
  const file = store === 'exam' ? examsFile() : kbFile();
  const byKey = new Map();
  for (const r of readJsonlRaw(file)) byKey.set(r.source && r.source.file ? r.source.file : '\u0000id:' + r.id, r);
  for (const r of records) byKey.set(r.source.file, r);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, [...byKey.values()].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 单文件导入全流程：投放 -> 解析 -> 分库写库（同名覆盖）+ 归档，失败 -> 隔离 + 日志 */
async function kbImportOne({ name, buf, category, store = 'corpus', parserTag = null }) {
  const safe = kbSafeName(name);
  if (!safe) throw Object.assign(new Error('文件名无效'), { code: 'KB_IMPORT' });
  if (!buf || !buf.length) throw Object.assign(new Error('文件内容为空'), { code: 'KB_IMPORT' });
  const srcPath = path.join(kbDir('imports', category), safe);
  fs.writeFileSync(srcPath, buf);
  const ext = path.extname(safe).toLowerCase();
  const now = new Date().toISOString().slice(0, 19);
  let parsed, parser = null;
  try {
    if (store === 'exam' && ext !== '.tex' && ext !== '.pdf') {
      parsed = { ok: false, reason: `真题库仅支持 tex / pdf 结构化源（收到 ${ext || '无扩展名'}）`, hint: '文章、笔记类内容请到「📚 语料库」导入' };
    } else if (ext === '.txt' || ext === '.md' || ext === '') {
      const text = kbDecode(buf);
      const m = text.match(/^#\s+(.+)$/m);
      parser = parserTag || 'plain-text';   // v1.1.4：MinerU 通道传入 'mineru-api' 保留来源标记
      parsed = { ok: true, records: [{ rtype: 'note', title: m ? m[1].trim() : safe, text, meta: { chars: text.length } }] };
    } else if (ext === '.html' || ext === '.htm') {
      const { title, text } = kbParseHtml(kbDecode(buf));
      if (!text) throw new Error('HTML 正文为空');
      parser = 'html-strip';
      parsed = { ok: true, records: [{ rtype: 'article', title: title || safe, text, meta: { chars: text.length } }] };
    } else if (ext === '.docx') {
      const text = kbParseDocx(buf);
      if (!text) throw new Error('docx 正文为空');
      parser = 'docx-zip';
      parsed = { ok: true, records: [{ rtype: 'document', title: safe.replace(/\.docx$/i, ''), text, meta: { chars: text.length } }] };
    } else if (ext === '.tex' || ext === '.pdf') {
      if (store === 'corpus') {
        parsed = { ok: false, reason: 'tex / pdf 是真题结构化源，不属于语料库', hint: '请到「🗂 真题库」板块导入（自动拆题入库）' };
      } else {
        parsed = await kbParseWithPython(ext.slice(1), srcPath);
        if (parsed.ok) parser = parsed.parser || ext.slice(1) + '-adapter';
      }
    } else {
      parsed = { ok: false, reason: `不支持的类型 ${ext || '(无扩展名)'}，支持：txt/md/html/htm/docx` };
    }
  } catch (e) {
    parsed = { ok: false, reason: e.message };
  }

  if (!parsed.ok) {
    // 隔离区：识别失败绝不静默丢弃
    const q = path.join(kbDir('quarantine'), safe);
    if (fs.existsSync(q)) fs.rmSync(q);
    fs.renameSync(srcPath, q);
    kbLog({ time: now, file: safe, category, store, status: 'quarantined', reason: String(parsed.reason || '').slice(0, 200) });
    return { ok: false, file: safe, reason: parsed.reason || '解析失败', hint: parsed.hint || null, store };
  }

  // replace-by-source：同名重导覆盖旧记录；v1.1.2 分库——qa_set -> exams.jsonl，
  // 其余（真题拆题失败的整卷文档即「真题正文」）-> records.jsonl
  parsed.records.forEach((r, i) => {
    if (!r.id) r.id = crypto.createHash('sha1').update([safe, parser, i, r.title || ''].join('|')).digest('hex').slice(0, 12);
    r.source = { file: safe, category, parser, imported_at: now };
    if (!r.title) r.title = safe;
  });
  const toExam = parsed.records.filter(r => r.rtype === 'qa_set');
  const toCorpus = parsed.records.filter(r => r.rtype !== 'qa_set');
  if (toExam.length) kbMergeStore('exam', toExam);
  if (toCorpus.length) kbMergeStore('corpus', toCorpus);
  const storeTag = [toExam.length ? 'exam' : '', toCorpus.length ? 'corpus' : ''].filter(Boolean).join('+');
  // 原件归档（重导覆盖旧归档）
  const dest = path.join(kbDir('archive', category), safe);
  if (fs.existsSync(dest)) fs.rmSync(dest);
  fs.renameSync(srcPath, dest);
  kbLog({ time: now, file: safe, category, store: storeTag, status: 'imported', parser, records: parsed.records.length });
  return {
    ok: true, file: safe, parser, store: storeTag,
    records: parsed.records.length,
    rtypes: parsed.records.map(r => RTYPE_LABEL[r.rtype] || r.rtype),
  };
}

/* ================= v1.1.4：MinerU 精准解析 + 记录编辑/删除 + AI 审读 ================= */

const MINERU_BASE = 'https://mineru.net/api/v4';

/** mock 模式的样例 Markdown（验证 上传->云端->入库 全链路，不调外网） */
function mineruMockMd(name) {
  const blanks = Array.from({ length: 20 }, (_, i) => `〖${i + 1}〗`).join(' ');
  return [
    '# ' + String(name).replace(/\.pdf$/i, '') + '（MinerU mock 解析）',
    '',
    'Section I Use of English',
    '',
    'Directions: Read the following text. Choose the best word for each numbered blank and mark the answer sheet.',
    '',
    'The standard of education in a country is closely related to its economic growth, and the debate over how to improve it has lasted for decades. ' + blanks,
    '',
    'This mock markdown verifies the v1.1.4 MinerU pipeline: upload -> cloud parse -> text record -> corpus.',
  ].join('\n');
}

/**
 * MinerU 标准 API v4 解析 PDF -> Markdown。
 * 英语特化调参：language=en（英文 OCR 模型）、enable_formula=false（考研英语无公式）、
 * enable_table=false（真题无表格）、is_ocr 按前端勾选（扫描件强制 OCR）。
 * 流程：申请上传链接(batch) -> PUT 文件 -> 轮询 batch 结果 -> 下载 ZIP 取 full.md。
 * 说明：端点/字段按官方 v4 文档实现，若官方字段有出入只需改本函数一处。
 */
async function mineruParsePdf(buf, filename, isOcr) {
  if (!config.mineru.apiKey) {
    throw Object.assign(new Error('未配置 MinerU Token，请到「设置」页填写（mineru.net/apiManage/token 免费申请）'), { code: 'NO_MINERU' });
  }
  const auth = { 'Authorization': 'Bearer ' + config.mineru.apiKey };
  const apply = await fetch(MINERU_BASE + '/file-urls/batch', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'pipeline',          // 无幻觉管线（英语场景不需要 VLM 后端）
      language: 'en',             // 特化：英文 OCR
      enable_formula: false,      // 特化：考研英语无公式
      enable_table: false,        // 特化：真题无表格
      files: [{ name: filename, is_ocr: !!isOcr }],
    }),
  });
  if (apply.status === 401) {
    throw Object.assign(new Error('MinerU Token 无效或已过期（约 90 天需更换），请到 mineru.net/apiManage/token 重新生成'), { code: 'NO_MINERU' });
  }
  if (!apply.ok) {
    const t = await apply.text().catch(() => '');
    throw new Error(`MinerU 申请上传链接失败 (HTTP ${apply.status}) ${t.slice(0, 200)}`);
  }
  const aj = await apply.json();
  const batchId = aj?.data?.batch_id;
  const putUrl = aj?.data?.file_urls?.[0];
  if (!batchId || !putUrl) throw new Error('MinerU 返回异常: ' + JSON.stringify(aj).slice(0, 200));
  // 实测坑（v1.1.4a）：presigned URL 按「无 Content-Type」签名——PUT 带任何 Content-Type 都会 403 SignatureDoesNotMatch
  // （curl --data-binary 会默认自动加 x-www-form-urlencoded，必须 -T 裸传或显式清空才能成功）
  const put = await fetch(putUrl, { method: 'PUT', body: buf });
  if (!put.ok) {
    const t = await put.text().catch(() => '');
    throw new Error('MinerU 文件上传失败 (HTTP ' + put.status + ') ' + t.slice(0, 200));
  }
  let zipUrl = null;
  for (let i = 0; i < 80; i++) {   // 3s 间隔最长 4 分钟（留余量避开 5 分钟请求超时）
    await new Promise(s => setTimeout(s, 3000));
    try {
      const pr = await fetch(`${MINERU_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`, { headers: auth });
      if (!pr.ok) continue;
      const pj = await pr.json();
      const one = pj?.data?.extract_result?.[0];
      if (!one) continue;
      if (one.state === 'done' && one.full_zip_url) { zipUrl = one.full_zip_url; break; }
      if (one.state === 'failed') throw new Error('MinerU 解析失败: ' + String(one.err_msg || '未知原因').slice(0, 200));
    } catch (e) { if (String(e.message).startsWith('MinerU 解析失败')) throw e; }
  }
  if (!zipUrl) throw new Error('MinerU 解析超时（4 分钟），请稍后重试或改用本地导入');
  const zr = await fetch(zipUrl);
  if (!zr.ok) throw new Error('MinerU 结果下载失败 (HTTP ' + zr.status + ')');
  const zbuf = Buffer.from(await zr.arrayBuffer());
  const md = kbUnzipEntry(zbuf, 'full.md');
  if (!md) throw new Error('MinerU 结果包中未找到 full.md');
  return md.toString('utf8');
}

/** v1.1.4：按 id 定位记录所在库（真题库优先） */
function kbFindStoreOf(id) {
  if (loadExams().some(r => r.id === id)) return 'exam';
  if (loadKb().some(r => r.id === id)) return 'corpus';
  return null;
}

/** v1.1.4：按 id 原子改写单条记录（mutator 返回 null = 删除该行）；坏行原样保留 */
function kbMutateStore(store, id, mutator) {
  const file = store === 'exam' ? examsFile() : kbFile();
  if (!fs.existsSync(file)) return { ok: false, reason: '库文件不存在' };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let hit = null;
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj = null;
    try { obj = JSON.parse(line); } catch { out.push(line); continue; }
    if (!hit && obj && obj.id === id) {
      hit = obj;
      const r = mutator(obj);
      if (r) out.push(JSON.stringify(r));
      continue;
    }
    out.push(line);
  }
  if (!hit) return { ok: false, reason: '记录不存在：' + id };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, title: hit.title || hit.id, rtype: hit.rtype };
}

/** 粘贴直录：内容写为 txt 投放，走同一条导入管线（有归档、有日志） */
async function kbImportPaste({ title, text, category }) {
  const t = String(text || '');
  if (!t.trim()) throw Object.assign(new Error('粘贴内容为空'), { code: 'KB_IMPORT' });
  if (t.length > 2e6) throw Object.assign(new Error('粘贴内容过长（上限 200 万字符）'), { code: 'KB_IMPORT' });
  const base = kbSafeName(title) || ('直录-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, ''));
  return kbImportOne({ name: base + '.txt', buf: Buffer.from(t, 'utf8'), category });
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
  // v1.1.0：禁缓存（经验总结坑 #3）——前端改完立刻可见，杜绝"白排查半天"
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, max = 5e6) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      if (buf.length > max) {
        // v1.1.3：超限带 code 走统一错误映射（413）；resume() 排空剩余数据，连接可正常收尾
        req.resume();
        const e = new Error('请求体超过 ' + Math.round(max / 1e6) + 'MB 上限，请拆分文件');
        e.code = 'BODY_TOO_LARGE';
        reject(e);
      }
    });
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
          dict: {
            hasLearners: !!config.dict.learnersKey,
            hasCollegiate: !!config.dict.collegiateKey,
          },
          mineru: {
            hasKey: !!config.mineru.apiKey,
            mock: !!config.mineru.mock,
          },
          review: {
            providerId: (config.review && config.review.providerId) || '',
            model: (config.review && config.review.model) || '',
            thinking: !!(config.review && config.review.thinking),
          },
          kb: {
            dir: (config.kb && config.kb.dir) || '',
            pythonPath: (config.kb && config.kb.pythonPath) || '',
            categories: KB_CATEGORIES,
            file: kbFile(),
            exists: fs.existsSync(kbFile()),
            count: loadKb().length,
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
        // v1.0.8：韦氏词典双 Key（留空 = 沿用已存）
        if (body.dict && typeof body.dict === 'object') {
          const oldD = config.dict || {};
          config.dict = {
            learnersKey: (typeof body.dict.learnersKey === 'string' && body.dict.learnersKey.trim())
              ? body.dict.learnersKey.trim() : (oldD.learnersKey || ''),
            collegiateKey: (typeof body.dict.collegiateKey === 'string' && body.dict.collegiateKey.trim())
              ? body.dict.collegiateKey.trim() : (oldD.collegiateKey || ''),
          };
        }
        // v1.1.4：MinerU 解析服务（Token 留空 = 沿用已存）
        if (body.mineru && typeof body.mineru === 'object') {
          if (!config.mineru || typeof config.mineru !== 'object') config.mineru = { apiKey: '', mock: false };
          if (typeof body.mineru.apiKey === 'string' && body.mineru.apiKey.trim()) config.mineru.apiKey = body.mineru.apiKey.trim();
          if (body.mineru.mock != null) config.mineru.mock = !!body.mineru.mock;
        }
        // v1.1.7：AI 审核专用服务商配置持久化
        if (body.review && typeof body.review === 'object') {
          if (!config.review) config.review = { providerId: '', model: '', thinking: false };
          if (body.review.providerId !== undefined) config.review.providerId = String(body.review.providerId || '').trim();
          if (body.review.model !== undefined) config.review.model = String(body.review.model || '').trim();
          if (body.review.thinking !== undefined) config.review.thinking = !!body.review.thinking;
        }
        // v1.1.0：语料库数据源目录（留空 = 用仓库内 corpus/）
        if (body.kb && typeof body.kb === 'object' && typeof body.kb.dir === 'string') {
          if (!config.kb || typeof config.kb !== 'object') config.kb = { dir: '', pythonPath: '' };
          config.kb.dir = body.kb.dir.trim();
          if (typeof body.kb.pythonPath === 'string') config.kb.pythonPath = body.kb.pythonPath.trim();
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

      // 单词详情（含本地助记 + 韦氏词典缓存）
      if (p === '/api/word' && req.method === 'GET') {
        const sp = u.searchParams.get('spelling');
        const w = Object.values(db.words).find(x => x.spelling === sp) || null;
        const notes = db.notes.filter(n => n.spelling === sp);
        const sessions = db.sessions.filter(s => s.words?.includes(sp)).slice(0, 5);
        return sendJSON(res, 200, { word: w, notes, sessions, dict: dictCached(sp) });
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

        // v1.0.8：韦氏词典权威参考——释义/例句/同义词/词源注入，AI 只负责讲解不再编造事实
        if (spelling) {
          try {
            const entry = await dictLookup(spelling);
            if (entry?.found) {
              const parts = [`释义: ${entry.defs.join('；')}`];
              if (entry.examples.length) parts.push(`例句: ${entry.examples.join(' / ')}`);
              if (entry.synonyms.length) parts.push(`同义词: ${entry.synonyms.join(', ')}`);
              if (entry.etymology) parts.push(`词源: ${entry.etymology}`);
              msgs[0].content += `\n\n【韦氏词典权威参考（${entry.source}）】\n${parts.join('\n')}` +
                '\n讲解以上述权威释义为准（词义/例句/搭配不得与之冲突），但需用中文通俗讲解；词源可用于词根词缀记忆。';
            } else if (entry?.suggestions?.length) {
              msgs[0].content += `\n\n（韦氏词典未直接收录「${spelling}」，近似词条：${entry.suggestions.join('、')}。若学习者想查的是这些词形之一，请先提示确认。）`;
            }
          } catch { /* 词典未配置或网络失败：不阻塞对话 */ }
        }

        // v1.1.0：真题语料注入——当前单词在真实考试原句中的用法（带来源），例句优先引用、不再现编
        if (spelling) {
          try {
            const hits = kbCorpusForWord(spelling);
            if (hits.length) {
              const lines = hits.map(h => {
                const src = [h.title, h.year ? h.year + ' 年' : '', KB_SECTION_LABEL[h.section] || h.section || '', h.number ? '第 ' + h.number + ' 题' : '']
                  .filter(Boolean).join(' · ');
                return `- ${h.s}\n  （来源：${src}）`;
              });
              msgs[0].content += '\n\n【真题语料：真实考试原句】\n' + lines.join('\n') +
                '\n讲解时优先引用以上真实语料并注明来源（考研最考什么就讲什么）；真题未覆盖的义项再用你自己的例句补充。';
            }
          } catch { /* 语料库不可用不阻塞对话 */ }
        }

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

      // 韦氏词典查询（v1.0.8）：缓存优先，双 key 并行合并
      if (p === '/api/dict/lookup' && req.method === 'GET') {
        const entry = await dictLookup(u.searchParams.get('word') || '');
        return sendJSON(res, 200, { ok: true, entry });
      }

      // 韦氏词典连通性测试（v1.0.8）
      if (p === '/api/test/dict' && req.method === 'POST') {
        const entry = await dictLookup('resilient');
        if (!entry.found) {
          return sendJSON(res, 200, { ok: true, msg: `Key 可用，但「resilient」未收录。近似词：${(entry.suggestions || []).join('、') || '无'}` });
        }
        const bits = [`「${entry.headword}」${entry.pos}`, entry.def, `来源 ${entry.source}`];
        if (entry.audio) bits.push('真人发音 ✓');
        if (entry.etymology) bits.push('词源 ✓');
        return sendJSON(res, 200, { ok: true, msg: `查询成功！${bits.join(' · ')}` });
      }

      /* ---- 题库 / 语料库（v1.1.0） ---- */

      // 记录列表（摘要，不含全文）
      if (p === '/api/kb/records' && req.method === 'GET') {
        const records = loadKb();
        return sendJSON(res, 200, {
          ok: true,
          file: kbFile(),
          exists: fs.existsSync(kbFile()),
          records: records.map(kbSummary),
        });
      }

      // 记录详情（全文 + 渲染排序后的 items：题干在前、题目按题号，不重排板块）
      {
        const m = p.match(/^\/api\/kb\/record\/([0-9a-f]+)$/);
        if (m && req.method === 'GET') {
          // v1.1.7a 修复：编辑器加载原始记录走本接口，真题 id 在 exams.jsonl——
          // v1.1.2 分库后此处漏改单库查找，导致真题点「编辑」报「记录不存在」。
          // 改为双库查找（真题优先，与 kbFindStoreOf 一致），语料/真题编辑均恢复。
          const r = loadExams().find(x => x.id === m[1]) || loadKb().find(x => x.id === m[1]);
          if (!r) return sendJSON(res, 404, { error: '记录不存在' });
          return sendJSON(res, 200, {
            ok: true,
            record: { ...r, rtypeLabel: RTYPE_LABEL[r.rtype] || r.rtype, items: u.searchParams.get('raw') === '1' ? (r.items || []) : kbOrderedItems(r) },
          });
        }
      }

      // 全库句子搜索（题库 + 语料）
      if (p === '/api/kb/search' && req.method === 'GET') {
        const q = u.searchParams.get('q') || '';
        const results = kbSearch(q, 40);
        return sendJSON(res, 200, { ok: true, query: q, count: results.length, results });
      }

      /* ---------------- v1.1.4：MinerU 云端解析 + 记录编辑/删除 + AI 审读 ---------------- */

      // MinerU 解析：PDF -> 云端 Markdown -> 文本记录入库（扫描件/复杂版面专用通道）
      if (p === '/api/mineru/parse' && req.method === 'POST') {
        const body = await readBody(req, 60e6);
        const it = (Array.isArray(body.items) ? body.items : [])[0];
        if (!it || typeof it.name !== 'string' || typeof it.data64 !== 'string') {
          return sendJSON(res, 400, { error: '缺少文件（name + data64）', code: 'KB_IMPORT' });
        }
        const safe = kbSafeName(it.name);
        if (!safe || !/\.pdf$/i.test(safe)) return sendJSON(res, 400, { error: 'MinerU 通道目前只收 PDF 文件', code: 'KB_IMPORT' });
        let buf;
        try { buf = Buffer.from(it.data64, 'base64'); } catch { return sendJSON(res, 400, { error: 'base64 解码失败', code: 'KB_IMPORT' }); }
        let md;
        if (config.mineru.mock) {
          md = mineruMockMd(safe);   // mock 放在 Token 校验之前（经验总结坑：mock 分支要能进）
        } else {
          md = await mineruParsePdf(buf, safe, !!body.ocr);
        }
        const base = safe.replace(/\.pdf$/i, '');
        const r = await kbImportOne({
          name: base + '.md',
          buf: Buffer.from(md, 'utf8'),
          category: KB_CATEGORIES.includes(body.category) ? body.category : '真题',
          store: 'corpus',
          parserTag: 'mineru-api',
        });
        return sendJSON(res, 200, { ok: true, mineru: true, ...r });
      }

      // MinerU 连通性测试（401=Token 失效；400=参数错但 Token 有效，均视为可达）
      if (p === '/api/test/mineru' && req.method === 'POST') {
        if (config.mineru.mock) return sendJSON(res, 200, { ok: true, msg: 'mock 模式：MinerU 链路可用（未调云端）' });
        if (!config.mineru.apiKey) {
          return sendJSON(res, 400, { error: '未配置 MinerU Token，请到「设置」页填写（mineru.net/apiManage/token 免费申请）', code: 'NO_MINERU' });
        }
        const tr = await fetch(MINERU_BASE + '/file-urls/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.mineru.apiKey },
          body: JSON.stringify({ files: [] }),
        });
        if (tr.status === 401) {
          throw new Error('MinerU Token 无效或已过期（约 90 天需更换），请到 mineru.net/apiManage/token 重新生成');
        }
        if (!tr.ok && tr.status !== 400) {
          const t = await tr.text().catch(() => '');
          throw new Error(`MinerU API 请求失败 (HTTP ${tr.status}) ${t.slice(0, 200)}`);
        }
        return sendJSON(res, 200, { ok: true, msg: 'MinerU API 连接成功（Token 有效）' });
      }

      // 记录编辑（title/text/items 合并式更新；items 数组整体替换，删条目 = 数组里去掉）
      if (p === '/api/kb/record/update' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) return sendJSON(res, 400, { error: '缺少 id', code: 'KB_IMPORT' });
        const store = body.store || kbFindStoreOf(body.id);
        if (!store) return sendJSON(res, 404, { error: '记录不存在：' + body.id });
        const cleanText = s => String(s ?? '').slice(0, 2e6);
        const r = kbMutateStore(store, body.id, rec => {
          if (typeof body.title === 'string' && body.title.trim()) rec.title = body.title.trim().slice(0, 200);
          if (typeof body.text === 'string') rec.text = cleanText(body.text);
          if (Array.isArray(body.items)) {
            rec.items = body.items.slice(0, 300).map(it => {
              const o = { type: String(it.type || 'question'), section: it.section ?? null };
              if (it.number != null) o.number = it.number;
              if (it.text != null) o.text = cleanText(it.text);
              if (it.passage_id != null) o.passage_id = it.passage_id;
              if (it.options && typeof it.options === 'object') o.options = it.options;
              if (it.qtype) o.qtype = String(it.qtype).slice(0, 20);
              if (it.score != null) o.score = it.score;
              if (it.part) o.part = String(it.part).slice(0, 4);
              if (it.answer != null) o.answer = cleanText(it.answer).slice(0, 200);
              return o;
            });
          }
          rec.edited_at = new Date().toISOString().slice(0, 19);   // 编辑留痕（审核溯源用）
          return rec;
        });
        if (!r.ok) return sendJSON(res, r.reason.includes('不存在') ? 404 : 400, { error: r.reason });
        kbLog({ time: new Date().toISOString().slice(0, 19), file: '(edit)', status: 'updated', store, records: 1, reason: String(r.title).slice(0, 80) });
        return sendJSON(res, 200, { ok: true, title: r.title, edited_at: 'saved' });
      }

      // 记录删除（解析原件仍保留在 archive/，可重导恢复；删除写日志）
      if (p === '/api/kb/record/delete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) return sendJSON(res, 400, { error: '缺少 id', code: 'KB_IMPORT' });
        const store = body.store || kbFindStoreOf(body.id);
        if (!store) return sendJSON(res, 404, { error: '记录不存在：' + body.id });
        const r = kbMutateStore(store, body.id, () => null);
        if (!r.ok) return sendJSON(res, r.reason.includes('不存在') ? 404 : 400, { error: r.reason });
        kbLog({ time: new Date().toISOString().slice(0, 19), file: '(delete)', status: 'deleted', store, records: 1, reason: String(r.title).slice(0, 80) });
        return sendJSON(res, 200, { ok: true, title: r.title });
      }

      // AI 审读（建议者，不是提交者：只出疑点清单，不改任何数据）
      if (p === '/api/kb/review' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) return sendJSON(res, 400, { error: '缺少 id', code: 'KB_IMPORT' });
        const store = body.store || kbFindStoreOf(body.id);
        if (!store) return sendJSON(res, 404, { error: '记录不存在：' + body.id });
        const rec = (store === 'exam' ? loadExams() : loadKb()).find(x => x.id === body.id);
        if (!rec) return sendJSON(res, 404, { error: '记录不存在' });
        /* v1.1.6 修复审核数据源：旧版材料按每条 260 字符截断 + 全局 9000 字符截断 + 抹除 〖N〗 锚点 +
           原始顺序，LLM 把「送审材料自身残缺」当成语料问题报告（即实测中的假问题）。
           现在材料 = 与页面展示一致的渲染视图：kbOrderedItems 排序 + 每条完整文本 + 保留 〖N〗 锚点 +
           稳定定位符【条目#N】，并附 archive/ 真题原件（文本类）作比对参考。 */
        const ordered = kbOrderedItems(rec);
        const parts = ordered.map((it, i) => {
          const tag = `${it.type || 'item'}${it.section ? '·' + it.section : ''}${it.number != null ? '·题' + it.number : ''}`;
          return `【条目#${i + 1}｜${tag}】\n${String(it.text || '')}`;
        });
        const LIMIT = 60000;
        let material = parts.length
          ? parts.join('\n\n')
          : `【整理后的题库内容】（纯文本记录，无结构化条目）\n${String(rec.text || '')}`;
        const totalChars = material.length;
        let truncated = false;
        if (totalChars > LIMIT) { material = material.slice(0, LIMIT) + '\n…（超长截断，超出部分未送审）'; truncated = true; }
        let refNote = '';
        try {
          const origPath = rec.source?.file ? path.join(kbBaseDir(), 'archive', rec.source.category || '', rec.source.file) : null;
          if (origPath && fs.existsSync(origPath) && /\.(tex|txt|md|html?|htm)$/i.test(origPath)) {
            const orig = fs.readFileSync(origPath, 'utf8');
            refNote = `\n\n【真题原件参考】（${rec.source.file}，仅用于比对，不是整理结果）\n${orig.slice(0, 20000)}`;
          }
        } catch { /* 原件读取失败不影响审读 */ }
        const reply = await llmChat([
          { role: 'system', content: [
            '你是考研英语真题语料的质检审读员。审核对象是【整理后的题库内容】（与审核人员在页面上看到的完全一致，含 〖N〗 挖空/划线锚点）和可选的【真题原件参考】。',
            '对照找出解析/整理引入的问题，例如：句子残缺或截断、乱码与字形损坏、题号断档或重复、选项丢失或错位、段落错序、页眉页脚水印混入、明显重复段落、整理结果与原件不符。',
            '重要规则：',
            '1. 只报告有把握、能在材料中定位的问题；不要把送审材料自身的完整性当成语料问题；不要臆测内容含义；不要改写文本。',
            '2. 每个问题必须给 quote 字段：从【整理后的题库内容】中逐字摘录有误处的原文片段（10~40 字，须与材料完全一致，可包含 〖N〗 标记）。',
            '3. 严格输出 JSON（不要 markdown 代码块包裹）：{"issues":[{"loc":"位置(条目#或题号)","quote":"逐字摘录","severity":"high|mid|low","desc":"问题描述(60字内)"}]}；没有问题输出 {"issues":[]}。',
          ].join('\n') },
          { role: 'user', content: `记录：${rec.title || rec.id}\n\n${material}${refNote}` },
        ], {
          maxTokens: (config.review && config.review.thinking) ? 16000 : 2000,
          providerId: (config.review && config.review.providerId) || undefined,
          llmOverride: (() => {
            const over = {};
            if (config.review && config.review.model) over.model = config.review.model;
            if (config.review && config.review.thinking) {
              over.temperature = 1;
              over._thinking = { type: 'enabled', budget_tokens: 8000 };
            }
            return Object.keys(over).length ? over : undefined;
          })(),
        });
        const parsed = parseMnemonicJSON(reply);
        if (!parsed || !Array.isArray(parsed.issues)) {
          throw Object.assign(new Error('AI 审读输出无法解析为疑点清单（schema 不符），原始输出：' + String(reply).slice(0, 120)), { code: 'KB_IMPORT' });
        }
        // quote 定位回写：把每条疑点锚到渲染序条目（先精确 includes，失败用去空白/去锚点宽松匹配）
        const normTxt = s => String(s || '').replace(/〖\/\d+〗/g, '').replace(/〖\d+〗/g, '').replace(/\s+/g, '');
        const locate = quote => {
          const q = String(quote || '').trim();
          if (q.length < 4) return { idx: null, text: null, tag: null };
          let hit = -1;
          if (ordered.length) hit = ordered.findIndex(it => (it.text || '').includes(q));
          if (hit < 0) {
            const nq = normTxt(q);
            if (nq.length >= 6) {
              if (ordered.length) hit = ordered.findIndex(it => normTxt(it.text).includes(nq));
              else if (normTxt(rec.text).includes(nq)) hit = 0;
            }
          }
          if (hit < 0) return { idx: null, text: null, tag: null };
          const it = ordered.length ? ordered[hit] : null;
          const tag = it ? `${it.type || 'item'}${it.section ? '·' + it.section : ''}${it.number != null ? '·题' + it.number : ''}` : '纯文本记录';
          return { idx: ordered.length ? hit : null, text: String(it ? it.text : rec.text || '').slice(0, 2000), tag };
        };
        const issues = parsed.issues
          .filter(x => x && typeof x.desc === 'string' && x.desc.trim())
          .slice(0, 30)
          .map(x => {
            const hitInfo = locate(x.quote);
            return {
              loc: String(x.loc || '?').slice(0, 40),
              quote: String(x.quote || '').trim().slice(0, 100),
              itemIdx: hitInfo.idx,
              itemTag: hitInfo.tag,
              itemText: hitInfo.text,
              severity: ['high', 'mid', 'low'].includes(x.severity) ? x.severity : 'mid',
              desc: x.desc.trim().slice(0, 160),
            };
          });
        kbLog({ time: new Date().toISOString().slice(0, 19), file: '(review)', status: 'reviewed', store, records: issues.length, reason: `located=${issues.filter(x => x.itemIdx != null).length}/${issues.length}` });
        return sendJSON(res, 200, {
          ok: true, issues,
          reviewed_at: new Date().toISOString().slice(0, 19), mock: !!config.llm.mock,
          materialStats: { chars: totalChars, items: ordered.length, limit: LIMIT, truncated, hasRef: !!refNote },
          modelUsed: {
            providerId: (config.review && config.review.providerId) || config.llm.activeId || '',
            model: (config.review && config.review.model) || '',
          },
        });
      }

      /* ---------------- v1.1.5：单元题库 API ---------------- */

      // 单元列表（整卷切片自动派生：导入成功即出现，无需手动推送）
      if (p === '/api/unit/records' && req.method === 'GET') {
        const answers = loadAnswers();
        const units = buildUnits().map(u => ({ ...u, hasAnswer: !!(answers[u.unitId] && Object.keys(answers[u.unitId]).length) }));
        return sendJSON(res, 200, { ok: true, units, file: examsFile() });
      }

      // 单元详情：items 切片 + 标准答案状态（只下发有无，不下发答案值）
      {
        const m = p.match(/^\/api\/unit\/detail\/([0-9a-f]{12}~[A-Za-z0-9_]+~[A-Za-z0-9]+)$/);
        if (m && req.method === 'GET') {
          const ui = unitItems(m[1]);
          if (!ui) return sendJSON(res, 404, { error: '单元不存在：' + m[1] });
          const std = loadAnswers()[m[1]] || {};
          return sendJSON(res, 200, {
            ok: true,
            unit: ui.unit,
            items: ui.items,
            answerState: { has: Object.keys(std).length > 0, keys: Object.keys(std) },
          });
        }
      }

      // 保存标准答案（人工录入权威答案；LLM 不得生成）
      if (p === '/api/unit/answers/save' && req.method === 'POST') {
        const body = await readBody(req);
        const unitId = String(body.unitId || '');
        if (!findUnit(unitId)) return sendJSON(res, 404, { error: '单元不存在：' + unitId });
        const ans = body.answers && typeof body.answers === 'object' ? body.answers : {};
        const keys = Object.keys(ans);
        if (keys.length > 60) return sendJSON(res, 400, { error: '答案条目过多', code: 'KB_IMPORT' });
        const clean = {};
        for (const k of keys) {
          const v = String(ans[k] || '').trim().toUpperCase();
          if (/^[A-G]$/.test(v)) clean[String(k).slice(0, 10)] = v;
        }
        const all = loadAnswers();
        all[unitId] = clean;
        saveAnswers(all);
        kbLog({ time: new Date().toISOString().slice(0, 19), file: '(answers)', status: 'saved', store: 'exam', records: Object.keys(clean).length, reason: unitId.slice(0, 40) });
        return sendJSON(res, 200, { ok: true, saved: Object.keys(clean).length });
      }

      // 提交作答 -> 服务端判分（客观题对标准答案；主观题仅保存）
      if (p === '/api/unit/answers/submit' && req.method === 'POST') {
        const body = await readBody(req);
        const unitId = String(body.unitId || '');
        const ui = unitItems(unitId);
        if (!ui) return sendJSON(res, 404, { error: '单元不存在：' + unitId });
        const qs = ui.items.filter(it => it.type === 'question');
        const std = loadAnswers()[unitId] || {};
        const given = body.answers && typeof body.answers === 'object' ? body.answers : {};
        const results = qs.map(it => {
          const picked = String(given[String(it.number)] || '').trim().toUpperCase() || null;
          const correct = std[String(it.number)] || null;
          return { number: it.number, picked, correct, ok: (picked && correct) ? picked === correct : null };
        });
        const judged = results.filter(r => r.ok !== null);
        const correctN = judged.filter(r => r.ok).length;
        db.unitLog.push({ ts: new Date().toISOString().slice(0, 19), unitId, title: ui.unit.title, total: qs.length, judged: judged.length, correct: correctN });
        if (db.unitLog.length > 500) db.unitLog = db.unitLog.slice(-500);
        persistDB();
        return sendJSON(res, 200, {
          ok: true, title: ui.unit.title, results,
          judged: judged.length, total: qs.length, correct: correctN,
          hasStd: Object.keys(std).length > 0,
        });
      }

      // v1.1.1：语料导入（文件 base64 数组 + 可选粘贴直录）
      if (p === '/api/kb/import' && req.method === 'POST') {
        const body = await readBody(req, 60e6);
        const category = KB_CATEGORIES.includes(body.category) ? body.category : '直录';
        const results = [];
        if (body.paste && typeof body.paste.text === 'string') {
          results.push(await kbImportPaste({ title: body.paste.title, text: body.paste.text, category }));
        }
        const files = (Array.isArray(body.items) ? body.items : []).slice(0, 20);
        for (const it of files) {
          if (!it || typeof it.name !== 'string' || typeof it.data64 !== 'string') continue;
          if (it.data64.length > KB_IMPORT_MAX) {
            results.push({ ok: false, file: it.name, reason: '文件超过 30MB 上限' });
            continue;
          }
          let buf;
          try { buf = Buffer.from(it.data64, 'base64'); } catch {
            results.push({ ok: false, file: it.name, reason: 'base64 解码失败' });
            continue;
          }
          results.push(await kbImportOne({ name: it.name, buf, category }));
        }
        if (!results.length) return sendJSON(res, 400, { error: '没有可导入的内容（选文件或粘贴文本）', code: 'KB_IMPORT' });
        return sendJSON(res, 200, {
          ok: true, results,
          imported: results.filter(r => r.ok).length,
          quarantined: results.filter(r => !r.ok).length,
        });
      }

      // v1.1.2：真题库导入（仅 tex/pdf 结构化源 -> exams.jsonl）
      if (p === '/api/exam/import' && req.method === 'POST') {
        const body = await readBody(req, 60e6);
        const results = [];
        const files = (Array.isArray(body.items) ? body.items : []).slice(0, 20);
        for (const it of files) {
          if (!it || typeof it.name !== 'string' || typeof it.data64 !== 'string') continue;
          if (it.data64.length > KB_IMPORT_MAX) {
            results.push({ ok: false, file: it.name, reason: '文件超过 30MB 上限', store: 'exam' });
            continue;
          }
          let buf;
          try { buf = Buffer.from(it.data64, 'base64'); } catch {
            results.push({ ok: false, file: it.name, reason: 'base64 解码失败', store: 'exam' });
            continue;
          }
          results.push(await kbImportOne({ name: it.name, buf, category: '真题', store: 'exam' }));
        }
        if (!results.length) return sendJSON(res, 400, { error: '没有可导入的文件（选择 tex / pdf）', code: 'KB_IMPORT' });
        return sendJSON(res, 200, {
          ok: true, results,
          imported: results.filter(r => r.ok).length,
          quarantined: results.filter(r => !r.ok).length,
        });
      }

      // v1.1.2：真题库列表（「考试-题型」板块统计）
      if (p === '/api/exam/records' && req.method === 'GET') {
        return sendJSON(res, 200, {
          ok: true,
          file: examsFile(),
          exists: fs.existsSync(examsFile()),
          records: loadExams().map(examSummary),
        });
      }

      // v1.1.2：真题详情（渲染排序后的 items + 板块统计）
      {
        const m = p.match(/^\/api\/exam\/record\/([0-9a-f]+)$/);
        if (m && req.method === 'GET') {
          const r = loadExams().find(x => x.id === m[1]);
          if (!r) return sendJSON(res, 404, { error: '记录不存在' });
          return sendJSON(res, 200, {
            ok: true,
            record: { ...r, rtypeLabel: RTYPE_LABEL[r.rtype] || r.rtype, items: u.searchParams.get('raw') === '1' ? (r.items || []) : kbOrderedItems(r), sections: examSummary(r).sections },
          });
        }
      }

      // v1.1.2：手动触发 qa_set 迁移（幂等，供测试/修复）
      if (p === '/api/test/kb-split' && req.method === 'POST') {
        const r = ensureKbSplit();
        return sendJSON(res, 200, { ok: true, ...r, corpus: loadKb().length, exams: loadExams().length });
      }

      // v1.1.1：导入日志（最近 30 条，新->旧）
      if (p === '/api/kb/importlog' && req.method === 'GET') {
        let log = [];
        try {
          log = fs.readFileSync(path.join(kbBaseDir(), 'import_log.jsonl'), 'utf8')
            .trim().split('\n').slice(-30)
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean).reverse();
        } catch { /* 无日志文件 */ }
        return sendJSON(res, 200, { ok: true, log });
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (p.startsWith('/api/')) {
      if (err.code === 'BODY_TOO_LARGE') {
        // v1.1.3：请求体超限 = 413，并提示 nginx 反代需同步放宽 client_max_body_size
        return sendJSON(res, 413, { error: err.message + '（若经 nginx 反代访问，还需放宽 client_max_body_size）', code: 'BODY_TOO_LARGE' });
      }
      return sendJSON(res, ['NO_TOKEN', 'NO_LLM', 'NO_IMG', 'NO_SEARCH', 'NO_DICT', 'BAD_WORD', 'KB_IMPORT', 'NO_MINERU'].includes(err.code) ? 400 : 500, { error: err.message, code: err.code });
    }
    res.writeHead(500); res.end('Server Error');
  }
});

ensureDataDir();
ensureKbSplit();   // v1.1.2：旧版单文件里的 qa_set 自动迁移到 exams.jsonl
armAutoSync();
server.listen(PORT, HOST, () => {
  console.log(`\n  英语学习工作台已启动`);
  console.log(`  ➜  http://localhost:${PORT}  (listening on ${HOST})`);
  console.log(`  数据目录: ${DATA_DIR}\n`);
  if (!config.maimemoToken) console.log('  [提示] 尚未配置墨墨 Token，请打开网页在「设置」中填写\n');
});
