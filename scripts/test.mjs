import { cp, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)));
});

await run(process.execPath, ['--check', 'server.js']);
await run(process.execPath, ['--check', 'public/app.js']);
await run(process.execPath, ['--check', 'public/sw.js']);
await run(process.execPath, ['scripts/study-plan-smoke.mjs']);
await run(process.execPath, ['scripts/tts-smoke.mjs']);
await run(process.execPath, ['scripts/today-response-smoke.mjs']);
await run(process.execPath, ['scripts/today-snapshot-smoke.mjs']);
await run(process.execPath, ['scripts/frontend-refinement-smoke.mjs']);
await run(process.execPath, ['scripts/mobile-device-check.mjs', '--emulated']);
await run(process.execPath, ['scripts/external-body-cache-smoke.mjs']);
await run(process.execPath, ['scripts/ecdict-smoke.mjs']);
await run(process.execPath, ['scripts/ecdict-bubble-ui-smoke.mjs']);
await run(process.execPath, ['scripts/exam-analysis-smoke.mjs']);
await run(process.execPath, ['scripts/vocab-chat-smoke.mjs']);   // v3.8.1：词汇精练单次会话请求数回归
await run(process.execPath, ['scripts/tutor-drill-smoke.mjs']);  // v4.1.0：AI 带练回合语义（出题/判分/推进/降级）
await run(process.execPath, ['scripts/method-smoke.mjs']);       // v4.8.0：学习方法回合语义 + 折算 SRS + 账本
await run(process.execPath, ['scripts/static-cache-smoke.mjs']); // v3.8.2：静态资源条件请求 + 复制入口 HTTP 降级
await run(process.execPath, ['scripts/exam-analysis-audit.mjs', '--strict']);

const sandbox = await mkdtemp(join(tmpdir(), 'workbench-test-'));
let server;
try {
  await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
  await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
  await cp(join(root, 'corpus'), join(sandbox, 'corpus'), { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 1000);
  server = spawn(process.execPath, ['server.js'], {
    cwd: sandbox,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), AUTH_RATE_MAX: '20' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/auth/status`)).ok; } catch { await delay(100); }
  }
  if (!ready) throw new Error('test server did not start');

  const status = await fetch(`${base}/api/auth/status`);
  if (status.headers.get('x-content-type-options') !== 'nosniff') throw new Error('missing security headers');
  if (status.headers.get('x-frame-options') !== 'DENY') throw new Error('missing frame protection');
  if (!status.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")) throw new Error('missing CSP');
  const css = await fetch(`${base}/style.css`);
  if (css.status !== 200 || !css.headers.get('content-type')?.includes('text/css')) throw new Error(`static CSS was not served: ${css.status}`);
  const app = await fetch(`${base}/app.js`);
  if (app.status !== 200 || !app.headers.get('content-type')?.includes('javascript')) throw new Error(`static JS was not served: ${app.status}`);
  const traversal = await fetch(`${base}/images/%2e%2e/server.js`);
  if (![403, 404].includes(traversal.status)) throw new Error(`image traversal was not rejected: ${traversal.status}`);
  const publicTraversal = await fetch(`${base}/%2e%2e/server.js`);
  if (![403, 404].includes(publicTraversal.status)) throw new Error(`public traversal was not rejected: ${publicTraversal.status}`);
  const crossSite = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ token: 'nope' }),
  });
  if (crossSite.status !== 403) throw new Error(`cross-site write was not rejected: ${crossSite.status}`);
  let limited = false;
  for (let i = 0; i < 22; i++) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }),
    });
    if (response.status === 429) limited = true;
  }
  if (!limited) throw new Error('auth rate limit did not trigger');
  console.log('security smoke: passed');
} finally {
  if (server) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
  for (let i = 0; i < 10; i++) {
    try { await rm(sandbox, { recursive: true, force: true }); break; }
    catch (err) { if (err.code !== 'EBUSY' || i === 9) throw err; await delay(100); }
  }
}
