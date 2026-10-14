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
const APP_VERSION = (() => {
  try { return require(path.join(ROOT, 'package.json')).version || ''; } catch { return ''; }
})();
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
// v2.8.0：日志版块——开发日志 / 使用日志（data/logs.json，人工维护）+ 报错日志（data/error_log.json，自动采集）
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const ERROR_LOG_FILE = path.join(DATA_DIR, 'error_log.json');
const MAX_ERROR_LOGS = 500;   // 报错日志上限（超出裁掉最旧）
const LEARNING_ATTEMPTS_FILE = path.join(DATA_DIR, 'learning_attempts.json');
// v2.10.0：测验记忆引擎（自维护 SRS + 错题本 + 游戏化），独立文件不膨胀 db.json
const QUIZ_SRS_FILE = path.join(DATA_DIR, 'quiz_srs.json');
// v2.11.0：自适应组卷会话（跨设备/刷新可续做），独立文件不膨胀 db.json
const QUIZ_SESSION_FILE = path.join(DATA_DIR, 'quiz_session.json');
// v3.3.6：今日任务中心与考试计划（按用户隔离，随备份恢复）
const STUDY_PLAN_FILE = 'study_plan.json';
const PORT = process.env.PORT ? Number(process.env.PORT) : 5178;
// 本机默认只监听 127.0.0.1；云服务器部署时设置 HOST=0.0.0.0（建议配合 nginx/防火墙）
const HOST = process.env.HOST || '127.0.0.1';

/* v3.3.3：认证接口的轻量进程内频控。生产环境仍应在 nginx/Cloudflare 层
   配合更严格的限流；这里保证直接暴露 Node 端口时登录接口不会无限尝试。 */
const AUTH_RATE_WINDOW_MS = 15 * 60_000;
const AUTH_RATE_MAX = Math.max(5, Number(process.env.AUTH_RATE_MAX) || 20);
const authRateBuckets = new Map();
function clientAddress(req) {
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 100);
}
function authRateLimited(req) {
  const now = Date.now();
  const key = clientAddress(req);
  let bucket = authRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= AUTH_RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    authRateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (authRateBuckets.size > 2000) {
    for (const [k, v] of authRateBuckets) if (now - v.startedAt >= AUTH_RATE_WINDOW_MS) authRateBuckets.delete(k);
  }
  return bucket.count > AUTH_RATE_MAX;
}

/* v3.3.3：浏览器写请求的 Origin/Referer 校验，补上 Cookie 会话的 CSRF 防线。
   缺少这些头的 CLI/同源服务端调用仍可用；跨站浏览器请求直接拒绝。 */
function sameSiteWriteRequest(req, pathname) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  if (!pathname.startsWith('/api/')) return true;
  const origin = String(req.headers.origin || '').trim();
  const referer = String(req.headers.referer || '').trim();
  if (!origin && !referer) return true;
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const expectedHost = forwardedHost || String(req.headers.host || '').trim();
  const trusted = String(process.env.TRUSTED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const check = value => {
    try {
      const u = new URL(value);
      return trusted.includes(value) || u.host === expectedHost;
    } catch { return false; }
  };
  return (!origin || check(origin)) && (!referer || check(referer));
}

/** 北京时间（Asia/Shanghai）的 YYYY-MM-DD，offsetDays 为偏移天数 */
function bjDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}

// v3.5.2：允许测试经 MAIMEMO_BASE 覆盖（默认官方端点，行为不变），便于注入假墨墨服务端回归同步清理
const MM_BASE = process.env.MAIMEMO_BASE || 'https://open.maimemo.com/open/api/v1/memo';

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
  if (MULTIUSER && !fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });
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

/* v3.3.1：出站 fetch 统一超时护栏——防止上游（LLM/墨墨/生图/搜索/MinerU）无响应时
   fetch 永久挂起，进而毒死 per-user 写串行队列（enqueueUserWrite）导致该用户所有写请求卡死。
   Node 原生 fetch 默认无超时；此处用 AbortSignal.timeout 强制中断并抛出可读错误。 */
const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 30000;
function fetchT(url, opts = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const { signal, timeout = timeoutMs, ...rest } = opts;
  const ms = Number(timeout);
  if (!ms || ms <= 0 || signal) return fetch(url, opts);   // 显式自带 signal / 关闭超时时尊重调用方
  return fetch(url, { ...rest, signal: AbortSignal.timeout(ms) });
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

/* ================================================================== */
/* v3.0.0：多用户隔离层                                                  */
/*   - AsyncLocalStorage 请求上下文（每个请求绑定 userId / role）          */
/*   - 用户注册表 data/users.json + 会话持久化 data/sessions.json         */
/*   - per-user 存储路径解析（config.multiUser=false 时行为与 v2.12.0 完全   */
/*     一致，保证既有测试与现有线上数据零破坏）                            */
/*   - config / db 透明 Proxy：业务代码零改动，按当前用户自动解析           */
/*   - 每用户写串行队列：避免同一用户并发写互相覆盖                        */
/*   - 一次性迁移：现有数据归入 admin 用户                                */
/* ================================================================== */
const { AsyncLocalStorage } = require('async_hooks');
const requestContext = new AsyncLocalStorage();
const LEGACY_USER = '__legacy__';
const USERS_DIR = path.join(DATA_DIR, 'users');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
// 属于「每个用户各自设置」的 config 字段；其余字段（llm/auth/kb/dict/...）为全局共享
const USER_CONFIG_KEYS = new Set([
  'maimemoToken', 'maimemoNotepadId', 'notepadTitle', 'autoSync',
  'diyPrompts', 'review', 'selection', 'story', 'writingOcr', 'storyThemes',
]);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function defaultDbSkeleton() {
  return {
    lastSync: null,
    lastSyncOk: true,
    syncLog: [],            // [{ts, ok, msg}]
    progressHistory: [],    // [{date, finished, total, studyTimeMs}]
    planTotal: 0,           // 学习计划总词数
    words: {},              // vocId -> {...}
    glosses: {},            // spelling -> {phonetic, pos, gloss}
    todayItems: [],         // 最近一次同步的今日词表
    notes: [],              // 助记
    sessions: [],           // 学习会话
    quizLog: [],            // 测验记录
    contentCreated: { date: '', count: 0 },
    unitLog: [],            // 单元做题记录
    stories: [],            // 词文成章
  };
}

/** 旧 db.json 兼容：缺失字段补默认值 */
function normalizeDb(obj) {
  const out = Object.assign(defaultDbSkeleton(), (obj && typeof obj === 'object') ? obj : {});
  if (!out.glosses || typeof out.glosses !== 'object') out.glosses = {};
  if (!Array.isArray(out.quizLog)) out.quizLog = [];
  if (out.lastSyncOk === undefined) out.lastSyncOk = true;
  if (!out.contentCreated || typeof out.contentCreated !== 'object') out.contentCreated = { date: '', count: 0 };
  if (!Array.isArray(out.unitLog)) out.unitLog = [];
  if (!Array.isArray(out.stories)) out.stories = [];
  if (!out.words || typeof out.words !== 'object') out.words = {};
  if (!Array.isArray(out.notes)) out.notes = [];
  if (!Array.isArray(out.sessions)) out.sessions = [];
  if (!Array.isArray(out.syncLog)) out.syncLog = [];
  if (!Array.isArray(out.progressHistory)) out.progressHistory = [];
  if (!Array.isArray(out.todayItems)) out.todayItems = [];
  return out;
}

function defaultUserConfig() {
  return {
    maimemoToken: '',
    maimemoNotepadId: '',
    notepadTitle: '',
    autoSync: { enabled: false, minutes: 60 },
    diyPrompts: {},
    review: { providerId: '', model: '', thinking: false },
    selection: { providerId: '', model: '' },
    story: { providerId: '', model: '' },
    writingOcr: { providerId: '', model: '' },
    storyThemes: null,
  };
}
function normalizeUserConfig(c) {
  const out = Object.assign(defaultUserConfig(), (c && typeof c === 'object') ? c : {});
  if (!out.autoSync || typeof out.autoSync !== 'object') out.autoSync = { enabled: false, minutes: 60 };
  if (!out.diyPrompts || typeof out.diyPrompts !== 'object') out.diyPrompts = {};
  if (!out.review || typeof out.review !== 'object') out.review = { providerId: '', model: '', thinking: false };
  if (!out.selection || typeof out.selection !== 'object') out.selection = { providerId: '', model: '' };
  if (!out.story || typeof out.story !== 'object') out.story = { providerId: '', model: '' };
  if (!out.writingOcr || typeof out.writingOcr !== 'object') out.writingOcr = { providerId: '', model: '' };
  if (out.storyThemes !== undefined && out.storyThemes !== null && !Array.isArray(out.storyThemes)) out.storyThemes = null;
  return out;
}

let rawConfig = loadJSON(CONFIG_FILE, {
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
  auth: { enabled: false, token: '' },   // v2.8.0：Token 凭证登录（开发者登录方式；关闭时无需登录）
  tts: { accent: 'en_US' },              // v3.5.0：发音朗读默认口音（en_US 美音 / en_GB 英音）
  multiUser: false,                      // v3.0.0：多用户总开关（false=保持 v2.12.0 单用户行为）
});
/** 多用户总开关：仅当 config.multiUser===true 时启用隔离；否则完全走旧路径 */
let MULTIUSER = rawConfig.multiUser === true;

/* 用户注册表 data/users.json：{ schemaVersion, nextId, users:{id:{...}}, invites:[{code,...}] } */
const userRegistry = loadJSON(USERS_FILE, { schemaVersion: 1, nextId: 1, users: {}, invites: [] });
if (!userRegistry.users || typeof userRegistry.users !== 'object') userRegistry.users = {};
if (!Array.isArray(userRegistry.invites)) userRegistry.invites = [];
if (!Number.isFinite(userRegistry.nextId) || userRegistry.nextId < 1) userRegistry.nextId = 1;

function persistUserRegistry() { saveJSON(USERS_FILE, userRegistry); }
function userCount() { return Object.keys(userRegistry.users).length; }
function adminUserId() {
  const admin = Object.values(userRegistry.users).find(u => u.role === 'admin');
  return admin ? admin.id : (Object.keys(userRegistry.users)[0] || null);
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, quotas: u.quotas || null };
}
function findUserByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return Object.values(userRegistry.users).find(u => String(u.username).toLowerCase() === n) || null;
}
function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
function verifyPassword(password, user) {
  try {
    if (!user || !user.salt || !user.hash) return false;
    const calc = crypto.scryptSync(String(password), Buffer.from(user.salt, 'hex'), 64);
    const stored = Buffer.from(user.hash, 'hex');
    if (calc.length !== stored.length) return false;
    return crypto.timingSafeEqual(calc, stored);
  } catch { return false; }
}
function userDir(userId) { return path.join(USERS_DIR, userId); }
function userConfigPath(userId) { return path.join(USERS_DIR, userId, 'config.json'); }
function ensureUserDir(userId) { fs.mkdirSync(userDir(userId), { recursive: true }); }

const userConfigCache = new Map();
const userDbCache = new Map();
let legacyDb = null;

/** 当前请求上下文；无请求上下文（启动期/定时器）时：多用户回退到管理员，否则回退到旧单用户 */
function currentCtx() {
  const store = requestContext.getStore();
  if (store) return store;
  if (MULTIUSER) { const aid = adminUserId(); if (aid) return { userId: aid, role: 'admin' }; }
  return { userId: LEGACY_USER, role: 'admin', legacy: true };
}
function getUserConfig(userId) {
  if (userId === LEGACY_USER) return rawConfig;
  if (!userConfigCache.has(userId)) {
    userConfigCache.set(userId, normalizeUserConfig(loadJSON(userConfigPath(userId), defaultUserConfig())));
  }
  return userConfigCache.get(userId);
}
function currentUserConfig() { return getUserConfig(currentCtx().userId); }
function getUserDb(userId) {
  if (userId === LEGACY_USER) return legacyDb;
  if (!userDbCache.has(userId)) {
    userDbCache.set(userId, normalizeDb(loadJSON(path.join(userDir(userId), 'db.json'), defaultDbSkeleton())));
  }
  return userDbCache.get(userId);
}
function currentDbObject() { return getUserDb(currentCtx().userId); }
/** per-user 文件路径解析：单用户模式 = data/<file>；多用户 = data/users/<uid>/<file> */
function ctxFilePath(filename) {
  const ctx = currentCtx();
  if (!MULTIUSER || ctx.userId === LEGACY_USER) return path.join(DATA_DIR, filename);
  return path.join(USERS_DIR, ctx.userId, filename);
}
/** 生图目录（v3.0.0 多用户下按用户隔离，防跨用户看到他人图片） */
function currentImagesDir() {
  const ctx = currentCtx();
  if (!MULTIUSER || ctx.userId === LEGACY_USER) return IMAGES_DIR;
  return path.join(USERS_DIR, ctx.userId, 'images');
}

/** config Proxy：用户级字段路由到当前用户，全局字段落在 rawConfig */
function createConfigProxy() {
  const handler = {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (MULTIUSER && USER_CONFIG_KEYS.has(prop)) return currentUserConfig()[prop];
      return rawConfig[prop];
    },
    set(_t, prop, value) {
      if (MULTIUSER && USER_CONFIG_KEYS.has(prop)) { currentUserConfig()[prop] = value; return true; }
      rawConfig[prop] = value; return true;
    },
    deleteProperty(_t, prop) {
      if (MULTIUSER && USER_CONFIG_KEYS.has(prop)) { delete currentUserConfig()[prop]; return true; }
      delete rawConfig[prop]; return true;
    },
    has(_t, prop) {
      if (MULTIUSER && USER_CONFIG_KEYS.has(prop)) return prop in currentUserConfig();
      return prop in rawConfig;
    },
    ownKeys() {
      const keys = new Set(Reflect.ownKeys(rawConfig));
      if (MULTIUSER) for (const k of Object.keys(currentUserConfig())) keys.add(k);
      return [...keys];
    },
    getOwnPropertyDescriptor(_t, prop) {
      const present = (MULTIUSER && USER_CONFIG_KEYS.has(prop)) ? (prop in currentUserConfig()) : (prop in rawConfig);
      if (!present) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: handler.get(_t, prop) };
    },
  };
  return new Proxy({}, handler);
}

/** db Proxy：所有 db.* 访问透明路由到当前用户的 db 对象 */
function createDbProxy() {
  const handler = {
    get(_t, prop) { if (typeof prop === 'symbol') return undefined; return currentDbObject()[prop]; },
    set(_t, prop, value) { currentDbObject()[prop] = value; return true; },
    deleteProperty(_t, prop) { delete currentDbObject()[prop]; return true; },
    has(_t, prop) { return prop in currentDbObject(); },
    ownKeys() { return Reflect.ownKeys(currentDbObject()); },
    getOwnPropertyDescriptor(_t, prop) {
      const o = currentDbObject();
      if (!(prop in o)) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: o[prop] };
    },
  };
  return new Proxy({}, handler);
}

legacyDb = normalizeDb(loadJSON(DB_FILE, defaultDbSkeleton()));
const config = createConfigProxy();
let db = createDbProxy();

function persistConfig() {
  if (!MULTIUSER) { saveJSON(CONFIG_FILE, rawConfig); return; }
  saveJSON(CONFIG_FILE, rawConfig);
  const ctx = currentCtx();
  if (ctx.userId !== LEGACY_USER) saveJSON(userConfigPath(ctx.userId), getUserConfig(ctx.userId));
}
function persistDB() { saveJSON(ctxFilePath('db.json'), currentDbObject()); }
function reloadConfigFromDisk() {
  rawConfig = loadJSON(CONFIG_FILE, rawConfig);
  MULTIUSER = rawConfig.multiUser === true;
  userConfigCache.clear();
}
function reloadDbFromDisk() {
  const ctx = currentCtx();
  if (ctx.userId === LEGACY_USER) legacyDb = normalizeDb(loadJSON(DB_FILE, legacyDb));
  else userDbCache.delete(ctx.userId);
}

/* v3.0.0：备份/恢复文件清单生成（单用户保持 v2.12.0 顶层布局；多用户按 users/<id>/ 分目录） */
const USER_DATA_FILES = [
  { file: 'config.json', json: true },
  { file: 'db.json', json: true },
  { file: 'chat_sessions.json', json: true },
  { file: 'learning_attempts.json', json: true, learning: true },
  { file: 'quiz_srs.json', json: true, quizSrs: true },
  { file: 'quiz_session.json', json: true, quizSession: true },
  { file: 'essays.json', json: true },
  { file: 'llm_usage.json', json: true },   // v3.2.0：AI 用量统计
  { file: STUDY_PLAN_FILE, json: true },    // v3.3.6：考试计划/任务完成状态
];
function backupFileSpecs() {
  const specs = [];
  if (!MULTIUSER) {
    // 单用户：顶层布局（config.json 为全局，单独追加，避免重复）
    for (const f of USER_DATA_FILES) {
      if (f.file === 'config.json') continue;
      specs.push({ src: path.join(DATA_DIR, f.file), name: f.file, ...f });
    }
  } else {
    for (const uid of Object.keys(userRegistry.users)) {
      for (const f of USER_DATA_FILES) {
        specs.push({ src: path.join(USERS_DIR, uid, f.file), name: `users/${uid}/${f.file}`, ...f });
      }
    }
    specs.push({ src: USERS_FILE, name: 'users.json', json: true });
    specs.push({ src: SESSIONS_FILE, name: 'sessions.json', json: true });
  }
  specs.push({ src: CONFIG_FILE, name: 'config.json', json: true });   // 全局配置
  specs.push({ src: CORPUS_FILE, name: 'records.jsonl' });
  specs.push({ src: path.join(ROOT, 'corpus', 'exams.jsonl'), name: 'exams.jsonl' });
  specs.push({ src: KB_VERSIONS_FILE, name: 'kb_versions.json', json: true });
  return specs;
}
function restoreFileSpecs() {
  // 与 backupFileSpecs 同布局；name 为备份内相对路径，dst 为磁盘目标
  const out = [];
  if (!MULTIUSER) {
    for (const f of USER_DATA_FILES) {
      if (f.file === 'config.json') continue;
      out.push({ name: f.file, dst: path.join(DATA_DIR, f.file), ...f });
    }
  } else {
    for (const uid of Object.keys(userRegistry.users)) {
      for (const f of USER_DATA_FILES) out.push({ name: `users/${uid}/${f.file}`, dst: path.join(USERS_DIR, uid, f.file), ...f });
    }
    out.push({ name: 'users.json', dst: USERS_FILE, json: true });
    out.push({ name: 'sessions.json', dst: SESSIONS_FILE, json: true });
  }
  out.push({ name: 'config.json', dst: CONFIG_FILE, json: true });
  out.push({ name: 'records.jsonl', dst: CORPUS_FILE, json: false });
  out.push({ name: 'exams.jsonl', dst: path.join(ROOT, 'corpus', 'exams.jsonl'), json: false });
  out.push({ name: 'kb_versions.json', dst: KB_VERSIONS_FILE, json: true });
  return out;
}

/* v3.0.0/v3.4.2：每用户写串行队列。断开请求、超时和过长队列都必须快速释放，
 * 避免一个取消的请求永久堵住后续配置保存。 */
const userWriteChains = new Map();
const USER_WRITE_QUEUE_MAX = 32;
const USER_WRITE_TIMEOUT_MS = 6 * 60_000;
function enqueueUserWrite(userId, fn) {
  let state = userWriteChains.get(userId);
  if (!state) {
    state = { tail: Promise.resolve(), pending: 0 };
    userWriteChains.set(userId, state);
  }
  if (state.pending >= USER_WRITE_QUEUE_MAX) {
    const e = new Error('写请求过多，请稍后重试');
    e.code = 'WRITE_QUEUE_FULL';
    return Promise.reject(e);
  }
  state.pending += 1;
  /* 保持 tail 绑定真实任务完成态。调用方超时只能结束当前响应，不能让后续写入
   * 越过仍可能落盘的旧任务，否则会重新引入并发覆盖。 */
  const task = state.tail.then(() => Promise.resolve().then(fn));
  const run = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const e = new Error('写请求处理超时，请稍后重试');
      e.code = 'WRITE_TIMEOUT';
      reject(e);
    }, USER_WRITE_TIMEOUT_MS);
    timer.unref?.();
    task.then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
  state.tail = task.then(() => {}, () => {}).finally(() => {
    state.pending = Math.max(0, state.pending - 1);
    if (state.pending === 0 && userWriteChains.get(userId) === state) userWriteChains.delete(userId);
  });
  return run;
}

/* v3.0.0：会话持久化 data/sessions.json（重启不掉线）；会话绑定 userId */
const AUTH_COOKIE = 'wb_session';
const authSessions = new Map();          // sessionId -> { userId, role, createdAt, lastSeen }
const AUTH_SESSION_TTL_MS = 30 * 86400000;   // 会话 30 天（该设备默认保持登录）
(function loadSessions() {
  const raw = loadJSON(SESSIONS_FILE, { schemaVersion: 1, sessions: {} });
  const map = (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') ? raw.sessions : {};
  const now = Date.now();
  for (const [sid, s] of Object.entries(map)) {
    if (!s || typeof s !== 'object' || typeof s.lastSeen !== 'number') continue;
    if (now - s.lastSeen > AUTH_SESSION_TTL_MS) continue;
    authSessions.set(sid, {
      userId: s.userId || LEGACY_USER,
      role: s.role || 'admin',
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : now,
      lastSeen: s.lastSeen,
    });
  }
})();
function persistSessions() {
  const sessions = {};
  for (const [sid, s] of authSessions) sessions[sid] = s;
  saveJSON(SESSIONS_FILE, { schemaVersion: 1, sessions });
}

/** 恒定时间字符串比较，避免时序侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

/** 解析请求 Cookie 头 -> 对象 */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** 登录成功后签发会话并下发 httpOnly Cookie（该设备后续请求自动携带，默认登录） */
function issueAuthCookie(res, userId, role, req = null) {
  const sid = crypto.randomBytes(24).toString('hex');
  authSessions.set(sid, {
    userId: userId || LEGACY_USER,
    role: role || 'admin',
    createdAt: Date.now(),
    lastSeen: Date.now(),
  });
  persistSessions();
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const secure = (String(process.env.HTTPS || '') === '1' || String(process.env.TRUST_PROXY || '') === '1' || forwardedProto === 'https') ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}${secure}`);
  return sid;
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * 解析当前请求的认证上下文。
 * 单用户模式：沿用 v2.8.0 Token 闸门，通过则为 LEGACY_USER。
 * 多用户模式：会话携带 userId，映射到注册表。
 * @returns {{ ok:boolean, store:{userId:string, role:string, legacy?:boolean} }}
 */
function resolveAuthContext(req) {
  const sid = parseCookies(req)[AUTH_COOKIE];
  let session = sid ? authSessions.get(sid) : null;
  if (session && (typeof session.lastSeen !== 'number' || Date.now() - session.lastSeen > AUTH_SESSION_TTL_MS)) {
    authSessions.delete(sid);
    persistSessions();
    session = null;
  }
  if (session) session.lastSeen = Date.now();
  if (!MULTIUSER) {
    const legacyStore = { userId: LEGACY_USER, role: 'admin', legacy: true };
    if (!rawConfig.auth || !rawConfig.auth.enabled) return { ok: true, store: legacyStore };   // 未启用登录 = 全部放行
    if (!rawConfig.auth.token) return { ok: true, store: legacyStore };                          // 防自锁
    if (session && session.userId === LEGACY_USER) return { ok: true, store: legacyStore };
    return { ok: false, store: legacyStore };
  }
  if (session && session.userId && userRegistry.users[session.userId]) {
    return { ok: true, store: { userId: session.userId, role: userRegistry.users[session.userId].role } };
  }
  return { ok: false, store: { userId: LEGACY_USER, role: 'admin', legacy: true } };
}

/** 多用户下管理员校验（单用户模式恒为真） */
function isAdminCtx(store) { return !MULTIUSER || (store && store.role === 'admin'); }

/** 共享内容写操作守卫（v3.2.0）：多用户下仅管理员可改全局共享资源（真题库/语料库/单元标准答案）。
 *  返回 true 表示放行；否则已发送 403，调用方应直接 return。 */
function requireAdmin(res, store, what) {
  if (isAdminCtx(store)) return true;
  sendJSON(res, 403, { error: `仅管理员可${what || '修改共享内容'}（多用户下共享资源只读）`, code: 'FORBIDDEN' });
  return false;
}

/**
 * v3.0.0：一次性迁移——把现有单用户数据归入 admin 用户，开启多用户。
 * 幂等：已存在用户时抛错；迁移前自动备份 data 核心文件。
 * @returns {{username:string,password:string,generated:boolean,backupDir:string}}
 */
function migrateToMultiUser(adminPasswordRaw) {
  if (userCount() > 0) { const e = new Error('已存在用户，拒绝重复迁移'); e.code = 'USERS_EXIST'; throw e; }
  const provided = String(adminPasswordRaw || '').trim();
  const finalPw = provided || (rawConfig.auth && rawConfig.auth.token) || crypto.randomBytes(9).toString('base64url');
  const generated = !provided && !(rawConfig.auth && rawConfig.auth.token);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(DATA_DIR, 'backups', `backup-v3-migrate-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const fn of ['config.json', 'db.json', 'chat_sessions.json', 'learning_attempts.json',
    'quiz_srs.json', 'quiz_session.json', 'essays.json', 'llm_usage.json', STUDY_PLAN_FILE, 'logs.json', 'error_log.json']) {
    const src = path.join(DATA_DIR, fn);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, fn));
  }

  // 拆分全局 config 与用户 config
  // 注意：必须以「内存中已归一化补全默认值」的 rawConfig 为基准（磁盘上可能缺 imageGen/dict 等
  // 未持久化的默认键，直接读盘会让新用户读到 undefined 而崩溃）
  const globalCfg = JSON.parse(JSON.stringify(rawConfig || {}));
  const userCfg = {};
  for (const k of USER_CONFIG_KEYS) {
    if (globalCfg[k] !== undefined) { userCfg[k] = globalCfg[k]; delete globalCfg[k]; }
  }

  // 建 admin 用户
  const id = 'admin';
  const { salt, hash } = hashPassword(finalPw);
  userRegistry.users[id] = {
    id, username: 'admin', role: 'admin', salt, hash,
    createdAt: new Date().toISOString(), quotas: null,
  };
  userRegistry.nextId = Math.max(userRegistry.nextId, 2);
  persistUserRegistry();
  ensureUserDir(id);

  // 迁移 per-user 数据文件
  for (const fn of ['db.json', 'chat_sessions.json', 'learning_attempts.json',
    'quiz_srs.json', 'quiz_session.json', 'essays.json', 'llm_usage.json', STUDY_PLAN_FILE]) {
    const src = path.join(DATA_DIR, fn);
    if (fs.existsSync(src)) {
      try { fs.renameSync(src, path.join(userDir(id), fn)); }
      catch { fs.copyFileSync(src, path.join(userDir(id), fn)); fs.rmSync(src, { force: true }); }
    }
  }
  saveJSON(userConfigPath(id), normalizeUserConfig(userCfg));

  // 全局 config：开启多用户 + 强制登录（管理员可用旧 Token 直登）
  globalCfg.multiUser = true;
  if (!globalCfg.auth || typeof globalCfg.auth !== 'object') globalCfg.auth = { enabled: true, token: '' };
  globalCfg.auth.enabled = true;
  saveJSON(CONFIG_FILE, globalCfg);

  // 重载内存状态
  rawConfig = globalCfg;
  MULTIUSER = true;
  userConfigCache.clear();
  userDbCache.clear();
  legacyDb = null;
  return { username: 'admin', password: finalPw, generated, backupDir };
}
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
// v2.6.2：手写稿识图专用模型配置缺省补齐（留空沿用默认视觉模型）
if (!config.writingOcr || typeof config.writingOcr !== 'object') config.writingOcr = { providerId: '', model: '' };
// v2.4.1：文章题材自定义列表（null = 未自定义，用内置 16 题材；数组 = 用户自定义全量替换，2~40 项）
if (config.storyThemes !== undefined && !Array.isArray(config.storyThemes)) config.storyThemes = null;
// v2.0.0：外刊发布源独立于手工语料和真题库；留空使用 corpus/external/current/
if (!config.kb || typeof config.kb !== 'object') config.kb = { dir: '', pythonPath: '', externalDir: '' };
if (config.kb.externalDir === undefined) config.kb.externalDir = '';
// v2.8.0：Token 凭证登录配置缺省补齐（enabled=false 时不校验）
if (!config.auth || typeof config.auth !== 'object') config.auth = { enabled: false, token: '' };
if (typeof config.auth.enabled !== 'boolean') config.auth.enabled = false;
if (typeof config.auth.token !== 'string') config.auth.token = '';

/* v2.8.0：报错日志（自动采集前端错误与 API 失败）；v3.0.0 统一为全局运维日志（管理员可查全量） */
function errorLogPath() { return ERROR_LOG_FILE; }
function loadErrorLog() {
  const raw = loadJSON(errorLogPath(), { schemaVersion: 1, errors: [] });
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.errors)) return { schemaVersion: 1, errors: [] };
  return { schemaVersion: 1, errors: raw.errors };
}
function saveErrorLog(store) {
  saveJSON(errorLogPath(), { schemaVersion: 1, errors: Array.isArray(store.errors) ? store.errors : [] });
}
/** 追加一条报错记录（上限 500，裁掉最旧） */
function appendErrorLog(entry) {
  try {
    const store = loadErrorLog();
    store.errors.unshift({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      source: String(entry.source || 'unknown').slice(0, 40),   // frontend / api / server
      level: String(entry.level || 'error').slice(0, 20),        // error / warn
      message: String(entry.message || '').slice(0, 2000),
      stack: String(entry.stack || '').slice(0, 4000),
      url: String(entry.url || '').slice(0, 500),
      method: String(entry.method || '').slice(0, 12),
      status: Number.isFinite(Number(entry.status)) ? Number(entry.status) : null,
      ua: String(entry.ua || '').slice(0, 300),
    });
    if (store.errors.length > MAX_ERROR_LOGS) store.errors = store.errors.slice(0, MAX_ERROR_LOGS);
    saveErrorLog(store);
  } catch { /* 日志写入失败不得影响主流程 */ }
}

/* v2.8.0：日志版块——开发日志（内置，随版本更新）+ 使用日志（人工维护，data/logs.json） */
const DEV_LOG = [
  {
    version: '3.5.3', date: '2026-10-14', title: '语音运行时移出数据目录',
    items: [
      'Piper 语音运行时与合成缓存从 data/ 移到 runtime/（部署产物目录，不进 git、不参与 data 备份）',
      '修复 data/ 内 Python venv 符号链接导致 deploy.sh 备份恢复校验失败（拒绝含符号链接的归档）的问题',
      '发布/回滚脚本显式排除 runtime/；今日词表快照清理见 v3.5.2',
    ],
  },
  {
    version: '3.5.2', date: '2026-10-14', title: '今日词表快照清理',
    items: [
      '同步今日词表改为以本次墨墨快照为唯一真源：先清空所有旧 w.today（含跨天残留），再按本次返回重建',
      '修旧版 w.today 只增不减、库里累积数千条过期今日快照（含已掉出计划的词）的问题',
      '墨墨返回 0 条时即清空今日上下文，db.todayItems 与各词 w.today 保持严格一致',
      '新增 scripts/today-snapshot-smoke.mjs 隔离回归（注入假墨墨：重建/部分返回/空返回三场景）',
    ],
  },
  {
    version: '3.5.1', date: '2026-10-13', title: '严格「今日」忘记/模糊筛选',
    items: [
      '新增词表与测验词源「今日忘词 / 今日模糊」筛选：严格限定为今天在墨墨或工作台测验的作答结果',
      '修正旧版忘记词/模糊词把全历史 lastResponse 与跨天累积的今日快照混在一起、不限日期的问题',
      '词文成章快选词源与真题迁移训练同步新增今日口径；词表按今日作答显示「今日忘/今日模糊/今日熟」徽标',
      '新增 scripts/today-response-smoke.mjs 隔离回归（今日口径、历史不混入、计数与组卷/迁移白名单）',
    ],
  },
  {
    version: '3.5.0', date: '2026-10-13', title: '发音朗读升级（真人音源 + 神经语音）',
    items: [
      '修复 CSP 缺少 media-src 导致跨域真人发音被拦截、全部回退系统合成声的问题',
      '单词发音改走服务端代理：优先有道真人发音，美音/英音可切换，按内容哈希落盘缓存',
      '句子朗读新增服务端 Piper 神经语音常驻工作进程，懒加载模型、多请求复用，失败回退浏览器朗读',
      '新增「设置 → 发音与朗读」：口音偏好、试听与引擎状态展示',
    ],
  },
  {
    version: '3.4.3', date: '2026-10-12', title: '服务商配置弹窗移动端适配',
    items: [
      '限制服务商弹窗高度，让表单内容在固定标题和操作栏之间滚动，键盘弹出时跟随可见视口收缩',
      '收起低频高级参数，新增关闭按钮、Escape 关闭与焦点管理',
      '补充 Pixel 7 与 iPhone 13 手机和横屏短视口的弹窗交互回归',
    ],
  },
  {
    version: '3.4.2', date: '2026-10-11', title: '默认模型服务商切换队列修复',
    items: [
      '修复管理员切换默认模型服务商时，前序取消的写请求可能永久堵塞配置保存的问题',
      '请求体在客户端中断时立即释放；同一用户写队列增加 32 项上限和 6 分钟总超时，异常时返回明确状态码',
      '线上重启后已验证默认服务商切换保存 200、刷新回读成功，原默认服务商已恢复',
    ],
  },
  {
    version: '3.4.1', date: '2026-10-11', title: '外刊正文随机读取优化',
    items: [
      '外刊详情首次访问只解压对应 gzip 分片，并建立文章 ID 到 JSONL 行偏移的内存索引',
      '同一分片后续详情请求直接按偏移解析目标行，避免重复整片解压与线性扫描',
      '新增 16 MiB / 6 分片有界 LRU 缓存，发布目录替换后按文件指纹自动失效；保留旧版整包外刊兼容',
      '新增外刊缓存专项冒烟，覆盖命中、失效、淘汰和再次按需解压',
    ],
  },
  {
    version: '3.4.0', date: '2026-10-11', title: '前端重复入口精简与报告归位',
    items: [
      '首页合并今日任务与快捷入口，考试计划改为按需展开，统计集中到学习报告',
      '学习报告明确工作台训练与墨墨数据来源，保留诊断、记忆状态和复习趋势',
      '模型分配改为一次保存，真题整卷与题型专项统一为同一训练入口',
      '移动端底栏保留高频训练，低频设置和专注工具收纳到更多抽屉；七种风格与训练能力保持不变',
    ],
  },
  {
    version: '3.3.5',
    date: '2026-10-11',
    title: '运维可靠性与安全收口',
    items: [
      '新增一键备份恢复演练脚本：在隔离目录打包、校验并恢复 data，不改动线上运行数据',
      '新增发布门禁与线上只读健康检查：核对版本、提交、响应安全头、PWA 静态资源与认证状态',
      '新增安全审计报告与敏感信息扫描，并把工作手册、版本历史、产品文档纳入一致性检查',
      '新增移动端模拟回归与 Android 真机（ADB + Chrome DevTools）测试入口；无真机时明确报告 skipped',
      '修复跨平台静态资源路径解析，并补横屏触控设备 44px 点击目标回归',
      '横屏低高度设备将词表筛选 chips 改为单行横向滚动，保持词表可触摸滚动',
    ],
  },
  {
    version: '3.3.4',
    date: '2026-10-10',
    title: '文档统一、发布回滚演练、CI 平台确认与安全审计补齐',
    items: [
      '① 统一 AGENTS.md、部署/测试/安全文档与产品版本口径，明确 Gitee 主仓库、GitHub Actions CI 与 ECS 发布边界；',
      '② 部署与回滚脚本新增 --dry-run，验证运行时 data、真题、外刊和投递脚本不会被产品发布覆盖；',
      '③ 静态文件服务改用 path.relative 目录边界校验，补齐图片与 public 目录路径穿越回归测试；',
      '④ 安全响应补充 CSP，npm test 增加 CSP 与路径穿越断言。',
    ],
  },
  {
    version: '3.3.3',
    date: '2026-10-10',
    title: '可复现测试、发布回滚自动化与安全审计加固',
    items: [
      '① 新增 npm test 与 CI：Node 22/24 自动执行语法检查、安全冒烟和隔离沙箱启动验证；',
      '② 新增 scripts/deploy.sh 与 scripts/rollback.sh：发布前备份 data、保留运行时语料、重启后健康检查并支持按发布时间点回滚；',
      '③ 登录/注册接口增加进程内频控；Cookie 会话写请求增加 Origin/Referer 同站校验；',
      '④ 所有响应补充 nosniff、点击劫持防护、Referrer-Policy、Permissions-Policy 等安全响应头；',
    ],
  },
  {
    version: '3.3.2',
    date: '2026-10-10',
    title: '移动端触控与窄屏布局收口',
    items: [
      '① 底部导航与顶部栏补齐安全区高度，减少底部内容被遮挡和多余留白；',
      '② 测验、AI 学习子导航改为单行横向滚动，窄屏下不再挤压主内容；',
      '③ 移动端常用按钮、筛选项、折叠标题和分页控件统一达到 44px 触控高度；',
      '④ 设置、真题、测验、登录弹层统一处理换行、滚动边界和小屏表单宽度，覆盖 360px–700px 视口；',
    ],
  },
  {
    version: '3.3.1',
    date: '2026-10-10',
    title: '出站 fetch 统一超时护栏（修复「模型拉取 / 切换默认模型」卡死）',
    items: [
      '① 根因修复：为服务端全部出站 fetch（LLM 对话/流式、墨墨 Open API、模型列表拉取、生图、网页搜索、MinerU 申请/上传/轮询/下载、连通性测试、韦氏词典）统一加 AbortSignal.timeout 超时，杜绝上游无响应时 Node fetch 永久挂起',
      '② 解决连锁故障：多用户下写请求经 per-user 串行队列（enqueueUserWrite）执行，此前任一写请求的上游 fetch 永久挂起会毒死该用户整条写链，导致「无法切换默认模型 / 模型列表拉取失败 / 手动同步无响应」等所有写操作卡死；加超时后上游无响应会快速失败并释放队列',
      '③ 超时策略：模型列表/墨墨单次 15–20s、LLM 流式 5 分钟、生图 2 分钟、网页搜索 30s、MinerU 上传 2 分钟/轮询 20s/下载 60s；可用环境变量 FETCH_TIMEOUT_MS 覆盖默认值（30s）',
      '④ 兼容性：自带 signal 的调用方（如韦氏词典）行为不变；超时错误以可读信息透传前端，不阻断其他功能',
    ],
  },
  {
    version: '3.3.0',
    date: '2026-09-27',
    title: 'PWA 可安装（添加到主屏幕 / 桌面应用）',
    items: [
      '① 可安装为应用：新增 Web App Manifest（standalone 全屏、品牌主题色、应用图标族含 maskable），设置页新增「📱 安装到桌面」区，支持一键安装（beforeinstallprompt）与各浏览器手动添加指引',
      '② iOS 全屏独立运行：补齐 apple-touch-icon 与 apple-mobile-web-app-capable，Safari「添加到主屏幕」后无地址栏全屏打开（不依赖 HTTPS）',
      '③ 离线可用：新增 Service Worker 缓存应用外壳（网络优先导航 + 静态资源 stale-while-revalidate），断网也能打开界面；/api 与 /images 直连网络不缓存。仅在 HTTPS/localhost 生效，HTTP/IP 下自动跳过（无副作用），日后启用 HTTPS 即自动启用离线',
      '④ 应用快捷方式：Manifest 内置「单词测验 / 今日学习」快捷入口，支持 ?tab= 参数直达对应页签',
    ],
  },
  {
    version: '3.2.1',
    date: '2026-09-27',
    title: '测验体验四项升级',
    items: [
      '① 智能信心判断：测验信心不再由用户手选，改为按作答行为自动推断（耗时 + 正误）。客观题相对快答对→确定、偏慢→犹豫、答错→猜测（极快）或犹豫，自评题按评分映射；作答后在反馈区轻量显示「本题判定」。真题迁移保留手动信心组不变',
      '② 题量解锁：基础/自适应/复练/迁移题量下限改为 1、不设上限（实际受词源与释义数量约束）；会话上限 100→10000、提交与复练到期列表截断同步放宽；释义预补不封顶，随题量自由膨胀',
      '③ 自动播报单词：进入题目自动朗读（浏览器 TTS），仅覆盖 flash/choice/audio/复练；看中选英(zh2en)与拼写(spell)不自动播报以免泄露答案；新增「🔊 自动播报」开关（默认开启，本机持久化）',
      '④ 词源显示具体数目：测验 8 个词源与复练 3 个范围 chip 显示候选具体数量；新增只读接口 GET /api/quiz/sources（与组卷同口径去重计数，失败静默不阻断）',
    ],
  },
  {
    version: '3.2.0',
    date: '2026-09-25',
    title: '多用户 P2 数据分区收尾 + P3 集成改造',
    items: [
      'P2 共享内容写操作加管理员守卫：语料/真题导入、记录编辑与删除、历史版本恢复、单元标准答案保存、MinerU 解析入库，多用户下均仅管理员可写（403 FORBIDDEN），普通用户对共享资源只读',
      'P3 墨墨集成改为 per-user：每人自带 Token 独立频控（滑动窗口 + 自适应间隔按用户隔离，互不拖慢）；云词库缓存按用户隔离；自动同步按用户各自间隔独立装配（各自 Token、写各自数据）',
      'P3 自动同步定时器：启动/迁移/配置变更时遍历所有已开启的用户分别装配，删除用户自动撤下；迁移后立即为 admin 装配',
      'P3 AI 用量统计：每次 LLM 调用抓取上游 usage tokens（流式与非流式均支持），按北京自然日聚合并落 data/users/<id>/llm_usage.json，纳入备份与恢复',
      '新增「📊 AI 用量」看板：普通用户看自己的总 Tokens/调用次数/输入输出与近 7/14/30 天柱状趋势；管理员额外可见全员用量表',
      '接口：GET /api/llm/usage?days=7|14|30（scope=all 仅管理员可看全员，越权 403 FORBIDDEN）',
      '共享 LLM Key 由管理员统一配置；用量看板仅统计展示，不设额度拦截',
    ],
  },
  {
    version: '3.1.0',
    date: '2026-09-25',
    title: '多用户 P1 账户体系（前端）',
    items: [
      '登录遮罩升级为「登录 / 注册」双标签：多用户模式走用户名 + 密码登录、一次性邀请码注册（注册成功即登录）；单用户模式仍为 Token 凭证，界面自适应',
      '新增「👤 我的账户」设置区：显示当前用户名与角色（管理员/普通用户），一键退出登录',
      '角色显隐：普通用户自动隐藏管理员专属设置区（模型服务/密钥/登录与安全/数据备份等），与后端 403 守卫一致',
      '登出清理：清空内存学习状态 + 作文草稿 + 番茄钟进度，保留主题/风格/白噪音等设备偏好；登出后登录遮罩复现',
      '管理员专属接口加固：备份创建/列表/恢复在多用户下仅管理员可用（403 FORBIDDEN）',
      '登录/注册成功与启动时统一刷新认证状态与角色可见性',
    ],
  },
  {
    version: '3.0.0',
    date: '2026-09-25',
    title: '多用户 P0 基础设施（后端）',
    items: [
      '多用户总开关 config.multiUser：默认 false 时行为与 v2.12.0 完全一致（零破坏）；true 时启用请求级用户隔离',
      'AsyncLocalStorage 请求上下文：每个请求绑定 userId/role；config 与 db 改为透明 Proxy，业务代码零改动即按当前用户自动解析',
      'config 按字段分流：用户级（墨墨 Token/云词库/自动同步/DIY 提示词/各功能专用模型/文章题材）落到各自用户；其余（LLM 服务商/登录开关/词典/搜索/KB/生图/解析）全局共享且仅管理员可改',
      '每用户独立数据目录 data/users/<id>/：db.json、config.json、chat_sessions.json、learning_attempts.json、quiz_srs.json、quiz_session.json、essays.json 全部分区，互不可见',
      '用户注册表 data/users.json（scrypt 加盐哈希，绝不明文）+ 会话持久化 data/sessions.json（30 天，重启不掉线，会话绑定 userId）',
      '用户名 + 密码 + 管理员一次性邀请码注册（邀请码用后即废）；用户名 2–20 位中英文/数字/下划线，密码 6–128 位；总用户上限 50',
      '管理员端点：POST /api/admin/migrate（单用户→多用户一次性迁移，自动备份 data 并把现有数据归入 admin）、GET/POST /api/admin/invites、GET/DELETE /api/admin/users',
      '每用户写串行队列：同一用户的写请求按到达顺序串行执行，避免并发写互相覆盖',
      '备份/恢复/自动备份统一按 users/<id>/ 分层打包，含全局 config 与 users.json/sessions.json；图片目录按用户隔离',
      '认证接口升级：/api/auth/status 返回 multiUser 与当前用户 me；/api/auth/login 多用户走用户名+密码（兼容旧 Token 直登 admin）；/api/auth/register、/api/auth/logout',
    ],
  },
  {
    version: '2.12.0',
    date: '2026-09-25',
    title: '测验 AI 增强 + 统计看板',
    items: [
      '测验 AI 增强 5 处（LLM 可用则增强，不可用一律优雅降级到确定性兜底，绝不阻断测验）',
      '① 智能干扰项：四选一/听音/看中选英的「似是而非」错误项可由 LLM 生成，逼近考研易混词辨析；失败回退本地同词性释义池；组卷时可勾选「AI 增强干扰项」',
      '② 错题讲解：结果页/错题本一键生成「为什么容易错 / 词义与搭配辨析 / 一句话记忆点」分层讲解',
      '③ 一键助记：为单个词生成个性化助记并直接入库（可推送墨墨）；失败回退「释义卡」',
      '④ 拼写容错判分：拼写笔误（漏/多/颠倒字母）与真正记错区分，规则 + LLM 双通道',
      '⑤ 真实例句：从真题与外刊本地语料取该词真实用例（确定性，无需 LLM）',
      '统计看板（新页签）：掌握度分布、近 7/14/30 天正确率趋势、错题构成（错次/阶段分档）、连续学习天数、分题型正确率；数据来源 quiz_srs.json + learning_attempts.json',
      '新增接口：GET /api/quiz/stats、POST /api/quiz/ai/distractors、POST /api/quiz/ai/explain、POST /api/quiz/ai/mnemonic、POST /api/quiz/ai/spell-grade、GET /api/quiz/ai/examples；/api/quiz/generate 支持 aiDistractors 选项',
    ],
  },
  {
    version: '2.11.0',
    date: '2026-09-25',
    title: '自适应组卷 + 交错题型 + 会话韧性',
    items: [
      '自适应组卷（服务端 /api/quiz/generate，确定性可测）：按「记忆到期 > 错题本在册 > 忘记/模糊 > 掌握度反比 > 顽固词」加权排序选词，兼顾弱项与到期节奏，避免只抽到简单词',
      '交错题型：一次测验内按题型池轮转并打散，避免长同题型连排；新增「看中文选英文」(zh2en) 与「听音辨义」(audio) 两类题型，客观题由服务端生成选项并权威判分',
      '难度档 easy/normal/hard 决定可用题型范围（越难越多客观题与新题型），词源支持 记忆到期/错题本/今日/顽固/模糊/忘记/7天内到期/全部',
      '会话韧性（服务端持久化 data/quiz_session.json）：跨设备/刷新/断网可续做；逐题暂存 idx/结果/信心，支持「继续上次」与放弃；提交时以服务端权威 answer 复核客观题成绩防篡改',
      '新增接口：POST /api/quiz/generate、GET /api/quiz/session、POST /api/quiz/session/save、POST /api/quiz/session/clear；/api/quiz/submit 支持携带 sessionId 复核入库',
      '游戏化（XP/连胜/combo）接入自适应组卷，仍默认关闭（设置可开）',
    ],
  },
  {
    version: '2.10.0',
    date: '2026-09-24',
    title: '测验记忆引擎（自维护 SRS + 错题本）',
    items: [
      '新增独立记忆引擎 data/quiz_srs.json（自维护 SRS，与墨墨同步数据互不干扰）：每词记录易度/间隔/到期时间与掌握度（0–4），tmp+rename 原子写、损坏拒绝覆盖、纳入备份与恢复',
      '基础回忆闪卡升级为 4 档评分（😵 忘记 / 😕 吃力 / 😊 掌握 / 😎 轻松），按简化 SM-2 演化间隔与易度；四选一/拼写自动映射 correct/incorrect',
      '新增「错题复练」子模式：答错即进入错题本，按 1→3→7→21 天分级复练，连续晋级即视为掌握并移出；支持仅错题本 / 仅记忆到期 / 全部到期三种范围',
      '测验页新增掌握度条（0–4 分段）与作答计时（可暂停）；结果页展示 4 档明细、用时与记忆引擎更新摘要',
      '新增游戏化基础（XP / 连胜 / 连对 combo），默认关闭，可在数据层按需开启',
      '新增接口：GET /api/quiz/srs、GET /api/quiz/wrongbook、POST /api/quiz/wrongbook/resolve、POST /api/quiz/wrongbook/remove、POST /api/quiz/gamification；旧 /api/quiz/submit 无 grade 时保持 legacy 三档路径兼容',
    ],
  },
  {
    version: '2.9.1',
    date: '2026-09-23',
    title: 'Markdown 语法升级与排版规范',
    items: [
      '增强前端行内 Markdown 解析（mdInline）：支持行内公式脱壳（$...$）、高亮语法（==重点== 渲染为 <mark>）',
      '全面支持 LaTeX 推导符号自动转换：\\rightarrow / \\to / \\longrightarrow 映射为 →，\\Rightarrow 映射为 ⇒，\\leftrightarrow 映射为 ↔，\\neq / \\approx / \\le / \\ge / \\pm 等常用符号自然排版',
      '平滑支持文本型快捷箭头：-> 转换为 →，=> 转换为 ⇒，<-> / <=> 转换为 ↔ / ⇔（兼容 HTML 转义）',
      '样式自适应：为各主题与昼夜模式适配高亮 <mark class="md-mark"> 底纹与强调边线',
      '系统提示词强化：明确要求 AI 单词教练与精读助手在词根拆解及派生推导中优先输出 Unicode 字符，避免裸写 LaTeX 指令',
    ],
  },
  {
    version: '2.9.0',
    date: '2026-09-22',
    title: '外刊全自动入库',
    items: [
      '外刊发布源升级为 release-format v2：瘦索引（articles_index.jsonl）常驻内存，全文分片（articles_body/*.gz）按需读取，内存占用由数百 MB 降到约数 MB',
      '句子索引（sentences_index.jsonl.gz）预生成，搜索与 AI「外刊真实语境」证据直接读取，不再逐篇重建',
      '采集服务器（香港）夜间增量构建 release，网站服务器定时 rsync 拉取并原子替换，全程无人值守',
      '保留最近 5 份历史 release 自动归档，可一键回滚；旧版整包 articles.jsonl 目录仍兼容读取',
      '语料库列表显示外刊「更新日期」，只读发布源标识不变',
    ],
  },
  {
    version: '2.8.0',
    date: '2026-09-22',
    title: 'Token 凭证登录 + 日志版块',
    items: [
      '新增 Token 凭证登录：开发者以单一管理员 Token 登录，登录后该设备默认保持登录（httpOnly 会话 Cookie，30 天有效）',
      '登录开关与 Token 可在「设置 → 登录与安全」中由管理员随时更改；关闭时无需登录',
      '点击左上角版本号可进入「日志版块」',
      '日志版块含：开发日志（版本更新内容）、使用日志（更新方向与已知小毛病）、报错日志（自动采集前端错误与 API 失败）',
    ],
  },
  {
    version: '2.7.2.d',
    date: '2026-09-21',
    title: '词汇精练词表无法滚动修复',
    items: [
      '修复宽屏/平板/横屏/桌面下「AI 学习 → 词汇精练」词表无法拖动取词的布局回归（折叠容器切断 flex 链）',
    ],
  },
  {
    version: '2.7.2',
    date: '2026-09-21',
    title: '移动端划词助手',
    items: [
      '移动端屏蔽系统自带复制/全选菜单，改为长按取词 + 浮动气泡',
      '支持自由拉伸选区、跨行多段高亮、整句精读',
    ],
  },
];
function loadUsageLog() {
  const raw = loadJSON(LOGS_FILE, { schemaVersion: 1, usage: [] });
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.usage)) return { schemaVersion: 1, usage: [] };
  return { schemaVersion: 1, usage: raw.usage };
}
function saveUsageLog(store) {
  saveJSON(LOGS_FILE, { schemaVersion: 1, usage: Array.isArray(store.usage) ? store.usage : [] });
}

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

/* v1.2.0：聊天记录持久化（独立文件，不膨胀 db.json）；v3.0.0 按用户解析路径 */
function chatFilePath() { return ctxFilePath('chat_sessions.json'); }
function loadChatHistory() { return loadJSON(chatFilePath(), []); }
function saveChatHistory(arr) { saveJSON(chatFilePath(), arr); }

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
  'listening',
  'speaking',
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
  const file = ctxFilePath('learning_attempts.json');
  if (!fs.existsSync(file)) {
    return { schemaVersion: 1, enabledAt: new Date().toISOString(), attempts: [] };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  saveJSON(ctxFilePath('learning_attempts.json'), {
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

/* ------------------------------------------------------------------ */
/* v2.10.0：测验记忆引擎——自维护 SRS（简化 SM-2） + 错题本 + 游戏化占位   */
/*   独立文件 data/quiz_srs.json，与墨墨同步数据（db.words）互不干扰。      */
/* ------------------------------------------------------------------ */

const QUIZ_MAX_WORDS = 20000;          // SRS 词条上限
const QUIZ_HISTORY_PER_WORD = 40;      // 每词最近作答历史条数上限
const QUIZ_WRONGBOOK_MAX = 5000;       // 错题本条目上限

/** 4 档评分（Anki 式）：again=忘记 / hard=吃力 / good=掌握 / easy=轻松 */
const QUIZ_GRADES = new Set(['again', 'hard', 'good', 'easy']);
/** 评分 → 旧版三档响应（兼容现有「忘记词/模糊词」筛选与统计口径） */
const QUIZ_GRADE_TO_RESPONSE = { again: 'FORGET', hard: 'VAGUE', good: 'FAMILIAR', easy: 'FAMILIAR' };
/** 评分 → 标准 attempt result */
const QUIZ_GRADE_TO_RESULT = { again: 'incorrect', hard: 'vague', good: 'correct', easy: 'correct' };
/** 掌握度晋级：错→归零；吃力→不动；掌握→+1；轻松→+2 */
const QUIZ_GRADE_MASTERY_DELTA = { again: 0, hard: 0, good: 1, easy: 2 };
/** 错题复练阶段间隔（天）：stage 0→1→2→3→4 毕业后移出错题本 */
const QUIZ_REVIEW_INTERVALS_DAYS = [1, 3, 7, 21];
const QUIZ_MASTERED_STAGE = QUIZ_REVIEW_INTERVALS_DAYS.length;   // 4
const QUIZ_MASTERED_MASTERY = 4;

function emptyQuizSrsStore() {
  return {
    schemaVersion: 1,
    enabledAt: new Date().toISOString(),
    words: {},
    wrongBook: [],
    gamification: { xp: 0, streak: 0, lastActiveDate: '', dailyGoal: 0, combo: 0, bestCombo: 0 },
  };
}

function isQuizSrsShape(obj) {
  return !!obj && typeof obj === 'object' && obj.schemaVersion === 1 &&
    obj.words && typeof obj.words === 'object' && Array.isArray(obj.wrongBook);
}

/**
 * 读取测验记忆存储。文件不存在返回内存空 store（首次真实追加后才落盘）；
 * 文件存在但损坏/结构非法时抛 code=QUIZ_SRS_CORRUPT，绝不返回空 store 覆盖原文件。
 */
function loadQuizSrs() {
  const file = ctxFilePath('quiz_srs.json');
  if (!fs.existsSync(file)) return emptyQuizSrsStore();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const err = new Error('测验记忆文件损坏，无法解析：' + String(e.message || e).slice(0, 160));
    err.code = 'QUIZ_SRS_CORRUPT';
    throw err;
  }
  if (!isQuizSrsShape(raw)) {
    const err = new Error('测验记忆文件结构非法（schemaVersion 必须为 1 且 words/wrongBook 合规），已拒绝读写以免覆盖');
    err.code = 'QUIZ_SRS_CORRUPT';
    throw err;
  }
  return {
    schemaVersion: 1,
    enabledAt: typeof raw.enabledAt === 'string' ? raw.enabledAt : new Date().toISOString(),
    words: raw.words,
    wrongBook: Array.isArray(raw.wrongBook) ? raw.wrongBook : [],
    gamification: (raw.gamification && typeof raw.gamification === 'object')
      ? { xp: 0, streak: 0, lastActiveDate: '', dailyGoal: 0, combo: 0, bestCombo: 0, ...raw.gamification }
      : { xp: 0, streak: 0, lastActiveDate: '', dailyGoal: 0, combo: 0, bestCombo: 0 },
  };
}

function saveQuizSrs(store) {
  saveJSON(ctxFilePath('quiz_srs.json'), {
    schemaVersion: 1,
    enabledAt: store.enabledAt || new Date().toISOString(),
    words: store.words && typeof store.words === 'object' ? store.words : {},
    wrongBook: Array.isArray(store.wrongBook) ? store.wrongBook : [],
    gamification: store.gamification || { xp: 0, streak: 0, lastActiveDate: '', dailyGoal: 0, combo: 0, bestCombo: 0 },
  });
}

/** 裁剪：word 数、每词历史、错题本条目上限（已 resolve 的最先淘汰） */
function pruneQuizSrs(store) {
  const words = store.words || {};
  for (const sp of Object.keys(words)) {
    const w = words[sp];
    if (Array.isArray(w.history) && w.history.length > QUIZ_HISTORY_PER_WORD) {
      w.history = w.history.slice(-QUIZ_HISTORY_PER_WORD);
    }
  }
  const keys = Object.keys(words);
  if (keys.length > QUIZ_MAX_WORDS) {
    // 保留最近复习的，淘汰最久未动的
    keys.sort((a, b) => String(words[a].lastReviewedAt || '').localeCompare(String(words[b].lastReviewedAt || '')));
    for (const sp of keys.slice(0, keys.length - QUIZ_MAX_WORDS)) delete words[sp];
  }
  let wb = Array.isArray(store.wrongBook) ? store.wrongBook : [];
  if (wb.length > QUIZ_WRONGBOOK_MAX) {
    wb = wb.slice().sort((a, b) => {
      if (!!a.resolved !== !!b.resolved) return a.resolved ? 1 : -1;
      return String(b.lastWrongAt || '').localeCompare(String(a.lastWrongAt || ''));
    }).slice(0, QUIZ_WRONGBOOK_MAX);
  }
  store.wrongBook = wb;
  return store;
}

/** 单次作答时间（安全解析 ISO → ms） */
function isoMs(v) {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

/** 生成/规整单个词的 SRS 状态 */
function normalizeSrsWord(w) {
  const o = (w && typeof w === 'object') ? w : {};
  return {
    ease: Number.isFinite(o.ease) ? Math.min(3.2, Math.max(1.3, o.ease)) : 2.5,
    intervalDays: Number.isFinite(o.intervalDays) && o.intervalDays >= 0 ? o.intervalDays : 0,
    dueAt: typeof o.dueAt === 'string' ? o.dueAt : null,
    mastery: Number.isFinite(o.mastery) ? Math.min(QUIZ_MASTERED_MASTERY, Math.max(0, Math.round(o.mastery))) : 0,
    streakCorrect: Number.isFinite(o.streakCorrect) && o.streakCorrect >= 0 ? o.streakCorrect : 0,
    lapses: Number.isFinite(o.lapses) && o.lapses >= 0 ? o.lapses : 0,
    totalReviews: Number.isFinite(o.totalReviews) && o.totalReviews >= 0 ? o.totalReviews : 0,
    lastGrade: typeof o.lastGrade === 'string' ? o.lastGrade : null,
    lastResult: typeof o.lastResult === 'string' ? o.lastResult : null,
    lastReviewedAt: typeof o.lastReviewedAt === 'string' ? o.lastReviewedAt : null,
    firstSeenAt: typeof o.firstSeenAt === 'string' ? o.firstSeenAt : null,
    history: Array.isArray(o.history) ? o.history : [],
  };
}

/**
 * 简化 SM-2 演化：给定当前状态与本次评分，返回新状态。
 * 纯函数（不读文件、不写盘），便于单测。
 * @param {object} cur 现有词状态（可为 null）
 * @param {string} grade again|hard|good|easy
 * @param {object} opts { confidence, result, at(ISO) }
 */
function applySrsGrade(cur, grade, opts = {}) {
  if (!QUIZ_GRADES.has(grade)) throw new Error(`无效评分: ${grade}`);
  const nowIso = typeof opts.at === 'string' ? opts.at : new Date().toISOString();
  const prev = normalizeSrsWord(cur);
  const ease = prev.ease;
  let intervalDays = prev.intervalDays;
  let mastery = prev.mastery;
  let streakCorrect = prev.streakCorrect;
  let lapses = prev.lapses;

  if (grade === 'again') {
    intervalDays = 0;
    mastery = 0;
    streakCorrect = 0;
    lapses += 1;
  } else if (grade === 'hard') {
    intervalDays = prev.intervalDays <= 0 ? 1 : Math.max(1, Math.round(prev.intervalDays * 1.2));
    streakCorrect += 1;
  } else if (grade === 'good') {
    intervalDays = prev.intervalDays <= 0 ? 1 : Math.max(1, Math.round(prev.intervalDays * ease));
    mastery = Math.min(QUIZ_MASTERED_MASTERY, mastery + QUIZ_GRADE_MASTERY_DELTA.good);
    streakCorrect += 1;
  } else { // easy
    intervalDays = prev.intervalDays <= 0 ? 4 : Math.max(1, Math.round(prev.intervalDays * ease * 1.3));
    mastery = Math.min(QUIZ_MASTERED_MASTERY, mastery + QUIZ_GRADE_MASTERY_DELTA.easy);
    streakCorrect += 1;
  }

  // ease 演化（SM-2 惯例；again 扣分最多）
  let nextEase = ease;
  if (grade === 'again') nextEase -= 0.20;
  else if (grade === 'hard') nextEase -= 0.15;
  else if (grade === 'easy') nextEase += 0.15;
  nextEase = Math.min(3.2, Math.max(1.3, Number(nextEase.toFixed(3))));

  const dueAt = intervalDays > 0
    ? new Date(isoMs(nowIso) + intervalDays * 86400000).toISOString()
    : new Date(isoMs(nowIso) + 10 * 60000).toISOString();   // again：10 分钟后再来

  const result = opts.result || QUIZ_GRADE_TO_RESULT[grade];
  const entry = {
    ease: nextEase,
    intervalDays,
    dueAt,
    mastery,
    streakCorrect,
    lapses,
    totalReviews: prev.totalReviews + 1,
    lastGrade: grade,
    lastResult: result,
    lastReviewedAt: nowIso,
    firstSeenAt: prev.firstSeenAt || nowIso,
    history: prev.history.concat([{
      at: nowIso, grade, result,
      confidence: opts.confidence || null,
      intervalDays, mastery,
    }]),
  };
  return entry;
}

/** 错题本条目查找下标 */
function wrongBookIndex(store, spelling) {
  return (store.wrongBook || []).findIndex(x => x.spelling === spelling);
}

/**
 * 作答后更新错题本（纯逻辑，直接改 store.wrongBook）。
 * 答错（again）→ 入本/回炉 stage=0；答对（good/easy）→ stage 晋级；
 * 连续晋级达 QUIZ_MASTERED_STAGE 视为掌握 → resolved=true 移出复练队列。
 */
function updateWrongBook(store, spelling, grade, atIso) {
  const at = atIso || new Date().toISOString();
  const idx = wrongBookIndex(store, spelling);
  if (!Array.isArray(store.wrongBook)) store.wrongBook = [];

  if (grade === 'again') {
    if (idx >= 0) {
      const e = store.wrongBook[idx];
      e.lastWrongAt = at;
      e.wrongCount = (e.wrongCount || 0) + 1;
      e.stage = 0;
      e.resolved = false;
      e.nextDueAt = new Date(isoMs(at) + QUIZ_REVIEW_INTERVALS_DAYS[0] * 86400000).toISOString();
    } else {
      store.wrongBook.unshift({
        spelling,
        firstWrongAt: at,
        lastWrongAt: at,
        wrongCount: 1,
        stage: 0,
        nextDueAt: new Date(isoMs(at) + QUIZ_REVIEW_INTERVALS_DAYS[0] * 86400000).toISOString(),
        resolved: false,
        lastGrade: grade,
      });
    }
    return store.wrongBook[wrongBookIndex(store, spelling)];
  }

  // 非 again：仅当已在错题本中才推进阶段
  if (idx < 0) return null;
  const e = store.wrongBook[idx];
  if (grade === 'hard') {
    e.lastGrade = grade;
    return e;   // 吃力不晋级，维持当前阶段
  }
  // good / easy
  e.stage = (e.stage || 0) + 1;
  e.lastGrade = grade;
  if (e.stage >= QUIZ_MASTERED_STAGE) {
    e.resolved = true;
    e.resolvedAt = at;
    e.nextDueAt = null;
  } else {
    const days = QUIZ_REVIEW_INTERVALS_DAYS[e.stage] || QUIZ_REVIEW_INTERVALS_DAYS[QUIZ_REVIEW_INTERVALS_DAYS.length - 1];
    e.nextDueAt = new Date(isoMs(at) + days * 86400000).toISOString();
    e.resolved = false;
  }
  return e;
}

/** 计算到期复习词（SRS due 或错题本 due），按到期时间升序。 */
function collectSrsDue(filter = 'srs_due') {
  const store = loadQuizSrs();
  const now = Date.now();
  const out = [];
  const wbMap = new Map((store.wrongBook || []).map(x => [x.spelling, x]));

  const consider = (spelling, dueAt, source) => {
    const t = isoMs(dueAt);
    if (!dueAt || t > now) return;
    out.push({ spelling, dueAt, source });
  };

  if (filter === 'srs_due' || filter === 'all') {
    for (const sp of Object.keys(store.words)) {
      const w = store.words[sp];
      if (w && w.dueAt) consider(sp, w.dueAt, 'srs');
    }
  }
  if (filter === 'wrongbook' || filter === 'all') {
    for (const e of store.wrongBook) {
      if (e.resolved) continue;
      consider(e.spelling, e.nextDueAt, 'wrongbook');
    }
  }
  out.sort((a, b) => isoMs(a.dueAt) - isoMs(b.dueAt));
  return out;
}

/** 记忆状态概览（掌握度分布 / 到期数 / 错题本数 / 平均易度） */
function srsOverview() {
  const store = loadQuizSrs();
  const now = Date.now();
  const dist = [0, 0, 0, 0, 0];
  let dueCount = 0;
  let easeSum = 0;
  let easeN = 0;
  for (const sp of Object.keys(store.words)) {
    const w = normalizeSrsWord(store.words[sp]);
    dist[w.mastery]++;
    if (w.dueAt && isoMs(w.dueAt) <= now) dueCount++;
    easeSum += w.ease; easeN++;
  }
  const active = (store.wrongBook || []).filter(x => !x.resolved);
  const dueWrong = active.filter(x => x.nextDueAt && isoMs(x.nextDueAt) <= now).length;
  return {
    trackedWords: Object.keys(store.words).length,
    masteryDist: {
      '0': dist[0], '1': dist[1], '2': dist[2], '3': dist[3], '4': dist[4],
    },
    dueCount,
    wrongBookTotal: active.length,
    wrongBookResolved: (store.wrongBook || []).length - active.length,
    wrongBookDue: dueWrong,
    avgEase: easeN > 0 ? Number((easeSum / easeN).toFixed(2)) : null,
    gamification: store.gamification,
    enabledAt: store.enabledAt,
  };
}

/* ------------------------------------------------------------------ */
/* v2.11.0：自适应组卷 + 交错题型 + 会话韧性                              */
/*   ① 自适应加权选词：到期/错题/弱项/低掌握度加权，掌握度反比；          */
/*   ② 交错题型：flash/choice/spell + 新增 zh2en（看中选英）/audio（听音）；*/
/*   ③ 服务端会话持久化 data/quiz_session.json，跨设备/刷新可续做。       */
/* ------------------------------------------------------------------ */

const QUIZ_SESSION_SCHEMA = 1;
const QUIZ_SESSION_MAX_ITEMS = 10000;   // v3.2.1：随题量解锁放宽（原 100）
const QUIZ_SESSION_TTL_MS = 7 * 86400000;   // 会话最长保留 7 天

/** 新题型 + 既有题型（交错组卷的可用题型池） */
const QUIZ_KINDS_ALL = new Set(['flash', 'choice', 'spell', 'zh2en', 'audio']);
/** 难度档 → 允许出现的题型（掌握度越低/难度越高，客观题占比越大） */
const QUIZ_DIFFICULTY_KINDS = {
  easy: ['flash', 'choice'],
  normal: ['flash', 'choice', 'spell'],
  hard: ['flash', 'choice', 'spell', 'zh2en', 'audio'],
};

/** 可复现随机数（mulberry32），seed 为整数；未给 seed 则用时间熵 */
function makeRng(seed) {
  let a = (Number.isFinite(seed) ? Math.floor(seed) : Date.now()) >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 会话结构校验（sessionId 为 null 表示已清空的空会话，属合法形态） */
function isQuizSessionShape(obj) {
  return !!obj && typeof obj === 'object' && obj.schemaVersion === QUIZ_SESSION_SCHEMA &&
    (typeof obj.sessionId === 'string' || obj.sessionId === null) && Array.isArray(obj.items);
}

function emptyQuizSession() {
  return {
    schemaVersion: QUIZ_SESSION_SCHEMA,
    sessionId: null,
    mode: 'adaptive',
    source: 'all',
    config: { difficulty: 'normal', kinds: ['flash', 'choice', 'spell'], count: 10 },
    items: [],
    idx: 0,
    results: [],
    confidence: 'unsure',
    sessionStartedAt: null,
    pausedMs: 0,
    pauseStartedAt: null,
    updatedAt: null,
  };
}

/** 读取会话；不存在返回空会话；损坏抛 QUIZ_SESSION_CORRUPT（拒绝覆盖） */
function loadQuizSession() {
  const file = ctxFilePath('quiz_session.json');
  if (!fs.existsSync(file)) return emptyQuizSession();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const err = new Error('测验会话文件损坏，无法解析：' + String(e.message || e).slice(0, 160));
    err.code = 'QUIZ_SESSION_CORRUPT';
    throw err;
  }
  if (!isQuizSessionShape(raw)) {
    const err = new Error('测验会话文件结构非法（schemaVersion 必须为 1 且 items 为数组），已拒绝读写以免覆盖');
    err.code = 'QUIZ_SESSION_CORRUPT';
    throw err;
  }
  return {
    schemaVersion: QUIZ_SESSION_SCHEMA,
    sessionId: raw.sessionId,
    mode: typeof raw.mode === 'string' ? raw.mode : 'adaptive',
    source: typeof raw.source === 'string' ? raw.source : 'all',
    config: (raw.config && typeof raw.config === 'object') ? raw.config : { difficulty: 'normal', kinds: ['flash', 'choice', 'spell'], count: 10 },
    items: Array.isArray(raw.items) ? raw.items : [],
    idx: Number.isFinite(raw.idx) && raw.idx >= 0 ? Math.round(raw.idx) : 0,
    results: Array.isArray(raw.results) ? raw.results : [],
    confidence: typeof raw.confidence === 'string' ? raw.confidence : 'unsure',
    sessionStartedAt: typeof raw.sessionStartedAt === 'string' ? raw.sessionStartedAt : null,
    pausedMs: Number.isFinite(raw.pausedMs) && raw.pausedMs >= 0 ? raw.pausedMs : 0,
    pauseStartedAt: typeof raw.pauseStartedAt === 'string' ? raw.pauseStartedAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function saveQuizSession(sess) {
  saveJSON(ctxFilePath('quiz_session.json'), {
    schemaVersion: QUIZ_SESSION_SCHEMA,
    sessionId: sess.sessionId,
    mode: sess.mode,
    source: sess.source,
    config: sess.config,
    items: (sess.items || []).slice(0, QUIZ_SESSION_MAX_ITEMS),
    idx: sess.idx || 0,
    results: (sess.results || []).slice(0, QUIZ_SESSION_MAX_ITEMS),
    confidence: sess.confidence || 'unsure',
    sessionStartedAt: sess.sessionStartedAt || null,
    pausedMs: sess.pausedMs || 0,
    pauseStartedAt: sess.pauseStartedAt || null,
    updatedAt: new Date().toISOString(),
  });
}

/** 会话是否已失效（超过 TTL 视为过期，可被新会话覆盖） */
function quizSessionExpired(sess) {
  if (!sess || !sess.updatedAt) return true;
  return (Date.now() - isoMs(sess.updatedAt)) > QUIZ_SESSION_TTL_MS;
}

/**
 * 按词源收集候选词（返回 word-like 对象数组，供加权）。
 * 支持：today/sticky/vague/forget/due7/all/srs_due/wrongbook
 */
function quizCandidates(source) {
  const store = loadQuizSrs();
  const todayStr = bjDate();
  const bySpelling = new Map(Object.values(db.words).map(w => [w.spelling, w]));
  const out = [];
  const push = sp => {
    const w = bySpelling.get(sp);
    out.push(w || { spelling: sp });
  };

  if (source === 'srs_due') {
    for (const d of collectSrsDue('srs_due')) push(d.spelling);
    return out;
  }
  if (source === 'wrongbook') {
    for (const e of (store.wrongBook || [])) if (!e.resolved) push(e.spelling);
    return out;
  }

  let words = Object.values(db.words);
  if (source === 'sticky') words = words.filter(w => w.tags?.includes('STICKING'));
  else if (source === 'forget') words = words.filter(w => w.lastResponse === 'FORGET' || w.today?.firstResponse === 'FORGET' || w.quizResponse === 'FORGET');
  else if (source === 'vague') words = words.filter(w => w.lastResponse === 'VAGUE' || w.today?.firstResponse === 'VAGUE' || w.quizResponse === 'VAGUE');
  else if (source === 'today_forget') words = words.filter(w => todayHasResponse(w, todayStr, 'FORGET'));
  else if (source === 'today_vague') words = words.filter(w => todayHasResponse(w, todayStr, 'VAGUE'));
  else if (source === 'due7') {
    const end = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    words = words.filter(w => { const d = (w.nextStudyDate || '').slice(0, 10); return d && d <= end; });
  } else if (source === 'today') {
    words = words.filter(w => w.today?.date === todayStr);
  }
  for (const w of words) out.push(w);
  return out;
}

/**
 * v3.2.1：词源/复练范围候选计数（供测验页 chip 显示「具体数目」）。
 * 口径与组卷一致：去重 + 合法拼写（字母开头、2~30 位字母/连字符）。
 * @returns {{ sources:object, srsFilters:object }}
 */
function quizSourceCounts() {
  const VALID_SPELLING = /^[a-z][a-z'\-]{1,29}$/i;
  const sourceKeys = ['today', 'sticky', 'vague', 'forget', 'today_forget', 'today_vague', 'due7', 'srs_due', 'wrongbook', 'all'];
  const sources = {};
  for (const key of sourceKeys) {
    const seen = new Set();
    for (const w of quizCandidates(key)) {
      if (!w || !w.spelling || seen.has(w.spelling)) continue;
      if (!VALID_SPELLING.test(w.spelling)) continue;
      seen.add(w.spelling);
    }
    sources[key] = seen.size;
  }
  const srsFilters = {};
  for (const key of ['all', 'wrongbook', 'srs_due']) {
    const seen = new Set();
    for (const d of collectSrsDue(key)) if (d && d.spelling) seen.add(d.spelling);
    srsFilters[key] = seen.size;
  }
  return { sources, srsFilters };
}

/**
 * 自适应加权打分（确定性：给定 rng 则结果可复现）。
 * 到期(SRS due) > 错题本在册 > 忘记/模糊 > 低掌握度 > 顽固词；再加少量抖动以打散并列。
 */
function scoreQuizCandidate(word, store, nowMs, rng) {
  const sp = word.spelling;
  let score = 1;
  const meta = store.words[sp];
  const norm = meta ? normalizeSrsWord(meta) : null;
  if (norm && norm.dueAt && isoMs(norm.dueAt) <= nowMs) score += 1000;   // 记忆到期
  const wb = (store.wrongBook || []).find(x => x.spelling === sp && !x.resolved);
  if (wb) score += 800 + Math.min(200, (wb.wrongCount || 0) * 40);       // 错题本在册
  const resp = word.quizResponse || word.lastResponse || word.today?.firstResponse;
  if (resp === 'FORGET') score += 300;
  else if (resp === 'VAGUE') score += 150;
  const mastery = norm ? norm.mastery : 0;
  score += (QUIZ_MASTERED_MASTERY - mastery) * 60;                       // 掌握度反比
  if (word.tags?.includes('STICKING')) score += 40;
  score += rng() * 50;                                                   // 抖动打散并列
  return score;
}

/** 交错分配题型：按题型池轮转 + 抖动静默，避免长同题型连排 */
function assignInterleavedKinds(count, kindPool, rng) {
  const pool = kindPool.length ? kindPool.slice() : ['flash'];
  // 构造一个被多次重复的循环序列并按权重（顺序）打散
  const seq = [];
  for (let i = 0; i < count; i++) seq.push(pool[i % pool.length]);
  // 小幅洗牌：以 2~3 为窗口局部交换，保持交错感同时引入变化
  for (let i = seq.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [seq[i], seq[j]] = [seq[j], seq[i]];
  }
  // 避免相邻同题型（简单前后推移）
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1] && pool.length > 1) {
      for (let k = i + 1; k < seq.length; k++) {
        if (seq[k] !== seq[i - 1]) { [seq[i], seq[k]] = [seq[k], seq[i]]; break; }
      }
    }
  }
  return seq;
}

/** 原地 Fisher-Yates 洗牌（可注入 rng，保证自适应组卷可复现） */
function shuffleWith(arr, rng) {
  const r = typeof rng === 'function' ? rng : Math.random;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 构造中文干扰项（同词性优先），不足返回 null */
function quizChineseDistractors(correctGloss, correctPos, poolCn, rng) {
  const samePos = [];
  const other = [];
  for (const g of poolCn) {
    if (g.gloss === correctGloss) continue;
    if (correctPos && g.pos && g.pos === correctPos) samePos.push(g.gloss);
    else other.push(g.gloss);
  }
  const out = [];
  for (const g of shuffleWith(samePos, rng)) { if (out.length >= 3) break; if (!out.includes(g)) out.push(g); }
  for (const g of shuffleWith(other, rng)) { if (out.length >= 3) break; if (!out.includes(g)) out.push(g); }
  return out.length >= 3 ? out : null;
}

/** 构造英文干扰项（看中选英），不足返回 null */
function quizEnglishDistractors(correctSpelling, poolEn, rng) {
  const out = [];
  for (const sp of shuffleWith(poolEn.slice(), rng)) {
    if (sp === correctSpelling) continue;
    if (!out.includes(sp)) out.push(sp);
    if (out.length >= 3) break;
  }
  return out.length >= 3 ? out : null;
}

/**
 * 自适应组卷（同步，要求 db.glosses 已就绪；路由先 ensureGlosses）。
 * @returns {Array} 公开题目项（不含 expected 之外的敏感字段；self-grade 题含 answer 供客户端比对）
 */
function buildAdaptiveQuiz({ source, count, difficulty, kinds, seed }) {
  const store = loadQuizSrs();
  const nowMs = Date.now();
  const rng = makeRng(seed);

  const diff = QUIZ_DIFFICULTY_KINDS[difficulty] ? difficulty : 'normal';
  const requested = (Array.isArray(kinds) && kinds.length ? kinds : QUIZ_DIFFICULTY_KINDS[diff])
    .map(k => String(k)).filter(k => QUIZ_KINDS_ALL.has(k));
  // 仅保留该难度档允许的题型；为空则退回难度档默认
  let kindPool = requested.filter(k => QUIZ_DIFFICULTY_KINDS[diff].includes(k));
  if (!kindPool.length) kindPool = QUIZ_DIFFICULTY_KINDS[diff].slice();

  // 候选去重 + 打分排序
  const seen = new Set();
  const cands = [];
  for (const w of quizCandidates(source)) {
    if (!w || !w.spelling || seen.has(w.spelling)) continue;
    if (!/^[a-z][a-z'\-]{1,29}$/i.test(w.spelling)) continue;
    seen.add(w.spelling);
    cands.push({ word: w, score: scoreQuizCandidate(w, store, nowMs, rng) });
  }
  cands.sort((a, b) => b.score - a.score || a.word.spelling.localeCompare(b.word.spelling));

  // 中文/英文干扰池（池顺序本身有序，故池内随机按 seed 可控）
  const poolCn = [];
  const poolEn = [];
  const cnSeen = new Set();
  for (const sp of Object.keys(db.glosses || {})) {
    const g = vocabGlossOf(sp);
    if (!g) continue;
    if (!cnSeen.has(g.gloss)) { cnSeen.add(g.gloss); poolCn.push(g); }
    poolEn.push(sp);
  }

  const kindSeq = assignInterleavedKinds(count, kindPool, rng);
  const items = [];
  let ki = 0;
  for (const c of cands) {
    if (items.length >= count) break;
    const g = vocabGlossOf(c.word.spelling);
    if (!g) continue;   // 无释义（AI 未就绪）跳过，由后续候选补足
    let kind = kindSeq[ki] || 'flash';
    const item = {
      spelling: c.word.spelling,
      kind,
      difficulty: diff,
      gloss: { pos: g.pos || '', gloss: g.gloss, phonetic: db.glosses[c.word.spelling]?.phonetic || '' },
      options: null,
      answer: null,
    };
    if (kind === 'choice' || kind === 'audio') {
      const distractors = quizChineseDistractors(g.gloss, g.pos, poolCn, rng);
      if (distractors) { item.options = shuffleWith([g.gloss, ...distractors], rng); item.answer = g.gloss; }
      else kind = 'flash';
    } else if (kind === 'zh2en') {
      const distractors = quizEnglishDistractors(c.word.spelling, poolEn, rng);
      if (distractors) { item.options = shuffleWith([c.word.spelling, ...distractors], rng); item.answer = c.word.spelling; }
      else kind = 'flash';
    }
    item.kind = kind;
    items.push(item);
    ki++;
  }
  return items;
}

/** 上次会话摘要（供前端「继续上次」提示） */
function quizSessionSummary(sess) {
  if (!sess || !sess.sessionId) return null;
  return {
    sessionId: sess.sessionId,
    mode: sess.mode,
    source: sess.source,
    config: sess.config,
    total: (sess.items || []).length,
    idx: sess.idx || 0,
    answered: (sess.results || []).length,
    sessionStartedAt: sess.sessionStartedAt,
    pausedMs: sess.pausedMs || 0,
    updatedAt: sess.updatedAt,
    expired: quizSessionExpired(sess),
  };
}

/* ------------------------------------------------------------------ */
/* v2.12.0：测验 AI 增强 5 处 + 统计看板                                 */
/*   AI 增强：① 智能干扰项 ② 错题讲解 ③ 一键助记 ④ 拼写容错判分          */
/*            ⑤ 外刊真实例句（本地语料，无需 LLM）                       */
/*   统一原则：LLM 可用则增强，不可用/失败一律优雅降级到确定性兜底。      */
/* ------------------------------------------------------------------ */

/** LLM 是否具备调用条件（mock 视为可用，便于自测） */
function llmAvailable() {
  if (config.llm && config.llm.mock) return true;
  const base = getProvider() || {};
  return !!(base.baseUrl && base.model);
}

/** 去掉 ```json 围栏并提取第一个平衡的 {...} 块（复用词文成章容错思路） */
function extractJsonObject(text) {
  const t = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(t); } catch { /* 继续提取 */ }
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(t.slice(start, end)); } catch { return null; }
}

/** Levenshtein 距离（拼写容错判分的确定性兜底） */
function levenshtein(a, b) {
  const s = String(a || ''), t = String(b || '');
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * ① 智能干扰项：给定词与正确释义，尝试用 LLM 生成 3 个「似是而非」的干扰项；
 * 失败/格式不符则回退到本地同词性释义池（确定性）。
 */
async function aiQuizDistractors(spelling, correctGloss, correctPos) {
  const poolCn = [];
  const seen = new Set();
  for (const sp of Object.keys(db.glosses || {})) {
    const g = vocabGlossOf(sp);
    if (!g || g.gloss === correctGloss || seen.has(g.gloss)) continue;
    seen.add(g.gloss);
    poolCn.push(g);
  }
  const fallback = () => {
    const same = poolCn.filter(g => correctPos && g.pos && g.pos === correctPos).map(g => g.gloss);
    const other = poolCn.filter(g => !(correctPos && g.pos && g.pos === correctPos)).map(g => g.gloss);
    shuffleWith(same); shuffleWith(other);
    const out = [];
    for (const g of same.concat(other)) { if (out.length >= 3) break; if (!out.includes(g)) out.push(g); }
    return out.length >= 3 ? out : null;
  };
  if (!llmAvailable()) return { options: fallback(), source: 'fallback' };
  try {
    const reply = await llmChat([
      { role: 'system', content: getPrompt('quiz_distractors') },
      { role: 'user', content: `单词：${spelling}\n词性：${correctPos || ''}\n正确释义：${correctGloss}` },
    ], { maxTokens: 400, llmOverride: { _jsonMode: true } });
    const parsed = extractJsonObject(reply);
    const opts = (parsed?.items?.[0]?.options || parsed?.options || [])
      .map(x => String(x || '').trim()).filter(Boolean);
    const uniq = [];
    for (const o of opts) { if (o !== correctGloss && !uniq.includes(o)) uniq.push(o); }
    if (uniq.length >= 3) return { options: uniq.slice(0, 3), source: 'ai' };
  } catch { /* 降级 */ }
  return { options: fallback(), source: 'fallback' };
}

/**
 * ①b 组卷后用 AI 增强客观题干扰项（可选、非阻断）：保留正确答案，替换/补齐 3 个干扰项。
 * 逐题调用，任一失败即保留该题确定性选项；总请求数受 maxItems 限制。
 */
async function enhanceQuizItemsWithAI(items, maxItems = 8) {
  if (!llmAvailable()) return items;
  let enhanced = 0;
  for (const it of items) {
    if (enhanced >= maxItems) break;
    const isCn = it.kind === 'choice' || it.kind === 'audio';
    const isEn = it.kind === 'zh2en';
    if (!isCn && !isEn) continue;
    if (!Array.isArray(it.options) || !it.options.length) continue;
    try {
      const out = await aiQuizDistractors(it.spelling, it.gloss.gloss, it.gloss.pos);
      const aiOpts = (out.options || []).map(x => String(x).trim()).filter(Boolean);
      if (out.source !== 'ai' || aiOpts.length < 3) continue;
      const correct = it.answer;
      const wrong = [];
      for (const o of aiOpts) { if (o !== correct && !wrong.includes(o)) wrong.push(o); }
      if (wrong.length < 3) continue;
      it.options = shuffleWith([correct, ...wrong.slice(0, 3)]);
      it.aiEnhanced = true;
      enhanced++;
    } catch { /* 单题失败忽略 */ }
  }
  return items;
}

/** ② 错题讲解：LLM 生成讲解；失败返回 null（前端不展示，非阻断） */
async function aiQuizExplain({ spelling, gloss, userAnswer, correct }) {
  if (!llmAvailable()) return null;
  try {
    const reply = await llmChat([
      { role: 'system', content: getPrompt('quiz_explain') },
      { role: 'user', content: [
        `单词：${spelling}`,
        gloss ? `正确释义：${gloss}` : '',
        correct ? '本题作答：正确' : '本题作答：错误',
        userAnswer ? `学习者所选：${userAnswer}` : '',
      ].filter(Boolean).join('\n') },
    ], { maxTokens: 700 });
    const text = String(reply || '').trim();
    return text ? text.slice(0, 1500) : null;
  } catch { return null; }
}

/** ③ 一键助记：LLM 生成一条助记并直接入库（复用 db.notes 结构）；失败回退确定性助记 */
async function aiQuizMnemonic(spelling) {
  const g = db.glosses[spelling] || null;
  const glossText = g ? (typeof g === 'string' ? g : g.gloss || '') : '';
  const saveNote = (noteType, content) => {
    const note = {
      id: crypto.randomUUID(),
      spelling,
      noteType,
      content: String(content).slice(0, 500),
      createdAt: new Date().toISOString(),
      source: 'AI',
      synced: false,
    };
    db.notes.unshift(note);
    persistDB();
    return note;
  };
  if (llmAvailable()) {
    try {
      const reply = await llmChat([
        { role: 'system', content: getPrompt('quiz_mnemonic') },
        // 用 ### 词头，与既有「个性化助记」mock/解析口径一致
        { role: 'user', content: `### ${spelling}${glossText ? `\n核心释义：${glossText}` : ''}` },
      ], { maxTokens: 500, llmOverride: { _jsonMode: true } });
      const parsed = parseMnemonicJSON(reply);
      const n = (parsed?.notes || []).find(x => x && x.content);
      if (n) return { note: saveNote(n.noteType || '联想', n.content), source: 'ai' };
    } catch { /* 降级 */ }
  }
  // 确定性兜底：用既有释义缓存生成一条朴素助记
  const content = glossText ? `释义卡：${spelling} = ${glossText}` : `（暂无释义缓存）${spelling}`;
  return { note: saveNote('其他', content), source: 'fallback' };
}

/**
 * ④ 拼写容错判分：先规则判分；拼错时若 LLM 可用则由其判定「笔误/真错」，否则用 Levenshtein 兜底。
 * @returns {{ verdict:'correct'|'typo'|'wrong', feedback:string, tip:string, source:string }}
 */
async function aiGradeSpelling(spelling, answer) {
  const target = String(spelling || '').trim().toLowerCase();
  const got = String(answer || '').trim().toLowerCase();
  if (!target || !got) return { verdict: 'wrong', feedback: '未作答', tip: '', source: 'rule' };
  if (target === got) return { verdict: 'correct', feedback: '拼写正确', tip: '', source: 'rule' };

  const dist = levenshtein(target, got);
  const tolerance = Math.max(1, Math.floor(target.length / 4));   // 长度 25% 以内允许视为笔误
  const ruleVerdict = dist <= tolerance ? 'typo' : 'wrong';
  if (!llmAvailable()) {
    return {
      verdict: ruleVerdict,
      feedback: ruleVerdict === 'typo' ? '拼写笔误，接近正确' : '拼写错误',
      tip: '',
      source: 'fallback',
    };
  }
  try {
    const reply = await llmChat([
      { role: 'system', content: getPrompt('quiz_spell_grade') },
      { role: 'user', content: `正确单词：${spelling}\n学习者拼写：${answer}` },
    ], { maxTokens: 200, llmOverride: { _jsonMode: true } });
    const parsed = extractJsonObject(reply);
    const verdict = ['correct', 'typo', 'wrong'].includes(parsed?.verdict) ? parsed.verdict : ruleVerdict;
    return {
      verdict,
      feedback: String(parsed?.feedback || '').slice(0, 60) || (verdict === 'typo' ? '拼写笔误' : '拼写错误'),
      tip: String(parsed?.tip || '').slice(0, 60),
      source: 'ai',
    };
  } catch {
    return { verdict: ruleVerdict, feedback: ruleVerdict === 'typo' ? '拼写笔误' : '拼写错误', tip: '', source: 'fallback' };
  }
}

/** ⑤ 外刊/真题真实例句（本地语料，纯确定性，无需 LLM） */
function quizRealExamples(spelling, limit = 3) {
  try {
    const ev = kbEvidenceForWord(spelling, 2, 3);
    const out = [];
    for (const h of [...(ev.exams || []), ...(ev.corpus || []), ...(ev.external || [])]) {
      const s = String(h.s || '').trim();
      if (!s || out.some(x => x.sentence === s)) continue;
      const kind = h.sourceKind;
      out.push({
        sentence: s,
        sourceKind: kind,
        sourceLabel: kind === 'exam'
          ? (h.year ? `真题 ${h.year}` : '真题语境')
          : kind === 'external' ? (h.publication || '外刊')
            : '语料',
        title: h.title || '',
        rid: h.rid || null,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

/* ---------------- v2.12.0：统计看板聚合 ---------------- */

/** 从学习流水取最近 N 个北京自然日的正确率（按 submittedAt 归日） */
function quizAccuracyTrend(days = 14) {
  let attempts = [];
  try { attempts = loadLearningStore().attempts || []; } catch { attempts = []; }
  const buckets = new Map();   // date -> { correct, total }
  const wordKinds = new Set(['word_quiz']);
  for (const a of attempts) {
    if (!a || !wordKinds.has(a.kind)) continue;
    const d = bjDateOf(a.submittedAt);
    if (!d) continue;
    const b = buckets.get(d) || { correct: 0, total: 0 };
    b.total++;
    if (a.result === 'correct') b.correct++;
    buckets.set(d, b);
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = bjDate(-i);
    const b = buckets.get(key) || { correct: 0, total: 0 };
    out.push({ date: key, correct: b.correct, total: b.total, rate: b.total ? Math.round(b.correct / b.total * 100) : null });
  }
  return out;
}

/** 错题构成：按 wrongCount 分档 + 阶段分布 */
function quizWrongBookBreakdown(store) {
  const active = (store.wrongBook || []).filter(x => !x.resolved);
  const byWrongCount = { '1': 0, '2': 0, '3+': 0 };
  const byStage = [0, 0, 0, 0];
  for (const e of active) {
    const wc = Number(e.wrongCount || 1);
    if (wc <= 1) byWrongCount['1']++; else if (wc === 2) byWrongCount['2']++; else byWrongCount['3+']++;
    const st = Math.min(3, Math.max(0, Number(e.stage || 0)));
    byStage[st]++;
  }
  return { active: active.length, resolved: (store.wrongBook || []).length - active.length, byWrongCount, byStage };
}

/** 连续学习天数（基于学习流水的北京自然日；今日或昨日有作答均计入） */
function quizStreakDays(days = 400) {
  let attempts = [];
  try { attempts = loadLearningStore().attempts || []; } catch { attempts = []; }
  const activeDays = new Set();
  for (const a of attempts) {
    const d = a && bjDateOf(a.submittedAt);
    if (d) activeDays.add(d);
  }
  if (!activeDays.size) return 0;
  let start = 0;
  if (!activeDays.has(bjDate())) start = activeDays.has(bjDate(-1)) ? -1 : null;
  if (start === null) return 0;
  let streak = 0;
  for (let i = start; i >= -days; i--) {
    if (activeDays.has(bjDate(i))) streak++;
    else break;
  }
  return streak;
}

/** 统计看板总聚合（掌握度分布 / 正确率趋势 / 错题构成 / 连续天数 / 题型正确率） */
function quizStatsDashboard(days = 14) {
  const store = loadQuizSrs();
  const dist = [0, 0, 0, 0, 0];
  let dueCount = 0;
  const now = Date.now();
  for (const sp of Object.keys(store.words)) {
    const w = normalizeSrsWord(store.words[sp]);
    dist[w.mastery]++;
    if (w.dueAt && isoMs(w.dueAt) <= now) dueCount++;
  }
  // 按题型（word_quiz meta.mode）统计正确率
  let attempts = [];
  try { attempts = loadLearningStore().attempts || []; } catch { attempts = []; }
  const byKind = {};
  for (const a of attempts) {
    if (!a || a.kind !== 'word_quiz') continue;
    const k = String((a.meta && a.meta.mode) || 'flash');
    const b = byKind[k] || { correct: 0, total: 0 };
    b.total++;
    if (a.result === 'correct') b.correct++;
    byKind[k] = b;
  }
  const kindRates = Object.keys(byKind).map(k => ({
    kind: k, total: byKind[k].total, correct: byKind[k].correct,
    rate: byKind[k].total ? Math.round(byKind[k].correct / byKind[k].total * 100) : null,
  })).sort((a, b) => b.total - a.total);

  return {
    trackedWords: Object.keys(store.words).length,
    masteryDist: { '0': dist[0], '1': dist[1], '2': dist[2], '3': dist[3], '4': dist[4] },
    dueCount,
    accuracyTrend: quizAccuracyTrend(days),
    wrongBook: quizWrongBookBreakdown(store),
    streakDays: quizStreakDays(),
    kindRates,
    gamification: store.gamification,
    windowDays: days,
  };
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

/**
 * v3.5.1：严格「今日」作答判定。墨墨今日词表已落 w.today（含 firstResponse），
 * 工作台测验结果落 w.quizLastAt（北京时间可判今日）。二者都限定为「今天」
 * 才计入，避免旧版把全历史 lastResponse 与跨天累积的 w.today 快照混在一起。
 */
function todayHasResponse(w, todayStr, response) {
  if (!w) return false;
  if (w.today && w.today.date === todayStr && w.today.firstResponse === response) return true;
  if (w.quizResponse === response && bjDateOf(w.quizLastAt) === todayStr) return true;
  return false;
}

/** 与 /api/words 同源的候选词筛选（支持 sticky/vague/forget/today_forget/today_vague/today_wellfamiliar/due7） */
function collectVocabCandidates(filter) {
  const todayStr = bjDate();
  let words = Object.values(db.words);
  if (filter === 'sticky') words = words.filter(w => w.tags?.includes('STICKING'));
  else if (filter === 'forget') words = words.filter(w => w.lastResponse === 'FORGET' || w.today?.firstResponse === 'FORGET' || w.quizResponse === 'FORGET');
  else if (filter === 'vague') words = words.filter(w => w.lastResponse === 'VAGUE' || w.today?.firstResponse === 'VAGUE' || w.quizResponse === 'VAGUE');
  else if (filter === 'today_forget') words = words.filter(w => todayHasResponse(w, todayStr, 'FORGET'));
  else if (filter === 'today_vague') words = words.filter(w => todayHasResponse(w, todayStr, 'VAGUE'));
  else if (filter === 'today_wellfamiliar') words = words.filter(w => todayHasResponse(w, todayStr, 'WELL_FAMILIAR'));
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

// v1.0.7：请求时间戳滑动窗口（官方未说明按端点独立计数，保守按全局计）
// v3.2.0：改为 **按用户（Token）独立**——每人自带墨墨 Token，频控须互不影响
const WIN_10S = 10_000, WIN_60S = 60_000, WIN_5H = 5 * 3600_000;
const LIMIT_10S = 18, LIMIT_60S = 38, LIMIT_5H = 1900;   // 官方 20/40/2000，各留约 10% 余量
const GAP_MIN = 650, GAP_MAX = 8000;

/** 每用户频控状态：{ callTimestamps:[], baseGapMs, throttledCount }（单用户模式用 LEGACY_USER 键） */
const mmLimiter = new Map();
function limiterState() {
  const uid = currentCtx().userId || LEGACY_USER;
  let st = mmLimiter.get(uid);
  if (!st) { st = { callTimestamps: [], baseGapMs: GAP_MIN, throttledCount: 0 }; mmLimiter.set(uid, st); }
  return st;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 限流：滑动窗口护栏 + 基础间隔，任一约束命中即等待（分段睡，可响应收紧）。按当前用户隔离 */
async function throttle() {
  const st = limiterState();
  for (;;) {
    const now = Date.now();
    while (st.callTimestamps.length && now - st.callTimestamps[0] > WIN_5H) st.callTimestamps.shift();
    let wait = 0;
    if (st.callTimestamps.length >= LIMIT_10S) {
      wait = Math.max(wait, WIN_10S - (now - st.callTimestamps[st.callTimestamps.length - LIMIT_10S]));
    }
    if (st.callTimestamps.length >= LIMIT_60S) {
      wait = Math.max(wait, WIN_60S - (now - st.callTimestamps[st.callTimestamps.length - LIMIT_60S]));
    }
    if (st.callTimestamps.length >= LIMIT_5H) {
      wait = Math.max(wait, WIN_5H - (now - st.callTimestamps[0]));
    }
    const last = st.callTimestamps[st.callTimestamps.length - 1] || 0;
    wait = Math.max(wait, st.baseGapMs - (now - last));
    if (wait <= 0) { st.callTimestamps.push(now); return; }
    await sleep(Math.min(wait, 2000));
  }
}

function tightenGap() { const st = limiterState(); st.baseGapMs = Math.min(GAP_MAX, Math.round(st.baseGapMs * 1.6)); st.throttledCount++; }
function relaxGap() { const st = limiterState(); if (st.baseGapMs > GAP_MIN) st.baseGapMs = Math.max(GAP_MIN, Math.round(st.baseGapMs / 1.15)); }
function throttledCountNow() { return limiterState().throttledCount; }

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
      res = await fetchT(url, {
        method,
        headers: {
          'Authorization': 'Bearer ' + config.maimemoToken,
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }, 15000);   // 墨墨 API：单次 15s（外层已有 4 次退避重试）
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
  const items = Array.isArray(data.today_items) ? data.today_items : [];
  const dateStr = bjDate();

  // v3.5.2：以本次同步快照为唯一真源——先清除所有旧 w.today（含跨天残留、已掉出今日计划的词），
  // 再按本次返回重建。返回 0 条时即清空今日上下文（快照即真相，不做保留）。
  let cleared = 0;
  for (const w of Object.values(db.words)) {
    if (w.today) { delete w.today; cleared++; }
  }

  for (const it of items) {
    if (!it || !it.voc_id) continue;
    const w = db.words[it.voc_id] || { vocId: it.voc_id };
    w.vocId = it.voc_id;
    w.spelling = it.voc_spelling || w.spelling;
    w.today = { date: dateStr, firstResponse: it.first_response, isNew: it.is_new, isFinished: it.is_finished };
    db.words[it.voc_id] = w;
  }
  db.todayItems = items;
  return { count: items.length, cleared };
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
    const t = await syncTodayItems();
    steps.push(`今日词表 ${t.count} 条${t.cleared ? `（清理旧快照 ${t.cleared}）` : ''}`);
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
  const thr = throttledCountNow();
  if (thr > 0) steps.push(`（期间触发限流 ${thr} 次，已自动退避恢复）`);
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
    temperature: 0.7
  },
  siliconflow: {
    label: '硅基流动 (SiliconFlow)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'],
    temperature: 0.7
  },
  zhipu: {
    label: '智谱 GLM 开放平台',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    temperature: 0.7
  },
  moonshot: {
    label: '月之暗面 (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    temperature: 0.7
  },
  openai: {
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    temperature: 0.7,
    vision: true   // v2.3.4：官方多模态模型默认开放视觉能力（可在编辑弹层调整）
  },
  ollama: {
    label: 'Ollama 本地部署',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b'],
    temperature: 0.7
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
    const reply = mockLLM(messages);
    recordLlmUsage(estimateUsage(messages, reply));   // v3.2.0：mock 也记用量（便于测试与看板联调）
    return reply;
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
    // v2.3.4：请求体三级构建——基础参数 → 思考参数（Claude 式 _thinking 优先，否则服务商「思考强度」reasoning_effort）→ 透传 JSON 参数
    // v2.4.4：思考参数单一来源——只读服务商档案 thinking 字段（用户设置页滑块调节，档位 2026-09 官方核实：
    //   off / minimal / low / medium / high / xhigh / max），任何功能板块不得注入思考参数；
    //   off → 显式关闭双保险（reasoning_effort:none + enable_thinking:false，兼容默认思考模型，上游不识别的忽略）
    const bodyObj = { model: llm.model, messages, max_tokens: llm.max_tokens || maxTokens, temperature: llm.temperature !== undefined ? llm.temperature : 0.7 };
    if (llm._thinking) {
      bodyObj.thinking = llm._thinking;
    } else if (llm.thinking && llm.thinking !== 'off') {
      bodyObj.reasoning_effort = llm.thinking;   // minimal~max 直通（OpenAI o 系 / gpt-5 系 / DeepSeek V4 / 主流中转站通用）
    } else {
      bodyObj.reasoning_effort = 'none';
      bodyObj.enable_thinking = false;
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
    // v2.4.3：全模型服务开启流式——长请求不再占用无数据连接，防止中转站/网关 504 超时
    bodyObj.stream = true;
    // v3.2.0：请求流末回报 usage，供 per-user 用量统计（上游不支持的会忽略该字段）
    if (!bodyObj.stream_options) bodyObj.stream_options = { include_usage: true };
    res = await fetchT(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(llm.apiKey ? { 'Authorization': 'Bearer ' + llm.apiKey } : {}),
      },
      body: JSON.stringify(bodyObj),
    }, 300000);   // LLM 流式：整段最长 5 分钟（含思考膨胀），超时即中断防永久挂起
  } catch {
    throw new Error(`无法连接 AI 服务（${llm.baseUrl}），请到「设置」检查 Base URL 与网络`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI 请求失败 (HTTP ${res.status}) ${text.slice(0, 300)}`);
  }
  // v2.4.3：统一解析——上游真流式（SSE）则逐块聚合 delta；上游忽略 stream 参数回整包 JSON 也能兼容
  const ct = String(res.headers.get('content-type') || '');
  let content = '';
  let reasoningLen = 0;
  let finishReason = '';
  let usageSeen = null;
  if (ct.includes('text/event-stream')) {
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';   // 末行可能不完整，留到下一轮
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const d = j.choices?.[0]?.delta || {};
            if (typeof d.content === 'string') content += d.content;
            if (typeof d.reasoning_content === 'string') reasoningLen += d.reasoning_content.length;
            if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
            if (j.usage) usageSeen = j.usage;   // v3.2.0：上游在流末块回报 usage
          } catch { /* 单块坏数据忽略 */ }
        }
      }
    } catch (e) {
      throw new Error(`AI 流式响应中断（${e.message}），请重试`);
    }
  } else {
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    content = msg.content || json.choices?.[0]?.text || '';
    reasoningLen = String(msg.reasoning_content || '').length;
    finishReason = json.choices?.[0]?.finish_reason || '';
    if (json.usage) usageSeen = json.usage;
  }
  if (usageSeen) recordLlmUsage(usageSeen);   // v3.2.0：per-user 用量统计
  content = String(content || '');
  // v2.3.5a 修复：思考耗尽 max_tokens 时正文为空——如实报错（带 finish_reason），提示调大 max_tokens 或关闭思考。
  if (!content.trim()) {
    const finish = finishReason || 'unknown';
    throw new Error(
      `AI 只返回了思考过程，正文为空（finish_reason=${finish}${reasoningLen ? '，思考已生成 ' + reasoningLen + ' 字' : ''}）。` +
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

/* ------------------------------------------------------------------ */
/* v2.5.0：写作升格（Essay Elevation）                                 */
/*   自由写作单轨（题源不碰真题库）+ Part B 图画防幻觉识图确认           */
/*   + 逐句 L1/L2 升格对比 + 流式 SSE 批改报告 + 金句入助记库           */
/* ------------------------------------------------------------------ */

// v2.5.0：写作历史（独立文件，tmp+rename 原子写）；v3.0.0 按用户隔离缓存
const essaysCache = new Map();   // userId -> array

function loadEssays() {
  const uid = currentCtx().userId;
  if (essaysCache.has(uid)) return essaysCache.get(uid);
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(ctxFilePath('essays.json'), 'utf8')); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  essaysCache.set(uid, arr);
  return arr;
}
function saveEssays() { saveJSON(ctxFilePath('essays.json'), loadEssays().slice(0, 200)); }

/* ------------------------------------------------------------------ */
/* v3.2.0：LLM 用量统计（per-user，独立文件 llm_usage.json）             */
/*   记录每次成功调用的 prompt/completion/total tokens，按日聚合并留存   */
/*   最近 N 天明细，供「AI 用量」看板展示（普通用户看自己/管理员看全员）。*/
/* ------------------------------------------------------------------ */
const LLM_USAGE_MAX_DAYS = 120;      // 保留天数
const llmUsageCache = new Map();     // userId -> store
function emptyLlmUsageStore() { return { schemaVersion: 1, total: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }, days: {} }; }
/** v3.2.0：mock/无 usage 回包时的粗略 token 估算（约 2.5 字符/token，中日韩更省；仅统计用） */
function estimateUsage(messages, reply) {
  const inChars = (Array.isArray(messages) ? messages : []).reduce((a, m) => a + String(m?.content || '').length, 0);
  const outChars = String(reply || '').length;
  const prompt_tokens = Math.ceil(inChars / 2.5);
  const completion_tokens = Math.ceil(outChars / 2.5);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}
function normalizeLlmUsageStore(raw) {
  const out = emptyLlmUsageStore();
  if (!raw || typeof raw !== 'object') return out;
  const t = raw.total || {};
  out.total = {
    calls: Number(t.calls) || 0,
    promptTokens: Number(t.promptTokens) || 0,
    completionTokens: Number(t.completionTokens) || 0,
    totalTokens: Number(t.totalTokens) || 0,
  };
  if (raw.days && typeof raw.days === 'object') {
    for (const [d, v] of Object.entries(raw.days)) {
      if (!v || typeof v !== 'object') continue;
      out.days[d] = {
        calls: Number(v.calls) || 0,
        promptTokens: Number(v.promptTokens) || 0,
        completionTokens: Number(v.completionTokens) || 0,
        totalTokens: Number(v.totalTokens) || 0,
      };
    }
  }
  return out;
}
function loadLlmUsage() {
  const uid = currentCtx().userId;
  if (llmUsageCache.has(uid)) return llmUsageCache.get(uid);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(ctxFilePath('llm_usage.json'), 'utf8')); } catch { raw = null; }
  const store = normalizeLlmUsageStore(raw);
  llmUsageCache.set(uid, store);
  return store;
}
function saveLlmUsage(store) {
  // 裁剪：只保留最近 LLM_USAGE_MAX_DAYS 天
  const days = Object.keys(store.days || {}).sort();
  while (days.length > LLM_USAGE_MAX_DAYS) delete store.days[days.shift()];
  saveJSON(ctxFilePath('llm_usage.json'), store);
}
/** 记一次 LLM 调用的 token 用量（bjDate 归日；usage 缺失时只记 calls） */
function recordLlmUsage(usage) {
  try {
    const uid = currentCtx().userId;
    const store = loadLlmUsage();
    const pt = Number(usage?.prompt_tokens) || 0;
    const ct = Number(usage?.completion_tokens) || 0;
    const tt = Number(usage?.total_tokens) || (pt + ct);
    const day = bjDate();
    store.total.calls += 1;
    store.total.promptTokens += pt;
    store.total.completionTokens += ct;
    store.total.totalTokens += tt;
    if (!store.days[day]) store.days[day] = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const d = store.days[day];
    d.calls += 1; d.promptTokens += pt; d.completionTokens += ct; d.totalTokens += tt;
    saveLlmUsage(store);
  } catch { /* 统计失败不影响主流程 */ }
}
/** 供看板：读取指定用户的用量（无上下文，显式传 userId） */
function loadLlmUsageForUser(userId) {
  const cached = llmUsageCache.get(userId);
  if (cached) return cached;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(USERS_DIR, userId, 'llm_usage.json'), 'utf8')); } catch { raw = null; }
  return normalizeLlmUsageStore(raw);
}

/** 从批改报告提取预估得分（列表徽章用） */
function parseWritingScore(report) {
  const m = String(report || '').match(/(\d+(?:\.\d+)?)\s*\/\s*(10|20)\b/);
  return m ? { got: m[1], full: m[2] } : null;
}

/* 审题/识图 system（防幻觉铁律：只描述画面可直接确认元素，不确定必标注） */
const WRITING_INSPECT_SYSTEM = [
  '你是考研英语（一）阅卷组资深审题指导。',
  '用户会给一道写作题（小作文 Part A 书信/告示类 10 分，或大作文 Part B 图画/图表类 20 分），若附图则是漫画原图。',
  '你的任务：审题拆解与立意指导，输出固定三段式 Markdown，三个标题一字不差：',
  '### 画面要素',
  '仅描述画面上真实可见的内容：主体人物/动物/物体、动作与方位、对话气泡与图内文字、背景物品、符号与箭头、整体氛围。',
  '【防幻觉铁律】只写你能从图上直接确认的元素；任何不确定的内容后面标注「（不确定）」；图上没有的东西严禁编造。题目未附图时写「（题目未附图）」，并从题干整理命题信息。',
  '### 寓意主题',
  '揭示图画/命题背后考察的考研经典话题（如科技双刃剑、传统与创新、诚信、环保、青年奋斗、心理健康等），并给出一句命题关键词总结。',
  '### 立意建议',
  '给出 2~3 个稳妥立意角度（按推荐度排序，每条一句话），并提醒容易写偏的歧义点。',
  '全程简体中文，语言凝练直接；禁止输出评分或范文。',
].join('\n');

/* 批改升格 system（五锚点协议 + 思考聚焦锚） */
const WRITING_ELEVATE_SYSTEM = [
  '你是考研英语（一）阅卷组资深外教，对考生习作做「逐句诊断 + 阶梯升格」批改（小作文满分 10 分 / 大作文满分 20 分）。',
  '评分遵循考研阅卷真实档次：内容切题与要点覆盖、篇章衔接、词汇多样与精准（警惕中式直译与大词堆砌）、语法多样与准确。',
  '【思考聚焦】思考时只围绕：审题契合度、逐句病因定位（时态/主谓一致/冠词/介词/搭配/中式英语）、句型最有力的升格方案；不做无关发散。',
  '你的输出是【固定锚点协议】Markdown，五个锚点标题一字不差、按顺序出现：',
  '### [SCORE]',
  '第一行：总分（如 15/20 或 7/10）＋ 档位结论（如 第二档（良好））。',
  '随后四行列表：任务完成度 x/5、篇章逻辑 x/5、词汇丰富 x/5、语法准确 x/5（四个维度各配一句短评）。',
  '### [SENTENCES]',
  '挑 3~5 句最值得改的句子。每个句子一个 :::sentence … ::: 块，内部五行前缀固定：',
  '[ORIGINAL] 原句（原样摘录不改字）',
  '[FLAW] 一句中文点出病因（语法硬伤/中式表达/用词平庸/衔接生硬）',
  '[LEVEL1] 规范纠错版：只修正错误、保留原有结构（基准档）',
  '[LEVEL2] 考研高分升格版：句式与用词升级（高分档），自然不堆砌',
  '[TECHNIQUE] 升格手法标签 2~3 个，用 | 分隔（如：分词状语 | 动词升格 | 破除中式主语）',
  '### [REWRITE]',
  '在保留考生原有思路与论点的前提下写出全文升格版（篇幅符合该部分字数档），不要逐句重复批改内容。',
  '### [PATTERNS]',
  '提炼 3~5 个可迁移的考研写作句型骨架，每行一条，格式「- 英文句型 —— 中文用法说明」。',
  '【硬性规则】除五个锚点标题与 ::: 块外不写任何额外小节；锚点顺序不得颠倒；英文示例必须语法正确；点评用简体中文。',
].join('\n');

/**
 * v2.5.0：流式 LLM 中继（OpenAI 兼容）——请求构建与 llmChat 同源（思考参数只按服务商档案透传，
 * 功能代码零注入，off 档双保险显式关闭），区别为 delta 通过 onThinking/onContent 回调实时转发。
 * 上游把思考体（Administration…王朝块）混进正文时，内置流式状态机拦截转发到 onThinking，不污染正文。
 * mock 模式：mockLLM 整包产出按 12 块均匀推送（模拟真实推流节奏，供测试断言分块）。
 * 返回 { content, reasoningLen, finishReason }。
 */
async function llmChatSSE(messages, { providerId, llmOverride, maxTokens, onThinking, onContent } = {}) {
  let contentSeen = '';
  let reasoningLen = 0;
  let finishReasonOf = '';
  let usageSeen = null;   // v3.2.0：per-user 用量统计
  const emitC = t => { if (!t) return; contentSeen += t; if (onContent) { try { onContent(t); } catch { } } };
  const emitT = t => { if (!t) return; reasoningLen += t.length; if (onThinking) { try { onThinking(t); } catch { } } };

  if (config.llm.mock) {
    const reply = stripThinkBlocks(mockLLM(messages));
    if (!reply) return { content: '', reasoningLen: 0, finishReason: 'stop' };
    const N = 12;
    for (let i = 0; i < N; i++) {
      emitC(reply.slice(Math.floor(reply.length * i / N), Math.floor(reply.length * (i + 1) / N)));
      await new Promise(r => setTimeout(r, 15));
    }
    recordLlmUsage(estimateUsage(messages, reply));   // v3.2.0：mock 也记用量
    return { content: reply, reasoningLen: 0, finishReason: 'stop' };
  }

  const base = getProvider(providerId) || {};
  const llm = { ...base, ...(llmOverride || {}) };
  if (!llm.baseUrl || !llm.model) {
    const e = new Error('尚未配置 AI 服务商，请到「设置」页添加服务商并填写 API Key');
    e.code = 'NO_LLM';
    throw e;
  }
  const url = llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  // v2.4.4 思考参数翻译层（与 llmChat 同源）：off → reasoning_effort:none + enable_thinking:false 双保险；档位直通
  const bodyObj = { model: llm.model, messages, temperature: llm.temperature !== undefined ? llm.temperature : 0.7, stream: true, stream_options: { include_usage: true } };   // v3.2.0：流末回报 usage
  if (llm.max_tokens) bodyObj.max_tokens = llm.max_tokens;          // 用户档案已配置 → 按档案
  else if (maxTokens) bodyObj.max_tokens = maxTokens;               // 调用方显式指定才带上（写作升格默认不设钳制）
  if (llm._thinking) bodyObj.thinking = llm._thinking;
  else if (llm.thinking && llm.thinking !== 'off') bodyObj.reasoning_effort = llm.thinking;
  else { bodyObj.reasoning_effort = 'none'; bodyObj.enable_thinking = false; }
  if (typeof llm.extraBody === 'string' && llm.extraBody.trim()) {
    try {
      const extra = JSON.parse(llm.extraBody);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        delete extra.messages; delete extra.stream; delete extra.max_tokens;
        Object.assign(bodyObj, extra);
      }
    } catch { /* 非法 JSON 忽略 */ }
  }
  let res;
  try {
    res = await fetchT(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(llm.apiKey ? { 'Authorization': 'Bearer ' + llm.apiKey } : {}),
      },
      body: JSON.stringify(bodyObj),
    }, 300000);   // LLM 流式（SSE 直通）：整段最长 5 分钟
  } catch {
    throw new Error(`无法连接 AI 服务（${llm.baseUrl}），请到「设置」检查 Base URL 与网络`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI 请求失败 (HTTP ${res.status}) ${text.slice(0, 300)}`);
  }
  const ct = String(res.headers.get('content-type') || '');

  /* 流式思考体拦截状态机： content 中的 Administration/Write 网块 → onThinking，正文 → onContent */
  let sbuf = '', inThink = false;
  const csScan = isFinal => {
    for (;;) {
      if (inThink) {
        const m = /<\/think(?:ing)?\s*>/i.exec(sbuf);
        if (m) { emitT(sbuf.slice(0, m.index)); sbuf = sbuf.slice(m.index + m[0].length); inThink = false; continue; }
        // 尾部可能是被截断的闭合标签（≤12 字符）：保守扣住等待
        const holdTail = /<\/?(?:\/?t?h?i?n?k?i?n?g?\s*>?)?$/i.test(sbuf.slice(-12)) && sbuf.length <= 12;
        if (sbuf.length > 12) { emitT(sbuf.slice(0, sbuf.length - 12)); sbuf = sbuf.slice(sbuf.length - 12); }
        else if (holdTail && !isFinal) { /* 等待更多 */ }
        else if (isFinal) { emitT(sbuf); sbuf = ''; }
        break;
      }
      const m = /<think(?:ing)?\s*>/i.exec(sbuf);
      if (m) {
        const emit = sbuf.slice(0, m.index);
        sbuf = sbuf.slice(m.index + m[0].length);
        inThink = true;
        if (emit) emitC(emit);
        continue;
      }
      // 无开标签：扣住尾部可能是半截「<t…」标签前缀（≤19 字符）等待补齐
      const tail = sbuf.match(/<[^>]{0,19}$/);
      if (tail) {
        const cut = sbuf.length - tail[0].length;
        if (cut > 0) { emitC(sbuf.slice(0, cut)); sbuf = sbuf.slice(cut); }
      } else {
        emitC(sbuf); sbuf = '';
      }
      if (!isFinal) break;
      if (sbuf) { emitC(sbuf); sbuf = ''; }
      break;
    }
  };

  if (ct.includes('text/event-stream')) {
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const d = j.choices?.[0]?.delta || {};
            if (typeof d.reasoning_content === 'string') emitT(d.reasoning_content);
            if (typeof d.content === 'string') { sbuf += d.content; csScan(false); }
            if (j.choices?.[0]?.finish_reason) finishReasonOf = j.choices[0].finish_reason;
            if (j.usage) usageSeen = j.usage;   // v3.2.0：per-user 用量统计
          } catch { /* 单块坏数据忽略 */ }
        }
      }
    } catch (e) {
      throw new Error(`AI 流式响应中断（${e.message}），请重试`);
    }
    csScan(true);
  } else {
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    if (msg.reasoning_content) emitT(String(msg.reasoning_content));
    sbuf = String(msg.content || json.choices?.[0]?.text || '');
    finishReasonOf = json.choices?.[0]?.finish_reason || '';
    if (json.usage) usageSeen = json.usage;
    csScan(true);
  }
  if (usageSeen) recordLlmUsage(usageSeen);   // v3.2.0：per-user 用量统计

  if (!contentSeen.trim() && reasoningLen > 0) {
    throw new Error(`AI 只返回了思考过程，正文为空（finish_reason=${finishReasonOf}，思考已生成 ${reasoningLen} 字）。请到设置页调整「Max Tokens」或「思考强度」后重试。`);
  }
  return { content: stripThinkBlocks(contentSeen), reasoningLen, finishReason: finishReasonOf };
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
  if (sys.includes('似是而非') || sys.includes('智能干扰项生成')) {   // v2.12.0：测验智能干扰项 mock
    const sp = (user.match(/单词：(.+)/) || [])[1] || 'word';
    return JSON.stringify({ items: [{ spelling: sp.trim(), options: [`[MOCK] ${sp.trim()} 干扰项A`, `[MOCK] ${sp.trim()} 干扰项B`, `[MOCK] ${sp.trim()} 干扰项C`] }] });
  }
  if (sys.includes('错题讲解教练')) {   // v2.12.0：错题讲解 mock
    const sp = (user.match(/单词：(.+)/) || [])[1] || 'word';
    return [
      '## 为什么容易错',
      `[MOCK] ${sp.trim()} 与所选答案语义相邻，属常见混淆点（自测占位）。`,
      '',
      '## 词义与搭配辨析',
      `[MOCK] ${sp.trim()} 的核心义项与常见搭配（自测占位）。`,
      '',
      '## 一句话记忆点',
      `[MOCK] 用词根/谐音记住 ${sp.trim()}（自测占位）。`,
    ].join('\n');
  }
  if (sys.includes('拼写判分助手')) {   // v2.12.0：拼写容错判分 mock
    const target = (user.match(/正确单词：(.+)/) || [])[1] || '';
    const got = (user.match(/学习者拼写：(.+)/) || [])[1] || '';
    const norm = s => String(s || '').trim().toLowerCase();
    const dist = (() => {
      const a = norm(target), b = norm(got);
      let p = Array.from({ length: b.length + 1 }, (_, j) => j);
      for (let i = 1; i <= a.length; i++) { const c = [i]; for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; }
      return p[b.length];
    })();
    const verdict = norm(target) === norm(got) ? 'correct' : (dist <= Math.max(1, Math.floor(norm(target).length / 4)) ? 'typo' : 'wrong');
    return JSON.stringify({ verdict, feedback: verdict === 'correct' ? '[MOCK] 拼写正确' : (verdict === 'typo' ? '[MOCK] 拼写笔误' : '[MOCK] 拼写错误'), tip: '' });
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
  if (sys.includes('阅卷组资深审题指导')) {   // v2.5.0：写作升格审题/识图 mock——三段式防幻觉输出
    const isB = user.includes('Part B');
    const hasImg = user.includes('image 图片内容块') || user.includes('image_url');
    return [
      '### 画面要素',
      hasImg && isB
        ? '[MOCK] 一位坐在书桌前的年轻人，面前堆着复习资料，右手握着手机，屏幕朝向自己（图内文字无法确认 → （不确定））。（不确定：桌角是否有闹钟。）'
        : '（题目未附图）[MOCK] 从题干整理：Part A 建议信——向外国朋友介绍校园读书周活动并发出邀请。',
      '### 寓意主题',
      isB
        ? '[MOCK] 命题关键词：「数字时代的自律」——手机便利与沉迷风险并存，青年自控力是核心议题。'
        : '[MOCK] 命题关键词：「书信交际与活动邀请」——格式规范（称呼/正文三段/落款）与信息完整性。',
      '### 立意建议',
      '- [MOCK] 角度一（推荐）：从个体自律切入，讨论适度使用手机与自我管理的平衡。',
      '- [MOCK] 角度二：从环境与引导切入，探讨学校/家庭的提醒责任。',
      '- [MOCK] 歧义点提醒：勿把话题写成纯手机利弊罗列，须落到「人应对诱惑的态度」。',
    ].join('\n');
  }
  if (sys.includes('阶梯升格')) {   // v2.5.0：写作升格批改 mock——严格按五锚点协议从考生真实作文构造
    const essay = (user.match(/【考生作文】\n([\s\S]+)/) || [])[1] || '';
    const sents = essay.split(/(?<=[.!?])\s+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 8).slice(0, 2);
    const s1 = sents[0] || 'People think it is very good.';
    const s2 = sents[1] || s1;
    const wordsN = (user.match(/约 (\d+) 词/) || [])[1] || '0';
    const isB = user.includes('Part B');
    return [
      '### [SCORE]',
      `预估得分：${isB ? '15' : '7'}/${isB ? '20' : '10'} · 第二档（良好）`,
      '- 任务完成度 4/5 · [MOCK] 要点覆盖完整，契合题意。',
      '- 篇章逻辑 3.5/5 · [MOCK] 衔接手段单一，段落推进可更清晰。',
      '- 词汇丰富 3.5/5 · [MOCK] 基础词重复，可替换更地道表达。',
      '- 语法准确 4/5 · [MOCK] 无严重硬伤，复合句占比可提升。',
      '### [SENTENCES]',
      ':::sentence',
      `[ORIGINAL] ${s1}`,
      '[FLAW] [MOCK] 用词偏口语，句子信息密度低。',
      `[LEVEL1] ${s1.replace(/\bthink\b/i, 'believe').replace(/\bis very\b/i, 'is quite')}`,
      `[LEVEL2] [MOCK] 升格示范：It is widely acknowledged that ${s1.replace(/^people\s+/i, '').replace(/\bthink\b/i, 'benefit')}.（结构化重构）`,
      '[TECHNIQUE] 动词升格 | 形式主语 | 消灭中式直译',
      ':::',
      ':::sentence',
      `[ORIGINAL] ${s2}`,
      '[FLAW] [MOCK] 短句堆叠，可用伴随状语合并。',
      `[LEVEL1] ${s2}`,
      `[LEVEL2] [MOCK] 升格示范：${s2.replace(/\.$/, '')}, thereby fostering a more balanced lifestyle.`,
      '[TECHNIQUE] 分词伴随 | 句式合并 | 衔接升格',
      ':::',
      '### [REWRITE]',
      `[MOCK] 全文升格示范（基于考生原思路重构，约 ${isB ? '185' : '112'} 词；考生字数 ${wordsN} 词）：`,
      `[MOCK REWRITE BASED ON]: ${s1}`,
      '[MOCK] 只有这样，我们才能在享受科技便利的同时守住自律的边界（占位收束段）。',
      '### [PATTERNS]',
      '- A prevailing consensus holds that … —— 普遍共识认为……（开篇点题）',
      '- It is advisable to … —— ……是可取的（建议句型）',
      '- Only in this way can we … —— 只有这样我们才能……（倒装收尾）',
    ].join('\n');
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
      '5. 回复用 Markdown 轻量排版；推导箭头请直接使用 Unicode 符号（如 →、⇒、↔、≠），禁止裸写未渲染的 LaTeX 命令（如 \\rightarrow、\\to）。',
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
    title: '语料与真题质检审读员（System Prompt）【v2.6.2 已随 AI 审读功能废弃，保留仅供历史参考】',
    desc: '【v2.6.2 已废弃】对导入的真题或语料进行结构化对比、错字错题校验的质检提示词',
    template: [
      '【v2.6.2 已废弃：AI 审读功能因实测幻觉率过高已整体移除】',
      '此提示词不再被任何接口调用，保留仅为历史参考。',
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
      '要求：准确、简洁、有针对性；确实不确定的内容不要编造；用 Markdown 轻量排版（可用加粗与列表，推导箭头直接用 Unicode 符号 →，不要长篇大论）。',
    ].join('\n')
  },
  quality_review_item: {
    id: 'quality_review_item',
    title: '单条目编辑复核审读员（System Prompt）【v2.6.2 已随 AI 审读功能废弃，保留仅供历史参考】',
    desc: '【v2.6.2 已废弃】用户手动编辑真题条目后，AI 依据原件段落对该单条进行复核的提示词',
    template: [
      '【v2.6.2 已废弃：AI 审读功能因实测幻觉率过高已整体移除】',
      '此提示词不再被任何接口调用，保留仅为历史参考。',
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
      '6. quiz：检索自测题，数量按文章篇幅与难度自适应（短篇 5~6 题、中篇 7~8 题、长篇 9~12 题），覆盖全文关键情节与全部核心目标词——{q, options:[4个], answer(1-4), explain(40字内)}——多数用短文原句挖空目标词，穿插选义与细节理解题；干扰项来自目标词表或形近词。',
      '7. JSON 必须包含全部五个字段：title、passage、hooks、translation、quiz，缺一不可（hooks 数组元素数 = 目标词数，quiz 数量按篇幅 5~12 题自适应）。',
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
  },
  /* ---------- v2.12.0：测验 AI 增强 5 处 ---------- */
  quiz_distractors: {
    id: 'quiz_distractors',
    title: '测验：智能干扰项生成（System Prompt）',
    desc: '为四选一/看中选英题生成「似是而非」的干扰项，逼近考研易混词的辨析难度',
    template: [
      '你是考研英语出题教练。对给定的每个单词，生成 3 个「似是而非」的中文干扰释义（用于选择题的错误选项）。',
      '要求：',
      '1. 干扰项必须是真实存在的、与该词义相关或易混的其他义项/近义表达，绝不能是明显荒谬或与正确释义同义的选项。',
      '2. 三个干扰项彼此不同，且都不同于正确释义；优先取同词性、语义相邻（近义/反义/上下位/同一场景）的词。',
      '3. 每个干扰项 12 字以内，中文；不要写「的」字凑字数，不要加编号。',
      '4. 只输出 JSON，不要任何多余文字，格式：{"items":[{"spelling":"单词","options":["干扰1","干扰2","干扰3"]}]}',
    ].join('\n')
  },
  quiz_explain: {
    id: 'quiz_explain',
    title: '测验：错题讲解教练（System Prompt）',
    desc: '作答后针对错词给出简明讲解（错因、辨析、记忆点），用于结果页与错题本',
    template: [
      '你是考研英语错题讲解教练。学习者刚在单词测验中作答（可能答错或答得犹豫），请给出简明、可操作的讲解。',
      '固定输出以下 Markdown 小节，标题逐字使用：',
      '## 为什么容易错',
      '## 词义与搭配辨析',
      '## 一句话记忆点',
      '要求：',
      '1. 「为什么容易错」点明该词与学习者所选答案（若提供）混淆的根源，不要空泛。',
      '2. 「词义与搭配辨析」给核心义项、常见搭配，并视情况对比 1~2 个最易混的词。',
      '3. 「一句话记忆点」给一句能直接背的钩子（谐音/词根/联想均可）。',
      '4. 总篇幅 220 字以内；不确定的内容不要编造；推导箭头用 Unicode 符号 →。',
    ].join('\n')
  },
  quiz_mnemonic: {
    id: 'quiz_mnemonic',
    title: '测验：一键个性化助记（System Prompt）',
    desc: '为测验中的单个词生成一条可推送墨墨的个性化助记',
    template: [
      '你是英语学习教练，正在为「个性化助记」板块生成一条针对单个单词的助记。',
      '请结合该词的核心义项与易错点，生成一条具体、可直接背诵的助记。',
      '要求：',
      '1. 助记要结合该词暴露的易错点（混淆近义词、忘掉的义项），而不是泛泛的词根拆解。',
      '2. 80 字以内。',
      '3. noteType 从这些里选一个最贴切的：联想/谐音/词根词缀/近反义词/辨析/固定搭配/词源/口诀/其他。',
      '4. 只输出 JSON，不要多余文字，格式：{"notes":[{"spelling":"单词","noteType":"联想","content":"助记内容"}]}',
    ].join('\n')
  },
  quiz_spell_grade: {
    id: 'quiz_spell_grade',
    title: '测验：拼写容错判分（System Prompt）',
    desc: '对拼写题的答案做容错判定（拼写笔误 vs 真正记错），并给出简短反馈',
    template: [
      '你是考研英语拼写判分助手。学习者根据中文释义拼写单词。',
      '请在规则判分之外做容错判断：形近笔误（漏字母、多字母、相邻字母颠倒、少写一个重复字母）应判为「拼写笔误」而非「完全不会」。',
      '只输出 JSON，不要任何多余文字，格式：',
      '{"verdict":"correct|typo|wrong","feedback":"20字内中文反馈","tip":"20字内记忆提示，不确定给空串"}',
      '规则：完全拼对 verdict=correct；仅个别字母笔误且明显是同一个词 verdict=typo；拼成另一个词或差异过大 verdict=wrong。',
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
    res = await fetchT(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ig.apiKey ? { 'Authorization': 'Bearer ' + ig.apiKey } : {}),
      },
      body: JSON.stringify({ model, prompt: String(prompt).slice(0, 2000), n: 1, size: '1024x1024' }),
    }, 120000);   // 生图：2 分钟
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
      const imgRes = await fetchT(item.url, {}, 30000);   // 生图结果下载：30s
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
  const dir = currentImagesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
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
    res = await fetchT(ws.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ws.apiKey ? { 'Authorization': 'Bearer ' + ws.apiKey, 'X-API-KEY': ws.apiKey } : {}),
      },
      // 字段超集：覆盖博查(query/count/summary)、Tavily(query/max_results)、Serper(q)、智谱(search_query)
      body: JSON.stringify({ query, q: query, search_query: query, count, max_results: count, summary: true }),
    }, 30000);   // 网页搜索：30s
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
let externalCache = { mtime: 0, records: [], thin: false };
let externalSentenceCache = { mtime: 0, rows: [] };   // v2.9.0：外刊句子索引缓存
const externalBodyShardCache = new Map();
const EXTERNAL_BODY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const EXTERNAL_BODY_CACHE_MAX_SHARDS = 6;
let externalBodyCacheBytes = 0;

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

/** v2.9.0：外刊 release-format v2（瘦索引）。存在 articles_index.jsonl 时优先用瘦索引。 */
function externalIndexFile() { return path.join(externalCorpusDir(), 'articles_index.jsonl'); }
function externalSentencesFile() { return path.join(externalCorpusDir(), 'sentences_index.jsonl.gz'); }
function externalBodyDir() { return path.join(externalCorpusDir(), 'articles_body'); }
function externalIndexExists() { return fs.existsSync(externalIndexFile()); }

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

/** v2.0.0：读取采集管线发布的外刊快照；此库由发布流程写入，网站端只读。
 *  v2.9.0：优先读 release-format v2 瘦索引（articles_index.jsonl，约数 MB），
 *          全文分片（articles_body/*.jsonl.gz）按需从磁盘流式读取；
 *          目录里若只有旧的整包 articles.jsonl，则走原逻辑（向后兼容）。 */
function loadExternalKb() {
  const file = externalArticlesFile();
  const indexFile = externalIndexFile();
  const useIndex = fs.existsSync(indexFile);
  const mtime = fileMtime(useIndex ? indexFile : file);
  if (!mtime) { externalCache = { mtime: 0, records: [], thin: useIndex }; return []; }
  if (externalCache.mtime !== mtime || externalCache.thin !== useIndex) {
    const raw = useIndex ? readJsonlRaw(indexFile) : readJsonlRaw(file);
    externalCache = { mtime, records: raw.map(normalizeExternalRecord).filter(Boolean), thin: useIndex };
  }
  return externalCache.records;
}

/** v3.4.1：按需解压分片，缓存有界的解压 Buffer 与文章字节偏移，后续随机读取只解析目标行。 */
function externalLoadBody(id, shard) {
  const sh = Number.isInteger(shard) ? shard : shardOfId(id);
  if (sh < 0 || sh > 15) return null;
  const bodyDir = externalBodyDir();
  const file = path.join(bodyDir, `body-${String(sh).padStart(2, '0')}.jsonl.gz`);
  let stat;
  try { stat = fs.statSync(file, { bigint: true }); } catch { return null; }

  const key = `${path.resolve(bodyDir)}:${sh}`;
  const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  let entry = externalBodyShardCache.get(key);
  if (entry && entry.fingerprint === fingerprint) {
    externalBodyShardCache.delete(key);
    externalBodyShardCache.set(key, entry);
    return externalBodyAt(entry, id);
  }
  if (entry) removeExternalBodyShard(key);

  let buffer;
  try { buffer = require('zlib').gunzipSync(fs.readFileSync(file)); } catch { return null; }
  const offsets = new Map();
  let start = 0;
  for (let end = 0; end <= buffer.length; end++) {
    if (end !== buffer.length && buffer[end] !== 10) continue;
    if (end > start) {
      try {
        const row = JSON.parse(buffer.toString('utf8', start, end));
        if (row && typeof row.id === 'string' && !offsets.has(row.id)) offsets.set(row.id, { start, end });
      } catch { /* Ignore malformed JSONL rows. */ }
    }
    start = end + 1;
  }

  entry = { buffer, offsets, fingerprint };
  if (buffer.length <= EXTERNAL_BODY_CACHE_MAX_BYTES) {
    externalBodyShardCache.set(key, entry);
    externalBodyCacheBytes += buffer.length;
    while (externalBodyShardCache.size > EXTERNAL_BODY_CACHE_MAX_SHARDS || externalBodyCacheBytes > EXTERNAL_BODY_CACHE_MAX_BYTES) {
      removeExternalBodyShard(externalBodyShardCache.keys().next().value);
    }
  }
  return externalBodyAt(entry, id);
}

function externalBodyAt(entry, id) {
  const range = entry.offsets.get(id);
  if (!range) return null;
  try { return JSON.parse(entry.buffer.toString('utf8', range.start, range.end)); }
  catch { return null; }
}

function removeExternalBodyShard(key) {
  const entry = externalBodyShardCache.get(key);
  if (!entry) return;
  externalBodyCacheBytes -= entry.buffer.length;
  externalBodyShardCache.delete(key);
}

function shardOfId(id) {
  return parseInt(crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8), 16) % 16;
}

/** v2.9.0：懒加载外刊句子索引（搜索/AI 证据用）并按 mtime 常驻。
 *  只保留 {rid,s,sourceKind,l,_lean}（约 50MB，远低于旧格式整包全量 parse 的 446MB）；
 *  标题/刊名/URL 等元数据不逐句存，命中时从常驻的 articles_index 取。
 *  注：刻意一次性 gunzip 到位并常驻，避免每次检索重新解压造成 V8 堆反复扩张、
 *  RSS 只增不降（1.6G 机器上反而更危险）。 */
function loadExternalSentences() {
  const file = externalSentencesFile();
  const mtime = fileMtime(file);
  if (!mtime) return [];
  if (externalSentenceCache.mtime === mtime) return externalSentenceCache.rows;
  const zlib = require('zlib');
  const rows = [];
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    let start = 0;
    for (let i = 0; i <= raw.length; i++) {
      if (i !== raw.length && raw[i] !== 10) continue;
      if (i > start) {
        try {
          const o = JSON.parse(raw.toString('utf8', start, i));
          if (o && o.s) rows.push({ rid: o.r, s: o.s, sourceKind: 'external', l: o.l ? 1 : 0, _lean: true });
        } catch {}
      }
      start = i + 1;
    }
  } catch {}
  externalSentenceCache = { mtime, rows };
  return rows;
}

/** v2.0.0：record 已含全文时（旧格式）直接拼接；瘦索引模式由调用方补正文。 */
function externalEnsureText(rec) {
  if (!rec || rec.text) return rec;
  try {
    const body = externalLoadBody(rec.id, rec.shard);
    if (body) return {
      ...rec,
      text: Array.isArray(body.paragraphs) ? body.paragraphs.join('\n\n') : '',
      paragraphs: body.paragraphs || rec.paragraphs,
      sentences: body.sentences || rec.sentences,
      vocab_analysis: body.vocab_analysis || rec.vocab_analysis,
    };
  } catch {}
  return rec;
}

function externalStatus() {
  const file = externalArticlesFile();
  const indexFile = externalIndexFile();
  const manifestFile = externalManifestFile();
  const manifest = loadJSON(manifestFile, null);
  const thin = fs.existsSync(indexFile);
  return {
    dir: externalCorpusDir(),
    file: thin ? indexFile : file,
    manifestFile,
    exists: fs.existsSync(thin ? indexFile : file),
    format: thin ? 'v2' : 'v1',
    count: loadExternalKb().length,
    manifest: manifest && typeof manifest === 'object' ? {
      release_id: manifest.release_id || manifest.releaseId || '',
      generated_at: manifest.generated_at || manifest.generatedAt || '',
      updated_at: manifest.updated_at || '',
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
  // v2.9.0：外刊改用预生成句子索引（sentences_index.jsonl.gz），不再从句级重建
  const thin = externalIndexExists();
  const key = `${fileMtime(kbFile())}|${thin ? fileMtime(externalSentencesFile()) : fileMtime(externalArticlesFile())}|${fileMtime(examsFile())}`;
  if (kbCache.sentences && kbCache.sentencesKey === key) return kbCache.sentences;
  const out = [];
  const externalRecords = loadExternalKb();
  const corpusRecords = thin ? [...loadKb(), ...loadExams()] : [...loadKb(), ...externalRecords, ...loadExams()];
  for (const r of corpusRecords) {
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
          track: sourceKind === 'exam' ? trackOf(r) : null,
          trackLabel: sourceKind === 'exam' ? examTrackMeta(trackOf(r)).label : '',
          publication: r.source?.publication || r.source?.source || '',
          sourceUrl: r.source?.canonical_url || r.source?.url || '',
          s,
        });
      }
    }
  }
  if (thin) {
    // v2.9.0：外刊句子来自预生成索引，以极简行并入缓存（复用同一对象引用，不再复制）。
    for (const row of loadExternalSentences()) out.push(row);
  }
  kbCache.sentences = out;
  kbCache.sentencesKey = key;
  return out;
}

/** v2.9.0：外刊 id -> 索引记录（懒建，仅元数据）。 */
let externalByIdCache = { key: '', map: null };
function externalById() {
  const key = `${externalIndexExists() ? fileMtime(externalIndexFile()) : fileMtime(externalArticlesFile())}`;
  if (externalByIdCache.map && externalByIdCache.key === key) return externalByIdCache.map;
  const map = new Map();
  for (const r of loadExternalKb()) map.set(r.id, r);
  externalByIdCache = { key, map };
  return map;
}

/** 把瘦句子行补全为搜索结果契约（title/year/section/publication/sourceUrl）。
 *  返回**新对象**，不改动用缓存中的极简行，避免多次检索后元数据在缓存里累积。 */
function externalHydrateSentence(item) {
  if (!item || !item._lean) return item;
  const rec = externalById().get(item.rid);
  const out = { rid: item.rid, s: item.s, sourceKind: 'external', number: null, track: null, trackLabel: '' };
  if (rec) {
    const src = rec.source || {};
    out.title = rec.title || '';
    out.year = rec.meta?.year ?? (src.published_at ? Number(String(src.published_at).slice(0, 4)) || null : null);
    out.section = src.section || null;
    out.publication = src.publication || src.source || '';
    out.sourceUrl = src.canonical_url || src.url || '';
  } else {
    out.title = ''; out.year = null; out.section = null; out.publication = ''; out.sourceUrl = '';
  }
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
  const rank = x => x.sourceKind === 'exam' ? 0 : x.sourceKind === 'corpus' ? 1 : 2;
  for (const item of kbSentences()) {
    if (sourceKind !== 'all' && item.sourceKind !== sourceKind) continue;
    const hit = re ? re.test(item.s) : item.s.toLowerCase().includes(lower);
    if (!hit) continue;
    const key = item.s.toLowerCase();
    const prev = seen.get(key);
    if (prev === undefined) { seen.set(key, out.length); out.push(item); }
    else if ((item.number != null && out[prev].number == null) || rank(item) < rank(out[prev])) out[prev] = item;
  }
  return limit > 0 ? out.slice(0, limit).map(externalHydrateSentence) : out.map(externalHydrateSentence);
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
    // v2.9.0：瘦索引模式列表不带全文，预览取索引内预生成的 preview 字段
    preview: String(r.text || (items[0] && items[0].text) || r.preview || '').replace(/〖\/?\d+〗/g, '').slice(0, 90),
  };
}

/* ---------- v1.1.2：真题库（qa_set 分库到 exams.jsonl） ---------- */

/* v2.7.0：真题库按「考试大类」分流（track）——考研英语一 / 六级英语。
   兼容策略：track 缺省（历史记录与现有导入）一律视为 kaoyan1，零数据迁移。
   冲突键：exam/record 详情等路由以 '/' 结尾（如 /api/exam/records/6）；track 详情为单段。 */
const EXAM_TRACKS = {
  kaoyan1: { key: 'kaoyan1', label: '考研英语一', examName: '考研', sections: ['use_of_english', 'reading', 'part_b', 'translation', 'writing'] },
  cet6: { key: 'cet6', label: '六级英语', examName: '六级', sections: ['listening', 'banked_cloze', 'long_match', 'reading', 'translation', 'writing'] },
};
const DEFAULT_EXAM_TRACK = 'kaoyan1';

function normalizeTrack(t) {
  return Object.prototype.hasOwnProperty.call(EXAM_TRACKS, t) ? t : DEFAULT_EXAM_TRACK;
}
function trackOf(r) { return normalizeTrack(r && (r.track || (r.meta && r.meta.track))); }
function examTrackMeta(t) { return EXAM_TRACKS[normalizeTrack(t)]; }
/** 题型中文名（与原始「考研-阅读理解」口径一致） */
const EXAM_SECTION_NAME = {
  use_of_english: '完形填空', reading: '阅读理解', part_b: '新题型',
  translation: '翻译', writing: '写作', misc: '其他',
  /* v2.7.1 六级板块 */
  listening: '听力理解', banked_cloze: '选词填空', long_match: '长篇匹配',
};
/** 题型标签按 track 前缀（考研-阅读理解 / 六级-阅读理解） */
function sectionLabel(track, section) {
  const tk = examTrackMeta(track);
  const name = EXAM_SECTION_NAME[section] || section || '其他';
  return `${tk.examName}-${name}`;
}

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
  const track = trackOf(r);
  const bySec = new Map();
  for (const it of items) {
    const s = it.section || 'misc';
    if (!bySec.has(s)) {
      bySec.set(s, { key: s, label: sectionLabel(track, s), questions: 0, passages: 0, writings: 0 });
    }
    const b = bySec.get(s);
    if (it.type === 'question') b.questions++;
    else if (it.type === 'passage') b.passages++;
    else if (it.type === 'writing') b.writings++;
  }
  return {
    id: r.id,
    rtype: r.rtype,
    track,
    trackLabel: examTrackMeta(track).label,
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
  /* v2.7.1 六级板块 */
  listening: '听力理解',
  banked_cloze: '选词填空',
  long_match: '长篇匹配',
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
    const track = trackOf(rec);
    const trackMeta = examTrackMeta(track);
    const groups = [];
    const gkey = it => {
      if (it.section === 'reading') return 'reading~' + (it.passage_id ?? 0);
      if (it.section === 'listening') return 'listening~' + (it.passage_id ?? 0);
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
      // v2.7.1：六级同一年有多场次多套卷，年份后补「月/套」以免标题重名
      const when = track === 'cet6'
        ? [year ? year + '年' : '', rec.meta?.month ? rec.meta.month + '月' : '',
           rec.meta?.set ? '第' + rec.meta.set + '套' : ''].filter(Boolean).join('') || rec.title
        : (year ? year + '年' : rec.title);
      let title = `${trackMeta.examName}-${secName}-${when}`;
      if (g.section === 'reading') title += `-第${g.passageId || '?'}篇`;
      if (g.section === 'listening') title += `-第${g.passageId || '?'}段`;
      if (g.section === 'writing') title += `-Part ${g.part || 'A'}`;
      const gitems = g.idx.map(i => items[i]);
      const qs = gitems.filter(it => it.type === 'question');
      // v2.7.1：long_match 无选项（选段字母作答），仍属客观题，按有标准答案判分
      const objOk = g.section === 'long_match'
        ? true
        : qs.length > 0 && qs.every(it => it.options && Object.keys(it.options).length >= 2);
      units.push({
        unitId: `${rec.id}~${g.key}`,
        examId: rec.id,
        track,
        trackLabel: trackMeta.label,
        year,
        section: g.section,
        label: `${trackMeta.examName}-${secName}`,
        title,
        itemCount: gitems.length,
        qCount: qs.length,
        scored: qs.length > 0 && objOk,
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
    if (it.section === 'listening') return 'listening~' + (it.passage_id ?? 0);
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
async function kbImportOne({ name, buf, category, store = 'corpus', parserTag = null, track = null }) {
  const safe = kbSafeName(name);
  if (!safe) throw Object.assign(new Error('文件名无效'), { code: 'KB_IMPORT' });
  if (!buf || !buf.length) throw Object.assign(new Error('文件内容为空'), { code: 'KB_IMPORT' });
  const examTrack = normalizeTrack(track);
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
  // v2.7.0：真题库记录打上考试大类标记（track），缺省 kaoyan1；语料库记录不写
  if (store === 'exam') {
    for (const r of toExam) { r.track = examTrack; if (r.meta && typeof r.meta === 'object') r.meta.track = examTrack; }
  }
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
  const apply = await fetchT(MINERU_BASE + '/file-urls/batch', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'pipeline',          // 无幻觉管线（英语场景不需要 VLM 后端）
      language: 'en',             // 特化：英文 OCR
      enable_formula: false,      // 特化：考研英语无公式
      enable_table: false,        // 特化：真题无表格
      files: [{ name: filename, is_ocr: !!isOcr }],
    }),
  }, 30000);   // MinerU 申请上传链接：30s
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
  const put = await fetchT(putUrl, { method: 'PUT', body: buf }, 120000);   // MinerU 文件上传：2 分钟
  if (!put.ok) {
    const t = await put.text().catch(() => '');
    throw new Error('MinerU 文件上传失败 (HTTP ' + put.status + ') ' + t.slice(0, 200));
  }
  let zipUrl = null;
  for (let i = 0; i < 80; i++) {   // 3s 间隔最长 4 分钟（留余量避开 5 分钟请求超时）
    await new Promise(s => setTimeout(s, 3000));
    try {
      const pr = await fetchT(`${MINERU_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`, { headers: auth }, 20000);   // 轮询：20s/次
      if (!pr.ok) continue;
      const pj = await pr.json();
      const one = pj?.data?.extract_result?.[0];
      if (!one) continue;
      if (one.state === 'done' && one.full_zip_url) { zipUrl = one.full_zip_url; break; }
      if (one.state === 'failed') throw new Error('MinerU 解析失败: ' + String(one.err_msg || '未知原因').slice(0, 200));
    } catch (e) { if (String(e.message).startsWith('MinerU 解析失败')) throw e; }
  }
  if (!zipUrl) throw new Error('MinerU 解析超时（4 分钟），请稍后重试或改用本地导入');
  const zr = await fetchT(zipUrl, {}, 60000);   // MinerU 结果下载：60s
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

/**
 * v2.10.0：统一测验作答入库（4 档评分版）。
 * ① 更新独立 SRS（quiz_srs.json）：每词 ease/interval/dueAt/mastery + 错题本；
 * ② 兼容回写 db.words 的 quizResponse/quizWrong（仅命中已有词）；
 * ③ 双写学习流水（word_quiz，带 grade/mastery）；
 * ④ 更新游戏化（XP/连胜/combo）。
 * @returns {{ applied:number, attemptsSaved:number, wrongBooked:number, resolved:number, gamification:object }}
 */
function applyQuizSrsSession(items, mode) {
  const atIso = new Date().toISOString();
  const store = loadQuizSrs();
  const attemptsToSave = [];
  let applied = 0;
  let wrongBooked = 0;
  let resolved = 0;
  let xpGained = 0;
  let combo = store.gamification.combo || 0;
  let bestCombo = store.gamification.bestCombo || 0;

  for (const it of items) {
    const sp = String(it.spelling || '').trim();
    const grade = String(it.grade || '').trim();
    if (!sp || !QUIZ_GRADES.has(grade)) continue;
    applied++;

    // ① SRS 演化
    const prev = store.words[sp] || null;
    let conf = it.confidence ? String(it.confidence).trim() : 'unsure';
    if (!VALID_ATTEMPT_CONFIDENCES.has(conf)) conf = 'unsure';
    const result = QUIZ_GRADE_TO_RESULT[grade];
    const next = applySrsGrade(prev, grade, { confidence: conf, result, at: atIso });
    store.words[sp] = next;

    // ② 错题本
    const before = wrongBookIndex(store, sp);
    const wasResolvedBefore = before >= 0 ? !!store.wrongBook[before].resolved : true;
    updateWrongBook(store, sp, grade, atIso);
    const afterIdx = wrongBookIndex(store, sp);
    if (grade === 'again' && afterIdx >= 0 && !store.wrongBook[afterIdx].resolved && (before < 0 || wasResolvedBefore)) {
      wrongBooked++;   // 新入本（含从已掌握回炉）
    }
    if (afterIdx >= 0 && store.wrongBook[afterIdx].resolved && !wasResolvedBefore) resolved++;

    // ③ 兼容回写 db.words（仅命中已有墨墨词；自维护词不凭空创建）
    const w = Object.values(db.words).find(x => x.spelling === sp);
    if (w) {
      w.quizResponse = QUIZ_GRADE_TO_RESPONSE[grade];
      if (grade === 'again') w.quizWrong = (w.quizWrong || 0) + 1;
      w.quizLastAt = atIso;
    }

    // ④ 游戏化
    if (grade === 'again') { combo = 0; xpGained += 1; }
    else if (grade === 'hard') { combo += 1; xpGained += 3; }
    else if (grade === 'good') { combo += 1; xpGained += 5; }
    else { combo += 1; xpGained += 8; }
    if (combo > bestCombo) bestCombo = combo;

    // ⑤ 学习流水
    const stdGloss = (db.glosses && db.glosses[sp])
      ? (typeof db.glosses[sp] === 'string' ? db.glosses[sp] : db.glosses[sp].gloss || '')
      : '';
    const userAnswer = it.userAnswer !== undefined && it.userAnswer !== null
      ? String(it.userAnswer).slice(0, 4000)
      : QUIZ_GRADE_TO_RESPONSE[grade];

    attemptsToSave.push({
      kind: 'word_quiz',
      source: 'quiz',
      itemId: `word:${sp}`,
      section: 'vocabulary',
      prompt: sp,
      expected: stdGloss,
      answer: userAnswer,
      result,
      confidence: conf,
      startedAt: it.startedAt || null,
      submittedAt: it.submittedAt || atIso,
      durationMs: (typeof it.durationMs === 'number' && it.durationMs >= 0 && it.durationMs <= 14400000) ? Math.round(it.durationMs) : null,
      meta: { mode: String(it.mode || mode || 'flash').slice(0, 20), word: sp, grade, mastery: next.mastery, response: QUIZ_GRADE_TO_RESPONSE[grade] },
    });
  }

  // 游戏化累积（XP/连胜按北京时间自然日）
  const today = bjDate();
  const g = store.gamification;
  if (applied > 0) {
    g.xp = (g.xp || 0) + xpGained;
    g.combo = combo;
    g.bestCombo = bestCombo;
    if (g.lastActiveDate !== today) {
      const yesterday = bjDate(-1);
      g.streak = (g.lastActiveDate === yesterday) ? (g.streak || 0) + 1 : 1;
      g.lastActiveDate = today;
    }
  }

  pruneQuizSrs(store);
  saveQuizSrs(store);
  persistDB();

  // 旧聚合日志（兼容仪表盘「测验概况」）
  if (applied > 0) {
    db.quizLog.unshift({
      ts: atIso, mode: String(mode || '').slice(0, 20),
      total: applied,
      familiar: items.filter(r => QUIZ_GRADE_TO_RESPONSE[r.grade] === 'FAMILIAR').length,
      vague: items.filter(r => r.grade === 'hard').length,
      forget: items.filter(r => r.grade === 'again').length,
    });
    db.quizLog = db.quizLog.slice(0, 100);
    persistDB();
  }

  let attemptsSaved = 0;
  if (attemptsToSave.length > 0) attemptsSaved = appendLearningAttempts(attemptsToSave);

  return { applied, attemptsSaved, wrongBooked, resolved, gamification: g };
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
// v3.2.0：云词库缓存按用户隔离（每人各自绑定云词库，Token 不同，缓存不可跨用户复用）
const notepadCaches = new Map();   // userId -> { id, at, words:Set, notepad }
function notepadCacheOf() {
  const uid = currentCtx().userId || LEGACY_USER;
  let c = notepadCaches.get(uid);
  if (!c) { c = { id: '', at: 0, words: new Set(), notepad: null }; notepadCaches.set(uid, c); }
  return c;
}

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
  const cache = notepadCacheOf();
  if (cache.id !== nid || now - cache.at > 5 * 60 * 1000) {
    const data = await mm(`/notepads/${encodeURIComponent(nid)}`);
    const np = data?.notepad || null;
    if (!np) throw new Error('云词库不存在或已被删除，请到「设置」重新绑定');
    const words = (Array.isArray(np.list) ? np.list : [])
      .filter(it => it?.type === 'WORD')
      .map(it => String(it?.data?.word || '').toLowerCase());
    cache.id = nid; cache.at = now; cache.words = new Set(words); cache.notepad = np;
  }

  if (cache.words.has(String(spelling).toLowerCase())) return;

  const np = cache.notepad;
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
  cache.notepad.content = content;
  cache.words.add(String(spelling).toLowerCase());
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

/* v3.2.0：自动同步改为 **per-user** —— 每个用户各自按自己的 Token/间隔独立后台同步。
 *  单用户模式沿用 LEGACY_USER 单键（行为与 v2.12.0 一致）。 */
const autoTimers = new Map();   // userId -> { timer, warm }
function armAutoSyncForUser(userId) {
  const prev = autoTimers.get(userId);
  if (prev) { if (prev.timer) clearInterval(prev.timer); if (prev.warm) clearTimeout(prev.warm); autoTimers.delete(userId); }
  let cfg, mmToken, lastSync, minutes;
  if (MULTIUSER && userId !== LEGACY_USER) {
    cfg = getUserConfig(userId);
    mmToken = cfg && cfg.maimemoToken;
    lastSync = getUserDb(userId)?.lastSync;
    minutes = cfg?.autoSync?.minutes;
  } else {
    cfg = rawConfig; mmToken = rawConfig.maimemoToken; lastSync = legacyDb?.lastSync; minutes = rawConfig.autoSync?.minutes;
  }
  if (!cfg?.autoSync?.enabled || !mmToken) return;
  const ms = Math.max(5, Number(minutes) || 60) * 60000;
  const ctxStore = { userId, role: userId === LEGACY_USER ? 'admin' : (userRegistry.users[userId]?.role || 'user'), ok: true, legacy: userId === LEGACY_USER };
  const run = () => requestContext.run(ctxStore, () => runSync('auto').catch(e => logSync(false, '自动同步异常: ' + e.message)));
  const timer = setInterval(run, ms);
  const entry = { timer, warm: null };
  requestContext.run(ctxStore, () => logSync(true, `已开启自动同步，每 ${minutes} 分钟`));
  // 超过间隔未曾同步 → 启动后 10 秒内预热一次
  const lastSyncMs = lastSync ? new Date(lastSync).getTime() : 0;
  if (Date.now() - lastSyncMs >= ms) {
    entry.warm = setTimeout(() => requestContext.run(ctxStore, () => runSync('auto-startup').catch(e => logSync(false, '启动自动同步异常: ' + e.message))), 10000);
  }
  autoTimers.set(userId, entry);
}
/** 重新装配：多用户下遍历所有用户，单用户下仅装配 LEGACY_USER */
function armAutoSync() {
  // 清理已下线/已关闭用户的定时器
  for (const uid of [...autoTimers.keys()]) {
    if (MULTIUSER && uid !== LEGACY_USER && !userRegistry.users[uid]) {
      const e = autoTimers.get(uid); if (e) { if (e.timer) clearInterval(e.timer); if (e.warm) clearTimeout(e.warm); } autoTimers.delete(uid);
    }
  }
  if (MULTIUSER) {
    for (const uid of Object.keys(userRegistry.users)) armAutoSyncForUser(uid);
  } else {
    armAutoSyncForUser(LEGACY_USER);
  }
}

/* ================================================================== */
/* v3.5.0：发音朗读（服务端神经语音 + 真人音源）                          */
/*   - 单词：有道真人发音（美音 type=2 / 英音 type=1），磁盘缓存          */
/*   - 句子：本地 Piper 神经语音常驻工作进程（懒加载、按需拉起），磁盘缓存   */
/*   - 二者皆不可用时前端回退浏览器 speechSynthesis（不阻断学习）         */
/*   本模块只读合成音频，不写用户数据，属全局共享资源。                    */
/* ================================================================== */
const RUNTIME_DIR = path.join(ROOT, 'runtime');             // v3.5.3：部署产物目录（不进 git、不参与 data 备份）
const TTS_DIR = path.join(RUNTIME_DIR, 'tts');              // 音频+缓存落盘目录
const TTS_CACHE_DIR = path.join(TTS_DIR, 'cache');          // 合成结果缓存（按内容哈希）
const PIPER_HOME = process.env.PIPER_HOME ? path.resolve(process.env.PIPER_HOME) : path.join(RUNTIME_DIR, 'piper');
const PIPER_VENV_PY = path.join(PIPER_HOME, 'venv', 'bin', 'python');
const PIPER_VOICES_DIR = path.join(PIPER_HOME, 'voices');
const PIPER_WORKER = path.join(ROOT, 'tools', 'tts', 'piper_worker.py');
const TTS_VOICES = {
  en_US: { piper: path.join(PIPER_VOICES_DIR, 'en_US-lessac-medium.onnx'), youdaoType: '2', label: '美音' },
  en_GB: { piper: path.join(PIPER_VOICES_DIR, 'en_GB-alba-medium.onnx'), youdaoType: '1', label: '英音' },
};
const TTS_TEXT_MAX = 500;              // 单次朗读文本上限（防滥用）
const TTS_WORD_MAX = 64;               // 视为「单词/词组」的长度上限，超过走句子引擎
const TTS_YOUDAO_TIMEOUT_MS = 12000;
const TTS_PIPER_TIMEOUT_MS = 30000;
const TTS_CACHE_MAX_FILES = 4000;      // 缓存文件上限（超出按 mtime 裁剪）
const TTS_CACHE_MAX_BYTES = 256 * 1024 * 1024;

function ensureTtsDirs() {
  for (const d of [TTS_DIR, TTS_CACHE_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

/** 发音语音偏好（全局，管理员配置；普通用户只读） */
function ttsAccent() {
  const a = config.tts && config.tts.accent;
  return (a === 'en_GB') ? 'en_GB' : 'en_US';
}
function ttsCacheKey(engine, accent, text) {
  return crypto.createHash('sha1').update(`${engine}\n${accent}\n${text}`).digest('hex').slice(0, 32);
}
function ttsCachePath(engine, accent, text, ext) {
  return path.join(TTS_CACHE_DIR, `${engine}-${accent}-${ttsCacheKey(engine, accent, text)}${ext}`);
}

/** 文本是否是「单词或短词组」（走真人音源）；含标点/多句则视为句子。 */
function isTtsWord(text) {
  const t = String(text || '').trim();
  if (!t || t.length > TTS_WORD_MAX) return false;
  return /^[a-zA-Z][a-zA-Z'’\- ]*$/.test(t) && t.split(/\s+/).length <= 4;
}

/** 有道真人发音 URL（美音 type=2 / 英音 type=1）。 */
function youdaoVoiceUrl(text, accent) {
  const type = (TTS_VOICES[accent] || TTS_VOICES.en_US).youdaoType;
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=${type}`;
}

/** 拉取有道真人发音 mp3；成功返回 Buffer，失败（500/网络/非音频）返回 null。 */
async function fetchYoudaoAudio(text, accent) {
  try {
    const r = await fetchT(youdaoVoiceUrl(text, accent), { headers: { 'User-Agent': TTS_UA } }, TTS_YOUDAO_TIMEOUT_MS);
    if (!r.ok) return null;
    const ct = String(r.headers.get('content-type') || '');
    if (!/audio|octet-stream|mpeg/i.test(ct)) return null;   // 有道失败时会返回 application/json
    const buf = Buffer.from(await r.arrayBuffer());
    // 有道失败体很小且以 JSON 开头；真实音频带 ID3 或 MPEG 帧同步
    if (buf.length < 512) return null;
    if (buf.subarray(0, 1).toString('latin1') === '{') return null;
    return buf;
  } catch {
    return null;
  }
}
const TTS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/* Piper 常驻工作进程：多请求复用同一 Python 进程，避免每次启动/加载模型（约 3.5s）。 */
const piperState = {
  proc: null,
  ready: false,
  pending: new Map(),   // id -> { resolve, reject, timer }
  seq: 0,
  buf: '',
  starting: null,
  lastError: '',
};
function piperAvailable() {
  return fs.existsSync(PIPER_VENV_PY) && fs.existsSync(PIPER_WORKER);
}
function piperVoiceReady(accent) {
  const v = TTS_VOICES[accent] || TTS_VOICES.en_US;
  return fs.existsSync(v.piper) && fs.existsSync(v.piper + '.json');
}
function resetPiper(reason) {
  piperState.ready = false;
  piperState.proc = null;
  piperState.buf = '';
  piperState.lastError = reason || 'piper 进程已退出';
  for (const [, p] of piperState.pending) {
    clearTimeout(p.timer);
    p.reject(new Error(piperState.lastError));
  }
  piperState.pending.clear();
}
function startPiper() {
  if (piperState.proc && piperState.ready) return Promise.resolve();
  if (piperState.starting) return piperState.starting;
  if (!piperAvailable()) return Promise.reject(new Error('未安装服务端语音引擎（Piper）'));
  piperState.starting = new Promise((resolve, reject) => {
    ensureTtsDirs();
    let child;
    try {
      child = spawn(PIPER_VENV_PY, [
        '-u', PIPER_WORKER,
        '--en_US', TTS_VOICES.en_US.piper,
        '--en_GB', TTS_VOICES.en_GB.piper,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      piperState.starting = null;
      return reject(e);
    }
    piperState.proc = child;
    const startedAt = Date.now();
    let settled = false;
    const failStart = msg => {
      if (settled) return;
      settled = true;
      piperState.ready = false;
      piperState.proc = null;
      piperState.starting = null;
      piperState.lastError = String(msg).slice(0, 300);
      try { child.kill(); } catch {}
      reject(new Error(piperState.lastError));
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (!settled) { settled = true; piperState.ready = true; piperState.starting = null; resolve(); }
      piperState.buf += chunk;
      let idx;
      while ((idx = piperState.buf.indexOf('\n')) >= 0) {
        const line = piperState.buf.slice(0, idx).trim();
        piperState.buf = piperState.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = msg && msg.id != null ? piperState.pending.get(String(msg.id)) : null;
        if (!p) continue;
        clearTimeout(p.timer);
        piperState.pending.delete(String(msg.id));
        if (msg.ok) p.resolve();
        else p.reject(new Error(msg.error || '合成失败'));
      }
    });
    child.stderr.on('data', d => { piperState.lastError = String(d).trim().slice(0, 300); });
    child.on('error', err => failStart(err.message));
    child.on('exit', code => {
      if (!settled) return failStart(`piper 启动失败（退出码 ${code}）`);
      resetPiper(`piper 进程退出（code=${code}）`);
    });
    // 启动看门狗：进程正常但迟迟不产出（模型加载异常）
    setTimeout(() => { if (!settled && Date.now() - startedAt >= 20000) failStart('piper 启动超时'); }, 20000);
  });
  return piperState.starting;
}
/** 用 Piper 合成文本到 outPath（wav）。失败抛异常，调用方降级。 */
async function piperSynthesize(text, accent, outPath) {
  await startPiper();
  const id = String(++piperState.seq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      piperState.pending.delete(id);
      reject(new Error('语音合成超时'));
    }, TTS_PIPER_TIMEOUT_MS);
    piperState.pending.set(id, { resolve, reject, timer });
    try {
      piperState.proc.stdin.write(JSON.stringify({ id, text, voice: accent, out: outPath }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      piperState.pending.delete(id);
      reject(e);
    }
  });
}

/** 缓存裁剪：文件数/总量超限时按 mtime 从旧到新删除。 */
function pruneTtsCache() {
  try {
    const names = fs.readdirSync(TTS_CACHE_DIR);
    const stat = [];
    let total = 0;
    for (const n of names) {
      try {
        const s = fs.statSync(path.join(TTS_CACHE_DIR, n));
        total += s.size;
        stat.push({ n, mtime: s.mtimeMs, size: s.size });
      } catch {}
    }
    if (stat.length <= TTS_CACHE_MAX_FILES && total <= TTS_CACHE_MAX_BYTES) return;
    stat.sort((a, b) => a.mtime - b.mtime);
    let i = 0;
    while (i < stat.length && (stat.length - i > TTS_CACHE_MAX_FILES || total > TTS_CACHE_MAX_BYTES)) {
      try { fs.unlinkSync(path.join(TTS_CACHE_DIR, stat[i].n)); total -= stat[i].size; } catch {}
      i++;
    }
  } catch { /* 裁剪失败不影响朗读 */ }
}

/**
 * 合成朗读音频，返回 { ok, file, mime, engine, cached }。
 * 单词优先有道真人音；句子或单词失败时用 Piper；全失败抛 TTS_UNAVAILABLE。
 */
async function ttsSynthesize(rawText, accentOverride) {
  const text = String(rawText || '').trim().slice(0, TTS_TEXT_MAX);
  if (!text) {
    const e = new Error('缺少朗读文本');
    e.code = 'BAD_TTS_TEXT';
    throw e;
  }
  const accent = TTS_VOICES[accentOverride] ? accentOverride : ttsAccent();
  ensureTtsDirs();
  const isWord = isTtsWord(text);

  // 1) 单词：有道真人音（mp3）
  if (isWord) {
    const cache = ttsCachePath('youdao', accent, text, '.mp3');
    if (fs.existsSync(cache)) return { ok: true, file: cache, mime: 'audio/mpeg', engine: 'youdao', cached: true };
    const buf = await fetchYoudaoAudio(text, accent);
    if (buf) {
      const tmp = cache + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, cache);
      pruneTtsCache();
      return { ok: true, file: cache, mime: 'audio/mpeg', engine: 'youdao', cached: false };
    }
  }

  // 2) 句子 / 有道失败：Piper 神经语音（wav）
  const cache = ttsCachePath('piper', accent, text, '.wav');
  if (fs.existsSync(cache)) return { ok: true, file: cache, mime: 'audio/wav', engine: 'piper', cached: true };
  if (piperAvailable()) {
    const tmp = cache + '.tmp';
    try {
      await piperSynthesize(text, accent, tmp);
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 44) {
        fs.renameSync(tmp, cache);
        pruneTtsCache();
        return { ok: true, file: cache, mime: 'audio/wav', engine: 'piper', cached: false };
      }
    } catch { /* 落到 TTS_UNAVAILABLE，前端回退浏览器 TTS */ }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }

  const e = new Error('服务端语音不可用');
  e.code = 'TTS_UNAVAILABLE';
  throw e;
}

/** 服务端语音能力状态（供设置页展示与健康检查）。 */
function ttsStatus() {
  return {
    accent: ttsAccent(),
    voices: Object.entries(TTS_VOICES).map(([k, v]) => ({ id: k, label: v.label, ready: piperVoiceReady(k) })),
    piper: {
      installed: piperAvailable(),
      running: piperState.ready,
      voicesReady: Object.keys(TTS_VOICES).filter(piperVoiceReady),
      home: PIPER_HOME,
      lastError: piperState.lastError || '',
    },
    youdao: true,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJSON(res, code, obj) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(obj);
  // v1.1.0：禁缓存（经验总结坑 #3）——前端改完立刻可见，杜绝"白排查半天"
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

function isWithinDir(baseDir, targetPath) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/* v3.3.6：今日任务中心、考试计划与听说训练 */
const STUDY_TASK_IDS = new Set(['vocab_today', 'review_due', 'exam_practice', 'listening', 'speaking']);
const speechSessions = new Map();
function validStudyDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2100 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
function defaultStudyPlan() {
  return {
    schemaVersion: 1,
    examType: 'kaoyan1',
    examDate: '',
    dailyWords: 30,
    dailyMinutes: 30,
    completed: {},
    updatedAt: null,
  };
}
function loadStudyPlan() {
  const file = ctxFilePath(STUDY_PLAN_FILE);
  let raw = defaultStudyPlan();
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || raw.schemaVersion !== 1 || !raw.completed || typeof raw.completed !== 'object' || Array.isArray(raw.completed)) throw new Error('invalid schema');
    } catch {
      const e = new Error('考试计划文件损坏，已拒绝覆盖，请从备份恢复');
      e.code = 'STUDY_PLAN_CORRUPT'; throw e;
    }
  }
  const base = defaultStudyPlan();
  const p = raw && typeof raw === 'object' ? raw : {};
  const completed = p.completed;
  return {
    ...base,
    examType: ['kaoyan1', 'cet6', 'custom'].includes(String(p.examType)) ? String(p.examType) : base.examType,
    examDate: validStudyDate(String(p.examDate || '')) ? String(p.examDate) : '',
    dailyWords: Number.isFinite(Number(p.dailyWords)) ? Math.max(1, Math.min(10000, Math.floor(Number(p.dailyWords)))) : base.dailyWords,
    dailyMinutes: Number.isFinite(Number(p.dailyMinutes)) ? Math.max(1, Math.min(1440, Math.floor(Number(p.dailyMinutes)))) : base.dailyMinutes,
    completed,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
  };
}
function saveStudyPlan(plan) {
  saveJSON(ctxFilePath(STUDY_PLAN_FILE), { ...plan, schemaVersion: 1, updatedAt: new Date().toISOString() });
}
function cleanStudyPlanInput(body, current = loadStudyPlan()) {
  const examType = String(body.examType ?? current.examType);
  if (!['kaoyan1', 'cet6', 'custom'].includes(examType)) throw new Error('examType 仅允许 kaoyan1/cet6/custom');
  const examDate = String(body.examDate ?? current.examDate ?? '').trim();
  if (examDate && !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) throw new Error('examDate 必须为 YYYY-MM-DD');
  if (examDate) {
    const [yy, mm, dd] = examDate.split('-').map(Number);
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    if (yy < 2000 || yy > 2100 || isNaN(d.getTime()) || d.getUTCFullYear() !== yy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) throw new Error('examDate 不是有效日期（2000..2100）');
  }
  const dailyWords = Number(body.dailyWords ?? current.dailyWords);
  const dailyMinutes = Number(body.dailyMinutes ?? current.dailyMinutes);
  if (!Number.isInteger(dailyWords) || dailyWords < 1 || dailyWords > 10000) throw new Error('dailyWords 必须为 1..10000 的整数');
  if (!Number.isInteger(dailyMinutes) || dailyMinutes < 1 || dailyMinutes > 1440) throw new Error('dailyMinutes 必须为 1..1440 的整数');
  return { ...current, schemaVersion: 1, examType, examDate, dailyWords, dailyMinutes };
}
function completedStudyTasksFor(date, plan = loadStudyPlan()) {
  const row = plan.completed && plan.completed[date];
  return row && typeof row === 'object' ? row : {};
}
function studyTasks(date = bjDate(), plan = loadStudyPlan()) {
  const due = new Set(collectSrsDue('all').map(x => x.spelling)).size;
  const attempts = loadLearningStore().attempts.filter(x => bjDateOf(x.submittedAt) === date && !['pending', 'unjudged'].includes(x.result));
  const vocab = new Set(attempts.filter(x => x.kind === 'word_quiz').map(x => x.meta?.word || x.itemId));
  const progress = db.progressHistory.find(x => x.date === date);
  const counts = {
    vocab_today: Math.max(vocab.size, progress?.finished || 0),
    review_due: new Set(attempts.filter(x => x.kind === 'word_quiz' && ['srs', 'srs_review', 'wrongbook'].includes(x.meta?.mode)).map(x => x.meta?.word || x.itemId)).size,
    exam_practice: attempts.filter(x => ['unit_objective', 'translation', 'writing', 'vocab_context', 'vocab_cloze'].includes(x.kind)).length,
    listening: attempts.filter(x => x.kind === 'listening').length,
    speaking: attempts.filter(x => x.kind === 'speaking').length,
  };
  const completed = completedStudyTasksFor(date, plan);
  const tasks = [
    { id: 'vocab_today', title: '今日词汇', icon: '🔤', target: plan.dailyWords, detail: `${counts.vocab_today}/${plan.dailyWords} 词 · 今日词表 ${Object.values(db.words).filter(x => x.today?.date === date).length}`, tab: 'study' },
    { id: 'review_due', title: '到期与错题复习', icon: '🔁', target: due + counts.review_due, detail: `${counts.review_due} 词已练 · ${due} 词待复习（去重）`, tab: 'quiz' },
    { id: 'exam_practice', title: '真题训练', icon: '📝', target: 1, detail: `${counts.exam_practice}/1 次`, tab: 'exam' },
    { id: 'listening', title: '听力拼写', icon: '🎧', target: 1, detail: `${counts.listening}/1 次`, tab: 'speaking' },
    { id: 'speaking', title: '口语跟读', icon: '🗣️', target: 1, detail: `${counts.speaking}/1 次`, tab: 'speaking' },
  ];
  return tasks.map(t => {
    const automatic = counts[t.id] >= t.target;
    return { ...t, count: counts[t.id], automatic, done: automatic || completed[t.id] === true };
  });
}
function completeStudyTask(taskId, date = bjDate(), done = true) {
  if (!STUDY_TASK_IDS.has(taskId)) throw new Error('未知任务');
  const plan = loadStudyPlan();
  if (!plan.completed[date] || typeof plan.completed[date] !== 'object') plan.completed[date] = {};
  plan.completed[date][taskId] = done === true;
  // 只保留最近 120 天，避免跨设备同步文件无限增长
  const dates = Object.keys(plan.completed).sort();
  for (const old of dates.slice(0, Math.max(0, dates.length - 120))) delete plan.completed[old];
  saveStudyPlan(plan);
  return studyTasks(date, plan);
}
function studyPlanDate(plan) {
  return plan.examDate || null;
}
function speechSourceWord() {
  const words = [...Object.values(db.words), ...db.todayItems].filter(x => /^[a-z][a-z'-]{1,40}$/i.test(x?.spelling || ''));
  const today = words.filter(x => x.today?.date === bjDate());
  const pool = today.length ? today : words;
  const item = pool.length ? pool[crypto.randomInt(pool.length)] : { spelling: 'practice' };
  const spelling = String(item.spelling).trim().slice(0, 120) || 'practice';
  const gloss = String(db.glosses[spelling]?.gloss || '').slice(0, 300);
  return { spelling, gloss };
}
function speechSourceSentence(word) {
  const plan = loadStudyPlan();
  const pool = kbSentences().filter(x => x.s.length <= 180 && /^[a-zA-Z]/.test(x.s) && (!x.track || plan.examType === 'custom' || x.track === plan.examType));
  const matching = pool.filter(x => normalizeSpeechText(x.s).split(' ').includes(word));
  const candidates = matching.length ? matching : pool;
  if (candidates.length) {
    const item = candidates[crypto.randomInt(candidates.length)];
    return { text: item.s, source: item.sourceKind, title: item.title || '本地语料', rid: item.rid };
  }
  const sentences = ['Regular practice helps me make steady progress.', 'I would like to improve my English every day.', 'Learning a new language takes time and patience.'];
  return { text: sentences[crypto.randomInt(sentences.length)], source: 'builtin', title: '内置练习短句', rid: null };
}
function speechSessionFor(id, userId) {
  const s = speechSessions.get(`${userId}:${id}`);
  if (!s || Date.now() - s.createdAt > 15 * 60 * 1000) { speechSessions.delete(`${userId}:${id}`); return null; }
  return s;
}
function normalizeSpeechText(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ').replace(/\s+/g, ' ').trim(); }
function speechTokenDistance(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  let prev = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const cur = [i];
    for (let j = 1; j <= right.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[right.length];
}

function readBody(req, max = 5e6) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
      req.off('aborted', onAborted); req.off('close', onClose);
    };
    const finish = value => { if (settled) return; settled = true; cleanup(); resolve(value); };
    const fail = err => { if (settled) return; settled = true; cleanup(); reject(err); };
    const onData = c => {
      buf += c;
      if (buf.length > max) {
        // v1.1.3：超限带 code 走统一错误映射（413）；resume() 排空剩余数据，连接可正常收尾
        req.resume();
        const e = new Error('请求体超过 ' + Math.round(max / 1e6) + 'MB 上限，请拆分文件');
        e.code = 'BODY_TOO_LARGE';
        fail(e);
      }
    };
    const onEnd = () => {
      if (!buf) return finish({});
      try { finish(JSON.parse(buf)); } catch { fail(new Error('invalid JSON body')); }
    };
    const onError = err => fail(err);
    const onAborted = () => { const e = new Error('请求已中断'); e.code = 'REQUEST_ABORTED'; fail(e); };
    const onClose = () => { if (!req.complete) onAborted(); };
    if (req.aborted || req.destroyed) return onAborted();
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError);
    req.on('aborted', onAborted); req.on('close', onClose);
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

  const studyPlan = loadStudyPlan();
  const configuredExamDate = studyPlanDate(studyPlan);
  // v3.3.6：优先使用用户考试计划；未设置时保留原有考研默认倒计时
  const yr = new Date().getFullYear();
  const hasExamDate = Boolean(configuredExamDate) || studyPlan.examType === 'kaoyan1';
  const examDate = new Date(`${configuredExamDate || `${yr}-12-21`}T00:00:00+08:00`);
  if (!configuredExamDate && hasExamDate && examDate.getTime() < Date.now()) examDate.setFullYear(examDate.getFullYear() + 1);
  const examDateStr = hasExamDate ? (configuredExamDate || `${examDate.getFullYear()}-12-21`) : '';
  const daysLeft = hasExamDate ? Math.round((Date.parse(`${examDateStr}T00:00:00+08:00`) - Date.parse(`${today}T00:00:00+08:00`)) / 86400000) : null;

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
    // v3.3.6：考试计划增强
    kaoyan: hasExamDate ? { daysLeft, examDate: examDateStr, examType: studyPlan.examType, custom: Boolean(configuredExamDate) } : null,
    studyPlan,
    studyTasks: studyTasks(today, studyPlan),
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

/* v3.0.0：白名单——免登录 API（含注册） */
const AUTH_WHITELIST = new Set([
  '/api/auth/login', '/api/auth/status', '/api/auth/register',
  '/api/auth/logout', '/api/error/report',
]);

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  setSecurityHeaders(res);
  if (!sameSiteWriteRequest(req, p)) return sendJSON(res, 403, { error: '跨站写请求已拒绝', code: 'CSRF_ORIGIN' });
  if ((p === '/api/auth/login' || p === '/api/auth/register') && authRateLimited(req)) {
    res.setHeader('Retry-After', String(Math.ceil(AUTH_RATE_WINDOW_MS / 1000)));
    return sendJSON(res, 429, { error: '登录尝试过于频繁，请稍后再试', code: 'AUTH_RATE_LIMIT' });
  }
  /* v3.0.0：建立每请求隔离上下文；写请求按用户串行（避免同一用户并发写互相覆盖） */
  const auth = resolveAuthContext(req);
  const store = Object.assign({ ok: auth.ok }, auth.store);
  const run = () => requestContext.run(store, () => handleRequest(req, res));
  if (p.startsWith('/api/') && MULTIUSER && auth.ok && !AUTH_WHITELIST.has(p) && WRITE_METHODS.has(req.method)) {
    return enqueueUserWrite(auth.store.userId, run).catch(err => {
      if (err.code === 'WRITE_QUEUE_FULL') return sendJSON(res, 429, { error: err.message, code: err.code });
      if (err.code === 'WRITE_TIMEOUT') return sendJSON(res, 504, { error: err.message, code: err.code });
      if (!res.headersSent) return sendJSON(res, 500, { error: err.message, code: err.code });
      try { res.destroy(); } catch {}
    });
  }
  return run();
});

async function handleRequest(req, res) {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  const ctxStore = requestContext.getStore() || {};

  try {
    /* ---- API ---- */
    if (p.startsWith('/api/')) {
      /* v2.8.0/v3.0.0：登录闸门——白名单外的 API 均需已登录（多用户下由会话解析身份） */
      if (!AUTH_WHITELIST.has(p) && ctxStore.ok !== true) {
        return sendJSON(res, 401, { error: MULTIUSER ? '未登录或登录已过期，请重新登录' : '未登录或登录已过期，请输入 Token 凭证', code: 'UNAUTHORIZED' });
      }

      /* v2.8.0：Token 凭证登录 / v3.0.0：多用户账户 */
      if (p === '/api/auth/status' && req.method === 'GET') {
        const me = (ctxStore.ok && ctxStore.userId && ctxStore.userId !== LEGACY_USER && MULTIUSER)
          ? publicUser(userRegistry.users[ctxStore.userId]) : null;
        return sendJSON(res, 200, {
          enabled: !!(config.auth && config.auth.enabled),
          hasToken: !!(config.auth && config.auth.token),
          authed: ctxStore.ok === true,
          multiUser: MULTIUSER,
          me,
        });
      }
      if (p === '/api/auth/login' && req.method === 'POST') {
        const body = await readBody(req);
        // v3.0.0：多用户——用户名 + 密码；兼容旧 Token 登录（username 缺省时按 Token 处理）
        if (MULTIUSER) {
          const username = String(body.username || '').trim();
          const password = String(body.password || body.token || '');
          if (!username) {
            // 兼容：多用户下旧「Token 凭证」入口——与 admin 密码比对
            const admin = userRegistry.users[adminUserId()];
            if (admin && verifyPassword(password, admin)) {
              issueAuthCookie(res, admin.id, admin.role, req);
              return sendJSON(res, 200, { ok: true, user: publicUser(admin) });
            }
            return sendJSON(res, 401, { error: '用户名或密码不正确', code: 'BAD_CREDENTIAL' });
          }
          const user = findUserByName(username);
          if (!user || !verifyPassword(password, user)) {
            return sendJSON(res, 401, { error: '用户名或密码不正确', code: 'BAD_CREDENTIAL' });
          }
          issueAuthCookie(res, user.id, user.role, req);
          return sendJSON(res, 200, { ok: true, user: publicUser(user) });
        }
        // ---- 单用户模式：沿用 Token 凭证 ----
        const token = String(body.token || body.password || '');
        if (!config.auth || !config.auth.enabled) {
          return sendJSON(res, 200, { ok: true, enabled: false, msg: '登录未启用，直接进入' });
        }
        if (!config.auth.token) {
          return sendJSON(res, 400, { error: '服务端尚未设置 Token，请先到「设置 → 登录与安全」配置', code: 'NO_AUTH_TOKEN' });
        }
        if (!safeEqual(token, config.auth.token)) {
          return sendJSON(res, 401, { error: 'Token 凭证不正确', code: 'BAD_CREDENTIAL' });
        }
        issueAuthCookie(res, LEGACY_USER, 'admin', req);
        return sendJSON(res, 200, { ok: true, enabled: true });
      }
      /* v3.0.0：多用户注册——一次性邀请码 */
      if (p === '/api/auth/register' && req.method === 'POST') {
        if (!MULTIUSER) {
          return sendJSON(res, 400, { error: '未开启多用户模式', code: 'NO_MULTIUSER' });
        }
        const body = await readBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const inviteCode = String(body.inviteCode || '').trim();
        if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) {
          return sendJSON(res, 400, { error: '用户名需为 2–20 位中英文字母/数字/下划线', code: 'BAD_USERNAME' });
        }
        if (password.length < 6 || password.length > 128) {
          return sendJSON(res, 400, { error: '密码长度需为 6–128 位', code: 'BAD_PASSWORD' });
        }
        if (findUserByName(username)) {
          return sendJSON(res, 409, { error: '用户名已被占用', code: 'USERNAME_TAKEN' });
        }
        if (userCount() >= 50) {
          return sendJSON(res, 403, { error: '用户数已达上限（50）', code: 'USER_LIMIT' });
        }
        const codeNum = userRegistry.invites.findIndex(inv => inv.code === inviteCode && !inv.usedBy);
        if (codeNum < 0) {
          return sendJSON(res, 401, { error: '邀请码无效或已被使用', code: 'BAD_INVITE' });
        }
        const id = 'u' + userRegistry.nextId++;
        const { salt, hash } = hashPassword(password);
        userRegistry.users[id] = {
          id, username, role: 'user', salt, hash,
          createdAt: new Date().toISOString(), quotas: null,
        };
        userRegistry.invites[codeNum].usedBy = id;
        userRegistry.invites[codeNum].usedAt = new Date().toISOString();
        persistUserRegistry();
        ensureUserDir(id);
        issueAuthCookie(res, id, 'user', req);
        return sendJSON(res, 200, { ok: true, user: publicUser(userRegistry.users[id]) });
      }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        const sid = parseCookies(req)[AUTH_COOKIE];
        if (sid) { authSessions.delete(sid); persistSessions(); }
        clearAuthCookie(res);
        return sendJSON(res, 200, { ok: true });
      }

      /* v3.0.0：多用户管理（仅管理员） */
      if (p === '/api/admin/migrate' && req.method === 'POST') {
        // 单用户 → 多用户一次性迁移；多用户下不可重入
        if (!isAdminCtx(ctxStore) && ctxStore.userId !== LEGACY_USER) {
          return sendJSON(res, 403, { error: '仅管理员可执行迁移', code: 'FORBIDDEN' });
        }
        const body = await readBody(req);
        const r = migrateToMultiUser(body && body.password);
        armAutoSync();   // v3.2.0：迁移后为 admin 装配自动同步定时器
        return sendJSON(res, 200, { ok: true, ...r });
      }
      if (p === '/api/admin/invites' && req.method === 'GET') {
        if (!MULTIUSER || !isAdminCtx(ctxStore)) return sendJSON(res, 403, { error: '仅管理员可查看邀请码', code: 'FORBIDDEN' });
        const list = userRegistry.invites.map(inv => ({
          code: inv.code, createdAt: inv.createdAt, usedBy: inv.usedBy || null, usedAt: inv.usedAt || null,
        }));
        return sendJSON(res, 200, { ok: true, invites: list });
      }
      if (p === '/api/admin/invites' && req.method === 'POST') {
        if (!MULTIUSER || !isAdminCtx(ctxStore)) return sendJSON(res, 403, { error: '仅管理员可生成邀请码', code: 'FORBIDDEN' });
        const body = await readBody(req);
        const count = Math.min(20, Math.max(1, Number(body && body.count) || 1));
        const created = [];
        for (let i = 0; i < count; i++) {
          const inv = { code: crypto.randomBytes(9).toString('base64url'), createdAt: new Date().toISOString(), createdBy: ctxStore.userId };
          userRegistry.invites.push(inv);
          created.push(inv.code);
        }
        persistUserRegistry();
        return sendJSON(res, 200, { ok: true, codes: created });
      }
      if (p === '/api/admin/users' && req.method === 'GET') {
        if (!MULTIUSER || !isAdminCtx(ctxStore)) return sendJSON(res, 403, { error: '仅管理员可查看用户', code: 'FORBIDDEN' });
        const users = Object.values(userRegistry.users).map(publicUser);
        return sendJSON(res, 200, { ok: true, users });
      }
      if (p === '/api/admin/users' && req.method === 'DELETE') {
        if (!MULTIUSER || !isAdminCtx(ctxStore)) return sendJSON(res, 403, { error: '仅管理员可删除用户', code: 'FORBIDDEN' });
        const body = await readBody(req);
        const targetId = String((body && body.id) || '');
        const target = userRegistry.users[targetId];
        if (!target) return sendJSON(res, 404, { error: '用户不存在', code: 'NO_USER' });
        if (target.role === 'admin') return sendJSON(res, 400, { error: '不能删除管理员账户', code: 'CANNOT_DELETE_ADMIN' });
        delete userRegistry.users[targetId];
        persistUserRegistry();
        // 清理该用户会话与目录（数据保留在 users/<id>/ 便于人工恢复）
        for (const [sid, s] of [...authSessions]) { if (s.userId === targetId) authSessions.delete(sid); }
        persistSessions();
        userConfigCache.delete(targetId);
        userDbCache.delete(targetId);
        llmUsageCache.delete(targetId);
        armAutoSync();   // v3.2.0：撤下该用户的自动同步定时器
        return sendJSON(res, 200, { ok: true });
      }

      /* v3.2.0：AI 用量看板——普通用户看自己；管理员可看全员（?scope=all） */
      if (p === '/api/llm/usage' && req.method === 'GET') {
        const wantAll = u.searchParams.get('scope') === 'all';
        if (wantAll && !isAdminCtx(ctxStore)) {
          return sendJSON(res, 403, { error: '仅管理员可查看全员用量', code: 'FORBIDDEN' });
        }
        const days = Math.min(120, Math.max(1, Number(u.searchParams.get('days')) || 14));
        const since = bjDate(-(days - 1));
        const shapeSeries = store => {
          const series = [];
          for (let i = days - 1; i >= 0; i--) {
            const d = bjDate(-i);
            const v = store.days[d] || { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            series.push({ date: d, ...v });
          }
          return series;
        };
        if (!wantAll || !MULTIUSER) {
          const store = wantAll ? loadLlmUsageForUser(adminUserId() || LEGACY_USER) : loadLlmUsage();
          return sendJSON(res, 200, { ok: true, scope: wantAll ? 'all' : 'self', days, series: shapeSeries(store), total: store.total });
        }
        const users = Object.values(userRegistry.users).map(u => {
          const store = loadLlmUsageForUser(u.id);
          const series = shapeSeries(store);
          const win = series.reduce((a, s) => ({
            calls: a.calls + s.calls,
            promptTokens: a.promptTokens + s.promptTokens,
            completionTokens: a.completionTokens + s.completionTokens,
            totalTokens: a.totalTokens + s.totalTokens,
          }), { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
          return { id: u.id, username: u.username, role: u.role, total: store.total, window: win, series };
        });
        const agg = users.reduce((a, x) => ({
          calls: a.calls + x.total.calls,
          promptTokens: a.promptTokens + x.total.promptTokens,
          completionTokens: a.completionTokens + x.total.completionTokens,
          totalTokens: a.totalTokens + x.total.totalTokens,
        }), { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        return sendJSON(res, 200, { ok: true, scope: 'all', days, users, total: agg });
      }

      /* v2.8.0：报错日志采集（前端错误 / API 失败自动上报） */
      if (p === '/api/error/report' && req.method === 'POST') {
        const body = await readBody(req);
        appendErrorLog({
          source: body.source || 'frontend',
          level: body.level || 'error',
          message: body.message,
          stack: body.stack,
          url: body.url,
          method: body.method,
          status: body.status,
          ua: req.headers['user-agent'] || '',
        });
        return sendJSON(res, 200, { ok: true });
      }

      /* v2.8.0：日志版块——开发日志 */
      if (p === '/api/logs/dev' && req.method === 'GET') {
        return sendJSON(res, 200, { ok: true, version: APP_VERSION, dev: DEV_LOG });
      }
      /* v2.8.0：日志版块——使用日志（人工维护：更新方向 / 已知小毛病） */
      if (p === '/api/logs/usage' && req.method === 'GET') {
        const store = loadUsageLog();
        return sendJSON(res, 200, { ok: true, usage: store.usage });
      }
      if (p === '/api/logs/usage' && req.method === 'POST') {
        const body = await readBody(req);
        const store = loadUsageLog();
        // 新增一条使用日志
        if (body.add && typeof body.add === 'object') {
          const entry = {
            id: crypto.randomUUID(),
            ts: new Date().toISOString(),
            kind: String(body.add.kind || 'note').slice(0, 20),     // plan=更新方向 / issue=小毛病 / note=备注
            title: String(body.add.title || '').slice(0, 200),
            content: String(body.add.content || '').slice(0, 4000),
          };
          if (!entry.title && !entry.content) return sendJSON(res, 400, { error: '标题或内容不能为空' });
          store.usage.unshift(entry);
        }
        // 删除一条使用日志
        if (body.remove) {
          store.usage = store.usage.filter(u => u.id !== String(body.remove));
        }
        // 整体覆盖（可选）
        if (Array.isArray(body.usage)) {
          store.usage = body.usage.slice(0, 500).map(u => ({
            id: String(u.id || crypto.randomUUID()),
            ts: String(u.ts || new Date().toISOString()),
            kind: String(u.kind || 'note').slice(0, 20),
            title: String(u.title || '').slice(0, 200),
            content: String(u.content || '').slice(0, 4000),
          }));
        }
        saveUsageLog(store);
        return sendJSON(res, 200, { ok: true, usage: store.usage });
      }
      /* v2.8.0：日志版块——报错日志（自动采集） */
      if (p === '/api/logs/errors' && req.method === 'GET') {
        const store = loadErrorLog();
        return sendJSON(res, 200, { ok: true, total: store.errors.length, errors: store.errors.slice(0, 300) });
      }
      if (p === '/api/logs/errors' && req.method === 'DELETE') {
        saveErrorLog({ schemaVersion: 1, errors: [] });
        return sendJSON(res, 200, { ok: true });
      }

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
          auth: {
            enabled: !!(config.auth && config.auth.enabled),
            hasToken: !!(config.auth && config.auth.token),
          },
          tts: {
            accent: ttsAccent(),
            status: ttsStatus(),
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
          writingOcr: {
            providerId: (config.writingOcr && config.writingOcr.providerId) || '',
            model: (config.writingOcr && config.writingOcr.model) || '',
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
        /* v3.0.0：多用户下，全局配置（服务商/词典/搜索/密钥/登录开关/KB）仅管理员可改；
           普通用户仅能改自己的 per-user 字段（墨墨 Token / 自动同步 / DIY 提示词等） */
        if (MULTIUSER && !isAdminCtx(ctxStore)) {
          const GLOBAL_KEYS = ['llm', 'auth', 'kb', 'dict', 'webSearch', 'mineru', 'imageGen', 'multiUser', 'users', 'tts'];
          const touched = GLOBAL_KEYS.filter(k => body[k] !== undefined);
          if (touched.length) {
            return sendJSON(res, 403, { error: '仅管理员可修改全局配置：' + touched.join(', '), code: 'FORBIDDEN' });
          }
        }
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
              // v2.4.4：Max Tokens 完全解放——取消 128000 封顶，仅防 0/负数；档案不配置时不传钳制
              if (pr.max_tokens !== undefined && pr.max_tokens !== '') out.max_tokens = Math.max(1, Number(pr.max_tokens));
              else if (old?.max_tokens !== undefined) out.max_tokens = old.max_tokens;
              if (pr.models !== undefined) out.models = Array.isArray(pr.models) ? pr.models.slice(0, 100) : old?.models;
              else if (old?.models !== undefined) out.models = old.models;
              // v2.3.4：模型服务高级三项——思考等级 / JSON 参数透传 / 视觉能力
              // v2.4.4：思考强度 7 档白名单（off/minimal/low/medium/high/xhigh/max），旧档案合法值无缝迁移
              if (pr.thinking !== undefined) out.thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(pr.thinking) ? pr.thinking : 'off';
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
        // v2.8.0：Token 凭证登录配置（enabled 开关；token 留空 = 沿用已存，显式空字符串清除）
        if (body.auth && typeof body.auth === 'object') {
          if (!config.auth || typeof config.auth !== 'object') config.auth = { enabled: false, token: '' };
          if (body.auth.enabled !== undefined) config.auth.enabled = !!body.auth.enabled;
          if (typeof body.auth.token === 'string' && body.auth.token.trim()) config.auth.token = body.auth.token.trim();
          // 显式清除 token（clearToken=true 时）
          if (body.auth.clearToken === true) config.auth.token = '';
          // 开启校验但无 token = 自锁风险，拒绝
          if (config.auth.enabled && !config.auth.token) {
            config.auth.enabled = false;
            return sendJSON(res, 400, { error: '开启登录前请先设置 Token 凭证', code: 'NO_AUTH_TOKEN' });
          }
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
        // v2.6.2：手写稿识图专用模型配置持久化
        if (body.writingOcr && typeof body.writingOcr === 'object') {
          if (!config.writingOcr || typeof config.writingOcr !== 'object') config.writingOcr = { providerId: '', model: '' };
          if (body.writingOcr.providerId !== undefined) config.writingOcr.providerId = String(body.writingOcr.providerId || '').trim();
          if (body.writingOcr.model !== undefined) config.writingOcr.model = String(body.writingOcr.model || '').trim();
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
        // v3.5.0：发音朗读默认口音（en_US 美音 / en_GB 英音）
        if (body.tts && typeof body.tts === 'object') {
          if (!config.tts || typeof config.tts !== 'object') config.tts = { accent: 'en_US' };
          if (body.tts.accent === 'en_US' || body.tts.accent === 'en_GB') config.tts.accent = body.tts.accent;
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
          externalCache = { mtime: 0, records: [], thin: false };
          externalSentenceCache = { mtime: 0, rows: [] };
          externalByIdCache = { key: '', map: null };
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
          r = await fetchT(url, { headers: apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {} }, 20000);   // 模型列表：20s
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

      /* ---- v3.3.6：今日任务中心与考试计划 ---- */
      if (p === '/api/study/plan' && req.method === 'GET') {
        const plan = loadStudyPlan();
        return sendJSON(res, 200, { ok: true, plan, today: bjDate(), tasks: studyTasks(bjDate(), plan) });
      }
      if (p === '/api/study/plan' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const plan = cleanStudyPlanInput(body);
          saveStudyPlan(plan);
          return sendJSON(res, 200, { ok: true, plan: loadStudyPlan(), tasks: studyTasks(bjDate(), plan) });
        } catch (e) { return sendJSON(res, e.code === 'STUDY_PLAN_CORRUPT' ? 500 : 400, { error: e.message, code: e.code }); }
      }
      if (p === '/api/study/tasks' && req.method === 'GET') {
        const plan = loadStudyPlan();
        const date = u.searchParams.get('date') || bjDate();
        if (!validStudyDate(date) || date !== bjDate()) return sendJSON(res, 400, { error: '任务仅支持当前北京日期' });
        return sendJSON(res, 200, { ok: true, date, tasks: studyTasks(date, plan), plan });
      }
      if (p === '/api/study/tasks/complete' && req.method === 'POST') {
        const body = await readBody(req);
        const date = String(body.date || bjDate());
        if (!validStudyDate(date) || date !== bjDate()) return sendJSON(res, 400, { error: '任务仅支持当前北京日期' });
        if (body.completed !== undefined && typeof body.completed !== 'boolean') return sendJSON(res, 400, { error: 'completed 必须为布尔值' });
        try { return sendJSON(res, 200, { ok: true, date, tasks: completeStudyTask(String(body.taskId || ''), date, body.completed !== false) }); }
        catch (e) { return sendJSON(res, 400, { error: e.message }); }
      }

      /* ---- v3.3.6：浏览器听说训练（TTS + Web Speech Recognition / 手动输入降级） ---- */
      if (p === '/api/speaking/session' && req.method === 'POST') {
        const body = await readBody(req);
        for (const [key, session] of speechSessions) if (Date.now() - session.createdAt > 15 * 60 * 1000) speechSessions.delete(key);
        const userPrefix = `${ctxStore.userId || LEGACY_USER}:`;
        const mine = [...speechSessions.keys()].filter(key => key.startsWith(userPrefix));
        for (const key of mine.slice(0, Math.max(0, mine.length - 9))) speechSessions.delete(key);
        const mode = body.mode || 'listening';
        if (!['listening', 'speaking'].includes(mode)) return sendJSON(res, 400, { error: 'mode 仅允许 listening/speaking' });
        const word = speechSourceWord();
        const id = crypto.randomBytes(12).toString('hex');
        const sentence = mode === 'speaking' ? speechSourceSentence(word.spelling) : null;
        const target = mode === 'speaking' ? sentence.text : word.spelling;
        speechSessions.set(`${ctxStore.userId || LEGACY_USER}:${id}`, { mode, expected: target, word: word.spelling, gloss: word.gloss, source: sentence?.source || null, createdAt: Date.now() });
        return sendJSON(res, 200, {
          ok: true, sessionId: id, mode, word: mode === 'speaking' ? word.spelling : null,
          prompt: mode === 'listening' ? '点击播放后，听音拼写单词' : '请朗读下面的句子，并检查识别结果',
          target: mode === 'speaking' ? target : null,
          ttsText: target,
          gloss: null,
          source: sentence ? { kind: sentence.source, title: sentence.title, rid: sentence.rid } : null,
        });
      }
      if (p === '/api/speaking/submit' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.sessionId || '');
        const session = speechSessionFor(id, ctxStore.userId || LEGACY_USER);
        if (!session) return sendJSON(res, 400, { error: '训练会话已失效，请重新开始' });
        const answer = String(body.answer || '').trim();
        if (!answer || answer.length > 4000) return sendJSON(res, 400, { error: '请输入 1..4000 字符的答案' });
        const inputMethod = body.inputMethod || 'manual';
        if (!['manual', 'recognition'].includes(inputMethod)) return sendJSON(res, 400, { error: 'inputMethod 非法' });
        const durationMs = body.durationMs === undefined ? null : Number(body.durationMs);
        if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 14400000)) return sendJSON(res, 400, { error: 'durationMs 非法' });
        const expected = session.expected;
        let score = 0;
        if (session.mode === 'listening') {
          const got = normalizeSpeechText(answer);
          const want = normalizeSpeechText(expected);
          const distance = levenshtein(got, want);
          score = got === want ? 1 : (got && want.length >= 5 && distance <= Math.floor(want.length * 0.2) ? 0.75 : 0);
        } else {
          const want = normalizeSpeechText(expected).split(/\s+/).filter(Boolean);
          const got = normalizeSpeechText(answer).split(/\s+/).filter(Boolean);
          // 对词序和重复词计入编辑距离；该分数仅表示文本匹配，不能代替发音评估。
          score = Math.max(0, 1 - speechTokenDistance(want, got) / Math.max(1, want.length, got.length));
        }
        const correct = score >= (session.mode === 'listening' ? 0.75 : 0.7);
        const result = correct ? 'correct' : (score > 0 ? 'vague' : 'incorrect');
        const submittedAt = new Date().toISOString();
        appendLearningAttempts([{
          kind: session.mode, source: 'speech_training', itemId: `speech:${session.word}`,
          section: session.mode, prompt: session.mode === 'speaking' ? expected : '听音拼写', expected,
          answer, result, confidence: null, startedAt: null, submittedAt,
          durationMs: durationMs === null ? null : Math.round(durationMs),
          meta: { mode: session.mode, score, word: session.word, inputMethod, evaluation: 'text_match' },
        }]);
        speechSessions.delete(`${ctxStore.userId || LEGACY_USER}:${id}`);
        return sendJSON(res, 200, { ok: true, correct, result, score, expected, gloss: session.gloss, source: session.source, attemptsSaved: 1 });
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
        // v3.5.1：严格「今日」作答筛选（限 today.date / quizLastAt 为北京时间今天）
        else if (filter === 'today_forget') words = words.filter(w => todayHasResponse(w, todayStr, 'FORGET'));
        else if (filter === 'today_vague') words = words.filter(w => todayHasResponse(w, todayStr, 'VAGUE'));
        else if (filter === 'today_wellfamiliar') words = words.filter(w => todayHasResponse(w, todayStr, 'WELL_FAMILIAR'));
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
      // v2.11.0：若携带 sessionId，则以服务端会话的权威 answer 复核客观题成绩（防篡改），
      //          自评题（flash）沿用客户端 grade；提交后清空会话。
      if (p === '/api/quiz/submit' && req.method === 'POST') {
        const body = await readBody(req);
        let results = Array.isArray(body.results) ? body.results.slice(0, QUIZ_SESSION_MAX_ITEMS) : [];
        const sessionId = String(body.sessionId || '').trim();

        if (sessionId) {
          let sess = null;
          try { sess = loadQuizSession(); } catch (e) {
            if (e.code === 'QUIZ_SESSION_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
            throw e;
          }
          if (sess.sessionId !== sessionId) return sendJSON(res, 409, { error: '会话已失效，请重新组卷' });
          const bySpelling = new Map(sess.items.map(it => [it.spelling, it]));
          const resultsBySpelling = new Map(results.map(r => [String(r.spelling || ''), r]));
          const graded = [];
          for (const it of sess.items) {
            const r = resultsBySpelling.get(it.spelling);
            if (!r) continue;
            const scoreable = (it.kind === 'choice' || it.kind === 'audio' || it.kind === 'zh2en') && it.answer != null;
            let grade = QUIZ_GRADES.has(String(r.grade || '')) ? String(r.grade) : null;
            if (scoreable) {
              const ok = String(r.userAnswer || '').trim().toLowerCase() === String(it.answer).trim().toLowerCase();
              grade = ok ? 'good' : 'again';
              // 服务端权威 expected 覆盖客户端
              r.expected = it.answer;
              r.grade = grade;
            } else if (!grade) {
              continue;   // 自评题缺 grade 视为无效
            }
            graded.push({ ...r, spelling: it.spelling, mode: it.kind, grade });
          }
          if (!graded.length) return sendJSON(res, 400, { error: '没有可入库的作答' });
          const out = applyQuizSrsSession(graded, body.mode);
          try { saveQuizSession({ ...sess, sessionId: null, items: [], idx: 0, results: [] }); } catch { /* 会话清理失败不影响入库 */ }
          return sendJSON(res, 200, { ok: true, engine: 'srs', sessionId, regraded: true, ...out });
        }

        // v2.10.0：若携带 4 档 grade，走 SRS 引擎（自维护调度 + 错题本 + 游戏化）；否则沿用旧三档路径
        const hasGrade = results.some(r => r && QUIZ_GRADES.has(String(r.grade || '')));
        if (hasGrade) {
          const out = applyQuizSrsSession(results, body.mode);
          return sendJSON(res, 200, { ok: true, engine: 'srs', ...out });
        }
        const { applied, attemptsSaved } = applyQuizResults(results, body.mode);
        return sendJSON(res, 200, { ok: true, engine: 'legacy', applied, attemptsSaved });
      }

      /* ---- v2.11.0：自适应组卷 + 交错题型 + 会话韧性 ---- */

      // 自适应组卷：POST { source, count, difficulty, kinds, seed }
      if (p === '/api/quiz/generate' && req.method === 'POST') {
        const body = await readBody(req);
        const source = String(body.source || 'all');
        const allowedSources = ['today', 'sticky', 'vague', 'forget', 'today_forget', 'today_vague', 'due7', 'all', 'srs_due', 'wrongbook'];
        if (!allowedSources.includes(source)) return sendJSON(res, 400, { error: 'source 非法' });
        // v3.2.1：题量解锁——下限 1，不设上限（实际受词源/释义数量约束）
        const rawCount = Number(body.count);
        const count = Number.isFinite(rawCount) ? Math.max(1, Math.floor(rawCount)) : 10;
        const difficulty = ['easy', 'normal', 'hard'].includes(String(body.difficulty)) ? String(body.difficulty) : 'normal';
        const kinds = Array.isArray(body.kinds) ? body.kinds.map(k => String(k)) : [];
        const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : undefined;
        const aiDistractors = body.aiDistractors === true;   // v2.12.0：可选 AI 干扰项增强

        try {
          const candidates = quizCandidates(source);
          if (candidates.length < 1) return sendJSON(res, 200, { ok: false, reason: 'too_few_words', candidates: candidates.length });
          // 先补齐候选词释义（AI 词典缓存；mock 模式即可测）—— v3.2.1：不再封顶，随题量自由膨胀
          const spellings = candidates.map(w => w.spelling).filter(Boolean).slice(0, Math.max(count * 6, 60));
          await ensureGlosses(spellings);
          const items = buildAdaptiveQuiz({ source, count, difficulty, kinds, seed });
          if (items.length < 1) return sendJSON(res, 200, { ok: false, reason: 'too_few_glossed', candidates: candidates.length, glossed: items.length });
          // v2.12.0：可选 AI 干扰项增强（非阻断，失败保留确定性选项）
          let aiEnhanced = 0;
          if (aiDistractors) {
            try {
              await enhanceQuizItemsWithAI(items, 8);
              aiEnhanced = items.filter(x => x.aiEnhanced).length;
            } catch { /* 整体失败不影响组卷 */ }
          }
          const sessionId = crypto.randomBytes(12).toString('hex');
          const sess = {
            ...emptyQuizSession(),
            sessionId,
            mode: 'adaptive',
            source,
            config: { difficulty, kinds: kinds.length ? kinds : QUIZ_DIFFICULTY_KINDS[difficulty], count },
            items,
            sessionStartedAt: new Date().toISOString(),
          };
          saveQuizSession(sess);
          // 下发时对客观题隐去 answer？——保留 answer 供前端即时反馈；服务端提交时另行权威复核。
          return sendJSON(res, 200, { ok: true, sessionId, source, difficulty, items, aiEnhanced, summary: quizSessionSummary(sess) });
        } catch (e) {
          if (e.code === 'QUIZ_SESSION_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      // 读取当前会话（用于跨设备/刷新续做）
      if (p === '/api/quiz/session' && req.method === 'GET') {
        try {
          const sess = loadQuizSession();
          const summary = quizSessionSummary(sess);
          if (!summary || quizSessionExpired(sess) || !sess.items.length) {
            return sendJSON(res, 200, { ok: true, resume: null });
          }
          return sendJSON(res, 200, { ok: true, resume: summary, session: sess });
        } catch (e) {
          if (e.code === 'QUIZ_SESSION_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      // 暂存/更新会话进度（前端逐题调用；也可用于更新 confidence/pause）
      if (p === '/api/quiz/session/save' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const sess = loadQuizSession();
          if (!sess.sessionId) return sendJSON(res, 404, { error: '当前无进行中的会话' });
          if (body.sessionId && String(body.sessionId) !== sess.sessionId) {
            return sendJSON(res, 409, { error: '会话 ID 不匹配' });
          }
          if (Number.isFinite(body.idx) && body.idx >= 0) sess.idx = Math.min(sess.items.length, Math.round(body.idx));
          if (Array.isArray(body.results)) sess.results = body.results.slice(0, QUIZ_SESSION_MAX_ITEMS);
          if (typeof body.confidence === 'string' && VALID_ATTEMPT_CONFIDENCES.has(body.confidence)) sess.confidence = body.confidence;
          if (Number.isFinite(body.pausedMs) && body.pausedMs >= 0) sess.pausedMs = body.pausedMs;
          if (body.pauseStartedAt === null || typeof body.pauseStartedAt === 'string') sess.pauseStartedAt = body.pauseStartedAt;
          saveQuizSession(sess);
          return sendJSON(res, 200, { ok: true, summary: quizSessionSummary(sess) });
        } catch (e) {
          if (e.code === 'QUIZ_SESSION_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      // 清除会话（放弃续做）
      if (p === '/api/quiz/session/clear' && req.method === 'POST') {
        try {
          const sess = loadQuizSession();
          saveQuizSession({ ...sess, sessionId: null, items: [], idx: 0, results: [], sessionStartedAt: null, pausedMs: 0, pauseStartedAt: null });
          return sendJSON(res, 200, { ok: true });
        } catch (e) {
          if (e.code === 'QUIZ_SESSION_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      /* ---- v2.12.0：测验 AI 增强 5 处 + 统计看板 ---- */

      // v3.2.1：词源/复练范围候选计数（供测验页 chip 显示具体数目）
      if (p === '/api/quiz/sources' && req.method === 'GET') {
        try {
          return sendJSON(res, 200, { ok: true, ...quizSourceCounts() });
        } catch (e) {
          if (e.code === 'QUIZ_SRS_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      // 统计看板聚合（掌握度分布 / 正确率趋势 / 错题构成 / 连续天数 / 题型正确率）
      if (p === '/api/quiz/stats' && req.method === 'GET') {
        try {
          const raw = Number(u.searchParams.get('days'));
          const days = [7, 14, 30].includes(raw) ? raw : 14;
          return sendJSON(res, 200, { ok: true, ...quizStatsDashboard(days) });
        } catch (e) {
          if (e.code === 'QUIZ_SRS_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      // ① 智能干扰项（LLM 增强，失败降级本地池）
      if (p === '/api/quiz/ai/distractors' && req.method === 'POST') {
        const body = await readBody(req);
        const spelling = String(body.spelling || '').trim();
        if (!spelling) return sendJSON(res, 400, { error: '缺少 spelling' });
        try { await ensureGlosses([spelling]); } catch { /* 释义缺失仍可用传入 gloss */ }
        const g = vocabGlossOf(spelling);
        const correctGloss = String(body.gloss || (g && g.gloss) || '').trim();
        const correctPos = String(body.pos || (g && g.pos) || '').trim();
        if (!correctGloss) return sendJSON(res, 200, { ok: false, reason: 'no_gloss', options: null });
        try {
          const out = await aiQuizDistractors(spelling, correctGloss, correctPos);
          return sendJSON(res, 200, { ok: true, spelling, correct: correctGloss, ...out });
        } catch (e) {
          if (e.code === 'NO_LLM') return sendJSON(res, 200, { ok: true, options: null, source: 'fallback' });
          throw e;
        }
      }

      // ② 错题讲解（LLM 增强；不可用返回 ok:false，前端不展示）
      if (p === '/api/quiz/ai/explain' && req.method === 'POST') {
        const body = await readBody(req);
        const spelling = String(body.spelling || '').trim();
        if (!spelling) return sendJSON(res, 400, { error: '缺少 spelling' });
        const g = vocabGlossOf(spelling);
        const explain = await aiQuizExplain({
          spelling,
          gloss: String(body.gloss || (g && g.gloss) || '').trim(),
          userAnswer: body.userAnswer != null ? String(body.userAnswer).slice(0, 120) : '',
          correct: !!body.correct,
        });
        if (!explain) return sendJSON(res, 200, { ok: false, reason: llmAvailable() ? 'llm_failed' : 'no_llm', explain: null });
        return sendJSON(res, 200, { ok: true, spelling, explain });
      }

      // ③ 一键助记（LLM 增强；不可用回退确定性释义卡并入库）
      if (p === '/api/quiz/ai/mnemonic' && req.method === 'POST') {
        const body = await readBody(req);
        const spelling = String(body.spelling || '').trim();
        if (!spelling) return sendJSON(res, 400, { error: '缺少 spelling' });
        try { await ensureGlosses([spelling]); } catch { /* 忽略 */ }
        const out = await aiQuizMnemonic(spelling);
        return sendJSON(res, 200, { ok: true, spelling, ...out });
      }

      // ④ 拼写容错判分（规则 + LLM 容错；永不阻断）
      if (p === '/api/quiz/ai/spell-grade' && req.method === 'POST') {
        const body = await readBody(req);
        const spelling = String(body.spelling || '').trim();
        const answer = String(body.answer || '').trim();
        if (!spelling) return sendJSON(res, 400, { error: '缺少 spelling' });
        const out = await aiGradeSpelling(spelling, answer);
        return sendJSON(res, 200, { ok: true, spelling, answer, ...out });
      }

      // ⑤ 真实例句（外刊 + 真题，本地语料，确定性）
      if (p === '/api/quiz/ai/examples' && req.method === 'GET') {
        const spelling = String(u.searchParams.get('spelling') || '').trim();
        if (!spelling) return sendJSON(res, 400, { error: '缺少 spelling' });
        return sendJSON(res, 200, { ok: true, spelling, examples: quizRealExamples(spelling, 3) });
      }

      /* ---- v2.10.0：测验记忆引擎（SRS + 错题本 + 游戏化） ---- */

      // 记忆状态概览 + 到期词表
      if (p === '/api/quiz/srs' && req.method === 'GET') {
        try {
          const filter = u.searchParams.get('filter') || 'all';
          if (!['srs_due', 'wrongbook', 'all'].includes(filter)) {
            return sendJSON(res, 400, { error: 'filter 仅允许 srs_due/wrongbook/all' });
          }
          const store = loadQuizSrs();
          const due = collectSrsDue(filter).slice(0, QUIZ_SESSION_MAX_ITEMS);   // v3.2.1：随题量解锁放宽
          const overview = srsOverview();
          // 附带掌握度明细（供前端展示 0–4 分布与每词状态）
          const words = {};
          for (const d of due) {
            const raw = store.words[d.spelling];
            const wb = (store.wrongBook || []).find(x => x.spelling === d.spelling);
            words[d.spelling] = {
              mastery: raw ? normalizeSrsWord(raw).mastery : 0,
              ease: raw ? normalizeSrsWord(raw).ease : null,
              intervalDays: raw ? normalizeSrsWord(raw).intervalDays : 0,
              dueAt: d.dueAt,
              source: d.source,
              wrongStage: wb ? wb.stage : null,
              wrongCount: wb ? wb.wrongCount : 0,
            };
          }
          return sendJSON(res, 200, { ok: true, filter, due, words, overview });
        } catch (e) {
          if (e.code === 'QUIZ_SRS_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      // 错题本列表
      if (p === '/api/quiz/wrongbook' && req.method === 'GET') {
        try {
          const store = loadQuizSrs();
          const includeResolved = u.searchParams.get('resolved') === '1';
          let list = store.wrongBook || [];
          if (!includeResolved) list = list.filter(x => !x.resolved);
          list = list.slice().sort((a, b) => {
            const ta = isoMs(a.nextDueAt || a.lastWrongAt);
            const tb = isoMs(b.nextDueAt || b.lastWrongAt);
            return ta - tb;
          }).slice(0, 500);
          return sendJSON(res, 200, { ok: true, total: list.length, items: list });
        } catch (e) {
          if (e.code === 'QUIZ_SRS_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      // 手动将错题标记为已掌握（移出复练队列）
      if (p === '/api/quiz/wrongbook/resolve' && req.method === 'POST') {
        const body = await readBody(req);
        const spelling = String(body.spelling || '').trim();
        if (!spelling) return sendJSON(res, 400, { error: '缺少 spelling' });
        try {
          const store = loadQuizSrs();
          const idx = wrongBookIndex(store, spelling);
          if (idx < 0) return sendJSON(res, 404, { error: '该词不在错题本中' });
          store.wrongBook[idx].resolved = true;
          store.wrongBook[idx].resolvedAt = new Date().toISOString();
          store.wrongBook[idx].nextDueAt = null;
          saveQuizSrs(store);
          return sendJSON(res, 200, { ok: true, spelling });
        } catch (e) {
          if (e.code === 'QUIZ_SRS_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      // 手动移除错题本条目
      if (p === '/api/quiz/wrongbook/remove' && req.method === 'POST') {
        const body = await readBody(req);
        const spelling = String(body.spelling || '').trim();
        if (!spelling) return sendJSON(res, 400, { error: '缺少 spelling' });
        try {
          const store = loadQuizSrs();
          const before = (store.wrongBook || []).length;
          store.wrongBook = (store.wrongBook || []).filter(x => x.spelling !== spelling);
          if (store.wrongBook.length === before) return sendJSON(res, 404, { error: '该词不在错题本中' });
          saveQuizSrs(store);
          return sendJSON(res, 200, { ok: true, spelling });
        } catch (e) {
          if (e.code === 'QUIZ_SRS_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
      }

      // 游戏化开关/目标（默认关闭，设置页可开）
      if (p === '/api/quiz/gamification' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const store = loadQuizSrs();
          const g = store.gamification;
          if (body.enabled !== undefined) g.enabled = !!body.enabled;
          if (body.dailyGoal !== undefined) {
            const dg = Number(body.dailyGoal);
            if (!Number.isFinite(dg) || dg < 0 || dg > 1000) return sendJSON(res, 400, { error: 'dailyGoal 需为 0..1000' });
            g.dailyGoal = Math.round(dg);
          }
          if (body.reset === true) { g.xp = 0; g.combo = 0; g.bestCombo = 0; g.streak = 0; g.lastActiveDate = ''; }
          saveQuizSrs(store);
          return sendJSON(res, 200, { ok: true, gamification: g });
        } catch (e) {
          if (e.code === 'QUIZ_SRS_CORRUPT') return sendJSON(res, 500, { error: e.message, code: e.code });
          throw e;
        }
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
                const src = [h.trackLabel || (h.track ? examTrackMeta(h.track).label : '考研真题'), h.title, h.year ? h.year + ' 年' : '', KB_SECTION_LABEL[h.section] || h.section || '', h.number ? '第 ' + h.number + ' 题' : '']
                  .filter(Boolean).join(' · ');
                const external = h.sourceKind === 'external';
                const externalSrc = [h.publication, h.year ? h.year + ' 年' : '', h.sourceUrl].filter(Boolean).join(' · ');
                return `- ${h.s}\n  （来源：${external ? (externalSrc || src || '外刊发布源') : (src || '考研真题')}）`;
            };
            if (evidence.exams.length) {
              msgs[0].content += '\n\n【真题原句】\n' + evidence.exams.map(formatHit).join('\n') +
                '\n讲解时优先引用以上真题并注明来源与考试类别，尤其关注对应考试的义项和考法。';
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

      /* v3.5.0：发音朗读——服务端合成音频（单词真人音 / 句子神经语音）。
         GET /api/tts?text=...&accent=en_US|en_GB 返回音频流；?meta=1 只返回状态不合成。 */
      if (p === '/api/tts' && req.method === 'GET') {
        if (u.searchParams.get('meta') === '1') {
          return sendJSON(res, 200, { ok: true, status: ttsStatus() });
        }
        const accent = u.searchParams.get('accent') || '';
        let out;
        try {
          out = await ttsSynthesize(u.searchParams.get('text') || '', accent);
        } catch (err) {
          if (err.code === 'TTS_UNAVAILABLE') {
            return sendJSON(res, 503, { error: '服务端语音暂不可用，请使用浏览器朗读', code: 'TTS_UNAVAILABLE' });
          }
          throw err;
        }
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, {
          'Content-Type': out.mime,
          'Content-Length': String(fs.statSync(out.file).size),
          'Cache-Control': 'public, max-age=86400',
          'X-TTS-Engine': out.engine,
        });
        return fs.createReadStream(out.file).pipe(res);
      }

      // 服务端语音能力状态（只读）：是否已装 Piper、各语音模型是否就绪
      if (p === '/api/tts/status' && req.method === 'GET') {
        return sendJSON(res, 200, { ok: true, status: ttsStatus() });
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
          // v2.9.0：瘦索引只存元数据，命中外刊后在返回前按需补全文
          const record = r.external ? externalEnsureText(r) : r;
          return sendJSON(res, 200, {
            ok: true,
            record: { ...record, rtypeLabel: RTYPE_LABEL[record.rtype] || record.rtype, items: u.searchParams.get('raw') === '1' ? (record.items || []) : kbOrderedItems(record) },
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
        if (!requireAdmin(res, ctxStore, '导入共享语料/真题')) return;
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
          track: body.track,
        });
        return sendJSON(res, 200, { ok: true, mineru: true, store: targetStore, ...r });
      }

      // MinerU 连通性测试（401=Token 失效；400=参数错但 Token 有效，均视为可达）
      if (p === '/api/test/mineru' && req.method === 'POST') {
        if (config.mineru.mock) return sendJSON(res, 200, { ok: true, msg: 'mock 模式：MinerU 链路可用（未调云端）' });
        if (!config.mineru.apiKey) {
          return sendJSON(res, 400, { error: '未配置 MinerU Token，请到「设置」页填写（mineru.net/apiManage/token 免费申请）', code: 'NO_MINERU' });
        }
        const tr = await fetchT(MINERU_BASE + '/file-urls/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.mineru.apiKey },
          body: JSON.stringify({ files: [] }),
        }, 20000);   // MinerU 连通性测试：20s
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
        if (!requireAdmin(res, ctxStore, '编辑共享语料')) return;
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
        if (!requireAdmin(res, ctxStore, '恢复共享语料历史版本')) return;
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

      // v2.6.2：废弃移除高幻觉率的 AI 审读相关接口
      if ((p === '/api/kb/review' || p === '/api/kb/review/apply' || p === '/api/kb/review/item') && req.method === 'POST') {
        return sendJSON(res, 410, { error: 'AI 审读功能已在 v2.6.2 中废弃移除' });
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
          // v2.4.4：删除 _noThinking——思考强度全权交给用户在设置页滑块调节；Max Tokens 已解放不再截断
          llmOverride: {
            _jsonMode: true,
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
      // v2.4.3：支持 groups 多分组——一次生成多篇文章（每组一篇，顺序生成，逐篇落库）
      if (p === '/api/story/generate' && req.method === 'POST') {
        const body = await readBody(req);
        const words = [...new Set((Array.isArray(body.words) ? body.words : [])
          .map(w => String(w || '').trim().toLowerCase())
          .filter(w => /^[a-z][a-z''\-]{0,39}$/.test(w)))];
        if (words.length < 1) return sendJSON(res, 400, { error: '请至少选择 1 个单词' });
        if (words.length > 600) return sendJSON(res, 400, { error: '单次生成单词量建议不超过 600 词（分 3 组每组 200），请适当精简' });
        // v2.4.3：多分组解析——groups 为 [{name, theme, words, suggestedPlot}]，1~6 组；无 groups 时退化为单篇（全词池）
        const groupsIn = (Array.isArray(body.groups) ? body.groups : [])
          .map(g => ({
            name: String(g?.name || '').slice(0, 40),
            theme: String(g?.theme || '').slice(0, 30),
            words: [...new Set((Array.isArray(g?.words) ? g.words : []).map(w => String(w || '').trim().toLowerCase()).filter(w => /^[a-z][a-z''\-]{0,39}$/.test(w)))].slice(0, 200),
            plot: String(g?.suggestedPlot || '').slice(0, 200),
          }))
          .filter(g => g.words.length >= 1)
          .slice(0, 6);
        const totalWords0 = words.length;
        if (groupsIn.length >= 2) {
          // v2.4.3.b：分组模式下每组 ≤200（组内截断保护）；总词数不设上限——
          // 允许一个词出现在多个分组（多故事强化记忆），篇数由分组数决定（≤6）
          for (const g of groupsIn) {
            if (g.words.length > 200) g.words = g.words.slice(0, 200);
          }
        } else if (totalWords0 > 200) {
          // v2.4.3.a：单篇超 200 词自动拆组（每 200 词一篇），不再直接拒绝——选词不限量的自然延伸
          for (let i = 0; i * 200 < words.length; i++) {
            groupsIn.push({ name: `第 ${i + 1} 篇`, theme: '', words: words.slice(i * 200, (i + 1) * 200), plot: '' });
          }
        }
        const useGroups = groupsIn.length >= 2;
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
        const stories = [];
        const genOne = async (gWords, gTheme, gName, gPlot, gLenKey, gLenLabel) => {
          const lens = Object.fromEntries(gWords.map(w => [w, db.glosses[w] || null]));
          // v2.4.0：真题/外刊真实语境注入，引导模型优先用考研高频义项
          let evidenceNote = '';
          try {
            const lines = [];
            for (const w of gWords.slice(0, 30)) {
              const ev = kbEvidenceForWord(w);
              const ex = ev.exams[0] || ev.external[0] || ev.corpus[0];
              if (ex?.s) lines.push(`- ${w}: ${String(ex.s).slice(0, 120)}`);
            }
            if (lines.length) evidenceNote = '\n\n【真实语境参考】以下是部分单词在考研真题/外刊中的原句，优先按这些义项与用法编写：\n' + lines.join('\n');
          } catch { /* 语料库不可用不阻塞 */ }
          const msgs = [
            { role: 'system', content: getPrompt('story_gen') },
            { role: 'user', content: [
              `【目标单词】（共 ${gWords.length} 个）：${gWords.join(', ')}`,
              lens && gWords.some(w => lens[w]) ? `【词典参考】\n` + gWords.filter(w => lens[w]).slice(0, 50).map(w => `- ${w}: ${lens[w].pos || ''} ${lens[w].gloss || ''}`).join('\n') : '',
              `【题材】：${gTheme}`,
              `【篇幅建议与要求】：${gLenLabel || lengths[gLenKey]?.label || '自适应'}（${customGuide}）`,
              gName ? `【本篇分组】：${gName}` : '',
              gPlot ? `【情节建议】：${gPlot}` : '',
              body.userInstruction ? `【AI分析与分类建议提示】：${String(body.userInstruction).slice(0, 300)}` : '',
              evidenceNote,
              '【再次提醒】你的回复必须整体是一个 JSON 对象（第一个字符 { 最后一个字符 }），英文正文放在 passage 字段里，不要在 JSON 之外输出任何文字。',
            ].filter(Boolean).join('\n\n') },
          ];
          const reply = await llmChat(msgs, {
            maxTokens: 4000,
            // v2.4.1：词文成章可单独指定服务商与覆盖模型（留空沿用默认服务商）
            // v2.4.4：删除 _noThinking——思考强度全权交给用户在设置页滑块调节；Max Tokens 已解放不再截断
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
                  + '{"title":"英文标题(12词内)","hooks":[{"word":"单词(必须逐一核对确在文中出现,用原形)","phonetic":"美式音标,不确定给空串","pos":"词性缩写","meaning":"考研核心义项,15字内","hook":"一句中文记忆钩子,谐音/联想/词根,25字内"}],"translation":"全文通顺中文翻译","quiz":[按篇幅6~12道选择题{"q":"题干","options":["A","B","C","D"],"answer":1到4,"explain":"40字内"}]}'
                  + '。hooks 必须覆盖给定的每个目标词；quiz 用文中原句挖空目标词并穿插词义题。除 JSON 外禁止输出任何文字。' },
                { role: 'user', content: `【目标词】${gWords.join(', ')}\n\n【英文短文】\n${parsed.passage.slice(0, 4500)}` },
              ];
              const metaReply = await llmChat(metaMsgs, { maxTokens: 3000, llmOverride: { _jsonMode: true } });
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
          if (hooks.length < gWords.length) {
            const have = new Set(hooks.map(h => h.word.toLowerCase()));
            for (const w of gWords) {
              if (have.has(w)) continue;
              const g = db.glosses[w] || null;
              hooks.push({ word: w, phonetic: (g && g.phonetic) || '', pos: (g && g.pos) || '', meaning: (g && g.gloss) || '', hook: g && g.gloss ? `释义卡：${g.gloss}` : '（本次未生成钩子，点「换一篇」重新生成可恢复）' });
            }
          }
          let quiz = (Array.isArray(parsed.quiz) ? parsed.quiz : [])
            .map(q => ({ q: String(q.q || '').slice(0, 300), options: (Array.isArray(q.options) ? q.options : []).map(o => String(o || '').slice(0, 120)).slice(0, 4), answer: Math.min(4, Math.max(1, Number(q.answer) || 1)), explain: String(q.explain || '').slice(0, 120) }))
            .filter(q => q.q && q.options.length === 4).slice(0, 12);   // v2.4.3：自测不限 5 题，按篇幅 5~12 题自适应
          // 自测缺题：确定性生成「词义四选一」（从词池+释义缓存出题，不依赖模型），目标至少 4 题
          if (quiz.length < 4 && gWords.length >= 3) {
            const pool = gWords.map(w => ({ w, g: db.glosses[w] || null }));
            const distractors = pool.filter(x => x.g && x.g.gloss).map(x => x.g.gloss);
            for (const { w, g } of pool) {
              if (quiz.length >= 4) break;
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
            title: String(parsed.title || `${gTheme}物语 · ${gWords.slice(0, 3).join(' · ')}`).slice(0, 120),
            words: gWords,
            theme: gTheme,
            length: gLenKey,
            passage: String(parsed.passage || '').slice(0, 6000),
            hooks,
            translation: String(parsed.translation || ''),
            quiz,
            done: false,   // v2.4.3：完成态——自测全部作答后置 true（绿色已完成/黄色待做）
            createdAt: new Date().toISOString(),
          };
          if (!story.passage) throw Object.assign(new Error('AI 输出缺少正文（passage 为空）'), { code: 'STORY_EMPTY' });
          db.stories.unshift(story);
          return story;
        };
        try {
          if (useGroups) {
            // v2.4.3：多分组逐篇生成（顺序执行防并发压垮上游；逐篇落库，中途失败保留已完成篇并报进度）
            for (let gi = 0; gi < groupsIn.length; gi++) {
              const g = groupsIn[gi];
              const gTheme = g.theme || theme;
              const gLenKey = lengthKey;
              try {
                const s = await genOne(g.words, gTheme, g.name, g.plot, gLenKey, body.lengthLabel || lengths[gLenKey]?.label);
                stories.push(s);
              } catch (e) {
                if (stories.length) {
                  // 已有部分成功：如实返回进度与失败原因
                  persistDB();
                  return sendJSON(res, 207, { ok: true, partial: true, stories, failed: { group: g.name || `第 ${gi + 1} 组`, error: e.message } });
                }
                throw e;
              }
            }
          } else {
            stories.push(await genOne(words, theme, '', '', lengthKey, body.lengthLabel || lengths[lengthKey]?.label));
          }
        } finally {
          if (db.stories.length > 200) db.stories.length = 200;   // 上限 200 篇，FIFO 裁剪
          persistDB();
        }
        return sendJSON(res, 200, { ok: true, stories, story: stories[0] });   // story 字段保持旧前端兼容
      }
      if (p === '/api/story/list' && req.method === 'GET') {
        const list = (db.stories || []).map(s => ({ id: s.id, title: s.title, words: s.words, theme: s.theme, length: s.length, done: !!s.done, quizCount: (s.quiz || []).length, createdAt: s.createdAt }));
        return sendJSON(res, 200, { ok: true, list });
      }
      {
        const m = p.match(/^\/api\/story\/([a-f0-9-]+)$/);
        if (m && req.method === 'GET') {
          const s = (db.stories || []).find(x => x.id === m[1]);
          if (!s) return sendJSON(res, 404, { error: '文章不存在' });
          return sendJSON(res, 200, { ok: true, story: s });
        }
        // v2.4.3：自测完成态上报——前端自测全部作答后调用，置 done=true（绿色已完成）
        const mDone = p.match(/^\/api\/story\/([a-f0-9-]+)\/done$/);
        if (mDone && req.method === 'POST') {
          const s = (db.stories || []).find(x => x.id === mDone[1]);
          if (!s) return sendJSON(res, 404, { error: '文章不存在' });
          if (!s.done) {
            s.done = true;
            s.doneAt = new Date().toISOString();
            persistDB();
          }
          return sendJSON(res, 200, { ok: true, done: true });
        }
        if (m && req.method === 'DELETE') {
          const before = (db.stories || []).length;
          db.stories = db.stories.filter(x => x.id !== m[1]);
          if (db.stories.length === before) return sendJSON(res, 404, { error: '文章不存在' });
          persistDB();
          return sendJSON(res, 200, { ok: true });
        }
      }

      /* ---------- v2.5.0：写作升格（自由写作单轨，题源不碰真题库） ---------- */

      // v2.6.2：手写稿拍照识别与转写（考研标准横线纸抗扰 + 防脑补精准转写）
      if (p === '/api/writing/transcribe' && req.method === 'POST') {
        const body = await readBody(req);
        const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : '';
        if (!image) return sendJSON(res, 400, { error: '请先提供手写稿照片' });
        if (image.length > 5000000) return sendJSON(res, 400, { error: '图片过大，请压缩后再试（≤3.5MB）' });

        // 服务商分派：配置专属 writingOcr > 默认服务商
        let targetProvId = (config.writingOcr && config.writingOcr.providerId) || undefined;
        let modelOverride = (config.writingOcr && config.writingOcr.model) ? config.writingOcr.model : undefined;
        const activeProv = targetProvId ? (config.llm.providers || []).find(x => x.id === targetProvId) : getProvider();

        if (!config.llm.mock && (!activeProv || !activeProv.vision)) {
          return sendJSON(res, 400, { error: '所选服务商未开启「视觉能力」，请到设置页选择支持 Vision 的模型档案' });
        }

        const systemPrompt = `You are a professional, high-precision English handwriting transcriber specifically calibrated for the Chinese Graduate Entrance Exam (考研英语) standard ruled answer sheet (考研横线纸).

CRITICAL TRANSCRIPTION RULES:
1. Ignore background printed horizontal ruling lines (考研印刷横线) completely. Do NOT treat them as hyphens, underlines, or minus signs. Focus strictly on the handwritten ink.
2. Transcribe exactly what is handwritten with 100% fidelity. DO NOT correct spelling mistakes, punctuation quirks, grammatical errors, or capitalization. If the student misspells "accompany" as "acommpany", you MUST output "acommpany".
3. Preserve original paragraph indentations and paragraph breaks.
4. If a word or stroke is genuinely illegible or ambiguous due to ink smear or blur, wrap it in bracket markers: [?word] or [?].
5. Output format: Output ONLY the transcribed English plain text. Strictly NO explanations, NO greetings, NO markdown fence blocks, NO translation.`;

        const msgs = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Please transcribe this handwritten essay from the ruled answer sheet with exact fidelity:' },
            { type: 'image_url', image_url: { url: image } }
          ] }
        ];

        try {
          const reply = await llmChat(msgs, {
            providerId: targetProvId,
            llmOverride: modelOverride ? { model: modelOverride } : undefined,
            maxTokens: 2500,
          });
          const text = stripThinkBlocks(reply).trim();
          const wordsCount = text.split(/\s+/).filter(Boolean).length;
          const uncertainCount = (text.match(/\[\?[^\]]*\]/g) || []).length;
          return sendJSON(res, 200, { ok: true, text, wordsCount, uncertainCount });
        } catch (e) {
          return sendJSON(res, 500, { error: '手写识图失败：' + (e.message || '未知错误') });
        }
      }

      // 审题/识图（含防幻觉：AI 先自报看到什么，用户再确认/纠偏）
      if (p === '/api/writing/inspect' && req.method === 'POST') {
        const body = await readBody(req);
        const promptText = String(body.prompt || '').trim().slice(0, 4000);
        const part = body.part === 'B' ? 'B' : 'A';
        const imageNote = String(body.imageNote || '').trim().slice(0, 800);
        if (!promptText) return sendJSON(res, 400, { error: '请先填写题目要求（题干/Directions）' });
        const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : '';
        if (image && image.length > 2100000) return sendJSON(res, 400, { error: '图片过大，请压缩后再试（≤1.5MB）' });
        const prov = getProvider();
        if (image && !(config.llm.mock || (prov && prov.vision))) {
          return sendJSON(res, 400, { error: '当前默认服务商未开启「视觉能力」，请到设置页编辑服务商勾选视觉能力，或直接用文字描述图画' });
        }
        const userText = [
          `【作文类型】Part ${part}${part === 'B' ? ' 大作文（20 分，图画/图表类）' : ' 小作文（10 分，书信/告示类）'}`,
          `【题目要求】\n${promptText}`,
          image ? '【附图】见 image 图片内容块（漫画原图，请严格按防幻觉铁律描述）' : '【附图】无',
          imageNote ? `【用户纠偏提示】${imageNote}` : '',
        ].filter(Boolean).join('\n\n');
        const msgs = [
          { role: 'system', content: WRITING_INSPECT_SYSTEM },
          { role: 'user', content: image ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: image } }] : userText },
        ];
        const reply = await llmChat(msgs, { maxTokens: 3000 });
        return sendJSON(res, 200, { ok: true, inspection: stripThinkBlocks(reply) });
      }

      // 批改升格（SSE 流式：thinking / content / done / error 四事件）
      if (p === '/api/writing/elevate' && req.method === 'POST') {
        const body = await readBody(req);
        const promptText = String(body.prompt || '').trim().slice(0, 4000);
        const essay = String(body.essay || '').trim().slice(0, 6000);
        const part = body.part === 'B' ? 'B' : 'A';
        const imageHint = String(body.imageHint || '').trim().slice(0, 1200);
        if (!promptText) { sendJSON(res, 400, { error: '题目要求不能为空' }); return; }
        if (!essay) { sendJSON(res, 400, { error: '作文正文为空，请先写作再提交' }); return; }

        // SSE 头：X-Accel-Buffering:no 防 nginx 缓冲吃掉流式；15s 心跳防空闲掐断
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        let finished = false;
        // v2.5.0.a：sseSend 不带 finished 闸（finishUp/failUp 先置位再发事件，若 sseSend 也检查会自我拦截 done）
        const sseSend = obj => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { } };
        const finishUp = (payload) => { if (!finished) { finished = true; sseSend({ type: 'done', ...payload }); try { res.end(); } catch { } } };
        const failUp = (msg) => { if (!finished) { finished = true; sseSend({ type: 'error', error: msg }); try { res.end(); } catch { } } };
        const hb = setInterval(() => { if (!finished) { try { res.write(': ping\n\n'); } catch { } } }, 15000);

        const wordsCount = essay.split(/\s+/).filter(Boolean).length;
        const msgs = [
          { role: 'system', content: WRITING_ELEVATE_SYSTEM },
          { role: 'user', content: [
            `【作文类型】Part ${part}${part === 'B' ? ' 大作文（满分 20 分，建议 160~200 词）' : ' 小作文（满分 10 分，建议 100~120 词）'}`,
            `【题目要求】\n${promptText}`,
            part === 'B' && imageHint ? `【图画理解（用户确认信息，以此为准）】${imageHint}` : '',
            `【考生字数】约 ${wordsCount} 词（与建议档差距明显时须在点评中提示）`,
            `【考生作文】\n${essay}`,
          ].filter(Boolean).join('\n\n') },
        ];

        try {
          const r = await llmChatSSE(msgs, {
            onThinking: t => sseSend({ type: 'thinking', delta: t }),
            onContent: t => sseSend({ type: 'content', delta: t }),
          });
          const report = stripThinkBlocks(r.content);
          if (!report.trim()) {
            failUp(`AI 未输出批改正文（finish_reason=${r.finishReason || 'unknown'}），请调整 Max Tokens/思考强度后重试`);
          } else {
            const rec = {
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              part, prompt: promptText, imageHint,
              essay, words: wordsCount,
              report,
              score: parseWritingScore(report),
            };
            const list = loadEssays();
            list.unshift(rec);
            essaysCache.set(currentCtx().userId, list);
            saveEssays();
            finishUp({ id: rec.id, score: rec.score, words: rec.words, createdAt: rec.createdAt });
          }
        } catch (e) {
          failUp(`AI 批改失败：${e.message}`);
        } finally {
          clearInterval(hb);
          if (!finished) { finished = true; try { res.end(); } catch { } }
        }
        return;
      }

      // 历史（列表最多 50 条元数据 / 详情 / 删除）
      if (p === '/api/writing/history' && req.method === 'GET') {
        const list = loadEssays().slice(0, 50).map(e => ({ id: e.id, createdAt: e.createdAt, part: e.part, words: e.words, score: e.score, prompt: String(e.prompt || '').slice(0, 120) }));
        return sendJSON(res, 200, { ok: true, list });
      }
      {
        const wm = p.match(/^\/api\/writing\/([a-f0-9-]+)$/);
        if (wm && req.method === 'GET') {
          const e = loadEssays().find(x => x.id === wm[1]);
          if (!e) return sendJSON(res, 404, { error: '习作不存在' });
          return sendJSON(res, 200, { ok: true, essay: e });
        }
        if (wm && req.method === 'DELETE') {
          const before = loadEssays().length;
          const next = loadEssays().filter(x => x.id !== wm[1]);
          if (next.length === before) return sendJSON(res, 404, { error: '习作不存在' });
          essaysCache.set(currentCtx().userId, next);
          saveEssays();
          return sendJSON(res, 200, { ok: true });
        }
      }

      // 金句入库（复用助记库存储，noteType=写作金句，不自动推送墨墨）
      if (p === '/api/writing/note' && req.method === 'POST') {
        const body = await readBody(req);
        const content = String(body.content || '').trim().slice(0, 500);
        if (!content) return sendJSON(res, 400, { error: '金句内容为空' });
        const spelling = (String(body.spelling || '').trim() || '写作金句').slice(0, 80);
        const note = {
          id: crypto.randomUUID(),
          spelling,
          noteType: '写作金句',
          content,
          createdAt: new Date().toISOString(),
          source: '写作升格',
          synced: false,
        };
        db.notes.unshift(note);
        persistDB();
        return sendJSON(res, 201, { ok: true, note });
      }

      // 记录删除（解析原件仍保留在 archive/，可重导恢复；删除写日志）
      if (p === '/api/kb/record/delete' && req.method === 'POST') {
        if (!requireAdmin(res, ctxStore, '删除共享语料')) return;
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

      // v2.6.2：废弃移除高幻觉率的 AI 审读与单条复核相关接口
      if ((p === '/api/kb/review' || p === '/api/kb/review/apply' || p === '/api/kb/review/item') && req.method === 'POST') {
        return sendJSON(res, 410, { error: 'AI 审读功能已在 v2.6.2 中废弃移除' });
      }

      /* ---------------- v1.1.5：单元题库 API ---------------- */

      // 单元列表（整卷切片自动派生：导入成功即出现，无需手动推送；v2.7.0 支持 track 过滤）
      if (p === '/api/unit/records' && req.method === 'GET') {
        const trackFilter = u.searchParams.get('track');
        const answers = loadAnswers();
        const all = buildUnits();
        const tracks = {};
        for (const k of Object.keys(EXAM_TRACKS)) tracks[k] = 0;
        for (const x of all) tracks[x.track || DEFAULT_EXAM_TRACK]++;
        const units = all
          .filter(x => !trackFilter || (x.track || DEFAULT_EXAM_TRACK) === normalizeTrack(trackFilter))
          .map(u => ({ ...u, hasAnswer: !!(answers[u.unitId] && Object.keys(answers[u.unitId]).length) }));
        return sendJSON(res, 200, {
          ok: true, units, file: examsFile(),
          track: trackFilter ? normalizeTrack(trackFilter) : null,
          tracks, trackMeta: EXAM_TRACKS,
        });
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
        if (!requireAdmin(res, ctxStore, '保存单元标准答案')) return;
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
        if (!requireAdmin(res, ctxStore, '导入共享语料')) return;
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
        if (!requireAdmin(res, ctxStore, '导入共享真题')) return;
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
          results.push(await kbImportOne({ name: it.name, buf, category: '真题', store: 'exam', track: body.track }));
        }
        if (!results.length) return sendJSON(res, 400, { error: '没有可导入的文件（选择 tex / pdf）', code: 'KB_IMPORT' });
        return sendJSON(res, 200, {
          ok: true, results,
          imported: results.filter(r => r.ok).length,
          quarantined: results.filter(r => !r.ok).length,
        });
      }

      // v1.1.2：真题库列表（「考试-题型」板块统计；v2.7.0 支持 track 过滤与分轨统计）
      if (p === '/api/exam/records' && req.method === 'GET') {
        const trackFilter = u.searchParams.get('track');
        const all = loadExams();
        const tracks = {};
        for (const k of Object.keys(EXAM_TRACKS)) tracks[k] = 0;
        for (const r of all) tracks[trackOf(r)]++;
        const records = all
          .filter(r => !trackFilter || trackOf(r) === normalizeTrack(trackFilter))
          .map(examSummary);
        return sendJSON(res, 200, {
          ok: true,
          file: examsFile(),
          exists: fs.existsSync(examsFile()),
          track: trackFilter ? normalizeTrack(trackFilter) : null,
          tracks,
          trackMeta: EXAM_TRACKS,
          records,
        });
      }

      // v2.7.0：真题详情（渲染排序后的 items + 板块统计）
      {
        const m = p.match(/^\/api\/exam\/record\/([A-Za-z0-9_-]+)$/);
        if (m && req.method === 'GET') {
          const r = loadExams().find(x => x.id === m[1]);
          if (!r) return sendJSON(res, 404, { error: '记录不存在' });
          const track = trackOf(r);
          return sendJSON(res, 200, {
            ok: true,
            record: {
              ...r, track, trackLabel: examTrackMeta(track).label,
              rtypeLabel: RTYPE_LABEL[r.rtype] || r.rtype,
              items: u.searchParams.get('raw') === '1' ? (r.items || []) : kbOrderedItems(r),
              sections: examSummary(r).sections,
            },
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
        if (!['sticky', 'vague', 'forget', 'today_forget', 'today_vague', 'due7'].includes(filter)) {
          return sendJSON(res, 400, { error: 'filter 参数仅允许 sticky/vague/forget/today_forget/today_vague/due7' });
        }
        // v3.2.1：题量解锁——下限 1，不设上限（实际受候选题约束）
        let count = parseInt(body.count, 10);
        if (isNaN(count)) count = 5;
        count = Math.max(1, count);
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

      /* ---- v1.2.0：数据备份与恢复（v3.1.0：多用户下备份为全站数据，仅管理员） ---- */

      if (p === '/api/backup/create' && req.method === 'POST') {
        if (!isAdminCtx(ctxStore)) return sendJSON(res, 403, { error: '仅管理员可创建备份', code: 'FORBIDDEN' });
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
        // 备份核心数据文件（v3.0.0：多用户按 users/<id>/ 分层）
        const filesToBackup = backupFileSpecs();
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
            if (f.quizSrs && !isQuizSrsShape(v.obj)) {
              warnings.push({ file: f.name, reason: '测验记忆结构不符，已跳过' });
              continue;
            }
            if (f.quizSession && !isQuizSessionShape(v.obj)) {
              warnings.push({ file: f.name, reason: '测验会话结构不符，已跳过' });
              continue;
            }
          }
          const dst = path.join(bDir, f.name);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(f.src, dst);
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
        if (!isAdminCtx(ctxStore)) return sendJSON(res, 403, { error: '仅管理员可查看备份', code: 'FORBIDDEN' });
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
        if (!isAdminCtx(ctxStore)) return sendJSON(res, 403, { error: '仅管理员可恢复备份', code: 'FORBIDDEN' });
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name || !/^backup-/.test(name)) return sendJSON(res, 400, { error: '无效的备份名称' });
        const bDir = path.join(DATA_DIR, 'backups', name);
        if (!fs.existsSync(bDir)) return sendJSON(res, 404, { error: '备份不存在: ' + name });

        // v2.2.6：恢复前逐文件校验（JSON 合法性 + 学习流水 schema），损坏则跳过并告警，绝不静默覆盖
        const restoreMap = restoreFileSpecs();
        const warnings = [];
        const skipped = [];
        let restored = 0;

        for (const f of restoreMap) {
          const src = path.join(bDir, f.name);
          if (!fs.existsSync(src)) {
            // 备份不含该文件：保留当前数据，不创建空文件覆盖（学习流水/测验记忆尤其如此）
            if (f.learning) skipped.push({ file: f.name, reason: '备份不含该文件，已保留当前学习流水' });
            if (f.quizSrs) skipped.push({ file: f.name, reason: '备份不含该文件，已保留当前测验记忆' });
            if (f.quizSession) skipped.push({ file: f.name, reason: '备份不含该文件，已保留当前测验会话' });
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
            if (f.quizSrs && !isQuizSrsShape(v.obj)) {
              warnings.push({ file: f.name, reason: 'schemaVersion/words 结构不符，已跳过' });
              continue;
            }
            if (f.quizSession && !isQuizSessionShape(v.obj)) {
              warnings.push({ file: f.name, reason: 'schemaVersion/items 结构不符，已跳过' });
              continue;
            }
          }
          try {
            fs.mkdirSync(path.dirname(f.dst), { recursive: true });
            fs.copyFileSync(src, f.dst);
            restored++;
          } catch (e) {
            warnings.push({ file: f.name, reason: '写入失败: ' + String(e.message || e).slice(0, 120) });
          }
        }

        // 重新加载内存数据（v3.0.0：清空用户缓存后按需重读；学习流水每次实时读文件）
        reloadConfigFromDisk();
        userConfigCache.clear();
        userDbCache.clear();
        legacyDb = null;
        essaysCache.clear();
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
      const baseDir = currentImagesDir();
      let requested;
      try { requested = decodeURIComponent(p.slice('/images/'.length)); } catch { res.writeHead(400); return res.end('Bad Request'); }
      const imgPath = path.resolve(baseDir, requested);
      if (!isWithinDir(baseDir, imgPath) || !fs.existsSync(imgPath)) { res.writeHead(404); return res.end('Not Found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(imgPath).toLowerCase()] || 'application/octet-stream' });
      return fs.createReadStream(imgPath).pipe(res);
    }
    let filePath;
    try {
      // URL pathname always starts with `/`; strip it before path.resolve so
      // Windows does not reinterpret `/style.css` as the drive root `D:\`.
      const publicName = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
      filePath = path.resolve(PUBLIC_DIR, publicName);
    }
    catch { res.writeHead(400); return res.end('Bad Request'); }
    if (!isWithinDir(PUBLIC_DIR, filePath)) { res.writeHead(403); return res.end(); }
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
      const code = ['NO_TOKEN', 'NO_LLM', 'NO_IMG', 'NO_SEARCH', 'NO_DICT', 'BAD_WORD', 'BAD_TTS_TEXT', 'KB_IMPORT', 'NO_MINERU', 'BAD_CREDENTIAL'].includes(err.code) ? 400 : 500;
      // v2.8.0：服务端 500 异常自动落入报错日志（前端错误由前端上报）
      if (code === 500) {
        appendErrorLog({ source: 'server', level: 'error', message: err.message, stack: err.stack, url: p, method: req.method, status: 500 });
      }
      return sendJSON(res, code, { error: err.message, code: err.code });
    }
    res.writeHead(500); res.end('Server Error');
  }
}

ensureDataDir();
ensureTtsDirs();   // v3.5.0：发音朗读缓存目录
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
    const files = backupFileSpecs();
    for (const f of files) {
      if (!fs.existsSync(f.src)) continue;
      // v2.2.6：损坏文件跳过，避免自动备份把坏数据固化
      if (f.json) {
        const v = validateJsonFile(f.src);
        if (!v.valid) { console.error(`  [自动备份] 跳过损坏文件 ${f.name}: ${v.error}`); continue; }
        if (f.learning && !isLearningStoreShape(v.obj)) { console.error(`  [自动备份] 跳过结构不符的 ${f.name}`); continue; }
        if (f.quizSrs && !isQuizSrsShape(v.obj)) { console.error(`  [自动备份] 跳过结构不符的 ${f.name}`); continue; }
        if (f.quizSession && !isQuizSessionShape(v.obj)) { console.error(`  [自动备份] 跳过结构不符的 ${f.name}`); continue; }
      }
      const dst = path.join(bDir, f.name);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(f.src, dst);
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
