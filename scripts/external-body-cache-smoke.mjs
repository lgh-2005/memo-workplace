import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const sandbox = await mkdtemp(join(tmpdir(), 'external-body-cache-'));
const externalDir = join(sandbox, 'external');
const bodyDir = join(externalDir, 'articles_body');
const corpusDir = join(sandbox, 'corpus');
const dataDir = join(sandbox, 'data');
const counterFile = join(sandbox, 'gunzip-count.txt');
const preload = join(sandbox, 'count-gunzip.cjs');
const port = 19000 + Math.floor(Math.random() * 1000);
let server;

const metadata = (id, shard) => ({
  schema_version: 2, id, rtype: 'article', title: id,
  source: { publication: 'Fixture', canonical_url: `https://example.test/${id}`, published_at: '2026-01-01' },
  preview: 'Fixture article', meta: { year: 2026 }, shard,
});
const bodyRow = (id, text) => JSON.stringify({ id, paragraphs: [text], sentences: [], vocab_analysis: {} });
const countDecompressions = async () => (await readFile(counterFile, 'utf8').catch(() => '')).trim().split(/\r?\n/).filter(Boolean).length;
const getRecord = async id => {
  const response = await fetch(`http://127.0.0.1:${port}/api/kb/record/${id}`);
  assert.equal(response.status, 200, `detail request for ${id} failed`);
  return (await response.json()).record;
};

try {
  await Promise.all([mkdir(bodyDir, { recursive: true }), mkdir(corpusDir), mkdir(dataDir)]);
  await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
  await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
  await writeFile(join(corpusDir, 'records.jsonl'), '');
  await writeFile(join(corpusDir, 'exams.jsonl'), '');
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ auth: { enabled: false }, autoSync: { enabled: false } }));
  await writeFile(join(dataDir, 'db.json'), JSON.stringify({ words: {}, notes: [], sessions: [], syncLog: [] }));
  await writeFile(join(externalDir, 'articles_index.jsonl'), [
    metadata('art_alpha', 0), metadata('art_beta', 0),
    ...Array.from({ length: 6 }, (_, i) => metadata(`art_shard_${i + 1}`, i + 1)),
  ].map(JSON.stringify).join('\n') + '\n');
  await writeFile(join(bodyDir, 'body-00.jsonl.gz'), gzipSync(Buffer.from([
    bodyRow('art_alpha', 'alpha first body'), bodyRow('art_beta', 'beta body'),
  ].join('\n') + '\n')));
  for (let shard = 1; shard <= 6; shard++) {
    await writeFile(join(bodyDir, `body-${String(shard).padStart(2, '0')}.jsonl.gz`), gzipSync(Buffer.from(`${bodyRow(`art_shard_${shard}`, `shard ${shard} body`)}\n`)));
  }
  await writeFile(preload, [
    "const fs = require('node:fs');",
    "const zlib = require('node:zlib');",
    'const original = zlib.gunzipSync;',
    "zlib.gunzipSync = function (...args) { fs.appendFileSync(process.env.GUNZIP_COUNTER, '1\\n'); return original.apply(this, args); };",
  ].join('\n'));

  server = spawn(process.execPath, ['--require', resolve(preload), 'server.js'], {
    cwd: sandbox,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), EXTERNAL_CORPUS_DIR: externalDir, GUNZIP_COUNTER: counterFile },
    stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok; }
    catch { await delay(100); }
  }
  if (!ready) throw new Error('fixture server did not start');

  assert.equal((await getRecord('art_alpha')).text, 'alpha first body');
  assert.equal(await countDecompressions(), 1, 'first access should decompress its shard');
  assert.equal((await getRecord('art_beta')).text, 'beta body');
  assert.equal(await countDecompressions(), 1, 'another article in the cached shard must not decompress it again');

  await writeFile(join(bodyDir, 'body-00.jsonl.gz'), gzipSync(Buffer.from([
    bodyRow('art_alpha', 'alpha refreshed body'), bodyRow('art_beta', 'beta body'),
  ].join('\n') + '\n')));
  assert.equal((await getRecord('art_alpha')).text, 'alpha refreshed body', 'replaced shard must invalidate its cache');
  assert.equal(await countDecompressions(), 2);

  for (let shard = 1; shard <= 6; shard++) await getRecord(`art_shard_${shard}`);
  assert.equal(await countDecompressions(), 8);
  await getRecord('art_alpha');
  assert.equal(await countDecompressions(), 9, 'least-recently-used shard should be evicted after six other shards');
  console.log('external body cache smoke: passed');
} finally {
  if (server) {
    server.kill('SIGTERM');
    await new Promise(resolveExit => server.once('close', resolveExit));
  }
  await rm(sandbox, { recursive: true, force: true });
}
