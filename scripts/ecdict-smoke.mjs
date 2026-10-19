#!/usr/bin/env node
/**
 * v3.7.0：离线英汉词典（ECDICT）隔离沙箱回归。
 * 覆盖：
 *  - 词库缺失时 /api/dict/ecdict 优雅降级 503（不崩服务）
 *  - 词库就绪后 status 返回 ready/count/fingerprint
 *  - 精确命中 / 忽略大小写 / 规则还原 / exchange 变形表 / 去符号模糊
 *  - 未收录词 found:false（200，不报错）
 *  - 空参数 400
 *  - 前缀联想按词频升序（高频词优先）
 *  - 查询缓存生效（重复查同一词不劣化）
 * 说明：沙箱按 ECDICT_HOME 指向临时目录，不读取/写入真实词库。
 */
import { mkdtemp, rm, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
const REAL_HOME = process.env.ECDICT_HOME || join(root, 'runtime', 'ecdict');
const HAS_REAL = existsSync(join(REAL_HOME, 'ecdict.db'));
const checks = [];
const T = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function boot(sandbox, ecdictHome, port) {
  await mkdir(join(sandbox, 'data'), { recursive: true });
  await mkdir(join(sandbox, 'corpus'), { recursive: true });
  await writeFile(join(sandbox, 'corpus', 'records.jsonl'), '');
  await writeFile(join(sandbox, 'corpus', 'exams.jsonl'), '');
  await writeFile(join(sandbox, 'data', 'config.json'), JSON.stringify({
    llm: { mock: true, activeId: 'x', providers: [{ id: 'x', name: 'x', baseUrl: '', apiKey: '', model: 'mock' }] },
    autoSync: { enabled: false, minutes: 60 }, auth: { enabled: false, token: '' }, multiUser: false,
  }));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: sandbox,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ECDICT_HOME: ecdictHome },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = (await fetch(base + '/api/auth/status')).ok; } catch { await delay(100); }
  }
  if (!ready) { server.kill(); throw new Error('ecdict sandbox server did not start'); }
  return { server, base };
}

async function prepareSandbox() {
  const sandbox = await mkdtemp(join(tmpdir(), 'workbench-ecdict-'));
  await copyFile(join(root, 'server.js'), join(sandbox, 'server.js'));
  await copyFile(join(root, 'package.json'), join(sandbox, 'package.json'));
  await mkdir(join(sandbox, 'public'), { recursive: true });
  await copyFile(join(root, 'public', 'index.html'), join(sandbox, 'public', 'index.html'));
  return sandbox;
}

let server;
let sandbox;
try {
  sandbox = await prepareSandbox();
  const emptyHome = join(sandbox, 'runtime-empty');
  await mkdir(emptyHome, { recursive: true });

  // 1. 词库缺失：不崩、明确 503
  {
    const port = 19420 + Math.floor(Math.random() * 80);
    const booted = await boot(sandbox, emptyHome, port);
    server = booted.server;
    const status = await (await fetch(booted.base + '/api/dict/ecdict/status')).json();
    T('1.1 词库缺失时 status.ready=false', status.status.ready === false);
    T('1.2 词库缺失时 status.installed=false', status.status.installed === false);
    const miss = await fetch(booted.base + '/api/dict/ecdict?word=abandon');
    const missBody = await miss.json();
    T('1.3 词库缺失时查词返回 503 而非 500', miss.status === 503, String(miss.status));
    T('1.4 503 带 ready=false 便于前端隐藏释义', missBody.ready === false);
    const other = await fetch(booted.base + '/api/auth/status');
    T('1.5 词库缺失不影响其他接口（服务未崩）', other.ok);
    server.kill();
    server = null;
  }

  if (!HAS_REAL) {
    console.log('SKIP 真实词库不在 ' + REAL_HOME + '（仅执行降级检查）');
  } else {
    const realHome = join(sandbox, 'runtime-real');
    await mkdir(realHome, { recursive: true });
    await copyFile(join(REAL_HOME, 'ecdict.db'), join(realHome, 'ecdict.db'));
    if (existsSync(join(REAL_HOME, 'lemma.db'))) {
      await copyFile(join(REAL_HOME, 'lemma.db'), join(realHome, 'lemma.db'));
    }
    const port = 19420 + Math.floor(Math.random() * 80);
    const booted = await boot(sandbox, realHome, port);
    server = booted.server;
    const base = booted.base;
    const get = async q => {
      const r = await fetch(base + q);
      return { status: r.status, body: await r.json() };
    };

    // 2. 状态
    const st = (await get('/api/dict/ecdict/status')).body.status;
    T('2.1 status.ready=true', st.ready === true);
    T('2.2 status.count > 700000', st.count > 700000, String(st.count));
    T('2.3 status.fingerprint 非空', Boolean(st.fingerprint), st.fingerprint);

    // 3. 精确 / 大小写 / 变形
    const exact = (await get('/api/dict/ecdict?word=abandon')).body;
    T('3.1 精确命中 abandon', exact.found === true);
    T('3.2 含中文释义', Array.isArray(exact.data.translation) && exact.data.translation.length > 0, JSON.stringify(exact.data.translation?.[0] || ''));
    T('3.3 含音标', Boolean(exact.data.phonetic), exact.data.phonetic);
    T('3.4 含考试标签（考研/四级等）', Array.isArray(exact.data.tags) && exact.data.tags.length > 0, JSON.stringify((exact.data.tags || []).map(t => t.code)));
    T('3.5 标签带中文名', (exact.data.tags || []).every(t => t.code && t.name));

    const upper = (await get('/api/dict/ecdict?word=Climate')).body;
    T('3.6 忽略大小写命中 climate', upper.found === true && upper.data.word.toLowerCase() === 'climate', upper.data?.word);

    const inflected = (await get('/api/dict/ecdict?word=abandoned')).body;
    T('3.7 变形词可查到（abandoned）', inflected.found === true);

    const irregular = (await get('/api/dict/ecdict?word=gave')).body;
    T('3.8 不规则变化走 exchange 表（gave→give）', irregular.found === true && String(irregular.lemmaOf || '').toLowerCase() === 'give', String(irregular.lemmaOf || ''));

    const plural = (await get('/api/dict/ecdict?word=mice')).body;
    T('3.9 不规则复数（mice→mouse）', plural.found === true, String(plural.lemmaOf || ''));

    const phrase = (await get('/api/dict/ecdict?word=give up')).body;
    T('3.10 词组可查（give up）', phrase.found === true && phrase.data.translation.length > 0);

    // 4. 未收录 / 参数校验
    const missing = await get('/api/dict/ecdict?word=zzzzqqqxyz');
    T('4.1 未收录词返回 200 + found:false', missing.status === 200 && missing.body.found === false);
    const empty = await get('/api/dict/ecdict?word=');
    T('4.2 空参数返回 400', empty.status === 400, String(empty.status));

    // 5. 前缀联想（高频优先）
    const sug = (await get('/api/dict/ecdict/suggest?word=hel')).body;
    T('5.1 前缀联想返回数组', Array.isArray(sug.data) && sug.data.length > 0, String(sug.data?.length));
    T('5.2 联想词以 hel 开头', (sug.data || []).every(x => x.word.toLowerCase().startsWith('hel')));
    T('5.3 高频词 help 排第一（按词频升序）', (sug.data || [])[0]?.word === 'help', (sug.data || []).map(x => x.word).join(','));
    T('5.4 联想带简要释义', (sug.data || []).every(x => typeof x.brief === 'string'));

    // 6. 缓存：同词重复查询应稳定且不劣化
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) await get('/api/dict/ecdict?word=climate');
    const avg = (Date.now() - t0) / 40;
    T('6.1 重复查词平均耗时 < 25ms（含 HTTP）', avg < 25, avg.toFixed(1) + 'ms');

    server.kill();
    server = null;
  }
} catch (err) {
  console.error('Test error:', err);
  process.exitCode = 1;
} finally {
  if (server) server.kill();
  if (sandbox) await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter(c => !c.ok);
console.log(`\necdict smoke: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map(f => f.name).join(' | '));
  process.exitCode = 1;
}
