// scripts/sources/refresh.mjs — 抓取编排：按源类型分派采集器，做基于 hash 的增量去重，
// 写 items/*.md + manifest.json，回填 sources.json 的 lastFetchedAt。
// 既可作库函数 refreshSource()/previewSource() 供路由/测试 import，也可作 CLI 子进程：
//   node scripts/sources/refresh.mjs <sourceId>   → 逐行输出 NDJSON（与生成任务同协议）
// 增量语义：同 origin 稳定 itemId；hash 未变的条目不重写；上游消失的条目在整批成功后清理。
import fs from 'node:fs';
import path from 'node:path';
import {
  readManifest, writeManifest, writeItem, makeItemId, sha256,
} from './store.mjs';
import { sourceItemsDir } from './paths.mjs';
import { getSource, validateSource, markFetched } from './registry.mjs';
import { capByBytes } from './text-extract.mjs';
import { collectDir } from './collect-dir.mjs';
import { collectUrl } from './collect-url.mjs';
import { collectSite } from './collect-site.mjs';
import { collectVault } from './collect-vault.mjs';

function dispatch(source) {
  switch (source.type) {
    case 'dir': return collectDir;
    case 'url': return collectUrl;
    case 'site': return collectSite;
    case 'vault': return collectVault;
    default: {
      const err = new Error(`未知源类型：${source.type}`);
      err.statusCode = 400;
      throw err;
    }
  }
}

/**
 * 抓取并落盘一个源。
 * @param {object|string} sourceOrId 源对象或源 id
 * @param {{onEvent?:(ev:object)=>void,fetchPage?:Function,allowPrivateNetwork?:boolean,vaultRoot?:string,maxBytes?:number,force?:boolean}} [opts]
 * @returns {Promise<{sourceId,added,updated,unchanged,removed,errors,fingerprint,itemCount,lastFetchedAt}>}
 */
export async function refreshSource(sourceOrId, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const source = typeof sourceOrId === 'string' ? getSource(sourceOrId) : sourceOrId;
  if (!source || !source.id) {
    const err = new Error('源不存在');
    err.statusCode = 404;
    throw err;
  }
  const sourceId = source.id;
  const maxBytesPerItem = Number.isFinite(source.options?.maxBytesPerItem)
    ? source.options.maxBytesPerItem
    : 524288;

  const collector = dispatch(source);
  const prev = readManifest(sourceId) || { items: [] };
  const prevById = new Map((prev.items || []).map((it) => [it.id, it]));

  const newItems = [];
  const newIds = new Set();
  const errors = [];
  let added = 0; let updated = 0; let unchanged = 0;

  const ctx = {
    fetchPage: opts.fetchPage,
    allowPrivateNetwork: opts.allowPrivateNetwork,
    vaultRoot: opts.vaultRoot,
    maxBytes: opts.maxBytes,
    onProgress: (message, detail) => onEvent({ step: 'scan', message, detail: detail || null }),
  };

  for await (const entry of collector(source, ctx)) {
    if (entry.kind === 'error') {
      errors.push({ origin: entry.origin || null, error: entry.error || 'unknown error' });
      onEvent({ step: 'fetch-error', message: `抓取失败：${entry.origin || ''}`, detail: { origin: entry.origin, error: entry.error } });
      continue;
    }
    const id = makeItemId(sourceId, entry.originKey);
    if (newIds.has(id)) continue; // 本轮去重（同 originKey 只留一条）

    let storedBody;
    let truncated = false;
    if (entry.kind === 'text') {
      const capped = capByBytes(entry.body || '', maxBytesPerItem);
      storedBody = capped.text;
      truncated = capped.truncated;
    } else {
      storedBody = entry.note ? `> ${entry.note}\n` : '';
    }
    const hash = sha256(storedBody);
    const bytes = Buffer.byteLength(storedBody, 'utf8');
    const prevItem = prevById.get(id);
    const action = !prevItem ? 'added' : (prevItem.hash !== hash ? 'updated' : 'unchanged');

    if (action !== 'unchanged') {
      const fetchedAt = new Date().toISOString();
      writeItem(sourceId, {
        id,
        title: entry.title,
        origin: entry.origin,
        hash,
        tags: entry.tags || [],
        truncated,
        kind: entry.kind,
        fetchedAt,
      }, storedBody);
    }

    newItems.push({
      id,
      title: entry.title,
      origin: entry.origin,
      hash,
      bytes,
      file: `items/${id}.md`,
      tags: entry.tags || [],
      ...(truncated ? { truncated: true } : {}),
    });
    newIds.add(id);
    if (action === 'added') added++;
    else if (action === 'updated') updated++;
    else unchanged++;

    onEvent({
      step: 'item',
      message: `${action}：${entry.title || entry.origin}`,
      detail: { id, action, origin: entry.origin, bytes, truncated },
    });
  }

  // 上游消失的条目：仅在整批成功采集后清理物理文件（errors 只影响对应条目，不影响清理）
  let removed = 0;
  const itemsDir = sourceItemsDir(sourceId);
  for (const old of prev.items || []) {
    if (!newIds.has(old.id)) {
      try {
        fs.rmSync(path.join(itemsDir, `${old.id}.md`), { force: true });
        removed++;
      } catch { /* 文件可能已不在 */ }
    }
  }

  const fingerprint = sha256(newItems.map((i) => `${i.id}:${i.hash}`).sort().join('\n'));
  const fetchedAt = new Date().toISOString();
  writeManifest(sourceId, {
    sourceId,
    fetchedAt,
    fingerprint,
    items: newItems,
    ...(errors.length ? { errors } : {}),
  });
  markFetched(sourceId, fetchedAt);

  const summary = {
    sourceId,
    name: source.name,
    type: source.type,
    added,
    updated,
    unchanged,
    removed,
    errors: errors.length,
    errorList: errors,
    fingerprint,
    itemCount: newItems.length,
    lastFetchedAt: fetchedAt,
  };
  return summary;
}

/**
 * 不落盘地试抓一条，返回正文预览（供 POST /api/sources/preview）。
 * @param {object|string} sourceOrId 已校验的源对象，或源 id，或原始 input（会先 validateSource）
 */
export async function previewSource(sourceOrId, opts = {}) {
  let source;
  if (typeof sourceOrId === 'string') {
    source = getSource(sourceOrId);
    if (!source) { const e = new Error('源不存在'); e.statusCode = 404; throw e; }
  } else if (sourceOrId && sourceOrId.id) {
    source = sourceOrId;
  } else {
    source = validateSource(sourceOrId); // 校验并归一，但不生成 id（预览不落盘）
  }
  const collector = dispatch(source);
  // 克隆：只取第一条、正文截短，不写盘
  const probe = {
    ...source,
    id: source.id || 'preview',
    options: { ...(source.options || {}), maxPages: 1, maxBytesPerItem: 20000 },
  };
  const ctx = {
    fetchPage: opts.fetchPage,
    allowPrivateNetwork: opts.allowPrivateNetwork,
    vaultRoot: opts.vaultRoot,
    maxBytes: opts.maxBytes,
    onProgress: () => {},
  };
  for await (const entry of collector(probe, ctx)) {
    if (entry.kind === 'error') {
      return { ok: false, origin: entry.origin, error: entry.error };
    }
    const capped = entry.kind === 'text'
      ? capByBytes(entry.body || '', 20000)
      : { text: entry.note ? `> ${entry.note}\n` : '', truncated: false };
    return {
      ok: true,
      kind: entry.kind,
      origin: entry.origin,
      title: entry.title,
      bytes: Buffer.byteLength(capped.text, 'utf8'),
      truncated: capped.truncated,
      content: capped.text,
    };
  }
  return { ok: false, error: '源为空或无匹配条目' };
}

// ---- CLI：node scripts/sources/refresh.mjs <sourceId> ----
async function runCli() {
  const { emit, emitError, emitDone } = await import('../generation-common.mjs');
  const sourceId = process.argv[2];
  if (!sourceId) {
    emitError('用法：node scripts/sources/refresh.mjs <sourceId>');
    process.exit(2);
  }
  const source = getSource(sourceId);
  if (!source) {
    emitError(`源不存在：${sourceId}`);
    process.exit(1);
  }
  emit('start', `开始刷新素材源 ${source.name}（${source.type}）`, { sourceId, type: source.type });
  try {
    const summary = await refreshSource(source, {
      onEvent: (ev) => emit(ev.step || 'progress', ev.message, ev.detail),
    });
    emitDone({ ...summary });
  } catch (err) {
    emitError(err.message || '刷新失败');
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('refresh.mjs');
if (invokedDirectly) {
  runCli();
}
