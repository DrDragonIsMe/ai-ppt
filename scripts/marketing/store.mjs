// scripts/marketing/store.mjs — 营销大纲与批量任务的落盘存取层。
// 大纲 = marketing/outlines/<outlineId>.json（生成物，随 /marketing/ 一起被 gitignore）。
// 契约形状（跨 mission，不得改名）：
//   {id,title,createdAt,sourceIds,angleSet,product{name,audience,tone},
//    angles:[{key,title,thesis,audience,evidenceItemIds,slides:[{heading,lead,points,evidenceItemIds}],deckName}]}
// 批量任务记录 = marketing/batches/<batchId>.json（进度快照，供刷新页面后重建状态）。
import fs from 'node:fs';
import path from 'node:path';
import { isSafeName } from '../config.mjs';
import { writeJsonAtomic } from '../fs-utils.mjs';
import { outlinesDir, outlinePath, marketingRoot } from './paths.mjs';
import { getAngleSet, angleSetId, DEFAULT_ANGLE_SET } from './angles.mjs';

const OUTLINE_ID_RE = /^mo-[0-9a-z]+$/;
const BATCHES_DIR_NAME = 'batches';

/** 大纲 id：mo-<base36 时间戳>（与 fragments 的 f-<ts>-<rand> 同族写法）。 */
export function makeOutlineId(now = Date.now()) {
  return `mo-${now.toString(36)}`;
}

export function isSafeOutlineId(id) {
  return typeof id === 'string' && OUTLINE_ID_RE.test(id) && isSafeName(id);
}

function batchesDir() {
  return path.join(marketingRoot(), BATCHES_DIR_NAME);
}

// ---- 清洗与校验 ----

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** slug 化用于 deckName：保留字母数字与中文，其余折叠为 -。 */
export function slugify(text, maxLen = 24) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, maxLen) || 'deck';
}

/** deckName = mkt-<angleKey>-<slug>，且必须满足项目名校验（isSafeProjectName）。 */
export function makeDeckName(angleKey, productName, outlineId = '') {
  const key = slugify(angleKey || 'angle', 24);
  let name = `mkt-${key}-${slugify(productName || 'campaign')}`;
  if (!isSafeProjectNameLike(name)) {
    name = `mkt-${key}-${slugify(outlineId || 'draft')}`;
  }
  if (!isSafeProjectNameLike(name)) name = `mkt-${key}-deck`;
  return name;
}

// 项目名允许字母/数字/中文/下划线/中划线（与 config.mjs PROJECT_NAME_RE 对齐）
function isSafeProjectNameLike(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(name);
}

/**
 * 规整任意来源的大纲对象到契约形状（不做存在性校验，只做形状/类型）。
 * 缺失的角度字段按 angleSet 定义补齐，保证下游（批量生成、前端）永远读到完整字段。
 */
export function normalizeOutline(input, { id, sourceIds } = {}) {
  const setId = angleSetId(str(input?.angleSet) || DEFAULT_ANGLE_SET);
  const defs = getAngleSet(setId);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const product = {
    name: str(input?.product?.name) || str(input?.productName) || '未命名产品',
    audience: str(input?.product?.audience) || '企业决策者',
    tone: str(input?.product?.tone) || '专业、克制、以事实说服',
  };
  const createdAt = str(input?.createdAt) || new Date().toISOString();
  const resolvedSourceIds = strList(input?.sourceIds).length ? strList(input?.sourceIds) : strList(sourceIds);
  const outlineId = isSafeOutlineId(input?.id) ? input.id : (id || makeOutlineId());

  const angles = (Array.isArray(input?.angles) ? input.angles : []).map((raw, i) => {
    const key = str(raw?.key) || (defs[i] && defs[i].key) || `angle-${i + 1}`;
    const def = byKey.get(key);
    const slides = (Array.isArray(raw?.slides) ? raw.slides : []).map((s) => ({
      heading: str(s?.heading) || '未命名页',
      lead: str(s?.lead),
      points: strList(s?.points),
      evidenceItemIds: strList(s?.evidenceItemIds),
    }));
    return {
      key,
      title: str(raw?.title) || (def ? def.title : key),
      thesis: str(raw?.thesis) || (def ? def.thesis : ''),
      audience: str(raw?.audience) || product.audience,
      evidenceItemIds: strList(raw?.evidenceItemIds),
      slides,
      deckName: str(raw?.deckName) || makeDeckName(key, product.name, outlineId),
    };
  });

  return {
    id: outlineId,
    title: str(input?.title) || `${product.name} · 营销大纲`,
    createdAt,
    updatedAt: str(input?.updatedAt) || null,
    sourceIds: resolvedSourceIds,
    angleSet: setId,
    product,
    angles,
    // 取材真实状况（不得静默：降级/截断/过期素材都记在这里，随事件透出给用户）
    warnings: strList(input?.warnings),
    material: input?.material && typeof input.material === 'object' ? input.material : null,
    status: str(input?.status) || 'ready',
  };
}

// itemId 真实形状：<sourceId>--<12 hex>（scripts/sources/store.mjs makeItemId）。
// 契约示意的 it-xxx 不是真实形状，校验按真实形状来。
const ITEM_ID_RE = /^[A-Za-z0-9_\u4e00-\u9fa5.-]+--[0-9a-f]{12}$/;
export function looksLikeItemId(id) {
  return typeof id === 'string' && ITEM_ID_RE.test(id);
}

/**
 * 防编造校验：把不存在于素材库的 evidenceItemIds 剔除并计数。
 * @param {object} outline normalizeOutline 产物
 * @param {{knownItemIds?:Set<string>|string[]}} ctx
 * @returns {{outline:object, dropped:number, droppedIds:string[]}}
 */
export function enforceEvidenceIntegrity(outline, ctx = {}) {
  const known = ctx.knownItemIds instanceof Set ? ctx.knownItemIds : new Set(ctx.knownItemIds || []);
  const droppedIds = [];
  const filterList = (list) => (Array.isArray(list) ? list : [])
    .filter((id) => {
      if (known.has(id)) return true;
      droppedIds.push(id);
      return false;
    });
  const next = {
    ...outline,
    angles: outline.angles.map((a) => ({
      ...a,
      evidenceItemIds: filterList(a.evidenceItemIds),
      slides: a.slides.map((s) => ({ ...s, evidenceItemIds: filterList(s.evidenceItemIds) })),
    })),
  };
  return { outline: next, dropped: droppedIds.length, droppedIds };
}

/** 形状硬校验：角度数量、slide 形状、deckName 合法性。返回问题列表（空 = 通过）。 */
export function validateOutline(outline) {
  const errors = [];
  if (!isSafeOutlineId(outline.id)) errors.push(`非法大纲 id：${outline.id}`);
  if (!str(outline.title)) errors.push('缺少 title');
  if (!Array.isArray(outline.angles) || outline.angles.length === 0) errors.push('缺少 angles');
  const minAngles = Math.min(3, getAngleSet(outline.angleSet).length);
  if (Array.isArray(outline.angles) && outline.angles.length < minAngles) {
    errors.push(`角度数量不足：${outline.angles.length} < ${minAngles}`);
  }
  const seenKeys = new Set();
  const seenDeckNames = new Set();
  const seenTheses = new Set();
  for (const a of outline.angles || []) {
    if (!str(a.key)) errors.push('角度缺少 key');
    if (seenKeys.has(a.key)) errors.push(`角度 key 重复：${a.key}`);
    seenKeys.add(a.key);
    if (!str(a.thesis)) errors.push(`角度 ${a.key} 缺少 thesis`);
    else {
      const norm = a.thesis.replace(/\s+/g, '');
      if (seenTheses.has(norm)) errors.push(`角度 ${a.key} 的 thesis 与其他角度重复（角度必须互不重复）`);
      seenTheses.add(norm);
    }
    if (!isSafeProjectNameLike(a.deckName)) errors.push(`角度 ${a.key} 的 deckName 非法：${a.deckName}`);
    if (seenDeckNames.has(a.deckName)) errors.push(`deckName 重复：${a.deckName}`);
    seenDeckNames.add(a.deckName);
    if (!Array.isArray(a.slides) || a.slides.length === 0) {
      errors.push(`角度 ${a.key} 缺少 slides`);
      continue;
    }
    for (const [i, s] of a.slides.entries()) {
      if (!str(s.heading)) errors.push(`角度 ${a.key} 第 ${i + 1} 页缺少 heading`);
      if (!Array.isArray(s.points)) errors.push(`角度 ${a.key} 第 ${i + 1} 页 points 必须为数组`);
    }
  }
  return errors;
}

// ---- CRUD ----

export function listOutlines() {
  let entries;
  try {
    entries = fs.readdirSync(outlinesDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const id = e.name.slice(0, -'.json'.length);
    if (!isSafeOutlineId(id)) continue;
    const o = getOutline(id);
    if (o) {
      out.push({
        id: o.id,
        title: o.title,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        angleSet: o.angleSet,
        product: o.product,
        sourceIds: o.sourceIds,
        angleCount: (o.angles || []).length,
        angleKeys: (o.angles || []).map((a) => a.key),
        status: o.status,
        warningCount: (o.warnings || []).length,
      });
    }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

export function getOutline(id) {
  if (!isSafeOutlineId(id)) return null;
  let raw;
  try {
    raw = fs.readFileSync(outlinePath(id), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeOutline(parsed, { id });
  } catch {
    return null;
  }
}

export function saveOutline(outline) {
  const next = normalizeOutline(outline);
  writeJsonAtomic(outlinePath(next.id), next);
  return next;
}

/**
 * 局部更新（PUT 语义）：允许改 title / product / angles（整份替换角度数组）/ status。
 * 更新后重新做形状校验，非法直接抛错由路由映射 400。
 */
export function updateOutline(id, patch) {
  const existing = getOutline(id);
  if (!existing) return null;
  const merged = normalizeOutline({
    ...existing,
    title: patch?.title !== undefined ? str(patch.title) : existing.title,
    status: patch?.status !== undefined ? str(patch.status) : existing.status,
    product: patch?.product ? { ...existing.product, ...patch.product } : existing.product,
    angles: Array.isArray(patch?.angles) ? patch.angles : existing.angles,
  }, { id });
  merged.id = id;
  merged.createdAt = existing.createdAt;
  merged.updatedAt = new Date().toISOString();
  // deckName 缺失/非法时按 id 重新推导，保证批量生成有稳定项目名
  for (const a of merged.angles) {
    if (!isSafeProjectNameLike(a.deckName)) a.deckName = makeDeckName(a.key, merged.product.name, id);
  }
  const errors = validateOutline(merged);
  if (errors.length) {
    const err = new Error(errors[0]);
    err.statusCode = 400;
    err.errors = errors;
    throw err;
  }
  writeJsonAtomic(outlinePath(id), merged);
  return merged;
}

export function deleteOutline(id) {
  if (!isSafeOutlineId(id)) return false;
  try {
    fs.rmSync(outlinePath(id), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---- 批量任务记录（进度可观测，重启后仍能列出历史） ----

export function makeBatchId(now = Date.now()) {
  return `mb-${now.toString(36)}`;
}

export function isSafeBatchId(id) {
  return typeof id === 'string' && /^mb-[0-9a-z]+$/.test(id) && isSafeName(id);
}

function batchPath(batchId) {
  return path.join(batchesDir(), `${batchId}.json`);
}

export function createBatchRecord({ batchId, outlineId, outlineTitle, angleKeys, deckNames, overwrite }) {
  const id = isSafeBatchId(batchId) ? batchId : makeBatchId();
  const rec = {
    id,
    outlineId,
    outlineTitle: str(outlineTitle),
    angleKeys: strList(angleKeys),
    deckNames: strList(deckNames),
    total: strList(angleKeys).length,
    overwrite: !!overwrite,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    rows: strList(angleKeys).map((key, i) => ({
      deckName: (strList(deckNames)[i] || `mkt-${slugify(key)}`),
      index: i,
      status: 'pending',
      message: '',
    })),
  };
  writeJsonAtomic(batchPath(id), rec);
  return rec;
}

export function readBatchRecord(batchId) {
  if (!isSafeBatchId(batchId)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(batchPath(batchId), 'utf8'));
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

export function updateBatchRecord(batchId, patch) {
  const rec = readBatchRecord(batchId);
  if (!rec) return null;
  const next = { ...rec, ...patch };
  writeJsonAtomic(batchPath(batchId), next);
  return next;
}

export function listBatchRecords(limit = 50) {
  let entries;
  try {
    entries = fs.readdirSync(batchesDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const id = e.name.slice(0, -'.json'.length);
    if (!isSafeBatchId(id)) continue;
    const r = readBatchRecord(id);
    if (r) out.push(r);
  }
  out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return Number.isFinite(limit) && limit > 0 ? out.slice(0, limit) : out;
}

export { outlinesDir, marketingRoot };
