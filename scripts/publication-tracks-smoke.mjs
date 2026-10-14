#!/usr/bin/env node
/** v3.6.0：外刊刊物数据轨 + 按考试圈定语料范围 隔离沙箱回归。 */
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const sandbox = await mkdtemp(join(tmpdir(), 'workbench-tracks-'));
let server, failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { failures++; console.error('  ✗ ' + msg); } };

try {
  await cp(join(root, 'server.js'), join(sandbox, 'server.js'));
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'));
  await cp(join(root, 'public'), join(sandbox, 'public'), { recursive: true });
  await mkdir(join(sandbox, 'corpus', 'external', 'current', 'articles_body'), { recursive: true });
  await writeFile(join(sandbox, 'corpus', 'records.jsonl'), '');
  await writeFile(join(sandbox, 'corpus', 'exams.jsonl'), '');
  await mkdir(join(sandbox, 'data'), { recursive: true });
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
    llm: { mock: true, activeId: 'x', providers: [{ id: 'x', name: 'x', baseUrl: '', apiKey: '', model: 'mock' }] },
    autoSync: { enabled: false, minutes: 60 }, auth: { enabled: false, token: '' }, multiUser: false,
  }));

  // 构造最小 release-format v2（两条不同刊物轨）
  const idx = [
    { schema_version: 2, id: 'art_econ1', rtype: 'article', title: 'Economist on tariffs', shard: 0,
      source: { publication: 'The Economist', source_key: '01_economist', published_at: '2026-03-01', canonical_url: 'https://e/1' },
      preview: 'tariff economy', meta: { year: 2026 } },
    { schema_version: 2, id: 'art_cd1', rtype: 'article', title: 'China Daily on reform', shard: 1,
      source: { publication: 'China Daily', source_key: '14_chinadaily', published_at: '2026-03-02', canonical_url: 'https://c/1' },
      preview: 'reform opening up', meta: { year: 2026 } },
  ];
  await writeFile(join(sandbox, 'corpus', 'external', 'current', 'articles_index.jsonl'),
    idx.map(r => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(join(sandbox, 'corpus', 'external', 'current', 'sentences_index.jsonl.gz'),
    gzipSync(idx.map(r => JSON.stringify({ r: r.id, s: r.source.source_key === '01_economist'
      ? 'Tariffs reshape the global trading order considerably.' : 'Reform and opening up transformed the economy.',
      l: 0 })).join('\n') + '\n'));
  await writeFile(join(sandbox, 'corpus', 'external', 'current', 'manifest.json'),
    JSON.stringify({ schema_version: 2, release_id: 'test-v360', article_count: 2, files: {} }));

  const port = 19500 + Math.floor(Math.random() * 300);
  server = spawn(process.execPath, ['server.js'], { cwd: sandbox, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {} await delay(100); if (i === 79) throw new Error('server did not start'); }
  const j = async (u, o = {}) => { const r = await fetch(base + u, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } }); return { status: r.status, body: await r.json() }; };

  let r = await j('/api/kb/status');
  ok(r.status === 200, 'kb/status 200');
  const pubs = r.body.publications || [];
  ok(pubs.find(p => p.key === 'economist') && pubs.find(p => p.key === 'chinadaily'), 'publications 含 economist + chinadaily');
  ok(pubs.find(p => p.key === 'chinadaily')?.label === '中国日报', '中国日报轨 label 正确');
  ok(r.body.corpusScope && Array.isArray(r.body.corpusScope.tracks), 'corpusScope 返回自动轨集合');

  r = await j('/api/kb/records');
  const recs = r.body.records || [];
  ok(recs.find(x => x.id === 'art_econ1')?.pubTrack === 'economist', 'records 带 pubTrack=economist');
  ok(recs.find(x => x.id === 'art_cd1')?.pubTrack === 'chinadaily', 'records 带 pubTrack=chinadaily');

  // 默认（kaoyan1）搜 "reform"：中国日报句应被排除
  r = await j('/api/kb/search?q=reform');
  ok((r.body.results || []).every(h => h.rid !== 'art_cd1'), 'kaoyan1 下中国日报句被 scope 排除（reform）');

  // 搜 "Tariffs"：经济学人在范围内，应命中
  r = await j('/api/kb/search?q=Tariffs');
  const hit = (r.body.results || []).find(h => h.rid === 'art_econ1');
  ok(hit && hit.pubTrack === 'economist' && hit.pubTrackLabel === '经济学人', '经济学人句命中且带 pubTrack/pupTrackLabel');

  // 切六级：中国日报应进入范围
  await j('/api/study/plan', { method: 'POST', body: JSON.stringify({ examType: 'cet6' }) });
  r = await j('/api/kb/search?q=reform');
  ok((r.body.results || []).some(h => h.rid === 'art_cd1'), 'cet6 下中国日报句进入范围（reform）');
  r = await j('/api/kb/search?q=Tariffs');
  ok((r.body.results || []).every(h => h.rid !== 'art_econ1'), 'cet6 下经济学人句被排除（Tariffs）');

  // 手动覆盖：只留 economist
  await j('/api/study/plan', { method: 'POST', body: JSON.stringify({ examType: 'cet6', corpusTracks: ['economist'] }) });
  r = await j('/api/kb/search?q=Tariffs');
  ok((r.body.results || []).some(h => h.rid === 'art_econ1'), '手动范围 [economist] 下经济学人命中');
  r = await j('/api/kb/search?q=reform');
  ok((r.body.results || []).every(h => h.rid !== 'art_cd1'), '手动范围 [economist] 下中国日报被排除');

  // 清回自动
  r = await j('/api/study/plan', { method: 'POST', body: JSON.stringify({ corpusTracks: null }) });
  ok(r.status === 200 && r.body.plan.corpusTracks === null, 'corpusTracks 置 null 回自动');
} catch (e) {
  failures++; console.error('FATAL', e);
} finally {
  if (server) server.kill();
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}
console.log(failures ? `\nFAILED: ${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
