#!/usr/bin/env node
// scripts/marketing/batch-generate.mjs — 按营销大纲批量生成 deck（契约 B030300）。
// 逐角度串行（LLM 并发 1）：拼该角度素材 → generation-common 的 buildSlidesPrompt/generateSlidesHtml
// → config.mjs 的 writeDeckIndex 落盘 → 写 sourceSelection(kind:'outline') → lintAfterGenerate → captureCover。
// 一个 deck 失败不阻断整批（失败记入汇总）；可取消（标记后不再开新 deck）；
// 已存在项目默认跳过，overwrite:true 才覆盖，且覆盖前 snapshotBeforeGenerate。
// CLI: node scripts/marketing/batch-generate.mjs <outlineId> [--angles k1,k2] [--batch-id mb-x]
//      [--overwrite] [--slides N] [--theme t] [--animation a]
// stdout 输出 NDJSON 事件（type: progress|step|deck|lint|error|done）。
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  writeDeckIndex, readConfig, writeConfig,
  assertSafeProjectName, projectExists,
} from '../config.mjs';
import {
  buildModelOptions, buildSlidesPrompt, generateSlidesHtml, formatUserEdits,
  buildFallbackSlides,
} from '../generation-common.mjs';
import { snapshotBeforeGenerate } from '../snapshot.mjs';
import { lintAfterGenerate } from '../design-lint.mjs';
import { captureCover } from '../deck-capture.mjs';
import { invalidateSearchIndex } from '../search.mjs';
import { readItem } from '../sources/store.mjs';
import { digestItemForAngle, buildAngleMaterial } from './material.mjs';
import { getOutline, createBatchRecord, updateBatchRecord } from './store.mjs';
import { marketingRoot } from './paths.mjs';
import { findAngle } from './angles.mjs';
import { makeEmitter, withHeartbeat } from './events.mjs';
import { llmReachable } from './llm.mjs';

const SLIDE_COUNT_DEFAULT = 8;
const SLIDE_COUNT_MIN = 4;
const SLIDE_COUNT_MAX = 15;

/**
 * 取消标记文件：路由侧 POST /api/marketing/batch/cancel 落盘，这里在 deck 边界与整批结束时轮询。
 * 运行期求值——marketing 根可被 AI_PPT_MARKETING_ROOT 覆盖（测试用临时目录）。
 */
export function cancelFlagFor(batchId) {
  const safe = String(batchId || '').replace(/[^a-z0-9-]/gi, '');
  return path.join(marketingRoot(), 'batches', `${safe}.cancel`);
}

export function isCancelled(batchId) {
  if (!batchId) return false;
  try {
    return fs.existsSync(cancelFlagFor(batchId));
  } catch {
    return false;
  }
}

/** 取该角度在大纲里引用到的素材（角度级 + 分页级并集）；读不到的逐条记为缺失。 */
export function loadAngleItems(angle, { readItemFn = readItem } = {}) {
  const ids = new Set([...(angle.evidenceItemIds || [])]);
  for (const s of angle.slides || []) for (const id of s.evidenceItemIds || []) ids.add(id);
  const items = [];
  const missing = [];
  for (const id of ids) {
    const full = readItemFn(id);
    if (!full || !full.content) { missing.push(id); continue; }
    items.push({ itemId: id, title: full.frontMatter?.title || id, text: full.content });
  }
  return { items, missing };
}

/** 把大纲页 + 素材拼成给 LLM 的素材块（分档摘要，不整篇截断），并给出引用编号对照。 */
export function buildDeckMaterial({ outline, angle, items, digestOpts, maxChars = 6000 }) {
  const angleDef = findAngle(outline.angleSet, angle.key) || angle;
  const entries = items.map((it, i) => ({
    item: it,
    alias: `it-${i}`,
    ...digestItemForAngle(it.text, angleDef, digestOpts),
  }));
  const built = buildAngleMaterial(entries, {
    title: angle.title,
    thesis: angle.thesis,
    maxChars,
  });
  // 大纲已定稿的页面结构是硬约束：单独列出，要求 LLM 逐页对应
  const aliasOf = new Map(items.map((it, i) => [it.itemId, `it-${i}`]));
  const plan = (angle.slides || []).map((s, i) => {
    const cited = (s.evidenceItemIds || []).map((id) => aliasOf.get(id) || id);
    return [
      `${i + 1}. ${s.heading}`,
      s.lead ? `   导语：${s.lead}` : '',
      (s.points || []).length ? `   要点：${s.points.join('；')}` : '',
      cited.length ? `   素材引用：${cited.join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');
  return {
    content: `${built.content}\n\n【大纲已定页面结构（必须逐页对应，顺序与页数保持一致）】\n${plan}`,
    materialChars: built.materialChars,
    includedItems: built.includedItems,
  };
}

/** deck 确定性兜底：直接用大纲页面结构渲染（无 LLM 也产出可用 deck）。 */
export function buildDeckFallback({ outline, angle }) {
  const sections = (angle.slides || []).map((s) => ({
    heading: s.heading,
    lead: s.lead || undefined,
    points: (s.points || []).slice(0, 4),
    note: s.evidenceItemIds?.length ? `素材引用 ${s.evidenceItemIds.length} 条` : undefined,
  }));
  return buildFallbackSlides({
    title: `${angle.title} · ${outline.product.name}`,
    subtitle: angle.thesis,
    closingTitle: '下一步',
    closingLead: '可从一个小范围试点开始，按阶段铺开。',
    sections,
  });
}

function deckPrompt({ outline, angle, material, slideCount, existingCfg }) {
  const otherAngles = (outline.angles || []).filter((a) => a.key !== angle.key).map((a) => a.title).join('、');
  return buildSlidesPrompt({
    task: `这是多角度营销 deck 中的「${angle.title}」角度，只讲这个角度的立场。`
      + `本角度既定论点：${angle.thesis}。`
      + `必须逐页对应素材块末尾给出的「大纲已定页面结构」，页数与顺序保持一致。`,
    title: `${angle.title} · ${outline.product.name}`,
    audience: angle.audience || outline.product.audience,
    style: `${outline.product.tone}｜营销提案`,
    language: 'zh-CN',
    slideCount,
    contentLabel: '本角度素材（已按角度压缩，引用编号形如 it-0）',
    content: material,
    extraRules: `- 角度立场不得漂移：这套 deck 另有 ${otherAngles || '（无其他角度）'} 等独立 deck，本次只服务「${angle.title}」。
- 素材里没有的数字、客户名、竞品对比一律不得出现。
`,
    userEditsSection: formatUserEdits(existingCfg || {}),
  });
}

/**
 * 批量生成。
 * @param {{outlineId?:string, outline?:object, angleKeys?:string[], overwrite?:boolean, batchId?:string,
 *          slidesPerDeck?:number, theme?:string, animation?:string, emitter?:object,
 *          deps?:{generateSlidesHtmlFn?:Function,captureCoverFn?:Function,lintFn?:Function,
 *                 readItemFn?:Function,writeDeckIndexFn?:Function,heartbeatMs?:number,
 *                 shouldCancel?:Function,digestOpts?:object,skipLint?:boolean,skipCover?:boolean,
 *                 modelOptions?:object,forceLlm?:boolean}}} [opts]
 * @returns {Promise<{outline:object, summary:object}>}
 */
export async function batchGenerate(opts = {}) {
  const emitter = opts.emitter || makeEmitter();
  const deps = opts.deps || {};
  const doGenerate = deps.generateSlidesHtmlFn || generateSlidesHtml;
  const doLint = deps.lintFn || lintAfterGenerate;
  const doCover = deps.captureCoverFn || captureCover;
  const doReadItem = deps.readItemFn || readItem;
  const doWriteDeck = deps.writeDeckIndexFn || writeDeckIndex;
  const cancelled = deps.shouldCancel || (() => isCancelled(opts.batchId));

  const outline = opts.outline || deps.outline || getOutline(opts.outlineId);
  if (!outline) {
    const err = new Error(`大纲不存在：${opts.outlineId}`);
    err.code = 'OUTLINE_NOT_FOUND';
    throw err;
  }
  const wanted = Array.isArray(opts.angleKeys) && opts.angleKeys.length
    ? opts.angleKeys.map((k) => outline.angles.find((a) => a.key === k)).filter(Boolean)
    : outline.angles.slice();
  if (!wanted.length) {
    const err = new Error('没有匹配到要生成的角度（angleKeys 与大纲不符）');
    err.code = 'NO_ANGLES';
    throw err;
  }

  const total = wanted.length;
  const slideCount = Math.min(
    Math.max(Number(opts.slidesPerDeck) || SLIDE_COUNT_DEFAULT, SLIDE_COUNT_MIN),
    SLIDE_COUNT_MAX,
  );
  const theme = opts.theme || 'web-ui';
  const animation = opts.animation || 'slide';
  const modelOptions = deps.modelOptions ?? buildModelOptions();
  // 可达性判定见 llm.mjs：buildModelOptions 的默认 baseUrl/provider 会让旧写法恒真，等于没开关
  const llmUsable = llmReachable(modelOptions, { explicitSkip: deps.skipLlm === true });

  // index 稳定且从 0 连续（M11 前端以 index 作进度表主键）
  const rows = wanted.map((a, index) => ({
    deckName: a.deckName, index, angleKey: a.key, status: 'pending', message: '',
  }));

  emitter.progress('start', `开始批量生成 ${total} 份营销 deck`, {
    batchId: opts.batchId || null, outlineId: outline.id, total,
    deckNames: wanted.map((a) => a.deckName),
  });

  let wasCancelled = false;
  for (const [index, angle] of wanted.entries()) {
    const row = rows[index];
    if (wasCancelled || cancelled()) {
      wasCancelled = true;
      row.status = 'cancelled';
      row.message = '批次已取消，未开始';
      emitter.emit('deck', { deckName: row.deckName, index, total, status: 'cancelled', message: row.message, angleKey: angle.key });
      continue;
    }

    // 已存在且不覆盖 → 跳过（快照只发生在真正要覆盖时）
    if (projectExists(angle.deckName) && !opts.overwrite) {
      row.status = 'skipped';
      row.message = `项目已存在，需 overwrite:true 才会覆盖`;
      emitter.emit('deck', { deckName: row.deckName, index, total, status: 'skipped', message: row.message, angleKey: angle.key });
      continue;
    }

    row.status = 'running';
    emitter.emit('deck', {
      deckName: row.deckName, index, total, status: 'running', angleKey: angle.key, outlineId: outline.id,
      message: `开始生成 ${index + 1}/${total}：${angle.title}`,
    });

    try {
      assertSafeProjectName(angle.deckName);
      const { items, missing } = loadAngleItems(angle, { readItemFn: doReadItem });
      if (!items.length) {
        throw new Error(`该角度引用的素材在素材库里已全部不可读（${missing.length} 条缺失），请重新生成大纲`);
      }
      const material = buildDeckMaterial({ outline, angle, items, digestOpts: deps.digestOpts });

      const existingCfg = projectExists(angle.deckName) ? readConfig(angle.deckName) : null;
      const prompt = deckPrompt({ outline, angle, material: material.content, slideCount, existingCfg });

      let slidesHtml;
      if (llmUsable || deps.forceLlm) {
        const { result } = await withHeartbeat(emitter, async () => doGenerate({
          prompt,
          modelOptions,
          minSections: Math.min(3, (angle.slides || []).length || 3),
          buildFallback: () => buildDeckFallback({ outline, angle }),
        }), {
          message: `deck ${index + 1}/${total}「${angle.title}」生成中`,
          everyMs: deps.heartbeatMs,
          deckName: row.deckName,
          index,
          total,
          angleKey: angle.key,
        });
        slidesHtml = result;
      } else {
        emitter.progress('llm', `未配置 LLM：deck「${angle.title}」用大纲直排兜底模板`, { deckName: row.deckName, index, total });
        slidesHtml = buildDeckFallback({ outline, angle });
      }
      if (!slidesHtml || slidesHtml.length < 200) throw new Error('幻灯片 HTML 产出为空');

      snapshotBeforeGenerate(angle.deckName, '营销批量生成覆盖前');
      const title = `${angle.title} · ${outline.product.name}`;
      doWriteDeck(angle.deckName, slidesHtml, { title, bodyClass: `theme-${theme} anim-${animation}` });

      // sourceSelection(kind:'outline') 接现有 PPT↔素材双向同步；userEdits 原样保留（契约要求）
      const prevCfg = existingCfg || {};
      const cfg = {
        ...prevCfg,
        name: angle.deckName,
        sourceType: 'marketing-outline',
        sourceUrl: '',
        sourceSelection: {
          kind: 'outline',
          outlineId: outline.id,
          angleKey: angle.key,
          sourceIds: outline.sourceIds || [],
        },
        articleText: material.content.slice(0, 20000),
        params: {
          ...(prevCfg.params || {}),
          title,
          audience: angle.audience || outline.product.audience,
          style: `${outline.product.tone}｜营销提案`,
          slideCount,
          language: 'zh-CN',
        },
        theme,
        animation,
        status: 'ready',
        lastGeneratedAt: new Date().toISOString(),
        errorMessage: null,
        marketing: {
          outlineId: outline.id,
          angleKey: angle.key,
          angleTitle: angle.title,
          thesis: angle.thesis,
          materialChars: material.materialChars,
          usedItems: items.length,
          missingEvidenceItemIds: missing,
        },
      };
      if (prevCfg.userEdits?.htmlSnapshot?.length) {
        cfg.userEdits = { ...prevCfg.userEdits, outlineId: outline.id, angleKey: angle.key };
      }
      writeConfig(angle.deckName, cfg);

      if (!deps.skipLint) {
        doLint(angle.deckName, (step, message, detail) => {
          emitter.emit('lint', { deckName: row.deckName, index, total, step, message, detail });
        });
      }
      if (missing.length) {
        emitter.progress('material-missing',
          `deck「${angle.title}」有 ${missing.length} 条大纲引用的素材已不可读，本 deck 未使用这些素材`,
          { deckName: row.deckName, index, total, missing: missing.slice(0, 20) });
      }
      try { invalidateSearchIndex(angle.deckName); } catch { /* 索引失败不影响 deck 产物 */ }
      if (!deps.skipCover) await doCover(angle.deckName);

      row.status = 'done';
      row.message = `已生成 ${angle.deckName}`;
      row.previewUrl = `/projects/${encodeURIComponent(angle.deckName)}/index.html`;
      emitter.emit('deck', {
        deckName: row.deckName, index, total, status: 'done', angleKey: angle.key,
        message: row.message,
        previewUrl: row.previewUrl,
        materialChars: material.materialChars,
        usedItems: items.length,
      });
    } catch (err) {
      // 单 deck 失败不阻断整批
      row.status = 'error';
      row.message = err.message || '生成失败';
      emitter.emit('deck', {
        deckName: row.deckName, index, total, status: 'error', angleKey: angle.key, message: row.message,
      });
    }
    if (cancelled()) wasCancelled = true;
  }

  const summary = {
    batchId: opts.batchId || null,
    outlineId: outline.id,
    outlineTitle: outline.title,
    total,
    doneCount: rows.filter((r) => r.status === 'done').length,
    skippedCount: rows.filter((r) => r.status === 'skipped').length,
    failedCount: rows.filter((r) => r.status === 'error').length,
    cancelledCount: rows.filter((r) => r.status === 'cancelled').length,
    wasCancelled,
    llmReachableFlag: llmUsable,
    rows,
    deckNames: rows.map((r) => r.deckName),
    projectDirs: rows.filter((r) => r.status === 'done').map((r) => `projects/${r.deckName}`),
    // 预览入口：已生成 deck 的可直接打开路径（M11 进度表用 rows[].deckName + 这个前缀拼链接）
    previewBase: '/projects/',
  };
  emitter.done({ ...summary });
  return { outline, summary };
}

// ---- CLI ----
async function runCli() {
  const emitter = makeEmitter();
  const argv = process.argv.slice(2);
  const outlineId = argv[0];
  if (!outlineId) {
    emitter.error('用法：node scripts/marketing/batch-generate.mjs <outlineId> [--angles k1,k2] [--batch-id mb-x] [--overwrite]');
    process.exitCode = 2;
    return;
  }
  const opts = { outlineId, angleKeys: [], overwrite: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--angles') opts.angleKeys = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--batch-id') opts.batchId = argv[++i];
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--slides') opts.slidesPerDeck = Number(argv[++i]);
    else if (a === '--theme') opts.theme = argv[++i];
    else if (a === '--animation') opts.animation = argv[++i];
  }
  // 批次记录落盘：开跑先写 running（进程被杀时留下可识别的 interrupted 记录），收尾写终态
  let record = null;
  try {
    const outline = getOutline(outlineId);
    if (outline && opts.batchId) {
      const keys = (opts.angleKeys.length
        ? outline.angles.filter((x) => opts.angleKeys.includes(x.key))
        : outline.angles).map((x) => x.key);
      const names = (opts.angleKeys.length
        ? outline.angles.filter((x) => opts.angleKeys.includes(x.key))
        : outline.angles).map((x) => x.deckName);
      record = createBatchRecord({
        batchId: opts.batchId, outlineId, outlineTitle: outline.title,
        angleKeys: keys, deckNames: names, overwrite: opts.overwrite,
      });
    }
  } catch { /* 记录失败不阻断生成 */ }
  try {
    const { summary } = await batchGenerate(opts);
    if (record) {
      updateBatchRecord(record.id, {
        status: summary.wasCancelled ? 'cancelled' : (summary.failedCount ? (summary.doneCount ? 'partial' : 'failed') : 'done'),
        finishedAt: new Date().toISOString(),
        rows: summary.rows,
        total: summary.total,
      });
    }
    if (summary.doneCount === 0 && summary.failedCount > 0) process.exitCode = 1;
  } catch (err) {
    if (record) {
      try {
        updateBatchRecord(record.id, { status: 'failed', finishedAt: new Date().toISOString(), error: err.message });
      } catch { /* 记录失败不掩盖原始错误 */ }
    }
    emitter.error(err.message || '批量生成失败', { code: err.code || null });
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) runCli();
