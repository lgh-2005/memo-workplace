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
 * 12. 外刊发布源（v2.0.1）：独立读取 corpus/external/current/articles.jsonl，
 *     保留标准文章元数据，和手工语料/真题分开管理；外刊只读、可参与检索与 AI 引用
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
const EXTERNAL_CORPUS_DEFAULT_DIR = path.join(ROOT, 'corpus', 'external', 'current');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const LEARNING_ATTEMPTS_FILE = path.join(DATA_DIR, 'learning_attempts.json');
const PORT = process.env.PORT ? Number(process.env.PORT) : 5178;
// 本机默认只监听 127.0.0.1；云服务器部署时设置 HOST=0.0.0.0（建议配合 nginx/防火墙）
const HOST = process.env.HOST || '127.0.0.1';

/** 北京时间（Asia/Shanghai）的 YYYY-MM-DD，offsetDays 为偏移天数 */
function bjDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}

const MM_BASE = 'https://open.maimemo.com/open/api/v1/memo';

/* v2.2.4：词汇真题迁移训练——仅在进程内存中驻留的签名密钥（重启即失效，旧题自动作废） */
const VOCAB_TRAIN_SECRET = crypto.randomBytes(32);
const VOCAB_QUESTION_TTL_MS = 6 * 3600_000;   // 单题有效期 6 小时
const vocabQuestionMap = new Map();           // token -> 题目上下文（仅内存）

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

/** v2.2.6：读取并校验 JSON 文件；返回 { exists, valid, obj, error }，损坏时不抛异常 */
function validateJsonFile(file) {
  if (!fs.existsSync(file)) return { exists: false, valid: false };
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { exists: true, valid: true, obj };
  } catch (e) {
    return { exists: true, valid: false, error: String(e.message || e).slice(0, 160) };
  }
}

/** v2.2.6：学习流水文件结构校验（schemaVersion 与 attempts 数组） */
function isLearningStoreShape(obj) {
  return !!obj && typeof obj === 'object' && obj.schemaVersion === 1 && Array.isArray(obj.attempts);
}

let config = loadJSON(CONFIG_FILE, {
  maimemoToken: process.env.MAIMEMO_TOKEN || '',
  llm: { mock: false, activeId: 'default', providers: [{ id: 'default', name: '默认服务商', baseUrl: '', apiKey: '', model: '' }] },
  autoSync: { enabled: false, minutes: 60 },
  diyPrompts: {},      // v2.1.0：自定义提示词（附带索引与最近5条历史）
  maimemoNotepadId: '',   // v1.0.6：绑定的云词库 id（助记推送前提）
  notepadTitle: '',
  imageGen: { baseUrl: '', apiKey: '', model: '' },   // v1.0.6：生图服务商（OpenAI 兼容 images API）
  webSearch: { url: '', apiKey: '' },   // v1.0.7：网络搜索服务（通用 url + 密钥）
  dict: { learnersKey: '', collegiateKey: '' },   // v1.0.8：韦氏词典双 key（learners=学习者词典 / collegiate=大学版）
  mineru: { apiKey: '', mock: false },   // v1.1.4：MinerU 精准解析 API（扫描件 PDF -> Markdown，mineru.net）
});
// v2.1.0：DIY 模型提示词自定义注册表配置补齐
if (!config.diyPrompts || typeof config.diyPrompts !== 'object') config.diyPrompts = {};
delete config.kaoyanMode; // v2.1.0：取消考研英语一模式
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
// v2.3.4：划词助手专用模型配置缺省补齐（留空沿用默认服务商）
if (!config.selection || typeof config.selection !== 'object') config.selection = { providerId: '', model: '' };
// v2.4.1：词文成章专用模型配置缺省补齐（留空沿用默认服务商）
if (!config.story || typeof config.story !== 'object') config.story = { providerId: '', model: '' };
// v2.4.1：文章题材自定义列表（null = 未自定义，用内置 16 题材；数组 = 用户自定义全量替换，2~40 项）
if (config.storyThemes !== undefined && !Array.isArray(config.storyThemes)) config.storyThemes = null;
// v2.0.0：外刊发布源独立于手工语料和真题库；留空使用 corpus/external/current/
if (!config.kb || typeof config.kb !== 'object') config.kb = { dir: '', pythonPath: '', externalDir: '' };
if (config.kb.externalDir === undefined) config.kb.externalDir = '';

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
  stories: [],            // v2.4.0：词文成章 [{id, title, words[], theme, length, passage, hooks[], translation, quiz[], createdAt}]
});
// 旧 db.json 兼容：缺失字段补默认值
if (!db.glosses) db.glosses = {};
if (!Array.isArray(db.quizLog)) db.quizLog = [];
if (db.lastSyncOk === undefined) db.lastSyncOk = true;
if (!db.contentCreated || typeof db.contentCreated !== 'object') db.contentCreated = { date: '', count: 0 };   // v1.0.7
if (!Array.isArray(db.unitLog)) db.unitLog = [];   // v1.1.5：单元做题记录缺省补齐
if (!Array.isArray(db.stories)) db.stories = [];   // v2.4.0：词文成章文章 {id, title, words[], theme, length, passage, hooks[], translation, quiz[], createdAt}

function persistConfig() { saveJSON(CONFIG_FILE, config); }
function persistDB() { saveJSON(DB_FILE, db); }

/* v1.2.0：聊天记录持久化（独立文件，不膨胀 db.json） */
const CHAT_FILE = path.join(DATA_DIR, 'chat_sessions.json');
function loadChatHistory() { return loadJSON(CHAT_FILE, []); }
function saveChatHistory(arr) { saveJSON(CHAT_FILE, arr); }

/* v2.2.0：统一学习流水持久化（独立文件，tmp+rename 原子写，最多 20,000 条） */
const MAX_LEARNING_ATTEMPTS = 20000;
const VALID_ATTEMPT_KINDS = new Set([
  'word_quiz',
  'unit_objective',
  'translation',
  'writing',
  'vocab_context',
  'vocab_cloze',
  'sentence_analysis',
]);
const VALID_ATTEMPT_RESULTS = new Set([
  'pending',
  'correct',
  'incorrect',
  'vague',
  'unjudged',
  'completed',
]);
const VALID_ATTEMPT_CONFIDENCES = new Set([
  'sure',
  'unsure',
  'guess',
]);
const VALID_ATTEMPT_ERROR_REASONS = new Set([
  'unknown_word',
  'misread_stem',
  'evidence_missed',
  'over_inference',
  'option_trap',
  'careless',
  'time_pressure',
  'other',
]);

/**
 * v2.2.8：读取学习流水存储。
 * 文件不存在时返回内存空 store（首次真实追加后才落盘）；
 * 文件存在但 JSON 损坏或结构非法（schemaVersion !== 1 / attempts 非数组）时抛出
 * 带 code=LEARNING_STORE_CORRUPT 的错误，绝不返回空 store 覆盖原文件。
 */
function loadLearningStore() {
  if (!fs.existsSync(LEARNING_ATTEMPTS_FILE)) {
    return { schemaVersion: 1, enabledAt: new Date().toISOString(), attempts: [] };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(LEARNING_ATTEMPTS_FILE, 'utf8'));
  } catch (e) {
    const err = new Error('学习流水文件损坏，无法解析：' + String(e.message || e).slice(0, 160));
    err.code = 'LEARNING_STORE_CORRUPT';
    throw err;
  }
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1 || !Array.isArray(raw.attempts)) {
    const err = new Error('学习流水文件结构非法（schemaVersion 必须为 1 且 attempts 为数组），已拒绝读写以免覆盖');
    err.code = 'LEARNING_STORE_CORRUPT';
    throw err;
  }
  return {
    schemaVersion: 1,
    enabledAt: typeof raw.enabledAt === 'string' ? raw.enabledAt : new Date().toISOString(),
    attempts: raw.attempts,
  };
}

function saveLearningStore(store) {
  saveJSON(LEARNING_ATTEMPTS_FILE, {
    schemaVersion: 1,
    enabledAt: store.enabledAt || new Date().toISOString(),
    attempts: Array.isArray(store.attempts) ? store.attempts : [],
  });
}

function normalizeLearningAttempt(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Attempt 必须为对象');

  const kind = String(raw.kind || '').trim();
  if (!VALID_ATTEMPT_KINDS.has(kind)) throw new Error(`无效的 attempt kind: ${kind}`);

  const result = String(raw.result || '').trim();
  if (!VALID_ATTEMPT_RESULTS.has(result)) throw new Error(`无效的 attempt result: ${result}`);

  let confidence = raw.confidence !== null && raw.confidence !== undefined ? String(raw.confidence).trim() : null;
  if (confidence !== null && !VALID_ATTEMPT_CONFIDENCES.has(confidence)) {
    throw new Error(`无效的 attempt confidence: ${confidence}`);
  }

  let errorReason = raw.errorReason !== null && raw.errorReason !== undefined ? String(raw.errorReason).trim() : null;
  if (errorReason !== null && !VALID_ATTEMPT_ERROR_REASONS.has(errorReason)) {
    throw new Error(`无效的 attempt errorReason: ${errorReason}`);
  }

  const prompt = raw.prompt !== null && raw.prompt !== undefined ? String(raw.prompt) : null;
  if (prompt && prompt.length > 4000) throw new Error('prompt 超过 4000 字符限制');

  const expected = raw.expected !== null && raw.expected !== undefined ? String(raw.expected) : null;
  if (expected && expected.length > 4000) throw new Error('expected 超过 4000 字符限制');

  const answer = raw.answer !== null && raw.answer !== undefined ? String(raw.answer) : null;
  if (answer && answer.length > 4000) throw new Error('answer 超过 4000 字符限制');

  let meta = null;
  if (raw.meta !== null && raw.meta !== undefined) {
    if (typeof raw.meta !== 'object') throw new Error('meta 必须为对象');
    const metaStr = JSON.stringify(raw.meta);
    if (metaStr.length > 8000) throw new Error('meta 序列化后超过 8000 字符限制');
    meta = JSON.parse(metaStr);
  }

  let durationMs = null;
  if (raw.durationMs !== null && raw.durationMs !== undefined) {
    const d = Number(raw.durationMs);
    if (!Number.isFinite(d) || d < 0 || d > 14400000) {
      throw new Error('durationMs 必须为 0..14400000 毫秒');
    }
    durationMs = Math.round(d);
  }

  const parseISO = (val, name) => {
    if (!val) return null;
    const str = String(val).trim();
    const d = new Date(str);
    if (isNaN(d.getTime())) throw new Error(`${name} 无效的 ISO 时间`);
    return d.toISOString();
  };

  const startedAt = parseISO(raw.startedAt, 'startedAt');
  const submittedAt = parseISO(raw.submittedAt, 'submittedAt');
  const dueAt = parseISO(raw.dueAt, 'dueAt');

  const cleanStr = (val, max = 200) => {
    if (val === null || val === undefined) return null;
    const s = String(val).trim();
    return s.slice(0, max) || null;
  };

  const cleanNum = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };

  return {
    id: cleanStr(raw.id, 64) || `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    kind,
    source: cleanStr(raw.source, 100),
    itemId: cleanStr(raw.itemId, 200),
    unitId: cleanStr(raw.unitId, 100),
    examId: cleanStr(raw.examId, 100),
    year: cleanNum(raw.year),
    section: cleanStr(raw.section, 100),
    prompt,
    expected,
    answer,
    result,
    confidence,
    errorReason,
    startedAt,
    submittedAt,
    durationMs,
    reviewOf: cleanStr(raw.reviewOf, 64),
    dueAt,
    meta,
  };
}

function pruneLearningAttempts(attempts, max = MAX_LEARNING_ATTEMPTS) {
  if (attempts.length <= max) return attempts;
  const now = Date.now();
  // 必须优先保留未完成 (result === 'pending') 或未来到期 (dueAt 在未来) 的复测记录
  const isProtected = (att) => {
    if (att.result === 'pending') return true;
    if (att.dueAt) {
      const t = new Date(att.dueAt).getTime();
      if (!isNaN(t) && t > now) return true;
    }
    return false;
  };

  // 按 submittedAt || startedAt 升序排序
  const getTime = (att) => {
    const iso = att.submittedAt || att.startedAt;
    if (!iso) return 0;
    const t = new Date(iso).getTime();
    return isNaN(t) ? 0 : t;
  };

  // 如果全部都保护，或者超出上限，先剔除最早且未受保护的记录
  let excess = attempts.length - max;
  const result = [];
  // 保持时间相对顺序
  const sortedWithIdx = attempts.map((att, idx) => ({ att, idx, time: getTime(att), prot: isProtected(att) }))
    .sort((a, b) => a.time - b.time || a.idx - b.idx);

  const dropIndices = new Set();
  for (const item of sortedWithIdx) {
    if (excess <= 0) break;
    if (!item.prot) {
      dropIndices.add(item.idx);
      excess--;
    }
  }

  // 若剔除非保护记录后仍然超量（极端情况下全是保护记录），再按最早时间丢弃受保护记录兜底
  if (excess > 0) {
    for (const item of sortedWithIdx) {
      if (excess <= 0) break;
      if (!dropIndices.has(item.idx)) {
        dropIndices.add(item.idx);
        excess--;
      }
    }
  }

  return attempts.filter((_, idx) => !dropIndices.has(idx));
}

function appendLearningAttempts(newItems) {
  if (!Array.isArray(newItems) || newItems.length === 0) return 0;
  const normalized = newItems.map(normalizeLearningAttempt);
  const store = loadLearningStore();
  store.attempts.push(...normalized);
  store.attempts = pruneLearningAttempts(store.attempts);
  saveLearningStore(store);
  return normalized.length;
}

/**
 * v2.2.8：并发安全地更新单条流水。
 * 每次调用前重新 loadLearningStore()，仅在最新快照上修改指定 id 的记录后落盘，
 * 禁止跨 await 持有旧 store 快照整体保存（避免覆盖并发写入）。
 * @returns {object|null} 修改后的记录，未找到返回 null
 */
function updateLearningAttempt(attemptId, mutator) {
  const store = loadLearningStore();
  const idx = (store.attempts || []).findIndex(a => a.id === attemptId);
  if (idx < 0) return null;
  const next = mutator(store.attempts[idx]);
  store.attempts[idx] = next;
  store.attempts = pruneLearningAttempts(store.attempts);
  saveLearningStore(store);
  return next;
}

/** v2.2.8：同一 attemptId 在 LLM 请求期间只允许一次提交，避免并发重复生成复测任务 */
const sentenceSubmitInFlight = new Set();

/**
 * v2.2.3：按北京时间自然日窗口（7/14/30天）聚合细粒度学习诊断周报纯函数
 * 严禁使用旧汇总伪造单题数据，无细粒度流水时安全返回全零结构与 enabledAt
 * v2.2.8：pending（未完成首答/待复测）一律不进入作答统计，仅 dueReviews/pendingRetries 单独呈现
 */
function buildLearningReport(days = 7) {
  const allowedDays = [7, 14, 30];
  const winDays = allowedDays.includes(Number(days)) ? Number(days) : 7;
  const store = loadLearningStore();
  const enabledAt = store.enabledAt || null;
  const allAttempts = Array.isArray(store.attempts) ? store.attempts : [];

  // 计算北京时间自然日窗口边界：今天为第 0 天，窗口为 [today - (winDays - 1), today]
  const todayStr = bjDate(0);
  const startDayStr = bjDate(-(winDays - 1));

  const inWindow = (iso) => {
    if (!iso) return false;
    const dStr = bjDateOf(iso);
    return dStr >= startDayStr && dStr <= todayStr;
  };

  // 筛选窗口内已提交/作答的流水记录
  // v2.2.8：pending（含首答未完成与待复测）不进入作答统计，避免污染准确率/信心矩阵/最近流水
  const inWindowAll = allAttempts.filter(a => inWindow(a.submittedAt || a.startedAt));
  const windowAttempts = inWindowAll.filter(a => a.result !== 'pending');

  // 1. overview: 总作答、已判题、正确率、平均耗时至
  let totalAttempts = windowAttempts.length;
  let judgedCount = 0;
  let correctCount = 0;
  let durationTotalMs = 0;
  let durationSamples = 0;

  // v2.2.8：单题耗时用 durationMs；单元作答改用整会话耗时 meta.sessionDurationMs，
  // 同一批次（batchId）共享一次会话，按批次去重，避免一单元 N 题重复计入。
  const sessionSeen = new Set();
  for (const a of windowAttempts) {
    if (a.result === 'correct' || a.result === 'incorrect' || a.result === 'vague') {
      judgedCount++;
      if (a.result === 'correct') correctCount++;
    }
    const sessionMs = a.meta && typeof a.meta.sessionDurationMs === 'number' ? a.meta.sessionDurationMs : null;
    if (sessionMs !== null && sessionMs > 0) {
      const key = (a.meta && a.meta.batchId) ? 'b:' + a.meta.batchId : 'a:' + a.id;
      if (!sessionSeen.has(key)) {
        sessionSeen.add(key);
        durationTotalMs += sessionMs;
        durationSamples++;
      }
    } else if (typeof a.durationMs === 'number' && a.durationMs > 0) {
      durationTotalMs += a.durationMs;
      durationSamples++;
    }
  }

  const accuracy = judgedCount > 0 ? Number((correctCount / judgedCount).toFixed(4)) : null;
  const avgDurationMs = durationSamples > 0 ? Math.round(durationTotalMs / durationSamples) : 0;

  // 2. bySection: 按板块统计作答量、判分量与正确率
  const sectionKeys = ['vocabulary', 'use_of_english', 'reading', 'part_b', 'translation', 'writing'];
  const bySection = {};
  for (const k of sectionKeys) {
    bySection[k] = { total: 0, judged: 0, correct: 0, accuracy: null };
  }
  for (const a of windowAttempts) {
    const sec = a.section || (a.kind === 'word_quiz' ? 'vocabulary' : 'misc');
    if (!bySection[sec]) {
      bySection[sec] = { total: 0, judged: 0, correct: 0, accuracy: null };
    }
    bySection[sec].total++;
    if (a.result === 'correct' || a.result === 'incorrect' || a.result === 'vague') {
      bySection[sec].judged++;
      if (a.result === 'correct') bySection[sec].correct++;
    }
  }
  for (const k of Object.keys(bySection)) {
    const item = bySection[k];
    item.accuracy = item.judged > 0 ? Number((item.correct / item.judged).toFixed(4)) : null;
  }

  // 3. repeatedWords: 窗口内 incorrect/vague 至少 2 次的错词，降序取前 20
  const wordErrMap = new Map();
  for (const a of windowAttempts) {
    const isWordKind = a.kind === 'word_quiz' || a.kind === 'vocab_context' || a.kind === 'vocab_cloze';
    if (isWordKind && (a.result === 'incorrect' || a.result === 'vague')) {
      const sp = a.meta?.word || a.prompt;
      if (!sp) continue;
      const cur = wordErrMap.get(sp) || { word: sp, count: 0, vagueCount: 0, incorrectCount: 0, lastAt: null };
      cur.count++;
      if (a.result === 'vague') cur.vagueCount++;
      if (a.result === 'incorrect') cur.incorrectCount++;
      const t = a.submittedAt || a.startedAt;
      if (!cur.lastAt || t > cur.lastAt) cur.lastAt = t;
      wordErrMap.set(sp, cur);
    }
  }
  const repeatedWords = Array.from(wordErrMap.values())
    .filter(x => x.count >= 2)
    .sort((a, b) => b.count - a.count || (b.lastAt < a.lastAt ? -1 : 1))
    .slice(0, 20);

  // 4. errorReasons: 8 大错因分布
  const errorReasons = {
    unknown_word: 0,
    misread_stem: 0,
    evidence_missed: 0,
    over_inference: 0,
    option_trap: 0,
    careless: 0,
    time_pressure: 0,
    other: 0,
  };
  for (const a of windowAttempts) {
    if (a.errorReason && errorReasons[a.errorReason] !== undefined) {
      errorReasons[a.errorReason]++;
    }
  }

  // 5. confidenceMatrix: 信心校准矩阵 (sure/unsure/guess 分别的正确、模糊、错误与准确率)
  const confidenceMatrix = {
    sure: { total: 0, correct: 0, vague: 0, incorrect: 0, accuracy: null },
    unsure: { total: 0, correct: 0, vague: 0, incorrect: 0, accuracy: null },
    guess: { total: 0, correct: 0, vague: 0, incorrect: 0, accuracy: null },
  };
  for (const a of windowAttempts) {
    const c = a.confidence;
    if (confidenceMatrix[c] && (a.result === 'correct' || a.result === 'incorrect' || a.result === 'vague')) {
      confidenceMatrix[c].total++;
      if (a.result === 'correct') confidenceMatrix[c].correct++;
      else if (a.result === 'vague') confidenceMatrix[c].vague++;
      else if (a.result === 'incorrect') confidenceMatrix[c].incorrect++;
    }
  }
  for (const c of ['sure', 'unsure', 'guess']) {
    const m = confidenceMatrix[c];
    m.accuracy = m.total > 0 ? Number((m.correct / m.total).toFixed(4)) : null;
  }

  // 6. subjective: 主观输出统计（翻译题数、作文篇数、总词数）
  let transCount = 0;
  let essayCount = 0;
  let subjectiveWords = 0;
  for (const a of windowAttempts) {
    if (a.kind === 'translation') {
      transCount++;
      subjectiveWords += (a.meta?.wordCount || (a.answer ? a.answer.length : 0));
    } else if (a.kind === 'writing') {
      essayCount++;
      subjectiveWords += (a.meta?.wordCount || (a.answer ? a.answer.split(/\s+/).filter(Boolean).length : 0));
    }
  }

  // 7. dueReviews: 到期且未完成的复测任务（reviewOf 存在、result=pending 且 dueAt <= 现在），最多 20 条
  //    v2.2.8：首答失败待重试的 pending（无 reviewOf）不再伪装成复测任务
  const nowISO = new Date().toISOString();
  const dueReviews = allAttempts
    .filter(a => a.result === 'pending' && a.reviewOf && a.dueAt && a.dueAt <= nowISO)
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))
    .slice(0, 20);

  // 7b. pendingRetries: 首答因 LLM 失败待重试的记录（result=pending、无 reviewOf、有 lastError）
  const pendingRetries = allAttempts
    .filter(a => a.result === 'pending' && !a.reviewOf && a.meta && a.meta.lastError)
    .sort((a, b) => {
      const ta = new Date(a.submittedAt || a.startedAt || 0).getTime() || 0;
      const tb = new Date(b.submittedAt || b.startedAt || 0).getTime() || 0;
      return tb - ta;
    })
    .slice(0, 20);

  // 8. recentAttempts: 窗口内最近 20 条流水
  const recentAttempts = windowAttempts
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.submittedAt || a.startedAt || 0).getTime() || 0;
      const tb = new Date(b.submittedAt || b.startedAt || 0).getTime() || 0;
      return tb - ta;
    })
    .slice(0, 20);

  // 9. mnemonicEffect: 助记有效性可解释追踪
  // 每条助记与同 spelling 且 submittedAt > note.createdAt 的首个 word_quiz/vocab_context/vocab_cloze attempt 关联
  let initialEffective = 0;
  let needsRewrite = 0;
  let pendingEffect = 0;
  let samples = 0;

  const notes = Array.isArray(db.notes) ? db.notes : [];
  for (const n of notes) {
    const sp = n.spelling;
    if (!sp) continue;
    const nCreated = n.createdAt || '1970-01-01T00:00:00.000Z';
    // 找到该词在助记创建后的所有流水，按时间正序
    const postAttempts = allAttempts.filter(a => {
      const isWord = a.kind === 'word_quiz' || a.kind === 'vocab_context' || a.kind === 'vocab_cloze';
      const wordHit = (a.meta?.word === sp) || (a.prompt === sp);
      const postTime = (a.submittedAt || a.startedAt || '') > nCreated;
      return isWord && wordHit && postTime;
    }).sort((a, b) => {
      const ta = new Date(a.submittedAt || a.startedAt || 0).getTime() || 0;
      const tb = new Date(b.submittedAt || b.startedAt || 0).getTime() || 0;
      return ta - tb;
    });

    if (postAttempts.length === 0) {
      pendingEffect++;
    } else {
      samples++;
      const first = postAttempts[0];
      if (first.result === 'correct') {
        initialEffective++;
      } else if (first.result === 'incorrect' || first.result === 'vague') {
        needsRewrite++;
      } else {
        pendingEffect++;
      }
    }
  }

  return {
    windowDays: winDays,
    startDate: startDayStr,
    endDate: todayStr,
    enabledAt,
    overview: {
      totalAttempts,
      judgedCount,
      correctCount,
      accuracy,
      avgDurationMs,
    },
    bySection,
    repeatedWords,
    errorReasons,
    confidenceMatrix,
    subjective: {
      translationCount: transCount,
      essayCount,
      totalWords: subjectiveWords,
    },
    mnemonicEffect: {
      initialEffective,
      needsRewrite,
      pending: pendingEffect,
      samples,
    },
    dueReviews,
    pendingRetries,
    recentAttempts,
  };
}

/* ------------------------------------------------------------------ */
/* v2.2.4：词汇真题迁移训练（真实真题句确定性出题 + HMAC 防篡改判分）      */
/* ------------------------------------------------------------------ */

function vocabGlossOf(word) {
  const g = db.glosses && db.glosses[word];
  if (!g) return null;
  const text = typeof g === 'string' ? g : g.gloss;
  if (!text) return null;
  return {
    pos: (typeof g === 'object' && g.pos) ? String(g.pos) : '',
    gloss: String(text).trim(),
  };
}

/** 与 /api/words 同源的候选词筛选（仅支持 sticky/vague/forget/due7） */
function collectVocabCandidates(filter) {
  const todayStr = bjDate();
  let words = Object.values(db.words);
  if (filter === 'sticky') words = words.filter(w => w.tags?.includes('STICKING'));
  else if (filter === 'forget') words = words.filter(w => w.lastResponse === 'FORGET' || w.today?.firstResponse === 'FORGET' || w.quizResponse === 'FORGET');
  else if (filter === 'vague') words = words.filter(w => w.lastResponse === 'VAGUE' || w.today?.firstResponse === 'VAGUE' || w.quizResponse === 'VAGUE');
  else if (filter === 'due7') {
    const end = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    words = words.filter(w => {
      const d = (w.nextStudyDate || '').slice(0, 10);
      return d && d <= end;
    });
  }
  return words;
}

/** 取句中真实命中的目标词形（用于 cloze 挖空），大小写不敏感 */
function findWordFormInSentence(sentence, word) {
  const inflections = getWordInflections(word);
  const pattern = inflections.length
    ? new RegExp(`\\b(?:${inflections.map(escapeRegExp).join('|')})\\b`, 'i')
    : new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
  const m = pattern.exec(sentence);
  return m ? m[0] : null;
}

function vocabSignPayload(q) {
  // v2.2.8：额外绑定 rid，提交时据此在当前索引精确复核来源
  return crypto.createHmac('sha256', VOCAB_TRAIN_SECRET)
    .update([q.kind, q.word, q.sentence, q.expected, q.rid || ''].join('|'))
    .digest('hex');
}

/** 生成词汇真题迁移题（语境选义 + 搭配补全），不调用 LLM，仅用真实真题句 */
function generateVocabQuestions(filter, count, options = {}) {
  const wantContext = options.context !== false;
  const wantCloze = options.cloze !== false;
  const candidates = collectVocabCandidates(filter);
  const now = Date.now();

  const usable = [];
  for (const w of candidates) {
    const gloss = vocabGlossOf(w.spelling);
    if (!gloss) continue;
    const evidence = kbEvidenceForWord(w.spelling, 3, 0);
    const examHit = evidence.exams && evidence.exams[0];
    if (!examHit) continue;
    usable.push({ word: w.spelling, gloss, hit: examHit });
  }

  // 打乱候选词，避免每次同一顺序
  for (let i = usable.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [usable[i], usable[j]] = [usable[j], usable[i]];
  }

  // 干扰项池：所有本地 gloss（去重），保留词性以支持同词性优先
  const allGlosses = [];
  const glossSeen = new Set();
  for (const sp of Object.keys(db.glosses || {})) {
    const g = vocabGlossOf(sp);
    if (g && !glossSeen.has(g.gloss)) { glossSeen.add(g.gloss); allGlosses.push({ gloss: g.gloss, pos: g.pos || '' }); }
  }

  const questions = [];
  for (const item of usable) {
    if (questions.length >= count) break;

    if (wantContext) {
      // 语境选义：干扰项优先取同词性释义，不足再补其他词性；仍不足 3 个则跳过
      const targetPos = (item.gloss.pos || '').trim();
      const samePos = [];
      const otherPos = [];
      for (const g of allGlosses) {
        if (g.gloss === item.gloss.gloss) continue;
        if (targetPos && g.pos && g.pos === targetPos) samePos.push(g.gloss);
        else otherPos.push(g.gloss);
      }
      shuffleInPlace(samePos);
      shuffleInPlace(otherPos);
      const distractors = samePos.slice(0, 3);
      if (distractors.length < 3) {
        for (const g of otherPos) {
          if (distractors.length >= 3) break;
          if (!distractors.includes(g)) distractors.push(g);
        }
      }
      if (distractors.length < 3) continue;   // 释义池不足，跳过
      const opts = [item.gloss.gloss, ...distractors.slice(0, 3)];
      shuffleInPlace(opts);
      const expected = item.gloss.gloss;
      const q = {
        kind: 'vocab_context',
        word: item.word,
        sentence: item.hit.s,
        rid: item.hit.rid || null,
        sourceSentence: item.hit.s,
        year: item.hit.year || null,
        title: item.hit.title || '',
        sourceKind: item.hit.sourceKind,
        expected,
        options: opts,
      };
      q.token = vocabSignPayload(q);
      questions.push(q);
      vocabQuestionMap.set(q.token, { ...q, createdAt: now });
      if (questions.length >= count) break;
    }

    if (wantCloze) {
      // 搭配补全：把句中真实目标词形替换为 ____，答案为该实际词形
      const form = findWordFormInSentence(item.hit.s, item.word);
      if (!form) continue;
      const blanked = item.hit.s.replace(
        new RegExp(`\\b${escapeRegExp(form)}\\b`, 'i'),
        '____'
      );
      if (blanked === item.hit.s) continue;
      const q = {
        kind: 'vocab_cloze',
        word: item.word,
        sentence: blanked,
        rid: item.hit.rid || null,
        sourceSentence: item.hit.s,
        year: item.hit.year || null,
        title: item.hit.title || '',
        sourceKind: item.hit.sourceKind,
        expected: form,
        options: null,
      };
      q.token = vocabSignPayload(q);
      questions.push(q);
      vocabQuestionMap.set(q.token, { ...q, createdAt: now });
    }
  }

  // 清理过期题目缓存
  if (vocabQuestionMap.size > 4000) {
    for (const [k, v] of vocabQuestionMap) {
      if (now - v.createdAt > VOCAB_QUESTION_TTL_MS) vocabQuestionMap.delete(k);
    }
  }

  return questions;
}

// 返回给前端时移除 expected（标准答案不下发为独立字段，仅以 opts 存在与否体现）
function publicVocabQuestion(q) {
  return {
    token: q.token,
    kind: q.kind,
    word: q.word,
    sentence: q.sentence,
    year: q.year,
    title: q.title,
    sourceLabel: q.year ? `真题 ${q.year}` : '真题语境',
    options: q.options || null,
  };
}

/** 任意 ISO 时间 → 北京时间的 YYYY-MM-DD */
function bjDateOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

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
  deepseek: {
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    temperature: 0.7,
    max_tokens: 2000
  },
  siliconflow: {
    label: '硅基流动 (SiliconFlow)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'],
    temperature: 0.7,
    max_tokens: 2000
  },
  zhipu: {
    label: '智谱 GLM 开放平台',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    temperature: 0.7,
    max_tokens: 2000
  },
  moonshot: {
    label: '月之暗面 (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    temperature: 0.7,
    max_tokens: 2000
  },
  openai: {
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    temperature: 0.7,
    max_tokens: 2000,
    vision: true   // v2.3.4：官方多模态模型默认开放视觉能力（可在编辑弹层调整）
  },
  ollama: {
    label: 'Ollama 本地部署',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b'],
    temperature: 0.7,
    max_tokens: 2000
  }
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
    // v2.2.8：测试用可配置延迟（MOCK_LLM_DELAY_MS），用于验证并发写入安全
    const mockDelay = Number(process.env.MOCK_LLM_DELAY_MS || 0);
    if (Number.isFinite(mockDelay) && mockDelay > 0) await new Promise(r => setTimeout(r, mockDelay));
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
    // v2.3.4：请求体三级构建——基础参数 → 思考参数（Claude 式 _thinking 优先，否则服务商「思考等级」reasoning_effort）→ 透传 JSON 参数
    const bodyObj = { model: llm.model, messages, max_tokens: llm.max_tokens || maxTokens, temperature: llm.temperature !== undefined ? llm.temperature : 0.7 };
    if (llm._thinking) {
      bodyObj.thinking = llm._thinking;
    } else if (llm._noThinking) {
      // v2.4.2.b：调用方显式关闭思考——仅不传 reasoning_effort 不够（部分模型默认思考），
      // 双保险下发两种主流关闭参数，上游不识别的会忽略
      bodyObj.reasoning_effort = 'none';
      bodyObj.enable_thinking = false;
    } else if (llm.thinking && llm.thinking !== 'off') {
      bodyObj.reasoning_effort = llm.thinking;   // OpenAI o 系列与主流中转站通用
    }
    if (typeof llm.extraBody === 'string' && llm.extraBody.trim()) {
      try {
        const extra = JSON.parse(llm.extraBody);
        if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
          delete extra.messages; delete extra.stream;   // 流程关键参数不许覆盖
          Object.assign(bodyObj, extra);
        }
      } catch { /* 非法 JSON 忽略，不阻塞请求 */ }
    }
    if (llm._jsonMode && !bodyObj.response_format) {
      // v2.4.0.b：结构化输出场景（词文成章）请求 JSON 模式；服务商不支持时由上游报错或走解析兜底
      bodyObj.response_format = { type: 'json_object' };
    }
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(llm.apiKey ? { 'Authorization': 'Bearer ' + llm.apiKey } : {}),
      },
      body: JSON.stringify(bodyObj),
    });
  } catch {
    throw new Error(`无法连接 AI 服务（${llm.baseUrl}），请到「设置」检查 Base URL 与网络`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI 请求失败 (HTTP ${res.status}) ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const msg = json.choices?.[0]?.message || {};
  let content = msg.content;
  // v2.0.0.a 增强：部分中转站会把输出置于 text 字段，做兼容提取
  if (!content && json.choices?.[0]?.text) {
    content = json.choices[0].text;
  }
  // v2.3.5a 修复：思考模式开启后 content 为空时，reasoning_content 里是被 max_tokens 截断的思考过程——
  // 直接回退返回会「整条回复只剩半截思考体」。这里改为如实报错（带 finish_reason），提示调大 max_tokens 或关闭思考。
  if (!content) {
    const rc = String(msg.reasoning_content || '').trim();
    const finish = json.choices?.[0]?.finish_reason || 'unknown';
    throw new Error(
      `AI 只返回了思考过程，正文为空（finish_reason=${finish}${rc ? '，思考已生成 ' + rc.length + ' 字' : ''}）。` +
      `多为 max_tokens 被思考耗尽所致：请到设置页调大该服务商的 Max Tokens，或关闭思考等级后重试。`
    );
  }
  // v2.3.5：开启思考模式后，部分模型/中转站把思考体（<think>…</think>）混在正文里返回，统一剥离
  return stripThinkBlocks(content);
}

/** v2.3.5：剥离混入正文的思考体——成对 <think>…</think>（含 <thinking> 变体）整段删除；
 *  开标签独占段落开头（前仅空白）且无闭合时，丢弃该标签到末尾的内容（真实泄漏形态），
 *  正文句中提及 <think> 字样不受影响。只处理标签形态，不做文字启发式；仅净化不改变其余输出。 */
function stripThinkBlocks(text) {
  let out = String(text ?? '');
  out = out.replace(/<think(?:ing)?\s*>[\s\S]*?<\/think(?:ing)?\s*>/gi, '');
  out = out.replace(/(^|\n)(\s*)<think(?:ing)?\s*>[\s\S]*$/i, (m, pre) => pre);
  return out.trim();
}

/** 本地自测用的假 LLM（config.llm.mock=true 时启用） */
function mockLLM(messages) {
  const sys = messages.find(m => m.role === 'system')?.content || '';
  const user = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  if (sys.includes('质检审读员')) {   // v1.1.6：mock 审读从送审材料抽真实文本做 quote，验证定位回写链路
    const seg = user.match(/【条目#1｜[^】]*】\n([^\n【]{10,80})/) || user.match(/无结构化条目）\n([^\n【]{10,80})/);
    const quote2 = seg ? seg[1].replace(/\s+/g, ' ').trim().slice(0, 30) : '';
    // v2.1.2：附 fix 修正方案（把摘录文本中的 "the" 改成 "a"，纯自测）
    const fix2 = quote2 ? quote2.replace(/\bthe\b/i, 'a') : '';
    return JSON.stringify({ issues: [
      { loc: '条目#2', quote: quote2, fix: fix2 && fix2 !== quote2 ? fix2 : '', severity: 'low', desc: '[mock] 该条目首行疑似混入页眉' },
      { loc: '通篇', quote: '', fix: '', severity: 'mid', desc: '[mock] 无摘录的疑点示例（应无法定位）' },
    ] });
  }
  if (sys.includes('英语精读解析助手')) {   // v2.1.2：划选精读 mock
    const sel = (user.match(/【划选内容】[^：]*：([^\n]+)/) || [])[1] || user.slice(0, 60);
    const mode = (user.match(/【请求模式】：([^\n]+)/) || [])[1] || '';   // v2.3.3：回显请求模式，验证注入链路
    return `[MOCK] 划选精读自测（模式：${mode || '释义'}）：**${sel.trim()}**\n\n- 词义/整体含义：占位释义（自测数据）\n- 语境含义：在此上下文中的占位说明\n\n> 配置真实 AI 服务商后可获得准确解析。`;
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
  if (sys.includes('长难句训练教练')) {   // v2.2.5：长难句三遍法 mock
    const isReview = user.includes('复答');
    const base = [
      '## 一、句子主干',
      '[MOCK] 主语 + 谓语 + 宾语（自测占位，配置真实 AI 后生效）。',
      '',
      '## 二、从句与修饰成分',
      '[MOCK] 定语从句修饰前面的名词；非谓语作状语（自测占位）。',
      '',
      '## 三、逻辑与指代关系',
      '[MOCK] 转折与因果关系说明；代词指代前文（自测占位）。',
      '',
      '## 四、译文反馈',
      '[MOCK] 你的译文主干基本正确；注意语序与个别词义（自测占位）。',
      '',
      '## 五、建议译文',
      '[MOCK] 这是一个占位参考译文，配置真实 AI 服务商后可获得准确讲解。',
    ];
    if (isReview) base.push('', '## 六、复测对比', '[MOCK] 相较首答，结构与理解更准确；仍需注意修饰关系（自测占位）。');
    return base.join('\n');
  }
  if (sys.includes('美术指导')) {   // v1.0.6：生图提示词 mock
    const word = (user.match(/当前单词：(.+)/) || [])[1] || 'word';
    return JSON.stringify({
      prompt: `A flat-style mock mnemonic illustration for the word "${word.trim()}", bright colors`,
      caption: '[MOCK] 占位画面说明（自测数据）',
    });
  }
  if (sys.includes('词汇记忆教练')) {   // v2.4.0：词文成章 mock——严格按 story_gen schema
    const wm = user.match(/【目标单词】（共 \d+ 个）：(.+)/) || [];
    const words = (wm[1] || 'mock story word').split(',').map(s => s.trim()).filter(Boolean);
    const hookOne = { word: words[0] || 'mock', phonetic: '/mɒk/', pos: 'n.', meaning: '[MOCK] 核心义项', hook: '[MOCK] 谐音钩子：mock=某蔻，毛茸茸的故事' };
    return JSON.stringify({
      title: 'The Mock Adventure',
      passage: `Once upon a mock day, ${words.slice(0, 10).join(' and ')} met in a library. They argued about ${words[0] || 'mock'} loudly, until a librarian suggested a better plan. In the end, ${words[0] || 'mock'} became the hero of the story.`,
      hooks: words.slice(0, 30).map(w => ({ word: w, phonetic: '/mɒk/', pos: 'n.', meaning: '[MOCK] 核心义项（自测）', hook: `[MOCK] ${w} 的联想钩子` })),
      translation: '[MOCK] 这是占位中文翻译：在一个 mock 的日子里，' + words.slice(0, 10).join('和') + '在图书馆相遇……（自测数据）',
      quiz: [
        { q: `The story happened in a ___.`, options: ['library', 'stadium', 'kitchen', 'garage'], answer: 1, explain: '[MOCK] 原句定位：met in a library。' },
        { q: `${words[0] || 'mock'} finally became ___.`, options: ['the villain', 'the hero', 'a ghost', 'a driver'], answer: 2, explain: '[MOCK] 原句定位：became the hero of the story。' },
        { q: `Who suggested a better plan?`, options: ['the librarian', 'the dog', 'the teacher', 'the pilot'], answer: 1, explain: '[MOCK] 原句定位：a librarian suggested。' },
      ],
    });
  }
  if (sys.includes('词汇分类规划师')) {   // v2.4.2：词汇AI分析与篇幅建议 mock
    const wm = user.match(/【待分析单词清单】（共 \d+ 个）：([\s\S]*?)(?=\n\n|$)/) || [];
    const words = (wm[1] || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    const wCount = words.length || 1;
    return JSON.stringify({
      summary: `已对这 ${wCount} 个词汇完成语义与考研场景切片分析，识别出认知关联与搭配逻辑。`,
      recommendedLength: wCount > 25 ? 'long' : (wCount > 10 ? 'medium' : 'short'),
      lengthLabel: wCount > 25 ? '长篇拓展（建议 600~900 词）' : (wCount > 10 ? '中篇叙事（建议 350~450 词）' : '精悍短篇（建议 180~260 词）'),
      lengthReason: `本次包含 ${wCount} 个目标词，为保证各词上下文自然展开且不堆砌，推荐此篇幅。`,
      groups: [
        {
          name: '核心场景群',
          theme: '校园/科技',
          words: words.slice(0, Math.ceil(wCount / 2)),
          suggestedPlot: '以探索新知或技术挑战为叙事线索，将关键情境词自然嵌入。'
        },
        {
          name: '演化与心境群',
          theme: '反思/成长',
          words: words.slice(Math.ceil(wCount / 2)),
          suggestedPlot: '围绕面对波折后的心理蜕变或局势逆转展开。'
        }
      ].filter(g => g.words.length > 0)
    });
  }
  return `[MOCK] 收到！这是一个自测回复。（词义、例句、用法讲解在配置真实 AI 服务商后可用）\n\n关于你的问题「${user.slice(0, 60)}」：本回复来自内置 mock 模式，仅用于验证闭环。`;
}

/* ---------- v1.0.6：AI 生图（助记图） ---------- */

const IMAGE_PRESETS = {
  zhipu: { label: '智谱 CogView', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-4' },
  openai: { label: 'OpenAI DALL·E', baseUrl: 'https://api.openai.com/v1', model: 'dall-e-3' },
};

const DEFAULT_PROMPTS = {
  tutor_system: {
    id: 'tutor_system',
    title: 'AI 单词学习教练（System Prompt）',
    desc: '学习页中 AI 教练的基础系统人设与引导规则，可自定义你的专属导师风格',
    template: [
      '你是一位耐心的英语单词学习助手，面向中国学习者。',
      '规则：',
      '1. 用简体中文讲解，术语可保留英文；简洁、有重点，别写长篇大论。',
      '2. 词义、例句、搭配要准确；不确定就说不确定，不要编造。',
      '3. 例句中的目标词要自然出现，并配中文翻译。',
      '4. 主动呼应学习者的薄弱点（如给出易混词对比、记忆钩子）。',
      '5. 回复用 Markdown 轻量排版。',
      '6. 结合提供的权威词典释义、历年真题原句和外刊真实语境进行针对性讲解。',
    ].join('\n')
  },
  tutor_first_msg: {
    id: 'tutor_first_msg',
    title: '单词点击自动开场指令（User Prompt）',
    desc: '在左侧单词列表中点击单词时，前端向 AI 自动发送的第一句开场白。支持 {spelling} 占位符',
    template: '请介绍「{spelling}」的核心含义和常见考点/熟词僻义，还有最常用的搭配，然后等我提问。'
  },
  mnemonic_gen: {
    id: 'mnemonic_gen',
    title: '会话结束助记生成（System Prompt）',
    desc: '学习会话结束时，AI 根据对话历史与错词点为单词生成助记的提示词',
    template: [
      '你是英语学习教练。学习者刚结束一次单词学习会话。',
      '请根据会话内容和易错点，为每个学习过的单词生成一条个性化助记。',
      '要求：',
      '1. 助记要结合学习者在会话中暴露的具体问题（混淆的词、忘掉的义项、拼错的点），而不是泛泛的词根拆解。',
      '2. 每条助记 80 字以内，可以直接背。',
      '3. noteType 从这些里选一个最贴切的：联想/谐音/词根词缀/近反义词/辨析/固定搭配/词源/口诀/其他。',
      '4. 只输出 JSON，不要多余文字，格式：{"notes":[{"spelling":"单词","noteType":"联想","content":"助记内容"}]}',
    ].join('\n')
  },
  gloss_gen: {
    id: 'gloss_gen',
    title: '词典音标释义提取（System Prompt）',
    desc: '用于为单词表批量缓存音标、词性与核心释义的词典生成指令',
    template: [
      '你是一本英汉词典，面向中国英语学习者。',
      '对用户给出的每个单词（每行一个）输出极简词典信息。',
      '只输出 JSON，不要任何多余文字，格式：',
      '{"glosses":[{"spelling":"单词","phonetic":"/美式音标/，不确定就给空串","pos":"词性缩写如 n. v. adj.","gloss":"最核心的 1-2 个中文释义，30 字内"}]}',
      '规则：每个输入单词都必须有一条；音标不确定给空串，严禁编造；释义要优先最常用的高频核心义项。',
    ].join('\n')
  },
  image_prompt: {
    id: 'image_prompt',
    title: '生图画面描述改写（System Prompt）',
    desc: '根据单词含义与学习场景生成英文生图 Prompt 的美术指导提示词',
    template: [
      '你是记忆图片的美术指导，面向中国英语学习者。',
      '根据当前学习的单词和最近的对话场景，构思一幅"助记图"：把单词的核心义项/记忆钩子画成一个具体、夸张、好记的画面。',
      '只输出 JSON，不要任何多余文字，格式：{"prompt":"英文画面提示词","caption":"中文一句话说明画面与记忆点"}',
      '规则：prompt 用英文、一个场景、主体明确、风格统一（明快扁平插画），60 词以内；caption 30 字内点出记忆钩子。',
    ].join('\n')
  },
  quality_review: {
    id: 'quality_review',
    title: '语料与真题质检审读员（System Prompt）',
    desc: '对导入的真题或语料进行结构化对比、错字错题校验的质检提示词',
    template: [
      '你是材料的质检审读员。审核对象是【整理后的题库/语料内容】（含 〖N〗 挖空/划线锚点）和可选的【真题原件参考】。',
      '你的职责是核对「整理结果」是否忠实于【真题原件参考】（有无解析/整理引入的缺损），而不是校对英文本身。',
      '对照找出解析/整理引入的问题，例如：句子残缺或截断、乱码与字形损坏、题号断档或重复、选项丢失或错位、段落错序、页眉页脚水印混入、明显重复段落、整理结果与原件不符。',
      '重要规则：',
      '1. 只报告有把握、能在材料中定位的问题；不要把送审材料自身的完整性当成语料问题；不要臆测内容含义；不要改写文本。',
      '1a. 原件中已有的写法一律不是问题——包括原件自身的拼写错误、语法不一致、专有名词特殊写法（如 Au Bong Pain / Gallileo）、看似矛盾的用词、原卷的标点习惯等。只要整理结果与原件一致，就不得报告（例如：整句话与原件逐字相同，即使拼写看起来有误，也不要报）。',
      '1b. 只有「整理结果」与「原件」确实不同、或语句被截断/丢词/夹杂水印而原件没有时，才算问题。不要仅凭英文常识判断对错。',
      '2. 每个问题必须给 quote 字段：从材料中逐字摘录有误处的原文片段（10~40 字，须与材料完全一致，可包含 〖N〗 标记）。',
      '3. v2.1.2：每个问题必须尽量给出 fix 字段——用于替换 quote 的修正文本（只修正该片段本身的错误，保持其余内容与 〖N〗 锚点原样；无把握时留空字符串）。',
      '4. 严格输出 JSON（不要 markdown 代码块包裹）：{"issues":[{"loc":"位置(条目#或题号)","quote":"逐字摘录","fix":"修正后的替换文本(可为空)","severity":"high|mid|low","desc":"问题描述(60字内)"}]}；没有问题输出 {"issues":[]}。',
    ].join('\n')
  },
  selection_learn: {
    id: 'selection_learn',
    title: '划线精读解析（System Prompt）',
    desc: '阅读材料时划选单词/词组/句子，AI 按类型给出词义、语境含义、词组释义或地道翻译',
    template: [
      '你是英语精读解析助手，面向中国考研学生。用户正在阅读考研英语真题或外刊材料，并划选了其中一段文本。',
      '请根据【划选内容】与【上下文】判断类型并解析：',
      '- 单词：先给核心词义（含词性），再结合上下文说明它在此处的语境含义；若它在文中属于固定搭配/词组，补充该词组的含义与用法。',
      '- 词组：给出该词组/搭配的整体含义与常见用法，并说明它在当前语境中的意思。',
      '- 句子：结合全文语境给出地道、自然的中文翻译；可附一句简短翻译要点（如长难句结构、指代关系）。',
      '要求：准确、简洁、有针对性；确实不确定的内容不要编造；用 Markdown 轻量排版（可用加粗与列表，不要长篇大论）。',
    ].join('\n')
  },
  quality_review_item: {
    id: 'quality_review_item',
    title: '单条目编辑复核审读员（System Prompt）',
    desc: '用户手动编辑真题条目后，AI 依据原件段落对该单条进行复核的提示词',
    template: [
      '你是考研英语真题语料的质检审读员。审核对象是【单个条目的当前文本】（刚被用户编辑过），比对依据是【真题原件相关段落】。',
      '只报告能与原件比对确认的问题：句子残缺或截断、乱码、挖空/划线锚点（〖N〗或〖/N〗）缺失或破坏、明显重复、页眉页脚水印混入、当前文本与原件不符。',
      '重要：原件本身的内容不是问题；拿不准、无法与原件比对确认的，一律输出 {"ok":true}——宁可放过，不可杜撰。',
      '严格输出 JSON（不要 markdown 代码块包裹）：{"ok":true} 表示质量合格；{"ok":false,"issues":[{"desc":"问题描述(60字内)","suggestion":"给用户的修改建议(120字内)"}]} 表示仍有问题——suggestion 必填，且建议里的英文措辞必须来自原件或当前文本，不得杜撰原件中不存在的句子。',
    ].join('\n')
  },
  sentence_training: {
    id: 'sentence_training',
    title: '长难句三遍法训练（System Prompt）',
    desc: '长难句“结构分析 → 自译 → 分层反馈 → 3 天复测”的分层讲解与复测对比提示词',
    template: [
      '你是考研英语长难句训练教练，面向中国考研学生。学习者先完成【结构分析】和【自译】，再由你给出分层反馈。',
      '首次反馈必须固定输出以下五个 Markdown 小节，标题逐字使用，不得增减：',
      '## 一、句子主干',
      '## 二、从句与修饰成分',
      '## 三、逻辑与指代关系',
      '## 四、译文反馈',
      '## 五、建议译文',
      '要求：',
      '1. 「主干」先给出主句的主语、谓语、宾语/表语；「从句与修饰」逐层拆出定语从句、状语从句、非谓语、插入语等，并说明各自修饰对象。',
      '2. 「逻辑与指代」说清连接词、转折/因果、代词与省略的所指。',
      '3. 「译文反馈」先肯定学习者译文中正确的部分，再指出误译、漏译、语序或术语问题，逐条对应；不要空泛夸奖。',
      '4. 「建议译文」给出一版通顺、忠实、符合中文表达习惯的参考译文。',
      '5. 只针对本句讲解，不编造原文没有的背景；不确定的地方如实说明。',
      '6. 复测场景下（输入含【首答】【首轮反馈】【复答】），额外在末尾输出：',
      '## 六、复测对比',
      '明确写出相较首答的改善点与仍存在的问题，只作定性比较，禁止输出任何虚构的分数或等级。',
    ].join('\n')
  },
  story_gen: {
    id: 'story_gen',
    title: '词文成章：选词生成记忆故事（System Prompt）',
    desc: '把学习者选定的单词写进一篇连贯英文短文（语境记忆），并为每个词配记忆钩子（关键词法），附中文翻译与自测题',
    template: [
      '【输出格式铁律】你的全部回复必须是一个可被 JSON.parse 直接解析的单个 JSON 对象，第一个字符必须是 {，最后一个字符必须是 }。禁止输出任何解释、前言、后记、Markdown 代码块围栏或纯文本文章。',
      '你是考研英语词汇记忆教练，面向中国考研学生。把用户选定的单词写进一篇便于记忆的英文短文。',
      '要求：',
      '1. 用【目标单词】清单里的每个单词至少一次（原形或标注了词形的变形），全部覆盖，不得遗漏；优先使用考研高频义项。',
      '2. 短文情节连贯、有画面感、略带幽默或戏剧性更好记；题材按用户指定；难度对标考研阅读（高考纲内词汇为主，超纲词最多 3 个）。',
      '3. 目标单词在短文中原样出现（变形时在 hooks 里标注），便于前端加粗高亮。',
      '4. hooks：每个目标词一条 {word, phonetic, pos, meaning, hook}——phonetic 美式音标（不确定给空串）、pos 词性缩写、meaning 考研核心义项（15字内）、hook 一句中文记忆钩子（谐音/联想/词根拆解，25字内，具体不空泛）。',
      '5. translation：全文通顺中文翻译。',
      '6. quiz：5 道选择题 {q, options:[4个], answer(1-4), explain(40字内)}——3 道用短文原句挖空目标词，2 道选义；干扰项来自目标词表或形近词。',
      '7. JSON 必须包含全部五个字段：title、passage、hooks、translation、quiz，缺一不可（hooks 数组元素数 = 目标词数，quiz 数组元素数 = 5）。',
      '8. 完整示例（3 词的迷你样例，展示结构——你生成时按目标词数量与篇幅扩展）：',
      '{"title":"The Last Train","passage":"The station was nearly empty...（完整英文正文）","hooks":[{"word":"desperate","phonetic":"/ˈdespərət/","pos":"adj.","meaning":"不顾一切的；绝望的","hook":"谐音：德斯珀雷特，德行绝望了就不顾一切"},{"word":"commute","phonetic":"/kəˈmjuːt/","pos":"v./n.","meaning":"通勤","hook":"com(共同)+mute(移动)→大家共同移动=通勤"},{"word":"scramble","phonetic":"/ˈskræmbl/","pos":"v.","meaning":"争夺；爬行","hook":"scram(爬)+ble→争着往上爬"}],"translation":"（完整中文翻译）","quiz":[{"q":"The passengers ___ for the last seats on the train.","options":["scrambled","strolled","zoomed","melted"],"answer":1,"explain":"scramble for 争夺，符合末节车厢拥挤场景。"},{"q":"A ___ worker takes the same train every morning.","options":["commute","commuting","commuted","commuter"],"answer":4,"explain":"commuter 通勤者，作名词。"},{"q":"desperate 的核心含义是？","options":["高兴的","不顾一切的","缓慢的","富有的"],"answer":2,"explain":"desperate 绝望的/不顾一切的。"},{"q":"文中谁最终赶上了火车？","options":["the guard","the narrator","the driver","nobody"],"answer":2,"explain":"结尾处 narrator 挤上了末班车。"},{"q":"commute 在文中的词性是？","options":["名词","动词","形容词","副词"],"answer":1,"explain":"文中用作动词，表示通勤。"}]}',
      '再次强调：回复只能是这样一个完整 JSON 对象。passage 字段里放英文正文；五个字段一个都不能少。',
    ].join('\n')
  },
  story_analyze: {
    id: 'story_analyze',
    title: '词文成章：词汇分析与篇幅建议（System Prompt）',
    desc: '分析用户选中的单词列表，梳理词义逻辑、考研搭配关联，给出合理的情景/语义分类和篇幅建议',
    template: [
      '你是考研英语教学专家与词汇分类规划师。学习者选定了一组单词，准备编写故事来背诵记忆。',
      '请根据给出的【待分析单词清单】（可能包含几个到几十个词），进行深入的语义/考研场景分析并给出最佳规划方案。',
      '任务要求：',
      '1. 【词汇分类与情节线索】：分析词群之间的逻辑关联（如因果、对立、工作科研场景、情感态度等），将词汇合理划分为 1~4 个场景或情节子群（每个群包含名称、推荐题材、包含单词列表、推荐情节构想）。',
      '2. 【篇幅与节奏建议】：结合总词数与词义复杂度，科学评估最易于吸收记忆的故事篇幅（短篇 180~260 词 / 中篇 350~450 词 / 长篇 600~900 词），给出推荐理由。',
      '3. 【结构化输出格式】：严格输出单个合法的 JSON 对象（禁止包含 markdown 代码块包裹，首字符 {，末字符 }）：',
      '{"summary":"一两句整体分析，点明这批词在考研语境或逻辑上的核心关联","recommendedLength":"short|medium|long","lengthLabel":"精悍短篇（180~260词）|中篇叙事（350~450词）|长篇拓展（600~900词）","lengthReason":"推荐该篇幅的具体理由","groups":[{"name":"分组名称","theme":"建议题材如科幻/校园/职场/悬疑等","words":["单词1","单词2"],"suggestedPlot":"该组词在此题材中的情节推进与记忆线索"}]}',
      '严禁在 JSON 之外输出任何文字。',
    ].join('\n')
  }
};

function getPrompt(key, fallback) {
  if (config.diyPrompts && config.diyPrompts[key]?.current) {
    return config.diyPrompts[key].current;
  }
  return DEFAULT_PROMPTS[key]?.template || fallback || '';
}

/* v2.4.1：词文成章题材清单——config.storyThemes 自定义优先，缺省内置 16 题材 */
const STORY_THEMES_BUILTIN = ['随缘', '校园', '科幻', '悬疑', '职场', '旅行', '童话', '冒险', '美食', '体育', '侦探', '西部', '宫斗', '末日', '神话', '赛博朋克'];
function storyThemesList() {
  if (Array.isArray(config.storyThemes) && config.storyThemes.length) {
    return config.storyThemes.map(t => String(t || '').trim()).filter(Boolean).slice(0, 40);
  }
  return STORY_THEMES_BUILTIN;
}

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
      { role: 'system', content: getPrompt('image_prompt') },
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

/* ---------- v2.0.0：题库 / 语料库 / 外刊发布源 ---------- */
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
let externalCache = { mtime: 0, records: [] };

function kbFile() {
  const dir = (config.kb && config.kb.dir || '').trim();
  return dir ? path.resolve(dir, 'records.jsonl') : CORPUS_FILE;
}

function externalCorpusDir() {
  const configured = (config.kb && config.kb.externalDir || process.env.EXTERNAL_CORPUS_DIR || '').trim();
  return configured ? path.resolve(configured) : EXTERNAL_CORPUS_DEFAULT_DIR;
}

function externalArticlesFile() { return path.join(externalCorpusDir(), 'articles.jsonl'); }
function externalManifestFile() { return path.join(externalCorpusDir(), 'manifest.json'); }

function externalText(r) {
  if (typeof r.text === 'string' && r.text.trim()) return r.text;
  const ps = Array.isArray(r.paragraphs) ? r.paragraphs : r.content?.paragraphs;
  if (!Array.isArray(ps)) return '';
  return ps.map(p => typeof p === 'string' ? p : String(p?.text || '')).filter(Boolean).join('\n\n');
}

/** 外刊发布源只接受 article，兼容 scraper 的 paragraphs/content 两种正文形态。 */
function normalizeExternalRecord(r) {
  if (!r || !r.id || r.rtype !== 'article') return null;
  const source = { ...(r.source || {}), category: '外刊', managed: 'external' };
  const published = source.published_at || source.date || r.meta?.published_at || '';
  if (published && !source.published_at) source.published_at = published;
  const meta = { ...(r.meta || {}) };
  if (!meta.year && /^\d{4}/.test(String(published))) meta.year = Number(String(published).slice(0, 4));
  const text = externalText(r);
  return { ...r, rtype: 'article', text, source, meta, external: true };
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

/** v2.0.0：读取采集管线发布的外刊快照；此库由发布流程写入，网站端只读。 */
function loadExternalKb() {
  const file = externalArticlesFile();
  if (!fs.existsSync(file)) { externalCache = { mtime: 0, records: [] }; return []; }
  const mtime = fileMtime(file);
  if (externalCache.mtime !== mtime) {
    externalCache = { mtime, records: readJsonlRaw(file).map(normalizeExternalRecord).filter(Boolean) };
  }
  return externalCache.records;
}

function externalStatus() {
  const file = externalArticlesFile();
  const manifestFile = externalManifestFile();
  const manifest = loadJSON(manifestFile, null);
  return {
    dir: externalCorpusDir(),
    file,
    manifestFile,
    exists: fs.existsSync(file),
    count: loadExternalKb().length,
    manifest: manifest && typeof manifest === 'object' ? {
      release_id: manifest.release_id || manifest.releaseId || '',
      generated_at: manifest.generated_at || manifest.generatedAt || '',
      article_count: manifest.article_count ?? manifest.articleCount ?? null,
      schema_version: manifest.schema_version ?? manifest.schemaVersion ?? null,
    } : null,
  };
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
  // v2.0.0：索引覆盖手工语料 + 外刊发布源 + 真题库，任一文件变化即重建
  const key = `${fileMtime(kbFile())}|${fileMtime(externalArticlesFile())}|${fileMtime(examsFile())}`;
  if (kbCache.sentences && kbCache.sentencesKey === key) return kbCache.sentences;
  const out = [];
  for (const r of [...loadKb(), ...loadExternalKb(), ...loadExams()]) {
    const sourceKind = r.external ? 'external' : (r.rtype === 'qa_set' ? 'exam' : 'corpus');
    const year = r.meta?.year || (r.source?.published_at && /^\d{4}/.test(r.source.published_at) ? Number(r.source.published_at.slice(0, 4)) : null);
    const title = r.title || '';
    const items = Array.isArray(r.items) && r.items.length
      ? r.items
      : [{ type: 'passage', section: null, number: null, text: r.text || '' }];
    for (const it of items) {
      for (const s of kbSentenceSplit(it.text || '')) {
        out.push({
          rid: r.id,
          title,
          year,
          section: it.section || null,
          number: it.number ?? null,
          sourceKind,
          publication: r.source?.publication || r.source?.source || '',
          sourceUrl: r.source?.canonical_url || r.source?.url || '',
          s,
        });
      }
    }
  }
  kbCache.sentences = out;
  kbCache.sentencesKey = key;
  return out;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** v2.2.8：原地 Fisher-Yates 洗牌（迁移题选项/干扰项随机化复用） */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * v2.0.1 单词词形生成器（Lemmatizer / Inflections）
 * 针对单词形态变化导致语料命中率偏低的问题，生成完整的英文屈折变体：
 * 1. 原形
 * 2. 复数 / 第三人称单数：-s, -es, -ies (study -> studies)
 * 3. 过去式 / 过去分词：-ed, -d, -ied, 双写辅音 (stop -> stopped, prefer -> preferred)
 * 4. 现在分词 / 进行时：-ing, 去e加ing (make -> making), 双写加ing (run -> running), -ying (die -> dying)
 * 5. 形容词副词比较级/最高级：-er, -est, -r, -st, -ier, -iest, -ly
 */
function getWordInflections(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w || !/^[a-z][a-z'\-]{1,29}$/.test(w)) return [];
  const forms = new Set([w]);

  // 辅音字母判断
  const isVowel = c => ['a','e','i','o','u'].includes(c);
  const len = w.length;
  const last1 = w[len - 1];
  const last2 = len > 1 ? w.slice(-2) : '';

  // 1. 复数 / 三单
  if (w.endsWith('y') && len > 2 && !isVowel(w[len - 2])) {
    forms.add(w.slice(0, -1) + 'ies'); // carry -> carries
  } else if (w.endsWith('s') || w.endsWith('x') || w.endsWith('z') || w.endsWith('ch') || w.endsWith('sh')) {
    forms.add(w + 'es');
  } else {
    forms.add(w + 's');
  }

  // 2. 过去式 / 分词 (-ed)
  if (w.endsWith('e')) {
    forms.add(w + 'd'); // live -> lived, prosecute -> prosecuted
  } else if (w.endsWith('y') && len > 2 && !isVowel(w[len - 2])) {
    forms.add(w.slice(0, -1) + 'ied'); // apply -> applied
  } else {
    forms.add(w + 'ed');
    // 双写规则检测 (重读闭音节单辅音结尾：如 stop -> stopped, plan -> planned)
    if (len >= 3 && !isVowel(last1) && isVowel(w[len - 2]) && !isVowel(w[len - 3]) && !['w','x','y'].includes(last1)) {
      forms.add(w + last1 + 'ed');
    }
  }

  // 3. 现在分词 (-ing)
  if (w.endsWith('ie') && len > 2) {
    forms.add(w.slice(0, -2) + 'ying'); // die -> dying, tie -> tying
  } else if (w.endsWith('e') && !w.endsWith('ee')) {
    forms.add(w.slice(0, -1) + 'ing'); // write -> writing, prosecute -> prosecuting
  } else {
    forms.add(w + 'ing');
    // 双写 -ing
    if (len >= 3 && !isVowel(last1) && isVowel(w[len - 2]) && !isVowel(w[len - 3]) && !['w','x','y'].includes(last1)) {
      forms.add(w + last1 + 'ing');
    }
  }

  // 4. 形容词副词派生（如有 -er, -est, -ly）
  if (w.endsWith('e')) {
    forms.add(w + 'r');
    forms.add(w + 'st');
  } else if (w.endsWith('y') && len > 2 && !isVowel(w[len - 2])) {
    forms.add(w.slice(0, -1) + 'ier');
    forms.add(w.slice(0, -1) + 'iest');
    forms.add(w.slice(0, -1) + 'ily');
  } else {
    forms.add(w + 'er');
    forms.add(w + 'est');
    forms.add(w + 'ly');
  }

  return [...forms];
}

/**
 * 全库句子搜索。v2.0.1 升级：融合多词形还原变体匹配，大幅提升真题与外刊命中率。
 * 中文按包含匹配。返回句子来源类型和 URL，供网站展示与 AI 分通道引用。
 */
function kbSearch(query, limit = 30, sourceKind = 'all') {
  const q = String(query || '').trim();
  if (!q || q.length > 100) return [];
  const lower = q.toLowerCase();
  const isAscii = /^[\x20-\x7e]+$/.test(q);
  
  let re = null;
  if (isAscii) {
    // 获取全部变体词形构建高性能正则词界匹配
    const inflections = getWordInflections(lower);
    if (inflections.length > 0) {
      re = new RegExp(`\\b(?:${inflections.map(escapeRegExp).join('|')})\\b`, 'i');
    } else {
      re = new RegExp(`\\b${escapeRegExp(lower)}(?:s|es|ed|d|ing)?\\b`, 'i');
    }
  }

  const out = [];
  const seen = new Map();   // 同句去重（翻译原文与题干可能重复收录），优先保留带题号的来源
  for (const item of kbSentences()) {
    if (sourceKind !== 'all' && item.sourceKind !== sourceKind) continue;
    const hit = re ? re.test(item.s) : item.s.toLowerCase().includes(lower);
    if (!hit) continue;
    const key = item.s.toLowerCase();
    const prev = seen.get(key);
    if (prev === undefined) { seen.set(key, out.length); out.push(item); }
    else {
      const rank = x => x.sourceKind === 'exam' ? 0 : x.sourceKind === 'corpus' ? 1 : 2;
      if ((item.number != null && out[prev].number == null) || rank(item) < rank(out[prev])) out[prev] = item;
    }
  }
  return limit > 0 ? out.slice(0, limit) : out;
}

/** v2.0.0：为 AI 提供分通道证据，避免外刊挤掉真题或被误标为真题。 */
function kbEvidenceForWord(word, examLimit = 2, externalLimit = 2) {
  const w = String(word || '').trim();
  if (!w || !/^[a-zA-Z][a-zA-Z'\-]{1,29}$/.test(w)) return { exams: [], external: [], corpus: [] };
  const hits = kbSearch(w, 0);
  return {
    exams: hits.filter(h => h.sourceKind === 'exam').slice(0, examLimit),
    external: hits.filter(h => h.sourceKind === 'external').slice(0, externalLimit),
    corpus: hits.filter(h => h.sourceKind === 'corpus').slice(0, 2),
  };
}

/** 兼容旧调用：返回混合搜索结果；AI 新路径使用 kbEvidenceForWord。 */
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
    source: r.source ? {
      file: r.source.file,
      parser: r.source.parser,
      imported_at: r.source.imported_at,
      category: r.source.category,
      managed: r.source.managed || (r.external ? 'external' : 'managed'),
      publication: r.source.publication || r.source.source || '',
      published_at: r.source.published_at || r.source.date || '',
      canonical_url: r.source.canonical_url || r.source.url || '',
    } : null,
    quality: r.quality || null,
    external: !!r.external,
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
    // v2.1.1：真题库新增 mineru md 结构化通道（扫描件经 MinerU 版面还原后拆题入库）
    const examMineruMd = store === 'exam' && ext === '.md' && parserTag === 'mineru-api';
    if (store === 'exam' && ext !== '.tex' && ext !== '.pdf' && !examMineruMd) {
      parsed = { ok: false, reason: `真题库仅支持 tex / pdf 结构化源（收到 ${ext || '无扩展名'}）`, hint: '文章、笔记类内容请到「📚 语料库」导入' };
    } else if (examMineruMd) {
      parsed = await kbParseWithPython('md', srcPath);
      if (parsed.ok) parser = parsed.parser || 'mineru-md-parser';
    } else if (ext === '.txt' || ext === '.md' || ext === '') {
      const text = kbDecode(buf);
      const m = text.match(/^#\s+(.+)$/m);
      parser = parserTag || (category === '外刊' ? 'manual-text' : 'plain-text');
      // v2.0.1：网页选择“外刊”上传 TXT/MD 时按文章处理，保留为可编辑手工语料。
      const rtype = category === '外刊' ? 'article' : 'note';
      parsed = { ok: true, records: [{ rtype, title: m ? m[1].trim() : safe, text, meta: { chars: text.length } }] };
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
    r.source = {
      file: safe,
      category,
      parser,
      imported_at: now,
      managed: 'manual',
      origin: 'web_upload',
    };
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

/** v2.0.0：按 id 定位可写库；外刊发布源单独标记为只读。 */
function kbFindStoreOf(id) {
  if (loadExams().some(r => r.id === id)) return 'exam';
  if (loadKb().some(r => r.id === id)) return 'corpus';
  if (loadExternalKb().some(r => r.id === id)) return 'external';
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

/* ---------- v2.1.2：记录修改版本历史（每个记录保留最近 5 个版本，可回溯） ---------- */

const KB_VERSIONS_FILE = path.join(DATA_DIR, 'kb_versions.json');
const KB_VERSION_MAX = 5;

function loadKbVersions() {
  const v = loadJSON(KB_VERSIONS_FILE, {});
  return (v && typeof v === 'object') ? v : {};
}
function saveKbVersions(v) { saveJSON(KB_VERSIONS_FILE, v); }

/** 记录一次版本快照（在写入新内容前调用，保存的是「修改前」的旧内容） */
function kbPushVersion(id, store, rec, note) {
  try {
    const all = loadKbVersions();
    const list = Array.isArray(all[id]) ? all[id] : [];
    list.unshift({
      ts: new Date().toISOString().slice(0, 19),
      store,
      title: rec.title || '',
      text: String(rec.text || '').slice(0, 2e6),
      items: Array.isArray(rec.items) ? rec.items : undefined,
      edited_at: rec.edited_at || null,
      note: String(note || '').slice(0, 120),
    });
    all[id] = list.slice(0, KB_VERSION_MAX);
    // 全局防膨胀：最多保留 200 个记录的版本（超出按最新快照时间淘汰）
    const ids = Object.keys(all);
    if (ids.length > 200) {
      ids.sort((a, b) => String(all[a]?.[0]?.ts || '').localeCompare(String(all[b]?.[0]?.ts || '')));
      for (const k of ids.slice(0, ids.length - 200)) delete all[k];
    }
    saveKbVersions(all);
    return true;
  } catch { return false; }
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
  const baseTutor = getPrompt('tutor_system');
  const lines = [baseTutor];
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

/* ---------- v1.0.4：AI 词典缓存（音标/词性/核心释义） ---------- */

async function ensureGlosses(spellings) {
  const missing = [...new Set(spellings)].filter(sp => sp && !db.glosses[sp]);
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    try {
      const text = await llmChat([
        { role: 'system', content: getPrompt('gloss_gen') },
        { role: 'user', content: chunk.join('\n') },
      ], { maxTokens: 800 });
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

/** 记录测验结果：反哺「我又忘了」体系（写入 word.quizResponse，供忘记词/模糊词筛选）
 *  v2.2.1：双写统一学习流水（word_quiz attempt），单题采集信心/耗时/作答值，服务端权威释义 expected 防篡改
 */
function applyQuizResults(results, mode) {
  let applied = 0;
  const attemptsToSave = [];

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

    // 服务端权威释义作为 expected，禁止信任客户端上报
    const stdGloss = (db.glosses && db.glosses[sp])
      ? (typeof db.glosses[sp] === 'string' ? db.glosses[sp] : db.glosses[sp].gloss || '')
      : '';

    // 映射 FAMILIAR/VAGUE/FORGET 到标准 attempt result
    const attemptResult = resp === 'FAMILIAR' ? 'correct' : resp === 'VAGUE' ? 'vague' : 'incorrect';

    let conf = r.confidence ? String(r.confidence).trim() : 'unsure';
    if (!VALID_ATTEMPT_CONFIDENCES.has(conf)) conf = 'unsure';

    const itemMode = String(r.mode || mode || 'flash').slice(0, 20);
    const userAnswer = r.userAnswer !== undefined && r.userAnswer !== null
      ? String(r.userAnswer).slice(0, 4000)
      : resp;

    attemptsToSave.push({
      kind: 'word_quiz',
      source: 'quiz',
      itemId: `word:${sp}`,
      section: 'vocabulary',
      prompt: sp,
      expected: stdGloss,
      answer: userAnswer,
      result: attemptResult,
      confidence: conf,
      startedAt: r.startedAt || null,
      submittedAt: r.submittedAt || new Date().toISOString(),
      durationMs: r.durationMs !== undefined ? r.durationMs : null,
      meta: {
        mode: itemMode,
        word: sp,
        response: resp,
      },
    });
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

  let attemptsSaved = 0;
  if (attemptsToSave.length > 0) {
    attemptsSaved = appendLearningAttempts(attemptsToSave);
  }

  return { applied, attemptsSaved };
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

  const system = getPrompt('mnemonic_gen');
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
    // v2.0.0.a：如果超过设定的时间间隔未曾同步过，启动后 10 秒内立即执行一次预热后台同步
    const lastSyncMs = db.lastSync ? new Date(db.lastSync).getTime() : 0;
    if (Date.now() - lastSyncMs >= ms) {
      setTimeout(() => {
        runSync('auto-startup').catch(e => logSync(false, '启动自动同步异常: ' + e.message));
      }, 10000);
    }
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

  // v1.2.1：考研倒计时（每年 12 月最后一个周末，约 12-20 ~ 12-28 之间，取 12-21 作近似值）
  const yr = new Date().getFullYear();
  const examDate = new Date(`${today > `${yr}-06-01` ? yr : yr}-12-21T00:00:00+08:00`);
  if (examDate.getTime() < Date.now()) examDate.setFullYear(examDate.getFullYear() + 1);
  const daysLeft = Math.ceil((examDate.getTime() - Date.now()) / 86400000);

  // 连续打卡天数 (streak)：从今天/昨天向前数连续有学习记录的天数
  let streak = 0;
  const startCheck = progress && progress.finished > 0 ? 0 : -1; // 今天有数据从今天开始，否则从昨天
  for (let i = startCheck; i >= -365; i--) {
    const key = bjDate(i);
    const rec = db.progressHistory.find(x => x.date === key);
    if (rec && rec.finished > 0) streak++;
    else break;
  }

  // 词汇掌握度分布
  const mastery = { wellFamiliar: wellFamiliar.length, sticky: sticky.length, forget: 0, vague: 0, other: 0 };
  for (const w of words) {
    if (w.tags?.includes('WELL_FAMILIAR') || w.tags?.includes('STICKING')) continue;
    if (w.lastResponse === 'FORGET' || w.quizResponse === 'FORGET') mastery.forget++;
    else if (w.lastResponse === 'VAGUE' || w.quizResponse === 'VAGUE') mastery.vague++;
    else mastery.other++;
  }

  // 测验统计
  const quizStats = { total: db.quizLog.length, recent: db.quizLog.slice(0, 5) };
  if (db.quizLog.length) {
    const all = db.quizLog;
    quizStats.totalQ = all.reduce((s, q) => s + (q.total || 0), 0);
    quizStats.totalCorrect = all.reduce((s, q) => s + (q.familiar || 0), 0);
    quizStats.avgRate = quizStats.totalQ ? Math.round(quizStats.totalCorrect / quizStats.totalQ * 100) : 0;
  }

  // 单元做题统计
  const unitStats = { total: db.unitLog.length, correct: 0, judged: 0 };
  for (const u of db.unitLog) { unitStats.correct += u.correct || 0; unitStats.judged += u.judged || 0; }

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
    // v1.2.1：考研增强
    kaoyan: { daysLeft, examDate: examDate.toISOString().slice(0, 10) },
    streak,
    mastery,
    quizStats,
    unitStats,
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
            vision: !!getProvider()?.vision,   // v2.3.4：默认服务商是否开启视觉能力（前端控制图片按钮显隐）
          },
          lastSync: db.lastSync,
          lastSyncOk: db.lastSyncOk,
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
              temperature: pr.temperature, max_tokens: pr.max_tokens, models: pr.models,
              thinking: pr.thinking || 'off', extraBody: pr.extraBody || '', vision: !!pr.vision,   // v2.3.4：模型服务高级三项
            })),
          },
          autoSync: config.autoSync,
          diyPrompts: (() => {
            const out = {};
            for (const [k, v] of Object.entries(DEFAULT_PROMPTS)) {
              const userConf = config.diyPrompts?.[k] || {};
              out[k] = {
                id: v.id,
                title: v.title,
                desc: v.desc,
                template: v.template,
                current: userConf.current || v.template,
                history: Array.isArray(userConf.history) ? userConf.history : [],
              };
            }
            return out;
          })(),
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
          selection: {
            providerId: (config.selection && config.selection.providerId) || '',
            model: (config.selection && config.selection.model) || '',
          },
          story: {
            providerId: (config.story && config.story.providerId) || '',
            model: (config.story && config.story.model) || '',
          },
          storyThemes: storyThemesList(),   // v2.4.1：文章题材（自定义或内置）
          kb: {
            dir: (config.kb && config.kb.dir) || '',
            externalDir: (config.kb && config.kb.externalDir) || '',
            pythonPath: (config.kb && config.kb.pythonPath) || '',
            categories: KB_CATEGORIES,
            file: kbFile(),
            exists: fs.existsSync(kbFile()),
            count: loadKb().length,
            external: externalStatus(),
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
              // v2.1.0：完整模型参数入库（参考 Cherry Studio，预设自带 temperature / max_tokens 等）
              const out = {
                id,
                name: String(pr.name || '服务商').slice(0, 30),
                baseUrl: String(pr.baseUrl || '').trim(),
                model: String(pr.model || '').trim(),
                apiKey: (typeof pr.apiKey === 'string' && pr.apiKey.trim()) ? pr.apiKey.trim() : (old?.apiKey || ''),
              };
              if (pr.temperature !== undefined && pr.temperature !== '') out.temperature = Math.max(0, Math.min(2, Number(pr.temperature)));
              else if (old?.temperature !== undefined) out.temperature = old.temperature;
              if (pr.max_tokens !== undefined && pr.max_tokens !== '') out.max_tokens = Math.max(1, Math.min(128000, Number(pr.max_tokens)));
              else if (old?.max_tokens !== undefined) out.max_tokens = old.max_tokens;
              if (pr.models !== undefined) out.models = Array.isArray(pr.models) ? pr.models.slice(0, 100) : old?.models;
              else if (old?.models !== undefined) out.models = old.models;
              // v2.3.4：模型服务高级三项——思考等级 / JSON 参数透传 / 视觉能力
              if (pr.thinking !== undefined) out.thinking = ['off', 'low', 'medium', 'high'].includes(pr.thinking) ? pr.thinking : 'off';
              else if (old?.thinking) out.thinking = old.thinking;
              if (pr.extraBody !== undefined) out.extraBody = String(pr.extraBody || '').slice(0, 2000);
              else if (old?.extraBody) out.extraBody = old.extraBody;
              if (pr.vision !== undefined) out.vision = !!pr.vision;
              else if (old?.vision) out.vision = old.vision;
              return out;
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
        // v2.1.0：DIY 模型提示词自定义保存（附带索引与最近5条历史记录）
        if (body.diyPrompts && typeof body.diyPrompts === 'object') {
          if (!config.diyPrompts) config.diyPrompts = {};
          for (const [k, pVal] of Object.entries(body.diyPrompts)) {
            if (typeof pVal === 'string' && DEFAULT_PROMPTS[k]) {
              const oldEntry = config.diyPrompts[k] || { current: DEFAULT_PROMPTS[k].template, history: [] };
              const trimmed = pVal.trim();
              if (trimmed && trimmed !== oldEntry.current) {
                const history = Array.isArray(oldEntry.history) ? [...oldEntry.history] : [];
                // 存入当前旧值至最近5条历史
                if (oldEntry.current) {
                  history.unshift({ time: new Date().toISOString(), text: oldEntry.current });
                }
                config.diyPrompts[k] = {
                  current: trimmed,
                  history: history.slice(0, 5) // 最多保存 5 条
                };
              }
            } else if (pVal && typeof pVal === 'object' && pVal.reset) {
              // 恢复默认提示词
              if (DEFAULT_PROMPTS[k]) {
                const oldEntry = config.diyPrompts[k] || { current: '', history: [] };
                const history = Array.isArray(oldEntry.history) ? [...oldEntry.history] : [];
                if (oldEntry.current && oldEntry.current !== DEFAULT_PROMPTS[k].template) {
                  history.unshift({ time: new Date().toISOString(), text: oldEntry.current });
                }
                config.diyPrompts[k] = {
                  current: DEFAULT_PROMPTS[k].template,
                  history: history.slice(0, 5)
                };
              }
            }
          }
        }
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
        // v2.3.4：划词助手专用模型配置持久化
        if (body.selection && typeof body.selection === 'object') {
          if (!config.selection || typeof config.selection !== 'object') config.selection = { providerId: '', model: '' };
          if (body.selection.providerId !== undefined) config.selection.providerId = String(body.selection.providerId || '').trim();
          if (body.selection.model !== undefined) config.selection.model = String(body.selection.model || '').trim();
        }
        // v2.4.1：词文成章专用模型配置持久化
        if (body.story && typeof body.story === 'object') {
          if (!config.story || typeof config.story !== 'object') config.story = { providerId: '', model: '' };
          if (body.story.providerId !== undefined) config.story.providerId = String(body.story.providerId || '').trim();
          if (body.story.model !== undefined) config.story.model = String(body.story.model || '').trim();
        }
        // v2.4.1：文章题材自定义列表持久化（null 恢复内置默认；数组 2~40 项、每项 ≤12 字符全量替换）
        if (body.storyThemes !== undefined) {
          if (body.storyThemes === null) {
            config.storyThemes = null;
          } else if (Array.isArray(body.storyThemes)) {
            const list = [...new Set(body.storyThemes.map(t => String(t || '').trim()).filter(t => t && t.length <= 12))];
            config.storyThemes = list.length >= 2 ? list.slice(0, 40) : null;
          }
        }
        // v1.1.0：语料库数据源目录（留空 = 用仓库内 corpus/）
        if (body.kb && typeof body.kb === 'object' && typeof body.kb.dir === 'string') {
          if (!config.kb || typeof config.kb !== 'object') config.kb = { dir: '', pythonPath: '' };
          config.kb.dir = body.kb.dir.trim();
          if (typeof body.kb.pythonPath === 'string') config.kb.pythonPath = body.kb.pythonPath.trim();
        }
        if (body.kb && typeof body.kb === 'object' && typeof body.kb.externalDir === 'string') {
          if (!config.kb || typeof config.kb !== 'object') config.kb = { dir: '', pythonPath: '', externalDir: '' };
          config.kb.externalDir = body.kb.externalDir.trim();
          externalCache = { mtime: 0, records: [] };
          kbCache.sentences = null;
          kbCache.sentencesKey = '';
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
        // v2.0.0.a 优化：思考型推理模型（如 deepseek-r1/claude-thinking 等）思考过程会占用大量 token，
        // 测试连通性时 maxTokens 设为 200，避免因思考内容占满 20 token 导致 content 字段为空报错
        const opts = { maxTokens: 200 };
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

      // 测验结果提交：计入错词体系（v1.0.4）并双写统一流水（v2.2.1）
      if (p === '/api/quiz/submit' && req.method === 'POST') {
        const body = await readBody(req);
        const results = Array.isArray(body.results) ? body.results.slice(0, 500) : [];
        const { applied, attemptsSaved } = applyQuizResults(results, body.mode);
        return sendJSON(res, 200, { ok: true, applied, attemptsSaved });
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
        let spelling = (body.spelling || '').trim();
        const message = (body.message || '').trim();
        const history = Array.isArray(body.history) ? body.history.slice(-16) : [];
        if (!message) return sendJSON(res, 400, { error: '消息不能为空' });

        // v2.0.0.a 智能单词感知：若前端未明确传参 spelling（例如用户未点击左侧单词直接打字提问），
        // 从用户提问中智能提取最可能的英文目标词（优先匹配墨墨数据库中的高频真题词/普通词形），打通与语料库的连接
        if (!spelling) {
          const englishTokens = (message.match(/\b[a-zA-Z][a-zA-Z'\-]{1,29}\b/g) || [])
            .map(t => t.toLowerCase());
          // 排除过于基础的高频日常词（如 i, you, he, the, is, a, an, and, or, what, how, can）
          const stopWords = new Set(['the','be','to','of','and','a','in','that','have','i','it','for','not','on','with','he','as','you','do','at','this','but','his','by','from','they','we','say','her','she','or','an','will','my','one','all','would','there','their','what','so','up','out','if','about','who','get','which','go','me','when','make','can','like','time','no','just','him','know','take','people','into','year','your','good','some','could','them','see','other','than','then','now','look','only','come','its','over','think','also','back','after','use','two','how','our','work','first','well','way','even','new','want','because','any','these','give','day','most','us']);
          for (const token of englishTokens) {
            if (!stopWords.has(token)) {
              // 优先匹配本地词库或语料库中能搜到的词
              const wordMatch = Object.values(db.words).find(x => x.spelling?.toLowerCase() === token);
              if (wordMatch) { spelling = wordMatch.spelling; break; }
              const hits = kbSearch(token, 1);
              if (hits.length > 0) { spelling = token; break; }
            }
          }
        }

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

        // v2.0.1：真题与外刊分通道注入，并记录注入证据元信息返给前端 UI 展示小标签
        let evidenceMeta = null;
        if (spelling) {
          try {
            const evidence = kbEvidenceForWord(spelling);
            evidenceMeta = {
              spelling,
              examsCount: evidence.exams.length,
              externalCount: evidence.external.length,
              corpusCount: evidence.corpus.length,
              sampleExam: evidence.exams[0] ? `${evidence.exams[0].title || '真题'}${evidence.exams[0].year ? ' (' + evidence.exams[0].year + ')' : ''}` : '',
              sampleExternal: evidence.external[0] ? (evidence.external[0].publication || '外刊精选') : ''
            };
            const formatHit = h => {
                const src = [h.title, h.year ? h.year + ' 年' : '', KB_SECTION_LABEL[h.section] || h.section || '', h.number ? '第 ' + h.number + ' 题' : '']
                  .filter(Boolean).join(' · ');
                const external = h.sourceKind === 'external';
                const externalSrc = [h.publication, h.year ? h.year + ' 年' : '', h.sourceUrl].filter(Boolean).join(' · ');
                return `- ${h.s}\n  （来源：${external ? (externalSrc || src || '外刊发布源') : (src || '考研真题')}）`;
            };
            if (evidence.exams.length) {
              msgs[0].content += '\n\n【考研真题原句】\n' + evidence.exams.map(formatHit).join('\n') +
                '\n讲解时优先引用以上真题并注明来源，尤其关注考研义项和考法。';
            }
            if (evidence.external.length) {
              msgs[0].content += '\n\n【外刊真实语境】\n' + evidence.external.map(formatHit).join('\n') +
                '\n以上是外刊语境，不得称为考研真题；可用于补充当代用法、主题背景和词义迁移。';
            }
            if (evidence.corpus.length) {
              msgs[0].content += '\n\n【个人语料补充】\n' + evidence.corpus.map(formatHit).join('\n') +
                '\n请标明这是工作台语料，不要将其表述为考试原句。';
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

        // v2.3.4：视觉能力——服务商开启 vision 后允许随消息发送图片（dataURL，OpenAI 兼容 image_url 内容块）
        if (typeof body.image === 'string' && body.image.startsWith('data:image/')) {
          if (body.image.length > 2100000) {
            return sendJSON(res, 400, { error: '图片过大，请压缩后再试（≤1.5MB）' });
          }
          const prov = getProvider();
          if (!(config.llm.mock || (prov && prov.vision))) {
            return sendJSON(res, 400, { error: '当前默认服务商未开启「视觉能力」，请到设置页编辑服务商并勾选后重试' });
          }
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'user') {
            last.content = [
              { type: 'text', text: message },
              { type: 'image_url', image_url: { url: body.image } },
            ];
          }
        }

        const reply = await llmChat(msgs);
        return sendJSON(res, 200, { reply, evidence: evidenceMeta });
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

      // v2.0.0：发布源状态只读接口，便于本地/线上核对当前外刊 release
      if (p === '/api/kb/status' && req.method === 'GET') {
        return sendJSON(res, 200, {
          ok: true,
          manual: { file: kbFile(), exists: fs.existsSync(kbFile()), count: loadKb().length },
          external: externalStatus(),
          exams: { file: examsFile(), exists: fs.existsSync(examsFile()), count: loadExams().length },
        });
      }

      // 记录列表（摘要，不含全文）
      if (p === '/api/kb/records' && req.method === 'GET') {
        const records = [...loadKb(), ...loadExternalKb()];
        return sendJSON(res, 200, {
          ok: true,
          file: kbFile(),
          exists: fs.existsSync(kbFile()),
          records: records.map(kbSummary),
          external: externalStatus(),
        });
      }

      // 记录详情（全文 + 渲染排序后的 items：题干在前、题目按题号，不重排板块）
      {
        const m = p.match(/^\/api\/kb\/record\/([A-Za-z0-9_-]+)$/);
        if (m && req.method === 'GET') {
          // v1.1.7a 修复：编辑器加载原始记录走本接口，真题 id 在 exams.jsonl——
          // v1.1.2 分库后此处漏改单库查找，导致真题点「编辑」报「记录不存在」。
          // 改为双库查找（真题优先，与 kbFindStoreOf 一致），语料/真题编辑均恢复。
          const r = loadExams().find(x => x.id === m[1])
            || loadKb().find(x => x.id === m[1])
            || loadExternalKb().find(x => x.id === m[1]);
          if (!r) return sendJSON(res, 404, { error: '记录不存在' });
          return sendJSON(res, 200, {
            ok: true,
            record: { ...r, rtypeLabel: RTYPE_LABEL[r.rtype] || r.rtype, items: u.searchParams.get('raw') === '1' ? (r.items || []) : kbOrderedItems(r) },
          });
        }
      }

      // 全库句子搜索（题库 + 手工语料 + 外刊发布源）
      if (p === '/api/kb/search' && req.method === 'GET') {
        const q = u.searchParams.get('q') || '';
        const scope = ['all', 'exam', 'external', 'corpus'].includes(u.searchParams.get('scope')) ? u.searchParams.get('scope') : 'all';
        const results = kbSearch(q, 40, scope);
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
        // v2.1.1：store=exam 时走 mineru md 结构化拆题通道 -> 真题库（qa_set）；
        // 否则维持原行为（整篇 md 入语料库）
        const targetStore = body.store === 'exam' ? 'exam' : 'corpus';
        const r = await kbImportOne({
          name: base + '.md',
          buf: Buffer.from(md, 'utf8'),
          category: KB_CATEGORIES.includes(body.category) ? body.category : '真题',
          store: targetStore,
          parserTag: 'mineru-api',
        });
        return sendJSON(res, 200, { ok: true, mineru: true, store: targetStore, ...r });
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
        if (store === 'external') return sendJSON(res, 409, { error: '外刊发布源为只读，请在采集管线或本地验收层修改', code: 'EXTERNAL_READONLY' });
        if (!store) return sendJSON(res, 404, { error: '记录不存在：' + body.id });
        const cleanText = s => String(s ?? '').slice(0, 2e6);
        // v2.1.2：写入前先快照旧版本（保留最近 5 个，可回溯/恢复）
        const before = (store === 'exam' ? loadExams() : loadKb()).find(x => x.id === body.id);
        if (before) kbPushVersion(body.id, store, before, body.note || '修改前快照');
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

      // v2.1.2：记录修改历史（最近 5 个版本，可回溯）
      if (p === '/api/kb/versions' && req.method === 'GET') {
        const id = u.searchParams.get('id') || '';
        if (!id) return sendJSON(res, 400, { error: '缺少 id', code: 'KB_IMPORT' });
        const all = loadKbVersions();
        const list = (Array.isArray(all[id]) ? all[id] : []).map((v, i) => ({
          index: i, ts: v.ts, store: v.store, title: v.title, note: v.note,
          itemCount: Array.isArray(v.items) ? v.items.length : 0,
          chars: String(v.text || '').length +
            (Array.isArray(v.items) ? v.items.reduce((a, it) => a + String(it.text || '').length, 0) : 0),
        }));
        return sendJSON(res, 200, { ok: true, id, versions: list, max: KB_VERSION_MAX });
      }

      // v2.1.2：恢复到指定历史版本（当前内容会先压入历史，可再回退）
      if (p === '/api/kb/version/restore' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) return sendJSON(res, 400, { error: '缺少 id', code: 'KB_IMPORT' });
        const store = body.store || kbFindStoreOf(body.id);
        if (store === 'external') return sendJSON(res, 409, { error: '外刊发布源为只读，不能恢复历史', code: 'EXTERNAL_READONLY' });
        if (!store) return sendJSON(res, 404, { error: '记录不存在：' + body.id });
        const all = loadKbVersions();
        const list = Array.isArray(all[body.id]) ? all[body.id] : [];
        const vi = Number(body.versionIndex);
        if (!Number.isInteger(vi) || vi < 0 || vi >= list.length) return sendJSON(res, 400, { error: '历史版本序号无效' });
        const snapshot = list[vi];
        const before = (store === 'exam' ? loadExams() : loadKb()).find(x => x.id === body.id);
        if (before) kbPushVersion(body.id, store, before, `恢复自 ${snapshot.ts} 前快照`);
        const cleanText = s => String(s ?? '').slice(0, 2e6);
        const r = kbMutateStore(store, body.id, rec => {
          if (typeof snapshot.title === 'string') rec.title = snapshot.title.slice(0, 200);
          rec.text = cleanText(snapshot.text);
          if (Array.isArray(snapshot.items)) rec.items = snapshot.items.slice(0, 300);
          else delete rec.items;
          rec.edited_at = new Date().toISOString().slice(0, 19);
          return rec;
        });
        if (!r.ok) return sendJSON(res, r.reason.includes('不存在') ? 404 : 400, { error: r.reason });
        kbLog({ time: new Date().toISOString().slice(0, 19), file: '(restore)', status: 'updated', store, records: 1, reason: `version#${vi} @${snapshot.ts}` });
        return sendJSON(res, 200, { ok: true, title: r.title, restored: snapshot.ts });
      }

      // v2.1.2：AI 审读修正方案——用户采纳后直接写回（替换 quote 片段）
      if (p === '/api/kb/review/apply' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) return sendJSON(res, 400, { error: '缺少 id', code: 'KB_IMPORT' });
        const store = body.store || kbFindStoreOf(body.id);
        if (store === 'external') return sendJSON(res, 409, { error: '外刊发布源为只读，不能应用修正', code: 'EXTERNAL_READONLY' });
        if (!store) return sendJSON(res, 404, { error: '记录不存在：' + body.id });
        const rawIdx = body.itemRawIdx == null ? -1 : Number(body.itemRawIdx);
        const quote = String(body.quote || '');
        const fix = String(body.fix || '');
        if (!quote) return sendJSON(res, 400, { error: '缺少 quote（AI 摘录）' });
        if (fix === quote) return sendJSON(res, 400, { error: '修正方案与原文相同，无需应用' });
        const rec = (store === 'exam' ? loadExams() : loadKb()).find(x => x.id === body.id);
        if (!rec) return sendJSON(res, 404, { error: '记录不存在' });
        const cleanText = s => String(s ?? '').slice(0, 2e6);
        // 定位目标文本：优先 itemRawIdx，其次全文
        const target = (Array.isArray(rec.items) && Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < rec.items.length)
          ? String(rec.items[rawIdx].text || '') : String(rec.text || '');
        if (!target.includes(quote)) {
          return sendJSON(res, 409, { error: 'AI 摘录未能在当前文本中命中（可能已被修改），请手动编辑' });
        }
        const replaced = target.replace(quote, fix);
        const before = (store === 'exam' ? loadExams() : loadKb()).find(x => x.id === body.id);
        if (before) kbPushVersion(body.id, store, before, 'AI 修正采纳前快照');
        const r = kbMutateStore(store, body.id, r0 => {
          if (Array.isArray(r0.items) && Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < r0.items.length) {
            r0.items[rawIdx].text = cleanText(replaced);
          } else {
            r0.text = cleanText(replaced);
          }
          r0.edited_at = new Date().toISOString().slice(0, 19);
          return r0;
        });
        if (!r.ok) return sendJSON(res, r.reason.includes('不存在') ? 404 : 400, { error: r.reason });
        kbLog({ time: new Date().toISOString().slice(0, 19), file: '(review-apply)', status: 'updated', store, records: 1, reason: String(r.title).slice(0, 80) });
        return sendJSON(res, 200, { ok: true, title: r.title, appliedText: replaced.slice(0, 2000) });
      }

      // v2.1.2：划线精读解析（单词 / 词组 / 句子）——参考沉浸式翻译的学习反馈弹窗
      // v2.3.3：新增 mode 模式注入（释义 define / 直译 translate / 语法 grammar / 例句 example）——借鉴 nextai-translator 多模式气泡
      if (p === '/api/selection/learn' && req.method === 'POST') {
        const body = await readBody(req);
        const selection = String(body.text || '').trim().slice(0, 600);
        if (!selection) return sendJSON(res, 400, { error: '划选内容为空' });
        const context = String(body.context || '').trim().slice(0, 4000);
        const title = String(body.title || '').slice(0, 120);
        const kind = ['word', 'phrase', 'sentence'].includes(body.kind) ? body.kind : 'auto';
        const mode = ['define', 'translate', 'grammar', 'example'].includes(body.mode) ? body.mode : 'define';
        const kindLabel = { word: '单词', phrase: '词组', sentence: '句子', auto: '自动判定' }[kind];
        const modeLabel = { define: '释义', translate: '直译', grammar: '语法', example: '例句' }[mode];
        const modeDirective = {
          define: '',
          translate: '本次解析严格要求以【直译】为主：句子给一段自然通顺、贴近原文的地道中文翻译，不展开其他分析；单词/词组给核心词义与在此语境中的中文含义，简短直接。',
          grammar: '本次解析严格要求以【语法】为主：拆解该片段的语法结构——主干与成分、从句与修饰关系、时态语态、指代衔接；面向考研阅读长难句习惯，简洁清楚，不必给完整译文。',
          example: '本次解析严格要求以【例句】为主：若是单词/词组，给 2~3 个地道例句（附中文翻译）与常见搭配；若是句子，给一个同结构仿写例句（附中文翻译）。',
        }[mode];
        const msgs = [
          { role: 'system', content: getPrompt('selection_learn') },
          { role: 'user', content: [
            title ? `材料：${title}` : '',
            `【划选内容】（${kindLabel}）：${selection}`,
            `【请求模式】：${modeLabel}`,
            modeDirective ? `本次解析要求：${modeDirective}` : '',
            context ? `【上下文】\n${context}` : '（无额外上下文）',
          ].filter(Boolean).join('\n\n') },
        ];
        const reply = await llmChat(msgs, {
          maxTokens: 1200,
          // v2.3.4：划词助手可单独指定服务商与覆盖模型（留空沿用默认服务商）
          providerId: (config.selection && config.selection.providerId) || undefined,
          llmOverride: (config.selection && config.selection.model) ? { model: config.selection.model } : undefined,
        });
        return sendJSON(res, 200, { ok: true, kind, mode, selection, reply });
      }

      // v2.3.3：划词一键收进墨墨云词库（Saladict 生词本交互 × 墨墨生态，复用 ensureWordInNotepad）
      if (p === '/api/selection/collect' && req.method === 'POST') {
        const body = await readBody(req);
        const spelling = String(body.spelling || '').trim();
        if (!spelling || spelling.length > 80) return sendJSON(res, 400, { error: '收词内容为空或超长' });
        if (!/^[A-Za-z][A-Za-z''\-]*(?:\s+[A-Za-z][A-Za-z''\-]*){0,4}$/.test(spelling)) {
          return sendJSON(res, 400, { error: '仅支持 1~5 个英文单词（字母/撇号/连字符）' });
        }
        if (!(config.maimemoNotepadId || '').trim()) {
          return sendJSON(res, 409, { error: '尚未绑定墨墨云词库，请先到「设置」页绑定后再收词' });
        }
        await ensureWordInNotepad(spelling);
        return sendJSON(res, 200, { ok: true, spelling, notepadId: config.maimemoNotepadId });
      }

      // v2.4.2：词文成章——AI分析词汇并给出分类与篇幅建议
      if (p === '/api/story/analyze' && req.method === 'POST') {
        const body = await readBody(req);
        const words = [...new Set((Array.isArray(body.words) ? body.words : [])
          .map(w => String(w || '').trim().toLowerCase())
          .filter(w => /^[a-z][a-z''\-]{0,39}$/.test(w)))];
        if (words.length < 1) return sendJSON(res, 400, { error: '请至少选择 1 个单词进行分析' });

        const lens = Object.fromEntries(words.map(w => [w, db.glosses[w] || null]));
        // v2.4.2.a：大词池智能摘要——>60 词时输出全量词表但释义仅抽样 40 条，控制输入规模防思考失控
        const glossLines = words.filter(w => lens[w]);
        const sampledGloss = glossLines.length > 40
          ? glossLines.filter((_, i) => i % Math.ceil(glossLines.length / 40) === 0).slice(0, 40)
          : glossLines;
        const msgs = [
          { role: 'system', content: getPrompt('story_analyze') },
          { role: 'user', content: [
            `【待分析单词清单】（共 ${words.length} 个）：\n${words.join(', ')}`,
            sampledGloss.length ? `【词典参考（${sampledGloss.length === glossLines.length ? '全量' : '抽样 ' + sampledGloss.length + '/' + glossLines.length + ' 条'}）】\n` + sampledGloss.map(w => `- ${w}: ${lens[w].pos || ''} ${lens[w].gloss || ''}`).join('\n') : '',
          ].filter(Boolean).join('\n\n') }
        ];

        const reply = await llmChat(msgs, {
          maxTokens: 8000,
          providerId: (config.story && config.story.providerId) || undefined,
          llmOverride: {
            _jsonMode: true,
            _noThinking: true,   // v2.4.2.a：分析类结构化任务禁用思考（实测思考会自适应膨胀至数万字耗尽预算）
            ...(((config.story && config.story.model)) ? { model: config.story.model } : {}),
          },
        });

        let parsed = null;
        try {
          let text = String(reply).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
          try {
            parsed = JSON.parse(text);
          } catch {
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start !== -1 && end > start) {
              parsed = JSON.parse(text.slice(start, end + 1));
            }
          }
        } catch { parsed = null; }

        // v2.4.2 schema 校验：分析结果必须含 groups(非空数组) 与 recommendedLength，否则视为无效输出走确定性兜底
        const analysisValid = parsed && typeof parsed === 'object'
          && Array.isArray(parsed.groups) && parsed.groups.length >= 1
          && ['short', 'medium', 'long'].includes(parsed.recommendedLength);
        if (!analysisValid) {
          // 容错兜底：模型未按要求输出（或输出了别的 schema），基于词数确定性给出科学分类和篇幅建议
          const wCount = words.length;
          const recLen = wCount > 25 ? 'long' : (wCount > 10 ? 'medium' : 'short');
          const lenLabels = {
            short: '精悍短篇（建议 180~260 词）',
            medium: '中篇叙事（建议 350~450 词）',
            long: '长篇拓展（建议 600~900 词）'
          };
          parsed = {
            summary: `已对这 ${wCount} 个词汇完成梳理。结合词汇量与记忆曲线，建议采用${lenLabels[recLen]}形式。`,
            recommendedLength: recLen,
            lengthLabel: lenLabels[recLen],
            lengthReason: `包含 ${wCount} 个单词，该篇幅能够让上下文自然展开，避免单词过于拥挤。`,
            groups: [
              {
                name: '核心场景群',
                theme: '校园/探索',
                words: words.slice(0, Math.ceil(wCount / 2)),
                suggestedPlot: '结合求知、探索与日常互动的生动故事线。'
              },
              {
                name: '行动与转变群',
                theme: '科幻/成长',
                words: words.slice(Math.ceil(wCount / 2)),
                suggestedPlot: '描绘面对突发状况、心理蜕变或局势逆转的情节。'
              }
            ].filter(g => g.words.length > 0)
          };
        }

        return sendJSON(res, 200, { ok: true, analysis: parsed });
      }

      // v2.4.0：词文成章——选词生成记忆故事（故事+钩子双形态 + 中文翻译 + 检索自测）
      // v2.4.2：解除严格数量限制，选词不限数量（至少 1 词，可分批分段生成）
      if (p === '/api/story/generate' && req.method === 'POST') {
        const body = await readBody(req);
        const words = [...new Set((Array.isArray(body.words) ? body.words : [])
          .map(w => String(w || '').trim().toLowerCase())
          .filter(w => /^[a-z][a-z''\-]{0,39}$/.test(w)))];
        if (words.length < 1) return sendJSON(res, 400, { error: '请至少选择 1 个单词' });
        if (words.length > 200) return sendJSON(res, 400, { error: '单次生成单词量建议不超过 200 词，请适当精简' });
        // v2.4.1：题材动态化——storyThemes 自定义列表优先，缺省用内置 16 题材
        const themes = storyThemesList();
        const theme = themes.includes(body.theme) ? body.theme : (body.theme ? String(body.theme).slice(0, 30) : (themes[0] || '随缘'));
        const lengths = {
          short: { label: '短篇', guide: '180~260 个英文单词' },
          medium: { label: '中篇', guide: '350~450 个英文单词' },
          long: { label: '长篇', guide: '600~900 个英文单词' }
        };
        const lengthKey = lengths[body.length] ? body.length : (body.length ? 'medium' : 'short');
        const customGuide = body.lengthGuide ? String(body.lengthGuide).slice(0, 80) : (lengths[lengthKey] ? lengths[lengthKey].guide : '适中篇幅');
        const lens = Object.fromEntries(words.map(w => [w, db.glosses[w] || null]));
        // v2.4.0：真题/外刊真实语境注入，引导模型优先用考研高频义项
        let evidenceNote = '';
        try {
          const lines = [];
          for (const w of words.slice(0, 30)) {
            const ev = kbEvidenceForWord(w);
            const ex = ev.exams[0] || ev.external[0] || ev.corpus[0];
            if (ex?.s) lines.push(`- ${w}: ${String(ex.s).slice(0, 120)}`);
          }
          if (lines.length) evidenceNote = '\n\n【真实语境参考】以下是部分单词在考研真题/外刊中的原句，优先按这些义项与用法编写：\n' + lines.join('\n');
        } catch { /* 语料库不可用不阻塞 */ }
        const msgs = [
          { role: 'system', content: getPrompt('story_gen') },
          { role: 'user', content: [
            `【目标单词】（共 ${words.length} 个）：${words.join(', ')}`,
            lens && words.some(w => lens[w]) ? `【词典参考】\n` + words.filter(w => lens[w]).slice(0, 50).map(w => `- ${w}: ${lens[w].pos || ''} ${lens[w].gloss || ''}`).join('\n') : '',
            `【题材】：${theme}`,
            `【篇幅建议与要求】：${body.lengthLabel || lengths[lengthKey]?.label || '自适应'}（${customGuide}）`,
            body.userInstruction ? `【AI分析与分类建议提示】：${String(body.userInstruction).slice(0, 300)}` : '',
            evidenceNote,
            '【再次提醒】你的回复必须整体是一个 JSON 对象（第一个字符 { 最后一个字符 }），英文正文放在 passage 字段里，不要在 JSON 之外输出任何文字。',
          ].filter(Boolean).join('\n\n') },
        ];
        const reply = await llmChat(msgs, {
          maxTokens: 4000,
          // v2.4.1：词文成章可单独指定服务商与覆盖模型（留空沿用默认服务商）
          providerId: (config.story && config.story.providerId) || undefined,
          llmOverride: {
            _jsonMode: true,
            ...(((config.story && config.story.model)) ? { model: config.story.model } : {}),
          },
        });
        let parsed;
        try {
          // v2.4.0a 容错：真实模型常在 JSON 前后带说明文字/代码围栏——先剥围栏，再提取第一个平衡的 {...} 块解析
          let text = String(reply).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
          try {
            parsed = JSON.parse(text);
          } catch {
            const start = text.indexOf('{');
            if (start === -1) throw new Error('no-json');
            let depth = 0, inStr = false, esc2 = false, end = -1;
            for (let i = start; i < text.length; i++) {
              const ch = text[i];
              if (esc2) { esc2 = false; continue; }
              if (ch === '\\') { esc2 = true; continue; }
              if (ch === '"') { inStr = !inStr; continue; }
              if (inStr) continue;
              if (ch === '{') depth++;
              else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
            }
            if (end === -1) throw new Error('no-json');
            parsed = JSON.parse(text.slice(start, end));
          }
          if (typeof parsed.passage !== 'string' || !parsed.passage.trim()) throw new Error('passage-missing');
        } catch {
          // v2.4.0e 二段式兜底：弱指令遵循模型（实测 deepseek-v4.1-flash）对结构化 JSON 服从性差，
          // 但纯写作没问题——第一段产物若为英文正文，直接用作 passage，进入第二段抽取补齐元数据
          const text = String(reply).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
          const enRatio = (text.match(/[A-Za-z]/g) || []).length / Math.max(1, text.replace(/\s/g, '').length);
          const inlinePassage = typeof parsed === 'object' && parsed && typeof parsed.passage === 'string' ? parsed.passage : '';
          const passage0 = inlinePassage || (text.length > 200 && enRatio > 0.7 ? text : '');
          if (!passage0) {
            throw Object.assign(new Error('AI 输出无法解析为文章 JSON（schema 不符），点「换一篇」重试通常可解决'), { code: 'STORY_PARSE' });
          }
          parsed = { passage: passage0 };
        }
        // v2.4.0e 二段式补齐：title/hooks/translation/quiz 缺哪段补哪段（抽取任务的指令服从性远高于边写边结构化）
        const needsMeta = !Array.isArray(parsed.hooks) || !parsed.hooks.length
          || !parsed.translation || !Array.isArray(parsed.quiz) || parsed.quiz.length < 3
          || !parsed.title;
        if (needsMeta) {
          try {
            const metaMsgs = [
              { role: 'system', content: '你是考研英语词汇教练。对给定英文短文完成四项标注并只输出 JSON 对象（第一个字符 { 最后一个字符 }）：'
                + '{"title":"英文标题(12词内)","hooks":[{"word":"单词(必须逐一核对确在文中出现,用原形)","phonetic":"美式音标,不确定给空串","pos":"词性缩写","meaning":"考研核心义项,15字内","hook":"一句中文记忆钩子,谐音/联想/词根,25字内"}],"translation":"全文通顺中文翻译","quiz":[5道选择题{"q":"题干","options":["A","B","C","D"],"answer":1到4,"explain":"40字内"}]}'
                + '。hooks 必须覆盖给定的每个目标词；quiz 前3题用文中原句挖空目标词、后2题考词义。除 JSON 外禁止输出任何文字。' },
              { role: 'user', content: `【目标词】${words.join(', ')}\n\n【英文短文】\n${parsed.passage.slice(0, 4500)}` },
            ];
            const metaReply = await llmChat(metaMsgs, { maxTokens: 2500, llmOverride: { _jsonMode: true } });
            let meta;
            const mt = String(metaReply).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
            try { meta = JSON.parse(mt); } catch {
              const ms = mt.indexOf('{');
              if (ms !== -1) {
                let depth = 0, inStr = false, esc3 = false, me = -1;
                for (let i = ms; i < mt.length; i++) {
                  const ch = mt[i];
                  if (esc3) { esc3 = false; continue; }
                  if (ch === '\\') { esc3 = true; continue; }
                  if (ch === '"') { inStr = !inStr; continue; }
                  if (inStr) continue;
                  if (ch === '{') depth++;
                  else if (ch === '}') { depth--; if (depth === 0) { me = i + 1; break; } }
                }
                if (me !== -1) meta = JSON.parse(mt.slice(ms, me));
              }
            }
            if (meta && typeof meta === 'object') {
              if (!parsed.title && meta.title) parsed.title = meta.title;
              if ((!Array.isArray(parsed.hooks) || !parsed.hooks.length) && Array.isArray(meta.hooks)) parsed.hooks = meta.hooks;
              if (!parsed.translation && meta.translation) parsed.translation = meta.translation;
              if ((!Array.isArray(parsed.quiz) || parsed.quiz.length < 3) && Array.isArray(meta.quiz)) parsed.quiz = meta.quiz;
            }
          } catch { /* 二段失败不阻塞：保留已成功的正文，缺失字段走确定性兜底 */ }
        }
        /* v2.4.0.f 确定性兜底：无论模型多不配合，文章+钩子+自测三件套保证齐全 */
        const hooks = (Array.isArray(parsed.hooks) ? parsed.hooks : [])
          .map(h => ({ word: String(h.word || '').trim(), phonetic: String(h.phonetic || '').slice(0, 40), pos: String(h.pos || '').slice(0, 12), meaning: String(h.meaning || '').slice(0, 40), hook: String(h.hook || '').slice(0, 60) }))
          .filter(h => h.word).slice(0, 100);
        // 钩子缺词：用韦氏释义缓存补卡片（hook 文案缺省提示），保证每个目标词都有卡
        if (hooks.length < words.length) {
          const have = new Set(hooks.map(h => h.word.toLowerCase()));
          for (const w of words) {
            if (have.has(w)) continue;
            const g = db.glosses[w] || null;
            hooks.push({ word: w, phonetic: (g && g.phonetic) || '', pos: (g && g.pos) || '', meaning: (g && g.gloss) || '', hook: g && g.gloss ? `释义卡：${g.gloss}` : '（本次未生成钩子，点「换一篇」重新生成可恢复）' });
          }
        }
        let quiz = (Array.isArray(parsed.quiz) ? parsed.quiz : [])
          .map(q => ({ q: String(q.q || '').slice(0, 300), options: (Array.isArray(q.options) ? q.options : []).map(o => String(o || '').slice(0, 120)).slice(0, 4), answer: Math.min(4, Math.max(1, Number(q.answer) || 1)), explain: String(q.explain || '').slice(0, 120) }))
          .filter(q => q.q && q.options.length === 4).slice(0, 5);
        // 自测缺题：确定性生成「词义四选一」（从词池+释义缓存出题，不依赖模型）
        if (quiz.length < 3 && words.length >= 3) {
          const pool = words.map(w => ({ w, g: db.glosses[w] || null }));
          const distractors = pool.filter(x => x.g && x.g.gloss).map(x => x.g.gloss);
          for (const { w, g } of pool) {
            if (quiz.length >= 3) break;
            if (!g || !g.gloss) continue;
            const others = distractors.filter(x => x !== g.gloss);
            if (others.length < 3) break;
            const opts = [g.gloss, ...others.slice(0, 3)];
            // 简单洗牌并记录答案位置
            for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
            quiz.push({ q: `单词「${w}」的核心含义是？`, options: opts, answer: opts.indexOf(g.gloss) + 1, explain: `${w} = ${g.gloss}` });
          }
        }
        const story = {
          id: crypto.randomUUID(),
          title: String(parsed.title || `${theme}物语 · ${words.slice(0, 3).join(' · ')}`).slice(0, 120),
          words,
          theme,
          length: lengthKey,
          passage: String(parsed.passage || '').slice(0, 6000),
          hooks,
          translation: String(parsed.translation || ''),
          quiz,
          createdAt: new Date().toISOString(),
        };
        if (!story.passage) return sendJSON(res, 502, { error: 'AI 输出缺少正文（passage 为空），点「换一篇」重试' });
        db.stories.unshift(story);
        if (db.stories.length > 200) db.stories.length = 200;   // 上限 200 篇，FIFO 裁剪
        persistDB();
        return sendJSON(res, 200, { ok: true, story });
      }
      if (p === '/api/story/list' && req.method === 'GET') {
        const list = (db.stories || []).map(s => ({ id: s.id, title: s.title, words: s.words, theme: s.theme, length: s.length, createdAt: s.createdAt }));
        return sendJSON(res, 200, { ok: true, list });
      }
      {
        const m = p.match(/^\/api\/story\/([a-f0-9-]+)$/);
        if (m && req.method === 'GET') {
          const s = (db.stories || []).find(x => x.id === m[1]);
          if (!s) return sendJSON(res, 404, { error: '文章不存在' });
          return sendJSON(res, 200, { ok: true, story: s });
        }
        if (m && req.method === 'DELETE') {
          const before = (db.stories || []).length;
          db.stories = db.stories.filter(x => x.id !== m[1]);
          if (db.stories.length === before) return sendJSON(res, 404, { error: '文章不存在' });
          persistDB();
          return sendJSON(res, 200, { ok: true });
        }
      }

      // 记录删除（解析原件仍保留在 archive/，可重导恢复；删除写日志）
      if (p === '/api/kb/record/delete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) return sendJSON(res, 400, { error: '缺少 id', code: 'KB_IMPORT' });
        const store = body.store || kbFindStoreOf(body.id);
        if (store === 'external') return sendJSON(res, 409, { error: '外刊发布源为只读，请在采集管线或本地验收层删除', code: 'EXTERNAL_READONLY' });
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
        const rec = store === 'exam' ? loadExams().find(x => x.id === body.id)
          : store === 'corpus' ? loadKb().find(x => x.id === body.id)
            : loadExternalKb().find(x => x.id === body.id);
        if (!rec) return sendJSON(res, 404, { error: '记录不存在' });
        const reviewLabel = store === 'external' ? '外刊语料' : '考研真题语料';
        /* v1.1.6 修复审核数据源：旧版材料按每条 260 字符截断 + 全局 9000 字符截断 + 抹除 〖N〗 锚点 +
           原始顺序，LLM 把「送审材料自身残缺」当成语料问题报告（即实测中的假问题）。
           现在材料 = 与页面展示一致的渲染视图：kbOrderedItems 排序 + 每条完整文本 + 保留 〖N〗 锚点 +
           稳定定位符【条目#N】，并附 archive/ 真题原件（文本类）作比对参考。 */
        const ordered = kbOrderedItems(rec);
        const parts = ordered.map((it, i) => {
          const tag = `${it.type || 'item'}${it.section ? '·' + it.section : ''}${it.number != null ? '·题' + it.number : ''}`;
          let body = String(it.text || '');
          // v2.1.4：选项一并送审（否则 LLM 会把「选项未提供」误报为语料缺选项）
          const opts = it.options;
          if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
            const lines = Object.keys(opts).map(L => `(${L}) ${String(opts[L] || '').trim()}`);
            if (lines.length) body = (body ? body + '\n' : '') + lines.join('\n');
          }
          return `【条目#${i + 1}｜${tag}】\n${body}`;
        });
        const LIMIT = 120000;
        let material = parts.length
          ? parts.join('\n\n')
          : `【整理后的${reviewLabel}内容】（纯文本记录，无结构化条目）\n${String(rec.text || '')}`;
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
          { role: 'system', content: getPrompt('quality_review') },
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
        // v2.1.4：送审材料含选项，定位同步覆盖「正文+选项」渲染体，quote 命中选项也能锚回条目
        const bodies = ordered.map((it, i) => {
          const body = String(it.text || '');
          const opts = it.options;
          if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
            const lines = Object.keys(opts).map(L => `(${L}) ${String(opts[L] || '').trim()}`);
            if (lines.length) return (body ? body + '\n' : '') + lines.join('\n');
          }
          return body;
        });
        const normTxt = s => String(s || '').replace(/〖\/\d+〗/g, '').replace(/〖\d+〗/g, '').replace(/\s+/g, '');
        const locate = quote => {
          const q = String(quote || '').trim();
          if (q.length < 4) return { idx: null, text: null, tag: null };
          let hit = -1;
          if (ordered.length) hit = bodies.findIndex(b => b.includes(q));
          if (hit < 0) {
            const nq = normTxt(q);
            if (nq.length >= 6) {
              if (ordered.length) hit = bodies.findIndex(b => normTxt(b).includes(nq));
              else if (normTxt(rec.text).includes(nq)) hit = 0;
            }
          }
          if (hit < 0) return { idx: null, text: null, tag: null, rawIdx: null };
          const it = ordered.length ? ordered[hit] : null;
          const tag = it ? `${it.type || 'item'}${it.section ? '·' + it.section : ''}${it.number != null ? '·题' + it.number : ''}` : '纯文本记录';
          // v1.1.7b：ordered 是 items 浅拷贝的排序，元素引用不变——indexOf 直接拿原始下标，供疑点弹窗直编对齐
          const rawIdx = (it && Array.isArray(rec.items)) ? rec.items.indexOf(it) : -1;
          return { idx: ordered.length ? hit : null, text: String(it ? it.text : rec.text || '').slice(0, 2000), tag, rawIdx: rawIdx >= 0 ? rawIdx : null };
        };
        const issues = parsed.issues
          .filter(x => x && typeof x.desc === 'string' && x.desc.trim())
          .slice(0, 30)
          .map(x => {
            const hitInfo = locate(x.quote);
            return {
              loc: String(x.loc || '?').slice(0, 40),
              quote: String(x.quote || '').trim().slice(0, 100),
              // v2.1.2：AI 修正方案——用于替换 quote 的修正文本（可为空 = 无自动方案）
              fix: String(x.fix || '').trim().slice(0, 2000),
              itemIdx: hitInfo.idx,
              itemRawIdx: hitInfo.rawIdx,
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
          materialStats: { chars: totalChars, items: ordered.length, limit: LIMIT, truncated, hasRef: !!refNote, readOnly: store === 'external' },
          readOnly: store === 'external',
          modelUsed: {
            providerId: (config.review && config.review.providerId) || config.llm.activeId || '',
            model: (config.review && config.review.model) || '',
          },
        });
      }

      // v1.1.7d：单条复核——疑点弹窗保存后对该条目快速 AI 复核，无误则前端自动消红
      if (p === '/api/kb/review/item' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) return sendJSON(res, 400, { error: '缺少 id', code: 'KB_IMPORT' });
        const store = body.store || kbFindStoreOf(body.id);
        if (!store) return sendJSON(res, 404, { error: '记录不存在：' + body.id });
        if (store === 'external') return sendJSON(res, 409, { error: '外刊发布源为只读，不能在网站端复核后直接写回', code: 'EXTERNAL_READONLY' });
        const rec = (store === 'exam' ? loadExams() : loadKb()).find(x => x.id === body.id);
        if (!rec) return sendJSON(res, 404, { error: '记录不存在' });
        const item = Array.isArray(rec.items) ? rec.items[body.rawIdx] : null;
        const text = typeof body.text === 'string' ? body.text : String((item && item.text) || '');
        const origText = typeof body.origText === 'string' && body.origText.trim() ? body.origText : text;
        if (!text.trim()) return sendJSON(res, 400, { error: '条目文本为空' });
        /* v1.1.7f：复核必须结合真题原件比对——先在原件中定位该条目对应段落作为比对基准，防止 AI 杜撰 */
        let refSeg = '';
        try {
          const origPath = rec.source?.file ? path.join(kbBaseDir(), 'archive', rec.source.category || '', rec.source.file) : null;
          if (origPath && fs.existsSync(origPath) && /\.(tex|txt|md|html?|htm)$/i.test(origPath)) {
            const orig = fs.readFileSync(origPath, 'utf8');
            const fuzzyFind = (hay, needle) => {
              // 忽略空白差异地在 hay 中找 needle，返回 [start, end) 或 null
              const isSp = c => /\s/.test(c);
              for (let start = 0; start < hay.length; start++) {
                if (isSp(hay[start])) continue;
                let p = start, j = 0;
                while (p < hay.length && j < needle.length) {
                  if (isSp(needle[j])) { j++; continue; }
                  if (isSp(hay[p])) { p++; continue; }
                  if (hay[p] !== needle[j]) break;
                  p++; j++;
                }
                while (j < needle.length && isSp(needle[j])) j++;
                if (j >= needle.length) return [start, p];
              }
              return null;
            };
            const probe = origText.replace(/\s+/g, ' ').trim().slice(0, 60);
            let hit = (probe.length >= 20) ? fuzzyFind(orig, probe) : null;
            let seg = '';
            if (hit) {
              seg = orig.slice(Math.max(0, hit[0] - 1200), hit[1] + 1200);
              refSeg = `\n\n【真题原件相关段落】（${rec.source.file} 中与该条目对应的片段，是比对基准）\n${seg}`;
            } else {
              // 精确定位失败：用条目里最长的几个英文词兜底
              const words = [...new Set(origText.split(/[^A-Za-z']+/))].filter(w => w.length >= 7).sort((a, b) => b.length - a.length).slice(0, 6);
              for (const w of words) {
                const wAt = orig.indexOf(w);
                if (wAt >= 0) {
                  seg = orig.slice(Math.max(0, wAt - 1500), wAt + 2500);
                  refSeg = `\n\n【真题原件相关段落】（按关键词定位，${rec.source.file}）\n${seg}`;
                  break;
                }
              }
              if (!refSeg) refSeg = `\n\n【真题原件开头】（未能精确定位该条目对应段落，附开头 ${Math.min(6000, orig.length)} 字符供比对）\n${orig.slice(0, 6000)}`;
            }
          }
        } catch { /* 原件读取失败不影响复核主流程 */ }
        if (config.llm.mock) return sendJSON(res, 200, { ok: true, mock: true });
        const reply = await llmChat([
          { role: 'system', content: getPrompt('quality_review_item') },
          { role: 'user', content: `条目类型：${(item && (item.type + (item.section ? '·' + item.section : ''))) || '未知'}\n\n【条目当前文本】\n${text.slice(0, 6000)}${refSeg}` },
        ], {
          maxTokens: (config.review && config.review.thinking) ? 8000 : 800,
          providerId: (config.review && config.review.providerId) || undefined,
          llmOverride: (() => {
            const over = {};
            if (config.review && config.review.model) over.model = config.review.model;
            if (config.review && config.review.thinking) {
              over.temperature = 1;
              over._thinking = { type: 'enabled', budget_tokens: 4000 };
            }
            return Object.keys(over).length ? over : undefined;
          })(),
        });
        const parsed = parseMnemonicJSON(reply);
        if (!parsed) {
          return sendJSON(res, 200, { ok: false, issues: [{ desc: 'AI 复核输出无法解析，请人工确认' }] });
        }
        const issues = Array.isArray(parsed.issues)
          ? parsed.issues.filter(x => x && typeof x.desc === 'string' && x.desc.trim()).slice(0, 5)
              .map(x => ({ desc: x.desc.trim().slice(0, 160), suggestion: String(x.suggestion || '').trim().slice(0, 300) }))
          : [];
        const ok = parsed.ok === true || (Array.isArray(parsed.issues) && !parsed.issues.length);
        return sendJSON(res, 200, { ok, issues });
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
          // v2.1.4：Part B 选项池可达 A–H（2023），统一放行单字母
          if (/^[A-Z]$/.test(v)) clean[String(k).slice(0, 10)] = v;
        }
        const all = loadAnswers();
        all[unitId] = clean;
        saveAnswers(all);
        kbLog({ time: new Date().toISOString().slice(0, 19), file: '(answers)', status: 'saved', store: 'exam', records: Object.keys(clean).length, reason: unitId.slice(0, 40) });
        return sendJSON(res, 200, { ok: true, saved: Object.keys(clean).length });
      }

      // 提交作答 -> 服务端判分（v1.1.5 客观题对标准答案；v2.2.2 升级为客观题、翻译和写作完整流水与错因后补）
      if (p === '/api/unit/answers/submit' && req.method === 'POST') {
        const body = await readBody(req);
        const unitId = String(body.unitId || '').trim();
        const ui = unitItems(unitId);
        if (!ui) return sendJSON(res, 404, { error: '单元不存在：' + unitId });

        // 仅补充错因模式：reasonOnly: true
        if (body.reasonOnly) {
          const attemptId = String(body.attemptId || '').trim();
          const batchId = String(body.batchId || '').trim();
          const errorReason = String(body.errorReason || '').trim();
          if (!attemptId) return sendJSON(res, 400, { error: '缺少 attemptId' });
          if (!batchId) return sendJSON(res, 400, { error: '缺少 batchId（错因只能修改同一批次作答）' });
          if (!VALID_ATTEMPT_ERROR_REASONS.has(errorReason)) {
            return sendJSON(res, 400, { error: `无效的 errorReason: ${errorReason}` });
          }

          const store = loadLearningStore();
          const target = (store.attempts || []).find(a => a.id === attemptId);
          if (!target) return sendJSON(res, 404, { error: '作答流水不存在: ' + attemptId });
          if (target.unitId !== unitId) {
            return sendJSON(res, 400, { error: '作答记录不属于当前单元' });
          }
          if (target.kind !== 'unit_objective') {
            return sendJSON(res, 400, { error: '仅客观题作答记录允许补充错因' });
          }
          if (target.result !== 'incorrect') {
            return sendJSON(res, 400, { error: '仅错误作答允许补充错因' });
          }
          if (!target.meta || target.meta.batchId !== batchId) {
            return sendJSON(res, 400, { error: '该作答不属于当前批次，拒绝修改' });
          }

          target.errorReason = errorReason;
          saveLearningStore(store);
          return sendJSON(res, 200, { ok: true, attemptId, errorReason, batchId });
        }

        const unitSection = ui.unit.section || 'misc';
        const isObjective = unitSection !== 'translation' && unitSection !== 'writing';
        const batchId = String(body.batchId || '').trim();
        if (!batchId) return sendJSON(res, 400, { error: '缺少 batchId（用于关联本次提交的作答与错因）' });

        const qs = ui.items.filter(it => it.type === 'question' && it.number != null);
        const std = loadAnswers()[unitId] || {};
        const given = body.answers && typeof body.answers === 'object' ? body.answers : {};
        const confObj = body.confidence && typeof body.confidence === 'object' ? body.confidence : {};
        const subjective = body.subjective && typeof body.subjective === 'object' ? body.subjective : {};
        const translations = subjective.translations && typeof subjective.translations === 'object'
          ? subjective.translations
          : {};
        const essayText = typeof subjective.essay === 'string' ? subjective.essay.trim() : '';

        // v2.2.8：按 unit.section 严格分支，拒绝不属于当前 section 的字段
        const hasGiven = Object.keys(given).length > 0;
        const hasTrans = Object.keys(translations).length > 0;
        const hasEssay = essayText.length > 0;
        if (unitSection === 'translation') {
          if (hasGiven) return sendJSON(res, 400, { error: '当前为翻译单元，不接受客观题作答 answers' });
          if (hasEssay) return sendJSON(res, 400, { error: '当前为翻译单元，不接受写作 essay' });
        } else if (unitSection === 'writing') {
          if (hasGiven) return sendJSON(res, 400, { error: '当前为写作单元，不接受客观题作答 answers' });
          if (hasTrans) return sendJSON(res, 400, { error: '当前为写作单元，不接受翻译 translations' });
        } else {
          if (hasTrans) return sendJSON(res, 400, { error: '当前为客观题单元，不接受翻译 translations' });
          if (hasEssay) return sendJSON(res, 400, { error: '当前为客观题单元，不接受写作 essay' });
        }

        // v2.2.8：严格校验客观题答案（单个 A–Z）与题号归属，非法直接 400
        const unitNumbers = new Set(qs.map(it => String(it.number)));
        for (const numStr of Object.keys(given)) {
          const raw = String(given[numStr] || '').trim().toUpperCase();
          if (!raw) continue;
          if (!/^[A-Z]$/.test(raw)) {
            return sendJSON(res, 400, { error: `第 ${numStr} 题答案非法（需为单个 A–Z）` });
          }
          if (!unitNumbers.has(String(numStr))) {
            return sendJSON(res, 400, { error: `第 ${numStr} 题不属于当前单元` });
          }
        }
        for (const numStr of Object.keys(confObj)) {
          const c = String(confObj[numStr] || '').trim();
          if (c && !VALID_ATTEMPT_CONFIDENCES.has(c)) {
            return sendJSON(res, 400, { error: `第 ${numStr} 题信心非法（仅 sure/unsure/guess）` });
          }
        }

        // 耗时与起止时间（v2.2.8：整单元会话耗时存 meta.sessionDurationMs，durationMs 不再伪装单题耗时）
        const now = new Date();
        const submittedAt = now.toISOString();
        let startedAt = null;
        let unitDurationMs = null;
        if (body.startedAt) {
          const st = new Date(body.startedAt);
          if (!isNaN(st.getTime())) {
            startedAt = st.toISOString();
            unitDurationMs = Math.max(0, Math.min(14400000, now.getTime() - st.getTime()));
          }
        }

        const attemptsToSave = [];
        const results = [];

        // 1. 客观题处理
        for (const it of qs) {
          const rawPicked = String(given[String(it.number)] || '').trim().toUpperCase();
          const picked = /^[A-Z]$/.test(rawPicked) ? rawPicked : null;
          const correct = std[String(it.number)] || null;
          const isJudged = picked && correct;
          const ok = isJudged ? picked === correct : null;

          let conf = confObj[String(it.number)] ? String(confObj[String(it.number)]).trim() : 'unsure';
          if (!VALID_ATTEMPT_CONFIDENCES.has(conf)) conf = 'unsure';

          const attemptId = `att_uo_${Date.now()}_${it.number}_${Math.random().toString(36).slice(2, 6)}`;
          results.push({
            number: it.number,
            picked,
            correct,
            ok,
            attemptId,
            batchId,
          });

          // 只有用户作答了才落盘流水
          if (picked) {
            attemptsToSave.push({
              id: attemptId,
              kind: 'unit_objective',
              source: 'exam',
              itemId: `${unitId}:${it.number}`,
              unitId,
              examId: ui.unit.examId || null,
              year: ui.unit.year || null,
              section: ui.unit.section || 'reading',
              prompt: it.text ? String(it.text).slice(0, 4000) : `第 ${it.number} 题`,
              expected: correct ? String(correct) : null,
              answer: picked,
              result: ok === true ? 'correct' : ok === false ? 'incorrect' : 'unjudged',
              confidence: conf,
              errorReason: null,
              startedAt,
              submittedAt,
              durationMs: null,
              meta: {
                unitTitle: ui.unit.title,
                number: it.number,
                batchId,
                sessionDurationMs: unitDurationMs,
              },
            });
          }
        }

        // 2. 主观题处理：翻译
        let subjectiveCount = 0;
        if (unitSection === 'translation' && hasTrans) {
          for (const [numStr, tText] of Object.entries(translations)) {
            const rawText = String(tText || '').trim();
            if (!rawText) continue;
            if (rawText.length > 2000) {
              return sendJSON(res, 400, { error: `第 ${numStr} 题翻译译文超过 2000 字符限制` });
            }
            subjectiveCount++;
            const qMatch = qs.find(q => String(q.number) === String(numStr));
            attemptsToSave.push({
              kind: 'translation',
              source: 'exam',
              itemId: `${unitId}:${numStr}`,
              unitId,
              examId: ui.unit.examId || null,
              year: ui.unit.year || null,
              section: 'translation',
              prompt: qMatch?.text ? String(qMatch.text).slice(0, 4000) : `第 ${numStr} 题划线句`,
              expected: null,
              answer: rawText,
              result: 'unjudged',
              confidence: 'unsure',
              startedAt,
              submittedAt,
              durationMs: null,
              meta: {
                unitTitle: ui.unit.title,
                number: Number(numStr) || null,
                wordCount: rawText.length,
                batchId,
                sessionDurationMs: unitDurationMs,
              },
            });
          }
        }

        // 3. 主观题处理：写作
        if (unitSection === 'writing' && hasEssay) {
          if (essayText.length > 4000) {
            return sendJSON(res, 400, { error: '作文草稿超过 4000 字符限制' });
          }
          subjectiveCount++;
          const wItem = ui.items.find(it => it.type === 'writing') || {};
          const partStr = wItem.part || (ui.unit.title.includes('Part B') ? 'B' : 'A');
          attemptsToSave.push({
            kind: 'writing',
            source: 'exam',
            itemId: `${unitId}:writing:${partStr}`,
            unitId,
            examId: ui.unit.examId || null,
            year: ui.unit.year || null,
            section: 'writing',
            prompt: wItem.text ? String(wItem.text).slice(0, 4000) : ui.unit.title,
            expected: null,
            answer: essayText,
            result: 'unjudged',
            confidence: 'unsure',
            startedAt,
            submittedAt,
            durationMs: null,
            meta: {
              unitTitle: ui.unit.title,
              part: partStr,
              score: wItem.score || null,
              wordCount: essayText.split(/\s+/).filter(Boolean).length,
              batchId,
              sessionDurationMs: unitDurationMs,
            },
          });
        }

        // 4. 落盘学习流水
        let attemptsSaved = 0;
        if (attemptsToSave.length > 0) {
          attemptsSaved = appendLearningAttempts(attemptsToSave);
        }

        // 5. 双写旧 unitLog（仅计算客观题，主观题不干扰正确率）
        const judged = results.filter(r => r.ok !== null);
        const correctN = judged.filter(r => r.ok).length;
        db.unitLog.push({
          ts: submittedAt.slice(0, 19),
          unitId,
          title: ui.unit.title,
          total: qs.length,
          judged: judged.length,
          correct: correctN,
          subjective: subjectiveCount,
        });
        if (db.unitLog.length > 500) db.unitLog = db.unitLog.slice(-500);
        persistDB();

        return sendJSON(res, 200, {
          ok: true,
          title: ui.unit.title,
          unitSection,
          batchId,
          results,
          judged: judged.length,
          total: qs.length,
          correct: correctN,
          subjective: subjectiveCount,
          hasStd: Object.keys(std).length > 0,
          attemptsSaved,
          sessionDurationMs: unitDurationMs,
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
        const m = p.match(/^\/api\/exam\/record\/([A-Za-z0-9_-]+)$/);
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

      /* ---- v1.2.0：聊天记录持久化 ---- */

      if (p === '/api/chat/save' && req.method === 'POST') {
        const body = await readBody(req);
        const msgs = Array.isArray(body.messages) ? body.messages.slice(0, 200) : [];
        if (!msgs.length) return sendJSON(res, 400, { error: '消息不能为空' });
        const id = body.id || crypto.randomUUID();
        const title = String(body.title || msgs.find(m => m.word)?.word || msgs[0]?.content?.slice(0, 30) || '对话').slice(0, 60);
        const words = [...new Set(msgs.filter(m => m.word).map(m => m.word))];
        const session = {
          id,
          title,
          words,
          messages: msgs.map(m => ({ role: m.role, content: String(m.content || '').slice(0, 5000), word: m.word || null })),
          createdAt: body.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const all = loadChatHistory();
        const idx = all.findIndex(s => s.id === id);
        if (idx >= 0) all[idx] = session; else all.unshift(session);
        // 保留最近 200 个会话
        if (all.length > 200) all.length = 200;
        saveChatHistory(all);
        return sendJSON(res, 200, { ok: true, id, title });
      }

      if (p === '/api/chat/history' && req.method === 'GET') {
        const all = loadChatHistory();
        const q = (u.searchParams.get('q') || '').toLowerCase();
        let list = all;
        if (q) list = list.filter(s =>
          s.title.toLowerCase().includes(q) ||
          (s.words || []).some(w => w.toLowerCase().includes(q)) ||
          s.messages.some(m => m.content.toLowerCase().includes(q)));
        // 按天分组
        const groups = {};
        for (const s of list) {
          const day = bjDateOf(s.updatedAt || s.createdAt) || 'unknown';
          if (!groups[day]) groups[day] = [];
          groups[day].push({
            id: s.id, title: s.title, words: s.words || [],
            msgCount: s.messages.length,
            createdAt: s.createdAt, updatedAt: s.updatedAt,
            preview: s.messages.filter(m => m.role === 'user').slice(-1)[0]?.content?.slice(0, 80) || '',
          });
        }
        return sendJSON(res, 200, { ok: true, total: list.length, groups });
      }

      {
        const m = p.match(/^\/api\/chat\/session\/([a-f0-9-]+)$/);
        if (m && req.method === 'GET') {
          const s = loadChatHistory().find(x => x.id === m[1]);
          if (!s) return sendJSON(res, 404, { error: '会话不存在' });
          return sendJSON(res, 200, { ok: true, session: s });
        }
        if (m && req.method === 'DELETE') {
          const all = loadChatHistory();
          const idx = all.findIndex(x => x.id === m[1]);
          if (idx < 0) return sendJSON(res, 404, { error: '会话不存在' });
          all.splice(idx, 1);
          saveChatHistory(all);
          return sendJSON(res, 200, { ok: true });
        }
      }

      /* ---- v2.2.0：学习流水接口 ---- */

      if (p === '/api/learning/attempts' && req.method === 'GET') {
        const u = new URL(req.url, 'http://localhost');
        const kind = u.searchParams.get('kind');
        if (kind && !VALID_ATTEMPT_KINDS.has(kind)) {
          return sendJSON(res, 400, { error: `无效的 kind 参数: ${kind}` });
        }
        let limit = parseInt(u.searchParams.get('limit') || '50', 10);
        if (isNaN(limit) || limit < 1) limit = 50;
        if (limit > 200) limit = 200;

        const store = loadLearningStore();
        let list = store.attempts || [];
        if (kind) {
          list = list.filter(a => a.kind === kind);
        }
        // 按时间倒序（submittedAt || startedAt）返回最多 limit 条
        const sorted = list.slice().sort((a, b) => {
          const ta = new Date(a.submittedAt || a.startedAt || 0).getTime() || 0;
          const tb = new Date(b.submittedAt || b.startedAt || 0).getTime() || 0;
          return tb - ta;
        });

        return sendJSON(res, 200, {
          ok: true,
          schemaVersion: store.schemaVersion || 1,
          enabledAt: store.enabledAt || null,
          total: list.length,
          attempts: sorted.slice(0, limit),
        });
      }

      /* ---- v2.2.3：学习诊断周报接口 ---- */

      if (p === '/api/learning/report' && req.method === 'GET') {
        const u = new URL(req.url, 'http://localhost');
        const daysParam = u.searchParams.get('days') || '7';
        let days = parseInt(daysParam, 10);
        if (![7, 14, 30].includes(days)) {
          return sendJSON(res, 400, { error: 'days 参数仅允许 7、14 或 30' });
        }
        const report = buildLearningReport(days);
        return sendJSON(res, 200, { ok: true, ...report });
      }

      /* ---- v2.2.4：词汇真题迁移训练接口 ---- */

      if (p === '/api/learning/vocab/generate' && req.method === 'POST') {
        const body = await readBody(req);
        const filter = String(body.filter || 'forget').trim();
        if (!['sticky', 'vague', 'forget', 'due7'].includes(filter)) {
          return sendJSON(res, 400, { error: 'filter 参数仅允许 sticky/vague/forget/due7' });
        }
        let count = parseInt(body.count, 10);
        if (isNaN(count)) count = 5;
        count = Math.max(3, Math.min(20, count));
        const wantContext = body.context !== false;
        const wantCloze = body.cloze !== false;
        if (!wantContext && !wantCloze) {
          return sendJSON(res, 400, { error: '至少需要开启一种题型（语境选义或搭配补全）' });
        }
        const raw = generateVocabQuestions(filter, count, { context: wantContext, cloze: wantCloze });
        const questions = raw.map(publicVocabQuestion);
        if (!questions.length) {
          return sendJSON(res, 200, {
            ok: true, questions: [], filter, count,
            message: '没有符合条件的真题迁移题：候选词需既有本地释义、又在真实真题句中出现。可先做基础测验或降低筛选范围。',
          });
        }
        return sendJSON(res, 200, { ok: true, questions, filter, count });
      }

      if (p === '/api/learning/vocab/submit' && req.method === 'POST') {
        const body = await readBody(req);
        const token = String(body.token || '').trim();
        const answer = String(body.answer || '').trim();
        if (!token) return sendJSON(res, 400, { error: '缺少题目标识 token' });

        const q = vocabQuestionMap.get(token);
        if (!q) {
          return sendJSON(res, 400, { error: '题目已失效（服务可能已重启），请重新生成迁移题', code: 'VOCAB_EXPIRED' });
        }
        if (Date.now() - q.createdAt > VOCAB_QUESTION_TTL_MS) {
          vocabQuestionMap.delete(token);
          return sendJSON(res, 400, { error: '题目已过期，请重新生成', code: 'VOCAB_EXPIRED' });
        }

        // v2.2.8：按 token 绑定的 rid + sourceSentence 在当前索引精确查找，不得只取 evidence.exams[0]
        const gloss = vocabGlossOf(q.word);
        if (!gloss) {
          vocabQuestionMap.delete(token);
          return sendJSON(res, 400, { error: '题目来源已变化，请重新生成', code: 'VOCAB_EXPIRED' });
        }
        const normS = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const srcNorm = normS(q.sourceSentence);
        const examHit = kbSentences().find(it =>
          it.sourceKind === 'exam' &&
          it.rid === q.rid &&
          normS(it.s) === srcNorm);
        if (!examHit) {
          vocabQuestionMap.delete(token);
          return sendJSON(res, 400, { error: '题目来源已变化，请重新生成', code: 'VOCAB_EXPIRED' });
        }

        let expected;
        if (q.kind === 'vocab_context') {
          expected = gloss.gloss;
        } else {
          const form = findWordFormInSentence(examHit.s, q.word);
          if (!form) {
            vocabQuestionMap.delete(token);
            return sendJSON(res, 400, { error: '题目来源已变化，请重新生成', code: 'VOCAB_EXPIRED' });
          }
          expected = form;
        }

        const norm = s => String(s || '').trim().toLowerCase();
        const ok = norm(answer) === norm(expected);

        // v2.2.8：信心非法直接 400，不再静默降级；duration 超范围 400
        let conf = 'unsure';
        if (body.confidence !== undefined && body.confidence !== null && String(body.confidence).trim() !== '') {
          conf = String(body.confidence).trim();
          if (!VALID_ATTEMPT_CONFIDENCES.has(conf)) {
            return sendJSON(res, 400, { error: `无效的 confidence: ${conf}（仅 sure/unsure/guess）` });
          }
        }
        let durationMs = null;
        if (body.durationMs !== undefined && body.durationMs !== null && String(body.durationMs).trim() !== '') {
          const d = Number(body.durationMs);
          if (!Number.isFinite(d) || d < 0 || d > 14400000) {
            return sendJSON(res, 400, { error: '无效的 durationMs（0..14400000 毫秒）' });
          }
          durationMs = Math.round(d);
        }
        const startedAt = body.startedAt ? (() => { const d = new Date(body.startedAt); return isNaN(d) ? null : d.toISOString(); })() : null;
        const submittedAt = new Date().toISOString();

        const attempt = {
          kind: q.kind,
          source: 'exam',
          itemId: `${q.kind}:${q.word}:${(q.token || '').slice(0, 12)}`,
          section: 'vocabulary',
          year: q.year || null,
          prompt: q.sentence,
          expected,
          answer: answer.slice(0, 4000),
          result: ok ? 'correct' : 'incorrect',
          confidence: conf,
          startedAt,
          submittedAt,
          durationMs,
          meta: { word: q.word, sourceKind: q.sourceKind, title: q.title, rid: q.rid || null, mode: 'vocab_transfer' },
        };
        appendLearningAttempts([attempt]);
        vocabQuestionMap.delete(token);   // 一题一提交，防止重复计分

        // 回写单词错词体系（使现有忘记词筛选有效）
        const w = Object.values(db.words).find(x => x.spelling === q.word);
        if (w) {
          w.quizResponse = ok ? 'FAMILIAR' : 'FORGET';
          if (!ok) w.quizWrong = (w.quizWrong || 0) + 1;
          w.quizLastAt = submittedAt;
          persistDB();
        }

        return sendJSON(res, 200, {
          ok: true,
          correct: ok,
          expected,
          word: q.word,
          kind: q.kind,
          attemptsSaved: 1,
        });
      }

      /* ---- v2.2.5：长难句三遍法与 3 天复测接口 ---- */

      if (p === '/api/learning/sentence/start' && req.method === 'POST') {
        const body = await readBody(req);
        // v2.2.8：超长直接拒绝，不得先截断再保存
        const rawText = String(body.text || '').trim();
        if (rawText.length > 600) return sendJSON(res, 400, { error: '句子超过 600 字符限制' });
        const text = rawText;
        if (text.length < 15) return sendJSON(res, 400, { error: '句子长度不足（至少 15 字符）' });
        const context = String(body.context || '').trim().slice(0, 3000);
        const title = String(body.title || '').trim().slice(0, 120);

        // v2.2.8：sourceRef 校验固定以服务端收到的 text 为准；rid 必须命中同 rid 且规范化后完全一致的句子
        let verifiedSource = false;
        let source = 'manual_selection';
        let refRid = null;
        let refSection = null;
        let refYear = null;
        const sourceRef = body.sourceRef && typeof body.sourceRef === 'object' ? body.sourceRef : null;
        let declaredRef = null;
        if (sourceRef && sourceRef.rid) {
          const rid = String(sourceRef.rid);
          declaredRef = {
            rid: rid.slice(0, 64),
            sourceKind: sourceRef.sourceKind ? String(sourceRef.sourceKind).slice(0, 24) : null,
            year: Number.isFinite(Number(sourceRef.year)) ? Number(sourceRef.year) : null,
            section: sourceRef.section ? String(sourceRef.section).slice(0, 40) : null,
          };
          const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const targetNorm = norm(text);
          const hit = kbSentences().find(it => it.rid === rid && norm(it.s) === targetNorm);
          if (hit) {
            verifiedSource = true;
            refRid = hit.rid;
            source = hit.sourceKind === 'exam' ? 'exam' : (hit.sourceKind === 'external' ? 'external' : 'corpus');
            refSection = hit.section || null;
            refYear = hit.year || null;
          }
        }

        const submittedAt = new Date().toISOString();
        const attempt = {
          id: `att_sent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          kind: 'sentence_analysis',
          source,
          itemId: refRid ? `sentence:${refRid}` : 'sentence:manual',
          year: refYear,
          section: 'sentence',
          prompt: text,
          expected: null,
          answer: null,
          result: 'pending',
          confidence: null,
          startedAt: submittedAt,
          submittedAt,
          durationMs: null,
          meta: {
            phase: 'first',
            context,
            title,
            verifiedSource,
            sourceKind: verifiedSource ? source : 'manual_selection',
            rid: refRid,
            refSection,
            refYear,
            sourceRef: declaredRef,
          },
        };
        appendLearningAttempts([attempt]);
        return sendJSON(res, 200, { ok: true, attemptId: attempt.id, verifiedSource, source });
      }

      if (p === '/api/learning/sentence/submit' && req.method === 'POST') {
        const body = await readBody(req);
        const attemptId = String(body.attemptId || '').trim();
        if (!attemptId) return sendJSON(res, 400, { error: '缺少 attemptId' });

        // v2.2.8：同一 attempt 在 LLM 请求期间再次提交直接 409，避免生成两个复测任务
        if (sentenceSubmitInFlight.has(attemptId)) {
          return sendJSON(res, 409, { error: '该训练正在生成反馈，请勿重复提交', code: 'SENTENCE_IN_FLIGHT' });
        }

        // 先校验记录状态（完成/未到期），再校验正文，保证幂等与 409 语义优先
        const store = loadLearningStore();
        const target = (store.attempts || []).find(a => a.id === attemptId);
        if (!target) return sendJSON(res, 404, { error: '训练记录不存在: ' + attemptId });
        if (target.kind !== 'sentence_analysis') return sendJSON(res, 400, { error: '该记录不是长难句训练' });

        const isReview = !!target.reviewOf;
        if (target.result === 'completed') {
          return sendJSON(res, 409, { error: '该训练已完成，请勿重复提交', code: 'SENTENCE_DONE' });
        }
        if (isReview) {
          const dueT = target.dueAt ? new Date(target.dueAt).getTime() : NaN;
          if (isNaN(dueT) || dueT > Date.now()) {
            return sendJSON(res, 409, { error: '复测尚未到期，请到期后再来', code: 'SENTENCE_NOT_DUE' });
          }
        }

        const structure = String(body.structure || '').trim();
        const translation = String(body.translation || '').trim();
        if (structure.length < 2 || translation.length < 2) {
          return sendJSON(res, 400, { error: '结构分析与自译都需要填写' });
        }
        if (structure.length > 2000) return sendJSON(res, 400, { error: '结构分析超过 2000 字符限制' });
        if (translation.length > 2000) return sendJSON(res, 400, { error: '自译超过 2000 字符限制' });

        // 组装 LLM 输入（仅使用读取快照，落盘一律走 updateLearningAttempt 重新读取）
        const msgs = [{ role: 'system', content: getPrompt('sentence_training') }];
        const baseUser = [
          `【原句】${target.prompt}`,
          target.meta?.context ? `【上下文】\n${target.meta.context}` : '',
        ].filter(Boolean).join('\n\n');
        if (isReview) {
          const first = (store.attempts || []).find(a => a.id === target.reviewOf);
          const firstText = first ? `【首答结构分析】\n${first.meta?.structure || ''}\n\n【首答自译】\n${first.meta?.translation || ''}` : '';
          const firstFeedback = first?.expected ? `【首轮反馈】\n${first.expected}` : '';
          msgs.push({ role: 'user', content: [baseUser, firstText, firstFeedback,
            `【复答结构分析】\n${structure}`, `【复答自译】\n${translation}`].filter(Boolean).join('\n\n') });
        } else {
          msgs.push({ role: 'user', content: [baseUser,
            `【结构分析】\n${structure}`, `【自译】\n${translation}`].filter(Boolean).join('\n\n') });
        }

        sentenceSubmitInFlight.add(attemptId);
        try {
          let reply;
          try {
            reply = await llmChat(msgs, {
              maxTokens: (config.review && config.review.thinking) ? 8000 : 1800,
              providerId: (config.review && config.review.providerId) || undefined,
              llmOverride: (() => {
                const over = {};
                if (config.review && config.review.model) over.model = config.review.model;
                if (config.review && config.review.thinking) {
                  over.temperature = 1;
                  over._thinking = { type: 'enabled', budget_tokens: 6000 };
                }
                return Object.keys(over).length ? over : undefined;
              })(),
            });
          } catch (e) {
            // LLM 失败：重新读取最新 store 仅更新目标记录保存输入，保持 pending 以便重试，不生成复测任务
            updateLearningAttempt(attemptId, (att) => {
              att.meta = { ...(att.meta || {}), structure, translation, phase: isReview ? 'review' : 'first', lastError: String(e.message || '').slice(0, 300) };
              att.submittedAt = new Date().toISOString();
              return att;
            });
            return sendJSON(res, 502, { ok: false, retryable: true, error: 'AI 反馈生成失败，已保存你的输入，可稍后重试：' + String(e.message || '').slice(0, 200) });
          }

          const submittedAt = new Date().toISOString();
          let reviewAttemptId = null;

          // LLM 返回后重新读取最新 store 合并首答反馈，禁止用调用前快照整体保存
          updateLearningAttempt(attemptId, (att) => {
            att.answer = `${structure}\n\n[自译] ${translation}`.slice(0, 4000);
            att.expected = String(reply).slice(0, 4000);
            att.result = 'completed';
            att.submittedAt = submittedAt;
            att.meta = { ...(att.meta || {}), structure, translation, phase: isReview ? 'review' : 'first', feedbackAt: submittedAt };
            return att;
          });

          if (!isReview) {
            // 首次成功：生成 3 天后复测任务。重新读取最新 store 后追加，避免覆盖并发写入
            const dueAt = new Date(Date.now() + 3 * 86400000).toISOString();
            const reviewAttempt = {
              kind: 'sentence_analysis',
              source: target.source,
              itemId: target.itemId,
              unitId: target.unitId || null,
              examId: target.examId || null,
              year: target.year || null,
              section: 'sentence',
              prompt: target.prompt,
              expected: null,
              answer: null,
              result: 'pending',
              confidence: null,
              startedAt: submittedAt,
              submittedAt,
              durationMs: null,
              reviewOf: attemptId,
              dueAt,
              meta: { phase: 'review', context: target.meta?.context || '', title: target.meta?.title || '', verifiedSource: !!target.meta?.verifiedSource, sourceKind: target.meta?.sourceKind || 'manual_selection' },
            };
            const normalized = normalizeLearningAttempt(reviewAttempt);
            appendLearningAttempts([normalized]);
            reviewAttemptId = normalized.id;
          }

          return sendJSON(res, 200, {
            ok: true,
            feedback: String(reply),
            isReview,
            reviewAttemptId,
            dueAt: !isReview ? new Date(Date.now() + 3 * 86400000).toISOString() : null,
          });
        } finally {
          sentenceSubmitInFlight.delete(attemptId);
        }
      }

      /* ---- v1.2.0：数据备份与恢复 ---- */

      if (p === '/api/backup/create' && req.method === 'POST') {
        const backupDir = path.join(DATA_DIR, 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        let stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        let backupName = `backup-${stamp}`;
        let bDir = path.join(backupDir, backupName);
        if (fs.existsSync(bDir)) {
          backupName = `backup-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
          bDir = path.join(backupDir, backupName);
        }
        fs.mkdirSync(bDir, { recursive: true });
        // 备份核心数据文件
        const filesToBackup = [
          { src: DB_FILE, name: 'db.json', json: true },
          { src: CONFIG_FILE, name: 'config.json', json: true },
          { src: path.join(DATA_DIR, 'chat_sessions.json'), name: 'chat_sessions.json', json: true },
          { src: LEARNING_ATTEMPTS_FILE, name: 'learning_attempts.json', json: true, learning: true },
          { src: CORPUS_FILE, name: 'records.jsonl' },
          { src: path.join(ROOT, 'corpus', 'exams.jsonl'), name: 'exams.jsonl' },
          { src: KB_VERSIONS_FILE, name: 'kb_versions.json', json: true },
        ];
        let count = 0;
        const warnings = [];
        for (const f of filesToBackup) {
          if (!fs.existsSync(f.src)) continue;
          // v2.2.6：备份前校验 JSON 合法性与学习流水 schema，损坏文件仅告警不中断
          if (f.json) {
            const v = validateJsonFile(f.src);
            if (!v.valid) {
              warnings.push({ file: f.name, reason: '源文件 JSON 损坏，已跳过: ' + (v.error || '解析失败') });
              continue;
            }
            if (f.learning && !isLearningStoreShape(v.obj)) {
              warnings.push({ file: f.name, reason: '学习流水结构不符，已跳过' });
              continue;
            }
          }
          fs.copyFileSync(f.src, path.join(bDir, f.name));
          count++;
        }
        // 清理超过 10 个的旧备份
        const backups = fs.readdirSync(backupDir).filter(d => d.startsWith('backup-')).sort();
        while (backups.length > 10) {
          const old = backups.shift();
          const oldDir = path.join(backupDir, old);
          try { fs.rmSync(oldDir, { recursive: true }); } catch { /* ignore */ }
        }
        return sendJSON(res, 200, { ok: true, name: backupName, files: count, warnings });
      }

      if (p === '/api/backup/list' && req.method === 'GET') {
        const backupDir = path.join(DATA_DIR, 'backups');
        if (!fs.existsSync(backupDir)) return sendJSON(res, 200, { ok: true, backups: [] });
        const list = fs.readdirSync(backupDir)
          .filter(d => d.startsWith('backup-'))
          .sort().reverse()
          .map(d => {
            const bDir = path.join(backupDir, d);
            const files = fs.existsSync(bDir) ? fs.readdirSync(bDir) : [];
            return { name: d, files: files.length, date: d.replace('backup-', '').replace(/-/g, (m, i) => i < 10 ? '-' : i === 10 ? 'T' : ':') };
          });
        return sendJSON(res, 200, { ok: true, backups: list });
      }

      if (p === '/api/backup/restore' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name || !/^backup-/.test(name)) return sendJSON(res, 400, { error: '无效的备份名称' });
        const bDir = path.join(DATA_DIR, 'backups', name);
        if (!fs.existsSync(bDir)) return sendJSON(res, 404, { error: '备份不存在: ' + name });

        // v2.2.6：恢复前逐文件校验（JSON 合法性 + 学习流水 schema），损坏则跳过并告警，绝不静默覆盖
        const restoreMap = [
          { name: 'db.json', dst: DB_FILE, json: true },
          { name: 'config.json', dst: CONFIG_FILE, json: true },
          { name: 'chat_sessions.json', dst: path.join(DATA_DIR, 'chat_sessions.json'), json: true },
          { name: 'learning_attempts.json', dst: LEARNING_ATTEMPTS_FILE, json: true, learning: true },
          { name: 'records.jsonl', dst: CORPUS_FILE, json: false },
          { name: 'exams.jsonl', dst: path.join(ROOT, 'corpus', 'exams.jsonl'), json: false },
          { name: 'kb_versions.json', dst: KB_VERSIONS_FILE, json: true },
        ];
        const warnings = [];
        const skipped = [];
        let restored = 0;

        for (const f of restoreMap) {
          const src = path.join(bDir, f.name);
          if (!fs.existsSync(src)) {
            // 备份不含该文件：保留当前数据，不创建空文件覆盖（学习流水尤其如此）
            if (f.learning) skipped.push({ file: f.name, reason: '备份不含该文件，已保留当前学习流水' });
            continue;
          }
          if (f.json) {
            const v = validateJsonFile(src);
            if (!v.valid) {
              warnings.push({ file: f.name, reason: 'JSON 损坏，已跳过: ' + (v.error || '解析失败') });
              continue;
            }
            if (f.learning && !isLearningStoreShape(v.obj)) {
              warnings.push({ file: f.name, reason: 'schemaVersion/attempts 结构不符，已跳过' });
              continue;
            }
          }
          try {
            fs.copyFileSync(src, f.dst);
            restored++;
          } catch (e) {
            warnings.push({ file: f.name, reason: '写入失败: ' + String(e.message || e).slice(0, 120) });
          }
        }

        // 重新加载内存数据（学习流水由 loadLearningStore() 每次从文件实时读取，无需额外缓存失效）
        config = loadJSON(CONFIG_FILE, config);
        db = loadJSON(DB_FILE, db);
        armAutoSync();
        return sendJSON(res, 200, {
          ok: true, restored, name, warnings, skipped,
          learningPreserved: skipped.some(s => s.file === 'learning_attempts.json'),
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

/* v1.2.0：自动备份——启动时检查，之后每 6 小时一次（最多保留 10 份） */
function autoBackup() {
  const backupDir = path.join(DATA_DIR, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  // 检查最近一次备份时间，不足 6 小时则跳过
  const existing = fs.readdirSync(backupDir).filter(d => d.startsWith('backup-')).sort();
  if (existing.length) {
    const last = existing[existing.length - 1];
    const ts = last.replace('backup-', '').replace(/-/g, (m, i) => i < 10 ? '-' : i === 10 ? 'T' : ':');
    const elapsed = Date.now() - new Date(ts + ':00').getTime();
    if (elapsed < 6 * 3600_000) return;   // 距上次备份不足 6h
  }
  let stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let bDir = path.join(backupDir, `backup-${stamp}`);
  if (fs.existsSync(bDir)) {
    stamp = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    bDir = path.join(backupDir, `backup-${stamp}`);
  }
  try {
    fs.mkdirSync(bDir, { recursive: true });
    const files = [
      { src: DB_FILE, name: 'db.json', json: true },
      { src: CONFIG_FILE, name: 'config.json', json: true },
      { src: CHAT_FILE, name: 'chat_sessions.json', json: true },
      { src: LEARNING_ATTEMPTS_FILE, name: 'learning_attempts.json', json: true, learning: true },
      { src: CORPUS_FILE, name: 'records.jsonl' },
      { src: path.join(ROOT, 'corpus', 'exams.jsonl'), name: 'exams.jsonl' },
      { src: KB_VERSIONS_FILE, name: 'kb_versions.json', json: true },
    ];
    for (const f of files) {
      if (!fs.existsSync(f.src)) continue;
      // v2.2.6：损坏文件跳过，避免自动备份把坏数据固化
      if (f.json) {
        const v = validateJsonFile(f.src);
        if (!v.valid) { console.error(`  [自动备份] 跳过损坏文件 ${f.name}: ${v.error}`); continue; }
        if (f.learning && !isLearningStoreShape(v.obj)) { console.error(`  [自动备份] 跳过结构不符的 ${f.name}`); continue; }
      }
      fs.copyFileSync(f.src, path.join(bDir, f.name));
    }
    // 清理旧备份（保留 10 份）
    const all = fs.readdirSync(backupDir).filter(d => d.startsWith('backup-')).sort();
    while (all.length > 10) {
      try { fs.rmSync(path.join(backupDir, all.shift()), { recursive: true }); } catch {}
    }
    console.log(`  [自动备份] ${stamp} 完成`);
  } catch (e) {
    console.error('  [自动备份] 失败:', e.message);
  }
}
autoBackup();
setInterval(autoBackup, 6 * 3600_000);   // 每 6 小时

server.listen(PORT, HOST, () => {
  console.log(`\n  英语学习工作台已启动`);
  console.log(`  ➜  http://localhost:${PORT}  (listening on ${HOST})`);
  console.log(`  数据目录: ${DATA_DIR}\n`);
  if (!config.maimemoToken) console.log('  [提示] 尚未配置墨墨 Token，请打开网页在「设置」中填写\n');
});
