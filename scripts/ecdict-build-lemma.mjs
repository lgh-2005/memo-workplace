#!/usr/bin/env node
/**
 * v3.7.0：从 ECDICT 主库生成「变形 → 原形」映射表（lemma.db）。
 *
 * 用法：
 *   node scripts/ecdict-build-lemma.mjs                     # 读 runtime/ecdict/ecdict.db
 *   node scripts/ecdict-build-lemma.mjs --src a.db --out b.db
 *   ECDICT_HOME=/path/to/ecdict node scripts/ecdict-build-lemma.mjs
 *
 * 说明：ECDICT 的 exchange 字段形如 `0:give/1:p`（0 = 原形，其余为变形），
 * 本脚本把每个变形写入 lemma(form, base)，供后端「规则还原失败后再查变形表」使用。
 * 生成物属部署产物（runtime/ 下，不进 git、不参与 data 备份）。零第三方依赖。
 */
import { existsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const home = process.env.ECDICT_HOME ? resolve(process.env.ECDICT_HOME) : join(root, 'runtime', 'ecdict');
const srcPath = resolve(valueOf('--src') || join(home, 'ecdict.db'));
const outPath = resolve(valueOf('--out') || join(home, 'lemma.db'));

if (!existsSync(srcPath)) {
  console.error(`[ecdict-build-lemma] 找不到主词库：${srcPath}`);
  process.exit(1);
}

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  console.error(`[ecdict-build-lemma] 当前 Node 不支持 node:sqlite（需 ≥22.5）：${err.message}`);
  process.exit(1);
}

const started = Date.now();
if (existsSync(outPath)) await rm(outPath, { force: true });

const src = new DatabaseSync(srcPath, { readOnly: true });
const dst = new DatabaseSync(outPath);
dst.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
dst.exec('CREATE TABLE lemma (form TEXT NOT NULL, base TEXT NOT NULL);');

const insert = dst.prepare('INSERT INTO lemma (form, base) VALUES (?, ?)');
let rows = 0;
dst.exec('BEGIN');
try {
  for (const row of src.prepare("SELECT word, exchange FROM stardict WHERE exchange != ''").iterate()) {
    const base = String(row.word || '').trim();
    if (!base) continue;
    for (const part of String(row.exchange || '').split('/')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const form = part.slice(i + 1).trim().toLowerCase();
      if (form && form !== base.toLowerCase()) {
        insert.run(form, base);
        rows++;
      }
    }
  }
  dst.exec('COMMIT');
} catch (err) {
  dst.exec('ROLLBACK');
  src.close();
  dst.close();
  console.error(`[ecdict-build-lemma] 构建失败：${err.message}`);
  process.exit(1);
}

dst.exec('CREATE INDEX idx_lemma_form ON lemma (form);');
dst.exec('VACUUM; ANALYZE;');
src.close();
dst.close();

const sizeMb = (statSync(outPath).size / 1048576).toFixed(1);
console.log(`[ecdict-build-lemma] 完成：${rows.toLocaleString()} 条映射 → ${outPath}（${sizeMb} MB，${((Date.now() - started) / 1000).toFixed(1)}s）`);
