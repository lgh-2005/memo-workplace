import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)));
});

await run(process.execPath, ['--check', 'server.js']);
await run(process.execPath, ['--check', 'public/app.js']);
await run(process.execPath, ['--check', 'public/sw.js']);

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
