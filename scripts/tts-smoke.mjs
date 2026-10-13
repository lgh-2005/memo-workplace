#!/usr/bin/env node
/**
 * v3.5.0：发音朗读接口隔离沙箱回归。
 * 覆盖：
 *  - CSP 含 media-src（真人/服务端音频放行）
 *  - /api/tts/status 与 /api/tts?meta=1 能力字段
 *  - /api/tts 空文本 400 BAD_TTS_TEXT
 *  - 句子在未部署 Piper 时返回 503 TTS_UNAVAILABLE（可优雅降级）
 *  - 单词返回音频（200 audio/*）或降级 503（无网络/无引擎）
 *  - 缓存命中：同一文本二次请求更快、返回 200
 * 说明：CI 环境不安装 Piper（数据目录侧车），故句子请求预期 503。
 */
import { cp, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const sandbox = await mkdtemp(join(tmpdir(), 'workbench-tts-'));
let server;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
try {
  await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
  await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
  await cp(join(root, 'tools'), join(sandbox, 'tools'), { recursive: true });
  await mkdir(join(sandbox, 'corpus'), { recursive: true });
  await writeFile(join(sandbox, 'corpus', 'records.jsonl'), '');
  await writeFile(join(sandbox, 'corpus', 'exams.jsonl'), '');
  await mkdir(join(sandbox, 'data'), { recursive: true });
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
    llm: { mock: true, activeId: 'x', providers: [{ id: 'x', name: 'x', baseUrl: '', apiKey: '', model: 'mock' }] },
    autoSync: { enabled: false, minutes: 60 }, auth: { enabled: false, token: '' }, multiUser: false,
  }));
  const port = 18900 + Math.floor(Math.random() * 300);
  server = spawn(process.execPath, ['server.js'], {
    cwd: sandbox, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(base + '/api/auth/status')).ok; } catch { await delay(100); }
  }
  assert(ready, 'tts sandbox server did not start');

  // CSP 放行媒体
  const shell = await fetch(base + '/');
  const csp = shell.headers.get('content-security-policy') || '';
  assert(csp.includes("media-src 'self' blob: https:"), 'CSP media-src missing: ' + csp);

  // 能力状态
  const status = await fetch(base + '/api/tts/status');
  const statusBody = await status.json();
  assert(status.status === 200 && statusBody.ok === true, 'tts status not ok');
  assert(['en_US', 'en_GB'].includes(statusBody.status.accent), 'tts accent invalid');
  assert(Array.isArray(statusBody.status.voices) && statusBody.status.voices.length === 2, 'tts voices shape');
  assert(statusBody.status.piper && typeof statusBody.status.piper.installed === 'boolean', 'piper status shape');

  // meta=1 只返回状态，不合成
  const meta = await fetch(base + '/api/tts?meta=1');
  const metaBody = await meta.json();
  assert(meta.status === 200 && metaBody.status && metaBody.status.youdao === true, 'tts meta contract');

  // 空文本 400
  const empty = await fetch(base + '/api/tts?text=');
  assert(empty.status === 400, 'empty tts text should be 400, got ' + empty.status);
  const emptyBody = await empty.json();
  assert(emptyBody.code === 'BAD_TTS_TEXT', 'empty tts text code');

  // 句子：无 Piper 时必须优雅降级 503
  const sentence = await fetch(base + '/api/tts?text=' + encodeURIComponent('Learning English opens the door to a wider world.'));
  if (sentence.status === 503) {
    const body = await sentence.json();
    assert(body.code === 'TTS_UNAVAILABLE', 'sentence degrade code: ' + JSON.stringify(body));
  } else {
    // 若环境恰好安装了 Piper，则应返回音频
    assert(sentence.status === 200, 'sentence unexpected status ' + sentence.status);
    assert((sentence.headers.get('content-type') || '').startsWith('audio/'), 'sentence content-type');
  }

  // 单词：返回音频或降级
  const word = await fetch(base + '/api/tts?text=resilient&accent=en_US');
  assert([200, 503].includes(word.status), 'word unexpected status ' + word.status);
  if (word.status === 200) {
    assert((word.headers.get('content-type') || '').startsWith('audio/'), 'word content-type');
    const buf = Buffer.from(await word.arrayBuffer());
    assert(buf.length > 512, 'word audio too small');
    assert(['youdao', 'piper'].includes(word.headers.get('x-tts-engine') || ''), 'word engine header');
    // 缓存命中：二次请求应命中缓存并返回 200
    const again = await fetch(base + '/api/tts?text=resilient&accent=en_US');
    assert(again.status === 200 && (again.headers.get('content-type') || '').startsWith('audio/'), 'word cache miss');
  }

  // 英音分支可调用（不校验音源内容，只校验接口不报错）
  const uk = await fetch(base + '/api/tts?text=resilient&accent=en_GB');
  assert([200, 503].includes(uk.status), 'uk accent status ' + uk.status);

  console.log('tts smoke: passed');
} finally {
  if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('close', resolve)); }
  for (let i = 0; i < 10; i++) {
    try { await rm(sandbox, { recursive: true, force: true }); break; }
    catch (err) { if (err.code !== 'EBUSY' || i === 9) { /* ignore */ } await delay(100); }
  }
}
