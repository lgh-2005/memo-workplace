#!/usr/bin/env node
/**
 * v4.3.1：清理「听说训练」历史数据（一次性维护脚本，不参与 npm test）。
 *
 * 背景：v4.3.1 删除听说训练模块，随之移除 learning_attempts 里 kind=listening/speaking
 * 的流水与今日任务里 listening/speaking 的勾选记录。代码侧不再产生这类记录，
 * 但历史文件里可能仍有存量——本脚本负责把它们清掉，可重复执行（幂等）。
 *
 * 数据位置（与 server.js 的 ctxFilePath 一致）：
 *   data/learning_attempts.json、data/study_plan.json
 *   data/users/<id>/learning_attempts.json、data/users/<id>/study_plan.json
 *
 * 安全约定：
 *   - 默认只 dry-run 预览，加 --apply 才真正写盘；
 *   - 写盘前把原文件备份为 <file>.bak-speaking-<时间戳>；
 *   - JSON 解析失败或结构非法时跳过该文件并告警，绝不覆盖；
 *   - 原子写：同目录 .tmp + rename，与 server.js 的 saveJSON 行为一致（2 空格缩进）。
 *
 * 用法：
 *   node scripts/purge-speaking-attempts.mjs            # 预览
 *   node scripts/purge-speaking-attempts.mjs --apply     # 执行
 *   node scripts/purge-speaking-attempts.mjs --data /opt/workbench/data --apply
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dataIndex = args.indexOf('--data');
const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : join(root, 'data');

const SPEAKING_KINDS = new Set(['listening', 'speaking']);
const SPEAKING_TASK_IDS = ['listening', 'speaking'];
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');

/** atomicJsonWrite：与 server.js saveJSON 同样的 2 空格缩进 + tmp/rename */
async function atomicJsonWrite(file, obj) {
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await rename(tmp, file);
}

async function backup(file) {
  const target = `${file}.bak-speaking-${stamp}`;
  await copyFile(file, target);
  return target;
}

/** 清 learning_attempts.json：返回 { removed, total, changed } */
async function purgeAttempts(file) {
  if (!existsSync(file)) return { skipped: 'missing' };
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    return { skipped: `unparsable (${String(e.message || e).slice(0, 80)})` };
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.attempts)) {
    return { skipped: 'invalid schema (attempts is not an array)' };
  }
  const before = raw.attempts.length;
  const kept = raw.attempts.filter(a => !SPEAKING_KINDS.has(String(a?.kind || '')));
  const removed = before - kept.length;
  if (!removed) return { removed: 0, total: before, changed: false };
  if (apply) {
    const backupFile = await backup(file);
    await atomicJsonWrite(file, { ...raw, attempts: kept });
    return { removed, total: before, kept: kept.length, changed: true, backup: backupFile };
  }
  return { removed, total: before, kept: kept.length, changed: true, dryRun: true };
}

/** 清 study_plan.json 里 listening/speaking 的任务勾选：返回 { removed, changed } */
async function purgePlan(file) {
  if (!existsSync(file)) return { skipped: 'missing' };
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    return { skipped: `unparsable (${String(e.message || e).slice(0, 80)})` };
  }
  const completed = raw?.completed;
  if (!completed || typeof completed !== 'object' || Array.isArray(completed)) {
    return { removed: 0, changed: false };
  }
  let removed = 0;
  for (const date of Object.keys(completed)) {
    const row = completed[date];
    if (!row || typeof row !== 'object') continue;
    for (const id of SPEAKING_TASK_IDS) {
      if (Object.prototype.hasOwnProperty.call(row, id)) { delete row[id]; removed += 1; }
    }
  }
  if (!removed) return { removed: 0, changed: false };
  if (apply) {
    const backupFile = await backup(file);
    await atomicJsonWrite(file, raw);
    return { removed, changed: true, backup: backupFile };
  }
  return { removed, changed: true, dryRun: true };
}

/** 收集所有需要处理的数据文件 */
async function collect() {
  const targets = [];
  for (const name of ['learning_attempts.json', 'study_plan.json']) {
    const file = join(dataDir, name);
    if (existsSync(file)) targets.push(file);
  }
  const usersDir = join(dataDir, 'users');
  if (existsSync(usersDir)) {
    const entries = await readdir(usersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const name of ['learning_attempts.json', 'study_plan.json']) {
        const file = join(usersDir, entry.name, name);
        if (existsSync(file)) targets.push(file);
      }
    }
  }
  return targets;
}

const files = await collect();
console.log(`speaking purge: ${apply ? 'APPLY' : 'DRY-RUN'} · data dir = ${dataDir} · files = ${files.length}`);
let totalRemoved = 0;
let touched = 0;
for (const file of files) {
  const kind = file.endsWith('learning_attempts.json') ? 'attempts' : 'plan';
  const result = kind === 'attempts' ? await purgeAttempts(file) : await purgePlan(file);
  const label = file.replace(dataDir, 'data');
  if (result.skipped) {
    console.log(`SKIP ${label}: ${result.skipped}`);
    continue;
  }
  if (!result.changed) {
    console.log(`OK   ${label}: nothing to purge`);
    continue;
  }
  touched += 1;
  totalRemoved += result.removed;
  const extra = result.backup ? ` · backup=${result.backup.replace(dataDir, 'data')}` : '';
  console.log(`${apply ? 'DONE' : 'WOULD'} ${label}: removed=${result.removed}${result.total !== undefined ? ` of ${result.total}` : ''}${extra}`);
}
console.log(`speaking purge: ${touched} file(s) ${apply ? 'updated' : 'would change'}, ${totalRemoved} record(s) ${apply ? 'removed' : 'to remove'}`);
if (apply && totalRemoved === 0) console.log('speaking purge: nothing to do (idempotent)');