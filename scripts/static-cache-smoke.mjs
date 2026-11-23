#!/usr/bin/env node
/**
 * v3.8.2：静态资源条件请求（ETag/Last-Modified/304）+ 复制入口 HTTP 降级 隔离回归。
 *
 * 背景（两条都是线上实测出来的，不是推测）：
 *  ① 线上 nginx 的 gzip_types 只覆盖 text/html，app.js / style.css 完全没压缩；服务端又对
 *     public/ 下每个文件打 `Cache-Control: no-store`。实测首屏 index(41KB gzip) +
 *     app.js(429KB 未压缩) + style.css(192KB 未压缩) ≈ 663KB，关掉再开**照样再传 663KB**，
 *     等于零缓存。
 *  ② 线上以 `http://IP` 访问时，window.isSecureContext=false、navigator.clipboard===undefined，
 *     于是四处「复制」按钮要么抛 TypeError、要么落进空 catch 变成「点了没反应」。
 *
 * 本套件锁死三个契约：
 *  A. 静态资源回 no-cache + ETag + Last-Modified + Vary，且条件请求命中 304 零字节；
 *  B. /api/* 继续保持 no-store（前端改完立刻可见，不得被缓存策略反向破坏）；
 *  C. 前端所有复制走统一入口 copyText，且该入口在 navigator.clipboard 缺失时能靠
 *     execCommand 真正复制成功（用浏览器实测，不看源码「看起来对」）。
 *
 * 断言数：22。全部为正向契约，无恒真断言 —— 把 server.js 的静态分支还原成 no-store
 * 会让 A 组全红；把 app.js 的 copyText 调用换回裸 navigator.clipboard.writeText 会让 C 组全红。
 */
import { cp, mkdtemp, mkdir, rm, writeFile, readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const checks = [];
const T = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

const sandbox = await mkdtemp(join(tmpdir(), 'workbench-static-cache-'));
const port = 19750 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
let server;
let browser;

try {
  await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
  await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
  await mkdir(join(sandbox, 'corpus'), { recursive: true });
  await writeFile(join(sandbox, 'corpus', 'records.jsonl'), '');
  await writeFile(join(sandbox, 'corpus', 'exams.jsonl'), '');
  await mkdir(join(sandbox, 'data'), { recursive: true });
  await writeFile(join(sandbox, 'data', 'db.json'), JSON.stringify({ words: {}, glosses: {}, notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [] }));
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
    llm: { mock: true, activeId: 'x', providers: [{ id: 'x', name: 'x', baseUrl: '', apiKey: '', model: 'mock' }] },
    autoSync: { enabled: false, minutes: 60 }, auth: { enabled: false }, multiUser: false,
  }));

  server = spawn(process.execPath, ['server.js'], {
    cwd: sandbox,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = (await fetch(base + '/api/auth/status')).ok; } catch { await delay(100); }
  }
  if (!ready) throw new Error('static cache sandbox server did not start');

  /* ---------- A. 静态资源头 ---------- */
  const js = await fetch(base + '/app.js');
  const jsBody = await js.text();
  const jsEtag = js.headers.get('etag');
  const jsLastMod = js.headers.get('last-modified');
  T('static js served', js.status === 200 && jsBody.length > 0, `status=${js.status} bytes=${jsBody.length}`);
  T('static js cache-control is no-cache (not no-store)', js.headers.get('cache-control') === 'no-cache', `got ${js.headers.get('cache-control')}`);
  T('static js has strong ETag', typeof jsEtag === 'string' && /^"[^"]+"$/.test(jsEtag), `got ${jsEtag}`);
  T('static js has Last-Modified', !!jsLastMod && !Number.isNaN(Date.parse(jsLastMod)), `got ${jsLastMod}`);
  T('static js has Vary: Accept-Encoding', String(js.headers.get('vary') || '').toLowerCase().includes('accept-encoding'), `got ${js.headers.get('vary')}`);
  T('static js Content-Length matches body', Number(js.headers.get('content-length')) === Buffer.byteLength(jsBody), `header=${js.headers.get('content-length')} body=${Buffer.byteLength(jsBody)}`);

  const css = await fetch(base + '/style.css');
  const cssEtag = css.headers.get('etag');
  T('static css served with own ETag', css.status === 200 && !!cssEtag && cssEtag !== jsEtag, `status=${css.status} etag=${cssEtag}`);

  const indexHtml = await fetch(base + '/');
  T('index served with ETag', indexHtml.status === 200 && !!indexHtml.headers.get('etag'), `status=${indexHtml.status}`);

  /* ---------- B. 条件请求 ---------- */
  const inm = await fetch(base + '/app.js', { headers: { 'If-None-Match': jsEtag } });
  const inmBody = await inm.text();
  T('If-None-Match match yields 304', inm.status === 304, `status=${inm.status}`);
  T('304 body is empty', inmBody.length === 0, `bytes=${inmBody.length}`);
  T('304 still carries ETag', inm.headers.get('etag') === jsEtag, `got ${inm.headers.get('etag')}`);

  const ims = await fetch(base + '/app.js', { headers: { 'If-Modified-Since': new Date(Date.now() + 60000).toUTCString() } });
  T('If-Modified-Since future yields 304', ims.status === 304, `status=${ims.status}`);

  const stale = await fetch(base + '/app.js', { headers: { 'If-None-Match': '"deadbeef"' } });
  T('stale If-None-Match yields 200', stale.status === 200, `status=${stale.status}`);

  // RFC 9110 §13.1.3：有 If-None-Match 时忽略 If-Modified-Since —— 过期 ETag + 未来日期必须回 200
  const precedence = await fetch(base + '/app.js', {
    headers: { 'If-None-Match': '"deadbeef"', 'If-Modified-Since': new Date(Date.now() + 60000).toUTCString() },
  });
  T('If-None-Match takes precedence over If-Modified-Since', precedence.status === 200, `status=${precedence.status}`);

  const oldIms = await fetch(base + '/app.js', { headers: { 'If-Modified-Since': new Date(Date.now() - 86400000 * 30).toUTCString() } });
  T('old If-Modified-Since yields 200', oldIms.status === 200, `status=${oldIms.status}`);

  /* ---------- HEAD ---------- */
  const head = await fetch(base + '/app.js', { method: 'HEAD' });
  const headBody = await head.text();
  T('HEAD returns 200', head.status === 200, `status=${head.status}`);
  T('HEAD has no body', headBody.length === 0, `bytes=${headBody.length}`);
  T('HEAD keeps Content-Length', Number(head.headers.get('content-length')) === Buffer.byteLength(jsBody), `got ${head.headers.get('content-length')}`);

  /* ---------- ETag 随内容变化（防「改了文件用户还拿旧缓存」） ---------- */
  await appendFile(join(sandbox, 'public', 'app.js'), '\n/* etag-change-probe */\n');
  const changed = await fetch(base + '/app.js');
  const changedEtag = changed.headers.get('etag');
  T('ETag changes when file content changes', !!changedEtag && changedEtag !== jsEtag, `${jsEtag} -> ${changedEtag}`);
  const oldTagStillHits = await fetch(base + '/app.js', { headers: { 'If-None-Match': jsEtag } });
  T('old ETag no longer yields 304 after change', oldTagStillHits.status === 200, `status=${oldTagStillHits.status}`);

  /* ---------- C. API 仍必须 no-store ---------- */
  const api = await fetch(base + '/api/auth/status');
  T('API keeps Cache-Control no-store', api.headers.get('cache-control') === 'no-store', `got ${api.headers.get('cache-control')}`);

  /* ---------- D. 前端契约（源码层） ---------- */
  const appSrc = await readFile(join(root, 'public', 'app.js'), 'utf8');
  T('app.js defines copyText helper', /async function copyText\(text\)/.test(appSrc));
  // 先剥离块注释：copyText 的 JSDoc 里就写着 `navigator.clipboard.writeText(...)` 作为说明文字，
  // 不剥离会把文档示例误算成真实调用（首版断言就是这么误报的）
  const appCode = appSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const clipboardCalls = (appCode.match(/navigator\.clipboard\.writeText\(/g) || []).length;
  T('app.js has exactly one navigator.clipboard.writeText call (inside helper)', clipboardCalls === 1, `found ${clipboardCalls}`);
  T('helper falls back to document.execCommand(copy)', /execCommand\(\s*['"]copy['"]\s*\)/.test(appSrc));
  const helperBody = appSrc.slice(appSrc.indexOf('async function copyText(text)'), appSrc.indexOf('async function copyText(text)') + 2200);
  T('helper restores prior selection Range', /getRangeAt/.test(helperBody) && /addRange/.test(helperBody));

  /* ---------- E. 浏览器实测降级真的能复制 ---------- */
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });

  const withClipboard = await page.evaluate(async () => (typeof copyText === 'function' ? await copyText('hello-direct') : 'no-helper'));
  T('copyText works via Clipboard API when available', withClipboard === true, `returned ${withClipboard}`);

  // 模拟线上 HTTP/IP 非安全上下文：Chrome 里 navigator.clipboard 直接不存在
  const fallback = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    if (navigator.clipboard !== undefined) return 'could-not-remove-clipboard';
    return await copyText('hello-fallback');
  });
  T('copyText falls back to execCommand when clipboard is absent', fallback === true, `returned ${fallback}`);

  const inputPreserved = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const p = document.createElement('p');
    p.id = 'sel-preserve-probe';
    p.textContent = 'selection must survive copy';
    document.body.appendChild(p);
    const r = document.createRange();
    r.selectNodeContents(p);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    await copyText('overwrites-clipboard-only');
    const alive = s.rangeCount > 0 && s.toString() === 'selection must survive copy';
    p.remove();
    return alive;
  });
  T('user selection survives the fallback copy', inputPreserved === true, `survived=${inputPreserved}`);

  const emptySafe = await page.evaluate(async () => (await copyText('') === false && await copyText(null) === false));
  T('empty/null text returns false without throwing', emptySafe === true);
} finally {
  if (browser) { try { await browser.close(); } catch { /* 静默 */ } }
  if (server) {
    server.kill('SIGTERM');
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 3000); });
  }
  for (let i = 0; i < 10; i++) {
    try { await rm(sandbox, { recursive: true, force: true }); break; }
    catch (err) { if (err.code !== 'EBUSY' || i === 9) throw err; await delay(100); }
  }
}

const failed = checks.filter(c => !c.ok);
console.log(`\nstatic cache smoke: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(`FAILED (${failed.length}): ${failed.map(f => f.name).join(', ')}`);
  process.exitCode = 1;
}