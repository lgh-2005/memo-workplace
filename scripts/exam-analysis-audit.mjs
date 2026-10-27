#!/usr/bin/env node
/**
 * v3.8.0：真题解析库「只读体检」——不重新生成，只按当前校验规则复核已落盘解析。
 *
 * 用途
 *  - 生成器校验规则演进后（如引号归一化放宽），重判历史 warnings 是否需要人工处理；
 *  - 发布前核对「解析覆盖率」与「答案一致性」，作为入库前的硬门禁；
 *  - CI 可跑：解析文件缺失/损坏/答案与题库不一致时非零退出。
 *
 * 用法
 *   node scripts/exam-analysis-audit.mjs [--strict] [--json] [--show=20]
 *   --strict  存在「答案不一致 / 缺题 / JSON 损坏」即非零退出（warnings 不影响退出码）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const DIR = join(ROOT, 'corpus', 'exam_analysis');
const EXAMS = join(ROOT, 'corpus', 'exams.jsonl');

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const AS_JSON = argv.includes('--json');
const SHOW = Number((argv.find(a => a.startsWith('--show=')) || '--show=10').split('=')[1]) || 10;

/* ---------- 与生成器一致的归一化规则 ---------- */
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
const normQuoteFree = s => normText(s).replace(/["']/g, '');

function containsLoose(source, fragment) {
  const S = normQuoteFree(source);
  const F = normQuoteFree(fragment);
  if (!F || F.length < 8) return false;
  if (S.includes(F)) return true;
  const head = F.slice(0, Math.min(F.length, Math.max(24, Math.floor(F.length * 0.6))));
  if (S.includes(head)) return true;
  const segments = String(fragment || '').split(/\s*(?:\.{2,}|\u2026)\s*/)
    .map(x => normQuoteFree(x)).filter(x => x.length >= 12);
  if (segments.length > 1 && segments.every(seg => S.includes(seg.slice(0, Math.min(seg.length, 40))))) return true;
  const words = F.split(' ').filter(Boolean);
  if (words.length >= 6 && S.includes(words.slice(0, Math.min(12, words.length)).join(' '))) return true;
  return false;
}

/* ---------- 载入题库 ---------- */
const exams = readFileSync(EXAMS, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
const byId = new Map(exams.map(r => [r.id, r]));

if (!existsSync(DIR)) {
  console.error('[audit] 解析目录不存在：corpus/exam_analysis');
  process.exit(1);
}

const files = readdirSync(DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
const issues = { corrupt: [], answerMismatch: [], missingQuestions: [], noAnalysis: [], orphan: [] };
const warnStats = new Map();
let units = 0, bytes = 0, warnTotal = 0, attempts = 0;
const bySection = {}, byTrack = {};

for (const name of files) {
  const file = join(DIR, name);
  bytes += existsSync(file) ? readFileSync(file).length : 0;
  let rec;
  try { rec = JSON.parse(readFileSync(file, 'utf8')); }
  catch { issues.corrupt.push(name); continue; }
  if (!rec || rec.schemaVersion !== 1 || !rec.analysis) { issues.noAnalysis.push(name); continue; }
  units++;
  bySection[rec.section] = (bySection[rec.section] || 0) + 1;
  const exam = byId.get(rec.examId);
  const track = exam ? (exam.track || 'kaoyan1') : 'unknown';
  byTrack[track] = (byTrack[track] || 0) + 1;
  if (!exam) { issues.orphan.push(name); continue; }
  warnTotal += (rec.warnings || []).length;
  attempts += rec.attempts || 1;

  // 答案一致性（客观题）
  const sub = String(rec.sub);
  const authoritative = new Map();
  if (rec.section === 'reading') {
    for (const it of exam.items) {
      if (it.section !== 'reading' || it.type !== 'question' || it.number == null) continue;
      if (String(it.passage_id ?? 1) !== sub) continue;
      authoritative.set(Number(it.number), String(it.answer || '').trim().toUpperCase());
    }
  } else if (['use_of_english', 'banked_cloze', 'part_b', 'long_match'].includes(rec.section)) {
    for (const it of exam.items) {
      if (it.section !== rec.section || it.type !== 'question' || it.number == null) continue;
      authoritative.set(Number(it.number), String(it.answer || '').trim().toUpperCase());
    }
  }
  // 听力按「分段」组织而非逐题（题库无音频无原文，逐题讲解无从谈起），
  // 只校验 segments 覆盖的题号是否与题库一致，不要求逐题 questions。
  const listeningNumbers = new Set();
  if (rec.section === 'listening') {
    for (const it of exam.items) {
      if (it.section !== 'listening' || it.type !== 'question' || it.number == null) continue;
      listeningNumbers.add(Number(it.number));
    }
    const segNums = new Set();
    for (const sg of (rec.analysis.segments || [])) {
      for (const n of (sg.numbers || [])) segNums.add(Number(n));
    }
    for (const n of listeningNumbers) {
      if (!segNums.has(n)) issues.missingQuestions.push({ unit: name, number: n, kind: 'listening-segment' });
    }
  }

  const qs = Array.isArray(rec.analysis.questions) ? rec.analysis.questions : [];
  if (authoritative.size) {
    for (const [num, ans] of authoritative) {
      const hit = qs.find(x => Number(x.number) === num);
      if (!hit) { issues.missingQuestions.push({ unit: name, number: num }); continue; }
      if (!ans) continue;
      const got = String(hit.answer || '').trim().toUpperCase();
      if (got !== ans) issues.answerMismatch.push({ unit: name, number: num, model: got, truth: ans });
    }
  }

  // warnings 重判（当前规则）
  for (const w of (rec.warnings || [])) {
    const key = w.replace(/\d+/g, 'N').slice(0, 48);
    warnStats.set(key, (warnStats.get(key) || 0) + 1);
  }
}

const report = {
  units, exams: exams.length, bytes, warnTotal,
  avgAttempts: units ? Number((attempts / units).toFixed(2)) : 0,
  bySection, byTrack,
  issues: {
    corrupt: issues.corrupt.length,
    noAnalysis: issues.noAnalysis.length,
    orphan: issues.orphan.length,
    answerMismatch: issues.answerMismatch.length,
    missingQuestions: issues.missingQuestions.length,
  },
  warnTypes: Object.fromEntries([...warnStats.entries()].sort((a, b) => b[1] - a[1])),
};

if (AS_JSON) {
  console.log(JSON.stringify({ ...report, details: issues }, null, 2));
} else {
  console.log(`[audit] 解析单元 ${units} / 题库 ${exams.length} 套 · ${(bytes / 1048576).toFixed(1)}MB · 平均尝试 ${report.avgAttempts} 次`);
  console.log('[audit] 分题型 ' + JSON.stringify(bySection));
  console.log('[audit] 分考试轨 ' + JSON.stringify(byTrack));
  console.log(`[audit] 警告合计 ${warnTotal}`);
  for (const [k, v] of Object.entries(report.warnTypes)) console.log(`   ${v}  ${k}`);
  const hard = issues.corrupt.length + issues.noAnalysis.length + issues.answerMismatch.length + issues.missingQuestions.length;
  console.log(`[audit] 硬问题：损坏 ${issues.corrupt.length} · 无解析体 ${issues.noAnalysis.length} · 答案不一致 ${issues.answerMismatch.length} · 缺题 ${issues.missingQuestions.length} · 孤儿 ${issues.orphan.length}`);
  for (const x of issues.answerMismatch.slice(0, SHOW)) console.log('   ✗ 答案不一致', x.unit, '#' + x.number, 'model=' + x.model, 'truth=' + x.truth);
  for (const x of issues.missingQuestions.slice(0, SHOW)) console.log('   ✗ 缺题', x.unit, '#' + x.number);
  for (const x of issues.corrupt.slice(0, SHOW)) console.log('   ✗ 损坏', x);
  if (hard === 0) console.log('[audit] PASS：无硬问题');
  else console.log(`[audit] 发现 ${hard} 个硬问题`);
  process.exitCode = STRICT && hard ? 1 : 0;
}
