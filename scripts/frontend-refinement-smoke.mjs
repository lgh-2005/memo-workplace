#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), 'workbench-refinement-'));
const port = 19200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
let server;

try {
  await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
  await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
  await cp(join(root, 'corpus'), join(sandbox, 'corpus'), { recursive: true });
  await mkdir(join(sandbox, 'data'), { recursive: true });
  await writeFile(join(sandbox, 'data', 'db.json'), JSON.stringify({ words: {
    practice: { id: 1, spelling: 'practice', today: { date: today } },
    memory: { id: 2, spelling: 'memory', today: { date: today } },
    review: { id: 3, spelling: 'review', tags: ['STICKING'] },
  }, glosses: { practice: { gloss: '练习', pos: 'n.' }, memory: { gloss: '记忆', pos: 'n.' } }, notes: [], sessions: [], syncLog: [], quizLog: [], unitLog: [] }));
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
    await page.locator('#mistWordBody .mist-word').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-style'), 'mist');
    assert.equal(await page.locator('#sidebarToggle').isVisible(), false);
    assert.equal(await page.locator('#appSidebar .tabs').evaluate(el => getComputedStyle(el).flexDirection), 'row');
    assert.equal(await page.locator('.tab:visible').count(), 7);
    const image = await fetch(`${base}/mist/hero-dawn.webp`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/webp');
    await image.arrayBuffer();
    const first = await page.locator('#mistWordBody .mist-word').textContent();
    assert(['practice', 'memory'].includes(first));
    await page.locator('#mistWordNext').click();
    const second = await page.locator('#mistWordBody .mist-word').textContent();
    assert(['practice', 'memory'].includes(second) && first !== second);
    await page.locator('#mistWordStudy').click();
    await page.locator('#wordPanel.open').waitFor();
    assert.equal(await page.locator('#wordSearch').inputValue(), second);
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'study');
    await page.goBack();
    await page.locator('#tab-dashboard.active').waitFor();
    await page.goForward();
    await page.locator('#tab-study.active').waitFor();
    await page.goBack();
    await page.locator('#mistOpenSample').click();
    await page.locator('#coachDetail').getByText('老师示范').first().waitFor();
    await page.goBack();
    await page.locator('#tab-dashboard.active').waitFor();
    const initial = await page.locator('#mistTicketSummary').textContent();
    // v4.6.0：今日任务只剩今日词汇 / 到期与错题复习，「真题训练」已下线
    assert.equal(await page.locator('[data-study-start="exam_practice"]').count(), 0);
    assert.equal(await page.locator('#todayTasksList .study-task').count(), 2);
    await page.locator('[data-study-start="review_due"]').click();
    await page.locator('#tab-quiz.active').waitFor();
    await page.goBack();
    await page.locator('#tab-dashboard.active').waitFor();
    assert.equal(await page.locator('#mistTicketSummary').textContent(), initial);
    // 沙箱里没有学习流水：错题复习按 0 待复习自动完成，今日词汇仍待办
    assert.match(initial, /1 \/ 2 项已完成/);
    assert.equal(await page.locator('[data-study-complete="vocab_today"]').isDisabled(), false);
    await page.locator('[data-study-complete="vocab_today"]').check();
    await page.locator('#mistTicketSummary').getByText('2 / 2 项已完成').waitFor();
    await page.locator('[data-study-complete="vocab_today"]').uncheck();
    await page.locator('#mistTicketSummary').getByText('1 / 2 项已完成').waitFor();
    await page.evaluate(() => applyTheme('dark'));
    assert.match(await page.locator('.mist-hero').evaluate(el => getComputedStyle(el).backgroundImage), /hero-night/);
    await page.evaluate(() => applyTheme('light'));
    console.log('PASS Mist default layout, real words, history, sample, independent task navigation/progress, night art');

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
    await page.locator('[data-report-view="workbench"]').click();
    await page.route('**/api/learning/report?days=14', async route => {
      await delay(550);
      await route.fulfill({ status: 502, json: { error: '过期请求' } });
    });
    await page.locator('.report-win-btn[data-days="14"]').click();
    await page.locator('.report-win-btn[data-days="30"]').click();
    await page.waitForFunction(() => document.querySelector('#learningReportBody').getAttribute('aria-busy') === 'false');
    await delay(600);
    assert.equal(await page.locator('#reportWinLabel').textContent(), '最近 30 天');
    assert.equal(await page.locator('.report-win-btn[data-days="30"]').getAttribute('aria-pressed'), 'true');
    assert.doesNotMatch(await page.locator('#learningReportBody').textContent(), /过期请求/);
    console.log('PASS latest report range wins across out-of-order responses');


    await page.evaluate(() => switchTab('kb'));
    assert.equal(await page.locator('#tab-kb').evaluate(el => el.classList.contains('active')), true);
    assert.equal(await page.locator('.tab[data-tab="exam"]').count(), 0, 'v4.0.0：独立真题页签必须下线');
    assert.equal(await page.locator('.tab[data-tab="pomo"]').count(), 0, 'v4.0.0：番茄钟页签必须下线');
    assert.equal(await page.locator('#kbFilters [data-kcat="真题"]').count(), 1, '语料库必须保留真题筛选档');
    console.log('PASS exam merged into corpus, standalone exam/pomodoro tabs removed');

    // v4.3.1：听说训练页签下线 + 左侧边栏折叠为图标窄栏（折叠状态刷新后保持）
    assert.equal(await page.locator('.tab[data-tab="speaking"]').count(), 0, 'v4.3.1：听说训练页签必须下线');
    assert.equal(await page.locator('#tab-speaking').count(), 0, 'v4.3.1：听说训练页面必须下线');
    assert.equal(await page.locator('#installBtn').count(), 0, 'v4.3.1：设置里的安装按钮必须下线');
    // v4.5.0：晨雾使用顶部胶囊导航，旧侧栏折叠按钮不再显示（折叠逻辑保留但无入口）
    assert.equal(await page.locator('#sidebarToggle').isVisible(), false, '晨雾顶部导航下不显示侧栏折叠按钮');
    assert.equal(await page.locator('.tab:visible').count(), 7, '晨雾桌面保留 7 个页签');
    assert.equal(await page.locator('#appSidebar .tabs').evaluate(el => getComputedStyle(el).flexDirection), 'row');
    console.log('PASS mist top navigation replaces legacy collapsible sidebar');
    await page.evaluate(() => switchTab('settings'));
    // v4.5.0：设置只有一行横列导航，先切到「模型服务」分区，再展开功能模型分配
    assert.equal(await page.locator('#settingsNavItems .mist-page-nav-btn').count(), 7, '非多用户下设置横列应有 7 个分区');
    await page.locator('#settingsNavItems [data-settings-jump="modelSection"]').click();
    assert.equal(await page.locator('#tab-settings > section.settings-panel:visible').count(), 1, '设置同一时刻只能显示一个分区');
    assert.equal(await page.locator('#ttsSection').evaluate(el => el.hidden), true, '切换到模型服务后发音分区必须隐藏');
    await page.locator('#modelAssignments').evaluate(el => {
      for (let node = el; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
      el.style.display = '';
    });
    await page.waitForFunction(() => document.querySelectorAll('#cfgReviewProvider option[value="refine-provider"]').length === 1);
    for (const id of ['cfgReviewProvider', 'cfgSelectionProvider', 'cfgStoryProvider']) await page.locator(`#${id}`).selectOption('refine-provider', { force: true });
    await page.locator('#cfgReviewModel').fill('review-model');
    await page.locator('#cfgSelectionModel').fill('selection-model');
    await page.locator('#cfgStoryModel').fill('story-model');
    await page.locator('#saveModelAssignmentsBtn').click();
    await page.locator('#modelAssignmentsResult').getByText('模型分配已保存').waitFor();
    assert.equal(writes.length, 1, 'model assignments should use a single config write');
    assert.deepEqual(Object.keys(writes[0]).sort(), ['review', 'selection', 'story']);
    console.log('PASS one-save model assignments');

    // v4.5.0：界面只保留晨雾，旧风格入口、样式与本地偏好全部下线
    await page.evaluate(() => { try { localStorage.setItem('wb-style', 'arcade'); } catch {} });
    await page.evaluate(() => applyStyle('arcade'));
    assert.equal(await page.locator('html').getAttribute('data-style'), 'mist', '旧风格参数必须被忽略，始终落在晨雾');
    assert.equal(await page.evaluate(() => localStorage.getItem('wb-style')), null, '旧风格本地偏好必须清除');
    assert.equal(await page.locator('#styleGrid').count(), 0, '设置里的风格选择器必须下线');
    assert.equal(await page.locator('.style-opt').count(), 0, '旧风格按钮必须下线');
    const shippedCss = await (await fetch(`${base}/style.css`)).text();
    assert.doesNotMatch(shippedCss, /\[data-style="(classic|arcade|pop|mc)/, '线上样式不得再含旧风格主题');
    await page.evaluate(() => switchTab('dashboard'));
    assert.equal(await page.locator('#todayTasksCard').evaluate(el => getComputedStyle(el).transform), 'none');
    await page.evaluate(() => applyTheme('dark'));
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.evaluate(() => applyTheme('light'));
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    console.log('PASS mist-only styling, day/night themes, and calm card hover');

    await page.evaluate(() => switchTab('quiz'));
    // 前面从今日任务进过「错题复练」，这里切回基础回忆再看组卷
    await page.locator('[data-submode="basic"]').click();
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

    const mobileContext = await browser.newContext({ ...devices['Pixel 7'], reducedMotion: 'reduce' });
    const mobile = await mobileContext.newPage();
    const mobileErrors = [];
    mobile.on('pageerror', error => mobileErrors.push(error.message));
    await mobile.goto(base, { waitUntil: 'networkidle' });
    const hero = await mobile.locator('.mist-hero').boundingBox();
    const tasks = await mobile.locator('#todayTasksCard').boundingBox();
    assert(hero && hero.height < 340 && tasks.y < 550, 'Mist should keep today tasks near the first screen');
    assert.equal(await mobile.locator('#tab-dashboard').evaluate(el => Number.parseFloat(getComputedStyle(el).animationDuration) < .01), true);
    for (const tab of ['dashboard', 'reports', 'quiz', 'kb', 'notes', 'settings']) {
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
