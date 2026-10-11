#!/usr/bin/env node
/** v3.4.1：线上只读健康检查，不调用任何持久化写接口。 */
const args = process.argv.slice(2);
const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (valueOf('--url') || process.env.WORKBENCH_ONLINE_URL || 'http://127.0.0.1:5178').replace(/\/$/, '');
const expectedVersion = valueOf('--expected-version') || process.env.WORKBENCH_EXPECTED_VERSION || '';
const timeoutMs = Number(valueOf('--timeout') || 10000);
const jsonOutput = args.includes('--json');
const checks = [];
const fetchCheck = async (name, path, predicate) => {
  try {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
    const result = await predicate(response, body, headers);
    checks.push({ name, ok: response.ok && result.ok !== false, status: response.status, detail: result.detail || '' });
  } catch (error) {
    checks.push({ name, ok: false, status: 0, detail: String(error.message || error) });
  }
};
await fetchCheck('auth status', '/api/auth/status', (r, body) => {
  let parsed; try { parsed = JSON.parse(body); } catch { return { ok: false, detail: 'invalid JSON' }; }
  return { ok: typeof parsed === 'object' && typeof parsed.enabled === 'boolean', detail: `multiUser=${Boolean(parsed.multiUser)}` };
});
await fetchCheck('application shell', '/', (r, body, headers) => ({
  ok: !expectedVersion || body.includes(`v${expectedVersion}`),
  detail: headers['content-type'] || '',
}));
await fetchCheck('manifest', '/manifest.webmanifest', (r, body, headers) => ({
  ok: headers['content-type']?.includes('manifest+json') && (!expectedVersion || body.includes(`v${expectedVersion}`) || body.includes('英语')), detail: headers['content-type'] || '',
}));
await fetchCheck('service worker', '/sw.js', (r, body) => ({
  ok: !expectedVersion || body.includes(`wb-shell-v${expectedVersion}`), detail: 'shell cache checked',
}));
await fetchCheck('security headers', '/', (r, body, headers) => ({
  ok: headers['x-content-type-options'] === 'nosniff' && headers['x-frame-options'] === 'DENY' && (headers['content-security-policy'] || '').includes("frame-ancestors 'none'"),
  detail: 'nosniff/frame/CSP',
}));
const failed = checks.filter(x => !x.ok);
const result = { ok: failed.length === 0, base, expectedVersion: expectedVersion || null, checks };
if (jsonOutput) console.log(JSON.stringify(result));
else {
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${check.status}) ${check.detail}`);
  console.log(`online health: ${result.ok ? 'passed' : `${failed.length} failed`}`);
}
if (!result.ok) process.exitCode = 1;
