#!/usr/bin/env node
/** v3.3.5：产品文档、版本标识与工作手册的一致性检查。 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = String(pkg.version);
const marker = `v${version}`;
const checks = [];
const checkFile = async (file, label, needles) => {
  if (!existsSync(file)) { checks.push({ label, ok: false, detail: 'missing' }); return; }
  const text = await readFile(file, 'utf8');
  const missing = needles.filter(needle => !text.includes(needle));
  checks.push({ label, ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : 'ok' });
};
await checkFile(join(root, 'public', 'index.html'), 'index version', [marker]);
await checkFile(join(root, 'public', 'sw.js'), 'service worker version', [marker, `wb-shell-${marker}`]);
await checkFile(join(root, 'server.js'), 'developer log version', [`version: '${version}'`]);
for (const file of ['DEPLOY.md', 'SECURITY.md', 'TESTING.md', 'CI_PLATFORM.md']) {
  await checkFile(join(root, file), `${file} version`, [marker]);
}
const workspaceRoot = dirname(root);
if (existsSync(join(workspaceRoot, 'AGENTS.md'))) {
  await checkFile(join(workspaceRoot, 'AGENTS.md'), 'AGENTS current version', [`当前交付版本：${marker}`, marker]);
  await checkFile(join(workspaceRoot, '版本号经历.md'), 'version history section', [`## ${marker} ·`]);
} else {
  checks.push({ label: 'external work manual', ok: true, detail: 'skipped outside workspace checkout' });
}
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.label}: ${check.detail}`);
const failed = checks.filter(x => !x.ok);
if (failed.length) throw new Error(`docs consistency failed: ${failed.map(x => x.label).join(', ')}`);
console.log(`docs consistency passed: ${checks.length}`);
