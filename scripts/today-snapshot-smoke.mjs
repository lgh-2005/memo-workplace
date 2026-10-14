#!/usr/bin/env node
/**
 * v3.5.2：今日词表快照清理隔离沙箱回归。
 * 覆盖：同步时以本次 get_today_items 快照为唯一真源——
 *  - 先清空所有旧 w.today（含跨天残留），再按快照重建
 *  - 墨墨返回 0 条时，所有 w.today 被清空
 *  - 返回部分词时，仅这些词带 w.today，其余清空
 *  - db.todayItems 与 w.today 保持一致
 * 通过 MAIMEMO_BASE 环境变量注入假墨墨服务端。
 */
import { cp, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const sandbox = await mkdtemp(join(tmpdir(), 'workbench-today-snap-'));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - 86400000));
let server;
let fakeMm;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// 假墨墨：today_items 由外部变量控制；其余接口返回空成功
let fakeTodayItems = [];
function startFakeMm() {
  return new Promise(resolve => {
    fakeMm = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url, 'http://localhost');
      const ok = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, errors: [], data: body })); };
      if (url.pathname.endsWith('/study/get_today_items')) return ok({ today_items: fakeTodayItems });
      if (url.pathname.endsWith('/study/get_study_progress')) return ok({ progress: { finished: 0, total: 0, study_time: 0 } });
      if (url.pathname.endsWith('/study/query_study_records')) return ok({ records: [], count: 0 });
      return ok({});
    });
    fakeMm.listen(0, '127.0.0.1', () => resolve(fakeMm.address().port));
  });
}

try {
  const mmPort = await startFakeMm();
  await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
  await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
  await cp(join(root, 'tools'), join(sandbox, 'tools'), { recursive: true });
  await mkdir(join(sandbox, 'corpus'), { recursive: true });
  await writeFile(join(sandbox, 'corpus', 'records.jsonl'), '');
  await writeFile(join(sandbox, 'corpus', 'exams.jsonl'), '');
  await mkdir(join(sandbox, 'data'), { recursive: true });

  // 预置：a/b 为今日快照残留（昨天），c 有 lastResponse 无 today
  const seedWords = {
    a: { vocId: 'a', spelling: 'apple', today: { date: yesterday, firstResponse: 'FORGET', isFinished: true }, lastResponse: 'FAMILIAR' },
    b: { vocId: 'b', spelling: 'banana', today: { date: yesterday, firstResponse: 'VAGUE', isFinished: true }, lastResponse: 'FAMILIAR' },
    c: { vocId: 'c', spelling: 'cherry', lastResponse: 'FORGET' },
  };
  const writeDb = async words => writeFile(join(sandbox, 'data', 'db.json'), JSON.stringify({
    words, glosses: {}, todayItems: [{ voc_spelling: 'stale', voc_id: 'x' }], progressHistory: [], notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [], planTotal: 3,
  }));
  await writeDb(seedWords);
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
    maimemoToken: 'test-token', llm: { mock: true, activeId: 'x', providers: [{ id: 'x', name: 'x', baseUrl: '', apiKey: '', model: 'mock' }] },
    autoSync: { enabled: false, minutes: 60 }, auth: { enabled: false, token: '' }, multiUser: false,
  }));

  const port = 19400 + Math.floor(Math.random() * 300);
  server = spawn(process.execPath, ['server.js'], {
    cwd: sandbox,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MAIMEMO_BASE: `http://127.0.0.1:${mmPort}/open/api/v1/memo` },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(base + '/api/auth/status')).ok; } catch { await delay(100); }
  }
  assert(ready, 'snapshot sandbox server did not start');

  const doSync = async () => {
    const r = await fetch(base + '/api/sync', { method: 'POST' });
    return { status: r.status, body: await r.json() };
  };

  // 场景 1：墨墨返回 2 条 → 旧残留应被清空，仅新快照带 today
  fakeTodayItems = [
    { voc_id: 'a', voc_spelling: 'apple', first_response: 'FORGET', is_new: false, is_finished: true },
    { voc_id: 'd', voc_spelling: 'durian', first_response: 'VAGUE', is_new: true, is_finished: false },
  ];
  let r = await doSync();
  assert(r.status === 200 && r.body.ok === true, 'sync 1 not ok: ' + JSON.stringify(r.body));
  let dbRaw = JSON.parse(await (await import('node:fs/promises')).readFile(join(sandbox, 'data', 'db.json'), 'utf8'));
  let withToday = Object.values(dbRaw.words).filter(w => w.today);
  assert(withToday.length === 2, 'scenario1: expected 2 words with today, got ' + withToday.length);
  assert(dbRaw.words.a.today.date === today && dbRaw.words.a.today.firstResponse === 'FORGET', 'scenario1: apple today not refreshed');
  assert(dbRaw.words.d && dbRaw.words.d.today && dbRaw.words.d.today.firstResponse === 'VAGUE', 'scenario1: durian new today missing');
  assert(!dbRaw.words.b.today, 'scenario1: banana stale today not cleared');
  assert(!withToday.some(w => w.today.date === yesterday), 'scenario1: yesterday snapshot survived');
  assert(Array.isArray(dbRaw.todayItems) && dbRaw.todayItems.length === 2, 'scenario1: todayItems not aligned');

  // 场景 2：墨墨返回 1 条 → 仅该词带 today，其余清空
  fakeTodayItems = [
    { voc_id: 'c', voc_spelling: 'cherry', first_response: 'FAMILIAR', is_new: false, is_finished: true },
  ];
  r = await doSync();
  assert(r.body.ok === true, 'sync 2 not ok');
  dbRaw = JSON.parse(await (await import('node:fs/promises')).readFile(join(sandbox, 'data', 'db.json'), 'utf8'));
  withToday = Object.values(dbRaw.words).filter(w => w.today);
  assert(withToday.length === 1 && withToday[0].spelling === 'cherry', 'scenario2: expected only cherry, got ' + JSON.stringify(withToday.map(w => w.spelling)));
  assert(!dbRaw.words.a.today && !dbRaw.words.d.today, 'scenario2: previous today not cleared');
  assert(dbRaw.words.c.lastResponse === 'FORGET', 'scenario2: lastResponse must be preserved');

  // 场景 3：墨墨返回 0 条 → 所有 w.today 清空，todayItems 清空
  fakeTodayItems = [];
  r = await doSync();
  assert(r.body.ok === true, 'sync 3 not ok');
  dbRaw = JSON.parse(await (await import('node:fs/promises')).readFile(join(sandbox, 'data', 'db.json'), 'utf8'));
  withToday = Object.values(dbRaw.words).filter(w => w.today);
  assert(withToday.length === 0, 'scenario3: empty snapshot must clear all today, got ' + withToday.length);
  assert(dbRaw.todayItems.length === 0, 'scenario3: todayItems must be empty');
  assert(dbRaw.words.c.lastResponse === 'FORGET', 'scenario3: word data must survive clearing');

  // 同步日志应包含清理计数
  const logMsg = (dbRaw.syncLog || []).map(s => s.msg).join(' | ');
  assert(/清理旧快照/.test(logMsg) || /今日词表 0 条/.test(logMsg), 'sync log missing cleanup info: ' + logMsg.slice(0, 160));

  console.log('today-snapshot smoke: passed');
} finally {
  if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('close', resolve)); }
  if (fakeMm) await new Promise(resolve => fakeMm.close(resolve));
  for (let i = 0; i < 10; i++) {
    try { await rm(sandbox, { recursive: true, force: true }); break; }
    catch (err) { if (err.code !== 'EBUSY' || i === 9) { /* ignore */ } await delay(100); }
  }
}
