#!/usr/bin/env node
/**
 * v3.8.0：真题解析批量生成器（离线跑批，产物入库 corpus/exam_analysis/）
 *
 * 设计要点
 *  - 「解析单元」粒度：阅读=一篇文章+其题目；完形/选词/新题型/匹配=整个板块；
 *    翻译=整个板块；写作=整个板块；听力=整场听力（缺音频，只做选项语言特征分析）。
 *  - 断点续跑：每个单元一个 JSON 文件，已存在且 schema 校验通过即跳过；
 *    `--force` 覆盖重生成，`--only=<unitId>` 只跑指定单元。
 *  - 答案一致性硬校验：模型返回的 answer 必须与题库权威答案一致，不一致即视为失败重试。
 *  - 原文忠实度校验：locate / en / longSentences.en 必须是原文子串（宽松归一化）。
 *  - 失败自动重试（指数退避），最终失败记录到 failures.json 供人工复核。
 *
 * 用法
 *   node scripts/exam-analysis-build.mjs [--concurrency=8] [--provider=deepseek]
 *        [--track=kaoyan1|cet6] [--section=reading,...] [--only=<id>] [--force] [--dry-run]
 *        [--limit=N] [--no-listen]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const OUT_DIR = join(ROOT, 'corpus', 'exam_analysis');
const EXAMS = join(ROOT, 'corpus', 'exams.jsonl');
const CONFIG = join(ROOT, 'data', 'config.json');

/* ---------------- CLI ---------------- */
const argv = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};
const hasFlag = name => argv.some(a => a === `--${name}` || a.startsWith(`--${name}=`));

const CONCURRENCY = Math.max(1, Number(argOf('concurrency', 4)) || 4);
const PROVIDER_NAME = String(argOf('provider', process.env.EXAM_ANALYSIS_PROVIDER || 'deepseek'));
const TRACK_FILTER = argOf('track') ? String(argOf('track')).split(',').filter(Boolean) : null;
const SECTION_FILTER = argOf('section') ? String(argOf('section')).split(',').filter(Boolean) : null;
const ONLY = argOf('only') ? String(argOf('only')).split(',').filter(Boolean) : null;
const FORCE = hasFlag('force');
const DRY_RUN = hasFlag('dry-run');
const LIMIT = Number(argOf('limit', 0)) || 0;
const SKIP_LISTEN = hasFlag('no-listen');
/* v3.8.0：写作单元超时兜底——考研写作板块含 2 篇作文 + 范文，输出极长，
   部分网关（Cloudflare 100s）会 524。--split-writing 时把写作按题拆成独立单元
   生成，跑完后由 --merge-writing 合并回 __writing__all，前端契约不变。 */
const SPLIT_WRITING = hasFlag('split-writing');
const MERGE_WRITING = hasFlag('merge-writing');
/* v3.8.0：阅读单元题量兜底——个别单元一篇文章挂 10 道题（如六级 2017-12 第 1 套
   的 Text 1 合并了 46–55），输出量超出网关 100s 上限会持续 524。
   --split-reading[=N] 时按 N 题（默认 5）把题目切成子单元分别生成，
   再由 --merge-reading 合并回单个 __reading__<pid>，前端契约不变。 */
const SPLIT_READING = (() => {
  const hit = argv.find(a => a === '--split-reading' || a.startsWith('--split-reading='));
  if (!hit) return 0;
  const eq = hit.indexOf('=');
  const n = eq < 0 ? 5 : Number(hit.slice(eq + 1));
  return Math.max(1, n || 5);
})();
const MERGE_READING = hasFlag('merge-reading');
/* v3.8.0：--revalidate 只按当前校验规则重算 warnings（不调 LLM）。
   校验规则演进后（如引号归一化放宽、幻觉检测排除否定语境），
   历史单元的 warnings 会变成误报；此模式把它们刷新为与代码一致的结论。 */
const REVALIDATE = hasFlag('revalidate');
const MAX_ATTEMPTS = Math.max(1, Number(argOf('attempts', 6)) || 6);
const MAX_TOKENS = Math.max(4000, Number(argOf('max-tokens', 32000)) || 32000);
const TIMEOUT_MS = Math.max(60000, Number(argOf('timeout', 420000)) || 420000);

/* ---------------- 工具 ---------------- */
const log = (...a) => console.log(...a);
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 归一化：去空白、去 〖N〗 标记、统一各类引号/破折号/省略号，便于子串校验。
 *  v3.8.0 修订：模型常把原文的英文双引号写成单引号（"vision" → 'vision'），
 *  也常把 – — 混用、把括号内的中文注（如 nostalgia(怀旧)）省掉；
 *  这些都属「引用同一句」而非改写，故先把引号/破折号/省略号统一再比对。 */
function normText(s) {
  return String(s || '')
    .replace(/〖\/?\d+〗/g, '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026{1,}/g, '...')
    .replace(/\.{2,}/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 归一化后再做「引号无关」比对：把所有引号直接删掉，避免 ' 与 " 混用造成误判 */
function normQuoteFree(s) {
  return normText(s).replace(/["']/g, '');
}

/** 宽松包含：整体子串，或前半段子串（模型可能只截取部分），或 60% 词序列连续命中。
 *  比对前先把引号删掉（模型常在 ' 与 " 之间混用），并对省略号拼接做分段命中。 */
function containsLoose(source, fragment) {
  const S = normQuoteFree(source);
  const F = normQuoteFree(fragment);
  if (!F || F.length < 8) return false;
  if (S.includes(F)) return true;
  const head = F.slice(0, Math.min(F.length, Math.max(24, Math.floor(F.length * 0.6))));
  if (S.includes(head)) return true;
  // 省略号拼接（"句A ... 句B"）：任一段落在原文即视为引用成立
  const segments = String(fragment || '').split(/\s*(?:\.{2,}|\u2026)\s*/).map(x => normQuoteFree(x)).filter(x => x.length >= 12);
  if (segments.length > 1 && segments.every(seg => S.includes(seg.slice(0, Math.min(seg.length, 40))))) return true;
  const words = F.split(' ').filter(Boolean);
  if (words.length >= 6) {
    const win = words.slice(0, Math.min(12, words.length)).join(' ');
    if (S.includes(win)) return true;
  }
  return false;
}

function stripFences(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < t.length - 1)) {
    if (first >= 0 && last > first) t = t.slice(first, last + 1);
  }
  return t;
}

/**
 * v3.8.0：修复「字符串值里出现未转义 ASCII 双引号」的常见畸形 JSON。
 *
 * 典型场景（Claude 系模型高频）：
 *   "cn": "近年来中国航天进入创新发展"快车道",太空基础设施建设稳步推进。"
 *   "why": "D选项"hiding them from the locals"是对原文的同义改写。"
 * 中文讲解里夹带英文/中文双引号却没转义，导致整包解析失败。
 *
 * 判别规则（关键洞察）：真正的字符串收尾引号后面必然是
 *   `:`（不可能，值后不会紧跟冒号）/ `,`+下一个 key 或元素 / `}` / `]` / 结束。
 * 而内容引号（如 `"快车道"` 的后引号）后面虽然也可能是 `,`，
 * 但**逗号之后跟的是正文而不是新的 key/元素**。
 * 所以对 `,` 情形再加一步前瞻：`,` 之后（跳过空白）必须是 `"`（下一个键或元素）、
 * `{`、`[`、`}`、`]` 或结束，才算真正收尾；否则判为内容引号并转义。
 *
 * 兜底：若按此规则仍无法严格解析，退回「逐个候选回溯转义」，
 * 最后再交给 salvageJson 做截断抢救。
 */
function repairUnescapedQuotes(text) {
  const s = String(text || '');
  try { JSON.parse(s); return s; } catch { /* 需要修复 */ }

  const skipWs = (i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };

  /** 判断位置 i（字符串内部的 "）是否应视为字符串收尾 */
  const isRealClose = (i) => {
    let j = skipWs(i + 1);
    if (j >= s.length) return true;                 // 文本结束
    const c = s[j];
    if (c === '}' || c === ']') return true;
    if (c === ':') return true;
    if (c === ',') {
      let k = skipWs(j + 1);
      if (k >= s.length) return true;
      const d = s[k];
      return d === '"' || d === '{' || d === '[' || d === '}' || d === ']';
    }
    return false;
  };

  let out = '';
  let inString = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') {
      if (isRealClose(i)) { inString = false; out += ch; }
      else { out += '\\"'; }
      continue;
    }
    out += ch;
  }
  try { JSON.parse(out); return out; } catch { /* 继续兜底 */ }

  // 兜底：逐个候选回溯转义（从内容引号最少的切分开始试）
  const candidates = [];
  inString = false; escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inString) { if (ch === '"') inString = true; continue; }
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') candidates.push(i);
  }
  const escapeSet = (positions) => {
    const set = new Set(positions);
    let buf = '';
    for (let i = 0; i < s.length; i++) buf += set.has(i) ? '\\"' : s[i];
    return buf;
  };
  const MAX_TRIES = Math.min(candidates.length, 400);
  for (let k = 1; k <= MAX_TRIES; k++) {
    const cand = escapeSet(candidates.slice(0, k));
    try { JSON.parse(cand); return cand; } catch { /* 下一个 k */ }
  }
  return s;
}

/** 从尽可能多的角度解析模型输出（严格 → 去围栏 → 引号修复 → 截断抢救） */
function parseLoose(text) {
  const raw = String(text || '');
  const candidates = [];
  const stripped = stripFences(raw);
  candidates.push(stripped);
  candidates.push(repairUnescapedQuotes(stripped));
  // 去围栏后再截一次（有的模型会在 JSON 前后加说明文字）
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = stripped.slice(firstBrace, lastBrace + 1);
    candidates.push(sliced);
    candidates.push(repairUnescapedQuotes(sliced));
  }
  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 下一个候选 */ }
  }
  return null;
}

/** 从被截断的 JSON 中尽量抢救（补齐未闭合的引号/括号） */
function salvageJson(text) {
  const repaired = repairUnescapedQuotes(stripFences(text));
  try { return JSON.parse(repaired); } catch { /* 继续抢救 */ }
  let s = repaired;
  for (let cut = 0; cut < 3; cut++) {
    let cand = s;
    const lastComma = cand.lastIndexOf(',');
    if (lastComma > 0) cand = cand.slice(0, lastComma);
    const opens = [];
    for (const ch of cand) {
      if (ch === '{' || ch === '[') opens.push(ch);
      else if (ch === '}' || ch === ']') opens.pop();
    }
    cand += opens.slice().reverse().map(o => (o === '{' ? '}' : ']')).join('');
    try { return JSON.parse(cand); } catch { s = cand.slice(0, lastComma > 0 ? lastComma : cand.length); }
  }
  return null;
}

/* ---------------- 题库与单元划分 ---------------- */
const clean = s => String(s || '').replace(/〖\/?\d+〗/g, '').trim();
const passageTextWithMarks = s => String(s || '').trim();

function loadExams() {
  const raw = readFileSync(EXAMS, 'utf8');
  return raw.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
}

/** 单元 ID：<examId>__<section>__<sub> */
function buildUnits(rec) {
  const units = [];
  const bySection = new Map();
  for (const it of rec.items || []) {
    const sec = it.section || 'misc';
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(it);
  }
  for (const [section, items] of bySection) {
    const questions = items.filter(i => i.type === 'question' && i.number != null);
    const writings = items.filter(i => i.type === 'writing');
    const passages = items.filter(i => i.type === 'passage');

    if (section === 'listening') {
      // 听力：整场一个单元（缺音频/原文，只做选项语言特征 + 通用技巧，按场分析才成体系）
      if (!questions.length && !passages.length) continue;
      units.push({
        id: `${rec.id}__${section}__all`,
        examId: rec.id, track: rec.track || 'kaoyan1', section, sub: 'all',
        title: rec.title, year: rec.meta?.year ?? null,
        passage: null, questions, writings: [], pool: null, passages,
      });
      continue;
    }

    if (section === 'reading') {
      const pids = [];
      for (const p of passages) { const k = p.passage_id ?? 1; if (!pids.includes(k)) pids.push(k); }
      const orphans = questions.filter(q => q.passage_id == null);
      if (!pids.length && orphans.length) pids.push(1);
      for (const pid of pids) {
        const p = passages.find(x => (x.passage_id ?? 1) === pid) || null;
        const qs = questions.filter(q => (q.passage_id ?? 1) === pid);
        if (!qs.length && !p) continue;
        // v3.8.0：题量过大时按 --split-reading=N 切分（子单元 id 带 __cN 后缀）
        if (SPLIT_READING > 0 && qs.length > SPLIT_READING) {
          let chunk = 0;
          for (let i = 0; i < qs.length; i += SPLIT_READING) {
            chunk++;
            const part = qs.slice(i, i + SPLIT_READING);
            units.push({
              id: `${rec.id}__${section}__${pid}c${chunk}`,
              examId: rec.id, track: rec.track || 'kaoyan1', section, sub: `${pid}c${chunk}`,
              splitOf: pid,
              title: rec.title, year: rec.meta?.year ?? null,
              passage: p, questions: part, writings: [], pool: null, passages,
            });
          }
          continue;
        }
        units.push({
          id: `${rec.id}__${section}__${pid}`,
          examId: rec.id, track: rec.track || 'kaoyan1', section, sub: String(pid),
          title: rec.title, year: rec.meta?.year ?? null,
          passage: p, questions: qs, writings: [], pool: null, passages,
        });
      }
      continue;
    }

    const pool = items.find(i => i.type === 'question' && i.number == null && i.options) || null;
    if (section === 'writing' && SPLIT_WRITING) {
      // 拆题：每道写作题一个单元（id 后缀 __all#N），避免一次性输出超网关上限
      for (const w of writings) {
        const n = w.number ?? (w.part === 'A' ? 51 : 52);
        units.push({
          id: `${rec.id}__${section}__${n}`,
          examId: rec.id, track: rec.track || 'kaoyan1', section, sub: String(n),
          title: rec.title, year: rec.meta?.year ?? null,
          passage: null, questions: [], writings: [w], pool: null, passages,
        });
      }
      continue;
    }
    units.push({
      id: `${rec.id}__${section}__all`,
      examId: rec.id, track: rec.track || 'kaoyan1', section, sub: 'all',
      title: rec.title, year: rec.meta?.year ?? null,
      passage: passages[0] || null, questions, writings, pool, passages,
    });
  }
  return units.filter(u => (u.questions.length || u.writings.length || u.passage));
}

/* ---------------- 提示词 ---------------- */
const SYSTEM = '你是考研英语与英语六级教学领域资深专家，长期从事真题命题研究与逐题精讲，擅长拆解正确项推理链、逐项剖析干扰项设计、以及长难句结构分析。你只输出合法 JSON，不输出任何多余文字。';

const JSON_RULES = '严格只输出一个 JSON 对象：不要 markdown 代码块、不要前后解释文字、不要注释、不要尾随逗号。所有讲解用中文；英文只出现在原文摘录、译文对照与单词上。';

function promptReading(u, trackLabel) {
  const qLines = u.questions.map(q => `第 ${q.number} 题：${clean(q.text)}\nA. ${q.options?.A ?? ''}\nB. ${q.options?.B ?? ''}\nC. ${q.options?.C ?? ''}\nD. ${q.options?.D ?? ''}\n正确答案：${q.answer}`).join('\n\n');
  return `请为下面这篇${trackLabel}阅读理解做「做完题后的参考解析」。

【文章原文】
${passageTextWithMarks(u.passage?.text)}

【题目与正确答案】
${qLines}

【输出结构】
{
  "topic": "一句话点明文章主题（中文，20 字内）",
  "gist": "文章主旨概括（中文，60-120 字）",
  "structure": ["段落/层次作用，每条 15-30 字，3-5 条"],
  "difficulty": "较易|中等|较难",
  "translation": "全文参考译文（中文，忠实原文、通顺，段落之间用 \\n\\n 分隔）",
  "questions": [
    {
      "number": ${u.questions[0].number},
      "answer": "${u.questions[0].answer}",
      "type": "细节题|推断题|词义句意题|态度题|主旨题|例证题|指代题",
      "locate": "原文定位（英文原句摘录，20-60 词，必须是原文原句）",
      "why": "为什么该选项正确：结合原文逻辑讲清推理链（中文，60-140 字）",
      "traps": "其余选项错在哪：逐个点明 A/B/C 的错误类型与陷阱（中文，60-140 字）",
      "tip": "一句话做题启示（中文，20-40 字）"
    }
  ],
  "vocab": [{"w": "原文生词", "cn": "中文释义（含词性）"}],
  "longSentences": [{"en": "原文长难句（必须是原文原句，可截取不可改写）", "cn": "中文翻译", "note": "结构拆解（中文，30-60 字）"}]
}

【硬性要求】
- questions 必须覆盖全部 ${u.questions.length} 道题，顺序与题号一致，answer 必须与给定正确答案完全一致。
- vocab 给 8-12 个本篇真正有难度的词（考研核心词优先），不要给 the/of/and 这类。
- longSentences 给 2-3 个最值得拆解的长难句，en 必须是原文原句。
- ${JSON_RULES}`;
}

function promptCloze(u, trackLabel, kindLabel) {
  const qLines = u.questions.map(q => {
    const opts = ['A', 'B', 'C', 'D'].filter(k => q.options && q.options[k] != null)
      .map(k => `${k}) ${q.options[k]}`).join('  ');
    return `${q.number}. ${opts}   → 答案 ${q.answer}（${q.options?.[q.answer] ?? ''}）`;
  }).join('\n');
  const extra = kindLabel === '选词填空'
    ? `{
  "topic": "文章主题（中文，20 字内）",
  "gist": "文章主旨（中文，60-120 字）",
  "difficulty": "较易|中等|较难",
  "translation": "全文参考译文（中文，空格处按正确答案填入后翻译，段落之间用 \\n\\n）",
  "questions": [
    {"number": 26, "answer": "O", "correct": "正确答案对应的英文词", "why": "为什么选它：词性/搭配/上下文逻辑哪条决定（中文 50-100 字）", "traps": "其他被排除的候选词为什么不行（中文 50-100 字）", "tip": "一句话考点提示（中文 20-40 字）"}
  ],
  "vocab": [{"w": "候选词池中的核心生词", "cn": "中文释义（含词性）"}],
  "skills": ["选词填空解题步骤，3-5 条，每条 20-40 字"]
}`
    : `{
  "topic": "文章主题（中文，20 字内）",
  "gist": "文章主旨（中文，60-120 字）",
  "difficulty": "较易|中等|较难",
  "translation": "全文参考译文（中文，空格处按正确答案填词翻译，段落之间用 \\n\\n）",
  "questions": [
    {"number": 1, "answer": "D", "correct": "正确答案对应的英文词", "why": "为什么选它：语法/搭配/上下文逻辑三条中哪条决定（中文 50-100 字）", "traps": "三个错误项各自为什么不行（中文 50-100 字）", "tip": "一句话考点提示（中文 20-40 字）"}
  ],
  "vocab": [{"w": "原文生词", "cn": "中文释义（含词性）"}],
  "logicWords": [{"w": "原文中的逻辑连接词", "role": "它在本篇中起到的逻辑作用（中文 15-30 字）"}]
}`;
  return `请为下面这篇${trackLabel}「${kindLabel}」做做完后的参考解析。

【文章（〖N〗 标记空格位置）】
${passageTextWithMarks(u.passage?.text)}

【题目与正确答案（共 ${u.questions.length} 题）】
${qLines}

【输出结构】
${extra}

【硬性要求】
- questions 必须覆盖全部 ${u.questions.length} 题，answer 必须与给定答案完全一致。
- correct 必须是该答案对应的英文词（与选项文本一致）。
- vocab 8-12 个核心词；${kindLabel === '选词填空' ? 'skills 3-5 条' : 'logicWords 3-6 个'}。
- ${JSON_RULES}`;
}

function promptPartB(u, trackLabel) {
  const qLines = u.questions.map(q => `${q.number}. → 答案 ${q.answer}`).join('\n');
  const poolLines = u.pool ? Object.entries(u.pool.options).map(([k, v]) => `${k}) ${clean(v)}`).join('\n') : '';
  const isSort = /→/.test(String(u.passage?.text || ''));
  return `请为下面这道${trackLabel}「新题型（Part B）」做参考解析。

【文章/选项材料】
${passageTextWithMarks(u.passage?.text)}
${poolLines ? `\n【选项池】\n${poolLines}` : ''}

【题目与答案（共 ${u.questions.length} 题）】
${qLines}

【输出结构】
{
  "topic": "文章主题（中文，20 字内）",
  "type": "本卷新题型的具体题型（${isSort ? '如段落排序题，请核实后填写' : '如七选五/小标题匹配，请核实后填写'}）",
  "strategy": ["做本题型的方法步骤，3-5 条，每条 20-40 字"],
  "questions": [
    {"number": ${u.questions[0].number}, "answer": "${u.questions[0].answer}", "why": "为什么选该段/该标题：抓衔接词、指代关系、重复关键词（中文 60-120 字）", "traps": "其他候选为什么不行（中文 40-90 字）", "tip": "定位线索一句话（中文 20-40 字）"}
  ],
  "vocab": [{"w": "原文生词", "cn": "中文释义（含词性）"}]
}

【硬性要求】
- questions 必须覆盖全部 ${u.questions.length} 题，answer 必须与给定答案完全一致。
- 讲解必须基于给出的材料，不得编造不存在的内容。
- ${JSON_RULES}`;
}

function promptTranslationKaoyan(u, trackLabel) {
  const qLines = u.questions.map(q => `${q.number}. ${clean(q.text)}`).join('\n\n');
  return `请为下面这篇文章的${trackLabel}「英译汉（划线句翻译）」做参考解析。

【全文】
${passageTextWithMarks(u.passage?.text)}

【划线句（共 ${u.questions.length} 句，每句 2 分）】
${qLines}

【输出结构】
{
  "topic": "全文主题（中文，20 字内）",
  "translation": "全文参考译文（中文，段落之间用 \\n\\n）",
  "questions": [
    {
      "number": ${u.questions[0].number},
      "en": "原句（必须逐字照抄上方划线句）",
      "cn": "参考译文",
      "structure": "句子主干与修饰成分拆解（中文 60-120 字）",
      "points": ["得分点 1（如：定语从句的处理）", "得分点 2", "得分点 3"],
      "pitfall": "最容易译错的地方（中文 40-80 字）"
    }
  ],
  "vocab": [{"w": "原文生词", "cn": "中文释义（含词性）"}],
  "skills": ["本篇翻译技巧要点，3-5 条，每条 20-40 字"]
}

【硬性要求】
- questions 必须覆盖全部 ${u.questions.length} 句，en 必须逐字照抄原句（不得改写、不得省略）。
- 每句 points 给 2-3 个采分点。
- ${JSON_RULES}`;
}

function promptTranslationCet6(u, trackLabel) {
  return `请为下面这道${trackLabel}「汉译英（段落翻译，15 分）」做参考解析。

【中文原文】
${passageTextWithMarks(u.passage?.text)}

【输出结构】
{
  "topic": "原文主题（中文，20 字内）",
  "reference": "参考英文译文（完整段落，地道英文）",
  "sentences": [
    {"cn": "中文原句", "en": "对应英文译文", "structure": "句型结构（如：with 复合结构/定语从句，中文 30-60 字）", "keys": ["采分点关键词（如：青藏高原 the Qinghai-Tibet Plateau）"]}
  ],
  "keys": [{"cn": "中文术语", "en": "标准英文译法"}],
  "pitfalls": ["常见失分点，3-5 条，每条 20-40 字"],
  "upgrades": [{"plain": "普通表达", "better": "升级表达", "note": "为什么更好（中文 20-40 字）"}]
}

【硬性要求】
- sentences 按原文顺序逐句给出，必须覆盖原文所有句子，cn 必须逐字对应原文分句。
- keys 给 6-10 个专有名词/术语的标准英文译法。
- upgrades 3-5 组。
- ${JSON_RULES}`;
}

function promptWriting(u, trackLabel) {
  const wLines = u.writings.map(w => `【第 ${w.number} 题 · Part ${w.part || 'A'} · ${w.score ?? '?'} 分】
${clean(w.text)}`).join('\n\n');
  const wordHint = u.writings.map(w => {
    const m = clean(w.text).match(/(?:at least|no less than|no more than|about)?\s*(\d{2,3})\s*(?:-|~|—|to)?\s*(\d{2,3})?\s*words?/i);
    return `第 ${w.number} 题词数要求：${m ? m[0].trim() : '按题目原文要求'}`;
  }).join('；');
  return `请为下面这套${trackLabel}「写作」题做参考解析。

${wLines}

【输出结构】
{
  "units": [
    {
      "number": ${u.writings[0]?.number ?? 51},
      "part": "${u.writings[0]?.part || 'A'}",
      "task": "题型与要求概括（中文 30-60 字）",
      "outline": ["第一段该写什么（中文）", "第二段该写什么（中文）", "第三段该写什么（中文）"],
      "sample": "参考范文（英文，词数严格符合题目要求）",
      "phrases": [{"en": "高分短语/句型", "cn": "中文释义与用法"}],
      "pitfalls": ["常见失分点，3-5 条，每条 15-35 字"],
      "upgrades": [{"plain": "普通写法", "better": "升级写法", "note": "为什么更好（中文 20-40 字）"}]
    }
  ],
  "band9": ["本篇最值得背的句子，3-5 条（英文 + 中文注释放在同一字符串里）"]
}

【硬性要求】
- units 必须覆盖全部 ${u.writings.length} 道写作题。
- sample 必须严格符合题目词数要求（${wordHint}）。
- 每道题 phrases 6-10 个、upgrades 3-5 组。
- 范文不得套用与题目无关的万能模板，必须贴合题干。
- ${JSON_RULES}`;
}

function promptListening(u, trackLabel) {
  const segs = [];
  const pids = [];
  for (const p of u.passages) { const k = p.passage_id ?? 1; if (!pids.includes(k)) pids.push(k); }
  for (const pid of pids) {
    const qs = u.questions.filter(q => (q.passage_id ?? 1) === pid);
    if (!qs.length) continue;
    segs.push(`第 ${pid} 段（题号 ${qs.map(q => q.number).join('/')}）：` + qs.map(q =>
      `\n  ${q.number}. A) ${q.options?.A ?? ''} | B) ${q.options?.B ?? ''} | C) ${q.options?.C ?? ''} | D) ${q.options?.D ?? ''} → ${q.answer}`
    ).join(''));
  }
  return `请为下面这场${trackLabel}「听力理解」做参考解析。

【重要前提】题库中**没有收录本场听力的录音音频，也没有听力原文文稿**，只有题目选项与正确答案。
因此：绝对不要编造录音里的对话或短文内容，不要假装知道录音说了什么，不要写"录音中提到……"这类句子。
只做两件事：① 基于选项文本的语言特征做分析；② 给出通用且可执行的听力应试技巧。

【听力分段与题目选项（共 ${u.questions.length} 题，答案已给出）】
${segs.join('\n')}

【输出结构】
{
  "notice": "一句话说明本题库未收录听力音频与原文，本页为选项语言特征分析（中文 40-70 字）",
  "overview": "本场听力题型结构概览：几段对话/几篇短文、各段题号区间、由选项措辞推测的话题倾向（不得编造具体录音内容，中文 80-150 字）",
  "strategy": ["通用听力应试技巧，4-6 条，每条 20-50 字，要具体可执行"],
  "segments": [
    {"pid": ${pids[0] || 1}, "numbers": [${u.questions.slice(0, 3).map(q => q.number).join(',')}], "sharedTopic": "这组选项的共同话题倾向（只能由选项措辞推断，中文 15-30 字）", "optionSignals": "这组选项的语言特征（如：都是动名词短语说明在问 action、都含比较级说明在问 preference；中文 40-80 字）", "tips": ["针对这组选项的排除技巧，2-3 条"]}
  ],
  "coreVocab": [{"w": "选项中出现的高频听力核心词", "cn": "中文释义"}]
}

【硬性要求】
- segments 必须覆盖全部 ${pids.length} 段录音。
- coreVocab 8-14 个。
- 全部讲解用中文，英文只出现在关键词上。
- ${JSON_RULES}`;
}

function promptLongMatch(u, trackLabel) {
  const qLines = u.questions.map(q => `${q.number}. ${clean(q.text)}\n   → 答案：${q.answer} 段`).join('\n\n');
  const hasPassage = u.passage && String(u.passage.text || '').trim().length > 200;
  const note = hasPassage
    ? `【正文段落】\n${passageTextWithMarks(u.passage.text)}\n`
    : `【注意】题库只收录了 10 条陈述句与每条对应的答案段落字母（A–O），**没有收录正文段落原文**。不要编造段落原文内容，只基于陈述句本身与答案字母做解析。\n`;
  return `请为下面这道${trackLabel}「长篇阅读（信息匹配，${u.questions.length} 题）」做参考解析。

${note}
【陈述句与答案】
${qLines}

【输出结构】
{
  "topic": "本组陈述句的共同主题（中文，20 字内）",
  "strategy": ["做长篇匹配题的可行方法，3-5 条，每条 20-40 字"],
  "questions": [
    {"number": ${u.questions[0].number}, "answer": "${u.questions[0].answer}", "cn": "陈述句的准确中文翻译", "keywords": ["需在原文扫读定位的关键词 2-4 个"], "paraphrase": "陈述句与原文之间常见的同义替换形式（中文 40-80 字；若无原文只能描述替换类型，不得编造原句）", "tip": "一句话定位技巧（中文 20-40 字）"}
  ],
  "vocab": [{"w": "陈述句中的生词", "cn": "中文释义（含词性）"}]
}

【硬性要求】
- questions 必须覆盖全部 ${u.questions.length} 题，answer 必须与给定答案完全一致。
- cn 必须是准确的中文翻译。
- ${JSON_RULES}`;
}

const TRACK_LABEL = { kaoyan1: '考研英语一', cet6: '英语六级' };
const SECTION_LABEL = {
  reading: '阅读理解', use_of_english: '完形填空', banked_cloze: '选词填空',
  part_b: '新题型', long_match: '长篇阅读', translation: '翻译',
  writing: '写作', listening: '听力理解',
};

function buildPrompt(u) {
  const tl = TRACK_LABEL[u.track] || '考研英语一';
  switch (u.section) {
    case 'reading': return promptReading(u, tl);
    case 'use_of_english': return promptCloze(u, tl, '完形填空');
    case 'banked_cloze': return promptCloze(u, tl, '选词填空');
    case 'part_b': return promptPartB(u, tl);
    case 'translation': return tl === '英语六级' ? promptTranslationCet6(u, tl) : promptTranslationKaoyan(u, tl);
    case 'writing': return promptWriting(u, tl);
    case 'listening': return promptListening(u, tl);
    case 'long_match': return promptLongMatch(u, tl);
    default: return promptReading(u, tl);
  }
}

/* ---------------- 校验 ---------------- */
/**
 * 校验模型输出。返回 { ok, errors[], warnings[], stats }
 * 硬错误（errors）会触发重试；软问题（warnings）仅记录。
 */
function validateUnit(u, data) {
  const errors = [];
  const warnings = [];
  const stats = { questions: 0, vocab: 0 };
  if (!data || typeof data !== 'object') return { ok: false, errors: ['输出不是对象'], warnings, stats };

  const authoritative = new Map(u.questions.map(q => [q.number, String(q.answer || '').trim().toUpperCase()]));

  if (u.section === 'writing') {
    const units = Array.isArray(data.units) ? data.units : [];
    if (units.length < u.writings.length) errors.push(`写作范文数量不足：${units.length}/${u.writings.length}`);
    for (const w of u.writings) {
      const hit = units.find(x => Number(x.number) === Number(w.number));
      if (!hit) { errors.push(`缺少第 ${w.number} 题范文`); continue; }
      if (!String(hit.sample || '').trim()) errors.push(`第 ${w.number} 题范文为空`);
      else {
        const words = String(hit.sample).split(/\s+/).filter(Boolean).length;
        if (words < 60) warnings.push(`第 ${w.number} 题范文偏短（${words} 词）`);
      }
      if (!Array.isArray(hit.outline) || hit.outline.length < 2) warnings.push(`第 ${w.number} 题缺少段落提纲`);
    }
    stats.questions = units.length;
    return { ok: errors.length === 0, errors, warnings, stats };
  }

  if (u.section === 'translation') {
    if (Array.isArray(data.questions)) {
      stats.questions = data.questions.length;
      for (const [num, ans] of authoritative) {
        const hit = data.questions.find(x => Number(x.number) === num);
        if (!hit) { errors.push(`缺少第 ${num} 句解析`); continue; }
        const q = u.questions.find(x => Number(x.number) === num);
        if (q && hit.en && !containsLoose(q.text, hit.en)) warnings.push(`第 ${num} 句 en 与原文不完全一致`);
      }
      if (data.questions.length < u.questions.length) errors.push(`翻译解析数量不足：${data.questions.length}/${u.questions.length}`);
    } else if (Array.isArray(data.sentences)) {
      stats.questions = data.sentences.length;
      if (data.sentences.length < 2) errors.push('六级译文逐句解析过少');
    } else {
      errors.push('缺少 questions/sentences 字段');
    }
    if (!String(data.translation || data.reference || '').trim()) errors.push('缺少全文译文/参考译文');
    stats.vocab = Array.isArray(data.vocab) ? data.vocab.length : 0;
    return { ok: errors.length === 0, errors, warnings, stats };
  }

  if (u.section === 'listening') {
    if (!String(data.notice || '').trim()) warnings.push('缺少 notice 说明');
    const segs = Array.isArray(data.segments) ? data.segments : [];
    stats.questions = segs.length;
    if (!segs.length) errors.push('缺少 segments');
    if (!Array.isArray(data.strategy) || data.strategy.length < 3) warnings.push('听力技巧条目过少');
    // 幻觉检测：只抓「断言录音说了什么」的表述，如「录音中提到男士喜欢乡村音乐」。
    // 排除三类合法语境：
    //   1. 免责声明（不涉及编造 / 未收录原文 / 无从得知）；
    //   2. 推测语气（可能 / 大概 / 推测 / 疑似 —— 本库允许由选项措辞推断话题）；
    //   3. 行动建议（「注意对话中提到的观看方式」这类是应试提示，不是复述内容）。
    const body = JSON.stringify(data);
    const affirmative = body
      .replace(/[^，。；"]{0,24}(?:不涉及|不包含|不提供|不编造|未收录|没有收录|无从得知|无法得知|不做推断|不作推断|无法判断|无从判断)[^，。；"]{0,24}/g, '')
      .replace(/[^，。；"]{0,24}(?:可能|大概|也许|推测|疑似|或许|应是|倾向)[^，。；"]{0,40}/g, '')
      .replace(/[^，。；"]{0,16}(?:注意|留意|关注|警惕|小心)[^，。；"]{0,40}/g, '');
    if (/(?:录音|音频|对话)(?:中|里)(?:提到|说到|说|讲|谈|提及)/.test(affirmative)) {
      warnings.push('疑似编造录音内容表述');
    }
    return { ok: errors.length === 0, errors, warnings, stats };
  }

  // 客观题类（reading / cloze / part_b / long_match）
  const qsIn = Array.isArray(data.questions) ? data.questions : [];
  stats.questions = qsIn.length;
  stats.vocab = Array.isArray(data.vocab) ? data.vocab.length : 0;
  if (!qsIn.length) errors.push('缺少 questions');
  for (const [num, ans] of authoritative) {
    const hit = qsIn.find(x => Number(x.number) === num);
    if (!hit) { errors.push(`缺少第 ${num} 题解析`); continue; }
    const got = String(hit.answer || '').trim().toUpperCase();
    if (got !== ans) errors.push(`第 ${num} 题答案不一致：模型 ${got || '(空)'} vs 题库 ${ans}`);
  }
  const extra = qsIn.filter(x => !authoritative.has(Number(x.number)));
  if (extra.length) warnings.push(`出现题库外题号：${extra.map(x => x.number).join(',')}`);
  if (stats.vocab < 4) warnings.push(`生词条目偏少（${stats.vocab}）`);
  // long_match 的讲解字段是 paraphrase/cn（题库无原文，不做 why 要求）
  if (u.section === 'long_match') {
    const noText = qsIn.filter(x => !String(x.cn || '').trim() && !String(x.paraphrase || '').trim());
    if (noText.length) errors.push(`${noText.length} 道题缺少中文翻译/同义替换讲解`);
  } else {
    const noWhy = qsIn.filter(x => !String(x.why || '').trim());
    if (noWhy.length) errors.push(`${noWhy.length} 道题缺少 why 讲解`);
  }
  // 原文忠实度
  if (u.passage && u.section !== 'long_match') {
    for (const q of qsIn) {
      if (q.locate && !containsLoose(u.passage.text, q.locate)) warnings.push(`第 ${q.number} 题 locate 定位句与原文不符`);
    }
  }
  if (Array.isArray(data.longSentences)) {
    for (const ls of data.longSentences) {
      if (!ls || !ls.en || !u.passage) continue;
      // 长难句允许「截取到破折号/省略号/分号前」——这类截取仍是原文原句的一部分
      const variants = [ls.en];
      for (const m of String(ls.en).split(/\s*(?:—|–|\u2026|\.\.\.|;)\s*/)) {
        if (m && m.trim().length >= 12) variants.push(m.trim());
      }
      if (!variants.some(v => containsLoose(u.passage.text, v))) {
        warnings.push('longSentences 有原句与原文不符');
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, stats };
}

/* ---------------- LLM 调用 ---------------- */
let PROVIDERS = [];
let providerCursor = 0;
/* v3.8.0：上游限流自适应——命中 429 时全局暂停并发（所有 worker 共享的门闩），
   暂停时长指数增长；同时降低同时在飞请求数（effectiveConcurrency），避免雪崩式重试。 */
const throttleState = {
  pausedUntil: 0,        // 全局暂停截止时间戳（ms）
  hits: 0,               // 连续 429 次数
  effective: CONCURRENCY, // 动态并发（上限 CONCURRENCY，最低 1）
  inFlight: 0,
};

async function awaitThrottle() {
  for (;;) {
    const wait = throttleState.pausedUntil - Date.now();
    if (wait <= 0) break;
    await sleep(Math.min(wait, 5000));
  }
  // 并发闸门：在飞数达到动态上限则等待（简单轮询，粒度 150ms）
  while (throttleState.inFlight >= throttleState.effective) await sleep(150);
}

function noteThrottle() {
  throttleState.hits++;
  const backoff = Math.min(120000, 4000 * Math.pow(2, Math.min(throttleState.hits - 1, 5)));
  throttleState.pausedUntil = Math.max(throttleState.pausedUntil, Date.now() + backoff);
  throttleState.effective = Math.max(1, Math.floor(throttleState.effective / 2));
  log(`  ⏳ 上游限流：暂停 ${(backoff / 1000).toFixed(0)}s，动态并发降至 ${throttleState.effective}`);
}

function noteThrottleOk() {
  if (throttleState.hits > 0) {
    throttleState.hits = Math.max(0, throttleState.hits - 1);
    if (throttleState.effective < CONCURRENCY && throttleState.hits === 0) {
      throttleState.effective = Math.min(CONCURRENCY, throttleState.effective + 1);
    }
  }
}

function pickProvider() {
  if (!PROVIDERS.length) throw new Error('没有可用服务商');
  const p = PROVIDERS[providerCursor % PROVIDERS.length];
  providerCursor++;
  return p;
}

async function callLlm(messages, provider) {
  const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: provider.model,
    messages,
    max_tokens: MAX_TOKENS,
    temperature: 0.3,
    response_format: { type: 'json_object' },
  };
  const t0 = Date.now();
  await awaitThrottle();
  throttleState.inFlight++;
  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: 'Bearer ' + provider.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } finally {
    throttleState.inFlight--;
  }
  if (res.status === 429) {
    const err = new Error(`HTTP 429 ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    err.throttled = true;
    noteThrottle();
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  noteThrottleOk();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('上游返回非 JSON'); }
  const choice = json.choices?.[0] || {};
  const content = choice.message?.content || choice.text || '';
  const finish = choice.finish_reason || '';
  if (!String(content).trim()) {
    throw new Error(`正文为空（finish_reason=${finish}，思考已生成 ${String(choice.message?.reasoning_content || '').length} 字）`);
  }
  let data = null;
  try { data = JSON.parse(stripFences(content)); } catch { /* 走宽松解析 */ }
  if (!data) data = parseLoose(content);
  if (!data) data = salvageJson(content);
  if (!data) throw new Error(`JSON 解析失败（finish_reason=${finish}，长度 ${content.length}）`);
  return { data, ms: Date.now() - t0, usage: json.usage || null, finish, raw: content };
}

/* ---------------- 阅读拆题合并 ---------------- */
/**
 * v3.8.0：把 __reading__<pid>c<N> 的拆题产物合并成 __reading__<pid>。
 * 合并规则：
 *   - questions 按题号并集排序；
 *   - topic/gist/difficulty 取第一个非空（同一篇文章，各子单元结论应一致）；
 *   - translation 取最长的（通常是最完整的全文译文）；
 *   - structure / vocab / longSentences 去重合并；
 *   - 答案以题库权威值为准（子单元生成时已硬校验）。
 */
async function mergeReadingUnits() {
  const files = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')) : [];
  const byBase = new Map();
  for (const f of files) {
    const m = /^(.+?)__reading__(\d+)c(\d+)$/.exec(f.slice(0, -5));
    if (!m) continue;
    const baseId = `${m[1]}__reading__${m[2]}`;
    if (!byBase.has(baseId)) byBase.set(baseId, []);
    byBase.get(baseId).push({ file: f, chunk: Number(m[3]) });
  }
  let merged = 0, skipped = 0;
  for (const [baseId, parts] of byBase) {
    const outFile = join(OUT_DIR, `${baseId}.json`);
    if (existsSync(outFile) && !FORCE) { skipped++; continue; }
    const recs = [];
    for (const p of parts.sort((a, b) => a.chunk - b.chunk)) {
      try { recs.push(JSON.parse(await readFile(join(OUT_DIR, p.file), 'utf8'))); }
      catch { /* 跳过损坏件 */ }
    }
    if (!recs.length) continue;
    const base = recs[0];
    const qMap = new Map();
    let translation = '';
    const structure = [];
    const vocabMap = new Map();
    const longSentMap = new Map();
    const warnings = [];
    let provider = '', model = '', usage = null, elapsed = 0, attempts = 1;
    let topic = '', gist = '', difficulty = '', type = '';
    for (const r of recs) {
      const a = r.analysis || {};
      for (const q of (Array.isArray(a.questions) ? a.questions : [])) {
        if (q && q.number != null) qMap.set(Number(q.number), q);
      }
      if (String(a.translation || '').length > translation.length) translation = a.translation;
      for (const s of (Array.isArray(a.structure) ? a.structure : [])) if (s) structure.push(s);
      for (const v of (Array.isArray(a.vocab) ? a.vocab : [])) if (v && v.w) vocabMap.set(String(v.w).toLowerCase(), v);
      for (const ls of (Array.isArray(a.longSentences) ? a.longSentences : [])) {
        if (ls && ls.en) longSentMap.set(normText(ls.en).slice(0, 80), ls);
      }
      topic = topic || a.topic || '';
      gist = gist || a.gist || '';
      difficulty = difficulty || a.difficulty || '';
      type = type || a.type || '';
      provider = provider || r.provider || '';
      model = model || r.model || '';
      usage = usage || r.usage || null;
      elapsed += r.elapsedMs || 0;
      attempts = Math.max(attempts, r.attempts || 1);
      warnings.push(...(r.warnings || []));
    }
    const questions = [...qMap.values()].sort((a, b) => Number(a.number) - Number(b.number));
    const mergedRec = {
      schemaVersion: 1,
      id: baseId,
      examId: base.examId, track: base.track, section: 'reading',
      sectionLabel: base.sectionLabel || '阅读理解',
      title: base.title, year: base.year, sub: String(base.sub).replace(/c\d+$/, ''),
      questionNumbers: questions.map(q => q.number),
      generatedAt: new Date().toISOString(),
      model, provider, elapsedMs: elapsed, usage, attempts, warnings,
      analysis: {
        ...(topic ? { topic } : {}),
        ...(gist ? { gist } : {}),
        ...(structure.length ? { structure } : {}),
        ...(difficulty ? { difficulty } : {}),
        ...(type ? { type } : {}),
        ...(translation ? { translation } : {}),
        questions,
        vocab: [...vocabMap.values()],
        longSentences: [...longSentMap.values()],
      },
      mergedFrom: recs.map(r => r.id),
    };
    await writeJsonAtomic(outFile, mergedRec);
    merged++;
    log(`  ⊕ 合并 ${baseId}: ${recs.length} 件 → ${questions.length} 题`);
  }
  log(`[exam-analysis] 阅读合并完成：${merged} 篇（跳过已有 ${skipped}）`);
  return merged;
}

/* ---------------- 写作拆题合并 ---------------- */
/**
 * v3.8.0：把 __writing__<number> 的拆题产物合并成 __writing__all。
 * 产物结构与整板块生成完全一致（units[] + band9），前端无需感知拆题过程。
 */
async function mergeWritingUnits() {
  const files = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')) : [];
  // 按 examId 聚合拆题产物
  const byExam = new Map();
  for (const f of files) {
    const m = /^(.+?)__writing__(\d+)$/.exec(f.slice(0, -5));
    if (!m) continue;
    if (!byExam.has(m[1])) byExam.set(m[1], []);
    byExam.get(m[1]).push({ file: f, number: Number(m[2]) });
  }
  let merged = 0, skippedNoAll = 0;
  for (const [examId, parts] of byExam) {
    const allFile = join(OUT_DIR, `${examId}__writing__all.json`);
    // 已有整板块产物则跳过（不覆盖已成功的）
    if (existsSync(allFile) && !FORCE) { skippedNoAll++; continue; }
    const recs = [];
    for (const p of parts.sort((a, b) => a.number - b.number)) {
      try { recs.push(JSON.parse(await readFile(join(OUT_DIR, p.file), 'utf8'))); }
      catch { /* 跳过损坏拆题件 */ }
    }
    if (!recs.length) continue;
    const unitsOut = [];
    let band9 = [];
    let provider = '', model = '', usage = null, elapsed = 0, attempts = 1, warnings = [];
    for (const r of recs) {
      const a = r.analysis || {};
      for (const u of (Array.isArray(a.units) ? a.units : [])) unitsOut.push(u);
      if (Array.isArray(a.band9)) band9 = band9.concat(a.band9);
      provider = provider || r.provider || '';
      model = model || r.model || '';
      usage = usage || r.usage || null;
      elapsed += r.elapsedMs || 0;
      attempts = Math.max(attempts, r.attempts || 1);
      warnings = warnings.concat(r.warnings || []);
    }
    if (!unitsOut.length) continue;
    unitsOut.sort((a, b) => Number(a.number ?? 0) - Number(b.number ?? 0));
    const base = recs[0];
    const mergedRec = {
      schemaVersion: 1,
      id: `${examId}__writing__all`,
      examId, track: base.track, section: 'writing',
      sectionLabel: base.sectionLabel || '写作',
      title: base.title, year: base.year, sub: 'all',
      questionNumbers: unitsOut.map(u => u.number).filter(n => n != null),
      generatedAt: new Date().toISOString(),
      model, provider, elapsedMs: elapsed, usage, attempts,
      warnings,
      analysis: { units: unitsOut, band9 },
      mergedFrom: recs.map(r => r.id),
    };
    await writeJsonAtomic(allFile, mergedRec);
    merged++;
    log(`  ⊕ 合并 ${examId}: ${recs.length} 个拆题件 → units=${unitsOut.length}`);
  }
  log(`[exam-analysis] 写作合并完成：${merged} 套（跳过已有 ${skippedNoAll}）`);
  return merged;
}

/* ---------------- 只读重校验（不调 LLM） ---------------- */
/**
 * v3.8.0：按当前校验规则重算已落盘单元的 warnings。
 * 只重写 warnings 字段，不动 analysis 正文、不动 model/provider/usage 等溯源信息。
 */
async function revalidateAll() {
  const files = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')) : [];
  const recs = loadExams();
  const examById = new Map(recs.map(r => [r.id, r]));
  let checked = 0, changed = 0, beforeW = 0, afterW = 0;
  for (const f of files) {
    const file = join(OUT_DIR, f);
    let rec;
    try { rec = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    if (!rec || !rec.analysis || !rec.examId) continue;
    const exam = examById.get(rec.examId);
    if (!exam) continue;
    // 重建该单元对应的「单元视图」，复用 validateUnit 的告警逻辑
    const built = buildUnits(exam).find(u => u.id === rec.id);
    if (!built) continue;
    checked++;
    beforeW += (rec.warnings || []).length;
    const v = validateUnit(built, rec.analysis);
    const newWarnings = [...new Set(v.warnings)];
    afterW += newWarnings.length;
    const same = JSON.stringify(rec.warnings || []) === JSON.stringify(newWarnings);
    if (!same) {
      rec.warnings = newWarnings;
      await writeJsonAtomic(file, rec);
      changed++;
    }
  }
  log(`[revalidate] 检查 ${checked} 个单元 · warnings ${beforeW} → ${afterW} · 改写 ${changed} 个文件`);
  return changed;
}

/* ---------------- 单单元处理 ---------------- */
function unitFile(u) { return join(OUT_DIR, `${u.id}.json`); }

function buildRecord(u, data, meta) {
  return {
    schemaVersion: 1,
    id: u.id,
    examId: u.examId,
    track: u.track,
    section: u.section,
    sectionLabel: SECTION_LABEL[u.section] || u.section,
    title: u.title,
    year: u.year,
    sub: u.sub,
    questionNumbers: u.questions.map(q => q.number),
    generatedAt: meta.generatedAt,
    model: meta.model,
    provider: meta.provider,
    elapsedMs: meta.elapsedMs,
    usage: meta.usage || null,
    attempts: meta.attempts,
    warnings: meta.warnings || [],
    analysis: data,
  };
}

async function writeJsonAtomic(file, obj) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(obj, null, 1), 'utf8');
  await rename(tmp, file);
}

async function processUnit(u, counters) {
  const file = unitFile(u);
  if (!FORCE && existsSync(file)) {
    try {
      const prev = JSON.parse(await readFile(file, 'utf8'));
      if (prev && prev.schemaVersion === 1 && prev.analysis) {
        counters.skipped++;
        return { status: 'skipped' };
      }
    } catch { /* 损坏则重生成 */ }
  }
  if (DRY_RUN) { counters.planned++; return { status: 'planned' }; }

  const prompt = buildPrompt(u);
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const provider = pickProvider();
    try {
      const { data, ms, usage } = await callLlm(messages, provider);
      const v = validateUnit(u, data);
      if (!v.ok) {
        lastErr = `校验失败：${v.errors.slice(0, 4).join('；')}`;
        log(`  ✗ [${u.id}] 第 ${attempt} 次 ${lastErr.slice(0, 160)}`);
        if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
        continue;
      }
      const rec = buildRecord(u, data, {
        generatedAt: new Date().toISOString(), model: provider.model, provider: provider.name,
        elapsedMs: ms, usage, attempts: attempt, warnings: v.warnings,
      });
      await writeJsonAtomic(file, rec);
      counters.ok++;
      counters.warn += v.warnings.length;
      log(`  ✓ [${u.id}] ${ms}ms 题=${v.stats.questions} 生词=${v.stats.vocab} 警告=${v.warnings.length} 第${attempt}次`);
      return { status: 'ok', warnings: v.warnings };
    } catch (e) {
      lastErr = e.message;
      // 429 已经被全局门闩接管（awaitThrottle 会在下次调用时等待），这里不再叠加长 sleep
      if (e.throttled) {
        log(`  ⏳ [${u.id}] 第 ${attempt} 次 限流，等待门闩后重试`);
        continue;
      }
      log(`  ✗ [${u.id}] 第 ${attempt} 次 ${String(e.message).slice(0, 160)}`);
      if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
    }
  }
  counters.failed++;
  return { status: 'failed', error: lastErr };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const cfg = JSON.parse(await readFile(CONFIG, 'utf8'));
  const all = cfg.llm?.providers || [];
  const wanted = PROVIDER_NAME.split(',').filter(Boolean);
  PROVIDERS = wanted.map(n => all.find(p => p.name === n)).filter(Boolean);
  if (!PROVIDERS.length) throw new Error(`找不到服务商：${PROVIDER_NAME}（可用：${all.map(p => p.name).join(',')}）`);

  // v3.8.0：仅重校验模式（按当前规则刷新 warnings，不调 LLM）
  if (REVALIDATE) {
    await revalidateAll();
    process.exitCode = 0;
    return;
  }

  // v3.8.0：仅合并模式（把已生成的拆题件合成整单元，不调 LLM）
  if (MERGE_WRITING || MERGE_READING) {
    await mkdir(OUT_DIR, { recursive: true });
    let n = 0;
    if (MERGE_WRITING) n += await mergeWritingUnits();
    if (MERGE_READING) n += await mergeReadingUnits();
    process.exitCode = n ? 0 : 1;
    return;
  }

  const recs = loadExams();
  let units = [];
  for (const rec of recs) {
    const track = rec.track || 'kaoyan1';
    if (TRACK_FILTER && !TRACK_FILTER.includes(track)) continue;
    units.push(...buildUnits(rec));
  }
  if (SECTION_FILTER) units = units.filter(u => SECTION_FILTER.includes(u.section));
  if (ONLY) units = units.filter(u => ONLY.includes(u.id));
  if (SKIP_LISTEN) units = units.filter(u => u.section !== 'listening');
  if (LIMIT > 0) units = units.slice(0, LIMIT);

  log(`[exam-analysis] 服务商 ${PROVIDERS.map(p => p.name + '/' + p.model).join(', ')}`);
  log(`[exam-analysis] 单元 ${units.length} 个，并发 ${CONCURRENCY}，上限 ${MAX_TOKENS} tokens，重试 ${MAX_ATTEMPTS} 次${DRY_RUN ? '（dry-run）' : ''}`);

  const bySection = {};
  for (const u of units) bySection[u.section] = (bySection[u.section] || 0) + 1;
  log('[exam-analysis] 分布 ' + JSON.stringify(bySection));

  if (DRY_RUN) {
    const counts = { skipped: 0, planned: 0, ok: 0, failed: 0, warn: 0 };
    for (const u of units) { if (existsSync(unitFile(u)) && !FORCE) counts.skipped++; else counts.planned++; }
    log(`[dry-run] 待生成 ${counts.planned}，已存在 ${counts.skipped}`);
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const counters = { ok: 0, skipped: 0, failed: 0, warn: 0, planned: 0 };
  const failures = [];
  const t0 = Date.now();
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= units.length) return;
      const u = units[i];
      const r = await processUnit(u, counters);
      if (r.status === 'failed') failures.push({ id: u.id, section: u.section, title: u.title, error: r.error });
      done++;
      if (done % 20 === 0) {
        const el = (Date.now() - t0) / 1000;
        log(`[progress] ${done}/${units.length} 用时 ${el.toFixed(0)}s · ok=${counters.ok} skip=${counters.skipped} fail=${counters.failed}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, units.length) }, worker));

  const el = ((Date.now() - t0) / 1000).toFixed(0);
  log(`\n[exam-analysis] 完成：成功 ${counters.ok} · 跳过 ${counters.skipped} · 失败 ${counters.failed} · 警告 ${counters.warn} · 用时 ${el}s`);

  if (failures.length) {
    await writeJsonAtomic(join(OUT_DIR, '_failures.json'), {
      generatedAt: new Date().toISOString(), total: failures.length, failures,
    });
    log(`[exam-analysis] 失败清单已写入 ${join(OUT_DIR, '_failures.json')}`);
  } else if (existsSync(join(OUT_DIR, '_failures.json'))) {
    await writeJsonAtomic(join(OUT_DIR, '_failures.json'), {
      generatedAt: new Date().toISOString(), total: 0, failures: [],
    });
  }
  process.exitCode = counters.failed ? 1 : 0;
}

main().catch(e => { console.error('[exam-analysis] 致命错误：', e); process.exit(2); });
