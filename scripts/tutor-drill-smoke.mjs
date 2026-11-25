#!/usr/bin/env node
/**
 * v4.1.0：「AI 带练」隔离回归（词汇精练从「单向讲解」升级为「出题 → 作答 → 判分 → 推进」）。
 *
 * 为什么需要它：带练的核心不是接口返回 200，而是**回合语义**——
 *   ① 开局只出题、不带判分，且必须是一次可作答的结构化题目；
 *   ② 作答时服务端把「题干 + 选项 + 学习者答案」一起交给上游，拿回判分与下一关题目；
 *   ③ 第三关答完即通关（task=null / wordFinished=true），不再多打一次上游；
 *   ④ 上游没配置、返回不合约定、题目结构缺斤少两时一律降级（ok:false 或 400），
 *      不能让学习者卡在一个出不了题的界面里。
 * 因此这里用「假上游 LLM」观测服务端真正发出的 messages 与调用次数，而不是只看状态码。
 *
 * 断言：
 *  A. 前端契约与学习导图流程；旧接口保留兼容。
 *  B. 回合语义：开局出题 / 作答判分 + 下一题 / 答错留在本关 / 二次错放行 / 第三关通关。
 *  C. 降级：缺 word 400、坏题目结构 400、未配置服务商 no_llm、上游吐非 JSON bad_json、选项不足 bad_task。
 *  D. v4.2.0 联动：多词一起进上下文 / focus 只认组内词 / 模型不给 focus 时按题干兜底 / 词数上限与去重。
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

T('悬浮词表与学习导图是词汇精练的新入口', ['wordFab', 'wordPanel', 'coachMap', 'coachTree'].every(id => htmlSrc.includes('id="' + id + '"')));
T('旧联动和快捷按钮已移除', !['drillGroupBtn', 'quickRow', 'imgGenChip', 'webSearchChip'].some(id => htmlSrc.includes('id="' + id + '"')));

/* ============ 假上游 LLM ============ */
const DRILL_TASK_OPEN = {
  type: 'choice',
  prompt: '「abandon」最接近下面哪个意思？',
  options: ['放弃，抛弃', '获得，得到', '坚持，固守', '隐藏，遮蔽'],
  placeholder: '',
};
const DRILL_TASK_NEXT = {
  type: 'blank',
  prompt: 'The crew had to ___ the sinking ship.（填一个动词，表示「放弃」）',
  options: [],
  placeholder: '填一个动词',
};

/** kind: 'ok' | 'bad_json' | 'bad_task'；opts.focus: 'good' | 'foreign' | 'none'（联动 focus 归属用） */
function makeFakeLLM(kind = 'ok', opts = {}) {
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
      const isDrill = sys.includes('带练教练');
      const isGloss = sys.includes('英汉词典');
      hits.push({ kind: isDrill ? 'drill' : (isGloss ? 'gloss' : 'chat'), sys, user });

      let reply;
      if (sys.includes('为已经初筛的词分组')) {
        const row = { title: '是否继续执行', reason: 'abandon 是放弃，postpone 是推迟。', exercise: '判断项目取消还是改期。' };
        reply = JSON.stringify({ groups: [{ ...row, ids: [0, 9] }, { ...row, ids: [1, 0] }, { ...row, ids: [1, 2] }, { ids: [2, 3], title: '无成组理由' }] });
      } else if (sys.includes('你是英语语料学习教练')) {
        const { sources, goal, previous } = JSON.parse(user);
        const pick = sources.find(s => s.source === (previous ? 'corpus' : 'exam')) || sources[0];
        reply = JSON.stringify({ sourceId: goal === 'bad source' ? 999 : pick.id, question: '句中的词是什么意思？', options: ['推迟', '终止'], answerIndex: 1, explanation: '根据原文辨别延期与永久取消，不要把两者混为一谈。', translation: '原句参考译文。', clue: previous ? 'until the safety review concludes' : 'running out of supplies' });
      } else if (sys.includes('为该词组设计')) {
        const { previous } = JSON.parse(user);
        reply = JSON.stringify({ sentence: previous ? 'They will ___ the search until sunrise.' : 'They had to ___ the search permanently.', question: '哪个词符合语境？', answerIndex: previous ? 0 : 1, explanation: previous ? 'until sunrise 表示等到天亮后继续。' : 'permanently 表示永久放弃。' });
      } else if (sys.includes('给指定单词或短语')) {
        reply = JSON.stringify({ sentence: 'The team had to abandon the plan when funding disappeared.', question: 'abandon 在句中是什么意思？', options: ['放弃原计划', '推迟原计划'], answerIndex: 0 });
      } else if (sys.includes('根据学习者实际选中')) {
        const input = JSON.parse(user);
        reply = JSON.stringify({ term: 'postpone', evidence: input.word === 'invalid' ? '原句不存在的证据' : 'funding disappeared', reason: '资金没了，项目不再继续，而非往后延。', retest: { sentence: 'They had to ___ the trip until Friday because of the storm.', answerIndex: 1 } });
      } else if (isDrill) {
        const grading = user.includes('【待判分】');
        const finished = user.includes('这个词到此结束') || user.includes('三关全部完成');
        const answerLine = (user.match(/学习者作答：([\s\S]*)$/) || [])[1] || '';
        const wrong = /不对|wrong|不知道/.test(answerLine);
        if (kind === 'bad_json') {
          reply = '抱歉，这次我给你讲一下 abandon 的用法……';
        } else {
          const verdict = wrong
            ? { correct: false, score: 0, comment: '这里是「放弃」不是「坚持」，别被中文干扰。', hook: 'abandon 里的 band 不救你，直接丢下' }
            : { correct: true, score: 2, comment: '义项和搭配都用对了。', hook: 'abandon = 彻底放下不管' };
          // v4.2.0：联动时服务端要求 focus 落在组内词上；这里分别模拟「规规矩矩」「夹带组外词」「偷懒不给」
          const groupLine = (user.match(/【词群联动】本组 \d+ 个词：([^。]+)。/) || [])[1] || '';
          const groupWords = groupLine ? groupLine.split('/').map(s => s.trim()).filter(Boolean) : [];
          let focus = groupWords.slice(0, 1);
          if (opts.focus === 'foreign') focus = [groupWords[0] || 'abandon', 'banana'];
          else if (opts.focus === 'none') focus = [];
          if (!grading) {
            reply = JSON.stringify({ say: '先认清它最核心的意思。', verdict: null, focus: [], task: DRILL_TASK_OPEN, wordFinished: false });
          } else if (finished) {
            reply = JSON.stringify({ say: '三关都过了，可以换词。', verdict, focus, task: null, wordFinished: true });
          } else if (kind === 'bad_task') {
            reply = JSON.stringify({ say: '再来一题。', verdict, focus, task: { type: 'choice', prompt: '只有一个选项的坏题', options: ['唯一'], placeholder: '' }, wordFinished: false });
          } else {
            reply = JSON.stringify({ say: '再来一题，这次换个角度。', verdict, focus, task: DRILL_TASK_NEXT, wordFinished: false });
          }
        }
      } else if (isGloss) {
        reply = JSON.stringify({ glosses: user.split('\n').filter(Boolean).map(sp => ({ spelling: sp.trim(), phonetic: '', pos: 'v.', gloss: 'LLM-' + sp.trim() })) });
      } else {
        reply = '模拟回复。';
      }

      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, hits };
}

async function makeSandbox() {
  const sb = await mkdtemp(join(tmpdir(), 'workbench-drill-'));
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
      // v4.2.0：联动要一组词才能验证「多词一起进上下文」
      w1: { id: 2, spelling: 'give up', tags: [], today: { date: today, isNew: true, isFinished: false } },
      w2: { id: 3, spelling: 'quit', tags: [], today: { date: today, isNew: false, isFinished: false } },
    },
    glosses: {
      abandon: { phonetic: '/əˈbændən/', pos: 'v.', gloss: '放弃；抛弃' },
      'give up': { phonetic: '', pos: 'phr.', gloss: '放弃；认输' },
      quit: { phonetic: '/kwɪt/', pos: 'v.', gloss: '停止；离开；辞职' },
    },
    progressHistory: [], todayItems: [1, 2, 3], notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [],
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
  return { server, base };
}

const post = async (base, body) => {
  const res = await fetch(base + '/api/tutor/drill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/* ============ B. 回合语义（假上游正常） ============ */
{
  const llm = makeFakeLLM('ok');
  const llmPort = 18601, appPort = 18602;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const base = booted.base;

    const mapPost = async body => (await fetch(base + '/api/tutor/map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    const hitsBeforeMap = llm.hits.length;
    const map = await mapPost({ action: 'start', word: 'abandon' });
    T('导图开局隐藏正确答案，只使用一个上游请求', map.ok && map.step === 1 && !Object.hasOwn(map.task, 'answerIndex') && llm.hits.length === hitsBeforeMap + 1);
    const reply = { action: 'answer', roundId: map.roundId, step: 1, choice: 1 };
    const [wrong, concurrent] = await Promise.all([mapPost(reply), mapPost(reply)]);
    const reviews = [wrong, concurrent].filter(r => r.ok);
    T('答错后按选项联动词表外表达，重复请求最多调用一次模型', reviews.length > 0 && reviews.every(r => r.branch?.term === 'postpone' && r.branch.evidence === 'funding disappeared' && r.step === 2) && llm.hits.length === hitsBeforeMap + 2);
    const input = JSON.parse(llm.hits.at(-1).user);
    T('联动依据携带原句和真实作答', input.selected === '推迟原计划' && input.sentence === map.task.sentence);
    const retest = await mapPost({ ...reply, step: 2, choice: 1 });
    T('新语境复测判分并收束，零额外模型调用', retest.verdict?.correct && retest.step === 0 && retest.task === null && llm.hits.length === hitsBeforeMap + 2);
    const mapCorrect = await mapPost({ action: 'start', word: 'abandon' });
    const win = await mapPost({ ...reply, roundId: mapCorrect.roundId, choice: 0 });
    T('答对直接收束，不向模型索取联动', win.branch === null && win.step === 0 && llm.hits.length === hitsBeforeMap + 3);
    const mapInvalid = await mapPost({ action: 'start', word: 'invalid' });
    const invalid = await mapPost({ ...reply, roundId: mapInvalid.roundId });
    T('无法在原句核对的证据不进入导图', invalid.ok && invalid.verdict.correct === false && invalid.branch === null);
    const sample = await mapPost({ action: 'start', sample: true });
    const sampleWrong = await mapPost({ ...reply, roundId: sample.roundId });
    T('固定例题完整复用导图流程，零模型调用', sampleWrong.branch?.term === 'solve a problem' && llm.hits.length === hitsBeforeMap + 5);

    const plan = await mapPost({ action: 'plan', words: ['abandon', 'postpone', 'innovation', 'resilient'] });
    T('模型分组引用合法词，重叠或越界组被舍弃，遗漏词单独练', plan.ok && JSON.stringify(plan.groups.map(g => g.words)) === JSON.stringify([['postpone', 'abandon'], ['innovation'], ['resilient']]) && plan.groups[0].reason.includes('推迟'));
    const planInput = JSON.parse(llm.hits.at(-1).user);
    T('AI 分组收到选词及释义', planInput.length === 4 && planInput[0].word === 'abandon' && planInput[0].gloss.includes('放弃'));
    const groupStart = await mapPost({ action: 'start', words: plan.groups[0].words, goal: plan.groups[0].exercise });
    T('组题只从组内词作答，交卷前不返回答案或讲解', groupStart.ok && JSON.stringify(groupStart.task.options) === JSON.stringify(plan.groups[0].words) && !Object.hasOwn(groupStart.task, 'answerIndex') && !Object.hasOwn(groupStart.task, 'explanation'));
    const groupWrong = await mapPost({ ...reply, roundId: groupStart.roundId, choice: 0 });
    T('错选提供初题讲解与同组新语境，复测答案不提前返回', groupWrong.ok && !groupWrong.verdict.correct && groupWrong.verdict.explanation.includes('永久') && groupWrong.task.sentence !== groupStart.task.sentence && JSON.stringify(groupWrong.task.options) === JSON.stringify(groupStart.task.options) && !Object.hasOwn(groupWrong.task, 'answerIndex'));
    const groupRetest = await mapPost({ ...reply, roundId: groupStart.roundId, step: 2, choice: 0 });
    T('组题复测判分并结束', groupRetest.ok && groupRetest.step === 0 && groupRetest.verdict.correct && groupRetest.task === null);

    const examSentence = 'The explorers had to abandon the expedition after running out of supplies.';
    const articleSentence = 'The board decided to postpone the vote until the safety review concludes.';
    await writeFile(join(sb, 'corpus', 'exams.jsonl'), JSON.stringify({ id: 'exam_fixture', rtype: 'qa_set', title: '真题测试记录', meta: { year: 2025 }, items: [{ type: 'passage', section: 'reading', text: examSentence }] }) + '\n');
    await writeFile(join(sb, 'corpus', 'records.jsonl'), JSON.stringify({ id: 'import_fixture', rtype: 'article', title: '导入测试记录', text: articleSentence }) + '\n');
    const corpusStart = await mapPost({ action: 'start', words: ['abandon', 'postpone'] });
    T('真题语境由服务端原样挖空，只返回来源概要', corpusStart.task?.sentence === examSentence.replace('abandon', '___') && corpusStart.task?.source?.rid === 'exam_fixture' && !Object.hasOwn(corpusStart.task.source, 'sentence') && !Object.hasOwn(corpusStart.task, 'answerIndex'));
    const corpusAnswer = await mapPost({ action: 'answer', roundId: corpusStart.roundId, step: 1, choice: 0 });
    T('语料组题采用来源词作为权威答案，交卷还原原文和可核对线索', corpusAnswer.verdict?.correct && corpusAnswer.verdict.source.sentence === examSentence && corpusAnswer.verdict.clue === 'running out of supplies' && !!corpusAnswer.verdict.translation);
    T('复测改用另一词和语料，延伸阅读不会提前泄露复测原文', corpusAnswer.task?.sentence === articleSentence.replace('postpone', '___') && corpusAnswer.task.source.rid === 'import_fixture' && !corpusAnswer.verdict.related?.some(e => e.rid === 'import_fixture'));
    const corpusRetest = await mapPost({ action: 'answer', roundId: corpusStart.roundId, step: 2, choice: 1 });
    T('复测单独交付原句、出处和解释', corpusRetest.step === 0 && corpusRetest.verdict?.correct && corpusRetest.verdict.source.sentence === articleSentence && corpusRetest.verdict.related?.some(e => e.rid === 'exam_fixture'));
    const invalidSource = await mapPost({ action: 'start', words: ['abandon', 'postpone'], goal: 'bad source' });
    T('模型伪造来源编号只会降级为明确无出处的自拟题', invalidSource.ok && !invalidSource.task.source && invalidSource.task.sentence !== examSentence);
    const largePlan = await mapPost({ action: 'plan', words: Array.from({ length: 101 }, (_, i) => `word${i}`) });
    T('分组 API 不再拒绝超过 80 个词', largePlan.ok && largePlan.groups.flatMap(g => g.words).length === 101);

    // ① 开局
    const start = await post(base, { word: 'abandon', stage: 0 });
    T('开局返回结构化题目（choice + 4 选项）',
      start.body.ok === true && start.body.task?.type === 'choice' && start.body.task.options.length === 4,
      `type=${start.body.task?.type} options=${start.body.task?.options?.length}`);
    T('开局不带判分、停在第 1 关', start.body.verdict === null && start.body.stage === 0 && start.body.wordFinished === false);
    const h1 = llm.hits.filter(h => h.kind === 'drill');
    T('上游收到带练提示词与「开局」指令（且只调用一次）',
      h1.length === 1 && h1[0].sys.includes('带练教练') && h1[0].user.includes('开局') && h1[0].user.includes('第 1 关'),
      `hits=${h1.length}`);

    // ② 作答 → 判分 + 下一题
    const a1 = await post(base, { word: 'abandon', stage: 0, task: start.body.task, answer: '放弃，抛弃' });
    T('作答返回判分并进第 2 关',
      a1.body.ok === true && a1.body.verdict?.correct === true && a1.body.stage === 1 && a1.body.task?.type === 'blank',
      `stage=${a1.body.stage} task=${a1.body.task?.type}`);
    const h2 = llm.hits.filter(h => h.kind === 'drill').slice(-1)[0];
    T('判分请求把题干与学习者作答一并交给上游',
      h2.user.includes('【待判分】') && h2.user.includes('学习者作答：放弃，抛弃') && h2.user.includes('第 2 关'),
      h2.user.slice(0, 40).replace(/\n/g, ' '));

    // ③ 第三关答完 → 通关，不再出题
    const before = llm.hits.filter(h => h.kind === 'drill').length;
    const a3 = await post(base, {
      word: 'abandon', stage: 2, answer: 'The crew had to abandon the ship.',
      task: { type: 'write', prompt: '用 abandon 写一句英文。', options: [], placeholder: '' },
    });
    T('第三关答完即通关（task=null / wordFinished=true）',
      a3.body.ok === true && a3.body.wordFinished === true && a3.body.task === null);
    T('通关这一轮只打一次上游（不额外请求）',
      llm.hits.filter(h => h.kind === 'drill').length === before + 1);

    // ③b 答错：留在本关重考；同一关第二次仍错才放过去（避免学习者卡死在一关）
    const w1 = await post(base, { word: 'abandon', stage: 0, retry: 0, task: start.body.task, answer: '不对，我不知道' });
    T('答错留在本关重考（不进下一关）',
      w1.body.ok === true && w1.body.verdict?.correct === false && w1.body.stage === 0 && !!w1.body.task,
      `stage=${w1.body.stage}`);
    const w2 = await post(base, {
      word: 'abandon', stage: 0, retry: 1, answer: '不对',
      task: { type: 'choice', prompt: '再考一次它的意思', options: ['放弃', '坚持'], placeholder: '' },
    });
    T('同一关第二次答错也放过去（不把人卡死）', w2.body.ok === true && w2.body.stage === 1, `stage=${w2.body.stage}`);
    const w3 = await post(base, {
      word: 'abandon', stage: 2, retry: 1, answer: '不对',
      task: { type: 'blank', prompt: 'The crew had to ___ the ship.', options: [], placeholder: '动词' },
    });
    T('第 3 关最后一次答错即结束该词', w3.body.ok === true && w3.body.wordFinished === true && w3.body.task === null);

    // ④ 缺 word → 400
    const noWord = await post(base, { stage: 0 });
    T('缺少 word 返回 400', noWord.status === 400);

    // ⑤ 题目结构不完整 → 400（选项不足两个）
    const badTask = await post(base, { word: 'abandon', stage: 0, answer: 'x', task: { type: 'choice', prompt: '坏题', options: ['唯一'] } });
    T('结构不完整的题目返回 400', badTask.status === 400);
  } finally {
    if (server) server.kill();
    llm.server.close();
    await delay(200);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ C. 降级：未配置服务商 / 上游吐非 JSON / 上游题型不合约定 ============ */
{
  // C1：没有服务商 → ok:false no_llm（200，前端优雅退回自由问答）
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, null, 18604);
    server = booted.server;
    const r = await post(booted.base, { word: 'abandon', stage: 0 });
    T('未配置服务商时降级为 ok:false / no_llm',
      r.status === 200 && r.body.ok === false && r.body.reason === 'no_llm', `reason=${r.body.reason}`);
  } finally {
    if (server) server.kill();
    await delay(200);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

{
  // C2：上游回自然语言而不是 JSON → bad_json
  const llm = makeFakeLLM('bad_json');
  const llmPort = 18605, appPort = 18606;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const r = await post(booted.base, { word: 'abandon', stage: 0 });
    T('上游吐非 JSON 时降级为 ok:false / bad_json',
      r.status === 200 && r.body.ok === false && r.body.reason === 'bad_json', `reason=${r.body.reason}`);
  } finally {
    if (server) server.kill();
    llm.server.close();
    await delay(200);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

{
  // C3：上游给的 choice 只有 1 个选项 → 当作坏题拒绝（bad_task），不把半截题推给前端
  const llm = makeFakeLLM('bad_task');
  const llmPort = 18607, appPort = 18608;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const base = booted.base;
    const start = await post(base, { word: 'abandon', stage: 0 });
    const r = await post(base, { word: 'abandon', stage: 0, task: start.body.task, answer: '放弃' });
    T('上游题目选项不足时降级为 ok:false / bad_task',
      r.status === 200 && r.body.ok === false && r.body.reason === 'bad_task', `reason=${r.body.reason}`);
  } finally {
    if (server) server.kill();
    llm.server.close();
    await delay(200);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ D. v4.2.0：词群联动（整组进上下文 + focus 只认组内词） ============ */
{
  const llm = makeFakeLLM('ok', { focus: 'foreign' });
  const llmPort = 18609, appPort = 18610;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const base = booted.base;
    const group = ['abandon', 'give up', 'quit'];

    const start = await post(base, { words: group, stage: 0 });
    T('联动开局回传整组词与 group 标记',
      start.body.ok === true && Array.isArray(start.body.words) && start.body.words.length === 3 && start.body.group === true,
      `words=${JSON.stringify(start.body.words)} group=${start.body.group}`);
    const h = llm.hits.filter(x => x.kind === 'drill').slice(-1)[0];
    T('联动把整组词一起交给上游（含组内关系要求）',
      h.user.includes('【词群联动】') && h.user.includes('give up') && h.user.includes('quit'), h.user.slice(0, 48).replace(/\n/g, ' '));

    const a1 = await post(base, { words: group, stage: 0, task: start.body.task, answer: '放弃，抛弃' });
    T('focus 只接受组内词：模型夹带组外词被过滤掉',
      Array.isArray(a1.body.focus) && a1.body.focus.length === 1 && a1.body.focus[0] === 'abandon',
      `focus=${JSON.stringify(a1.body.focus)}`);
    T('联动答对同样进下一关', a1.body.ok === true && a1.body.verdict?.correct === true && a1.body.stage === 1, `stage=${a1.body.stage}`);

    const fin = await post(base, {
      words: group, stage: 2, answer: 'The crew abandoned the ship and did not quit.',
      task: { type: 'write', prompt: '用 abandon 与 quit 各写一句英文。', options: [], placeholder: '' },
    });
    T('联动三关走完整组通关（task=null / wordFinished=true）',
      fin.body.ok === true && fin.body.wordFinished === true && fin.body.task === null);
  } finally {
    if (server) server.kill();
    llm.server.close();
    await delay(200);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ E. v4.2.0：联动词表清洗 + focus 题干兜底 + 单词模式兼容 ============ */
{
  const llm = makeFakeLLM('ok', { focus: 'none' });
  const llmPort = 18611, appPort = 18612;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const base = booted.base;

    // 去重（大小写不敏感）+ 上限 5 个：乱传也不会把整份词表塞进一次请求
    const clamped = await post(base, { words: ['Abandon', 'abandon', 'quit', 'give up', 'x1', 'x2'], stage: 0 });
    T('联动词表去重并限长 5（大小写不敏感）',
      Array.isArray(clamped.body.words) && clamped.body.words.length === 5
      && clamped.body.words.filter(w => w.toLowerCase() === 'abandon').length === 1,
      JSON.stringify(clamped.body.words));

    const single = await post(base, { word: 'abandon', stage: 0 });
    T('只传 word 时仍按单词带练（words 长度 1 / group=false）',
      single.body.ok === true && single.body.words?.length === 1 && single.body.group === false);

    // 模型偷懒不给 focus：按题干里实际出现的组内词兜底（确定性，不额外打请求）
    const fb = await post(base, {
      words: ['abandon', 'give up', 'quit'], stage: 1, answer: 'The crew had to abandon the ship.',
      task: { type: 'blank', prompt: 'The crew had to ___ the ship；辨析 abandon 与 give up。', options: [], placeholder: '动词' },
    });
    T('模型不给 focus 时按题干出现的组内词兜底',
      JSON.stringify(fb.body.focus) === JSON.stringify(['abandon', 'give up']), `focus=${JSON.stringify(fb.body.focus)}`);
  } finally {
    if (server) server.kill();
    llm.server.close();
    await delay(200);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ 汇总 ============ */
const failed = checks.filter(c => !c.ok);
console.log(`\ntutor drill smoke: ${checks.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  process.exitCode = 1;
}
