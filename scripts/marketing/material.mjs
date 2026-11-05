// scripts/marketing/material.mjs — 多源素材汇总与「分档摘要」。
// 为什么不直接把全文塞进 prompt：素材库单个条目可到几十 KB，六个角度各塞一遍要么超窗要么被
// 简单截断（丢信息）。这里分两档：
//   第一档 digestItemForAngle：每个条目 × 每个角度做一次「角度相关句抽取」，得到该条目在该角度下的短摘要；
//   第二档 buildAngleMaterial：按角度把入选条目的短摘要拼成该角度的素材块（预算内、按相关度排序）。
// 全过程记账：语料总字数 / 实际进入 prompt 的字数 / 被降级、截断、过期素材的情况，一律如实上报。
import fs from 'node:fs';
import { listItems, readItem, readManifest } from '../sources/store.mjs';
import { cacheRoot } from '../sources/paths.mjs';
import { stripMarkdown } from '../generation-common.mjs';
import { isSafeName } from '../config.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 超过这个天数的素材语料视为「陈旧」，进 warnings 但不静默剔除（内容可能依然有效）。 */
export const STALE_CORPUS_AGE_DAYS = 30;

/** 句子切分：中英文句末标点 + 换行，保留分隔符便于回读原文顺序。 */
function splitSentences(text) {
  return String(text)
    .split(/(?<=[。！？!?；;\n])/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** 关键词命中次数（大小写无关）。 */
function keywordHits(sentence, keywords) {
  const low = String(sentence).toLowerCase();
  let hits = 0;
  for (const kw of keywords || []) {
    const k = String(kw || '').toLowerCase();
    if (!k) continue;
    let idx = low.indexOf(k);
    while (idx !== -1) {
      hits++;
      idx = low.indexOf(k, idx + k.length);
    }
  }
  return hits;
}

/**
 * 第一档摘要：把一个条目压成「该角度视角下值得看」的片段。
 * 策略：头部原文（保住定义/背景不失真）+ 角度关键词命中最高的若干句（按原文顺序还原）。
 * 一个关键词都没命中时退化为头部 + 前几句，保证角度永远有料可用，但 matched=false 供上层如实标注。
 */
export function digestItemForAngle(text, angle, { headChars = 220, maxChars = 700 } = {}) {
  const clean = stripMarkdown(String(text || '')).replace(/[ \t]*\n[ \t]*/g, '\n').trim();
  if (!clean) return { digest: '', score: 0, matched: false, chars: 0 };
  const head = clean.slice(0, headChars).replace(/\n+/g, ' ');
  const sentences = splitSentences(clean);
  const scored = sentences
    .map((s, i) => ({ s, i, hit: keywordHits(s, angle?.keywords) }))
    .filter((x) => x.hit > 0)
    .sort((a, b) => (b.hit - a.hit) || (a.i - b.i));
  const matched = scored.length > 0;
  const pickedRaw = matched ? scored.slice(0, 8) : sentences.slice(0, 4).map((s, i) => ({ s, i, hit: 0 }));
  const picked = pickedRaw.slice().sort((a, b) => a.i - b.i).map((x) => x.s.replace(/\n+/g, ' '));
  const body = [];
  for (const p of picked) {
    if (p === head || body.includes(p)) continue;
    body.push(p);
  }
  const digest = (body.length ? `${head}\n— ${body.join(' / ')}` : head).slice(0, maxChars);
  return { digest, score: scored.reduce((n, x) => n + x.hit, 0), matched, chars: digest.length };
}

/** 素材源降级/保命/截断信号 → 人类可读警告（不得静默当作新鲜内容）。 */
export function sourceWarnings(sourceId, manifest, { now = Date.now() } = {}) {
  const w = [];
  if (!manifest) {
    w.push(`素材源 ${sourceId} 没有抓取记录（尚未刷新或抓取失败），本轮未取材`);
    return w;
  }
  const name = manifest.sourceName || sourceId;
  if (manifest.preserved) {
    const reason = manifest.preserveReason === 'all-confirmed-gone'
      ? '上游报告条目已全部消失，已按保命策略保留上一轮语料'
      : '采集整体失败，已按保命策略保留上一轮语料';
    w.push(`素材源「${name}」处于保命状态（${reason}），自 ${manifest.fetchedAt || '未知时间'} 起未更新，本轮用的是上一轮旧素材`);
  }
  if (manifest.degraded) {
    w.push(`素材源「${name}」上一轮部分抓取失败（${manifest.staleCount || 0} 条标记 stale），内容可能不完整`);
  }
  if (manifest.truncated) {
    w.push(`素材源「${name}」受 maxPages 截断：入库 ${Array.isArray(manifest.items) ? manifest.items.length : 0} 条，另有 ${manifest.droppedCount || 0} 条未入库（候选 ${manifest.totalCandidates ?? '?'}，上限 ${manifest.maxPages ?? '?'}）`);
  }
  if (Number.isFinite(manifest.policySkipped) && manifest.policySkipped > 0) {
    w.push(`素材源「${name}」有 ${manifest.policySkipped} 个文件命中安全清单未纳入素材库`);
  }
  const fetchedMs = Date.parse(manifest.fetchedAt || '');
  if (Number.isFinite(fetchedMs) && now - fetchedMs > STALE_CORPUS_AGE_DAYS * DAY_MS) {
    const days = Math.round((now - fetchedMs) / DAY_MS);
    w.push(`素材源「${name}」自 ${manifest.fetchedAt} 起未更新（已过去 ${days} 天）`);
  }
  return w;
}

/**
 * 汇总多源素材。
 * @param {{sourceIds?:string[], includeStale?:boolean, maxItems?:number,
 *          listItemsFn?:Function, readItemFn?:Function, readManifestFn?:Function}} [opts]
 *   注入 *Fn 便于单测用假 store；默认走 scripts/sources/store.mjs 真实实现。
 * @returns {{items:Array, perSource:Array, warnings:string[], stats:object}}
 *   items: [{itemId, sourceId, title, origin, text, bytes, stale, fetchedAt}]
 */
export function collectMaterial(opts = {}) {
  const listFn = opts.listItemsFn || listItems;
  const readFn = opts.readItemFn || readItem;
  const manifestFn = opts.readManifestFn || readManifest;
  const includeStale = !!opts.includeStale;

  const all = listFn({});
  const wanted = Array.isArray(opts.sourceIds) && opts.sourceIds.length ? opts.sourceIds : null;
  const listed = wanted ? all.filter((it) => wanted.includes(it.sourceId)) : all;
  // 未指定源时也要覆盖「有 manifest 但零条目」的源，否则降级信号会被静默吞掉
  const sourceIds = wanted || Array.from(new Set([
    ...all.map((it) => it.sourceId),
    ...listManifestSourceIds(manifestFn),
  ]));

  const warnings = [];
  const perSource = [];
  const items = [];
  let staleSkipped = 0;

  for (const sid of sourceIds) {
    const manifest = manifestFn(sid);
    const srcWarnings = sourceWarnings(sid, manifest);
    const itemsOfSource = listed.filter((it) => it.sourceId === sid);
    if (wanted && !all.some((it) => it.sourceId === sid)) {
      srcWarnings.push(`素材源 ${sid} 在素材库里没有任何条目`);
    }
    warnings.push(...srcWarnings);
    let used = 0;
    let stale = 0;
    for (const it of itemsOfSource) {
      if (it.stale && !includeStale) { stale++; staleSkipped++; continue; }
      const full = readFn(it.id) || {};
      const text = full.content || '';
      items.push({
        itemId: it.id,
        sourceId: sid,
        title: it.title || full.frontMatter?.title || it.id,
        origin: it.origin || full.frontMatter?.origin || '',
        text,
        bytes: it.bytes ?? Buffer.byteLength(text, 'utf8'),
        stale: !!it.stale,
        fetchedAt: full.frontMatter?.fetched_at || (manifest && manifest.fetchedAt) || null,
      });
      used++;
    }
    perSource.push({
      sourceId: sid,
      itemCount: used,
      staleSkipped: stale,
      preserved: !!(manifest && manifest.preserved),
      preserveReason: (manifest && manifest.preserveReason) || null,
      degraded: !!(manifest && manifest.degraded),
      manifestStaleCount: manifest && Number.isFinite(manifest.staleCount) ? manifest.staleCount : 0,
      truncated: !!(manifest && manifest.truncated),
      droppedCount: manifest && Number.isFinite(manifest.droppedCount) ? manifest.droppedCount : 0,
      totalCandidates: manifest && Number.isFinite(manifest.totalCandidates) ? manifest.totalCandidates : null,
      maxPages: manifest && Number.isFinite(manifest.maxPages) ? manifest.maxPages : null,
      policySkipped: manifest && Number.isFinite(manifest.policySkipped) ? manifest.policySkipped : 0,
      fetchedAt: (manifest && manifest.fetchedAt) || null,
    });
  }

  const limited = Number.isFinite(opts.maxItems) && opts.maxItems > 0 ? items.slice(0, opts.maxItems) : items;
  const droppedByCap = items.length - limited.length;
  if (droppedByCap > 0) {
    warnings.push(`素材条目过多，本轮取材只用前 ${limited.length} 条（另有 ${droppedByCap} 条未参与），可缩小素材源范围后重跑`);
  }

  return {
    items: limited,
    perSource,
    warnings,
    stats: {
      itemCount: limited.length,
      staleSkipped,
      includeStale,
      corpusChars: limited.reduce((n, it) => n + it.text.length, 0),
      droppedByCap,
    },
  };
}

// 缓存根下所有有 manifest 的源 id（用于覆盖「零条目但有降级记录」的源）。
// 注入自定义 manifestFn 时（假 store）不再触碰真实文件系统。
function listManifestSourceIds(manifestFn) {
  if (manifestFn !== readManifest) return [];
  let entries;
  try {
    entries = fs.readdirSync(cacheRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isSafeName(e.name))
    .map((e) => e.name)
    .filter((id) => !!manifestFn(id));
}

/**
 * 跨角度分配素材：相关度优先 + 「别的角度用过多少」次级排序，保证
 *   (1) 每个角度都分到素材（不出现空角度）；
 *   (2) 素材够分时不同角度的 evidence 尽量不重叠（否则「不同角度」是假的）。
 * @returns {Map<string, Array<{item:object, digest:string, score:number, matched:boolean}>>}
 */
export function assignMaterial(angles, items, { perAngleItems = 6, digestOpts } = {}) {
  const scored = items.map((item) => ({
    item,
    per: new Map(angles.map((a) => [a.key, digestItemForAngle(item.text, a, digestOpts)])),
  }));
  const usage = new Map(); // itemId -> 已被前面几个角度选过
  const assignment = new Map();
  for (const angle of angles) {
    const rank = scored
      .map((row) => ({ row, p: row.per.get(angle.key) }))
      .filter((x) => x.p && x.p.digest)
      .sort((a, b) => (b.p.score - a.p.score)
        || ((usage.get(a.row.item.itemId) || 0) - (usage.get(b.row.item.itemId) || 0))
        || (b.row.item.text.length - a.row.item.text.length));
    const chosen = rank.slice(0, perAngleItems).map(({ row, p }) => {
      usage.set(row.item.itemId, (usage.get(row.item.itemId) || 0) + 1);
      return { item: row.item, ...p };
    });
    assignment.set(angle.key, chosen);
  }
  return assignment;
}

/** 第二档：把某角度的入选条目拼成素材块文本，并统计实际进入 prompt 的字数。 */
export function buildAngleMaterial(entries, { title = '', thesis = '', maxChars = 5200 } = {}) {
  const header = `【角度】${title}\n【本角度论点】${thesis}\n`;
  const parts = [];
  let used = 0;
  for (const e of entries || []) {
    const label = e.item?.title || e.title || '';
    // 素材块里的引用编号必须与提示词要求一致（缺 alias 时才退回真实 itemId）
    const idTag = e.alias || e.item?.itemId || e.itemId || '';
    const block = `· [${idTag}] ${label}\n${e.digest || ''}`;
    if (header.length + used + block.length + 2 > maxChars) continue;
    parts.push(block);
    used += block.length + 2;
  }
  return {
    content: header + parts.join('\n\n'),
    materialChars: used,
    includedItems: parts.length,
    totalItems: (entries || []).length,
  };
}
