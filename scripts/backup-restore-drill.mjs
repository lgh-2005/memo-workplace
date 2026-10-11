#!/usr/bin/env node
/**
 * v3.3.6：隔离式 data 备份/恢复演练。
 * 默认生成 data/ tar.gz，再恢复到隔离临时目录并逐文件校验 SHA-256；
 * 永远不会覆盖源目录。生产服务器可通过 --source 指向 /opt/workbench/data。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const valueOf = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sourceArg = valueOf('--source') || process.env.WORKBENCH_DATA || join(root, 'data');
const workArg = valueOf('--work-dir');
const archiveArg = valueOf('--archive');
const keep = args.includes('--keep');
const jsonOutput = args.includes('--json');

function usage() {
  console.log('用法: node scripts/backup-restore-drill.mjs [--source data] [--archive BACKUP.tar.gz] [--work-dir DIR] [--keep] [--json]');
  console.log('      node scripts/backup-restore-drill.mjs --self-test');
}

function ignored(rel) {
  const normalized = rel.replaceAll('\\', '/');
  return normalized === 'backups' || normalized.startsWith('backups/') || basename(normalized).endsWith('.tmp');
}

function tar(args) {
  try {
    return execFileSync(process.env.TAR || 'tar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim();
    throw new Error(`tar ${args[0]} failed: ${detail}`);
  }
}

function createArchive(source, archive) {
  tar(['-czf', archive, '--exclude=backups', '--exclude=*.tmp', '-C', dirname(source), basename(source)]);
}

function archiveEntries(archive) {
  const names = tar(['-tzf', archive]).split(/\r?\n/).filter(Boolean);
  if (!names.length) throw new Error('backup archive is empty');
  for (const name of names) {
    const normalized = name.replaceAll('\\', '/');
    const clean = posix.normalize(normalized.replace(/^\.\//, ''));
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || clean === '..' || clean.startsWith('../')) {
      throw new Error(`unsafe path in backup archive: ${name}`);
    }
  }
  const verbose = tar(['-tvzf', archive]).split(/\r?\n/).filter(Boolean);
  if (verbose.some(line => /^[lh]/.test(line))) throw new Error('symbolic and hard links are not allowed in backup archives');
  return names;
}

async function extractArchive(archive, destination) {
  archiveEntries(archive);
  await mkdir(destination, { recursive: true });
  tar(['-xzf', archive, '-C', destination]);
}

async function manifest(dir, rel = '') {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (ignored(nextRel)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await manifest(full, nextRel));
    else if (entry.isSymbolicLink()) {
      out[nextRel] = { type: 'symlink', target: await readlink(full) };
    } else if (entry.isFile()) {
      const buf = await readFile(full);
      out[nextRel] = { type: 'file', bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    }
  }
  return out;
}

function sameManifest(a, b) {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length || ak.some((x, i) => x !== bk[i])) return false;
  return ak.every(k => a[k].type === b[k].type && (
    a[k].type === 'symlink' ? a[k].target === b[k].target : a[k].bytes === b[k].bytes && a[k].sha256 === b[k].sha256
  ));
}

async function drill(source, work, suppliedArchive = '') {
  if (!existsSync(source)) throw new Error(`source directory not found: ${source}`);
  const sourceReal = resolve(source);
  const workReal = resolve(work);
  const nested = relative(sourceReal, workReal);
  if (nested === '' || (!nested.startsWith('..') && !isAbsolute(nested))) {
    throw new Error('--work-dir must be outside --source to prevent recursive copying');
  }
  const archive = suppliedArchive ? resolve(suppliedArchive) : join(workReal, 'data-backup.tar.gz');
  const restored = join(workReal, 'restore');
  await mkdir(work, { recursive: true });
  const sourceManifest = await manifest(source);
  if (!suppliedArchive) createArchive(sourceReal, archive);
  if (!existsSync(archive)) throw new Error(`backup archive not found: ${archive}`);
  await extractArchive(archive, restored);
  const restoredData = join(restored, basename(sourceReal));
  const backupManifest = await manifest(restoredData);
  if (!sameManifest(sourceManifest, backupManifest)) throw new Error('backup archive does not match source data');
  const afterManifest = await manifest(sourceReal);
  if (!sameManifest(sourceManifest, afterManifest)) throw new Error('source data changed during backup/restore drill');
  const restoredManifest = await manifest(restored);
  if (!Object.keys(restoredManifest).length) throw new Error('restored directory is empty');
  const report = {
    ok: true,
    source,
    workDir: work,
    archive,
    files: Object.keys(sourceManifest).length,
    bytes: Object.values(sourceManifest).reduce((n, x) => n + x.bytes, 0),
    excluded: ['data/backups/**', '**/*.tmp'],
    backupVerified: true,
    restoreVerified: true,
    sourceUnchanged: true,
  };
  await writeFile(join(work, 'manifest.json'), JSON.stringify({ files: sourceManifest }, null, 2));
  return report;
}

async function selfTest() {
  const work = await mkdtemp(join(tmpdir(), 'workbench-drill-selftest-'));
  const source = join(work, 'data');
  const drillWork = join(work, 'run-generated');
  const suppliedArchive = join(work, 'data-backup.tar.gz');
  try {
    await mkdir(join(source, 'users', 'admin'), { recursive: true });
    await mkdir(join(source, 'backups'), { recursive: true });
    await writeFile(join(source, 'config.json'), '{"multiUser":true}\n');
    await writeFile(join(source, 'users', 'admin', 'db.json'), '{"words":{}}\n');
    await writeFile(join(source, 'backups', 'old.tmp'), 'excluded\n');
    const result = await drill(source, drillWork);
    if (result.files !== 2 || !result.backupVerified || !result.restoreVerified) throw new Error('self-test assertion failed');
    tar(['-czf', suppliedArchive, '--exclude=data/backups', '-C', work, 'data']);
    const supplied = await drill(source, join(work, 'run-supplied'), suppliedArchive);
    if (supplied.files !== 2 || !supplied.sourceUnchanged) throw new Error('production archive self-test assertion failed');
    console.log('backup/restore drill self-test: passed');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (args.includes('--help') || args.includes('-h')) usage();
else if (args.includes('--self-test')) await selfTest();
else {
  const work = workArg ? resolve(workArg) : await mkdtemp(join(tmpdir(), 'workbench-drill-'));
  try {
    const result = await drill(resolve(sourceArg), work, archiveArg);
    if (jsonOutput) console.log(JSON.stringify(result));
    else console.log(`backup/restore drill passed: ${result.files} files, ${result.bytes} bytes (isolated at ${work})`);
    if (!keep && !workArg) await rm(work, { recursive: true, force: true });
  } catch (error) {
    if (!keep && !workArg) await rm(work, { recursive: true, force: true });
    console.error(`backup/restore drill failed: ${error.message}`);
    process.exitCode = 1;
  }
}
