#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const sandbox = await mkdtemp(join(tmpdir(), 'workbench-refinement-'));
const port = 19200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let server;

try {
  await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
  await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
  await cp(join(root, 'corpus'), join(sandbox, 'corpus'), { recursive: true });
  await mkdir(join(sandbox, 'data'), { recursive: true });
  await writeFile(join(sandbox, 'data', 'db.json'), JSON.stringify({ words: {}, glosses: {}, notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [] }));
  const provider = { id: 'refine-provider', name: 'Refinement mock', baseUrl: '', apiKey: '', model: 'mock', vision: true };
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
    llm: { mock: true, activeId: provider.id, providers: [provider] },
    review: { providerId: provider.id, model: '' }, selection: { providerId: provider.id, model: '' },
    story: { providerId: provider.id, model: '' }, writingOcr: { providerId: provider.id, model: '' },
    autoSync: { enabled: false, minutes: 60 }, auth: { enabled: false },
  }));

  server = spawn(process.execPath, ['server.js'], {
    cwd: sandbox,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch {}
    await delay(100);
    if (i === 79) throw new Error('frontend refinement sandbox failed to start');
  }

  const { chromium, devices } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors = [];
    const writes = [];
    const quizCalls = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/config') writes.push(JSON.parse(request.postData() || '{}'));
    });
    await page.route('**/api/words*', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('filter') === 'today') {
        return route.fulfill({ json: { words: [
          { id: 1, spelling: 'practice', gloss: { gloss: '练习' } },
          { id: 2, spelling: 'memory', gloss: { gloss: '记忆' } },
          { id: 3, spelling: 'review', gloss: { gloss: '复习' } },
        ] } });
      }
      return route.continue();
    });
    await page.route('**/api/quiz/generate', async route => {
      quizCalls.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ json: { ok: false, reason: 'too_few_words' } });
    });

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('#studyPlanCard > summary').click();
    await page.locator('#studyPlanExamType').selectOption('cet6');
    await page.locator('#studyPlanExamDate').fill('2027-06-15');
    await page.locator('#studyPlanWords').fill('24');
    await page.locator('#studyPlanMinutes').fill('40');
    await page.locator('#studyPlanSaveBtn').click();
    await page.waitForFunction(() => document.querySelector('#studyPlanResult')?.textContent === '已保存');
    assert.match(await page.locator('#studyPlanSummary').textContent(), /六级.*2027-06-15.*24 词 \/ 40 分钟/);
    assert.equal(await page.locator('#studyPlanCard').evaluate(el => el.open), false, 'saved plan should collapse into its summary');
    console.log('PASS plan save and collapsed summary');

    await page.evaluate(() => switchTab('reports'));
    await page.locator('[data-report-view="maimemo"]').click();
    assert.equal(await page.locator('#report-maimemo').evaluate(el => el.hidden), false);
    assert.equal(await page.locator('#report-workbench').evaluate(el => el.hidden), true);
    assert.equal(await page.locator('#quizOverview').evaluate(el => el.closest('#report-workbench') !== null), true);
    console.log('PASS report source separation');

    await page.evaluate(() => switchTab('unit'));
    assert.equal(await page.locator('#tab-unit').evaluate(el => el.classList.contains('active')), true);
    assert.equal(await page.locator('.tab[data-tab="exam"]').evaluate(el => el.classList.contains('active')), true);
    await page.locator('#tab-unit [data-training-view="exam"]').click();
    assert.equal(await page.locator('#tab-exam').evaluate(el => el.classList.contains('active')), true);
    console.log('PASS unified exam and unit entry');

    await page.evaluate(() => switchTab('settings'));
    await page.locator('#modelAssignments').evaluate(el => {
      for (let node = el; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
      el.style.display = '';
    });
    await page.waitForFunction(() => document.querySelectorAll('#cfgReviewProvider option[value="refine-provider"]').length === 1);
    for (const id of ['cfgReviewProvider', 'cfgSelectionProvider', 'cfgStoryProvider', 'cfgWritingOcrProvider']) await page.locator(`#${id}`).selectOption('refine-provider', { force: true });
    await page.locator('#cfgReviewModel').fill('review-model');
    await page.locator('#cfgSelectionModel').fill('selection-model');
    await page.locator('#cfgStoryModel').fill('story-model');
    await page.locator('#cfgWritingOcrModel').fill('vision-model');
    await page.locator('#saveModelAssignmentsBtn').click();
    await page.locator('#modelAssignmentsResult').getByText('模型分配已保存').waitFor();
    assert.equal(writes.length, 1, 'model assignments should use a single config write');
    assert.deepEqual(Object.keys(writes[0]).sort(), ['review', 'selection', 'story', 'writingOcr']);
    assert.equal(writes[0].writingOcr.model, 'vision-model');
    console.log('PASS one-save model assignments');

    const styles = ['', 'arcade', 'pop', 'mc', 'mc-gui', 'mc-deep', 'mc-end'];
    for (const style of styles) {
      await page.evaluate(value => applyStyle(value), style);
      assert.equal(await page.locator('html').getAttribute('data-style') || '', style);
      await page.evaluate(() => switchTab('dashboard'));
      assert.equal(await page.locator('#todayTasksCard').evaluate(el => getComputedStyle(el).transform), 'none');
    }
    await page.evaluate(() => applyTheme('dark'));
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.evaluate(() => applyTheme('light'));
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    console.log('PASS seven styles, day/night themes, and calm card hover');

    await page.evaluate(() => switchTab('quiz'));
    await page.locator('#quizCount').fill('3');
    await page.locator('#quizAssembly').selectOption('fixed');
    await page.locator('#quizStartBtn').click();
    await page.locator('#quizRun').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#quizSetup').evaluate(el => getComputedStyle(el).display === 'none'), true);
    await page.locator('#quizQuitBtn').click();
    await page.locator('#quizAssembly').selectOption('adaptive');
    assert.equal(await page.locator('#quizAdaptiveFold').evaluate(el => el.hidden), false);
    await page.locator('#quizStartBtn').click();
    await page.locator('#quizMsg').getByText('单词太少').waitFor();
    assert.equal(quizCalls.length, 1);
    assert.equal(quizCalls[0].count, 3);
    console.log('PASS shared fixed/adaptive start control');

    const mobileContext = await browser.newContext(devices['Pixel 7']);
    const mobile = await mobileContext.newPage();
    const mobileErrors = [];
    mobile.on('pageerror', error => mobileErrors.push(error.message));
    await mobile.goto(base, { waitUntil: 'networkidle' });
    for (const tab of ['dashboard', 'reports', 'quiz', 'exam', 'unit', 'settings']) {
      await mobile.evaluate(name => switchTab(name), tab);
      const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, `${tab} has horizontal overflow`);
    }
    await mobile.locator('#bottomMoreBtn').click();
    assert.equal(await mobile.locator('#moreSheet').evaluate(el => el.classList.contains('open')), true);
    assert.equal(await mobile.locator('#moreSheet').evaluate(el => getComputedStyle(el).visibility), 'visible');
    await mobile.locator('.more-sheet-item[data-tab="reports"]').click();
    assert.equal(await mobile.locator('#moreSheet').evaluate(el => el.classList.contains('open')), false);
    assert.equal(await mobile.locator('#bottomMoreBtn').evaluate(el => el.classList.contains('active')), true);
    const touchTargets = await mobile.locator('.mobile-bottom-bar button, #moreSheet summary').evaluateAll(items => items.filter(el => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    }).map(el => Math.round(el.getBoundingClientRect().height)));
    assert(touchTargets.length && touchTargets.every(height => height >= 44), `mobile controls under 44px: ${touchTargets}`);
    assert.equal(mobileErrors.length, 0, mobileErrors.join('\n'));
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    console.log('PASS mobile more-sheet, navigation, touch sizes, and browser console');
    await mobileContext.close();
  } finally { await browser.close(); }
} finally {
  if (server) {
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('close', resolve); });
  }
  await rm(sandbox, { recursive: true, force: true });
}
