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
const required = [
  // v3.8.0：版本断言改为跟随 package.json，避免每次发版都要改脚本（沿用 v3.7.1 思路）
  ['package version', packageJson.version === '4.0.0'],
  // v4.0.0：定位收缩为「英语单词学习工作台」——真题并入语料库、做题面下线、番茄钟与写作升格删除
  ['v4 removed writing api', !/p === '\/api\/writing\//.test(serverSrc)],
  ['v4 removed unit api', !/p === '\/api\/unit\//.test(serverSrc)],
  ['v4 corpus exam projection', serverSrc.includes("p === '/api/kb/exams'") && appSrc.includes('kbAppendExamReading')],
  ['v4 nav has no exam/pomodoro tab', !indexHtml.includes('data-tab="exam"') && !indexHtml.includes('data-tab="pomo"')],
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
  ['study plan speech smoke', exists(join(root, 'scripts', 'study-plan-smoke.mjs'))],
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
  ['static cache smoke', exists(join(root, 'scripts', 'static-cache-smoke.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('static-cache-smoke.mjs')],
  ['static cache contract in server', (await readFile(join(root, 'server.js'), 'utf8')).includes('function serveStaticFile') && (await readFile(join(root, 'server.js'), 'utf8')).includes("'Cache-Control': 'no-cache'")],
];
const failed = required.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`release checks failed: ${failed.join(', ')}`);
console.log(`release checks passed: ${required.length}`);
