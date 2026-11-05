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
import { isWithinRoot } from '../scripts/sources/paths.mjs';
import { matchesAny } from '../scripts/sources/glob.mjs';
import sourcesRoutes from '../routes/sources.mjs';
import { isSafeName } from '../scripts/config.mjs';

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

  it('条目级 basename/段命中被排除：即使扩展名是 .md/.json 也不入库', async () => {
    freshEnv('p11-entry');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-'));
    fs.writeFileSync(path.join(dir, 'keep.md'), '# Keep\nlegit note');
    fs.writeFileSync(path.join(dir, 'id_notes.md'), '# IDN\nlooks like a doc but id_ prefix');
    fs.writeFileSync(path.join(dir, 'credentials.json'), '{"a":1}');
    fs.mkdirSync(path.join(dir, 'sub', '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', '.ssh', 'token.md'), '# Token');
    const source = mkDirSource({ type: 'dir', name: 'Entry', target: dir }).source;
    await refreshSource(source.id);
    const titles = listItems({ sourceId: source.id }).map((i) => i.title).sort();
    assert.deepEqual(titles, ['Keep']); // 只有 keep.md 入库
    // 敏感文件确实在磁盘上（证明是清单挡的，不是没造出来）
    assert.ok(fs.existsSync(path.join(dir, 'credentials.json')));
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
