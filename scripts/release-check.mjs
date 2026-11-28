import { readFile, readdir } from 'node:fs/promises';
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
const styleCss = await readFile(join(root, 'public', 'style.css'), 'utf8');
const faviconSvg = await readFile(join(root, 'public', 'icons', 'favicon.svg'), 'utf8');
const inkDir = join(root, 'public', 'icons', 'ink');
const inkFiles = (await readdir(inkDir)).filter(name => name.endsWith('.png')).sort();
const iconFiles = ['favicon.ico', 'favicon.svg', 'icon-120.png', 'icon-152.png', 'icon-167.png', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png'];
const mistAssets = ['mist.css', ...['hero-dawn', 'hero-night', 'paper', 'cover-lesson', 'cover-ridge', 'band-report', 'cover-quiz', 'cover-library', 'cover-notes', 'cover-settings', 'empty-ink'].map(name => `mist/${name}.webp`)];
const inkWriter = appSrc.slice(appSrc.indexOf('function inkFragment('), appSrc.indexOf('/** v2.1.0a 补齐：右下角轻提示'));
const EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F]/u;
const required = [
  // v3.8.0：版本断言改为跟随 package.json，避免每次发版都要改脚本（沿用 v3.7.1 思路）
  ['package version', packageJson.version === '4.9.1'],
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
  ['v4.4.1 motion respects reduced motion', mistCss.includes('prefers-reduced-motion: reduce') && mistCss.includes('mist-glow') && mistCss.includes('mist-row-in')],
  // v4.5.0：设置只留一行横列导航 + 界面只留晨雾 + 朱印图标族
  ['v4.5.0 settings is a single horizontal switcher', indexHtml.includes('id="settingsNavItems"') && !indexHtml.includes('settingsFoldAll') && appSrc.includes('mistSettingsSetActive') && appSrc.includes('refreshMistSettingsNav') && !appSrc.includes('mistSettingsSpy')],
  ['v4.5.0 settings panels are sections', (indexHtml.match(/class="settings-section settings-panel"/g) || []).length >= 7 && !indexHtml.includes('<details class="settings-section"')],
  ['v4.5.0 mist is the only UI style', !indexHtml.includes('styleGrid') && !appSrc.includes('applyStyle(t') && !/(^|\n)\s*\[data-style="(classic|arcade|pop|mc)/.test(styleCss)],
  ['v4.5.0 seal favicon and pwa icon family', iconFiles.every(name => exists(join(root, 'public', 'icons', name))) && faviconSvg.includes('词') && sw.includes("'/icons/favicon.ico'")],
  // v4.6.0：删掉无意义解释性小字 + 生图水墨图标族 + 今日任务去掉「真题训练」
  ['v4.6.0 explanatory micro-copy removed', !indexHtml.includes('class="hint-fold"') && !indexHtml.includes('<span class="mist-kicker">') && (indexHtml.match(/class="[^"]*\bhint\b[^"]*"/g) || []).length <= 7 && !/<p[ >]/.test(indexHtml)],
  ['v4.6.0 ink icon family shipped', inkFiles.length >= 36 && inkFiles.every(name => exists(join(inkDir, name))) && mistCss.includes('/icons/ink/dashboard.png') && sw.includes("'/icons/ink/notes.png'") && sw.includes("'/icons/ink/sun.png'")],
  ['v4.6.0 emoji glyphs replaced in chrome', !/class="tab-icon" aria-hidden="true">[^<]/.test(indexHtml) && !/class="bottom-tab-icon">[^<]/.test(indexHtml) && !/class="more-item-icon">[^<]/.test(indexHtml) && !/id="themeToggle"[^>]*>[^<]+\s*<\/button>/.test(indexHtml) && !/id="mobileThemeToggle"[^>]*>[^<]+\s*<\/button>/.test(indexHtml)],
  ['v4.6.0 chip counts keep ink icons', appSrc.includes("chip.querySelector('.chip-label')") && !/chip\.textContent\s*=\s*Number\.isFinite/.test(appSrc)],
  ['v4.6.0 theme toggle swaps ink class', appSrc.includes("classList.add('ink-' + icon)") && !appSrc.includes("btn.textContent = t === 'dark'")],
  ['v4.6.0 exam_practice task retired', !serverSrc.includes("id: 'exam_practice'") && !serverSrc.includes("'vocab_today', 'review_due', 'exam_practice'") && !appSrc.includes("exam_practice: '真题训练'")],
  // v4.7.0：残留的系统 emoji 全部换成水墨图标（图标族 89 枚，状态行改走 setInkText）
  ['v4.7.0 ink icon family covers every glyph', inkFiles.length >= 89 && ['person', 'lock', 'unlock', 'door', 'clock', 'compass', 'bug', 'puzzle', 'dice', 'chat', 'cycle', 'eye', 'undo', 'flame', 'calendar', 'hourglass', 'play', 'star', 'brain', 'trend', 'chart', 'news', 'cap', 'pin', 'ruler', 'tree', 'tile', 'card', 'keyboard', 'scale', 'broom', 'hook', 'arrow-left', 'arrow-right', 'arrows', 'ban', 'book-closed', 'face-think', 'face-dazed', 'face-uneasy', 'face-calm', 'face-cool', 'letter-a'].every(name => inkFiles.includes(name + '.png'))],
  ['v4.7.0 every icon file has a css mapping', inkFiles.every(name => mistCss.includes(`.ink-${name.replace(/\.png$/, '')} {`) && mistCss.includes(`/icons/ink/${name}`))],
  ['v4.7.0 no system emoji left in chrome', !EMOJI.test(indexHtml) && !EMOJI.test(appSrc) && !EMOJI.test(mistCss) && !EMOJI.test(serverSrc)],
  ['v4.7.0 status lines go through setInkText', appSrc.includes('function setInkText(') && appSrc.includes('function inkFragment(') && !/\.textContent\s*=\s*(`|')<i class="ink-glyph/.test(appSrc)],
  ['v4.7.0 setInkText never parses arbitrary html', !/innerHTML/.test(inkWriter) && /appendChild\(inkFragment\(s\)\)/.test(inkWriter) && inkWriter.includes('document.createTextNode')],
  ['v4.7.0 accent options are plain text', !indexHtml.includes('\u{1F1FA}\u{1F1F8}') && indexHtml.includes('>美式发音<') && indexHtml.includes('>英式发音<')],
  ['v4.7.0 sw precaches the whole icon family', inkFiles.every(name => sw.includes(`'/icons/ink/${name}'`))],
  // v4.8.0：学习方法（费曼 / 苏格拉底 / 对比辨析 / 空白回忆）——同一引擎四种关卡机，
  // 结果折算 SRS 并记账；四套提示词都进 DEFAULT_PROMPTS（设置页可改）。
  ['v4.8.0 method registry has four methods', ['feynman', 'socratic', 'contrast', 'blank'].every(id => new RegExp(`${id}: \\{\\s*\\n\\s*title:`).test(serverSrc)) && (serverSrc.match(/stages: \['\w+', '\w+', '\w+'\]/g) || []).length >= 4],
  ['v4.8.0 every method has a prompt in DEFAULT_PROMPTS', ['feynman', 'socratic', 'contrast', 'blank'].every(id => serverSrc.includes(`id: 'method_${id}'`) && serverSrc.includes(`method_${id}: {`))],
  ['v4.8.0 method routes exist', ["'/api/method/start'", "'/api/method/turn'", "'/api/method/settle'", "'/api/method/list'", "'/api/method/effect'"].every(r => serverSrc.includes(r))],
  ['v4.8.0 method settle writes srs + ledger', serverSrc.includes('function settleMethodRound(') && serverSrc.includes('applyQuizSrsSession(items, round.method)') && serverSrc.includes('recordMethodRun({') && serverSrc.includes("kind: 'method_practice'")],
  ['v4.8.0 method result maps to srs grade', /METHOD_RESULT_TO_GRADE = \{ independent: 'good', assisted: 'hard', needs_work: 'again' \}/.test(serverSrc)],
  ['v4.8.0 method ledger is backed up and validated', serverSrc.includes("const METHOD_LEDGER_FILE = 'method_ledger.json'") && serverSrc.includes('isMethodLedgerShape') && (serverSrc.match(/isMethodLedgerShape\(v\.obj\)/g) || []).length >= 3],
  ['v4.8.0 method page wired in front end', ['methodPane', 'methodRoster', 'methodStageCard', 'methodEffectCard'].every(id => indexHtml.includes(`id="${id}"`)) && appSrc.includes("'/api/method/start'") && appSrc.includes("'/api/method/settle'") && appSrc.includes('method_practice:')],
  ['v4.8.0 no method answer parsed as html', !/innerHTML = answer\b/.test(appSrc) && appSrc.includes('mdLite(data.feedback.coaching')],
  ['v4.9.0 sw cache name bumped', sw.includes("'wb-shell-v4.9.1'")],
  // v4.9.0：单词记忆宫殿。核心契约不是「有个 3D 页面」，而是四件容易退化的事：
  // ① 槽位固定 / 词流动（换词必须清掉旧联想，否则 A 的联想会挂在 B 身上）；
  // ② 复习结果真的折算 again/hard/good 进 quiz_srs（否则又是一个刷新即散的孤岛）；
  // ③ 只有 /palace/ 放开被同源 iframe 嵌入，其余路径仍 DENY（否则站点可被第三方嵌）；
  // ④ 3D 走独立子应用，主站首屏不加载 three.js。
  ['v4.9.0 palace file registered, backed up and shape-validated',
    serverSrc.includes("const PALACE_FILE = 'palace.json'") &&
    serverSrc.includes('{ file: PALACE_FILE, json: true, palace: true }') &&
    serverSrc.includes('function isPalaceShape(') &&
    (serverSrc.match(/f\.palace && !isPalaceShape\(v\.obj\)/g) || []).length >= 3],
  ['v4.9.0 palace routes exist and settle writes srs as palace_practice',
    ["'/api/palace/state'", "'/api/palace/assign'", "'/api/palace/slot'", "'/api/palace/mnemonic'", "'/api/palace/layout'", "'/api/palace/settle'"].every(r => serverSrc.includes(r)) &&
    serverSrc.includes('function settlePalaceReview(') &&
    serverSrc.includes('applyQuizSrsSession(accepted') &&
    serverSrc.includes("kind: 'palace_practice'") &&
    serverSrc.includes("'palace_practice',")],
  ['v4.9.0 palace AI only proposes candidates (learner decides)',
    serverSrc.includes("palace_mnemonic: {") &&
    serverSrc.includes('function normalizePalaceCandidates(') &&
    /PALACE_ROUTES = new Set\(\['origin', 'sound', 'scene'\]\)/.test(serverSrc)],
  ['v4.9.0 iframe embedding opened only for /palace/',
    serverSrc.includes("startsWith('/palace/')") &&
    serverSrc.includes("X-Frame-Options', 'SAMEORIGIN'") &&
    serverSrc.includes("X-Frame-Options', 'DENY'") &&
    /frame-src 'self'/.test(serverSrc)],
  ['v4.9.0 palace sub-app is standalone (no main-site css, no first-screen bytes)',
    exists(join(root, 'public', 'palace', 'index.html')) &&
    exists(join(root, 'public', 'palace', 'palace.js')) &&
    exists(join(root, 'public', 'palace', 'palace.css')) &&
    exists(join(root, 'public', 'palace', 'vendor', 'three.module.min.js')) &&
    !appSrc.includes('three.module.min.js') &&
    indexHtml.includes('data-sub="palace"') &&
    /if \(!frame\.getAttribute\('src'\)\)/.test(appSrc)],
  ['v4.9.0 static server serves directory index (no EISDIR crash)',
    serverSrc.includes('fs.statSync(filePath).isDirectory()') &&
    serverSrc.includes("path.join(filePath, 'index.html')")],
  ['v4.9.0 service worker leaves /palace/ alone',
    sw.includes("url.pathname.startsWith('/palace/')")],
  ['v4.9.0 palace degrades outside secure context',
    appSrc.includes('palace-review') === false &&
    (await readFile(join(root, 'public', 'palace', 'palace.js'), 'utf8')).includes('isSecureContext') &&
    (await readFile(join(root, 'public', 'palace', 'palace.js'), 'utf8')).includes('pickGround')],
  // v4.8.0：图标类「撞名」契约。v4.6/v4.7 的门禁只查「每个 PNG 都有 CSS 映射」，
  // 没查「同一个元素上两个 ink-* 类谁胜出」——`ink-card` 既当尺寸类又当图标名，
  // CSS 顺序让后出现的 card.png 覆盖掉前面真正的图标，17 处卡片标题全部画成同一张卡。
  // 现在尺寸类固定叫 ink-ico，图标名不再兼作尺寸类。
  ['v4.8.0 icon size class does not collide with icon names',
    /\n\[data-style="mist"\] \.ink-ico,/.test(mistCss) && !/\[data-style="mist"\] \.ink-ico \{ -webkit-mask-image/.test(mistCss) &&
    ['glyph', 'only', 'ico'].every(name => !new RegExp(`\\.ink-${name} \\{[^}]*mask-image`).test(mistCss))],
  ['v4.8.0 no icon element carries two mask-bearing classes', (() => {
    // 一个元素上只允许一个「承载 mask」的 ink-* 类；ink-glyph / ink-only / ink-ico 是尺寸/形态类，不承载 mask。
    const carriers = new Set([...mistCss.matchAll(/\[data-style="mist"\] \.ink-([a-z0-9-]+) \{[^}]*?mask-image: url\('\/icons\/ink\/[a-z0-9-]+\.png'\)/g)].map(m => m[1]));
    const sizeOnly = new Set(['glyph', 'only', 'ico']);
    for (const src of [indexHtml, appSrc]) {
      for (const m of src.matchAll(/class="([^"]*)"/g)) {
        const ink = m[1].split(/\s+/).filter(t => t.startsWith('ink-')).map(t => t.slice(4));
        const masked = ink.filter(t => carriers.has(t) && !sizeOnly.has(t));
        if (new Set(masked).size > 1) return false;
      }
    }
    return true;
  })()],
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
  // v4.8.0：学习方法（费曼 / 苏格拉底 / 对比辨析 / 空白回忆）——回合语义 + 折算 SRS + 账本
  ['method smoke', exists(join(root, 'scripts', 'method-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('method-smoke.mjs')],
  // v4.9.0：单词记忆宫殿——槽位语义 + 结算进 SRS + 降级
  ['palace smoke', exists(join(root, 'scripts', 'palace-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('palace-smoke.mjs')],
  ['static cache smoke', exists(join(root, 'scripts', 'static-cache-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('static-cache-smoke.mjs')],
  ['static cache contract in server', (await readFile(join(root, 'server.js'), 'utf8')).includes('function serveStaticFile') && (await readFile(join(root, 'server.js'), 'utf8')).includes("'Cache-Control': 'no-cache'")],
];
const failed = required.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`release checks failed: ${failed.join(', ')}`);
console.log(`release checks passed: ${required.length}`);
