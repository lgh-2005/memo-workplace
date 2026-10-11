#!/usr/bin/env node
 /** v3.3.6：今日任务中心、考试计划与听说训练隔离沙箱回归。 */
 import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { spawn } from 'node:child_process';
 import { randomBytes, scryptSync } from 'node:crypto';
 import { setTimeout as delay } from 'node:timers/promises';
 
 const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
 const sandbox = await mkdtemp(join(tmpdir(), 'workbench-study-'));
 const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
 const adminSalt = randomBytes(16);
 const studentSalt = randomBytes(16);
 const adminPassword = ['admin', 'password'].join('-');
 const studentPassword = ['student', 'password'].join('-');
 const user = (id, username, role, salt, password) => ({ id, username, role, salt: salt.toString('hex'), hash: scryptSync(password, salt, 64).toString('hex'), createdAt: new Date().toISOString(), quotas: null });
 let server;
 try {
   await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
   await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
   await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
   await cp(join(root, 'corpus'), join(sandbox, 'corpus'), { recursive: true });
   await writeFile(join(sandbox, 'corpus', 'records.jsonl'), '');
   await writeFile(join(sandbox, 'corpus', 'exams.jsonl'), '');
   await mkdir(join(sandbox, 'data'), { recursive: true });
   await mkdir(join(sandbox, 'data', 'users', 'admin'), { recursive: true });
   await mkdir(join(sandbox, 'data', 'users', 'u2'), { recursive: true });
   await writeFile(join(sandbox, 'data', 'db.json'), JSON.stringify({
    words: { a: { spelling: 'practice', today: { date: today } } },
     glosses: { practice: { gloss: '练习' } }, todayItems: [{ spelling: 'practice' }],
     progressHistory: [], notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [], planTotal: 1,
   }));
   await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
     llm: { mock: true, activeId: 'x', providers: [{ id: 'x', name: 'x', baseUrl: '', apiKey: '', model: 'mock' }] },
    autoSync: { enabled: false, minutes: 60 }, auth: { enabled: true, token: '' }, multiUser: true,
   }));
   await writeFile(join(sandbox, 'data', 'users.json'), JSON.stringify({ schemaVersion: 1, nextId: 3, users: {
     admin: user('admin', 'admin', 'admin', adminSalt, adminPassword),
     u2: user('u2', 'student', 'user', studentSalt, studentPassword),
   }, invites: [] }));
   const port = 18700 + Math.floor(Math.random() * 300);
   server = spawn(process.execPath, ['server.js'], { cwd: sandbox, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
   const base = `http://127.0.0.1:${port}`;
   for (let i = 0; i < 60; i++) {
     try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
     await delay(100);
     if (i === 59) throw new Error('study sandbox server did not start');
   }
   const json = async (url, opts = {}, cookie = '') => {
    const r = await fetch(base + url, { ...opts, headers: { 'content-type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) } });
    return { response: r, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
   };
   let adminLogin = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: adminPassword }) });
   let studentLogin = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'student', password: studentPassword }) });
   if (adminLogin.response.status !== 200 || studentLogin.response.status !== 200) throw new Error('multi-user fixture login failed');
   const adminCookie = adminLogin.cookie;
   const studentCookie = studentLogin.cookie;
   let r = await json('/api/study/plan', {}, adminCookie);
   if (r.response.status !== 200 || r.body.plan.schemaVersion !== 1) throw new Error('plan GET contract failed');
   r = await json('/api/study/plan', { method: 'POST', body: JSON.stringify({ examType: 'cet6', examDate: '2027-06-15', dailyWords: 20, dailyMinutes: 45 }) }, adminCookie);
   if (r.response.status !== 200 || r.body.plan.examDate !== '2027-06-15') throw new Error('plan POST contract failed: ' + JSON.stringify(r.body));
   r = await json('/api/study/plan', { method: 'POST', body: JSON.stringify({ examDate: '2027-02-30' }) }, adminCookie);
   if (r.response.status !== 400) throw new Error('invalid exam date accepted');
   r = await json('/api/study/plan', {}, studentCookie);
   if (r.response.status !== 200 || r.body.plan.examDate || r.body.plan.dailyWords === 20) throw new Error('study plan leaked across users');
   r = await json('/api/study/tasks/complete', { method: 'POST', body: JSON.stringify({ taskId: 'exam_practice', completed: true }) }, studentCookie);
   if (r.response.status !== 200 || !r.body.tasks.find(x => x.id === 'exam_practice')?.done) throw new Error('task completion failed');
   r = await json('/api/study/tasks', {}, studentCookie);
   if (!r.body.tasks.find(x => x.id === 'exam_practice')?.done) throw new Error('task completion did not persist');
   r = await json('/api/speaking/session', { method: 'POST', body: JSON.stringify({ mode: 'listening' }) }, studentCookie);
   const listen = r.body;
   r = await json('/api/speaking/submit', { method: 'POST', body: JSON.stringify({ sessionId: listen.sessionId, answer: 'practice', inputMethod: 'manual' }) }, studentCookie);
   if (!r.body.correct || r.body.attemptsSaved !== 1) throw new Error('listening submit failed');
   r = await json('/api/speaking/submit', { method: 'POST', body: JSON.stringify({ sessionId: listen.sessionId, answer: 'practice' }) }, studentCookie);
   if (r.response.status !== 400) throw new Error('speech session was reusable');
   r = await json('/api/speaking/submit', { method: 'POST', body: JSON.stringify({ sessionId: listen.sessionId, answer: 'practice' }) }, adminCookie);
   if (r.response.status !== 400) throw new Error('speech session crossed user boundary');
   r = await json('/api/speaking/session', { method: 'POST', body: JSON.stringify({ mode: 'speaking' }) }, studentCookie);
   if (!r.body.target || !r.body.source) throw new Error('speaking source contract failed');
   r = await json('/api/speaking/submit', { method: 'POST', body: JSON.stringify({ sessionId: r.body.sessionId, answer: r.body.target, inputMethod: 'recognition' }) }, studentCookie);
   if (!r.body.correct) throw new Error('speaking submit failed');
   r = await json('/api/learning/attempts?kind=listening', {}, studentCookie);
   if (r.body.total !== 1) throw new Error('learning attempts were not recorded');
   r = await json('/api/learning/attempts?kind=listening', {}, adminCookie);
   if (r.body.total !== 0) throw new Error('learning attempts leaked across users');
   const policy = (await fetch(base + '/api/auth/status', { headers: { Cookie: studentCookie } })).headers.get('permissions-policy') || '';
   if (!policy.includes('microphone=(self)')) throw new Error('same-origin microphone policy missing');
   console.log('study plan / speech smoke: passed');
 } finally {
   if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('close', resolve)); }
   await rm(sandbox, { recursive: true, force: true });
 }
 
