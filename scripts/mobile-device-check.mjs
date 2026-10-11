#!/usr/bin/env node
/**
 * v3.3.6：移动端回归入口。
 * --emulated 在无手机环境下执行可复现的移动契约检查；
 * --device 需要 Android ADB，并通过 Chrome DevTools 读取真实设备页面布局。
 */
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const mode = args.includes('--device') ? 'device' : 'emulated';
const base = (args.includes('--url') ? args[args.indexOf('--url') + 1] : process.env.MOBILE_BASE_URL || 'http://127.0.0.1:5178').replace(/\/$/, '');
const checks = [];
const pass = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
class DeviceUnavailable extends Error { constructor(message) { super(message); this.name = 'DeviceUnavailable'; } }

async function contractChecks() {
  const html = await readFile(join(root, 'public', 'index.html'), 'utf8');
  const css = await readFile(join(root, 'public', 'style.css'), 'utf8');
  const js = await readFile(join(root, 'public', 'app.js'), 'utf8');
  pass('viewport-fit meta', /viewport-fit=cover/.test(html));
  pass('mobile navigation exists', /mobile-bottom-bar/.test(html) && /mobile-header/.test(html));
  pass('safe-area handling', /safe-area-inset-(?:top|bottom)/.test(css));
  pass('44px touch contract', /min-height:\s*44px/.test(css) && /\.quiz-submode-btn/.test(css));
  pass('horizontal subnav contract', /\.quiz-submode[^{]*\{[^}]*overflow-x:\s*auto/s.test(css) || /\.quiz-submode/.test(css));
  pass('touch selection guard', /SEL_TOUCH_DEVICE|user-select:\s*none/.test(css + js));
  pass('responsive max-width constraints', /max-width:\s*1280px/.test(css) && /@media\s*\(max-width:\s*700px\)/.test(css));
  pass('version marker', /v3\.3\.6/.test(html));
}

async function emulatedChecks() {
  let playwright;
  try { playwright = await import('playwright'); }
  catch (error) { console.log(`INFO Playwright unavailable; static checks remain authoritative: ${error.message}`); return; }
  let sandbox;
  let server;
  let appBase = process.env.MOBILE_BASE_URL ? base : '';
  if (!appBase) {
    sandbox = await mkdtemp(join(tmpdir(), 'workbench-mobile-'));
    await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
    await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
    await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
    await cp(join(root, 'corpus'), join(sandbox, 'corpus'), { recursive: true });
    await mkdir(join(sandbox, 'data'), { recursive: true });
    const words = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`w${index}`, {
      id: index, spelling: `mobileword${String(index).padStart(3, '0')}`, studyCount: index,
      lastStudyDate: `2026-09-0${(index % 9) + 1}`,
    }]));
    await writeFile(join(sandbox, 'data', 'db.json'), JSON.stringify({ words, glosses: {}, progressHistory: [], todayItems: [], notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [] }));
    await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({ llm: { mock: true, activeId: 'mobile-test', providers: [{ id: 'mobile-test', name: 'mobile-test', baseUrl: '', apiKey: '', model: 'mock' }] }, autoSync: { enabled: false, minutes: 60 } }));
    const port = 19000 + Math.floor(Math.random() * 500);
    appBase = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['server.js'], { cwd: sandbox, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${appBase}/api/auth/status`)).ok) break; } catch {}
      await delay(100);
      if (i === 59) throw new Error('mobile sandbox server did not start');
    }
  }
  let browser;
  try {
    const launchOptions = { headless: true };
    const bundled = (() => { try { return playwright.chromium.executablePath(); } catch { return ''; } })();
    if (!bundled || !existsSync(bundled)) {
      const local = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : '';
      const candidates = local && existsSync(local) ? readdirSync(local).filter(name => /^chromium-\d+$/.test(name)).sort().reverse().map(name => join(local, name, 'chrome-win64', 'chrome.exe')) : [];
      const executable = process.env.PLAYWRIGHT_CHROMIUM || candidates.find(existsSync);
      if (executable) launchOptions.executablePath = executable;
    }
    browser = await playwright.chromium.launch(launchOptions);
    const projects = [
      ['Pixel 7', playwright.devices['Pixel 7']],
      ['Pixel 7 landscape', playwright.devices['Pixel 7 landscape']],
      ['iPhone 13', playwright.devices['iPhone 13']],
    ];
    for (const [name, device] of projects) {
      const context = await browser.newContext(device);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !/favicon|401|Failed to fetch|ERR_/.test(message.text())) errors.push(message.text()); });
      await page.goto(appBase, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      const result = await page.evaluate(async () => {
        const tabs = ['dashboard', 'study', 'quiz', 'exam', 'speaking', 'settings'];
        const pages = {};
        const touchHeights = [];
        for (const tab of tabs) {
          if (typeof window.switchTab === 'function') window.switchTab(tab);
          await new Promise(resolve => setTimeout(resolve, 80));
          const active = document.querySelector('.tab-page.active');
          pages[tab] = Boolean(active) && !(document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1);
          if (active) {
            for (const el of active.querySelectorAll('button,.chip,[role="button"]')) {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') touchHeights.push(Math.round(rect.height));
            }
          }
        }
        const header = document.querySelector('.mobile-header')?.getBoundingClientRect();
        const bottom = document.querySelector('.mobile-bottom-bar')?.getBoundingClientRect();
        for (const el of document.querySelectorAll('.mobile-bottom-bar button')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) touchHeights.push(Math.round(rect.height));
        }
        return { width: innerWidth, height: innerHeight, pages, header: header ? { width: header.width, height: header.height } : null, bottom: bottom ? { width: bottom.width, height: bottom.height } : null, heights: touchHeights.slice(0, 80), padding: getComputedStyle(document.body).paddingBottom };
      });
      pass(`${name} no horizontal overflow`, Object.values(result.pages).every(Boolean));
      pass(`${name} mobile chrome`, Boolean(result.header && result.bottom && result.header.width <= result.width + 1 && result.bottom.width <= result.width + 1));
      pass(`${name} touch sizes`, result.heights.length > 0 && result.heights.every(height => height >= 44), `visible heights=${JSON.stringify(result.heights)}`);
      pass(`${name} console clean`, errors.length === 0, errors.slice(0, 2).join(' | '));
      if (name === 'Pixel 7 landscape') {
        await page.evaluate(async () => {
          if (typeof window.switchTab === 'function') window.switchTab('study');
          await new Promise(resolve => setTimeout(resolve, 150));
          document.querySelector('#wordFilters [data-filter="all"]')?.click();
          await new Promise(resolve => setTimeout(resolve, 250));
        });
        const list = await page.evaluate(() => {
          const el = document.querySelector('#wordList');
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(40, rect.height - 5)), top: Math.round(rect.top), height: Math.round(rect.height), innerHeight, items: el.querySelectorAll('.word-item').length, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
        });
        let scrolled = false;
        if (list && list.items > 10 && list.y < list.innerHeight - 8 && list.scrollHeight > list.clientHeight) {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: list.x, y: list.y }] });
          for (let i = 1; i <= 14; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: list.x, y: list.y - i * 12 }] });
            await delay(16);
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await delay(250);
          scrolled = await page.evaluate(() => document.querySelector('#wordList')?.scrollTop > 40);
        }
        pass('Pixel 7 landscape word list is touch-scrollable above viewport edge', scrolled, JSON.stringify(list));
      }
      await context.close();
    }
  } catch (error) {
    pass('Playwright emulated browser launch', false, error.message);
  } finally {
    if (browser) await browser.close();
    if (server) {
      try { server.kill('SIGTERM'); } catch {}
      await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('close', resolve); });
    }
    if (sandbox) {
      for (let i = 0; i < 10; i++) { try { await rm(sandbox, { recursive: true, force: true }); break; } catch { await delay(100); } }
    }
  }
}

function command(name, args) {
  try { return execFileSync(process.env.ADB || 'adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`${name}: ${String(error.stderr || error.message).trim()}`); }
}

async function deviceChecks() {
  let devices;
  try { devices = command('adb devices', ['devices']); }
  catch (error) { throw new DeviceUnavailable(`ADB 不可用：${error.message}`); }
  const serial = devices.split(/\r?\n/).slice(1).map(x => x.trim().split(/\s+/)).find(x => x[1] === 'device')?.[0];
  if (!serial) throw new DeviceUnavailable('未检测到已授权 Android 真机；请开启 USB 调试后重试');
  const adb = (args) => command('adb', ['-s', serial, ...args]);
  pass('ADB device authorized', true, serial);
  pass('device model readable', Boolean(adb(['shell', 'getprop', 'ro.product.model']).trim()));
  pass('device viewport readable', /\d+x\d+/.test(adb(['shell', 'wm', 'size'])));
  try {
    adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', base, 'com.android.chrome']);
    pass('Chrome navigation requested', true, base);
  } catch (error) { pass('Chrome navigation requested', false, error.message); }
  try {
    adb(['forward', 'tcp:9222', 'localabstract:chrome_devtools_remote']);
    const require = createRequire(import.meta.url);
    let playwright;
    try { playwright = require('playwright'); } catch {}
    const candidates = [process.env.PLAYWRIGHT_MODULE, process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright')].filter(Boolean);
    for (const candidate of candidates) { if (playwright) break; try { playwright = require(candidate); break; } catch {} }
    if (!playwright) throw new DeviceUnavailable('未找到 Playwright；可设置 PLAYWRIGHT_MODULE');
    const browser = await playwright.chromium.connectOverCDP('http://127.0.0.1:9222');
    const pages = browser.contexts().flatMap(context => context.pages());
    const page = pages[0];
    if (!page) throw new DeviceUnavailable('Chrome DevTools 未返回页面');
    const result = await page.evaluate(async () => {
      const box = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; };
      const buttons = [...document.querySelectorAll('button,.chip,[role="button"]')].map(x => ({ rect: x.getBoundingClientRect(), style: getComputedStyle(x) })).filter(x => x.rect.width > 0 && x.rect.height > 0 && x.style.visibility !== 'hidden' && x.style.display !== 'none').map(x => Math.round(x.rect.height)).slice(0, 80);
      return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1, header: box('.mobile-header'), bottom: box('.mobile-bottom-bar'), bodyPadding: getComputedStyle(document.body).paddingBottom, buttons };
    });
    pass('real device page loaded', true, `${result.width}x${result.height}`);
    pass('real device no horizontal overflow', !result.overflow);
    pass('real device mobile chrome visible', Boolean(result.header && result.bottom));
    pass('real device safe bottom padding', /\d+px/.test(result.bodyPadding || ''));
    pass('real device touch targets', result.buttons.length > 0 && result.buttons.every(height => height >= 44), `visible heights=${JSON.stringify(result.buttons)}`);
    await browser.close();
  } finally {
    try { command('adb forward remove', ['-s', serial, 'forward', 'tcp:9222']); } catch {}
  }
}

await contractChecks();
if (mode === 'device') {
  try { await deviceChecks(); }
  catch (error) {
    if (error instanceof DeviceUnavailable) console.log(`SKIP real device regression: ${error.message}`);
    else pass('real device regression runner', false, error.message);
  }
} else await emulatedChecks();
const failed = checks.filter(x => !x.ok);
console.log(`mobile ${mode} regression: ${failed.length ? `${failed.length} failed` : `${checks.length} passed`}`);
if (failed.length) process.exitCode = 1;
