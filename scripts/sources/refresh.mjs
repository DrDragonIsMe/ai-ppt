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
import { sourceItemsDir, sourceManifestPath } from './paths.mjs';
import { writeJsonAtomic } from '../fs-utils.mjs';
import { getSource, validateSource, markFetched, requireFiniteOption, assertDirSourceAuthorized } from './registry.mjs';
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

// P2-G：判定一条采集错误是否属于「上游确认删除」——HTTP 404/410，或文件系统 ENOENT。
// 这类 origin 应正常 prune（缓存要能减）；其余 5xx / 401 / 403 / 429 / 超时 / 网络错误 / 瞬时不可读(如 EACCES)
// 都视为「未确认失败」，按 origin 保命标 stale——绝不能用「拿不到」冒充「不存在」把已上线内容误删。
// P2-②（r5）：目录级 readdir 失败（isDirectoryLevel）一律不算「确认删除」——它只代表「这一次 readdir 的返回码」，
// 而非「确认整棵子树上游已删」。移动盘/NAS 中途弹出、挂载点未就绪、TOCTOU 都会让子目录 readdir 返 ENOENT，
// 但磁盘上该子树依然存在；把它当 confirmed-gone 会静默物理删除整棵子树（实测 prev=8 → removed=3）。
// 故目录级错误归「未确认」→ 走 erroredPrefixes 让子树 stale 保命，下轮成功即以同 id 覆盖，代价只是缓存晚一轮收敛。
// 文件级 ENOENT（origin 是具体文件、非目录）仍属确证删除，照常清理。
function isConfirmedGone(entry) {
  if (entry.isDirectoryLevel) return false;
  return entry.httpStatus === 404 || entry.httpStatus === 410 || entry.code === 'ENOENT';
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
  // P2-C ii：撤回授权——dir 源在 refresh 入口按当前 env 重查 ROOT 归属（含符号链接解析）。
  // 关掉 AI_PPT_ALLOW_EXTERNAL_SOURCES 后，已存在的外部目录源也会被拒（此前只挡新建/编辑）。
  assertDirSourceAuthorized(source);
  const maxBytesPerItem = requireFiniteOption(source, 'maxBytesPerItem');

  const collector = dispatch(source);
  const prev = readManifest(sourceId) || { items: [] };
  const prevById = new Map((prev.items || []).map((it) => [it.id, it]));

  const newItems = [];
  const newIds = new Set();
  const errors = [];
  const erroredOrigins = new Set(); // P1-A：本轮明确抓取/抽取失败的 origin 集合，用于部分失败时按 origin 保命
  const confirmedGoneOrigins = new Set(); // P2-G：本轮上游确认删除（404/410/ENOENT）的 origin → 正常 prune、绝不 stale
  let confirmedGoneCount = 0; // P2-G：确认删除的错误数——不计入降级阈值（它们恰恰证明上游真的没了）
  // P2-F：dir/vault 的目录级错误，其 origin 是被卡住的**目录**本身，而条目 origin 是该目录下的**文件路径**——
  // 单靠精确 origin 匹配必然对不上、把整棵子树当"上游确认删除"物理删光（评审活体复现 13→10、无任何保命信号）。
  // 故除精确 origin 外，再记录"失败目录前缀" erroredPrefixes，让该目录下的既有子树条目命中 stale 保命。
  // P2-②（r5）：目录级错误无论 EACCES 还是 ENOENT 都归"未确认"（isConfirmedGone 已对 isDirectoryLevel 短路），
  // 全部走 erroredPrefixes 子树保命；曾有"已删目录前缀 confirmedGonePrefixes → 子树正常清理"一条分支，因 ② 之后
  // 目录级错误永不再被确证删除（只剩文件级 ENOENT，其 origin 是文件、前缀必不命中他条目）而成死码，已移除。
  // 真正"目录被删"（父枚举里没有它 → 无 readdir 错误）由 prune 末尾"本轮没抓到也没报错 → 正常清理"兜底处理，
  // 故缓存仍能减（见 P2-F 对照用例 removed=3），不依赖已删分支。
  const isDirVault = source.type === 'dir' || source.type === 'vault';
  const erroredPrefixes = new Set();
  let added = 0; let updated = 0; let unchanged = 0;
  let truncation = null; // { collected, dropped, total, cap }
  let policySkip = null; // P2-E：{ skipped, samples[] }——被禁入/敏感清单跳过的条目（可观测）
  let lowRelevanceSkip = null; // B080800：{ skipped, samples[] }——被 collect-site 低相关过滤丢掉的页

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
      if (isConfirmedGone(entry)) {
        // P2-G：上游确认删除 → 记入 confirmedGone（正常 prune），不进 erroredOrigins（否则会被永久 stale 保命）。
        // P2-②：目录级错误已被 isConfirmedGone 短路（isDirectoryLevel），此处只剩 url/site 的 404/410 与
        // dir/vault 的文件级 ENOENT（origin 是具体文件），故只记精确 origin，不再建前缀。
        if (entry.origin) confirmedGoneOrigins.add(entry.origin);
        confirmedGoneCount++;
      } else if (entry.origin) {
        // P1-A：未确认失败（5xx/401/403/429/超时/网络/瞬时不可读）→ 按 origin 保命。
        erroredOrigins.add(entry.origin);
        if (isDirVault) erroredPrefixes.add(entry.origin + path.sep); // P2-F：目录暂时不可读 → 该子树条目一并保命
      }
      onEvent({ step: 'fetch-error', message: `抓取失败：${entry.origin || ''}`, detail: { origin: entry.origin, error: entry.error } });
      continue;
    }
    // P2-E：采集器因命中禁入/敏感清单跳过条目 → 显式上报，绝不静默吃掉（与 maxPages 截断同一套形状）。
    if (entry.kind === 'policy') {
      policySkip = {
        skipped: entry.skipped | 0,
        samples: Array.isArray(entry.samples) ? entry.samples.slice(0, 10) : [],
      };
      onEvent({
        step: 'policy-skipped',
        message: `素材源「${source.name}」有 ${entry.skipped} 个文件/目录命中禁入或敏感清单被跳过（未入库）`,
        detail: { policySkipped: entry.skipped, samples: policySkip.samples },
      });
      continue;
    }
    // 采集器在因 maxPages 截断 / 低相关过滤时补发 summary：转为明确告警事件 + 记入 manifest，供前端徽标提示
    if (entry.kind === 'summary') {
      truncation = {
        collected: entry.collected | 0,
        dropped: entry.dropped | 0,
        total: entry.total | 0,
        cap: Number.isFinite(entry.cap) ? entry.cap : null,
      };
      if (truncation.dropped > 0) {
        onEvent({
          step: 'truncated',
          message: `素材源「${source.name}」被 maxPages 截断：共 ${entry.total} 个候选，仅入库 ${entry.collected} 个，丢弃 ${entry.dropped} 个（上限 maxPages=${entry.cap}）`,
          detail: truncation,
        });
      }
      if (Number.isFinite(entry.lowRelevanceSkipped) && entry.lowRelevanceSkipped > 0) {
        lowRelevanceSkip = {
          skipped: entry.lowRelevanceSkipped | 0,
          samples: Array.isArray(entry.lowRelevanceSamples) ? entry.lowRelevanceSamples.slice(0, 10) : [],
        };
        onEvent({
          step: 'low-relevance-skipped',
          message: `素材源「${source.name}」跳过 ${entry.lowRelevanceSkipped} 个低相关页（登录墙/法务/404/营销页），未入库`,
          detail: { lowRelevanceSkipped: lowRelevanceSkip.skipped, samples: lowRelevanceSkip.samples },
        });
      }
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

  // 成功性闸门（P1-4 全失败 + P1-A 部分失败）：
  //  A) 整体失败：本轮 0 入库且既有语料存在，且有错误 / 或有低相关页被过滤 → 完全跳过 prune，保留全部 prev，发 'preserve' 事件（既有语义）。
  //     P1-2（B080800 返修）：site 源根页变成 200 登录墙被低相关过滤跳过时，既不产 error 也不入队子页，
  //     会造出「0 入库 / 0 错误」的新路径；必须把它与 errors>0 同等视为保命条件，否则会把既有语料物理删光。
  //  B) 部分失败：本轮成功若干 + 失败若干。prev 里本轮"没出现"的条目，只有当它**本轮明确失败**
  //     （origin ∈ erroredOrigins）或**整体降级**（errors 占比 > 0.5，兜底 origin 对不上的边角）时才保命，
  //     打 stale 标记保留、绝不 rm；其余才是真消失，正常清理。修的是"成功 1 条就让闸门整体失效、
  //     把 30 条因 503/限流失败的子页物理删光"（评审活体复现 31→1）。
  //  dir 源本地枚举不会"部分失败"（单文件损坏是 error 条目、按 origin 保命即可），语义天然正确。
  const prevItems = prev.items || [];
  const prevItemCount = prevItems.length;
  // 降级阈值只统计「未确认失败」：confirmed-gone（404/410/ENOENT）恰恰证明上游真没了，
  // 不该把它们计入 errors 而把整库推向保守保命。
  const uncertainErrors = errors.length - confirmedGoneCount;
  const lowRelevanceSkippedCount = lowRelevanceSkip ? lowRelevanceSkip.skipped : 0;
  // B091100：首轮采集即全部被低相关过滤（0 入库 / 0 既有 / 有低相关丢弃）时，不能静默 status:done。
  // 沿用已有 'degraded' 语义发 warning 事件，并在 manifest/summary 中如实体现。
  const allFiltered = newItems.length === 0 && prevItemCount === 0 && lowRelevanceSkippedCount > 0;
  if (allFiltered) {
    onEvent({
      step: 'degraded',
      message: `素材源「${source.name}」本轮采集全部被低相关过滤跳过（0 入库 / ${lowRelevanceSkippedCount} 个低相关页）`,
      detail: { keptStale: 0, removed: 0, errors: uncertainErrors, overallDegraded: false, reason: 'all-low-relevance' },
    });
  }
  // P1-①（r5 回归修复）：整源归零闸门必须只看「本轮有没有错误」，绝不能只看「未确认错误」。
  // 反例：site 源入口页单独 404（本轮 1 条 confirmed-gone 错误、0 入库），10 条子页本轮根本没被抓过、
  // 上游对它们没有任何"已删除"表态——若用 uncertainErrors>0 判定，闸门被免检放行，子页会落进 prune 末尾
  // "本轮没抓到也没报错 → 正常清理"兜底分支被物理删光（评审实测 prev=11 → removed=11）。
  // 因此"部分轮次逐条确认消失 → 该清"（走 1D：有成功入库、不进此闸门）与"整源 0 入库 → 保命"必须分开。
  // B080800-P1-2：低相关过滤导致 0 入库时，同样要把既有语料完整保命。
  const totalFailure = newItems.length === 0 && prevItemCount > 0 && (errors.length > 0 || lowRelevanceSkippedCount > 0);
  const overallDegraded = !totalFailure
    && prevItemCount > 0
    && uncertainErrors > 0
    && uncertainErrors / prevItemCount > 0.5;
  const pruneBlocked = totalFailure; // 保留既有变量名与 'preserve' 语义
  // P1-①.2：整源归零但本轮所有错误都是 confirmed-gone（上游对全部条目报告已消失，常见于入口页改版/404）——
  // 仍保命，但要与"抓取全失败(5xx/网络)"区分开，可观测地记 'all-confirmed-gone'。
  const allConfirmedGone = pruneBlocked && errors.length > 0 && errors.length === confirmedGoneCount;

  let removed = 0;
  let removedConfirmedGone = 0; // P1-①.3：因上游确认删除（url/site 404/410、dir/vault 文件级 ENOENT）而清理的条数
  let removedUnconfirmed = 0;   // P1-①.3：兜底分支清理（本轮没抓到也没报错，视为上游确认消失）的条数
  let stalePreserved = 0;
  const staleKeptItems = [];
  if (pruneBlocked) {
    let preserveMessage;
    let preserveDetail;
    if (allConfirmedGone) {
      preserveMessage = `素材源「${source.name}」上游本轮对全部 ${errors.length} 条抓取报告已消失（404/410/ENOENT），但 0 入库——已保留既有 ${prevItemCount} 条素材未清理（绝不用"整源归零"冒充"全部删除"；确需清理请显式重建源）`;
      preserveDetail = { keptItems: prevItemCount, errors: errors.length, confirmedGone: confirmedGoneCount, reason: 'all-confirmed-gone' };
    } else if (errors.length === 0 && lowRelevanceSkippedCount > 0) {
      preserveMessage = `素材源「${source.name}」本轮采集全部被低相关过滤跳过（0 入库 / ${lowRelevanceSkippedCount} 个低相关页），已跳过清理并保留既有 ${prevItemCount} 条素材`;
      preserveDetail = { keptItems: prevItemCount, lowRelevanceSkipped: lowRelevanceSkippedCount, reason: 'collection-failed' };
    } else {
      preserveMessage = `素材源「${source.name}」本轮采集失败（0 入库 / ${uncertainErrors} 未确认错误），已跳过清理并保留既有 ${prevItemCount} 条素材`;
      preserveDetail = { keptItems: prevItemCount, errors: uncertainErrors };
    }
    onEvent({ step: 'preserve', message: preserveMessage, detail: preserveDetail });
  } else {
    const itemsDir = sourceItemsDir(sourceId);
    const erroredPre = isDirVault ? [...erroredPrefixes] : []; // P2-F/②：dir/vault 失败目录前缀 → 子树 stale 保命
    for (const old of prevItems) {
      if (newIds.has(old.id)) continue; // 本轮已重新收录，正常
      const o = old.origin;
      const oStr = String(o || '');
      // P2-G：本轮上游确认删除（url/site 的 404/410，dir/vault 的文件级 ENOENT，均精确 origin 命中）
      // → 正常清理，即便整体降级也不 stale（缓存要能减）。P2-② 后目录级错误不再进入此集合。
      const gone = o != null && confirmedGoneOrigins.has(o);
      if (gone) {
        try { fs.rmSync(path.join(itemsDir, `${old.id}.md`), { force: true }); removed++; removedConfirmedGone++; } catch { /* 可能已不在 */ }
        continue;
      }
      // P1-A/P2-F/②：本轮明确失败（origin 命中，或 dir/vault 子树落在失败/中途消失的目录前缀下）或整体降级 → 标 stale 保命，绝不 rm。
      const covered = (o != null && erroredOrigins.has(o)) || erroredPre.some((pre) => oStr.startsWith(pre));
      if (covered || overallDegraded) {
        staleKeptItems.push({ ...old, stale: true });
        stalePreserved++;
        continue;
      }
      // 其余 = 本轮没抓到、也没报错（含"目录整体消失 → 父枚举不再列出它"）→ 正常清理。缓存能减由此分支保证。
      try {
        fs.rmSync(path.join(itemsDir, `${old.id}.md`), { force: true });
        removed++;
        removedUnconfirmed++;
      } catch { /* 文件可能已不在 */ }
    }
    // P1-①.3：prune 侧可观测性——只要发生清理就广播 'pruned'，让"语料被清理"在 SSE 流可见，
    // 并区分"上游确认删除"与"本轮没抓到"两类，杜绝静默清空。
    if (removed > 0) {
      onEvent({
        step: 'pruned',
        message: `素材源「${source.name}」清理 ${removed} 条未再收录的素材（上游确认消失 ${removedConfirmedGone}，本轮未抓到兜底清理 ${removedUnconfirmed}）`,
        detail: { removed, confirmedGone: removedConfirmedGone, unconfirmed: removedUnconfirmed },
      });
    }
    if (stalePreserved > 0) {
      onEvent({
        step: 'degraded',
        message: `素材源「${source.name}」本轮部分抓取失败：已保留 ${stalePreserved} 条未能确认的上游素材（标记 stale，未删除），另有 ${removed} 条确认消失被清理`,
        detail: { keptStale: stalePreserved, removed, errors: uncertainErrors, overallDegraded },
      });
    }
  }

  // 全失败保留 prev 原样（含其旧 stale）；部分失败则 newItems + 本轮保命的 stale 条目。
  const outItems = pruneBlocked ? prevItems : [...newItems, ...staleKeptItems];
  const fingerprint = pruneBlocked
    ? (prev.fingerprint || '')
    : sha256(outItems.map((i) => `${i.id}:${i.stale ? 'S' : ''}${i.hash}`).sort().join('\n'));
  const fetchedAt = new Date().toISOString();
  const degraded = stalePreserved > 0 || allFiltered;
  writeManifest(sourceId, {
    sourceId,
    fetchedAt,
    fingerprint,
    items: outItems,
    ...(pruneBlocked ? { preserved: allConfirmedGone ? 'all-confirmed-gone' : true, preserveReason: allConfirmedGone ? 'all-confirmed-gone' : 'collection-failed' } : {}),
    // P1-①.3：prune 侧可观测（加性字段，既有键不动）
    ...(removed > 0 ? { pruned: removed, prunedConfirmedGone: removedConfirmedGone, prunedUnconfirmed: removedUnconfirmed } : {}),
    // P1-A：部分失败保命的可观测标记（加性字段）
    ...(degraded ? { degraded: true, staleCount: stalePreserved } : {}),
    // P2-E：命中禁入/敏感清单被跳过的条目数（加性字段，形状对齐 droppedCount 徽标）
    ...(policySkip && policySkip.skipped > 0
      ? { policySkipped: policySkip.skipped, policySamples: policySkip.samples }
      : {}),
    // B080800：低相关页过滤丢弃数（加性字段，与 policySkipped 同口径）
    ...(lowRelevanceSkip && lowRelevanceSkip.skipped > 0
      ? { lowRelevanceSkipped: lowRelevanceSkip.skipped, lowRelevanceSamples: lowRelevanceSkip.samples }
      : {}),
    ...(truncation && truncation.dropped > 0
      ? { truncated: true, droppedCount: truncation.dropped, totalCandidates: truncation.total, maxPages: truncation.cap }
      : {}),
    ...(errors.length ? { errors } : {}),
  });
  // B080800：store.mjs 的 writeManifest 只持久化已知字段，低相关过滤的可观测字段需要显式补丁写入。
  if (lowRelevanceSkip && lowRelevanceSkip.skipped > 0) {
    const patched = readManifest(sourceId);
    if (patched) {
      patched.lowRelevanceSkipped = lowRelevanceSkip.skipped;
      patched.lowRelevanceSamples = lowRelevanceSkip.samples;
      writeJsonAtomic(sourceManifestPath(sourceId), patched);
    }
  }

  markFetched(sourceId, fetchedAt);

  const summary = {
    sourceId,
    name: source.name,
    sourceType: source.type, // 不占用 done 事件的 type 字段（emitDone 会把 type 固定为 'done'）
    added,
    updated,
    unchanged,
    removed,
    // P1-①.3：清理可观测（加性字段，removed/preserved 原键不改名不删除）
    pruned: removed,
    prunedConfirmedGone: removedConfirmedGone,
    prunedUnconfirmed: removedUnconfirmed,
    errors: errors.length,
    errorList: errors,
    fingerprint,
    itemCount: outItems.length,
    truncated: !!(truncation && truncation.dropped > 0),
    preserved: pruneBlocked,
    // P1-A / P2-E 可观测（加性字段，不动既有键）
    degraded,
    staleCount: stalePreserved,
    policySkipped: policySkip ? policySkip.skipped : 0,
    // B080800：低相关页过滤丢弃数（加性字段）
    lowRelevanceSkipped: lowRelevanceSkip ? lowRelevanceSkip.skipped : 0,
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
      // F050500-B：preview 是「试抓预览」，任何采集错误都按失败处理，不再返回带 origin 的部分结果，
      // 使 POST /api/sources/preview 的 500 体统一为 {error}。
      const err = new Error(entry.error || '试抓失败');
      err.statusCode = 500;
      throw err;
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
