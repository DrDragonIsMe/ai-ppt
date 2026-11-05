// tests/sources.test.mjs — 素材源后端单测（node:test）。
// 离线：不发真实外网请求；url/site 用本地 http 服务（127.0.0.1）+ allowPrivateNetwork 注入。
// 覆盖：registry 校验/CRUD、dir 采集与增量、url/site/vault 采集、截断、listItems q/limit、
//       routes/sources.mjs 各端点与错误映射（send/readBody 桩件，spawnNdjsonTask 桩件）。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadSources, saveSources, upsertSource, removeSource, getSource, validateSource,
  makeId, slugify, SourceError, OPTION_RANGES,
} from '../scripts/sources/registry.mjs';
import {
  listItems, readItem, readManifest, makeItemId,
} from '../scripts/sources/store.mjs';
import { refreshSource, previewSource } from '../scripts/sources/refresh.mjs';
import { collectDir } from '../scripts/sources/collect-dir.mjs';
import { collectSite } from '../scripts/sources/collect-site.mjs';
import { fetchPage } from '../scripts/sources/net.mjs';
import { capByBytes, classifyExt } from '../scripts/sources/text-extract.mjs';
import { isWithinRoot, isSensitivePath, hasSensitiveSegment } from '../scripts/sources/paths.mjs';
import { matchesAny } from '../scripts/sources/glob.mjs';
import sourcesRoutes from '../routes/sources.mjs';
import { isSafeName } from '../scripts/config.mjs';
import dns from 'node:dns/promises';

// 每个测试独享临时 sources.json + 缓存根，避免污染仓库，也彼此隔离。
// 外部临时目录（os.tmpdir()）在 ROOT 之外，测试运行在"运维已授权外部源"的语境下：
// 设 AI_PPT_ALLOW_EXTERNAL_SOURCES=1（P1-1b 的第一道闸），dir 源创建再显式带 acknowledgeExternalPath（第二道闸，见 mkDirSource）。
function freshEnv(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `src-${label}-`));
  process.env.AI_PPT_SOURCES_FILE = path.join(tmp, 'sources.json');
  process.env.AI_PPT_SOURCE_CACHE_ROOT = path.join(tmp, 'cache');
  process.env.AI_PPT_ALLOW_EXTERNAL_SOURCES = '1';
  return tmp;
}

// 外部临时目录作为 dir 源：模拟生产"运维开 env + 前端确认一次"两道闸门（P1-1b/c）。
function mkDirSource(input) {
  return upsertSource({ acknowledgeExternalPath: true, ...input });
}

// refresh CLI 绝对路径（供 P1-3 端到端 NDJSON 子进程测试）
const REFRESH_CLI = fileURLToPath(new URL('../scripts/sources/refresh.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// slugify / makeId
// ---------------------------------------------------------------------------
describe('registry slugify / makeId', () => {
  it('slugifies ascii names and enforces src- prefix', () => {
    assert.equal(slugify('My Product Docs'), 'my-product-docs');
    const id = makeId('dir', 'My Product Docs', new Set());
    assert.equal(id, 'src-my-product-docs');
  });
  it('falls back to random segment for non-ascii names', () => {
    const id = makeId('url', '中文素材', new Set());
    assert.match(id, /^src-[a-z0-9][a-z0-9-]*$/);
  });
  it('avoids collisions with existing ids', () => {
    const taken = new Set(['src-dup', 'src-dup-2']);
    assert.equal(makeId('dir', 'dup', taken), 'src-dup-3');
  });
});

// ---------------------------------------------------------------------------
// validateSource
// ---------------------------------------------------------------------------
describe('validateSource', () => {
  it('accepts a valid dir source and applies defaults', () => {
    const tmp = freshEnv('validate');
    const s = validateSource({ type: 'dir', name: 'Docs', target: tmp, tags: ['a'], acknowledgeExternalPath: true });
    assert.equal(s.type, 'dir');
    assert.equal(s.enabled, true);
    assert.deepEqual(s.tags, ['a']);
    assert.ok(Array.isArray(s.options.include) && s.options.include.includes('**/*.md'));
  });
  it('rejects unknown type', () => {
    assert.throws(() => validateSource({ type: 'ftp', name: 'x', target: 'y' }), SourceError);
  });
  it('rejects empty name / empty target', () => {
    assert.throws(() => validateSource({ type: 'dir', name: '', target: '/tmp' }), SourceError);
    assert.throws(() => validateSource({ type: 'url', name: 'n', target: '' }), SourceError);
  });
  it('rejects non-http(s) url/site target', () => {
    assert.throws(() => validateSource({ type: 'url', name: 'n', target: 'ftp://x/y' }), SourceError);
    assert.throws(() => validateSource({ type: 'site', name: 'n', target: 'not a url' }), SourceError);
  });
  it('rejects relative dir target escaping repo root', () => {
    assert.throws(() => validateSource({ type: 'dir', name: 'n', target: '../../../etc' }), SourceError);
  });
  it('clamps numeric option ranges', () => {
    assert.throws(() => validateSource({ type: 'site', name: 'n', target: 'https://x.com', options: { depth: 99 } }), SourceError);
    assert.throws(() => validateSource({ type: 'site', name: 'n', target: 'https://x.com', options: { maxPages: 0 } }), SourceError);
    assert.throws(() => validateSource({ type: 'site', name: 'n', target: 'https://x.com', options: { maxBytesPerItem: 1 } }), SourceError);
    const ok = validateSource({ type: 'site', name: 'n', target: 'https://x.com', options: { depth: 2, maxPages: 10, maxBytesPerItem: 4096 } });
    assert.deepEqual({ depth: ok.options.depth, maxPages: ok.options.maxPages, maxBytesPerItem: ok.options.maxBytesPerItem },
      { depth: 2, maxPages: 10, maxBytesPerItem: 4096 });
  });
  it('未显式提供的数值 option 一律物化为 OPTION_RANGES 声明的 default', () => {
    freshEnv('materialize');
    for (const type of ['dir', 'url', 'site', 'vault']) {
      // dir 用外部临时目录（freshEnv 已开 env，需 ack）；vault 用空 target（限定在 ROOT/vault 内）；url/site 用 https。
      const target = type === 'url' || type === 'site' ? 'https://example.com' : (type === 'dir' ? os.tmpdir() : '');
      const s = validateSource({ type, name: 'no-opts', target, acknowledgeExternalPath: true }); // 完全不带 options
      assert.equal(s.options.maxPages, OPTION_RANGES.maxPages.default, `${type}.maxPages`);
      assert.equal(s.options.maxBytesPerItem, OPTION_RANGES.maxBytesPerItem.default, `${type}.maxBytesPerItem`);
      assert.equal(s.options.depth, OPTION_RANGES.depth.default, `${type}.depth`);
    }
  });
});

// ---------------------------------------------------------------------------
// registry CRUD
// ---------------------------------------------------------------------------
describe('registry CRUD', () => {
  beforeEach(() => freshEnv('crud'));
  it('creates, lists, gets, updates, removes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'src-target-'));
    const { source, isNew } = mkDirSource({ type: 'dir', name: 'A', target: tmp });
    assert.equal(isNew, true);
    assert.match(source.id, /^src-a$/);
    assert.equal(getSource(source.id).name, 'A');
    assert.equal(listCount(), 1);
    const { source: upd, isNew: isNew2 } = upsertSource({ name: 'A2' }, source.id);
    assert.equal(isNew2, false);
    assert.equal(upd.name, 'A2');
    assert.equal(upd.target, path.resolve(tmp));
    assert.equal(removeSource(source.id), true);
    assert.equal(getSource(source.id), null);
    assert.equal(removeSource('src-nope'), false);
  });
  it('update to a non-existent id → SourceError 404', () => {
    assert.throws(() => upsertSource({ name: 'x' }, 'src-does-not-exist'), (e) => e instanceof SourceError && e.statusCode === 404);
  });
  it('rejects invalid explicit id', () => {
    assert.throws(() => mkDirSource({ type: 'dir', name: 'x', target: '/tmp', id: '../bad' }), SourceError);
    assert.throws(() => mkDirSource({ type: 'dir', name: 'x', target: '/tmp', id: 'not-prefixed' }), SourceError);
  });
  it('loadSources tolerates missing file', () => {
    const d = loadSources();
    assert.equal(d.version, 1);
    assert.deepEqual(d.sources, []);
  });
});
function listCount() { return loadSources().sources.length; }

// ---------------------------------------------------------------------------
// dir collector + incremental + store read API
// ---------------------------------------------------------------------------
describe('dir source: collect + incremental + listItems', () => {
  let tmp, dir, source;
  beforeEach(() => {
    freshEnv('dir');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-dir-'));
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'alpha.md'), '# Alpha\nfirst doc');
    fs.writeFileSync(path.join(dir, 'sub', 'beta.md'), '# Beta\nsecond doc');
    fs.writeFileSync(path.join(dir, 'plain.txt'), 'plain text body');
    fs.writeFileSync(path.join(dir, 'binary.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // default include skips
    source = mkDirSource({ type: 'dir', name: 'Docs', target: dir, tags: ['demo'] }).source;
  });

  it('collects only text items with titles', async () => {
    const r = await refreshSource(source.id);
    assert.equal(r.added, 3);
    assert.equal(r.errors, 0);
    const items = listItems({ sourceId: source.id });
    assert.equal(items.length, 3);
    const titles = items.map((i) => i.title).sort();
    assert.deepEqual(titles, ['Alpha', 'Beta', 'plain']); // md 首行标题优先，txt 用文件名
    assert.ok(items.every((i) => i.file.startsWith('items/') && i.file.endsWith('.md')));
  });

  it('incremental: unchanged on second pass, updates on edit', async () => {
    const r1 = await refreshSource(source.id);
    const r2 = await refreshSource(source.id);
    assert.equal(r2.added, 0);
    assert.equal(r2.unchanged, 3);
    assert.equal(r2.fingerprint, r1.fingerprint);
    // edit one file → 1 updated
    fs.writeFileSync(path.join(dir, 'alpha.md'), '# Alpha v2\nchanged');
    const r3 = await refreshSource(source.id);
    assert.equal(r3.updated, 1);
    assert.equal(r3.unchanged, 2);
    // remove a file → 1 removed (pruned)
    fs.rmSync(path.join(dir, 'plain.txt'));
    const r4 = await refreshSource(source.id);
    assert.equal(r4.removed, 1);
    assert.equal(listItems({ sourceId: source.id }).length, 2);
    assert.equal(readItem(makeItemId(source.id, path.resolve(path.join(dir, 'plain.txt')))), null);
  });

  it('readItem returns parsed front matter + body', async () => {
    await refreshSource(source.id);
    const items = listItems({ sourceId: source.id });
    const it = items.find((i) => i.title === 'Alpha');
    const full = readItem(it.id);
    assert.equal(full.frontMatter.source_id, source.id);
    assert.equal(full.frontMatter.origin, path.resolve(path.join(dir, 'alpha.md')));
    assert.deepEqual(full.frontMatter.tags, ['demo']);
    assert.match(full.content, /first doc/);
    assert.ok(/^[0-9a-f]{64}$/.test(full.frontMatter.hash));
  });

  it('listItems q filters + limit truncates; aggregates across sources', async () => {
    await refreshSource(source.id);
    const s2 = mkDirSource({ type: 'dir', name: 'Other', target: (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'src-dir2-')); fs.writeFileSync(path.join(d, 'gamma.md'), '# Gamma\ng content'); return d; })() }).source;
    await refreshSource(s2.id);
    assert.deepEqual(listItems({ q: 'gamma' }).map((i) => i.title), ['Gamma']);
    assert.equal(listItems({ limit: 1 }).length, 1);
    const all = listItems({});
    assert.ok(all.length >= 4);
    assert.ok(all.every((i) => i.sourceId));
  });

  it('missing dir → refresh throws statusCode 500', async () => {
    const bad = mkDirSource({ type: 'dir', name: 'Bad', target: path.join(dir, 'nope-does-not-exist') }).source;
    await assert.rejects(() => refreshSource(bad.id), (e) => e.statusCode === 500);
  });
});

// ---------------------------------------------------------------------------
// truncation
// ---------------------------------------------------------------------------
describe('dir source: maxBytesPerItem truncation', () => {
  it('marks truncated and caps stored body', async () => {
    freshEnv('trunc');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-trunc-'));
    fs.writeFileSync(path.join(dir, 'big.md'), '# Big\n' + 'x'.repeat(5000));
    const source = mkDirSource({ type: 'dir', name: 'Big', target: dir, options: { maxBytesPerItem: 1024 } }).source;
    const r = await refreshSource(source.id);
    assert.equal(r.added, 1);
    const it = listItems({ sourceId: source.id })[0];
    assert.equal(it.truncated, true);
    const full = readItem(it.id);
    assert.equal(full.frontMatter.truncated, true);
    assert.ok(Buffer.byteLength(full.content, 'utf8') <= 1024);
    assert.ok(full.content.length < 5000);
  });
});

// ---------------------------------------------------------------------------
// maxPages 截断必须显式可观测（manifest + NDJSON + GET /api/sources）
// ---------------------------------------------------------------------------
describe('maxPages truncation is explicitly reported', () => {
  it('dir: >maxPages files → droppedCount 如实上报（summary/manifest/NDJSON/listItems）', async () => {
    freshEnv('trunc-report');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-tr-'));
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `d${i}.md`), `# Doc ${i}\nbody ${i}`);
    const source = mkDirSource({ type: 'dir', name: 'Trunc', target: dir, options: { maxPages: 3 } }).source;
    const events = [];
    const r = await refreshSource(source.id, { onEvent: (e) => events.push(e) });
    assert.equal(r.itemCount, 3);
    assert.equal(r.truncated, true);
    assert.equal(r.droppedCount, 2);
    assert.equal(r.totalCandidates, 5);
    assert.equal(listItems({ sourceId: source.id }).length, 3);
    const m = readManifest(source.id);
    assert.equal(m.truncated, true);
    assert.equal(m.droppedCount, 2);
    assert.equal(m.totalCandidates, 5);
    assert.equal(m.maxPages, 3);
    const ev = events.find((e) => e.step === 'truncated');
    assert.ok(ev, '应有 truncated NDJSON 事件');
    assert.match(ev.message, /maxPages=3/);
    assert.match(ev.message, /丢弃 2/);
  });

  it('默认上限 30：3 个文件未达上限故无 truncated 标记', async () => {
    freshEnv('trunc-none');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-tn-'));
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, `n${i}.md`), `# N${i}`);
    const source = mkDirSource({ type: 'dir', name: 'NoCap', target: dir }).source; // 无 maxPages → 物化默认 30
    const r = await refreshSource(source.id);
    assert.equal(source.options.maxPages, OPTION_RANGES.maxPages.default);
    assert.equal(r.itemCount, 3);
    assert.equal(r.truncated, false);
    assert.equal(r.droppedCount, 0);
    assert.ok(!('truncated' in readManifest(source.id)));
    assert.ok(!('droppedCount' in readManifest(source.id)));
  });

  it('dir 默认 maxPages 生效：31 文件不带 options → 截断到 30（与 site 同一默认，防止再塞第三个隐式默认）', async () => {
    freshEnv('trunc-default');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-td-'));
    for (let i = 0; i < 31; i++) fs.writeFileSync(path.join(dir, `f${i}.md`), `# F${i}\nbody`);
    const source = mkDirSource({ type: 'dir', name: 'Default30', target: dir }).source;
    assert.equal(source.options.maxPages, OPTION_RANGES.maxPages.default); // 物化 = 30
    const r = await refreshSource(source.id);
    assert.equal(r.itemCount, OPTION_RANGES.maxPages.default);              // 入库 30
    assert.equal(r.truncated, true);
    assert.equal(r.droppedCount, 1);
    assert.equal(r.totalCandidates, 31);
    const m = readManifest(source.id);
    assert.equal(m.truncated, true);
    assert.equal(m.droppedCount, 1);
    assert.equal(m.maxPages, OPTION_RANGES.maxPages.default);
  });

  it('采集器不再自带隐式默认：剥掉 maxPages 直接喂 collectDir → 抛错（而非悄悄用 Infinity）', async () => {
    freshEnv('collector-no-default');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-nd-'));
    fs.writeFileSync(path.join(dir, 'a.md'), '# A');
    const source = mkDirSource({ type: 'dir', name: 'Strip', target: dir }).source;
    const bad = { ...source, options: { ...source.options, maxPages: undefined } };
    await assert.rejects(
      async () => { for await (const _ of collectDir(bad)) { void _; } },
      /maxPages/,
    );
  });

  it('GET /api/sources 透出 truncated/droppedCount 供前端徽标', async () => {
    freshEnv('trunc-api');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-ta-'));
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `y${i}.md`), `# Y${i}`);
    const created = await call(makeRouteCtx(), 'POST', '/api/sources', { body: { acknowledgeExternalPath: true, type: 'dir', name: 'T', target: dir, options: { maxPages: 2 } } });
    const id = created.body.source.id;
    await refreshSource(id);
    const listed = await call(makeRouteCtx(), 'GET', '/api/sources');
    const src = listed.body.sources.find((s) => s.id === id);
    assert.equal(src.itemCount, 2);
    assert.equal(src.truncated, true);
    assert.equal(src.droppedCount, 2);
    assert.equal(src.totalCandidates, 4);
  });
});

// ---------------------------------------------------------------------------
// url + site via local http server (allowPrivateNetwork), and SSRF default-off
// ---------------------------------------------------------------------------
describe('url & site collectors (local http server)', () => {
  let server, port;
  const PAGE = (title, body, links = '') =>
    `<!doctype html><html><head><title>${title}</title></head><body>${links}<article><h1>${title}</h1><p>${body}</p></article></body></html>`;

  before(async () => {
    server = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      const origin = `http://127.0.0.1:${port}`;
      if (u === '/' ) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(PAGE('Home', 'welcome home',
          `<a href="/a.html">A</a><a href="/b.html">B</a><a href="${origin}/c.html">C rel</a>` +
          `<a href="http://elsewhere.example/x.html">external</a><a href="/dl.pdf">pdf</a>`));
      }
      if (u === '/a.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE('Page A', 'alpha page body')); }
      if (u === '/b.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE('Page B', 'beta page body')); }
      if (u === '/c.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE('Page C', 'gamma page body')); }
      if (u === '/dl.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from('%PDF-1.4\n%%EOF')); }
      res.writeHead(404); res.end('nope');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => new Promise((r) => server.close(r)));

  it('url source collects one page (allowPrivateNetwork)', async () => {
    freshEnv('url');
    const source = upsertSource({ type: 'url', name: 'A page', target: `http://127.0.0.1:${port}/a.html` }).source;
    const r = await refreshSource(source.id, { allowPrivateNetwork: true });
    assert.equal(r.added, 1);
    assert.equal(r.errors, 0);
    const it = listItems({ sourceId: source.id })[0];
    assert.match(it.title, /Page A/);
    const full = readItem(it.id);
    assert.match(full.content, /alpha page body/);
    // incremental: same
    const r2 = await refreshSource(source.id, { allowPrivateNetwork: true });
    assert.equal(r2.unchanged, 1);
  });

  it('site source BFS same-domain, skips external + media, respects depth', async () => {
    freshEnv('site');
    const source = upsertSource({ type: 'site', name: 'Site', target: `http://127.0.0.1:${port}/`, options: { depth: 1, maxPages: 10 } }).source;
    const r = await refreshSource(source.id, { allowPrivateNetwork: true });
    const titles = listItems({ sourceId: source.id }).map((i) => i.title).sort();
    // Home + Page A + Page B + Page C(rel) ; NOT external, NOT /dl.pdf
    assert.deepEqual(titles, ['Home', 'Page A', 'Page B', 'Page C']);
    assert.equal(r.errors, 0);
  });

  it('site depth 0 → only entry page', async () => {
    freshEnv('site0');
    const source = upsertSource({ type: 'site', name: 'Site0', target: `http://127.0.0.1:${port}/`, options: { depth: 0 } }).source;
    await refreshSource(source.id, { allowPrivateNetwork: true });
    const titles = listItems({ sourceId: source.id }).map((i) => i.title);
    assert.deepEqual(titles, ['Home']);
  });

  it('site truncation: maxPages below discovered links reports dropped explicitly', async () => {
    freshEnv('site-trunc');
    const source = upsertSource({ type: 'site', name: 'ST', target: `http://127.0.0.1:${port}/`, options: { depth: 1, maxPages: 2 } }).source;
    const events = [];
    const r = await refreshSource(source.id, { allowPrivateNetwork: true, onEvent: (e) => events.push(e) });
    assert.equal(r.itemCount, 2);        // home + a (BFS 前 2 页)
    assert.equal(r.truncated, true);
    assert.equal(r.droppedCount, 2);     // b + c 已发现但因上限未抓
    assert.equal(r.totalCandidates, 4);
    const truncEv = events.find((e) => e.step === 'truncated');
    assert.ok(truncEv, 'site 截断应发 truncated 事件');
    assert.equal(truncEv.detail.dropped, 2);
    assert.equal(readManifest(source.id).droppedCount, 2);
  });

  it('site 不带 options → 物化 default（depth=1、maxPages=30），与 dir 同一默认', () => {
    freshEnv('site-default');
    const source = upsertSource({ type: 'site', name: 'SiteDefault', target: `http://127.0.0.1:${port}/` }).source;
    assert.equal(source.options.depth, OPTION_RANGES.depth.default);           // 1
    assert.equal(source.options.maxPages, OPTION_RANGES.maxPages.default);      // 30
  });

  it('采集器不再自带隐式默认：剥掉 maxPages/depth 直接喂 collectSite → 抛错', async () => {
    freshEnv('site-no-default');
    const source = upsertSource({ type: 'site', name: 'SiteStrip', target: `http://127.0.0.1:${port}/` }).source;
    const noPages = { ...source, options: { ...source.options, maxPages: undefined } };
    await assert.rejects(
      async () => { for await (const _ of collectSite(noPages, { allowPrivateNetwork: true })) { void _; } },
      /maxPages/,
    );
    const noDepth = { ...source, options: { ...source.options, depth: undefined } };
    await assert.rejects(
      async () => { for await (const _ of collectSite(noDepth, { allowPrivateNetwork: true })) { void _; } },
      /depth/,
    );
  });

  it('SSRF guard: url source WITHOUT allowPrivateNetwork refuses localhost', async () => {
    freshEnv('ssrf');
    const source = upsertSource({ type: 'url', name: 'Guarded', target: `http://127.0.0.1:${port}/a.html` }).source;
    const r = await refreshSource(source.id); // no allowPrivateNetwork
    assert.equal(r.added, 0);
    assert.ok(r.errors >= 1);
    assert.match(r.errorList[0].error, /private|internal|refus/i);
  });

  it('previewSource url (allowPrivateNetwork) does not write cache', async () => {
    freshEnv('preview');
    const p = await previewSource({ type: 'url', name: 'p', target: `http://127.0.0.1:${port}/b.html` }, { allowPrivateNetwork: true });
    assert.equal(p.ok, true);
    assert.match(p.title, /Page B/);
    assert.match(p.content, /beta page body/);
    assert.equal(listItems({}).length, 0); // 未落盘
  });
});

// ---------------------------------------------------------------------------
// vault collector (injected vaultRoot)
// ---------------------------------------------------------------------------
describe('vault source (read-only, injected root)', () => {
  it('normalizes notes; hides .meta; strips front matter', async () => {
    freshEnv('vault');
    const vroot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    fs.mkdirSync(path.join(vroot, '.meta'), { recursive: true });
    fs.writeFileSync(path.join(vroot, '.meta', 'leak.md'), '# Should not appear');
    fs.writeFileSync(path.join(vroot, 'n1.md'), '---\ntitle: Note One\ntags: [product]\n---\n# Note One\nreal body one');
    fs.writeFileSync(path.join(vroot, 'n2.md'), '# Note Two\nbody two');
    const source = upsertSource({ type: 'vault', name: 'V', target: '' }).source;
    const r = await refreshSource(source.id, { vaultRoot: vroot });
    const titles = listItems({ sourceId: source.id }).map((i) => i.title).sort();
    assert.deepEqual(titles, ['Note One', 'Note Two']); // .meta skipped
    const one = listItems({ sourceId: source.id }).find((i) => i.title === 'Note One');
    const full = readItem(one.id);
    assert.match(full.content, /real body one/);
    assert.ok(!full.content.includes('title: Note One')); // front matter stripped
    assert.equal(r.errors, 0);
  });

  it('anyOfTags filter', async () => {
    freshEnv('vtag');
    const vroot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault2-'));
    fs.writeFileSync(path.join(vroot, 'a.md'), '---\ntags: [keep]\n---\nA body');
    fs.writeFileSync(path.join(vroot, 'b.md'), '---\ntags: [drop]\n---\nB body');
    const source = upsertSource({ type: 'vault', name: 'V', target: '', options: { anyOfTags: ['keep'] } }).source;
    await refreshSource(source.id, { vaultRoot: vroot });
    const items = listItems({ sourceId: source.id });
    assert.equal(items.length, 1);
    assert.match(items[0].origin, /a\.md$/);
  });
});

// ---------------------------------------------------------------------------
// helpers under test
// ---------------------------------------------------------------------------
describe('helpers', () => {
  it('capByBytes is utf8-boundary safe', () => {
    const s = '你好世界'.repeat(100);
    const { text, truncated, bytes } = capByBytes(s, 10);
    assert.equal(truncated, true);
    assert.ok(bytes <= 10);
    assert.ok(!text.includes('\uFFFD')); // 无替换字符
  });
  it('classifyExt', () => {
    assert.equal(classifyExt('.md'), 'text');
    assert.equal(classifyExt('.png'), 'media');
    assert.equal(classifyExt('.xyz'), 'unknown');
  });
  it('glob matchesAny', () => {
    assert.equal(matchesAny('a/b/c.md', ['**/*.md']), true);
    assert.equal(matchesAny('a/b/c.md', ['*.md']), false);
    assert.equal(matchesAny('top.md', ['**/*.md']), true);
    assert.equal(matchesAny('x.png', []), true); // 空 patterns 不限制
  });
  it('isWithinRoot', () => {
    assert.equal(isWithinRoot('/a/b', '/a/b/c/d'), true);
    assert.equal(isWithinRoot('/a/b', '/a/c'), false);
    assert.equal(isWithinRoot('/a/b', '/a/b'), true);
  });
});

// ---------------------------------------------------------------------------
// HTTP route handlers (stub send/readBody + spawnNdjsonTask)
// ---------------------------------------------------------------------------
describe('routes/sources.mjs handlers', () => {
  let ctx;
  beforeEach(() => {
    freshEnv('route');
    ctx = makeRouteCtx();
  });

  it('GET /api/sources → {version,sources}, create/list/items/refresh flow', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'src-rt-'));
    fs.writeFileSync(path.join(tmp, 'm.md'), '# M\ncontent');
    // create
    const created = await call(ctx, 'POST', '/api/sources', { body: { acknowledgeExternalPath: true, type: 'dir', name: 'R', target: tmp } });
    assert.equal(created.status, 201);
    const id = created.body.source.id;
    // list
    const listed = await call(ctx, 'GET', '/api/sources');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.sources.length, 1);
    assert.equal(typeof listed.body.sources[0].itemCount, 'number');
    // refresh start (spawn stub records)
    const started = await call(ctx, 'POST', `/api/sources/${id}/refresh`);
    assert.equal(started.status, 202);
    assert.equal(ctx.captured.spawn.name, id);
    assert.equal(ctx.captured.spawn.script, 'sources/refresh.mjs');
    // duplicate refresh → 409
    const dup = await call(ctx, 'POST', `/api/sources/${id}/refresh`);
    assert.equal(dup.status, 409);
    // events SSE → serveSse called
    const ev = await call(ctx, 'GET', `/api/sources/${id}/refresh/events`);
    assert.equal(ev.sse, true);
    // items (empty, spawn is a stub, no real crawl)
    const items = await call(ctx, 'GET', `/api/sources/${id}/items`);
    assert.equal(items.status, 200);
    assert.deepEqual(items.body.items, []);
  });

  it('PUT updates, DELETE removes; missing → 404', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'src-rt2-'));
    const id = (await call(ctx, 'POST', '/api/sources', { body: { acknowledgeExternalPath: true, type: 'dir', name: 'R', target: tmp } })).body.source.id;
    const upd = await call(ctx, 'PUT', `/api/sources/${id}`, { body: { name: 'R2' } });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.source.name, 'R2');
    const del = await call(ctx, 'DELETE', `/api/sources/${id}`);
    assert.equal(del.status, 204);
    const upd404 = await call(ctx, 'PUT', '/api/sources/src-gone', { body: { name: 'x' } });
    assert.equal(upd404.status, 404);
    const del404 = await call(ctx, 'DELETE', '/api/sources/src-gone');
    assert.equal(del404.status, 404);
  });

  it('error mapping: invalid id → 400, invalid body → 400', async () => {
    const badId = await call(ctx, 'PUT', '/api/sources/bad..id', { body: { name: 'x' } });
    assert.equal(badId.status, 400);
    const nonSrc = await call(ctx, 'DELETE', '/api/sources/not-src-prefix');
    assert.equal(nonSrc.status, 400);
    const badBody = await call(ctx, 'POST', '/api/sources', { body: { type: 'ftp', name: 'x', target: 'y' } });
    assert.equal(badBody.status, 400);
    const refresh404 = await call(ctx, 'POST', '/api/sources/src-ghost/refresh');
    assert.equal(refresh404.status, 404);
  });

  it('POST /api/sources/preview runs collectors in-process (dir + bad → 400/500)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'src-pv-'));
    fs.writeFileSync(path.join(tmp, 'z.md'), '# Zulu\npreview body');
    const pv = await call(ctx, 'POST', '/api/sources/preview', { body: { acknowledgeExternalPath: true, type: 'dir', name: 'P', target: tmp } });
    assert.equal(pv.status, 200);
    assert.equal(pv.body.ok, true);
    assert.match(pv.body.title, /Zulu/);
    // invalid target → validateSource 400
    const bad = await call(ctx, 'POST', '/api/sources/preview', { body: { acknowledgeExternalPath: true, type: 'dir', name: 'P', target: '../../../etc' } });
    assert.equal(bad.status, 400);
    // dir missing → collector throws 500
    const miss = await call(ctx, 'POST', '/api/sources/preview', { body: { acknowledgeExternalPath: true, type: 'dir', name: 'P', target: path.join(tmp, 'nope') } });
    assert.equal(miss.status, 500);
  });

  it('GET /api/sources/items aggregates (not shadowed by :id route)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'src-agg-'));
    fs.writeFileSync(path.join(tmp, 'k.md'), '# K\nk body');
    const id = (await call(ctx, 'POST', '/api/sources', { body: { acknowledgeExternalPath: true, type: 'dir', name: 'K', target: tmp } })).body.source.id;
    await refreshSource(id); // 真实抓取写缓存（不经 spawn 桩）
    const items = await call(ctx, 'GET', '/api/sources/items');
    assert.equal(items.status, 200);
    assert.ok(items.body.items.some((i) => i.title === 'K'));
  });
});

// ---------------------------------------------------------------------------
// P1-1 路径安全：外部授权（env）+ 显式确认 + 敏感/禁入拒绝清单
// ---------------------------------------------------------------------------
describe('P1-1 path safety: external gate + sensitive denylist', () => {
  it('仓库外绝对 target 在未设 env 时默认被拒', () => {
    freshEnv('p11-deny');
    const saved = process.env.AI_PPT_ALLOW_EXTERNAL_SOURCES;
    delete process.env.AI_PPT_ALLOW_EXTERNAL_SOURCES;
    try {
      assert.throws(
        () => validateSource({ type: 'dir', name: 'X', target: os.tmpdir(), acknowledgeExternalPath: true }),
        /AI_PPT_ALLOW_EXTERNAL_SOURCES/,
      );
    } finally {
      process.env.AI_PPT_ALLOW_EXTERNAL_SOURCES = saved;
    }
  });

  it('设了 env 仍需显式 acknowledgeExternalPath；确认后才放行', () => {
    freshEnv('p11-ack'); // freshEnv 已设 env=1
    assert.throws(
      () => validateSource({ type: 'dir', name: 'X', target: os.tmpdir() }), // 无 ack
      /acknowledgeExternalPath/,
    );
    const ok = validateSource({ type: 'dir', name: 'X', target: os.tmpdir(), acknowledgeExternalPath: true });
    assert.equal(ok.type, 'dir');
    assert.equal(ok.acknowledgeExternalPath, true); // 确认标记随源持久化，PUT 改名时无需再确认
  });

  it('敏感位置 target 即使 env+ack 也拒绝（.ssh/.aws 段、/etc、/var/root 前缀）', () => {
    freshEnv('p11-sens');
    const home = os.homedir();
    for (const bad of [
      path.join(home, '.ssh'),
      path.join(home, '.aws', 'credentials'),
      '/etc/passwd',
      '/private/etc/hosts',
      '/var/root/secret.md',
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sec-')), '.ssh', 'id_ed25519'), // 任意位置的 .ssh 段
    ]) {
      assert.throws(
        () => validateSource({ type: 'dir', name: 'X', target: bad, acknowledgeExternalPath: true }),
        /敏感位置|禁入目录/,
        `target 应被拒：${bad}`,
      );
    }
  });

  it('条目级 basename/段命中被排除：即使扩展名是 .md/.json 也不入库（P2-E 收窄 id_ 后双向锁定）', async () => {
    freshEnv('p11-entry');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-'));
    fs.writeFileSync(path.join(dir, 'keep.md'), '# Keep\nlegit note');
    // 真·SSH 私钥：无扩展名 id_ed25519 —— 收窄后仍命中 basename 清单，被排除
    fs.writeFileSync(path.join(dir, 'id_ed25519'), 'PRIVATE KEY MATERIAL');
    // 文档里极常见的 id_* 命名（P2-E 收窄前会被 ^id_.+ 误伤，收窄后应正常入库）
    fs.writeFileSync(path.join(dir, 'id_mapping.md'), '# Mapping\nid mapping doc');
    fs.writeFileSync(path.join(dir, 'credentials.json'), '{"a":1}');
    fs.mkdirSync(path.join(dir, 'sub', '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', '.ssh', 'token.md'), '# Token');
    const source = mkDirSource({ type: 'dir', name: 'Entry', target: dir }).source;
    const r = await refreshSource(source.id);
    const titles = listItems({ sourceId: source.id }).map((i) => i.title).sort();
    // keep.md 与 id_mapping.md 入库；id_ed25519 / credentials.json / .ssh 段被清单排除
    assert.deepEqual(titles, ['Keep', 'Mapping']);
    // 敏感文件确实在磁盘上（证明是清单挡的，不是没造出来）
    assert.ok(fs.existsSync(path.join(dir, 'credentials.json')));
    assert.ok(fs.existsSync(path.join(dir, 'id_ed25519')));
    // P2-E：命中清单被跳过的条目要可观测（这里 id_ed25519 + credentials.json + sub/.ssh/token.md = 3）
    assert.ok(r.policySkipped >= 3, `policySkipped 应记录被跳过的敏感条目，实得 ${r.policySkipped}`);
  });

});

// ---------------------------------------------------------------------------
// P1-2 禁入清单在 target 即禁入目录 / normalize 穿越时仍生效
// ---------------------------------------------------------------------------
describe('P1-2 forbidden-dir enforcement is absolute-based', () => {
  it('target 本身就是 .git/.backup/.snapshots/node_modules → 创建即拒（env+ack 也救不了）', () => {
    freshEnv('p12-target');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    for (const seg of ['.git', '.backup', '.snapshots', 'node_modules']) {
      fs.mkdirSync(path.join(repo, seg), { recursive: true });
      assert.throws(
        () => validateSource({ type: 'dir', name: 'X', target: path.join(repo, seg), acknowledgeExternalPath: true }),
        /禁入目录/,
        `target=${seg} 应被拒`,
      );
    }
  });

  it('normalize 穿越变体（repo/.git/./refs/../../.git）归一后命中禁入 → 拒', () => {
    freshEnv('p12-trav');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo2-'));
    const tricky = path.join(repo, '.git', '.', 'refs', '..', '..', '.git');
    assert.throws(
      () => validateSource({ type: 'dir', name: 'X', target: tricky, acknowledgeExternalPath: true }),
      /禁入目录/,
    );
  });

  it('collect-time：合法 target 之下的禁入子目录/条目仍被排除', async () => {
    freshEnv('p12-collect');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo3-'));
    fs.writeFileSync(path.join(repo, 'ok.md'), '# Ok\ngood doc');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'secret.md'), '# GitSecret');
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'README.md'), '# Nm');
    fs.mkdirSync(path.join(repo, '.backup'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.backup', 'snap.md'), '# Backup');
    const source = mkDirSource({ type: 'dir', name: 'Repo', target: repo }).source;
    const r = await refreshSource(source.id);
    const titles = listItems({ sourceId: source.id }).map((i) => i.title).sort();
    assert.deepEqual(titles, ['Ok']);
    assert.equal(r.added, 1);
  });
});

// ---------------------------------------------------------------------------
// P1-3 终态 NDJSON 事件 type 不被载荷 type 覆盖（端到端子进程）
// ---------------------------------------------------------------------------
describe('P1-3 done-event type integrity (spawn CLI)', () => {
  it('子进程刷新终态行 type==="done" 且载荷字段齐全，且没有任何行借用 dir/url/site/vault 作为 type', async () => {
    freshEnv('p13');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\nbody a');
    const source = mkDirSource({ type: 'dir', name: 'Cli', target: dir }).source;

    const events = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [REFRESH_CLI, source.id], { env: { ...process.env } });
      let out = '';
      const done = [];
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += `\n[stderr] ${d}`; });
      const killer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('CLI timeout')); }, 15000);
      child.on('close', () => {
        clearTimeout(killer);
        for (const line of out.split('\n')) {
          if (!line.trim()) continue;
          try { done.push(JSON.parse(line)); } catch { /* non-json */ }
        }
        resolve(done);
      });
      child.on('error', reject);
    });

    const finalLine = events[events.length - 1];
    assert.equal(finalLine.type, 'done', '终态行必须是 type:"done"');
    assert.equal(typeof finalLine.itemCount, 'number');
    assert.equal(typeof finalLine.truncated, 'boolean');
    assert.equal(finalLine.sourceType, 'dir'); // 源类型改名为 sourceType，不再占用 type
    assert.ok(!events.some((e) => ['dir', 'url', 'site', 'vault'].includes(e.type)),
      '不得出现以源类型充当事件 type 的行');
  });
});

// ---------------------------------------------------------------------------
// P1-4 采集全失败不得清空既有语料
// ---------------------------------------------------------------------------
describe('P1-4 total-failure refresh preserves existing corpus', () => {
  it('url 源一次抓取全失败 → 保留既有 item 与 manifest，removed=0 且事件可观测', async () => {
    freshEnv('p14');
    const source = upsertSource({ type: 'url', name: 'U', target: 'https://kb.example/page.html' }).source;
    // 第一次成功
    const okFetch = async () => ({ html: '<title>P</title><article>content one</article>', finalUrl: 'https://kb.example/page.html' });
    const r1 = await refreshSource(source.id, { fetchPage: okFetch });
    assert.equal(r1.added, 1);
    const cached = listItems({ sourceId: source.id });
    assert.equal(cached.length, 1);
    const itemId = cached[0].id;

    // 第二次：抓取抛错（上游 503 / DNS 抖动），本轮 0 入库 + errors>0
    const badFetch = async () => { throw new Error('503 Service Unavailable'); };
    const events = [];
    const r2 = await refreshSource(source.id, { fetchPage: badFetch, onEvent: (e) => events.push(e) });

    assert.equal(r2.preserved, true);
    assert.equal(r2.removed, 0);
    assert.equal(r2.itemCount, 1, '保留的既有语料数不变');
    assert.equal(r2.errors, 1);
    assert.ok(listItems({ sourceId: source.id }).length === 1, 'item 未被删');
    assert.ok(readItem(itemId), '磁盘 item 文件仍在');
    assert.equal(readManifest(source.id).preserved, true);
    assert.ok(events.some((e) => e.step === 'preserve'), '应有 preserve 事件上报');
  });
});

// ---------------------------------------------------------------------------
// P2-1 body 读取绝对截止期
// ---------------------------------------------------------------------------
describe('P2-1 net body-read deadline', () => {
  it('慢速流式响应被绝对 deadline 中断（不再只保护 header）', async () => {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      sockets.add(res.socket);
      res.socket.on('close', () => sockets.delete(res.socket));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><body>');
      const iv = setInterval(() => { try { res.write('x'); } catch { clearInterval(iv); } }, 20);
      res.socket.on('close', () => clearInterval(iv));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const t0 = Date.now();
    let threw = null;
    try {
      await fetchPage(`http://127.0.0.1:${port}/slow`, { allowPrivateNetwork: true, timeoutMs: 200 });
    } catch (err) { threw = err; }
    const elapsed = Date.now() - t0;
    for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
    await new Promise((r) => server.close(r));

    assert.ok(threw, '应因超时抛错');
    assert.match(threw.message, /timed out/i);
    assert.ok(elapsed < 3000, `应在 deadline 附近结束，实测 ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// P2-2 跨 sourceId 全局刷新并发闸 → 429
// ---------------------------------------------------------------------------
describe('P2-2 global refresh concurrency gate', () => {
  it('并发刷新超过上限（2）→ 第 3 个 429', async () => {
    freshEnv('p22');
    const ctx = makeRouteCtx();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `conc-${i}-`));
      fs.writeFileSync(path.join(d, 'x.md'), '# X');
      const r = await call(ctx, 'POST', '/api/sources', { body: { acknowledgeExternalPath: true, type: 'dir', name: `C${i}`, target: d } });
      ids.push(r.body.source.id);
    }
    const a = await call(ctx, 'POST', `/api/sources/${ids[0]}/refresh`);
    const b = await call(ctx, 'POST', `/api/sources/${ids[1]}/refresh`);
    const c = await call(ctx, 'POST', `/api/sources/${ids[2]}/refresh`);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal(c.status, 429, '第 3 个并发刷新应被全局闸拒绝');
  });
});

// ---------------------------------------------------------------------------
// P2-3 url/site 抓取上限随 maxBytesPerItem 抬高 + 超限截断可见
// ---------------------------------------------------------------------------
describe('P2-3 network cap follows maxBytesPerItem, oversize truncates (visible)', () => {
  it('refresh 把该源 maxBytesPerItem 透传给采集器的 maxBytes', async () => {
    freshEnv('p23-wire');
    let seenMaxBytes = null;
    const spy = async (_url, opts) => {
      seenMaxBytes = opts.maxBytes;
      return { html: '<title>T</title><article>hi</article>', finalUrl: _url };
    };
    const source = upsertSource({ type: 'url', name: 'U', target: 'https://x.example/p', options: { maxBytesPerItem: 123456 } }).source;
    await refreshSource(source.id, { fetchPage: spy });
    assert.equal(seenMaxBytes, 123456, 'net maxBytes 应等于源 maxBytesPerItem');
  });

  it('默认 512KB 上限下大页面被截断（item.truncated=true，非整页失败）；抬高上限后完整抓取', async () => {
    const PAGE = '<!doctype html><html><head><title>Big</title></head><body><article>'
      + ('<p>filler paragraph text for padding.</p>').repeat(40000) + '</article></body></html>';
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/big`;
    assert.ok(Buffer.byteLength(PAGE) > 524288, '构造的页面应大于默认上限');
    try {
      // 默认 maxBytesPerItem=512KB → 截断
      const s1 = upsertSource({ type: 'url', name: 'Big1', target: url }).source;
      const r1 = await refreshSource(s1.id, { allowPrivateNetwork: true });
      assert.equal(r1.errors, 0, '超限不得整页失败');
      const it1 = listItems({ sourceId: s1.id })[0];
      assert.equal(it1.truncated, true, '应在 manifest/条目上标记 truncated');

      // 抬高到 2MB → 完整，无截断
      const s2 = upsertSource({ type: 'url', name: 'Big2', target: url, options: { maxBytesPerItem: 2 * 1024 * 1024 } }).source;
      await refreshSource(s2.id, { allowPrivateNetwork: true });
      const it2 = listItems({ sourceId: s2.id })[0];
      assert.equal(it2.truncated, undefined, '未超限不应标记 truncated');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ---- route harness ----
function makeRouteCtx() {
  const captured = {};
  const sourceRefreshes = new Map();
  const taskRegistry = { get: () => undefined, create() {}, complete() {}, fail() {} };
  const deps = {
    send: (res, status, data) => { res.status = status; res.body = data; },
    readBody: async (req) => req._body ?? {},
    validName: (name, res, msg) => {
      if (!isSafeName(name)) { deps.send(res, 400, { error: msg || '非法名称' }); return false; }
      return true;
    },
    ROOT: process.cwd(),
    spawnNdjsonTask: (store, name, script, args) => {
      const state = { name, process: null, buffer: [], listeners: new Set(), done: false };
      store.set(name, state);
      captured.spawn = { store, name, script, args };
      return state;
    },
    serveSse: (res, state) => { res.sse = true; res.state = state; },
    hasActiveTask: (store, name) => { const s = store.get(name); return !!(s && !s.done); },
    sourceRefreshes,
    taskRegistry,
  };
  return { routes: sourcesRoutes(deps), deps, captured };
}
async function call(ctx, method, pathname, { body } = {}) {
  const route = ctx.routes.find((r) => r.method === method && pathname.match(r.pattern));
  assert.ok(route, `no route for ${method} ${pathname}`);
  const matches = pathname.match(route.pattern);
  const res = {};
  await route.handler({ _body: body, url: `http://x${pathname}`, headers: { host: 'x' } }, res, matches);
  return res;
}


// ---------------------------------------------------------------------------
// P1-A 部分抓取失败：按 origin 保命 + 降级阈值（不再是"成功 1 条就清空整库"）
// ---------------------------------------------------------------------------
describe('P1-A partial-failure refresh keeps errored origins as stale', () => {
  it('site 源：入口成功 + 3 子页失败 → 3 条标 stale 保留（removed=0），非整体保留也非物理删除', async () => {
    freshEnv('p1a');
    const ENTRY = 'http://site.test/';
    let round = 1;
    const fetchStub = async (url) => {
      if (url === ENTRY) {
        return {
          html: '<title>Home</title><a href="/a.html">A</a><a href="/b.html">B</a><a href="/c.html">C</a>',
          finalUrl: ENTRY,
        };
      }
      if (round === 1) return { html: `<title>${url}</title><article>body</article>`, finalUrl: url };
      throw new Error('503 Service Unavailable');
    };
    const source = upsertSource({ type: 'site', name: 'S', target: ENTRY, options: { depth: 1, maxPages: 10 } }).source;

    // 首轮全部成功：entry + 3 子页 = 4 条
    const r1 = await refreshSource(source.id, { fetchPage: fetchStub });
    assert.equal(r1.itemCount, 4, '首轮应入库 4 条');
    assert.equal(r1.errors, 0);

    // 次轮：入口成功、3 子页 503。旧闸门"只要成功 1 条即放行 prune"会把 3 条物理删光（评审复现 4→1）。
    round = 2;
    const events = [];
    const r2 = await refreshSource(source.id, { fetchPage: fetchStub, onEvent: (e) => events.push(e) });

    assert.equal(r2.errors, 3);
    assert.equal(r2.staleCount, 3, '3 条失败 origin 应被标记 stale 保命');
    assert.equal(r2.removed, 0, '部分失败不得物理删除任何条目');
    assert.equal(r2.itemCount, 4, '总量守恒：1 成功 + 3 stale');
    assert.equal(r2.degraded, true);
    assert.equal(r2.preserved, false, '这不是整体失败保留，而是部分降级');

    const m = readManifest(source.id);
    assert.equal(m.degraded, true);
    assert.equal(m.staleCount, 3);
    assert.equal(m.items.length, 4);
    assert.equal(m.items.filter((i) => i.stale === true).length, 3);

    // 磁盘 item 文件仍在（未被 rm），4 个 .md
    const itemsDir = path.join(process.env.AI_PPT_SOURCE_CACHE_ROOT, source.id, 'items');
    const onDisk = fs.readdirSync(itemsDir).filter((f) => f.endsWith('.md'));
    assert.equal(onDisk.length, 4);

    assert.ok(events.some((e) => e.step === 'degraded'), '应有 degraded 事件上报');
  });

  it('上游确实删除的条目（无对应错误）在正常轮次仍被清理 removed=1', async () => {
    freshEnv('p1a-rm');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1a-rm-'));
    fs.writeFileSync(path.join(dir, 'a.md'), '# A');
    fs.writeFileSync(path.join(dir, 'b.md'), '# B');
    const source = mkDirSource({ type: 'dir', name: 'D', target: dir }).source;
    const r1 = await refreshSource(source.id);
    assert.equal(r1.itemCount, 2);
    fs.rmSync(path.join(dir, 'b.md'));
    const r2 = await refreshSource(source.id);
    assert.equal(r2.removed, 1, '无错误、上游真删除 → 正常清理 1 条');
    assert.equal(r2.staleCount, 0);
    assert.equal(r2.degraded, false);
    assert.equal(r2.itemCount, 1);
  });

  it('P1-A′ 低比例部分失败：entry+10 子页、次轮仅 1 条 429 → 由 erroredOrigins 逐条保命（errors/prev=0.09 远低于 0.5，不走兜底）', async () => {
    freshEnv('p1a-low');
    const ENTRY = 'http://site.test/';
    const FAILED = 'http://site.test/p3.html';
    let round = 1;
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/p${i + 1}.html">P${i + 1}</a>`).join('');
    const fetchStub = async (url) => {
      if (url === ENTRY) return { html: `<title>Home</title>${links}`, finalUrl: ENTRY };
      // 次轮只有 p3 失败（429，非 confirmed-gone），其余照常成功
      if (round === 2 && url === FAILED) throw new Error('429 Too Many Requests');
      return { html: `<title>${url}</title><article>body</article>`, finalUrl: url };
    };
    const source = upsertSource({ type: 'site', name: 'Low', target: ENTRY, options: { depth: 1, maxPages: 20 } }).source;

    const r1 = await refreshSource(source.id, { fetchPage: fetchStub });
    assert.equal(r1.itemCount, 11, '首轮 entry + 10 子页全入库');
    assert.equal(r1.errors, 0);

    round = 2;
    const events = [];
    const r2 = await refreshSource(source.id, { fetchPage: fetchStub, onEvent: (e) => events.push(e) });

    assert.equal(r2.errors, 1);
    assert.equal(r2.staleCount, 1, '低比例失败须由 erroredOrigins 逐条保命，而非阈值兜底');
    assert.equal(r2.removed, 0);
    assert.equal(r2.itemCount, 11);
    assert.ok(events.some((e) => e.step === 'degraded'));
    // 锁死"阈值没参与"：被标 stale 的必须恰好是失败那一条 origin
    const stale = readManifest(source.id).items.filter((i) => i.stale === true);
    assert.equal(stale.length, 1);
    assert.ok(stale.every((i) => i.origin === FAILED), `唯一 stale 项应为失败 origin，实得 ${stale.map((i) => i.origin)}`);
    // 兜底确未触发（否则删掉 erroredOrigins.add 也不会红）——1/11 明确低于阈值
    assert.equal(r2.degraded, true, 'degraded 由 per-origin 保命驱动');
  });
});


// ---------------------------------------------------------------------------
// P1-①（r5 回归）：整源归零闸门必须重看「本轮有无错误」，不能只看「未确认错误」。
// 成对锁死两种形状，防止来回摆：
//   1A 仅入口页 404（子页本轮根本没抓过）→ 必须保命 removed=0（旧闸门被 uncertainErrors=0 免检 → 清零，即回归）。
//   1D 入口成功 + 子页全 404（每子页本轮都真被抓到并确认消失）→ 必须逐条清理 removed=10（P2-G 语义要能减）。
// ---------------------------------------------------------------------------
describe('P1-① entry-only confirmed-gone must NOT wipe corpus (r5 regression)', () => {
  it('1A：site 源次轮仅入口页 404 → removed=0 / preserved / itemCount 不变，且广播 all-confirmed-gone preserve', async () => {
    freshEnv('p1-1a');
    const ENTRY = 'http://site.test/';
    const httpErr = (msg, status) => { const e = new Error(msg); e.httpStatus = status; return e; };
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/p${i + 1}.html">P${i + 1}</a>`).join('');
    let round = 1;
    const fetchStub = async (url) => {
      if (url === ENTRY) {
        if (round === 2) throw httpErr('404 Not Found', 404); // 入口页改版/404
        return { html: `<title>Home</title>${links}`, finalUrl: ENTRY };
      }
      return { html: `<title>${url}</title><article>body</article>`, finalUrl: url };
    };
    const source = upsertSource({ type: 'site', name: 'E', target: ENTRY, options: { depth: 1, maxPages: 20 } }).source;

    const r1 = await refreshSource(source.id, { fetchPage: fetchStub });
    assert.equal(r1.itemCount, 11, '首轮 entry + 10 子页全入库');

    round = 2;
    const events = [];
    const r2 = await refreshSource(source.id, { fetchPage: fetchStub, onEvent: (e) => events.push(e) });

    assert.equal(r2.errors, 1, '仅入口页 404 → 1 条错误，子页本轮根本没被抓');
    assert.equal(r2.removed, 0, 'P1-①：整源归零 + 全 confirmed-gone 仍须保命，绝不清空（回归点）');
    assert.equal(r2.itemCount, 11, '11 条一条不少');
    assert.equal(r2.preserved, true, 'summary.preserved=true（整源归零闸门触发）');
    assert.ok(events.some((e) => e.step === 'preserve'), '必须广播 preserve 事件');

    const m = readManifest(source.id);
    assert.equal(m.preserved, 'all-confirmed-gone', 'manifest.preserved 记为 all-confirmed-gone 以便区分普通采集失败');
    // 关键：10 条子页本轮根本没被抓过（只有入口 404），prev 原样保留，一条不能少。
    const subCount = m.items.filter((i) => /\/p\d+\.html$/.test(String(i.origin))).length;
    assert.equal(subCount, 10, '10 条未被抓取的子页必须整批保命，不因入口 404 被兜底删除（回归点）');
    // 磁盘 11 个 .md 一个不少
    const itemsDir = path.join(process.env.AI_PPT_SOURCE_CACHE_ROOT, source.id, 'items');
    assert.equal(fs.readdirSync(itemsDir).filter((f) => f.endsWith('.md')).length, 11, '磁盘 .md 不得被清空');
  });

  it('1D：site 源次轮入口成功 + 10 子页全 404 → 逐条确认消失、正常清理 removed=10', async () => {
    freshEnv('p1-1d');
    const ENTRY = 'http://site.test/';
    const httpErr = (msg, status) => { const e = new Error(msg); e.httpStatus = status; return e; };
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/p${i + 1}.html">P${i + 1}</a>`).join('');
    let round = 1;
    const fetchStub = async (url) => {
      if (url === ENTRY) return { html: `<title>Home</title>${links}`, finalUrl: ENTRY };
      if (round === 2) throw httpErr('404 Not Found', 404); // 每个子页本轮都真被抓到并确认 404
      return { html: `<title>${url}</title><article>body</article>`, finalUrl: url };
    };
    const source = upsertSource({ type: 'site', name: 'D', target: ENTRY, options: { depth: 1, maxPages: 20 } }).source;

    const r1 = await refreshSource(source.id, { fetchPage: fetchStub });
    assert.equal(r1.itemCount, 11);

    round = 2;
    const events = [];
    const r2 = await refreshSource(source.id, { fetchPage: fetchStub, onEvent: (e) => events.push(e) });

    assert.equal(r2.errors, 10, '入口成功 + 10 子页各 1 条 404');
    assert.equal(r2.preserved, false, '有成功入库（入口）→ 不触发整源归零闸门');
    assert.equal(r2.removed, 10, 'P2-G：子页本轮逐条被抓并确认 404 → 正常清理（缓存要能减）');
    assert.equal(r2.staleCount, 0, '全为 confirmed-gone，不应有 stale 保命');
    assert.equal(r2.itemCount, 1, '仅入口页重抓成功');
    // 清理可观测：pruned 事件 + 分类计数
    const pruned = events.find((e) => e.step === 'pruned');
    assert.ok(pruned, 'removed>0 必须广播 pruned 事件');
    assert.equal(pruned.detail.removed, 10);
    assert.equal(pruned.detail.confirmedGone, 10, '全部经 confirmedGoneOrigins 精确命中清理');
    assert.equal(pruned.detail.unconfirmed, 0);
    assert.equal(r2.prunedConfirmedGone, 10);
    assert.equal(r2.prunedUnconfirmed, 0);
  });
});

// ---------------------------------------------------------------------------
// P2-C ack 只在确为外部时持久化；PUT 改 target/type 不继承 ack；env 关对存量源撤回
// ---------------------------------------------------------------------------
describe('P2-C external-ack hardening', () => {
  it('内部目录源即使请求带 acknowledgeExternalPath 也不持久化该标记（不免费铸造）', () => {
    freshEnv('p2c-internal');
    const s = validateSource({ type: 'dir', name: 'Ref', target: 'references', acknowledgeExternalPath: true });
    assert.equal(s.external, undefined);
    assert.ok(!('acknowledgeExternalPath' in s), '内部源不应写入 acknowledgeExternalPath');
  });

  it('PUT 更换 target 必须二次确认：不带 ack 改外部 target → 抛错；带上则成功；仅改名免确认', () => {
    freshEnv('p2c-put');
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'p2c-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'p2c-b-'));
    fs.writeFileSync(path.join(dirA, 'x.md'), '# X');
    fs.writeFileSync(path.join(dirB, 'y.md'), '# Y');
    const created = upsertSource({ type: 'dir', name: 'Ext', target: dirA, acknowledgeExternalPath: true }).source;
    assert.equal(created.acknowledgeExternalPath, true);

    // 换 target 无 ack → 剥离旧标记 → 越界但缺确认 → 抛错
    assert.throws(
      () => upsertSource({ target: dirB }, created.id),
      /acknowledgeExternalPath/,
      '改 target 到另一个外部目录必须重新确认',
    );
    // 仅改名（不带 target）→ 继承标记 → 成功
    const renamed = upsertSource({ name: 'Renamed' }, created.id).source;
    assert.equal(renamed.name, 'Renamed');
    assert.equal(renamed.acknowledgeExternalPath, true);
    // 换 target 且带 ack → 成功
    const moved = upsertSource({ target: dirB, acknowledgeExternalPath: true }, created.id).source;
    assert.equal(moved.target, path.normalize(dirB));
  });

  it('撤回授权：建外部源后关掉 env → refreshSource 抛 403（对存量源生效）', async () => {
    freshEnv('p2c-revoke');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2c-rev-'));
    fs.writeFileSync(path.join(dir, 'x.md'), '# X');
    const source = upsertSource({ type: 'dir', name: 'Ext', target: dir, acknowledgeExternalPath: true }).source;
    const saved = process.env.AI_PPT_ALLOW_EXTERNAL_SOURCES;
    delete process.env.AI_PPT_ALLOW_EXTERNAL_SOURCES;
    try {
      await assert.rejects(() => refreshSource(source.id), (err) => err.statusCode === 403);
    } finally {
      process.env.AI_PPT_ALLOW_EXTERNAL_SOURCES = saved;
    }
    // 重新开启 env 后仍可刷新（授权语境恢复）
    const r = await refreshSource(source.id);
    assert.equal(r.added, 1);
  });
});

// ---------------------------------------------------------------------------
// P2-B 符号链接逃逸与大小写折叠（realpath 重查）
// ---------------------------------------------------------------------------
describe('P2-B symlink-escape + case-insensitive denylist', () => {
  it('仓库内软链指向 ~/.ssh：validateSource(env+ack) 现按 realpath 判敏感而拒绝（旧词法判定会放行）', () => {
    freshEnv('p2b-sym');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-'));
    const fakeSsh = path.join(base, 'fakehome', '.ssh');
    fs.mkdirSync(fakeSsh, { recursive: true });
    fs.writeFileSync(path.join(fakeSsh, 'id_ed25519'), 'KEY');
    const link = path.join(base, 'link-to-ssh');
    fs.symlinkSync(fakeSsh, link, 'dir');
    // 词法上 link 在 base（非敏感）内，但 realpath 落在 .ssh 段 → 必须拒
    assert.throws(
      () => validateSource({ type: 'dir', name: 'X', target: link, acknowledgeExternalPath: true }),
      /敏感位置/,
    );
  });

  it('collect-time：软链根指向敏感目录 → collectDir 直接抛 400（防绕过 registry 直接喂）', async () => {
    freshEnv('p2b-collect');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p2bc-'));
    const fakeAws = path.join(base, '.aws');
    fs.mkdirSync(fakeAws, { recursive: true });
    fs.writeFileSync(path.join(fakeAws, 'creds.md'), '# C');
    const link = path.join(base, 'docs');
    fs.symlinkSync(fakeAws, link, 'dir');
    await assert.rejects(
      async () => { for await (const _ of collectDir({ type: 'dir', name: 'X', target: link, options: { maxPages: 30, maxBytesPerItem: 4096 } }, {})) { void _; } },
      /敏感|禁入/,
    );
  });

  it('大小写不敏感文件系统上 ~/.SSH 折叠命中敏感段（darwin/win32）', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return; // Linux 上大小写敏感，跳过
    assert.equal(hasSensitiveSegment('/Users/x/.SSH/foo'), true, '.SSH 应与 .ssh 同等命中');
    assert.equal(hasSensitiveSegment('/Users/x/.ssh/foo'), true);
    // 前导点区分不受折叠影响：普通 config 段不应命中敏感目录段
    assert.equal(hasSensitiveSegment('/Users/x/config/foo'), false);
  });
});

// ---------------------------------------------------------------------------
// P2-E 被禁入/敏感清单跳过的条目可观测（policySkipped + 事件 + manifest + GET 透出）
// ---------------------------------------------------------------------------
describe('P2-E policy-skipped observability', () => {
  it('isSensitivePath 收窄后的边界：id_ 仅挡无扩展名私钥，文档命名放行；.ai-ppt-*.json 拦截', () => {
    assert.equal(isSensitivePath('/x/id_ed25519'), true);
    assert.equal(isSensitivePath('/x/id_rsa'), true);
    assert.equal(isSensitivePath('/x/id_mapping.md'), false, 'id_mapping.md 不应被误伤');
    assert.equal(isSensitivePath('/x/ID_list.csv'), false, 'ID_list.csv 不应被误伤');
    assert.equal(isSensitivePath('/x/credentials-api.md'), false, 'credentials-api.md 不应被误伤');
    assert.equal(isSensitivePath('/x/credentials.json'), true);
    assert.equal(isSensitivePath('/x/.ai-ppt-config.json'), true);
    assert.equal(isSensitivePath('/x/.ai-ppt-tasks.json'), true);
  });

  it('dir 源命中清单 → refresh.policySkipped>0 + policy-skipped 事件 + manifest 记录 + GET /api/sources 透出', async () => {
    freshEnv('p2e-vis');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2e-'));
    fs.writeFileSync(path.join(dir, 'good.md'), '# Good\ndoc');
    fs.writeFileSync(path.join(dir, 'credentials.json'), '{"secret":1}');
    fs.mkdirSync(path.join(dir, 'keys', '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'keys', '.ssh', 'note.md'), '# note');
    const source = mkDirSource({ type: 'dir', name: 'P', target: dir }).source;

    const events = [];
    const r = await refreshSource(source.id, { onEvent: (e) => events.push(e) });
    assert.equal(r.itemCount, 1, '只 good.md 入库');
    assert.ok(r.policySkipped >= 2, `policySkipped 至少 2（credentials.json + .ssh 段），实得 ${r.policySkipped}`);
    assert.ok(events.some((e) => e.step === 'policy-skipped'), '应有 policy-skipped 事件');

    const m = readManifest(source.id);
    assert.ok(Number.isFinite(m.policySkipped) && m.policySkipped >= 2);
    assert.ok(Array.isArray(m.policySamples));

    // 经 HTTP GET 透出（加性字段，既有键不变）
    const ctx = makeRouteCtx();
    const listed = await call(ctx, 'GET', '/api/sources');
    const row = listed.body.sources.find((s) => s.id === source.id);
    assert.ok(row, 'GET 应能列出该源');
    assert.ok(row.policySkipped >= 2, 'GET /api/sources 应透出 policySkipped');
    assert.ok('itemCount' in row && 'truncated' in row && 'droppedCount' in row && 'target' in row,
      '既有键 itemCount/truncated/droppedCount/target 必须保留');
  });
});

// ---------------------------------------------------------------------------
// P2-D url 采集器生产分支（无 allowPrivateNetwork）也走 net.fetchPage：
//     抬高到 2MB 的 maxBytesPerItem 生效（旧 content-extractor 1MB 硬失败 → errors=1）
// ---------------------------------------------------------------------------
describe('P2-D url collector production branch respects maxBytesPerItem (net path)', () => {
  it('生产默认路径（不带 allowPrivateNetwork）抓取 1.5MB 页面在 2MB 上限下成功入库、errors=0', async () => {
    freshEnv('p2d');
    const body = '<!doctype html><html><head><title>BigProd</title></head><body><article>'
      + 'x'.repeat(Math.floor(1.5 * 1024 * 1024)) + '</article></body></html>';
    assert.ok(Buffer.byteLength(body) > 1024 * 1024, '构造体应超过 content-extractor 的 1MB 硬上限');

    const origLookup = dns.lookup;
    const origFetch = globalThis.fetch;
    dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }]; // 让 isPublicHost 通过（生产分支不跳过 SSRF）
    globalThis.fetch = async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    try {
      const source = upsertSource({
        type: 'url', name: 'BigProd', target: 'https://docs.example.com/page',
        options: { maxBytesPerItem: 2 * 1024 * 1024 },
      }).source;
      const r = await refreshSource(source.id); // 无 allowPrivateNetwork：走生产分支
      assert.equal(r.errors, 0, `生产分支应经 net.fetchPage 成功；若回退 content-extractor 会因 >1MB 抛错，实得 errors=${r.errors} ${JSON.stringify(r.errorList || [])}`);
      assert.equal(r.itemCount, 1);
      const it = listItems({ sourceId: source.id })[0];
      assert.match(it.title, /BigProd/);
      assert.equal(it.truncated, undefined, '1.5MB < 2MB 上限，不应标记截断');
    } finally {
      dns.lookup = origLookup;
      globalThis.fetch = origFetch;
    }
  });

  it('生产默认路径经 net.fetchPage：仅注入 globalThis.fetch（不 mock 守卫），私有/回环 target 被 SSRF 拒绝且传输层从未被调用', async () => {
    freshEnv('p2d-ssrf');
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalls++; return new Response('<html><body>should-not-reach</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }); };
    try {
      // 不带 allowPrivateNetwork：真实生产分支。net.fetchPage 的 SSRF 守卫应在建立传输前就拒绝回环地址。
      const source = upsertSource({ type: 'url', name: 'Loop', target: 'http://127.0.0.1:9/x' }).source;
      const r = await refreshSource(source.id);
      assert.equal(r.itemCount, 0, '回环地址不得入库');
      assert.ok(r.errors >= 1, '生产分支应因 SSRF 守卫产生错误');
      assert.match(r.errorList[0].error, /private|internal|refus/i, `错误应来自 SSRF 守卫，实得：${r.errorList[0].error}`);
      assert.equal(fetchCalls, 0, 'SSRF 守卫须在调用传输层 fetch 之前拦截（若为 0 说明守卫在生产路径真实生效，非被注入绕过）');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});


// ---------------------------------------------------------------------------
// P2-G confirmed-gone(404/410/ENOENT) 正常清理、未确认失败(5xx/429/…) stale 保命
//     —— 走真实 net.fetchPage（仅 allowPrivateNetwork，不注入 ctx.fetchPage），锁死同一判定式两侧分叉
// ---------------------------------------------------------------------------
describe('P2-G confirmed-gone prunes, transient failure preserves stale (real net path)', () => {
  let server, port;
  let round = 1;
  const PAGE = (t) => `<!doctype html><html><head><title>${t}</title></head><body><article>${t} body</article></body></html>`;
  before(async () => {
    server = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      const origin = `http://127.0.0.1:${port}`;
      if (u === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html><head><title>Home</title></head><body>`
          + `<a href="/a.html">A</a><a href="/b.html">B</a><a href="/c.html">C</a>`
          + `<a href="${origin}/gone.html">G</a><a href="${origin}/err.html">E</a></body></html>`);
      }
      if (u === '/a.html' || u === '/b.html' || u === '/c.html') {
        res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE(u));
      }
      if (u === '/gone.html') {
        if (round === 1) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE('/gone.html')); }
        res.writeHead(404, { 'content-type': 'text/html' }); return res.end('gone');   // 上游确认删除
      }
      if (u === '/err.html') {
        if (round === 1) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE('/err.html')); }
        res.writeHead(503, { 'content-type': 'text/html' }); return res.end('temp');   // 瞬时不可用
      }
      res.writeHead(404); res.end('nope');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => new Promise((r) => server.close(r)));

  it('次轮 404 条目被正常清理(removed、非 stale)、503 条目 stale 保命——同一条判定式两侧分叉', async () => {
    freshEnv('p2g');
    const GONE = `http://127.0.0.1:${port}/gone.html`;
    const ERR = `http://127.0.0.1:${port}/err.html`;
    round = 1;
    const source = upsertSource({ type: 'site', name: 'G', target: `http://127.0.0.1:${port}/`, options: { depth: 1, maxPages: 10 } }).source;
    const r1 = await refreshSource(source.id, { allowPrivateNetwork: true });
    assert.equal(r1.itemCount, 6, 'entry+a+b+c+gone+err 首轮全入库');
    assert.equal(r1.errors, 0);

    round = 2;
    const events = [];
    const r2 = await refreshSource(source.id, { allowPrivateNetwork: true, onEvent: (e) => events.push(e) });

    assert.equal(r2.errors, 2);
    assert.equal(r2.removed, 1, '404 是 confirmed-gone → 正常清理一条');
    assert.equal(r2.staleCount, 1, '503 是未确认失败 → stale 保命一条');
    assert.equal(r2.itemCount, 5, 'entry+a+b+c 成功 + err(stale) = 5；gone 已删除');

    const m = readManifest(source.id);
    assert.ok(!m.items.some((i) => i.origin === GONE), 'gone 条目应已从 manifest 删除');
    const errItem = m.items.find((i) => i.origin === ERR);
    assert.ok(errItem, 'err 条目应仍在 manifest');
    assert.equal(errItem.stale, true, 'err 条目应标 stale');
    assert.ok(events.some((e) => e.step === 'degraded'));

    // 磁盘：gone 的 .md 被物理删除，err 的 .md 仍在（stale 保命不删）
    const itemsDir = path.join(process.env.AI_PPT_SOURCE_CACHE_ROOT, source.id, 'items');
    assert.ok(!fs.existsSync(path.join(itemsDir, `${makeItemId(source.id, GONE)}.md`)), 'gone 的 item 文件应已删除');
    assert.ok(fs.existsSync(path.join(itemsDir, `${makeItemId(source.id, ERR)}.md`)), 'err 的 item 文件应保留');
  });
});


// ---------------------------------------------------------------------------
// P2-F dir/vault 目录级错误的 origin 对不上问题：失败目录前缀 → 子树保命；
//      与 P2-G 的 ENOENT 分类划清"暂时不可读(保命)" vs "目录真被删(正常清理)"。
// ---------------------------------------------------------------------------
describe('P2-F dir directory-level failure: transient unreadable preserves subtree', () => {
  function buildDirSrc(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), label + '-'));
    for (let i = 1; i <= 10; i++) fs.writeFileSync(path.join(dir, `t${i}.md`), `# T${i}\nbody`);
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    for (let j = 1; j <= 3; j++) fs.writeFileSync(path.join(sub, `s${j}.md`), `# S${j}\nbody`);
    return { dir, sub };
  }

  it('次轮子目录 chmod 000（EACCES 非 ENOENT）→ 该子树 3 条 stale 保命不删，顶层 10 条正常，degraded 事件发出', async (t) => {
    freshEnv('p2f');
    const { dir, sub } = buildDirSrc('p2f-eacces');
    const source = mkDirSource({ type: 'dir', name: 'F', target: dir }).source;
    const r1 = await refreshSource(source.id);
    assert.equal(r1.itemCount, 13, '首轮 10 顶层 + 3 子树全入库');

    fs.chmodSync(sub, 0o000);
    // 环境守卫：若本进程是 root，DAC 不生效、readdir 仍成功 → 无法触发目录级错误，显式 skip（而非假绿）。
    try { fs.readdirSync(sub); t.skip('readdir on chmod 000 still succeeds (running as root?) — cannot exercise EACCES path'); return; }
    catch { /* 期望：抛 EACCES，继续 */ }

    try {
      const events = [];
      const r2 = await refreshSource(source.id, { onEvent: (e) => events.push(e) });
      assert.equal(r2.errors, 1, '子目录 readdir 失败记 1 条错误');
      assert.equal(r2.removed, 0, 'P2-F：目录级失败 origin(目录) 对不上条目(文件)，但前缀保命 → 一条不删');
      assert.equal(r2.staleCount, 3, '该子树 3 条应 stale 保命');
      assert.equal(r2.itemCount, 13, '13 条一条不少（10 重抓 + 3 stale）');
      assert.ok(events.some((e) => e.step === 'degraded'), '目录级失败也必须发 degraded 事件，不得只剩通用 fetch-error');

      const m = readManifest(source.id);
      const stale = m.items.filter((i) => i.stale === true);
      assert.equal(stale.length, 3);
      const pre = sub + path.sep;
      assert.ok(stale.every((i) => String(i.origin).startsWith(pre)), '被保命的必须恰是失败子树下的条目');
      assert.ok(m.items.filter((i) => !String(i.origin).startsWith(pre)).every((i) => i.stale !== true), '顶层条目不应被标 stale');

      const itemsDir = path.join(process.env.AI_PPT_SOURCE_CACHE_ROOT, source.id, 'items');
      assert.equal(fs.readdirSync(itemsDir).filter((f) => f.endsWith('.md')).length, 13, '磁盘 .md 不得减少');
    } finally {
      fs.chmodSync(sub, 0o755); // 恢复权限，否则临时目录无法清理
    }
  });

  it('对照：子目录被真删除 → 子树 3 条正常清理(removed=3、非 stale)，与"暂时不可读保命"分叉', async () => {
    freshEnv('p2f-del');
    const { dir, sub } = buildDirSrc('p2f-del');
    const source = mkDirSource({ type: 'dir', name: 'FD', target: dir }).source;
    const r1 = await refreshSource(source.id);
    assert.equal(r1.itemCount, 13);

    fs.rmSync(sub, { recursive: true, force: true }); // 上游确认删除整个子目录（无 readdir 错误：目录直接不见）
    const events = [];
    const r2 = await refreshSource(source.id, { onEvent: (e) => events.push(e) });
    assert.equal(r2.errors, 0, '整目录删除不产生抓取错误');
    assert.equal(r2.removed, 3, '子树 3 条按确认消失正常清理');
    assert.equal(r2.staleCount, 0, '真删除不得被 stale 保命');
    assert.equal(r2.itemCount, 10);
    const pre = sub + path.sep;
    assert.ok(!readManifest(source.id).items.some((i) => String(i.origin).startsWith(pre)), '已删子树不应留在 manifest');
    // ①.3 + ④ 选项 B：清理可观测——removed>0 必须发 pruned；这 3 条来自"本轮没抓到也没报错"兜底分支，归 unconfirmed。
    // 证明删掉 confirmedGonePrefixes 死分支后，"目录真消失"仍由此兜底分支清理、缓存能减不受影响。
    const pruned = events.find((e) => e.step === 'pruned');
    assert.ok(pruned, 'removed>0 必须发 pruned 事件');
    assert.equal(pruned.detail.confirmedGone, 0, '目录整体消失无逐条错误 → 归 unconfirmed 而非 confirmedGone');
    assert.equal(pruned.detail.unconfirmed, 3);
  });

  it('P2-②：遍历中途子目录 readdir 返回 ENOENT → 归"未确认"，子树 stale 保命不删（绝不用一次 readdir 码冒充已删）', async () => {
    freshEnv('p2e-noent');
    const { dir, sub } = buildDirSrc('p2e-noent');
    const source = mkDirSource({ type: 'dir', name: 'E', target: dir }).source;
    const r1 = await refreshSource(source.id);
    assert.equal(r1.itemCount, 13, '首轮 10 顶层 + 3 子树全入库');

    // 确定性构造"父已枚举、descend 时子目录 readdir 返 ENOENT"（卷中途弹出/TOCTOU），且子目录磁盘上依然存在。
    const realReaddir = fs.readdirSync;
    fs.readdirSync = function (p, ...rest) {
      if (String(p) === sub) { const e = new Error(`ENOENT: no such file or directory, scandir '${sub}'`); e.code = 'ENOENT'; throw e; }
      return realReaddir.call(fs, p, ...rest);
    };
    try {
      const events = [];
      const r2 = await refreshSource(source.id, { onEvent: (e) => events.push(e) });
      assert.equal(r2.errors, 1, '子目录 readdir ENOENT 记 1 条目录级错误');
      assert.equal(r2.removed, 0, 'P2-②：目录级 ENOENT 不算上游确认删除 → 一条不删（去掉 isDirectoryLevel 短路即被清零，回归点）');
      assert.equal(r2.staleCount, 3, '该子树 3 条 stale 保命');
      assert.equal(r2.itemCount, 13, '13 条一条不少');
      assert.ok(events.some((e) => e.step === 'degraded'), '目录级失败必须发 degraded，不得只剩 fetch-error');
      assert.ok(!events.some((e) => e.step === 'pruned'), 'removed=0 不应发 pruned');
      const m = readManifest(source.id);
      const pre = sub + path.sep;
      const stale = m.items.filter((i) => i.stale === true);
      assert.equal(stale.length, 3);
      assert.ok(stale.every((i) => String(i.origin).startsWith(pre)), '被保命的必须恰是失败子树下的条目');
      const itemsDir = path.join(process.env.AI_PPT_SOURCE_CACHE_ROOT, source.id, 'items');
      assert.equal(fs.readdirSync.call(fs, itemsDir).filter((f) => f.endsWith('.md')).length, 13, '磁盘 .md 不得减少');
    } finally {
      fs.readdirSync = realReaddir;
    }
  });

  it('P2-③ vault 孪生用例：子目录瞬时 EACCES → 子树 stale 保命（证明相对前缀命中，非 dir-only 假绿）', async (t) => {
    freshEnv('p2v-eacces');
    const vroot = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-'));
    for (let i = 1; i <= 10; i++) fs.writeFileSync(path.join(vroot, `t${i}.md`), `# T${i}\nbody`);
    const sub = path.join(vroot, 'sub');
    fs.mkdirSync(sub);
    for (let j = 1; j <= 3; j++) fs.writeFileSync(path.join(sub, `s${j}.md`), `# S${j}\nbody`);
    const source = upsertSource({ type: 'vault', name: 'V', target: '' }).source;
    const r1 = await refreshSource(source.id, { vaultRoot: vroot });
    assert.equal(r1.itemCount, 13, '首轮 10 顶层 + 3 子树全入库');

    fs.chmodSync(sub, 0o000);
    try { fs.readdirSync(sub); t.skip('readdir on chmod 000 still succeeds (running as root?) — cannot exercise EACCES path'); return; }
    catch { /* 期望 EACCES */ }

    try {
      const events = [];
      const r2 = await refreshSource(source.id, { vaultRoot: vroot, onEvent: (e) => events.push(e) });
      assert.equal(r2.errors, 1, '子目录 readdir EACCES 记 1 条目录级错误');
      assert.equal(r2.removed, 0, 'P2-③：vault 目录级失败必须前缀保命，一条不删（若 collect-vault 仍 yield 绝对 dir → 这里被清零）');
      assert.equal(r2.staleCount, 3, '该子树 3 条 stale 保命');
      assert.equal(r2.itemCount, 13, '13 条一条不少');
      assert.ok(events.some((e) => e.step === 'degraded'), 'vault 目录级失败必须发 degraded');
      const m = readManifest(source.id);
      const stale = m.items.filter((i) => i.stale === true);
      assert.equal(stale.length, 3);
      // vault 条目 origin 是相对路径 sub/s0.md（非绝对），前缀命中依赖 ③ 的相对 yield。
      assert.ok(stale.every((i) => /^sub[\\/]/.test(String(i.origin))), `被保命的必须是相对子树 origin，实得 ${stale.map((i) => i.origin)}`);
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });
});


// ---------------------------------------------------------------------------
// P2-H 撤回授权的外部目录源：POST /refresh 在 HTTP 边界同步 403（不等子进程、不假 202）
// ---------------------------------------------------------------------------
describe('P2-H refresh authorization revocation returns 403 synchronously', () => {
  it('env 在时 POST refresh → 202；撤回 env 后同一源 → 同步 403 且不拉起刷新子进程', async () => {
    freshEnv('p2h'); // freshEnv 已设 AI_PPT_ALLOW_EXTERNAL_SOURCES=1
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2h-'));
    fs.writeFileSync(path.join(dir, 'x.md'), '# X');
    const ctx = makeRouteCtx();
    const created = await call(ctx, 'POST', '/api/sources', { body: { acknowledgeExternalPath: true, type: 'dir', name: 'Ext', target: dir } });
    assert.equal(created.status, 201);
    const id = created.body.source.id;

    const ok = await call(ctx, 'POST', `/api/sources/${id}/refresh`);
    assert.equal(ok.status, 202, '授权有效时照常异步启动刷新');

    // 撤回授权：关掉 env（存量外部源也应被拒）。用新 ctx 断言 403 路径没有拉起子进程。
    delete process.env.AI_PPT_ALLOW_EXTERNAL_SOURCES;
    try {
      const ctx2 = makeRouteCtx();
      const r = await call(ctx2, 'POST', `/api/sources/${id}/refresh`);
      assert.equal(r.status, 403, 'P2-H：撤回授权须在 HTTP 边界同步返回 403，而非 202「已启动」');
      assert.match(r.body.error, /AI_PPT_ALLOW_EXTERNAL_SOURCES/);
      assert.equal(ctx2.captured.spawn, undefined, '403 时绝不能再拉起 refresh 子进程');
    } finally {
      process.env.AI_PPT_ALLOW_EXTERNAL_SOURCES = '1';
    }
  });
});
