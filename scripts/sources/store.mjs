// scripts/sources/store.mjs — 抓取缓存（vault/.meta/source-cache/<sourceId>/）的读写与读取 API。
// 结构：manifest.json = {sourceId,fetchedAt,fingerprint,items:[{id,title,origin,hash,bytes,file,tags}]}
//       items/<itemId>.md = 带 Front Matter 的统一文本条目
// itemId 编码 sourceId（<sourceId>--<hex>），使 readItem(itemId) 无需 sourceId 即可定位。
// M10（大纲/批量生成）按此契约 import readManifest/listItems/readItem。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic, writeFileAtomic } from '../fs-utils.mjs';
import { parseFrontMatter, stringifyFrontMatter } from '../front-matter.mjs';
import { isSafeName } from '../config.mjs';
import { cacheRoot, sourceItemsDir, sourceManifestPath, sourceCacheDir } from './paths.mjs';

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// 稳定的条目 id：同一 origin（文件路径/URL/笔记名）在多次刷新间保持不变，便于增量去重与 readItem 定位。
export function makeItemId(sourceId, originKey) {
  const h = sha256(originKey).slice(0, 12);
  return `${sourceId}--${h}`;
}

export function sourceIdFromItem(itemId) {
  const s = String(itemId || '');
  const i = s.indexOf('--');
  return i > 0 ? s.slice(0, i) : null;
}

function safeItemId(itemId) {
  return typeof itemId === 'string' && isSafeName(itemId) && !itemId.startsWith('.');
}

/** 读取某个源的 manifest.json；不存在/损坏返回 null。 */
export function readManifest(sourceId) {
  if (typeof sourceId !== 'string' || !isSafeName(sourceId)) return null;
  const file = sourceManifestPath(sourceId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object' || !Array.isArray(m.items)) return null;
    return m;
  } catch {
    return null;
  }
}

/** 原子写 manifest.json。 */
export function writeManifest(sourceId, manifest) {
  const payload = {
    sourceId,
    fetchedAt: manifest.fetchedAt || new Date().toISOString(),
    fingerprint: manifest.fingerprint || '',
    items: Array.isArray(manifest.items) ? manifest.items : [],
    ...(manifest.errors ? { errors: manifest.errors } : {}),
  };
  writeJsonAtomic(sourceManifestPath(sourceId), payload);
  return payload;
}

/** 写入单个条目 md（带 Front Matter）。body 为统一纯文本/Markdown。 */
export function writeItem(sourceId, item, body) {
  const fm = {
    title: item.title,
    source_id: sourceId,
    origin: item.origin,
    fetched_at: item.fetchedAt || new Date().toISOString(),
    hash: item.hash,
    tags: item.tags || [],
    ...(item.truncated ? { truncated: true } : {}),
    ...(item.kind ? { kind: item.kind } : {}),
  };
  const content = stringifyFrontMatter(fm) + '\n' + String(body ?? '') + '\n';
  const filePath = path.join(sourceItemsDir(sourceId), `${item.id}.md`);
  writeFileAtomic(filePath, content);
  return filePath;
}

/**
 * 读取单个条目。返回 { itemId, sourceId, frontMatter, content } 或 null（不存在）。
 * frontMatter 含 title/source_id/origin/fetched_at/hash/tags/truncated?/kind?。
 */
export function readItem(itemId) {
  if (!safeItemId(itemId)) return null;
  const sourceId = sourceIdFromItem(itemId);
  if (!sourceId) return null;
  const filePath = path.join(sourceItemsDir(sourceId), `${itemId}.md`);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const { frontMatter, content } = parseFrontMatter(raw);
  return { itemId, sourceId, frontMatter, content: content.replace(/\n$/, '') };
}

// 列出 cacheRoot 下所有有缓存的 sourceId
function allCachedSourceIds() {
  const root = cacheRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => isSafeName(n));
}

/**
 * 列出条目（来自 manifest，不读 md 正文）。
 * @param {{sourceId?:string,q?:string,limit?:number,fields?:string[]}} [opts]
 *   sourceId 省略则聚合所有源；q 对 title/origin 做大小写无关子串过滤；limit>0 截断。
 */
export function listItems(opts = {}) {
  const { sourceId, q, limit } = opts;
  const ids = sourceId ? [sourceId] : allCachedSourceIds();
  let out = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !isSafeName(id)) continue;
    const m = readManifest(id);
    if (!m) continue;
    for (const it of m.items) {
      out.push({ ...it, sourceId: id });
    }
  }
  const query = String(q || '').trim().toLowerCase();
  if (query) {
    out = out.filter((it) =>
      String(it.title || '').toLowerCase().includes(query) ||
      String(it.origin || '').toLowerCase().includes(query));
  }
  if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
  return out;
}

/** 删除某源的全部缓存（删源时可选清理）。 */
export function removeCache(sourceId) {
  if (typeof sourceId !== 'string' || !isSafeName(sourceId)) return false;
  const dir = sourceCacheDir(sourceId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
