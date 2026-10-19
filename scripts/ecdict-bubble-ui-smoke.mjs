#!/usr/bin/env node
/**
 * v3.7.0：划词气泡本地词库释义 + 完整词条卡 浏览器回归。
 * 覆盖：
 *  - 划选单词后气泡内出现释义行（音标 + 词形 + 考试标签 + 中文释义）
 *  - 句子不出现释义行（只保留精读/复制）
 *  - 点击释义行展开完整词条卡（词性分组释义、朗读、收进墨墨、AI 精读入口）
 *  - 词条卡「AI 精读」可进入原四模式精读卡
 *  - 触摸端（Pixel 7）释义行触控高度 ≥44px
 *  - 控制台无异常
 * 说明：若本机没有 runtime/ecdict/ecdict.db，则输出 SKIP 并正常退出（CI 不携带词库）。
 */
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const ecdictHome = process.env.ECDICT_HOME || join(root, 'runtime', 'ecdict');
if (!existsSync(join(ecdictHome, 'ecdict.db'))) {
  console.log(`SKIP ecdict bubble ui: 词库不存在（${join(ecdictHome, 'ecdict.db')}）`);
  process.exit(0);
}

const checks = [];
const T = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

const sandbox = await mkdtemp(join(tmpdir(), 'workbench-ecdict-ui-'));
const port = 19550 + Math.floor(Math.random() * 200);
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
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ECDICT_HOME: ecdictHome },
    stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = (await fetch(base + '/api/auth/status')).ok; } catch { await delay(100); }
  }
  if (!ready) throw new Error('ecdict ui sandbox server did not start');

  const { chromium, devices } = await import('playwright');
  browser = await chromium.launch({ headless: true });

  const selectRange = async (page, id, start, end) => page.evaluate(([pid, a, b]) => {
    const p = document.getElementById(pid);
    const tn = p.firstChild;
    const r = document.createRange();
    r.setStart(tn, a); r.setEnd(tn, b);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    const rc = r.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rc.left + 1, clientY: rc.top + 1 }));
  }, [id, start, end]);

  // ---------- 桌面端 ----------
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'ecdictTarget';
    p.className = 'kb-passage';
    p.style.cssText = 'font-size:18px;padding:16px;line-height:2';
    p.textContent = 'The climate has changed dramatically, so resilience became essential.';
    document.body.appendChild(p);
    p.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(200);

  await selectRange(page, 'ecdictTarget', 4, 11); // "climate"
  await page.waitForTimeout(900);
  const bubble = await page.evaluate(() => {
    const b = document.querySelector('.sel-learn-bubble');
    if (!b) return null;
    const g = b.querySelector('[data-sel-gloss]');
    return {
      exists: true,
      glossText: g ? g.innerText : '',
      glossVisible: g ? getComputedStyle(g).display !== 'none' : false,
      hasLearn: !!b.querySelector('[data-act="learn"]'),
      hasCopy: !!b.querySelector('[data-act="copy"]'),
      hasGlossClass: b.classList.contains('has-gloss'),
    };
  });
  T('1.1 划词后出现气泡', Boolean(bubble && bubble.exists));
  T('1.2 气泡内显示本地释义行', Boolean(bubble && bubble.glossVisible), bubble ? bubble.glossText.replace(/\n/g, ' | ') : '');
  T('1.3 释义含音标', Boolean(bubble && /\/[^/]+\//.test(bubble.glossText)), bubble ? (bubble.glossText.match(/\/[^/]+\//) || [''])[0] : '');
  T('1.4 释义含考试标签', Boolean(bubble && /考研|四级|六级|高考/.test(bubble.glossText)));
  T('1.5 释义含中文释义', Boolean(bubble && /气候/.test(bubble.glossText)));
  T('1.6 保留「精读」与「复制」按钮', Boolean(bubble && bubble.hasLearn && bubble.hasCopy));

  await page.click('[data-sel-gloss]');
  await page.waitForTimeout(600);
  const card = await page.evaluate(() => {
    const c = document.querySelector('.sel-dict-card');
    if (!c) return null;
    return {
      text: c.innerText,
      posBlocks: c.querySelectorAll('.sel-dict-pos').length,
      hasSpeak: !!c.querySelector('[data-sel-speak]'),
      hasCollect: !!c.querySelector('[data-sel-collect]'),
      hasLearn: !!c.querySelector('[data-sel-learn]'),
      hasEn: !!c.querySelector('.sel-dict-en'),
    };
  });
  T('2.1 点击释义行展开完整词条卡', Boolean(card));
  T('2.2 词条卡按词性分组释义', Boolean(card && card.posBlocks >= 1), card ? String(card.posBlocks) : '');
  T('2.3 词条卡含朗读/收进墨墨/AI 精读入口', Boolean(card && card.hasSpeak && card.hasCollect && card.hasLearn));
  T('2.4 词条卡含英文释义折叠', Boolean(card && card.hasEn));

  if (card && card.hasLearn) {
    await page.click('.sel-dict-card [data-sel-learn]');
    await page.waitForTimeout(1200);
    const learnCard = await page.evaluate(() => {
      const c = document.querySelector('.sel-learn-card:not(.sel-dict-card)');
      if (!c) return null;
      return { modes: c.querySelectorAll('.sel-mode').length, text: c.innerText.slice(0, 120) };
    });
    T('2.5 词条卡可进入 AI 精读四模式', Boolean(learnCard && learnCard.modes === 4), learnCard ? String(learnCard.modes) : 'none');
  } else {
    T('2.5 词条卡可进入 AI 精读四模式', false, 'no card');
  }

  // 句子不查本地库
  await page.evaluate(() => { selDictCloseCard(); selLearnCloseCard(); selLearnRemoveBtn(); });
  await page.waitForTimeout(200);
  await selectRange(page, 'ecdictTarget', 0, 42); // 整句
  await page.waitForTimeout(700);
  const sentence = await page.evaluate(() => {
    const b = document.querySelector('.sel-learn-bubble');
    const g = b && b.querySelector('[data-sel-gloss]');
    return { exists: !!b, glossVisible: g ? getComputedStyle(g).display !== 'none' : false };
  });
  T('3.1 句子划选仍弹出气泡', sentence.exists);
  T('3.2 句子不显示本地释义行（不查词库）', sentence.exists && !sentence.glossVisible);
  T('4.1 桌面端无未捕获异常', errors.length === 0, errors.join(' | '));
  await page.close();

  // ---------- 触摸端 ----------
  const mobile = await browser.newContext({ ...devices['Pixel 7'] });
  const mpage = await mobile.newPage();
  const mErrors = [];
  mpage.on('pageerror', e => mErrors.push(e.message));
  await mpage.goto(base);
  await mpage.waitForTimeout(900);
  await mpage.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'ecdictMobile';
    p.style.cssText = 'font-size:20px;padding:20px;line-height:2.2';
    p.textContent = 'Resilience is crucial for learning English effectively.';
    document.body.appendChild(p);
    p.scrollIntoView({ block: 'center' });
  });
  await mpage.waitForTimeout(200);
  const mRes = await mpage.evaluate(() => {
    const p = document.getElementById('ecdictMobile');
    const tn = p.firstChild;
    const r = document.createRange();
    r.setStart(tn, 0); r.setEnd(tn, 10); // Resilience
    const rc = r.getBoundingClientRect();
    const ok = selLearnPickAtPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
    return { picked: ok };
  });
  await mpage.waitForTimeout(900);
  const mBubble = await mpage.evaluate(() => {
    const b = document.querySelector('.sel-learn-bubble');
    if (!b) return null;
    const g = b.querySelector('[data-sel-gloss]');
    const rect = g ? g.getBoundingClientRect() : null;
    const br = b.getBoundingClientRect();
    return {
      glossVisible: g ? getComputedStyle(g).display !== 'none' : false,
      glossH: rect ? rect.height : 0,
      inViewport: br.left >= 0 && br.right <= window.innerWidth + 1,
    };
  });
  T('5.1 触摸端长按取词后气泡显示释义行', Boolean(mBubble && mBubble.glossVisible));
  T('5.2 释义行触控高度 ≥44px', Boolean(mBubble && mBubble.glossH >= 44), mBubble ? mBubble.glossH.toFixed(1) : '');
  T('5.3 气泡不溢出屏幕', Boolean(mBubble && mBubble.inViewport));
  T('5.4 触摸端无未捕获异常', mErrors.length === 0, mErrors.join(' | '));
  await mobile.close();

  if (browser) { await browser.close(); browser = null; }
} catch (err) {
  console.error('Test error:', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter(c => !c.ok);
console.log(`\necdict bubble ui: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map(f => f.name).join(' | '));
  process.exitCode = 1;
}
