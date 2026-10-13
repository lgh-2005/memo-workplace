import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const exists = file => existsSync(file);
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const deploy = await readFile(join(root, 'scripts', 'deploy.sh'), 'utf8');
const rollback = await readFile(join(root, 'scripts', 'rollback.sh'), 'utf8');
const ci = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const required = [
  ['package version', packageJson.version === '3.5.0'],
  ['deploy dry-run', deploy.includes('--dry-run') && deploy.includes('DRY_RUN')],
  ['rollback dry-run', rollback.includes('--dry-run') && rollback.includes('DRY_RUN')],
  ['deploy data exclusion', deploy.includes('--exclude data/')],
  ['deploy corpus exclusion', deploy.includes('--exclude corpus/records.jsonl') && deploy.includes('--exclude corpus/exams.jsonl')],
  ['deploy external script exclusion', deploy.includes('--exclude scripts/pull_external.sh')],
  ['rollback data exclusion', rollback.includes('--exclude data/')],
  ['rollback external script exclusion', rollback.includes('--exclude scripts/pull_external.sh')],
  ['versioned backup', deploy.includes('data_backup_v350_')],
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
  ['piper worker tooling', exists(join(root, 'tools', 'tts', 'piper_worker.py')) && exists(join(root, 'tools', 'tts', 'setup_piper.sh'))],
  ['front-end refinement browser regression', exists(join(root, 'scripts', 'frontend-refinement-smoke.mjs')) && exists(join(root, 'scripts', 'test.mjs')) && (await readFile(join(root, 'scripts', 'test.mjs'), 'utf8')).includes('frontend-refinement-smoke.mjs')],
];
const failed = required.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`release checks failed: ${failed.join(', ')}`);
console.log(`release checks passed: ${required.length}`);
