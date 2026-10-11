#!/usr/bin/env node
/** v3.4.0：发布前门禁。默认只检查本地产品；--refs 检查双仓提交；--online 做线上只读健康检查。 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const repo = valueOf('--repo') || root;
const expectedSha = valueOf('--sha') || '';
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = String(pkg.version);
check('release version', version === '3.4.0', version);
for (const file of ['server.js', 'public/index.html', 'public/app.js', 'public/sw.js', 'scripts/deploy.sh', 'scripts/rollback.sh', 'scripts/backup-restore-drill.sh', 'scripts/backup-restore-drill.mjs', 'scripts/online-health.mjs', 'scripts/security-audit.mjs', 'scripts/mobile-device-check.mjs', 'scripts/docs-consistency.mjs', 'scripts/study-plan-smoke.mjs', 'scripts/frontend-refinement-smoke.mjs']) {
  check(`required file ${file}`, existsSync(join(root, file)));
}
const index = await readFile(join(root, 'public', 'index.html'), 'utf8');
const sw = await readFile(join(root, 'public', 'sw.js'), 'utf8');
check('HTML version markers', (index.match(/v3\.4\.0/g) || []).length >= 3);
check('service worker cache marker', sw.includes('wb-shell-v3.4.0'));
const diff = spawnSync('git', ['-C', root, 'diff', '--check'], { encoding: 'utf8' });
if (existsSync(join(root, '.git'))) check('git whitespace', diff.status === 0, diff.status === 0 ? '' : (diff.stderr.trim() || diff.stdout.trim()));
if (args.includes('--refs') || args.includes('--remote')) {
  const refs = {};
  const remoteOutput = spawnSync('git', ['-C', repo, 'remote', '-v'], { encoding: 'utf8' }).stdout || '';
  const configured = host => {
    const line = remoteOutput.split(/\r?\n/).find(x => x.includes(host) && /\(fetch\)$/.test(x));
    return line?.trim().split(/\s+/)[1] || `https://${host}/lgh-2005/memo-workplace.git`;
  };
  const targets = [['gitee', configured('gitee.com')], ['github', configured('github.com')]];
  for (const [name, remoteUrl] of targets) {
    const result = spawnSync('git', ['-C', repo, 'ls-remote', remoteUrl, 'refs/heads/master'], { encoding: 'utf8' });
    refs[name] = result.status === 0 ? result.stdout.trim().split(/\s+/)[0] : '';
    check(`${name} master reachable`, Boolean(refs[name]), result.stderr.trim());
  }
  check('Gitee/GitHub master match', refs.gitee && refs.gitee === refs.github, `${refs.gitee || '?'} == ${refs.github || '?'}`);
  if (expectedSha) check('target commit matches both mirrors', refs.gitee === expectedSha && refs.github === expectedSha, expectedSha);
  if (args.includes('--remote')) {
    try {
      const response = await fetch(`https://api.github.com/repos/lgh-2005/memo-workplace/actions/workflows/ci.yml/runs?branch=master&per_page=100`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'momo-release-gate' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`GitHub Actions API returned ${response.status}`);
      const body = await response.json();
      const run = (body.workflow_runs || []).find(item => item.head_sha === (expectedSha || refs.gitee));
      check('GitHub Actions completed successfully', Boolean(run && run.status === 'completed' && run.conclusion === 'success'), run ? `${run.status}/${run.conclusion}` : 'run not found for target SHA');
    } catch (error) { check('GitHub Actions API reachable', false, String(error.message || error)); }
  }
}
const onlineIndex = args.indexOf('--online');
if (onlineIndex >= 0) {
  const url = args[onlineIndex + 1];
  if (!url) throw new Error('--online requires a base URL');
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'online-health.mjs'), '--url', url, '--expected-version', version], { cwd: root, encoding: 'utf8' });
  check('online health', result.status === 0, (result.stdout || result.stderr).trim().split(/\r?\n/).at(-1) || '');
}
const failed = checks.filter(x => !x.ok);
console.log(`release gate: ${failed.length ? `${failed.length} failed` : `${checks.length} passed`}`);
if (failed.length) process.exitCode = 1;
