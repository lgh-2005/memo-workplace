import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const exists = file => existsSync(file);
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const deploy = await readFile(join(root, 'scripts', 'deploy.sh'), 'utf8');
const rollback = await readFile(join(root, 'scripts', 'rollback.sh'), 'utf8');
const ci = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const serverSrc = await readFile(join(root, 'server.js'), 'utf8');
const appSrc = await readFile(join(root, 'public', 'app.js'), 'utf8');
const indexHtml = await readFile(join(root, 'public', 'index.html'), 'utf8');
const sw = await readFile(join(root, 'public', 'sw.js'), 'utf8');
const mistCss = await readFile(join(root, 'public', 'mist.css'), 'utf8');
const mistAssets = ['mist.css', ...['hero-dawn', 'hero-night', 'paper', 'cover-lesson', 'cover-ridge', 'band-report', 'cover-quiz', 'cover-library', 'cover-notes', 'cover-settings', 'empty-ink'].map(name => `mist/${name}.webp`)];
const required = [
  // v3.8.0：版本断言改为跟随 package.json，避免每次发版都要改脚本（沿用 v3.7.1 思路）
  ['package version', packageJson.version === '4.4.1'],
  // v4.0.0：定位收缩为「英语单词学习工作台」——真题并入语料库、做题面下线、番茄钟与写作升格删除
  ['v4 removed writing api', !/p === '\/api\/writing\//.test(serverSrc)],
  ['v4 removed unit api', !/p === '\/api\/unit\//.test(serverSrc)],
  ['v4 corpus exam projection', serverSrc.includes("p === '/api/kb/exams'") && appSrc.includes('kbAppendExamReading')],
  ['v4 nav has no exam/pomodoro tab', !indexHtml.includes('data-tab="exam"') && !indexHtml.includes('data-tab="pomo"')],
  // v4.3.1：听说训练整链路下线、设置里的桌面安装入口移除、侧边栏可折叠
  ['v4.3.1 removed speaking tab', !indexHtml.includes('data-tab="speaking"') && !indexHtml.includes('id="tab-speaking"')],
  ['v4.3.1 removed speaking routes', !/p === '\/api\/speaking\//.test(serverSrc) && !appSrc.includes('/api/speaking/')],
  ['v4.3.1 removed install-to-desktop entry', !indexHtml.includes('id="installSection"') && !appSrc.includes('pwaInitInstall')],
  ['v4.3.1 keeps pwa shell registration', appSrc.includes('pwaRegisterSW()') && indexHtml.includes('rel="manifest"')],
  ['v4.3.1 sidebar collapse hook', indexHtml.includes('id="sidebarToggle"') && appSrc.includes('sidebar-collapsed') && appSrc.includes('applySidebarCollapse')],
  ['v4.3.1 no microphone permission', !serverSrc.includes("microphone=(self)")],
  ['Mist stylesheet and imagery ship with offline shell', indexHtml.includes('href="mist.css"') && mistAssets.every(asset => exists(join(root, 'public', asset)) && sw.includes(`'/${asset}'`))],
  // v4.4.1：晨雾铺到全部版块 + 任务票据并入首页卡片（不再负边距叠压）+ 键盘交互层
  ['v4.4.1 task ticket lives inside the hero card', /<header class="mist-hero"[\s\S]*?<section class="mist-ticket"[\s\S]*?<\/section>\s*<\/header>/.test(indexHtml)],
  ['v4.4.1 ticket does not float with negative margin', !/\.mist-ticket\s*\{[^}]*margin:\s*-/s.test(mistCss) && !/margin:\s*-33px/.test(mistCss)],
  ['v4.4.1 ticket cells are real buttons', indexHtml.includes('id="mistTaskCells"') && mistCss.includes('.mist-ticket-cell') && appSrc.includes('mist-cell-bar')],
  ['v4.4.1 every page has a mist band', ['quiz', 'kb', 'notes', 'settings', 'study', 'report'].every(name => indexHtml.includes(`mist-band-${name}`))],
  ['v4.4.1 page bands use generated art', ['cover-quiz', 'cover-library', 'cover-notes', 'cover-settings'].every(name => mistCss.includes(`/mist/${name}.webp`))],
  ['v4.4.1 command palette wiring', indexHtml.includes('id="mistPalette"') && appSrc.includes('mistPaletteSetOpen') && appSrc.includes('MIST_TAB_ACTIONS') && indexHtml.includes('id="paletteToggle"')],
  ['v4.4.1 settings index nav', indexHtml.includes('id="settingsNavItems"') && appSrc.includes('refreshMistSettingsNav') && appSrc.includes('mistSettingsSpy')],
  ['v4.4.1 motion respects reduced motion', mistCss.includes('prefers-reduced-motion: reduce') && mistCss.includes('mist-glow') && mistCss.includes('mist-row-in')],
  ['deploy dry-run', deploy.includes('--dry-run') && deploy.includes('DRY_RUN')],
  ['rollback dry-run', rollback.includes('--dry-run') && rollback.includes('DRY_RUN')],
  ['deploy data exclusion', deploy.includes('--exclude data/')],
  ['deploy corpus exclusion', deploy.includes('--exclude corpus/records.jsonl') && deploy.includes('--exclude corpus/exams.jsonl')],
  ['deploy external script exclusion', deploy.includes('--exclude scripts/pull_external.sh')],
  ['rollback data exclusion', rollback.includes('--exclude data/')],
  ['rollback external script exclusion', rollback.includes('--exclude scripts/pull_external.sh')],
  ['versioned backup', deploy.includes('VERSION_TAG') && deploy.includes('data_backup_v${VERSION_TAG}_')],
  ['release gate before apply', deploy.includes('release-gate.mjs')],
  ['remote release gate before backup', deploy.includes('--refs --remote --sha') && deploy.indexOf('--refs --remote --sha') < deploy.indexOf('backing up data')],
  ['post-deploy health automation', deploy.includes('online-health.mjs')],
  ['rollback health automation', rollback.includes('online-health.mjs')],
  ['backup drill on deploy', deploy.includes('backup-restore-drill.mjs')],
  ['backup archive excludes prior backups', deploy.includes('--exclude=data/backups')],
  ['CI installs Playwright browser', ci.includes('playwright install --with-deps chromium')],
  ['backup restore drill', exists(join(root, 'scripts', 'backup-restore-drill.sh'))],
  ['release gate', exists(join(root, 'scripts', 'release-gate.mjs'))],
  ['online health check', exists(join(root, 'scripts', 'online-health.mjs'))],
  ['security audit', exists(join(root, 'scripts', 'security-audit.mjs'))],
  ['mobile regression', exists(join(root, 'scripts', 'mobile-device-check.mjs'))],
  ['docs consistency', exists(join(root, 'scripts', 'docs-consistency.mjs'))],
  ['study plan smoke', exists(join(root, 'scripts', 'study-plan-smoke.mjs'))],
  ['speaking attempt purge tool', exists(join(root, 'scripts', 'purge-speaking-attempts.mjs'))],
  ['tts smoke', exists(join(root, 'scripts', 'tts-smoke.mjs'))],
  ['ecdict smoke', exists(join(root, 'scripts', 'ecdict-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('ecdict-smoke.mjs')],
  ['ecdict bubble ui', exists(join(root, 'scripts', 'ecdict-bubble-ui-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('ecdict-bubble-ui-smoke.mjs')],
  ['ecdict lemma builder', exists(join(root, 'scripts', 'ecdict-build-lemma.mjs'))],
  ['today response smoke', exists(join(root, 'scripts', 'today-response-smoke.mjs'))],
  ['today snapshot smoke', exists(join(root, 'scripts', 'today-snapshot-smoke.mjs'))],
  ['piper worker tooling', exists(join(root, 'tools', 'tts', 'piper_worker.py')) && exists(join(root, 'tools', 'tts', 'setup_piper.sh'))],
  ['front-end refinement browser regression', exists(join(root, 'scripts', 'frontend-refinement-smoke.mjs')) && exists(join(root, 'scripts', 'test.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('frontend-refinement-smoke.mjs')],
  ['exam analysis smoke', exists(join(root, 'scripts', 'exam-analysis-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('exam-analysis-smoke.mjs')],
  ['exam analysis builder', exists(join(root, 'scripts', 'exam-analysis-build.mjs'))],
  ['exam analysis audit', exists(join(root, 'scripts', 'exam-analysis-audit.mjs'))],
  ['exam analysis corpus shipped', exists(join(root, 'corpus', 'exam_analysis'))],
  ['vocab chat smoke', exists(join(root, 'scripts', 'vocab-chat-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('vocab-chat-smoke.mjs')],
  // v4.1.0：词汇精练「AI 带练」——出题 / 判分 / 关卡推进 / 降级；
  // v4.2.0 扩到 34 项断言，补「词表悬浮球」与「词群联动（多词上下文 / focus 归属）」契约
  ['tutor drill smoke', exists(join(root, 'scripts', 'tutor-drill-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('tutor-drill-smoke.mjs')],
  ['static cache smoke', exists(join(root, 'scripts', 'static-cache-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('static-cache-smoke.mjs')],
  ['static cache contract in server', (await readFile(join(root, 'server.js'), 'utf8')).includes('function serveStaticFile') && (await readFile(join(root, 'server.js'), 'utf8')).includes("'Cache-Control': 'no-cache'")],
];
const failed = required.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`release checks failed: ${failed.join(', ')}`);
console.log(`release checks passed: ${required.length}`);
