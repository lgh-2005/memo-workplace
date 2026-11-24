#!/usr/bin/env node
/**
 * v3.8.0：真题参考解析 隔离沙箱回归。
 *
 * 覆盖：
 *  1. 解析库状态接口（ready/units/bySection/byTrack/sectionLabels）
 *  2. 单套真题解析聚合接口（单元排序、questionNumbers、sectionLabel）
 *  3. 单单元接口（命中 / 404 NO_ANALYSIS 优雅降级）
 *  4. 真题详情带解析覆盖信息（analysis.units / sections）
 *  5. 解析缺失时整套接口返回 ready:false 而非报错
 *  6. 损坏解析文件被跳过（skipped 计数），不影响其他单元
 *  7. 解析目录不存在时状态接口 ready:false 且不 500
 *  8. 索引缓存随文件变更自动失效（新增单元后可见）
 *  9. 解析内容结构完整性（答案一致、逐题覆盖、译文/词汇存在）
 * 10. 前端契约：无内联 on* 处理器（CSP script-src 'self' 下必须成立）、
 *     解析面板挂载点、模式切换 class 契约、CSS 关键选择器
 * 11. 生成器静态契约：repairUnescapedQuotes / parseLoose / salvageJson 行为
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const sandbox = await mkdtemp(join(tmpdir(), 'workbench-exam-analysis-'));
let server, failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { failures++; console.error('  ✗ ' + msg); } };

/* ---------- 构造最小真题 + 解析夹具 ---------- */
const EXAM_A = {
  id: 'examA', rtype: 'qa_set', track: 'kaoyan1', title: '测试套卷 A',
  text: '', meta: { year: 2024, questions: 5 },
  source: { file: 'fixture.tex', parser: 'tex', imported_at: '2026-01-01T00:00:00Z', category: '真题' },
  items: [
    { year: 2024, section: 'reading', type: 'passage', passage_id: 1,
      text: 'The Romans buried their nails in a deep pit covered with gravel. Later civilisations valued the blacksmith labour in nails more than the raw material. As Agrawal explains, early Virginians sometimes burned their houses to reclaim nails, which shows how scarce and costly this simple-seeming technology was.' },
    { year: 2024, section: 'reading', type: 'question', number: 21, passage_id: 1, qtype: '单选',
      text: 'The Romans buried the nails probably for the sake of______.',
      options: { A: 'saving them for future use.', B: 'preventing them from rusting.', C: 'increasing their value.', D: 'hiding them from the locals.' },
      answer: 'D', score: 2, answerMode: '涂卡' },
    { year: 2024, section: 'reading', type: 'question', number: 22, passage_id: 1, qtype: '单选',
      text: 'The example of early Virginians is used to______.',
      options: { A: 'explain the high cost of nails.', B: 'show the value of blacksmith labour.', C: 'criticise wasteful habits.', D: 'illustrate house building.' },
      answer: 'A', score: 2, answerMode: '涂卡' },
    { year: 2024, section: 'translation', type: 'passage', passage_id: 1,
      text: 'Some text about elephants. 〖46〗They sometimes travel more than sixty miles to find food or water.〖/46〗' },
    { year: 2024, section: 'translation', type: 'question', number: 46, qtype: '解答',
      text: 'They sometimes travel more than sixty miles to find food or water.', score: 2, answerMode: '翻译纸' },
    { year: 2024, section: 'writing', type: 'writing', number: 51, part: 'A', qtype: '作文',
      text: 'Write a reply email to an international student about a study plan.', score: 10, answerMode: '作文纸' },
  ],
};

const EXAM_B = {
  id: 'examB', rtype: 'qa_set', track: 'cet6', title: '测试套卷 B',
  text: '', meta: { year: 2023, questions: 3 },
  source: { file: 'fixture2.docx', parser: 'docx', imported_at: '2026-01-02T00:00:00Z', category: '真题' },
  items: [
    { year: 2023, section: 'listening', type: 'passage', passage_id: 1, text: '（听力录音 1–2 题·暂无本地音频）' },
    { year: 2023, section: 'listening', type: 'question', number: 1, passage_id: 1, qtype: '单选',
      text: '', options: { A: 'Preparing for a job interview.', B: 'Writing a work report.', C: 'Going through issues.', D: 'Discussing performance review.' },
      answer: 'D', score: 1, answerMode: '涂卡' },
    { year: 2023, section: 'listening', type: 'question', number: 2, passage_id: 1, qtype: '单选',
      text: '', options: { A: 'He is good at singing.', B: 'He enjoys complicated music.', C: 'He can sing any song.', D: 'He loves country music.' },
      answer: 'C', score: 1, answerMode: '涂卡' },
  ],
};

const unitReading = {
  schemaVersion: 1, id: 'examA__reading__1', examId: 'examA', track: 'kaoyan1',
  section: 'reading', sectionLabel: '阅读理解', title: '测试套卷 A', year: 2024, sub: '1',
  questionNumbers: [21, 22], generatedAt: '2026-10-27T00:00:00.000Z',
  model: 'fixture-model', provider: 'fixture', elapsedMs: 1000, usage: null, attempts: 1, warnings: [],
  analysis: {
    topic: '钉子史折射廉价技术', gist: '文章借钉子说明真正改变世界的是变得廉价的技术。',
    structure: ['第1段：罗马人埋钉', '第2段：弗吉尼亚人烧房取钉', '第3段：廉价技术改变世界'],
    difficulty: '中等',
    translation: '罗马人把钉子埋在深坑里。\n\n后来的文明更看重钉子中铁匠的劳动价值。',
    questions: [
      { number: 21, answer: 'D', type: '细节题', locate: 'they didn\'t want the local Caledonians getting their hands on', why: '原文说明是为了不让当地人得到。', traps: 'A/B/C 均与原文不符。', tip: '找因果信号词。' },
      { number: 22, answer: 'A', type: '例证题', locate: 'how scarce, costly and valuable this simple-seeming technology was', why: '例子是为了说明钉子当时昂贵。', traps: 'B 项只是次要信息。', tip: '例证题看例子前后的论点句。' },
    ],
    vocab: [{ w: 'hoard', cn: 'n. 贮藏物' }, { w: 'reclaim', cn: 'v. 取回' }, { w: 'scarce', cn: 'adj. 稀缺的' }, { w: 'gravel', cn: 'n. 砾石' }],
    longSentences: [{ en: 'Later civilisations valued the blacksmith labour in nails more than the raw material.', cn: '后来的文明更看重钉子中铁匠的劳动价值。', note: 'more than 引导比较状语。' }],
  },
};

const unitTranslation = {
  schemaVersion: 1, id: 'examA__translation__all', examId: 'examA', track: 'kaoyan1',
  section: 'translation', sectionLabel: '翻译', title: '测试套卷 A', year: 2024, sub: 'all',
  questionNumbers: [46], generatedAt: '2026-10-27T00:00:00.000Z',
  model: 'fixture-model', provider: 'fixture', elapsedMs: 1000, usage: null, attempts: 1, warnings: [],
  analysis: {
    topic: '大象的空间记忆', translation: '全文参考译文段落。',
    questions: [{ number: 46, en: 'They sometimes travel more than sixty miles to find food or water.', cn: '它们有时会跋涉六十多英里寻找食物或水。', structure: '主谓 + 目的状语。', points: ['more than 的译法', 'to find 目的状语'], pitfall: '不要把 sixty miles 译成六十公里。' }],
    vocab: [{ w: 'acre', cn: 'n. 英亩' }], skills: ['先抓主干', '再补修饰'],
  },
};

const unitWriting = {
  schemaVersion: 1, id: 'examA__writing__all', examId: 'examA', track: 'kaoyan1',
  section: 'writing', sectionLabel: '写作', title: '测试套卷 A', year: 2024, sub: 'all',
  questionNumbers: [], generatedAt: '2026-10-27T00:00:00.000Z',
  model: 'fixture-model', provider: 'fixture', elapsedMs: 1000, usage: null, attempts: 1, warnings: [],
  analysis: {
    units: [{ number: 51, part: 'A', task: '写一封回复邮件，100 词左右。', outline: ['问候并说明收到来信', '给出学习计划建议', '结尾祝愿'],
      sample: 'Dear Chris, I am glad to hear from you. Here is my suggested study plan for the coming term. First, set a daily word target. Second, read one short passage every morning. Finally, review your notes each weekend. I hope it helps. Yours, Li Ming.',
      phrases: [{ en: 'I am glad to hear from you', cn: '很高兴收到你的来信' }],
      pitfalls: ['字数不足', '格式缺失'], upgrades: [{ plain: 'I think it is good.', better: 'I believe it will pay off.', note: '表达更地道。' }] }],
    band9: ['Every small habit compounds into a remarkable result.'],
  },
};

const unitListening = {
  schemaVersion: 1, id: 'examB__listening__all', examId: 'examB', track: 'cet6',
  section: 'listening', sectionLabel: '听力理解', title: '测试套卷 B', year: 2023, sub: 'all',
  questionNumbers: [1, 2], generatedAt: '2026-10-27T00:00:00.000Z',
  model: 'fixture-model', provider: 'fixture', elapsedMs: 1000, usage: null, attempts: 1, warnings: [],
  analysis: {
    notice: '本题库未收录该场听力音频与原文，以下解析仅基于选项文本语言特征展开。',
    overview: '共 1 段材料 2 题，选项显示为职场与音乐话题。',
    strategy: ['先扫选项预判话题', '抓住疑问词类型', '注意同义替换'],
    segments: [{ pid: 1, numbers: [1, 2], sharedTopic: '职场与个人偏好', optionSignals: '第 1 题均为动名词短语，说明问 action。', tips: ['注意男女说话人区分'] }],
    coreVocab: [{ w: 'interview', cn: 'n. 面试' }, { w: 'complicated', cn: 'adj. 复杂的' }],
  },
};

const allUnits = [unitReading, unitTranslation, unitWriting, unitListening];

/* ---------- 生成器函数单测（静态抽取） ---------- */
async function testRepairHelpers() {
  const src = await readFile(join(root, 'scripts', 'exam-analysis-build.mjs'), 'utf8');
  // 按函数名定位切片，不依赖固定行文（生成器会持续演进）
  const startIdx = src.indexOf('function repairUnescapedQuotes');
  const sfIdx = src.indexOf('function stripFences');
  const plIdx = src.indexOf('function parseLoose');
  const endIdx = src.indexOf('/* ---------------- 校验 ---------------- */');
  if (startIdx < 0 || sfIdx < 0 || endIdx < 0) throw new Error('生成器解析函数定位失败');
  const code = src.slice(sfIdx, sfIdx < startIdx ? startIdx : plIdx) + '\n' + src.slice(startIdx, endIdx);
  const factory = new Function(code + '\nreturn { repairUnescapedQuotes, parseLoose, salvageJson, stripFences };');
  const { repairUnescapedQuotes, parseLoose, salvageJson, stripFences } = factory();

  // 未转义双引号修复
  const bad = '{"why":"D选项"hiding them"是对的","n":1}';
  let fixedOk = false;
  try { JSON.parse(repairUnescapedQuotes(bad)); fixedOk = true; } catch { /* noop */ }
  ok(fixedOk, '生成器：未转义双引号可被修复');
  ok(JSON.parse(repairUnescapedQuotes('{"a":"plain","b":"ok"}')).a === 'plain', '生成器：合法 JSON 修复后不变');

  // v3.8.0 真实故障形态：中文讲解里的引号**后紧接逗号**（曾被误判为字符串收尾而截断）
  const tricky = '{"cn":"中国航天进入创新发展"快车道",基础设施稳步推进。","n":1}';
  let trickyObj = null;
  try { trickyObj = JSON.parse(repairUnescapedQuotes(tricky)); } catch { /* noop */ }
  ok(!!trickyObj && String(trickyObj.cn || '').includes('快车道') === false ? false : !!trickyObj,
    '生成器：引号后紧跟逗号的畸形 JSON 可修复');
  ok(!!trickyObj && String(trickyObj.cn || '').includes('快车道'), '生成器：修复后正文完整保留（未被截断）');

  // 多组引号 + 数组内对象
  ok(!!(() => { try { JSON.parse(repairUnescapedQuotes('{"t":"他称之为"廉价技术"，并说"这改变了世界"。"}')); return true; } catch { return false; } })(),
    '生成器：多个内容引号可全部修复');
  ok(!!(() => { try { JSON.parse(repairUnescapedQuotes('[{"q":"say "yes" now"},{"q":"and "no" too"}]')); return true; } catch { return false; } })(),
    '生成器：数组内多对象引号可修复');

  // 围栏剥离
  ok(stripFences('```json\n{"a":1}\n```') === '{"a":1}', '生成器：markdown 围栏可剥离');
  // parseLoose 组合恢复（围栏 + 坏引号）
  const fenced = '```json\n{"why":"他说"你好"呢","n":2}\n```';
  ok(!!parseLoose(fenced), '生成器：围栏 + 坏引号可组合恢复');
  // salvageJson 截断抢救
  const truncated = '{"topic":"x","questions":[{"number":1,"answer":"A","why":"因为';
  const salvaged = salvageJson(truncated);
  ok(!!salvaged, '生成器：截断 JSON 可抢救出部分结构');
}

/* ---------- 解析库体检脚本单测（只读，跑真实产物） ---------- */
async function testAuditScript() {
  const auditPath = join(root, 'scripts', 'exam-analysis-audit.mjs');
  const exists = existsSync(auditPath);
  ok(exists, '体检脚本 exam-analysis-audit.mjs 存在');
  if (!exists) return;
  const src = await readFile(auditPath, 'utf8');
  // 与生成器共用同一套归一化/宽松比对规则（避免两套口径漂移）
  ok(src.includes('normQuoteFree') && src.includes('containsLoose'), '体检脚本 复用归一化与宽松比对规则');
  ok(src.includes('listening') && src.includes('segments'), '体检脚本 听力按分段校验而非逐题');
  ok(src.includes('--strict'), '体检脚本 支持 --strict 硬门禁模式');
  ok(src.includes('answerMismatch'), '体检脚本 校验答案一致性');
}

/* ---------- 启动沙箱服务 ---------- */
async function startServer() {
  await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
  await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
  await mkdir(join(sandbox, 'corpus'), { recursive: true });
  await mkdir(join(sandbox, 'data'), { recursive: true });
  await writeFile(join(sandbox, 'corpus', 'records.jsonl'), '');
  await writeFile(join(sandbox, 'corpus', 'exams.jsonl'),
    [EXAM_A, EXAM_B].map(r => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
    llm: { mock: true, activeId: 'x', providers: [{ id: 'x', name: 'x', baseUrl: '', apiKey: '', model: 'mock' }] },
    autoSync: { enabled: false, minutes: 60 }, auth: { enabled: false, token: '' }, multiUser: false,
  }));
  const dir = join(sandbox, 'corpus', 'exam_analysis');
  await mkdir(dir, { recursive: true });
  for (const u of allUnits) await writeFile(join(dir, u.id + '.json'), JSON.stringify(u), 'utf8');

  const port = 19700 + Math.floor(Math.random() * 300);
  server = spawn(process.execPath, ['server.js'], {
    cwd: sandbox,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/auth/status`)).ok; } catch { await delay(120); }
  }
  if (!ready) throw new Error('sandbox server did not start');
  return { base, dir };
}

try {
  await testRepairHelpers();
  await testAuditScript();

  const { base, dir } = await startServer();
  const getJSON = async (path) => {
    const r = await fetch(base + path);
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  /* 1. 状态接口 */
  const st = await getJSON('/api/exam/analysis/status');
  ok(st.status === 200 && st.body.ok === true, '状态接口 200 ok');
  ok(st.body.ready === true && st.body.units === 4, '状态接口 units=4 且 ready');
  ok(st.body.exams === 2, '状态接口 exams=2（题库总数）');
  ok(st.body.bySection.reading === 1 && st.body.bySection.listening === 1, '状态接口 分题型计数正确');
  ok(st.body.byTrack.kaoyan1 === 3 && st.body.byTrack.cet6 === 1, '状态接口 分考试轨计数正确');
  ok(st.body.sectionLabels && st.body.sectionLabels.writing === '写作', '状态接口 返回题型中文标签');
  ok(typeof st.body.bytes === 'number' && st.body.bytes > 0, '状态接口 返回总体字节数');
  ok(st.body.dir === 'corpus/exam_analysis', '状态接口 不暴露绝对文件系统路径');

  /* 2. 整套解析 */
  const ea = await getJSON('/api/exam/analysis/examA');
  ok(ea.status === 200 && ea.body.ready === true, '整套解析 examA 200 ready');
  ok(ea.body.count === 3, '整套解析 examA 单元数=3');
  ok(ea.body.track === 'kaoyan1' && ea.body.trackLabel === '考研英语一', '整套解析 返回考试轨信息');
  const secs = ea.body.units.map(u => u.section);
  ok(JSON.stringify(secs) === JSON.stringify([...secs].sort()), '整套解析 单元按板块稳定排序');
  const rd = ea.body.units.find(u => u.section === 'reading');
  ok(rd && rd.sub === '1' && rd.sectionLabel === '阅读理解', '整套解析 阅读单元带 sub 与中文标签');
  ok(rd && JSON.stringify(rd.questionNumbers) === JSON.stringify([21, 22]), '整套解析 携带题号列表');
  ok(rd && rd.analysis.questions.length === 2, '整套解析 内嵌逐题解析');

  /* 3. 单单元接口 */
  const one = await getJSON('/api/exam/analysis/unit/examA__reading__1');
  ok(one.status === 200 && one.body.unit.analysis.topic.includes('钉子'), '单单元接口 命中返回解析');
  const miss = await getJSON('/api/exam/analysis/unit/not_exist__reading__9');
  ok(miss.status === 404 && miss.body.code === 'NO_ANALYSIS', '单单元接口 缺失返回 404 NO_ANALYSIS');

  /* 4. 真题详情带覆盖信息 */
  const rec = await getJSON('/api/exam/record/examA');
  ok(rec.status === 200 && rec.body.record.analysis, '真题详情 携带 analysis 覆盖信息');
  ok(rec.body.record.analysis.units === 3, '真题详情 覆盖信息 units=3');
  ok(rec.body.record.analysis.sections.reading === 1, '真题详情 覆盖信息 分板块计数');

  /* 5. 无解析的套卷优雅降级 */
  await writeFile(join(sandbox, 'corpus', 'exams.jsonl'),
    [EXAM_A, EXAM_B, { ...EXAM_B, id: 'examC', title: '无解析套卷' }].map(r => JSON.stringify(r)).join('\n') + '\n');
  const noAna = await getJSON('/api/exam/analysis/examC');
  ok(noAna.status === 200 && noAna.body.ready === false && noAna.body.count === 0, '无解析套卷 返回 ready:false 而非报错');

  /* 6. 损坏解析文件被跳过 */
  await writeFile(join(dir, 'examA__banked_cloze__all.json'), '{ this is not json', 'utf8');
  const corrupt = await getJSON('/api/exam/analysis/examA');
  ok(corrupt.status === 200 && corrupt.body.skipped >= 1, '损坏解析文件 被跳过并计入 skipped');
  ok(corrupt.body.count === 3, '损坏解析文件 不影响其他单元');
  await unlink(join(dir, 'examA__banked_cloze__all.json'));

  /* 7. 索引随文件变更失效 */
  const extraUnit = { ...unitReading, id: 'examA__part_b__all', section: 'part_b', sectionLabel: '新题型', questionNumbers: [41] };
  await writeFile(join(dir, 'examA__part_b__all.json'), JSON.stringify(extraUnit), 'utf8');
  const afterAdd = await getJSON('/api/exam/analysis/examA');
  ok(afterAdd.body.count === 4, '索引缓存 随新增文件自动失效并可见');
  await unlink(join(dir, 'examA__part_b__all.json'));

  /* 8. 解析内容结构完整性 */
  ok(rd.analysis.questions.every(q => typeof q.answer === 'string' && q.answer.length > 0), '解析内容 每道题都有答案');
  ok(rd.analysis.questions.every(q => q.why && q.why.length > 10), '解析内容 每道题都有 why 讲解');
  ok(typeof rd.analysis.translation === 'string' && rd.analysis.translation.length > 10, '解析内容 含全文译文');
  ok(Array.isArray(rd.analysis.vocab) && rd.analysis.vocab.length >= 3, '解析内容 含词汇条目');
  ok(Array.isArray(rd.analysis.longSentences) && rd.analysis.longSentences.length >= 1, '解析内容 含长难句');
  const wu = ea.body.units.find(u => u.section === 'writing');
  ok(wu && Array.isArray(wu.analysis.units) && wu.analysis.units[0].sample.split(/\s+/).length > 30, '解析内容 写作含参考范文');
  const eb = await getJSON('/api/exam/analysis/examB');
  const lu = eb.body.units.find(u => u.section === 'listening');
  ok(lu && typeof lu.analysis.notice === 'string' && lu.analysis.notice.includes('未收录'), '解析内容 听力含「未收录音频」说明');
  ok(lu && !/录音(?:中|里)(?:提到|说)/.test(JSON.stringify(lu.analysis)), '解析内容 听力未编造录音内容');

  /* 9. 前端契约 */
  const appJs = await readFile(join(root, 'public', 'app.js'), 'utf8');
  const idxHtml = await readFile(join(root, 'public', 'index.html'), 'utf8');
  const css = await readFile(join(root, 'public', 'style.css'), 'utf8');
  const inlineHandlers = appJs.match(/\son(?:click|change|input|keydown|keyup|blur|focus)=/g) || [];
  ok(inlineHandlers.length === 0, `前端契约 app.js 无内联事件处理器（实际 ${inlineHandlers.length}）`);
  const htmlInline = idxHtml.match(/\son(?:click|change|input|keydown|keyup|blur|focus)=/gi) || [];
  ok(htmlInline.length === 0, `前端契约 index.html 无内联事件处理器（实际 ${htmlInline.length}）`);
  // v4.0.0：做题面下线——真题改为「语料库里的只读阅读条目 + 板块级精读附件」
  ok(!appJs.includes('exm-show-analysis') && !appJs.includes('data-exm-analyze='), '前端契约 做题面与逐题解析挂载点已下线');
  ok(appJs.includes('kbAppendExamReading') && appJs.includes('/api/exam/analysis/'), '前端契约 真题精读附件渲染存在');
  ok(appJs.includes("'/api/kb/exams'") && appJs.includes("'exam/'"), '前端契约 语料库已接入真题投影');
  ok(idxHtml.includes('data-kcat="真题"'), '前端契约 语料库保留真题筛选档');
  ok(!idxHtml.includes('id="tab-exam"') && !idxHtml.includes('id="tab-pomo"'), '前端契约 真题/番茄钟页签已下线');
  ok(!css.includes('.exm-an-panel'), '前端契约 逐题解析样式已清理');
  const deadUnit = await fetch(base + '/api/unit/records');
  ok(deadUnit.status === 404, `已删路由 /api/unit/records 返回 404（实际 ${deadUnit.status}）`);
  const deadWriting = await fetch(base + '/api/writing/history');
  ok(deadWriting.status === 404, `已删路由 /api/writing/history 返回 404（实际 ${deadWriting.status}）`);

  /* 10. 安全头未因本次改动放宽 */
  const page = await fetch(base + '/');
  const csp = page.headers.get('content-security-policy') || '';
  ok(/script-src 'self'/.test(csp), '安全 仍为 script-src self');
  ok(!/unsafe-inline/.test(csp.split('script-src')[1] || ''), '安全 script-src 未放行 unsafe-inline');
} finally {
  if (server) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
  for (let i = 0; i < 10; i++) {
    try { await rm(sandbox, { recursive: true, force: true }); break; }
    catch (err) { if (err.code !== 'EBUSY' || i === 9) throw err; await delay(120); }
  }
}

console.log(failures ? `\nexam-analysis smoke: ${failures} FAILED` : '\nexam-analysis smoke: all passed');
process.exitCode = failures ? 1 : 0;
