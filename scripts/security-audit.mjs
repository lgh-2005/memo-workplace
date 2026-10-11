#!/usr/bin/env node
/** v3.4.2：源码与文档敏感信息扫描。输出只含路径、行号和类型，不回显匹配内容。 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : root;
const scanRoot = rootArg || root;
const jsonOutput = args.includes('--json');
const binaryExt = /\.(?:png|jpe?g|gif|ico|webp|pdf|gz|zip|tar|woff2?|mp3)$/i;
const patterns = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['cloud-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ['bearer-token', /\bAuthorization\s*[:=]\s*[`'\"]\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ['secret-assignment', /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*[`'\"][^`'\"\r\n]{16,}[`'\"]/i],
];
function candidateFiles() {
  const result = spawnSync('git', ['-C', scanRoot, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' });
  if (result.status === 0) return [...new Set(result.stdout.split('\0').filter(Boolean))];
  return [];
}
const findings = [];
const candidates = candidateFiles();
for (const rel of candidates) {
  if (/^(?:data|corpus|node_modules|\.git)\//.test(rel) || binaryExt.test(rel) || rel.endsWith('.lock')) continue;
  const full = join(scanRoot, rel);
  if (!existsSync(full)) continue;
  let text; try { text = await readFile(full, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [kind, pattern] of patterns) if (pattern.test(line)) findings.push({ file: rel, line: index + 1, kind });
  });
}
const result = { ok: findings.length === 0, scanned: candidates.length, findings };
if (jsonOutput) console.log(JSON.stringify(result));
else {
  if (!findings.length) console.log(`security audit passed: scanned ${result.scanned} tracked/worktree files; no sensitive patterns found`);
  else {
    for (const item of findings) console.error(`FAIL ${item.file}:${item.line} [${item.kind}]`);
    console.error(`security audit failed: ${findings.length} finding(s); matched values are intentionally hidden`);
  }
}
if (findings.length) process.exitCode = 1;
