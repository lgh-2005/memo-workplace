#!/usr/bin/env node
/**
 * v3.5.1：严格「今日」作答筛选隔离沙箱回归。
 * 覆盖：
 *  - /api/words?filter=today_forget / today_vague / today_wellfamiliar 只收当天作答
 *  - 历史（昨天）作答与旧版 lastResponse 不得混入今日筛选
 *  - 工作台测验当天结果（quizLastAt 为北京时间今天）计入今日筛选
 *  - /api/quiz/sources 返回 today_forget / today_vague 计数
 *  - /api/learning/vocab/generate 接受 today_forget / today_vague，拒绝非法 filter
 */
import { cp, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const sandbox = await mkdtemp(join(tmpdir(), 'workbench-today-'));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - 86400000));
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
  const words = {
    w1: { vocId: 'w1', spelling: 'apple', today: { date: today, firstResponse: 'FORGET', isFinished: true } },
    w2: { vocId: 'w2', spelling: 'banana', today: { date: today, firstResponse: 'VAGUE', isFinished: true } },
    w3: { vocId: 'w3', spelling: 'cherry', today: { date: yesterday, firstResponse: 'FORGET', isFinished: true } },
    w4: { vocId: 'w4', spelling: 'durian', today: { date: today, firstResponse: 'WELL_FAMILIAR', isFinished: true } },
    w5: { vocId: 'w5', spelling: 'elder', today: { date: today, firstResponse: 'FAMILIAR', isFinished: false } },
    w6: { vocId: 'w6', spelling: 'fig', lastResponse: 'FORGET', quizResponse: 'FORGET', quizLastAt: new Date().toISOString() },
    w7: { vocId: 'w7', spelling: 'grape', lastResponse: 'FORGET', quizResponse: 'FORGET', quizLastAt: new Date(Date.now() - 86400000).toISOString() },
  };
  await writeFile(join(sandbox, 'data', 'db.json'), JSON.stringify({
    words, glosses: {}, todayItems: [], progressHistory: [], notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [], planTotal: 7,
  }));
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
    llm: { mock: true, activeId: 'x', providers: [{ id: 'x', name: 'x', baseUrl: '', apiKey: '', model: 'mock' }] },
    autoSync: { enabled: false, minutes: 60 }, auth: { enabled: false, token: '' }, multiUser: false,
  }));
  const port = 19200 + Math.floor(Math.random() * 300);
  server = spawn(process.execPath, ['server.js'], { cwd: sandbox, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(base + '/api/auth/status')).ok; } catch { await delay(100); }
  }
  assert(ready, 'today-response sandbox server did not start');

  const names = async f => {
    const r = await fetch(base + '/api/words?filter=' + f);
    const d = await r.json();
    return (d.words || []).map(w => w.spelling).sort();
  };
  const tf = await names('today_forget');
  const tv = await names('today_vague');
  const tw = await names('today_wellfamiliar');
  const leg = await names('forget');
  assert(JSON.stringify(tf) === JSON.stringify(['apple', 'fig']), 'today_forget mismatch: ' + JSON.stringify(tf));
  assert(JSON.stringify(tv) === JSON.stringify(['banana']), 'today_vague mismatch: ' + JSON.stringify(tv));
  assert(JSON.stringify(tw) === JSON.stringify(['durian']), 'today_wellfamiliar mismatch: ' + JSON.stringify(tw));
  assert(!tf.includes('cherry') && !tf.includes('grape'), 'historical forget leaked into today_forget');
  assert(leg.includes('cherry') && leg.includes('grape'), 'legacy forget must remain historical-inclusive');

  const sr = await fetch(base + '/api/quiz/sources');
  const sd = await sr.json();
  assert(sd.sources.today_forget === 2, 'sources.today_forget expected 2, got ' + sd.sources.today_forget);
  assert(sd.sources.today_vague === 1, 'sources.today_vague expected 1, got ' + sd.sources.today_vague);

  const mode = await fetch(base + '/api/quiz/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'today_forget', count: 2 }),
  });
  const md = await mode.json();
  assert(mode.status === 200 && md.ok === true, 'quiz/generate today_forget rejected: ' + JSON.stringify(md).slice(0, 160));

  const tg = await fetch(base + '/api/learning/vocab/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filter: 'today_forget', count: 1 }),
  });
  assert(tg.status === 200, 'vocab/generate today_forget rejected: ' + tg.status);

  const bad = await fetch(base + '/api/learning/vocab/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filter: 'bogus', count: 1 }),
  });
  assert(bad.status === 400, 'bogus filter should be rejected');

  console.log('today-response smoke: passed');
} finally {
  if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('close', resolve)); }
  for (let i = 0; i < 10; i++) {
    try { await rm(sandbox, { recursive: true, force: true }); break; }
    catch { await delay(100); }
  }
}
