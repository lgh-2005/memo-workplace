#!/usr/bin/env node
/**
 * v4.9.0：单词记忆宫殿隔离回归。
 *
 * 这个功能最容易「看起来能用、其实没接上」的地方有四处，所以断言都盯着它们：
 *   ① 宫殿只是又一个孤岛？——复习结果必须真的写进 quiz_srs（明天回队列）
 *      并且落 learning_attempts（kind=palace_practice，报告里能分开统计）。
 *   ② 槽位是固定的、词是流动的：同一个槽换词时，旧词的联想不能串到新词身上。
 *   ③ AI 只出候选：/api/palace/mnemonic 只返回候选，落盘的永远是学习者确认的那一版；
 *      未配置模型 / 上游吐非 JSON 必须降级成 ok:false，不能把页面卡死。
 *   ④ 3D 子应用是独立加载的：主站零字节增长、iframe 不常驻、HTTP 下自动降级。
 *
 * 分组：A 前端与安全头契约 / B 槽位与布局 / C 复习结算进 SRS / D 降级 / E 备份结构校验。
 */
import { mkdtemp, rm, mkdir, writeFile, copyFile, readdir, readFile, readFile as readFileAsync } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

/* ============ A. 前端 / 安全头契约（静态） ============ */
const htmlSrc = await readFile(join(root, 'public', 'index.html'), 'utf8');
const appSrc = await readFile(join(root, 'public', 'app.js'), 'utf8');
const palaceHtml = await readFile(join(root, 'public', 'palace', 'index.html'), 'utf8');
const palaceJs = await readFile(join(root, 'public', 'palace', 'palace.js'), 'utf8');
const palaceCss = await readFile(join(root, 'public', 'palace', 'palace.css'), 'utf8');
const serverSrc = await readFile(join(root, 'server.js'), 'utf8');
const swSrc = await readFile(join(root, 'public', 'sw.js'), 'utf8');

T('AI 学习子版块里有「记忆宫殿」入口，且与词汇精练同一套子导航',
  htmlSrc.includes('data-sub="palace"') && htmlSrc.includes('id="palacePane"') && htmlSrc.includes('id="palaceFrame"'));
T('主站只在进入时才挂载 iframe（首屏不加载 3D，主站零字节增长）',
  /frame\.setAttribute\('src', '\/palace\/'\)/.test(appSrc) && /if \(!frame\.getAttribute\('src'\)\)/.test(appSrc));
T('子应用是独立目录，自带 three.js 与自己的样式（不拖进主站 200KB CSS）',
  existsSync(join(root, 'public', 'palace', 'index.html')) &&
  existsSync(join(root, 'public', 'palace', 'palace.js')) &&
  existsSync(join(root, 'public', 'palace', 'palace.css')) &&
  existsSync(join(root, 'public', 'palace', 'vendor', 'three.module.min.js')) &&
  !palaceHtml.includes('mist.css'));
T('静态服务能正确返回目录的 index.html（/palace/ 不是 EISDIR 崩溃）',
  serverSrc.includes('fs.statSync(filePath).isDirectory()') &&
  serverSrc.includes("path.join(filePath, 'index.html')") &&
  !/if \(false && fs\.statSync/.test(serverSrc));
T('Service Worker 不接管 /palace/（否则断网时导航会回退成主站页面）',
  swSrc.includes("url.pathname.startsWith('/palace/')"));
T('HTTP（非安全上下文）下会降级成拖动/点地面，而不是白屏或报错',
  palaceJs.includes('isSecureContext') && /canLock/.test(palaceJs) && /pickGround/.test(palaceJs));
T('子应用不用 innerHTML 拼用户文本（联想与词一律走文本节点）',
  !/innerHTML\s*=\s*[^;\n]*\$\{/.test(palaceJs) &&
  (palaceJs.includes('createTextNode') || palaceJs.includes('textContent')));
T('/palace/ 才放开被同源 iframe 嵌入，其余路径仍然 DENY / frame-ancestors none',
  serverSrc.includes("startsWith('/palace/')") &&
  serverSrc.includes("X-Frame-Options', 'SAMEORIGIN'") &&
  serverSrc.includes("X-Frame-Options', 'DENY'") &&
  serverSrc.includes("frame-ancestors ${frameAncestors}"));
T('palace.json 进备份恢复清单，并带结构校验（三处校验 + 缺文件保留）',
  (serverSrc.match(/f\.palace && !isPalaceShape\(v\.obj\)/g) || []).length >= 2 &&
  serverSrc.includes('{ file: PALACE_FILE, json: true, palace: true }') &&
  serverSrc.includes('已保留当前记忆宫殿'));
T('记忆宫殿下复习流水单独一种 kind，报告里可与测验区分',
  serverSrc.includes("'palace_practice'") && serverSrc.includes("kind: 'palace_practice'"));
/* v4.9.1 真缺陷：bindInput() 定义了却从未被调用——键盘、拖动转头、点地面、触摸
   全部不绑事件，用户进到宫殿里只能站着看，连「点编号放词」都做不到。
   单看源码「函数存在」会假通过，所以这里既查调用点，又查它必须在 renderer 建好之后调
   （直接放模块顶层会因 renderer 为 undefined 而抛错，整个子应用白屏）。 */
T('输入绑定 bindInput() 真的被调用，且在 initThree() 之后（否则白屏）',
  (palaceJs.match(/^\s*bindInput\(\)\s*;?\s*$/gm) || []).length === 1 &&
  /initThree\(\);[\s\S]{0,500}bindInput\(\);/.test(palaceJs));
T('点地面走路与拖动转头不打架（拖动结束后不能把人瞬移走）',
  palaceJs.includes('dragMoved') && /if \(S\.dragMoved\)/.test(palaceJs));
T('手机没有键盘时，轻点地面也能移动（不只剩转头）',
  /changedTouches/.test(palaceJs) && /pickGround\(t\)/.test(palaceJs));
/* 点编号必须靠射线命中，不能只认 3.3m 视线范围：操作说明写着「点编号」，
   但 slotInSight() 有距离上限，隔着房间能看见却点不动。 */
T('点编号走射线拾取，不受「靠近距离」限制（隔房间也能点开）',
  /function pickSlotAt\(/.test(palaceJs) &&
  /const picked = pickSlotAt\(ev\);/.test(palaceJs) &&
  /intersectObjects\(markers\.map/.test(palaceJs));
T('主站「开始复习」不再竞态丢指令（未就绪先排队，ready 后补发）',
  /palaceCmdQueue/.test(appSrc) && /palaceState\.ready\) send\(\)/.test(appSrc));


/* ============ 假上游 LLM ============ */
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
      const isPalace = /记忆宫殿/.test(sys) && /candidates/.test(sys);
      hits.push({ kind: isPalace ? 'palace' : 'other', sys, user });
      if (!isPalace) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
        return;
      }
      let content;
      if (opts.badJson) {
        content = '好的，我给你三个联想：一条词源的，一条谐音的，一条画面的。';
      } else {
        content = JSON.stringify({
          candidates: [
            { route: 'origin', text: 'ab-away + band 带子：把带子一扔就走了', hook: '放弃' },
            { route: 'sound', text: '“额班等”的一声，全班等不到人，散了', hook: '抛弃' },
            { route: 'scene', text: '一床被丢在雨里的旧被子', hook: '遗弃' },
          ],
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return { server, hits };
}

/* ============ 沙箱 ============ */
async function makeSandbox() {
  const sb = await mkdtemp(join(tmpdir(), 'workbench-palace-'));
  await copyFile(join(root, 'server.js'), join(sb, 'server.js'));
  await copyFile(join(root, 'package.json'), join(sb, 'package.json'));
  await mkdir(join(sb, 'public', 'palace', 'vendor'), { recursive: true });
  for (const f of await readdir(join(root, 'public'))) {
    if (f.endsWith('.js') || f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.webmanifest')) {
      await copyFile(join(root, 'public', f), join(sb, 'public', f));
    }
  }
  for (const f of await readdir(join(root, 'public', 'palace'))) {
    if (f.endsWith('.html') || f.endsWith('.js') || f.endsWith('.css')) {
      await copyFile(join(root, 'public', 'palace', f), join(sb, 'public', 'palace', f));
    }
  }
  // three.js 必须一起拷：漏了它，palace.js 的 import 直接 404，
  // 整个模块一行都不会执行（真浏览器测起来会「探针不存在」）。
  await copyFile(join(root, 'public', 'palace', 'vendor', 'three.module.min.js'),
    join(sb, 'public', 'palace', 'vendor', 'three.module.min.js'));
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
const readSrs = async (sandbox) => JSON.parse(await readFile(join(sandbox, 'data', 'quiz_srs.json'), 'utf8').catch(() => '{"words":{},"wrongBook":[]}'));

/* ============ B/C. 槽位、布局与复习结算（假上游正常） ============ */
{
  const llm = makeFakeLLM();
  const llmPort = 18741, appPort = 18742;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sb = await makeSandbox();
  let server = null;
  try {
    const booted = await boot(sb, llmPort, appPort);
    server = booted.server;
    const base = booted.base;

    // B0 目录请求必须真的返回子应用（此前的缺陷：/palace/ 被当文件读 → EISDIR 崩，
    //    表现是 ECONNRESET / 白屏。这里必须真发请求，源码字符串匹配抓不到这类缺陷。）
    let palaceOk = false, palaceDetail = '';
    try {
      const r = await fetch(base + '/palace/');
      const body = await r.text();
      palaceOk = r.status === 200 && body.includes('单词记忆宫殿') && body.includes('./palace.js');
      palaceDetail = 'status=' + r.status + ' len=' + body.length;
    } catch (e) { palaceDetail = 'request failed: ' + e.message; }
    T('/palace/ 真的能打开（返回子应用 HTML，而不是崩溃或主站页面）', palaceOk, palaceDetail);

    // B1 首次进入：拿到默认布局，槽位为空
    const st0 = await getJson(base, '/api/palace/state');
    T('首次进入给出默认布局（有房间、有位置、全部为空）',
      st0.body.ok && st0.body.palace.layout.slots.length >= 8 &&
      Object.keys(st0.body.palace.occupied).length === 0 && st0.body.stats.occupied === 0);
    const firstSlot = st0.body.palace.layout.slots[0].id;

    // B2 放词：释义来自本地词典（不是让前端传）
    const as1 = await postJson(base, '/api/palace/assign', { slotId: firstSlot, word: 'abandon' });
    T('放词时释义由服务端从本地词典补齐，前端不参与',
      as1.body.ok && as1.body.placed.word === 'abandon' && /放弃/.test(as1.body.placed.gloss) && as1.body.stats.occupied === 1);

    // B3 同槽换词：旧词的联想绝不能串到新词
    await postJson(base, '/api/palace/slot', { slotId: firstSlot, mnemonic: '这一条是 abandon 的联想', route: 'scene' });
    const as2 = await postJson(base, '/api/palace/assign', { slotId: firstSlot, word: 'postpone' });
    T('同一个位置换词时，旧词的联想与路线被清掉（不串味）',
      as2.body.ok && as2.body.placed.word === 'postpone' && as2.body.placed.mnemonic === '' && as2.body.placed.route === 'scene' &&
      /推迟/.test(as2.body.placed.gloss));

    // B4 换回原词：新词的联想不会当成旧词的
    const as3 = await postJson(base, '/api/palace/assign', { slotId: firstSlot, word: 'abandon' });
    T('换回同一个词时也不会恢复上一条已清空的联想',
      as3.body.ok && as3.body.placed.mnemonic === '');

    // B5 不存在的槽位 → 400（不静默创建）
    const bad = await postJson(base, '/api/palace/assign', { slotId: 'nope-999', word: 'abandon' });
    T('往不存在的槽位放词被拒绝（400），不静默造槽', bad.status === 400 && bad.body.ok === false);

    // B6 空 word = 取下该位置的词
    const clr = await postJson(base, '/api/palace/assign', { slotId: firstSlot, word: '' });
    T('空 word 表示把这个词从宫殿取下', clr.body.ok && clr.body.cleared === true && clr.body.stats.occupied === 0);

    // B7 联想候选：只返回候选，落盘仍是学习者那一版
    await postJson(base, '/api/palace/assign', { slotId: firstSlot, word: 'abandon' });
    const hitsBefore = llm.hits.filter(h => h.kind === 'palace').length;
    const cand = await postJson(base, '/api/palace/mnemonic', { word: 'abandon' });
    T('AI 只给 3 条候选，route 覆盖词源/谐音/画面三路',
      cand.body.ok && cand.body.candidates.length === 3 &&
      ['origin', 'sound', 'scene'].every(r => cand.body.candidates.some(c => c.route === r)) &&
      llm.hits.filter(h => h.kind === 'palace').length === hitsBefore + 1);
    T('生成候选不会直接写进宫殿（拍板这一步留给人）',
      (await getJson(base, '/api/palace/state')).body.palace.occupied[firstSlot].mnemonic === '');

    // B8 学习者拍板后保存
    const sav = await postJson(base, '/api/palace/slot', { slotId: firstSlot, mnemonic: '我自己改过的联想', route: 'sound' });
    T('保存的是学习者确认/改写后的那一版', sav.body.ok && sav.body.placed.mnemonic === '我自己改过的联想' && sav.body.placed.route === 'sound');

    // C1 复习结算：again 必须进 SRS（mastery 归零、10 分钟后到期）与错题本
    const second = (await getJson(base, '/api/palace/state')).body.palace.layout.slots[1].id;
    await postJson(base, '/api/palace/assign', { slotId: second, word: 'postpone' });
    const settle = await postJson(base, '/api/palace/settle', {
      items: [
        { slotId: firstSlot, grade: 'again', durationMs: 4200 },
        { slotId: second, grade: 'good', durationMs: 1800 },
      ],
      mode: 'review',
    });
    T('复习结算回传应用条数', settle.body.ok && settle.body.applied === 2);

    const srs = await readSrs(sb);
    T('again 真的进了记忆引擎：掌握度归零 + 10 分钟后到期',
      srs.words.abandon && srs.words.abandon.mastery === 0 && srs.words.abandon.lapses >= 1 &&
      Date.parse(srs.words.abandon.dueAt) - Date.now() < 20 * 60000);
    T('again 同时进错题本（复习想不起来就是没记住）',
      Array.isArray(srs.wrongBook) && srs.wrongBook.some(e => e.spelling === 'abandon' && !e.resolved));
    T('good 的词排到以后（间隔≥1 天），不会明天就再来',
      srs.words.postpone && srs.words.postpone.intervalDays >= 1 &&
      Date.parse(srs.words.postpone.dueAt) - Date.now() > 12 * 3600000);

    // C2 流水：kind 必须是 palace_practice，且不记作答原文
    const attempts = JSON.parse(await readFile(join(sb, 'data', 'learning_attempts.json'), 'utf8').catch(() => '{"attempts":[]}'));
    const palaceAttempts = (attempts.attempts || []).filter(a => a.kind === 'palace_practice');
    T('复习结果落 learning_attempts，kind=palace_practice（报告可分开统计）',
      palaceAttempts.length === 2 && palaceAttempts.every(a => a.source === 'palace'));

    // C3 空结算 / 未知槽位 → 400，不写脏数据
    const empty = await postJson(base, '/api/palace/settle', { items: [{ slotId: 'nope', grade: 'good' }] });
    T('没有合法记录时结算返回 400，不写脏数据', empty.status === 400 && empty.body.ok === false);

    // B9 改布局：删掉的槽位其词随之取下（词本身还在 SRS 里）
    const slots = (await getJson(base, '/api/palace/state')).body.palace.layout.slots;
    const layout = await postJson(base, '/api/palace/layout', { name: '两间屋', slots: slots.slice(0, 2) });
    T('改布局后只剩保留的位置，被删位置的词一并取下',
      layout.body.ok && layout.body.palace.layout.slots.length === 2 &&
      Object.keys(layout.body.palace.occupied).every(id => layout.body.palace.layout.slots.some(s => s.id === id)));
    T('取下词不影响 SRS 记录（数据不丢）',
      (await readSrs(sb)).words.postpone && (await readSrs(sb)).words.abandon);
  } finally {
    if (server) server.kill();
    llm.server.close();
    await delay(300);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ D. 降级 ============ */
{
  // D1 未配置 LLM
  {
    const appPort = 18743;
    const sb = await makeSandbox();
    let server = null;
    try {
      const booted = await boot(sb, null, appPort);
      server = booted.server;
      const first = (await getJson(booted.base, '/api/palace/state')).body.palace.layout.slots[0].id;
      await postJson(booted.base, '/api/palace/assign', { slotId: first, word: 'abandon' });
      const cand = await postJson(booted.base, '/api/palace/mnemonic', { word: 'abandon' });
      T('没配模型时生成候选优雅降级（200 + ok:false），不 500 不卡死',
        cand.status === 200 && cand.body.ok === false && cand.body.reason === 'no_llm');
      const empty = await postJson(booted.base, '/api/palace/mnemonic', { word: '' });
      T('不传词直接 400', empty.status === 400 && empty.body.ok === false);
    } finally {
      if (server) server.kill();
      await delay(300);
      await rm(sb, { recursive: true, force: true }).catch(() => {});
    }
  }

  // D2 上游吐非 JSON
  {
    const llm = makeFakeLLM({ badJson: true });
    const llmPort = 18744, appPort = 18745;
    await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
    const sb = await makeSandbox();
    let server = null;
    try {
      const booted = await boot(sb, llmPort, appPort);
      server = booted.server;
      const cand = await postJson(booted.base, '/api/palace/mnemonic', { word: 'abandon' });
      T('上游吐非 JSON 时判 bad_json 并降级，不把整段散文塞给前端',
        cand.status === 200 && cand.body.ok === false && cand.body.reason === 'bad_json');
    } finally {
      if (server) server.kill();
      llm.server.close();
      await delay(300);
      await rm(sb, { recursive: true, force: true }).catch(() => {});
    }
  }

  // D3 palace.json 损坏 → 改名留档 + 回落空宫殿（不 500）
  {
    const appPort = 18746;
    const sb = await makeSandbox();
    let server = null;
    try {
      const booted = await boot(sb, null, appPort);
      server = booted.server;
      await postJson(booted.base, '/api/palace/assign', {
        slotId: (await getJson(booted.base, '/api/palace/state')).body.palace.layout.slots[0].id,
        word: 'abandon',
      });
      await writeFile(join(sb, 'data', 'palace.json'), '{"schemaVersion": 99, "oops": true}');
      const st = await getJson(booted.base, '/api/palace/state');
      const files = await readdir(join(sb, 'data'));
      T('宫殿文件损坏时自动改名留档并回落空宫殿（不 500、不静默丢）',
        st.body.ok && st.body.stats.occupied === 0 && files.some(f => f.startsWith('palace.json.corrupt-')));
    } finally {
      if (server) server.kill();
      await delay(300);
      await rm(sb, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/* ============ D4. 真浏览器：输入绑定是不是真的接上了 ============
 *
 * 这条是 v4.9.1 修的真缺陷留下的防回退：bindInput() 曾经「定义了但从未调用」，
 * 于是键盘、拖动转头、点地面、触摸全部没绑事件——用户进到宫殿里只能站着，
 * 连「点编号把词放进去」都做不到，整个功能等于不可用。
 *
 * 关键：不能用截图像素差当证据。画面本身有呼吸动画（refreshMarkerLook 里
 * 对已放词的编号做 sin 缩放），任意两帧都不相等，所以「截图变了」会假通过。
 * 必须读真实相机坐标。
 */
{
  const appPort = 18751;
  const sb = await makeSandbox();
  let server = null;
  let browser = null;
  try {
    const booted = await boot(sb, null, appPort);
    server = booted.server;
    const base = booted.base;
    const slot0 = (await getJson(base, '/api/palace/state')).body.palace.layout.slots[0].id;
    await postJson(base, '/api/palace/assign', { slotId: slot0, word: 'abandon' });

    let chromium = null;
    try { ({ chromium } = await import('playwright')); } catch { chromium = null; }
    if (!chromium) {
      T('真浏览器输入测试（playwright 可用）', false, 'playwright 未安装，无法验证输入绑定');
    } else {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errs = [];
      page.on('pageerror', e => errs.push(String(e)));
      await page.goto(base + '/palace/', { waitUntil: 'load' });
      await page.waitForTimeout(2200);
      // 帮助遮罩会挡住画布中央
      await page.evaluate(() => { const h = document.getElementById('helpBox'); if (h) h.hidden = true; });

      const camOf = (p) => p.evaluate(() => window.__palaceProbe.cam());
      T('子应用暴露只读探针（否则无法断言镜头真的动了）',
        await page.evaluate(() => typeof window.__palaceProbe?.cam === 'function'));

      // 点地面走路（趁视角未转，点正前方地面）
      const e0 = await camOf(page);
      await page.mouse.click(640, 660);
      await page.waitForTimeout(900);
      const e1 = await camOf(page);
      T('真浏览器：点地面真的走过去（相机位移，不是截图呼吸）',
        Math.hypot(e1.x - e0.x, e1.z - e0.z) > 0.15,
        `d=${Math.hypot(e1.x - e0.x, e1.z - e0.z).toFixed(2)}m`);

      // 键盘 W
      const c0 = await camOf(page);
      await page.keyboard.down('w');
      await page.waitForTimeout(800);
      await page.keyboard.up('w');
      await page.waitForTimeout(150);
      const c1 = await camOf(page);
      T('真浏览器：按 W 真的往前走',
        Math.hypot(c1.x - c0.x, c1.z - c0.z) > 0.3,
        `d=${Math.hypot(c1.x - c0.x, c1.z - c0.z).toFixed(2)}m`);

      // 拖动转头：yaw 变，且不把人瞬移走
      const d0 = await camOf(page);
      await page.mouse.move(640, 400);
      await page.mouse.down();
      await page.mouse.move(340, 400, { steps: 14 });
      await page.mouse.up();
      await page.waitForTimeout(700);
      const d1 = await camOf(page);
      T('真浏览器：拖动鼠标真的转头', Math.abs(d1.yaw - d0.yaw) > 0.05,
        `yaw ${d0.yaw.toFixed(2)}->${d1.yaw.toFixed(2)}`);
      T('真浏览器：拖动转头结束时不会把人顺带传送走',
        Math.hypot(d1.x - d0.x, d1.z - d0.z) < 0.4,
        `d=${Math.hypot(d1.x - d0.x, d1.z - d0.z).toFixed(2)}m`);

      // 点编号开面板：走到编号跟前点它
      let opened = false;
      for (let i = 0; i < 8 && !opened; i++) {
        await page.mouse.click(640, 300 + i * 20);
        await page.waitForTimeout(450);
        opened = await page.evaluate(() => window.__palaceProbe.panelOpen());
      }
      T('真浏览器：点编号能打开槽位面板（放词的唯一入口）', opened);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      T('真浏览器：Esc 能关掉面板', !(await page.evaluate(() => window.__palaceProbe.panelOpen())));

      T('真浏览器：子应用无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
      await page.close();

      // 手机：没有键盘，轻点地面必须能走
      const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await mob.goto(base + '/palace/', { waitUntil: 'load' });
      await mob.waitForTimeout(2000);
      await mob.evaluate(() => { const h = document.getElementById('helpBox'); if (h) h.hidden = true; });
      const m0 = await camOf(mob);
      await mob.touchscreen.tap(195, 700);
      await mob.waitForTimeout(1000);
      const m1 = await camOf(mob);
      T('真浏览器：手机轻点地面能走过去（无键盘也走得动）',
        Math.hypot(m1.x - m0.x, m1.z - m0.z) > 0.15,
        `d=${Math.hypot(m1.x - m0.x, m1.z - m0.z).toFixed(2)}m`);
      await mob.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    await delay(400);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ D5. 真浏览器：主站 → iframe → 放词 → 跨域复习指令 ============
 *
 * D4 只测子应用自己。但用户真正走的是「主站登录 → 点记忆宫殿 → 进入 → 放词 →
 * 点主站开始复习」。这条路要跨 iframe，出问题的地方完全不同：
 *  ① 进入按钮不设 src → iframe 永远空白
 *  ② postMessage 在子应用注册监听器之前发出 → 指令进虚空（v4.9.1 修的竞态）
 *  ③ 点编号的坐标算不准 → 用户点不到
 */
{
  const appPort = 18752;
  const sb = await makeSandbox();
  let server = null;
  let browser = null;
  try {
    await writeFile(join(sb, 'data', 'config.json'), JSON.stringify({
      multiUser: false,
      auth: { enabled: true, token: 'gate-token' },
      llm: { mock: false, activeId: '', providers: [] },
      autoSync: { enabled: false, minutes: 60 },
    }, null, 2));
    const booted = await boot(sb, null, appPort);
    server = booted.server;
    const base = booted.base;

    let chromium = null;
    try { ({ chromium } = await import('playwright')); } catch { chromium = null; }
    if (!chromium) {
      T('端到端（主站 → iframe → 放词 → 复习指令）', false, 'playwright 未安装');
    } else {
      browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(String(e)));

      const login = await page.request.post(base + '/api/auth/login', { data: { token: 'gate-token' } });
      T('端到端：登录主站成功', login.ok(), 'status=' + login.status());
      await page.goto(base + '/', { waitUntil: 'load' });
      await page.waitForTimeout(1500);

      // 先切到「AI 学习」页签，否则子页按钮在 display:none 的页面里点不到
      await page.locator('.tab[data-tab="study"]').click();
      await page.waitForTimeout(600);
      await page.locator('[data-sub="palace"]').click();
      await page.waitForTimeout(600);
      T('端到端：切到记忆宫殿子页，且未点进入前 iframe 不加载',
        await page.evaluate(() => {
          const p = document.getElementById('palacePane');
          const s = document.getElementById('palaceFrame')?.getAttribute('src') || '';
          return !!p && getComputedStyle(p).display !== 'none' && s === '';
        }));

      await page.locator('#palaceEnterBtn').click();
      await page.waitForTimeout(3000);
      T('端到端：点「进入宫殿」后 iframe 真的加载子应用',
        await page.evaluate(() => (document.getElementById('palaceFrame')?.getAttribute('src') || '') === '/palace/'));

      const fr = page.frames().find(f => f.url().includes('/palace/'));
      T('端到端：iframe 内子应用启动完成（HUD 可见、载入遮罩消失、探针可用）',
        !!fr && await fr.evaluate(() => !!window.__palaceProbe && document.getElementById('hud') !== null && document.getElementById('boot').hidden));
      if (fr) {
        await fr.evaluate(() => { const h = document.getElementById('helpBox'); if (h) h.hidden = true; });
        await page.waitForTimeout(300);
        const mk = await fr.evaluate(() => window.__palaceProbe.markersScreen());
        const target = mk.find(m => m.inFront && m.x > 40 && m.x < 1400) || mk[0];
        await fr.locator('#stage canvas').click({ position: { x: target.x, y: target.y } });
        await page.waitForTimeout(700);
        T('端到端：点编号能打开槽位面板（隔房间也点得动）',
          await fr.evaluate(() => window.__palaceProbe.panelOpen()), `#${target.num}`);

        await fr.locator('#swapInput').fill('abandon');
        await fr.locator('#btnSwap').click();
        await page.waitForTimeout(1200);
        const st = await getJson(base, '/api/palace/state');
        T('端到端：从 iframe 里放词真的落到服务端', st.body.stats.occupied === 1, 'occupied=' + st.body.stats.occupied);
        await fr.locator('#slotClose').click();
        await page.waitForTimeout(300);

        await page.locator('#palaceReviewBtn').click();
        await page.waitForTimeout(2000);
        T('端到端：主站「开始复习」跨 iframe 真的让宫殿进入复习态（不丢指令）',
          await fr.evaluate(() => window.__palaceProbe.reviewOpen() || window.__palaceProbe.doneBoxOpen()));
      }
      T('端到端：主站无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    await delay(400);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ D6. 真浏览器：点「进入」后立刻点「开始复习」（竞态窗口） ============
 *
 * 这是 v4.9.1 修的竞态真正会打的时序：src 刚设置、子应用还没注册 message 监听器，
 * 此时发出的 palace:command 会落进虚空。D5 是「等子应用起来再点」，永远测不到这条。
 * 这里刻意两个点击之间不等待。
 */
{
  const appPort = 18753;
  const sb = await makeSandbox();
  let server = null;
  let browser = null;
  try {
    await writeFile(join(sb, 'data', 'config.json'), JSON.stringify({
      multiUser: false,
      auth: { enabled: true, token: 'gate-token-2' },
      llm: { mock: false, activeId: '', providers: [] },
      autoSync: { enabled: false, minutes: 60 },
    }, null, 2));
    const booted = await boot(sb, null, appPort);
    server = booted.server;
    const base = booted.base;
    // 预置一个词，这样「开始复习」会真的进复习态（否则走「还没有词」分支）
    const slot0 = (await getJson(base, '/api/palace/state')).body.palace.layout.slots[0].id;
    await postJson(base, '/api/palace/assign', { slotId: slot0, word: 'abandon' });

    let chromium = null;
    try { ({ chromium } = await import('playwright')); } catch { chromium = null; }
    if (!chromium) {
      T('端到端：进入后立刻点复习（竞态窗口）', false, 'playwright 未安装');
    } else {
      browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await page.request.post(base + '/api/auth/login', { data: { token: 'gate-token-2' } });

      // 确定性制造竞态窗口：把 palace.js 的响应人为拖慢 2.5s。
      // 不这么做的话，Playwright 两次点击之间的固有延迟刚好够 iframe 起来，
      // 这条断言会「运气好就过」，抓不到真缺陷。
      await page.route('**/palace/palace.js', async (route) => {
        await new Promise(r => setTimeout(r, 2500));
        await route.continue();
      });

      await page.goto(base + '/', { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      await page.locator('.tab[data-tab="study"]').click();
      await page.waitForTimeout(500);
      await page.locator('[data-sub="palace"]').click();
      await page.waitForTimeout(500);

      // 关键：点「进入」与点「开始复习」之间不等待。
      // 断言必须是 reviewOpen === true：宫殿里明明有词，若指令在 loadState() 完成前
      // 就被处理，startReview() 会误判「还没有词」弹 doneBox —— 那正是要抓的缺陷。
      // 所以不能把 doneBoxOpen 也算通过。
      await page.locator('#palaceEnterBtn').click();
      await page.locator('#palaceReviewBtn').click();
      await page.waitForTimeout(5000);
      const fr = page.frames().find(f => f.url().includes('/palace/'));
      const probe = fr ? await fr.evaluate(() => ({
        has: !!window.__palaceProbe,
        ro: window.__palaceProbe ? window.__palaceProbe.reviewOpen() : null,
        db: window.__palaceProbe ? window.__palaceProbe.doneBoxOpen() : null,
      })) : { has: false, ro: null, db: null };
      T('端到端：点「进入」后立刻点「开始复习」也能进复习态（不丢指令、不误判没词）',
        probe.has && probe.ro === true,
        `reviewOpen=${probe.ro} doneBox=${probe.db}（有词时出现 doneBox 就是误判）`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    await delay(400);
    await rm(sb, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ E. 备份结构校验（静态口径，防「恢复把坏数据写回去」） ============ */T('isPalaceShape 校验 schemaVersion + layout.slots + occupied 三件',
  /function isPalaceShape\(obj\)[\s\S]{0,400}schemaVersion !== PALACE_SCHEMA[\s\S]{0,400}Array\.isArray\(obj\.layout\.slots\)/.test(serverSrc));
T('版本号已升 4.9.1（package.json / index.html / sw 缓存名一致）',
  JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version === '4.9.1' &&
  swSrc.includes("wb-shell-v4.9.1") &&
  (htmlSrc.match(/v4\.9\.1</g) || []).length === 3);

/* ============ 汇总 ============ */
const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过${failed.length ? `，${failed.length} 项失败` : ''}`);
process.exit(failed.length ? 1 : 0);
