#!/usr/bin/env node
/**
 * v4.8.0：学习方法（费曼 / 苏格拉底 / 对比辨析 / 空白回忆）隔离回归。
 *
 * 为什么需要它：方法课的价值不在「接口 200」，而在四件容易悄悄坏掉的事——
 *   ① 四套方法必须是同一引擎、不同关卡机，而不是四份复制粘贴的代码；
 *   ② 关卡推进必须由服务端决定：答对进关、答错留在本关、末关才出结果，
 *      不能让模型自由发挥说「你过了」；
 *   ③ 结果必须真的落进 quiz_srs（明天回到复习队列）与 learning_attempts
 *      （报告里能看见），以及 method_ledger（哪种方法对哪些词有效）；
 *   ④ 未配置模型 / 上游吐非 JSON / 坏 roundId 一律降级，绝不把学习者卡死。
 * 因此这里用「假上游 LLM」观测服务端真正发出的 messages 与调用次数。
 *
 * 断言分组：
 *  A. 前端契约：方法页存在、三个方法入口、不使用 innerHTML 拼用户文本。
 *  B. 回合语义：开局 / 答对进关 / 答错留本关 / 末关出结果 / 结算入库。
 *  C. 降级：未知方法 400、无词 400、未配置 no_llm、坏 JSON bad_task、过期 expired。
 *  D. SRS 与账本：独立答对 → good、提示后 → hard、仍需补教 → again；账本按方法聚合。
 */
import { mkdtemp, rm, mkdir, writeFile, copyFile, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const root = fileURLToPath(new URL('..', import.meta.url));
const checks = [];
const T = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

/* ============ A. 前端源码契约（静态） ============ */
const htmlSrc = await readFile(join(root, 'public', 'index.html'), 'utf8');
const appSrc = await readFile(join(root, 'public', 'app.js'), 'utf8');

T('学习方法页存在，并与词汇精练共用子版块导航',
  ['methodPane', 'methodRoster', 'methodStageCard', 'methodBody', 'methodEffectCard'].every(id => htmlSrc.includes('id="' + id + '"')) &&
  htmlSrc.includes('data-sub="method"'));
T('四个方法入口都在前端注册表里',
  ['feynman', 'socratic', 'contrast', 'blank'].every(id => appSrc.includes(id + ':') && appSrc.includes('/api/method/start')));
T('方法页的作答文本一律走文本节点 / mdLite，不拼进 innerHTML 直接插入用户输入',
  !appSrc.includes('.innerHTML = answer') && !appSrc.includes('innerHTML = `<div>${answer'));

/* ============ 假上游 LLM ============ */
/** 依据 system prompt 里的方法名与 user 里的「判分 / 开局」分派回复。 */
function makeFakeLLM(opts = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', c => { buf += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf); } catch { /* ignore */ }
      const msgs = body.messages || [];
      const sys = String(msgs.find(m => m.role === 'system')?.content || '');
      const user = msgs.filter(m => m.role === 'user').map(m => String(m.content)).join('\n');
      const isMethod = sys.includes('教练') && (/费曼|苏格拉底|对比辨析|空白回忆/.test(sys));
      hits.push({ kind: isMethod ? 'method' : 'other', sys, user });
      if (!isMethod) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] })); return; }

      let content;
      if (opts.badJson && user.includes('【开局】')) {
        content = '好的，我先给你讲讲这个词的用法……';
      } else if (user.includes('学习者作答')) {
        const answerLine = (user.match(/学习者作答：([\s\S]*?)\n/) || [])[1] || '';
        const wrong = /不会|不知道|wrong/.test(answerLine);
        content = JSON.stringify(wrong
          ? { status: 'reteach', coaching: '这里还差一个依据。', gap: '没说出你从句子里哪一处看出来的。' }
          : { status: 'pass', coaching: '讲清楚了，也用上了具体的场景。', gap: '', model: '可以这样记：先看它改变了什么。' });
      } else {
        content = JSON.stringify({ say: opts.badJson ? '' : '先别急着查词典。', question: opts.badQuestion ? '' : '用你自己的话讲讲：这个词在这句里改变了什么？', placeholder: '用你自己的话写下来' });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return { server, hits };
}

async function makeSandbox() {
  const sb = await mkdtemp(join(tmpdir(), 'workbench-method-'));
  await copyFile(join(root, 'server.js'), join(sb, 'server.js'));
  await copyFile(join(root, 'package.json'), join(sb, 'package.json'));
  await mkdir(join(sb, 'public'), { recursive: true });
  for (const f of await readdir(join(root, 'public'))) {
    if (f.endsWith('.js') || f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.webmanifest')) {
      await copyFile(join(root, 'public', f), join(sb, 'public', f));
    }
  }
  await mkdir(join(sb, 'corpus'), { recursive: true });
  await writeFile(join(sb, 'corpus', 'records.jsonl'), '');
  await writeFile(join(sb, 'corpus', 'exams.jsonl'), '');
  await mkdir(join(sb, 'data'), { recursive: true });
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  await writeFile(join(sb, 'data', 'db.json'), JSON.stringify({
    words: {
      w0: { id: 1, spelling: 'abandon', tags: [], today: { date: today, isNew: true, isFinished: false } },
      w1: { id: 2, spelling: 'postpone', tags: [], today: { date: today, isNew: false, isFinished: false } },
    },
    glosses: {
      abandon: { phonetic: '/əˈbændən/', pos: 'v.', gloss: '放弃；抛弃' },
      postpone: { phonetic: '/pəˈspəʊn/', pos: 'v.', gloss: '推迟；延期' },
    },
    progressHistory: [], todayItems: [1, 2], notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [],
  }, null, 2));
  return sb;
}

async function boot(sandbox, llmPort, appPort) {
  const cfg = llmPort
    ? { llm: { mock: false, activeId: 'p', providers: [{ id: 'p', name: 'p', baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'k', model: 'fake' }] }, autoSync: { enabled: false, minutes: 60 } }
    : { llm: { mock: false, activeId: '', providers: [] }, autoSync: { enabled: false, minutes: 60 } };
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify(cfg, null, 2));
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(appPort), ECDICT_HOME: join(sandbox, 'no-ecdict') };
  const server = spawn(process.execPath, ['server.js'], { cwd: sandbox, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${appPort}`;
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    try { ready = (await fetch(base + '/api/auth/status')).ok; } catch { await delay(100); }
  }
  if (!ready) { server.kill(); throw new Error('sandbox server did not start'); }
  return { server, base, sandbox };
}

const postJson = async (base, path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const getJson = async (base, path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/* ============ B. 回合语义（假上游正常） ============ */
{
  const llm = makeFakeLLM();
  const llmPort = 18641, appPort = 18642;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const base = booted.base;

    // B1 开局：只出第 1 关、只有一个问题、不带答案
    const before = llm.hits.length;
    const start = await postJson(base, '/api/method/start', { method: 'feynman', words: ['abandon'], goal: '讲清楚' });
    T('费曼开局只出一道题，且只调用一次上游',
      start.body.ok && start.body.stage === 'plain' && start.body.stageIndex === 0 && start.body.stageCount === 3 &&
      typeof start.body.task?.question === 'string' && llm.hits.length === before + 1);
    T('开局题目不带任何「标准答案」字段，作答前不泄底',
      !Object.hasOwn(start.body.task || {}, 'expected') && !Object.hasOwn(start.body.task || {}, 'answer') &&
      !Object.hasOwn(start.body, 'feedback'));
    T('开局把词条事实（词典释义）交给上游',
      /\u62ab\u5f03|\u653e\u5f03/.test(llm.hits.at(-1).user) && llm.hits.at(-1).sys.includes('费曼'));

    // B2 答对 → 先给通过反馈，由 continue 推进关卡（服务端决定能不能过）
    const a1 = await postJson(base, '/api/method/turn', { roundId: start.body.roundId, revision: start.body.revision, move: 'answer', answer: '放弃这件事，之后不再继续' });
    T('答对后服务端判定 pass，但关卡要等 continue 才推进',
      a1.body.ok && a1.body.feedback?.status === 'pass' && a1.body.stage === 'plain' && !a1.body.result);
    const cont = await postJson(base, '/api/method/turn', { roundId: start.body.roundId, revision: a1.body.revision, move: 'continue' });
    T('进入下一关时重新出题（不是复用上一关题干）',
      cont.body.ok && cont.body.stage === 'probe' && cont.body.stageIndex === 1 && typeof cont.body.task?.question === 'string' && !cont.body.feedback);

    // B3 答错 → 留在本关，不给过
    const wrong = await postJson(base, '/api/method/turn', { roundId: start.body.roundId, revision: cont.body.revision, move: 'answer', answer: '不会' });
    T('答错判 reteach，关卡不前进',
      wrong.body.ok && wrong.body.feedback?.status === 'reteach' && wrong.body.stage === 'probe' && wrong.body.feedback?.gap && !wrong.body.result);
    const retry = await postJson(base, '/api/method/turn', { roundId: start.body.roundId, revision: wrong.body.revision, move: 'retry' });
    T('答错后可重答，且重答被记为「提示后答对」',
      retry.body.ok && retry.body.assisted === true && !retry.body.feedback && retry.body.stage === 'probe');

    // B4 末关答对 → 出结果 assisted（因为走了 retry）
    const probeOk = await postJson(base, '/api/method/turn', { roundId: start.body.roundId, revision: retry.body.revision, move: 'answer', answer: '它改变了主语的状态，后面的人不必再处理' });
    T('第 2 关通过后仍不给最终结果', probeOk.body.ok && probeOk.body.feedback?.status === 'pass' && !probeOk.body.result);
    const toLast = await postJson(base, '/api/method/turn', { roundId: start.body.roundId, revision: probeOk.body.revision, move: 'continue' });
    T('推进到最后一关（第 3 关）', toLast.body.ok && toLast.body.stage === 'refine' && toLast.body.stageIndex === 2);
    const last = await postJson(base, '/api/method/turn', { roundId: start.body.roundId, revision: toLast.body.revision, move: 'answer', answer: '一句话：丢下就不管了，之后再回来处理' });
    T('最后一关通过后给出 assisted（走过重答）',
      last.body.ok && last.body.feedback?.status === 'pass' && last.body.result === 'assisted');

    // B5 结算：写 SRS + 流水 + 账本
    const settled = await postJson(base, '/api/method/settle', { roundId: start.body.roundId });
    T('结算把 assisted 折算成 hard 写进记忆引擎',
      settled.body.ok && settled.body.grade === 'hard' && settled.body.applied === 1 && settled.body.attemptsSaved === 1);

    const srsRaw = JSON.parse(await readFile(join(sb, 'data', 'quiz_srs.json'), 'utf8'));
    const srsWord = srsRaw.words?.abandon;
    T('记忆引擎里确有该词，且评分与到期时间都已写入',
      !!srsWord && srsWord.lastGrade === 'hard' && typeof srsWord.dueAt === 'string' &&
      new Date(srsWord.dueAt).getTime() > Date.now() && srsWord.lastResult === 'vague');

    const attempts = await getJson(base, '/api/learning/attempts?kind=method_practice&limit=10');
    T('学习流水里出现 method_practice，且带方法名与结果',
      attempts.body.ok && attempts.body.total === 1 && attempts.body.attempts[0].meta?.method === 'feynman' &&
      attempts.body.attempts[0].meta?.methodResult === 'assisted' && attempts.body.attempts[0].source === 'method:feynman');

    const eff = await getJson(base, '/api/method/effect?days=30');
    const fRow = eff.body.methods?.find(m => m.id === 'feynman');
    T('方法效果按方法聚合，独立/提示/补教三档都有计数',
      eff.body.ok && fRow && fRow.runs === 1 && fRow.assisted === 1 && fRow.words === 1 && fRow.soloRate === 0);

    // B6 未知方法一律 400，不静默降级
    const badMethod = await postJson(base, '/api/method/start', { method: 'speed-reading', words: ['abandon'] });
    T('未知方法直接 400，不偷偷换成别的方法', badMethod.status === 400 && badMethod.body.reason === 'bad_method');
    const noWords = await postJson(base, '/api/method/start', { method: 'feynman', words: [] });
    T('没选词直接 400', noWords.status === 400 && noWords.body.reason === 'bad_words');

    // B7 未结束不能结算
    const s2 = await postJson(base, '/api/method/start', { method: 'blank', words: ['postpone'] });
    const early = await postJson(base, '/api/method/settle', { roundId: s2.body.roundId });
    T('没做完就结算被拒（不会把未完成的练习记成答错）',
      early.status === 400 && early.body.reason === 'not_finished');
    T('四个方法都能开局（苏格拉底 / 对比辨析 / 空白回忆）',
      (await postJson(base, '/api/method/start', { method: 'socratic', words: ['abandon'] })).body.ok &&
      (await postJson(base, '/api/method/start', { method: 'contrast', words: ['abandon'] })).body.ok &&
      (await postJson(base, '/api/method/start', { method: 'blank', words: ['abandon'] })).body.ok);
    const list = await getJson(base, '/api/method/list');
    T('方法清单接口列出四套方法与各自关卡',
      list.body.ok && list.body.methods.length === 4 &&
      list.body.methods.every(m => m.stages.length === 3 && m.title && m.need));
  } finally {
    server?.kill();
    await delay(300);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
    await new Promise(r => llm.server.close(r));
  }
}

/* ============ C. independent / needs_work 两条结果路径 + 降级 ============ */
{
  // C1 全程一次答对 → independent → good
  const llm = makeFakeLLM();
  const llmPort = 18651, appPort = 18652;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const base = booted.base;
    const s = await postJson(base, '/api/method/start', { method: 'contrast', words: ['abandon', 'postpone'], goal: '辨析' });
    let rev = s.body.revision;
    let roundId = s.body.roundId;
    for (let stage = 0; stage < 3; stage++) {
      const a = await postJson(base, '/api/method/turn', { roundId, revision: rev, move: 'answer', answer: '一处是永久停止，一处是延后继续' });
      rev = a.body.revision;
      if (a.body.result) { T('全程一次答对给出 independent', a.body.result === 'independent'); break; }
      const c = await postJson(base, '/api/method/turn', { roundId, revision: rev, move: 'continue' });
      rev = c.body.revision;
    }
    const done = await postJson(base, '/api/method/settle', { roundId });
    T('independent 折算成 good 进记忆引擎', done.body.ok && done.body.grade === 'good');
    const raw = JSON.parse(await readFile(join(sb, 'data', 'quiz_srs.json'), 'utf8'));
    T('good 档把掌握度推进、且不进错题本',
      raw.words?.abandon?.lastGrade === 'good' && raw.words.abandon.mastery >= 1 &&
      !(raw.wrongBook || []).some(x => x.spelling === 'abandon' && !x.resolved));
  } finally {
    server?.kill();
    await delay(300);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
    await new Promise(r => llm.server.close(r));
  }
}

{
  // C2 末关连错两次 → needs_work → again 进错题本
  const llm = makeFakeLLM();
  const llmPort = 18653, appPort = 18654;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const base = booted.base;
    const s = await postJson(base, '/api/method/start', { method: 'blank', words: ['postpone'], goal: '' });
    let rev = s.body.revision, roundId = s.body.roundId;
    // 前两关一次过，第三关连错两次
    for (let stage = 0; stage < 2; stage++) {
      const a = await postJson(base, '/api/method/turn', { roundId, revision: rev, move: 'answer', answer: '推迟，还没发生' });
      rev = a.body.revision;
      const c = await postJson(base, '/api/method/turn', { roundId, revision: rev, move: 'continue' });
      rev = c.body.revision;
    }
    const w1 = await postJson(base, '/api/method/turn', { roundId, revision: rev, move: 'answer', answer: '不会' });
    rev = w1.body.revision;
    T('末关第一次答错仍不给结果，留在本关', w1.body.feedback?.status === 'reteach' && !w1.body.result);
    const rt = await postJson(base, '/api/method/turn', { roundId, revision: rev, move: 'retry' });
    rev = rt.body.revision;
    const w2 = await postJson(base, '/api/method/turn', { roundId, revision: rev, move: 'answer', answer: '不知道' });
    rev = w2.body.revision;
    T('末关第二次也答错才记 needs_work（不会无限卡住）', w2.body.result === 'needs_work');
    const done = await postJson(base, '/api/method/settle', { roundId });
    T('needs_work 折算成 again 进记忆引擎', done.body.ok && done.body.grade === 'again');
    const raw = JSON.parse(await readFile(join(sb, 'data', 'quiz_srs.json'), 'utf8'));
    T('again 档进错题本，明天回炉',
      raw.words?.postpone?.lastGrade === 'again' &&
      (raw.wrongBook || []).some(x => x.spelling === 'postpone' && !x.resolved));
    const ledger = JSON.parse(await readFile(join(sb, 'data', 'method_ledger.json'), 'utf8'));
    T('方法账本落盘且 schemaVersion=1、只记结果不记作答原文',
      ledger.schemaVersion === 1 && ledger.entries.length === 1 && ledger.entries[0].method === 'blank' &&
      ledger.entries[0].result === 'needs_work' && !Object.hasOwn(ledger.entries[0], 'answer'));
  } finally {
    server?.kill();
    await delay(300);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
    await new Promise(r => llm.server.close(r));
  }
}

{
  // C3 降级：未配置模型 / 上游吐非 JSON / 坏 roundId
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, 0, 18655);
    server = booted.server;
    const base = booted.base;
    const noLlm = await postJson(base, '/api/method/start', { method: 'feynman', words: ['abandon'] });
    T('未配置服务商时返回 ok:false/no_llm，而不是 5xx', noLlm.status === 200 && noLlm.body.ok === false && noLlm.body.reason === 'no_llm');
    const badRound = await postJson(base, '/api/method/turn', { roundId: 'nope', revision: 0, move: 'answer', answer: 'x' });
    T('坏 roundId 一律 expired，不 500', badRound.status === 200 && badRound.body.ok === false && badRound.body.reason === 'expired');
    const badSettle = await postJson(base, '/api/method/settle', { roundId: 'nope' });
    T('坏 roundId 结算也是 expired', badSettle.body.ok === false && badSettle.body.reason === 'expired');
  } finally {
    server?.kill();
    await delay(300);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

{
  // C4 上游吐非 JSON → bad_task；题目缺问题时也 bad_task
  const llm = makeFakeLLM({ badJson: true });
  const llmPort = 18656, appPort = 18657;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const base = booted.base;
    const bad = await postJson(base, '/api/method/start', { method: 'socratic', words: ['abandon'] });
    T('上游吐非 JSON 时 ok:false/bad_task，前端可重试', bad.status === 200 && bad.body.ok === false && bad.body.reason === 'bad_task');
  } finally {
    server?.kill();
    await delay(300);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
    await new Promise(r => llm.server.close(r));
  }
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length} checks, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;