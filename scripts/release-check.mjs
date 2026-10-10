import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const deploy = await readFile(join(root, 'scripts', 'deploy.sh'), 'utf8');
const rollback = await readFile(join(root, 'scripts', 'rollback.sh'), 'utf8');
const required = [
  ['package version', packageJson.version === '3.3.4'],
  ['deploy dry-run', deploy.includes('--dry-run') && deploy.includes('DRY_RUN')],
  ['rollback dry-run', rollback.includes('--dry-run') && rollback.includes('DRY_RUN')],
  ['deploy data exclusion', deploy.includes('--exclude data/')],
  ['deploy corpus exclusion', deploy.includes('--exclude corpus/records.jsonl') && deploy.includes('--exclude corpus/exams.jsonl')],
  ['deploy external script exclusion', deploy.includes('--exclude scripts/pull_external.sh')],
  ['rollback data exclusion', rollback.includes('--exclude data/')],
  ['rollback external script exclusion', rollback.includes('--exclude scripts/pull_external.sh')],
  ['versioned backup', deploy.includes('data_backup_v334_')],
];
const failed = required.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`release checks failed: ${failed.join(', ')}`);
console.log(`release checks passed: ${required.length}`);
