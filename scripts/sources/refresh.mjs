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
import { getSource, validateSource, markFetched, requireFiniteOption } from './registry.mjs';
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
  const maxBytesPerItem = requireFiniteOption(source, 'maxBytesPerItem');

  const collector = dispatch(source);
  const prev = readManifest(sourceId) || { items: [] };
  const prevById = new Map((prev.items || []).map((it) => [it.id, it]));

  const newItems = [];
  const newIds = new Set();
  const errors = [];
  let added = 0; let updated = 0; let unchanged = 0;
  let truncation = null; // { collected, dropped, total, cap }

  const ctx = {
    fetchPage: opts.fetchPage,
    allowPrivateNetwork: opts.allowPrivateNetwork,
    vaultRoot: opts.vaultRoot,
    maxBytes: Number.isFinite(opts.maxBytes) ? opts.maxBytes : maxBytesPerItem, // P2-3：url/site 抓取上限随该源 maxBytesPerItem 抬高
    onProgress: (message, detail) => onEvent({ step: 'scan', message, detail: detail || null }),
  };

  for await (const entry of collector(source, ctx)) {
    if (entry.kind === 'error') {
      errors.push({ origin: entry.origin || null, error: entry.error || 'unknown error' });
      onEvent({ step: 'fetch-error', message: `抓取失败：${entry.origin || ''}`, detail: { origin: entry.origin, error: entry.error } });
      continue;
    }
    // 采集器在因 maxPages 截断时补发 summary：转为明确告警事件 + 记入 manifest，供前端徽标提示
    if (entry.kind === 'summary') {
      truncation = {
        collected: entry.collected | 0,
        dropped: entry.dropped | 0,
        total: entry.total | 0,
        cap: Number.isFinite(entry.cap) ? entry.cap : null,
      };
      onEvent({
        step: 'truncated',
        message: `素材源「${source.name}」被 maxPages 截断：共 ${entry.total} 个候选，仅入库 ${entry.collected} 个，丢弃 ${entry.dropped} 个（上限 maxPages=${entry.cap}）`,
        detail: truncation,
      });
      continue;
    }
    const id = makeItemId(sourceId, entry.originKey);
    if (newIds.has(id)) continue; // 本轮去重（同 originKey 只留一条）

    let storedBody;
    let truncated = false;
    if (entry.kind === 'text') {
      const capped = capByBytes(entry.body || '', maxBytesPerItem);
      storedBody = capped.text;
      truncated = capped.truncated || entry.bodyTruncated === true; // 正文二次截断 或 采集器响应体截断（P2-3）
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

  // P1-4 成功性闸门：本轮零入库且存在抓取/抽取错误 → 判定为「采集整体失败」（上游 503 / DNS 抖动 /
  // 维护窗口等），跳过 prune、保留既有 items，避免一次失败静默销毁已入库语料；并把该事实显式上报。
  const prevItemCount = (prev.items || []).length;
  const pruneBlocked = newItems.length === 0 && prevItemCount > 0 && errors.length > 0;

  let removed = 0;
  if (!pruneBlocked) {
    // 上游消失的条目：正常批次下清理物理文件（errors 只影响对应条目，不阻断清理）
    const itemsDir = sourceItemsDir(sourceId);
    for (const old of prev.items || []) {
      if (!newIds.has(old.id)) {
        try {
          fs.rmSync(path.join(itemsDir, `${old.id}.md`), { force: true });
          removed++;
        } catch { /* 文件可能已不在 */ }
      }
    }
  } else {
    onEvent({
      step: 'preserve',
      message: `素材源「${source.name}」本轮采集失败（0 入库 / ${errors.length} 错误），已跳过清理并保留既有 ${prevItemCount} 条素材`,
      detail: { keptItems: prevItemCount, errors: errors.length },
    });
  }

  const collectedFingerprint = sha256(newItems.map((i) => `${i.id}:${i.hash}`).sort().join('\n'));
  const fingerprint = pruneBlocked ? (prev.fingerprint || '') : collectedFingerprint;
  const outItems = pruneBlocked ? (prev.items || []) : newItems;
  const fetchedAt = new Date().toISOString();
  writeManifest(sourceId, {
    sourceId,
    fetchedAt,
    fingerprint,
    items: outItems,
    ...(pruneBlocked ? { preserved: true, preserveReason: 'collection-failed' } : {}),
    ...(truncation && truncation.dropped > 0
      ? { truncated: true, droppedCount: truncation.dropped, totalCandidates: truncation.total, maxPages: truncation.cap }
      : {}),
    ...(errors.length ? { errors } : {}),
  });
  markFetched(sourceId, fetchedAt);

  const summary = {
    sourceId,
    name: source.name,
    sourceType: source.type, // 不占用 done 事件的 type 字段（emitDone 会把 type 固定为 'done'）
    added,
    updated,
    unchanged,
    removed,
    errors: errors.length,
    errorList: errors,
    fingerprint,
    itemCount: outItems.length,
    truncated: !!(truncation && truncation.dropped > 0),
    preserved: pruneBlocked,
    droppedCount: truncation ? truncation.dropped : 0,
    totalCandidates: truncation ? truncation.total : outItems.length,
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
