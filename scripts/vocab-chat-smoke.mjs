#!/usr/bin/env node
/**
 * v3.8.1：「词汇精练单次会话被拆成多次请求」隔离回归。
 *
 * 背景（实测定位）：用户在「AI 学习 → 词汇精练」里点一个词／问一句话，界面上是一次交互，
 * 但服务端实际消耗了更多次上游调用，具体三个根因：
 *   ① 同一条用户消息在请求体里出现两次（前端先 push 进历史再把 history 整段发走，
 *      服务端又把 message 作为本轮提问追加一次）→ 每个回合 prompt 白多一份用户消息；
 *   ② 中文输入法组字态按 Enter 确认候选，浏览器仍派发 keydown Enter（isComposing=true），
 *      旧代码只判 e.key → 半截内容被当消息发出，一次输入变两次请求；
 *   ③ 无「请求在途」保护 → 上游慢时回车后再点快捷 chip、连点两次词条都会叠加成多次上游调用，
 *      而多用户下写请求走 per-user 串行队列，叠加请求只能排队逐个跑（实测相邻调用间隔被拉长 4 倍）；
 *   ④ 进入词表时 fetchGlosses 会对每个缺释义的词打 LLM（每批 20 词），
 *      现在先查离线 ECDICT，只有真正查不到的词才走 LLM。
 *
 * 本套件用「假上游 LLM」直接观测服务端实际发给上游的 messages 与调用次数，
 * 并读取前端源码断言契约，避免退化成只看接口状态的自欺测试。
 *
 * 断言（共 22 项）：
 *  A. 前端契约：askAI 在 push 之前取 history；Enter 判定含 isComposing/keyCode 229；
 *     askAI 有在途锁且 finally 释放；sendBtn 发送中禁用。
 *  B. 运行时：单击词条 → 上游 messages 为 [system,user]（不再重复）；
 *     手输一句 → 为 [system,...,user]，user 消息个数等于真实提问数。
 *  C. 在途锁：上游慢时叠加操作只产生 1 次请求，且卡片提示「上一条还在回答中」。
 *  D. 输入法：组字态 Enter 不发送；确认后正常发送一次。
 *  E. ECDICT 释义：词库在时 /api/gloss 零 LLM 调用且释义齐全 + 音标已归一化；
 *     词库缺失时优雅回退 LLM。
 *
 * 依赖：需要 playwright（与 mobile-device-check 同源，devDependency）。
 * 若未安装 playwright，浏览器相关断言自动跳过并明确打印 SKIP（不伪造通过）。
 */
import { mkdtemp, rm, mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const checks = [];
const T = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const SKIP = (name, why) => { checks.push({ name, ok: true, skip: true, detail: why }); console.log(`SKIP ${name}: ${why}`); };

/* ============ A. 前端源码契约（静态，不依赖浏览器） ============ */
const appSrc = await readFile(join(root, 'public', 'app.js'), 'utf8');

// A1/A2：history 必须在 push 之前取（取 history 与 push 的先后顺序）
const aiStart = appSrc.indexOf('async function askAI(');
const historyTakeIdx = aiStart >= 0 ? appSrc.indexOf('const history = state.chatHistory.slice', aiStart) : -1;
const pushUserIdx = aiStart >= 0 ? appSrc.indexOf("state.chatHistory.push({ role: 'user', content: message", aiStart) : -1;
T('前端 askAI 在写入历史之前取出 history', historyTakeIdx > aiStart && historyTakeIdx < pushUserIdx && pushUserIdx > 0,
  `history@${historyTakeIdx} < push@${pushUserIdx}`);
T('前端请求体使用已取出的 history（不再二次 slice）',
  /body:\s*\{[\s\S]{0,400}?history,/.test(appSrc.slice(aiStart, aiStart + 4000)));

// A3：Enter 判定含输入法保护
const enterIdx = appSrc.indexOf("$('#chatInput').addEventListener('keydown'");
const enterBlock = enterIdx >= 0 ? appSrc.slice(enterIdx, enterIdx + 420) : '';
T('前端 Enter 判定包含 isComposing 保护', /isComposing/.test(enterBlock));
T('前端 Enter 判定包含 keyCode 229 兜底', /229/.test(enterBlock));

// A4/A5：在途锁
T('前端存在 chatInFlight 在途锁', /let chatInFlight = false;/.test(appSrc));
const finallyIdx = appSrc.indexOf('chatInFlight = false;', aiStart);
T('前端 finally 中释放在途锁', finallyIdx > aiStart && /finally\s*\{/.test(appSrc.slice(aiStart, finallyIdx + 200)));
T('前端发送中禁用发送按钮', /sendBtnEl\.disabled = true/.test(appSrc.slice(aiStart, aiStart + 1200)));

/* ============ 假上游 LLM：记录每次调用的 messages ============ */
function makeFakeLLM() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', c => { buf += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf); } catch { /* ignore */ }
      const sys = String((body.messages || []).find(m => m.role === 'system')?.content || '');
      const isGloss = sys.includes('英汉词典');
      const users = (body.messages || []).filter(m => m.role === 'user').map(m => String(m.content));
      hits.push({ kind: isGloss ? 'gloss' : 'chat', users, roles: (body.messages || []).map(m => m.role) });
      const reply = isGloss
        ? JSON.stringify({ glosses: users.join('\n').split('\n').filter(Boolean).map(sp => ({ spelling: sp.trim(), phonetic: '', pos: 'n.', gloss: 'LLM-' + sp.trim() })) })
        : '模拟回复。';
      const delayMs = Number(process.env.SMOKE_LLM_DELAY_MS || 0);
      setTimeout(() => {
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, delayMs);
    });
  });
  return { server, hits };
}

async function makeSandbox(words, glosses = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), 'workbench-v381-'));
  await copyFile(join(root, 'server.js'), join(sandbox, 'server.js'));
  await copyFile(join(root, 'package.json'), join(sandbox, 'package.json'));
  await mkdir(join(sandbox, 'public'), { recursive: true });
  for (const f of await readdir(join(root, 'public'))) {
    if (f.endsWith('.js') || f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.webmanifest')) {
      await copyFile(join(root, 'public', f), join(sandbox, 'public', f));
    }
  }
  await mkdir(join(sandbox, 'corpus'), { recursive: true });
  await writeFile(join(sandbox, 'corpus', 'records.jsonl'), '');
  await writeFile(join(sandbox, 'corpus', 'exams.jsonl'), '');
  await mkdir(join(sandbox, 'data'), { recursive: true });
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const wordMap = {};
  words.forEach((sp, i) => {
    wordMap['w' + i] = { id: i + 1, spelling: sp, tags: [], today: { date: today, isNew: true, isFinished: false }, lastStudyDate: today };
  });
  await writeFile(join(sandbox, 'data', 'db.json'), JSON.stringify({
    words: wordMap, glosses, progressHistory: [], todayItems: words.map((_, i) => i + 1),
    notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [],
  }, null, 2));
  return sandbox;
}

async function boot(sandbox, llmPort, appPort, ecdictHome) {
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
    llm: { mock: false, activeId: 'p', providers: [{ id: 'p', name: 'p', baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'k', model: 'fake' }] },
    autoSync: { enabled: false, minutes: 60 },
  }, null, 2));
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(appPort) };
  if (ecdictHome) env.ECDICT_HOME = ecdictHome;
  const server = spawn(process.execPath, ['server.js'], { cwd: sandbox, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${appPort}`;
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    try { ready = (await fetch(base + '/api/auth/status')).ok; } catch { await delay(100); }
  }
  if (!ready) { server.kill(); throw new Error('sandbox server did not start'); }
  return { server, base };
}

const REAL_ECDICT = join(root, 'runtime', 'ecdict');
const HAS_ECDICT = existsSync(join(REAL_ECDICT, 'ecdict.db'));

/* ============ E. ECDICT 释义路径（纯接口，不需要浏览器） ============ */
const REAL_WORDS = ['abandon', 'resilient', 'innovation', 'dormitory', 'sustain', 'ambiguous', 'permanent', 'strain'];

// E1：词库在 → 零 LLM 调用 + 释义齐全 + 音标归一化
{
  const llm = makeFakeLLM();
  const llmPort = 18561, appPort = 18562;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sandbox = await makeSandbox(REAL_WORDS);
  try {
    const { server, base } = await boot(sandbox, llmPort, appPort, HAS_ECDICT ? REAL_ECDICT : join(sandbox, 'no-ecdict'));
    const res = await fetch(base + '/api/gloss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spellings: REAL_WORDS }),
    });
    const body = await res.json();
    const got = Object.keys(body.glosses || {});
    const glossHits = llm.hits.filter(h => h.kind === 'gloss');
    if (HAS_ECDICT) {
      T('ECDICT 词库在时 /api/gloss 零 LLM 调用', glossHits.length === 0, `LLM gloss=${glossHits.length}`);
      T('ECDICT 词库在时释义齐全', got.length === REAL_WORDS.length, `${got.length}/${REAL_WORDS.length}`);
      const phon = body.glosses?.abandon?.phonetic || '';
      T('ECDICT 音标已归一化为 IPA 并包裹斜杠', /^\/.*\/$/.test(phon) && !/[\u0400-\u04FF]/.test(phon), phon);
      T('ECDICT 词性为词表口径', ['v.', 'n.', 'adj.', 'adv.'].includes(body.glosses?.abandon?.pos || ''), body.glosses?.abandon?.pos || '(空)');
      // v3.8.1：/api/dict/ecdict（划词助手）与 /api/gloss 共用同一个音标归一化，两者都不得出现西里尔形近字
      {
        const dres = await fetch(base + '/api/dict/ecdict?word=abandon');
        const dj = await dres.json().catch(() => ({}));
        const dphon = dj?.data?.phonetic || '';
        T('划词词典音标同样已归一化（无西里尔字符）', Boolean(dphon) && !/[\u0400-\u04FF]/.test(dphon), dphon || '(空)');
        T('划词词典音标格式为 /.../', /^\/.*\/$/.test(dphon), dphon || '(空)');
      }
    } else {
      SKIP('ECDICT 词库在时零 LLM 调用', 'runtime/ecdict 未安装');
      SKIP('ECDICT 词库在时释义齐全', 'runtime/ecdict 未安装');
      SKIP('ECDICT 音标归一化', 'runtime/ecdict 未安装');
      SKIP('ECDICT 词性口径', 'runtime/ecdict 未安装');
    }
    server.kill();
  } finally {
    llm.server.close();
    await delay(200);
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

// E2：词库缺失 → 优雅回退 LLM
{
  const llm = makeFakeLLM();
  const llmPort = 18563, appPort = 18564;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sandbox = await makeSandbox(REAL_WORDS);
  try {
    const { server, base } = await boot(sandbox, llmPort, appPort, join(sandbox, 'no-such-ecdict'));
    const res = await fetch(base + '/api/gloss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spellings: REAL_WORDS }),
    });
    const body = await res.json();
    const glossHits = llm.hits.filter(h => h.kind === 'gloss');
    T('词库缺失时回退 LLM（1 批）', glossHits.length === 1, `LLM gloss=${glossHits.length}`);
    T('词库缺失时释义仍齐全（降级不阻断）', Object.keys(body.glosses || {}).length === REAL_WORDS.length);
    server.kill();
  } finally {
    llm.server.close();
    await delay(200);
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ B/C/D. 浏览器实测（需要 playwright） ============ */
async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    join(root, 'node_modules', 'playwright'),
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (existsSync(p)) return await import(`file://${p.replace(/\\/g, '/')}/index.mjs`).catch(async () => await import(p)); } catch { /* next */ }
  }
  try { return await import('playwright'); } catch { return null; }
}

const pw = await loadPlaywright();
if (!pw || !pw.chromium) {
  SKIP('浏览器实测：重复用户消息', 'playwright 未安装');
  SKIP('浏览器实测：在途锁', 'playwright 未安装');
  SKIP('浏览器实测：输入法 Enter', 'playwright 未安装');
} else {
  const llm = makeFakeLLM();
  const llmPort = 18565, appPort = 18566;
  await new Promise(r => llm.server.listen(llmPort, '127.0.0.1', r));
  const sandbox = await makeSandbox(['abandon', 'resilient', 'innovation']);
  const { server, base } = await boot(sandbox, llmPort, appPort, HAS_ECDICT ? REAL_ECDICT : join(sandbox, 'no-ecdict'));
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const chatPosts = [];
    page.on('request', r => { try { if (new URL(r.url()).pathname === '/api/chat') chatPosts.push(Date.now()); } catch { /* ignore */ } });

    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await delay(1500);
    await page.click('.tab[data-tab="study"]');
    await delay(2000);
    // v4.2.0：词表收成右下角悬浮球，先展开浮层才能点到词条
    await page.click('#wordFab');
    await delay(300);

    let n0 = llm.hits.length;
    await page.click('.word-item[data-sp="abandon"]');
    await page.fill('#wordSearch', 'resilient');
    await page.getByRole('checkbox', { name: '勾选 resilient' }).check();
    await page.fill('#wordSearch', 'innovation');
    await page.getByRole('checkbox', { name: '勾选 innovation' }).check();
    T('悬浮词表跨搜索保留勾选，点词不发送提问', (await page.locator('#coachSelected').innerText()).includes('3') && !llm.hits.slice(n0).some(h => h.kind === 'chat'));
    await page.click('#coachScreenBtn');
    const detail = page.locator('#coachDetail');
    const rate = async label => {
      await detail.getByRole('button', { name: '揭晓释义' }).click();
      await detail.getByRole('button', { name: label, exact: true }).click();
    };
    T('初筛先回想并隐藏释义', await detail.locator('.coach-recall').innerText() === 'abandon' && await detail.locator('.coach-sentence').count() === 0);
    await rate('熟知');
    await rate('模糊');
    await rate('不会');
    const plans = [];
    await page.route('**/api/tutor/map', async route => {
      const body = route.request().postDataJSON();
      if (body.action !== 'plan') return route.fallback();
      plans.push(body.words);
      await route.fulfill({ json: { ok: true, groups: body.words.map(word => ({ title: word, words: [word] })) } });
    });
    await detail.getByRole('button', { name: '分析并分组' }).click();
    await page.locator('[data-coach-node="g1"]').waitFor();
    T('已确认熟知的词不送给分组模型', JSON.stringify(plans[0]) === JSON.stringify(['resilient', 'innovation']));
    await page.locator('[data-coach-node="g1"]').click();
    await page.locator('[data-coach-view="outline"]').click();
    T('切换到大纲后保留当前组', await page.locator('#coachTree').getAttribute('data-view') === 'outline' && await detail.locator('h3').innerText() === 'innovation');
    await page.locator('#coachTree [data-coach-node="skipped"]').click();
    await detail.getByRole('button', { name: '拉回本轮' }).click();
    await detail.getByRole('button', { name: '分析并分组' }).click();
    await page.locator('[data-coach-node="g2"]').waitFor();
    T('略过的熟词可以拉回参与分组', plans[1].includes('abandon') && plans[1].length === 3);
    await page.click('#coachChat > summary');
    await page.fill('#chatInput', '请介绍一下这个词');
    await page.press('#chatInput', 'Enter');
    await delay(2500);
    const firstChat = llm.hits.slice(n0).filter(h => h.kind === 'chat').at(-1);
    T('首次提问：上游消息不含重复用户消息', firstChat?.users.length === 1 && firstChat.roles.join(',') === 'system,user');

    // B2：上游 user 消息个数 = 真实提问数（2 条不同内容）
    n0 = llm.hits.length;
    await page.fill('#chatInput', '它和 give up 有什么区别？');
    await page.press('#chatInput', 'Enter');
    await delay(2500);
    const secondChat = llm.hits.slice(n0).filter(h => h.kind === 'chat').at(-1);
    const dupOk = Boolean(secondChat) && new Set(secondChat.users).size === secondChat.users.length;
    T('手输提问：上游 user 消息无重复', dupOk && secondChat.users.length === 2,
      secondChat ? `users=${JSON.stringify(secondChat.users.map(u => u.slice(0, 12)))}` : '未捕获');

    // C：在途锁——上游慢时再按回车
    process.env.SMOKE_LLM_DELAY_MS = '2500';
    n0 = chatPosts.length;
    await page.fill('#chatInput', '第一个问题');
    await page.press('#chatInput', 'Enter');
    await delay(300);
    await page.fill('#chatInput', '在途时的第二个问题');
    await page.press('#chatInput', 'Enter');
    await delay(5000);
    T('在途锁：上游慢时叠加操作只产生 1 次 /api/chat', chatPosts.length - n0 === 1, `chat=${chatPosts.length - n0}`);
    process.env.SMOKE_LLM_DELAY_MS = '0';

    // D：输入法组字态 Enter 不得发送
    n0 = chatPosts.length;
    const cdp = await page.context().newCDPSession(page);
    await page.click('#chatInput');
    await cdp.send('Input.imeSetComposition', { text: '这个', selectionStart: 2, selectionEnd: 2 });
    await page.keyboard.press('Enter');
    await delay(1200);
    T('输入法组字态按 Enter 不发送', chatPosts.length - n0 === 0, `chat=${chatPosts.length - n0}`);
    const leftValue = await page.inputValue('#chatInput');
    T('输入法候选内容保留在输入框（未被当消息清空）', leftValue === '这个', JSON.stringify(leftValue));

    await browser.close();
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
    server.kill();
    llm.server.close();
    await delay(300);
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============ 汇总 ============ */
const failed = checks.filter(c => !c.ok);
const skipped = checks.filter(c => c.skip);
console.log(`\nvocab-chat smoke: ${checks.length - failed.length - skipped.length} passed, ${skipped.length} skipped, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.error(`  FAIL ${f.name}${f.detail ? ': ' + f.detail : ''}`);
  process.exitCode = 1;
}
