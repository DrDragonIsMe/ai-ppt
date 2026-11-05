// scripts/sources/registry.mjs — 素材源注册表：sources.json 的读写与条目校验。
// 契约：仓库根 sources.json（已 gitignore）= {version:1, sources:[Source]}。
// Source: {id,type,name,target,enabled,tags,lastFetchedAt,options}
//   type ∈ dir|url|site|vault
//   id   = src-<slug>（文件系统/URL 安全，供缓存目录名直接使用）
//   options: {include,maxPages,maxBytesPerItem,depth,label?}
// 默认值单一落地：validateSource 在写出时把 OPTION_RANGES.default **物化**进 options，
//   故下游（采集器/refresh）永远读到真实数字，不再各自持隐式默认；缺值即视为 bug（采集器抛错）。
//   语义选定：maxPages 对 dir/site/vault 统一默认 30、上限 500（有界 + 已被 truncated 上报可观测 + 用户可调），
//   优于「无上限静默遍历」；url 单页不受该上限影响。depth 仅 site 用，默认 1。
// 写盘统一走 fs-utils 的 writeJsonAtomic；非法 id/target → SourceError(statusCode=400)，
// 更新/删除不存在的 id → statusCode=404。
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../fs-utils.mjs';
import { isSafeName } from '../config.mjs';
import { ROOT, sourcesFile, isWithinRoot } from './paths.mjs';

export const SOURCE_TYPES = ['dir', 'url', 'site', 'vault'];

// 数值型 option 的唯一权威定义：min/max 供校验、default 供物化写入 options。
export const OPTION_RANGES = {
  maxPages: { min: 1, max: 500, default: 30 },
  maxBytesPerItem: { min: 1024, max: 10 * 1024 * 1024, default: 524288 },
  depth: { min: 0, max: 5, default: 1 },
};

// dir 源默认只收文本类；其余类型忽略 include。
export const DEFAULT_DIR_INCLUDE = [
  '**/*.md', '**/*.markdown', '**/*.txt', '**/*.html', '**/*.htm',
  '**/*.csv', '**/*.json', '**/*.docx', '**/*.pdf',
];

const ID_RE = /^src-[a-z0-9][a-z0-9-]*$/;
const NAME_MAX = 120;

export class SourceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'SourceError';
    this.statusCode = statusCode;
  }
}

function hasControlOrNul(s) {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(s);
}

// 把展示名转成 id slug；无 ASCII 可用时退化为随机段。CJK 名会被转空 → 走随机。
export function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base;
}

function randomSeg(len = 4) {
  return Math.random().toString(36).slice(2, 2 + len) || '0';
}

// 生成与现有 id 不冲突的 src-<slug>
export function makeId(type, name, takenIds) {
  const core = slugify(name) || `${(type || 'src')[0]}${randomSeg(6)}`;
  let id = `src-${core}`;
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds || []);
  let n = 2;
  while (taken.has(id)) id = `src-${core}-${n++}`;
  return id;
}

function clampNumber(label, value, range) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new SourceError(`options.${label} 必须是整数`);
  }
  if (n < range.min || n > range.max) {
    throw new SourceError(`options.${label} 超出范围 [${range.min}, ${range.max}]`);
  }
  return n;
}

/**
 * 采集器/refresh 读取「必需」数值 option 的唯一入口。
 * 默认值已由 validateSource 物化进 options；此处若读到缺失/非有限值即为上游 bug，
 * 直接抛错（绝不在此再放第二个隐式默认），以便尽早暴露而非静默改变抓取规模。
 */
export function requireFiniteOption(source, key) {
  const v = source?.options?.[key];
  if (!Number.isFinite(v)) {
    const e = new Error(`options.${key} 缺失或非有限值（应由 registry 物化默认值）：${String(v)}`);
    e.statusCode = 500;
    throw e;
  }
  return v;
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null || tags === '') return [];
  if (!Array.isArray(tags)) throw new SourceError('tags 必须是数组');
  return tags
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 50);
}

function normalizeOptions(type, rawOptions) {
  const opts = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
    ? { ...rawOptions }
    : {};
  const out = {};
  if (opts.include !== undefined) {
    if (!Array.isArray(opts.include) || opts.include.some((g) => typeof g !== 'string')) {
      throw new SourceError('options.include 必须是字符串数组');
    }
    out.include = opts.include.map((g) => g.trim()).filter(Boolean);
  } else if (type === 'dir') {
    out.include = [...DEFAULT_DIR_INCLUDE];
  } else if (type === 'vault') {
    out.include = ['**/*.md'];
  }
  // 数值型 options 一律物化：未显式提供则写入 OPTION_RANGES 声明的 default，
  // 让下游（采集器/refresh）永远拿到一个真实数字，采集器不再各自持有隐式默认值。
  out.maxPages = opts.maxPages !== undefined ? clampNumber('maxPages', opts.maxPages, OPTION_RANGES.maxPages) : OPTION_RANGES.maxPages.default;
  out.maxBytesPerItem = opts.maxBytesPerItem !== undefined ? clampNumber('maxBytesPerItem', opts.maxBytesPerItem, OPTION_RANGES.maxBytesPerItem) : OPTION_RANGES.maxBytesPerItem.default;
  out.depth = opts.depth !== undefined ? clampNumber('depth', opts.depth, OPTION_RANGES.depth) : OPTION_RANGES.depth.default;
  if (typeof opts.label === 'string' && opts.label.trim()) out.label = opts.label.trim().slice(0, 200);
  if (opts.anyOfTags !== undefined) {
    if (!Array.isArray(opts.anyOfTags) || opts.anyOfTags.some((t) => typeof t !== 'string')) {
      throw new SourceError('options.anyOfTags 必须是字符串数组');
    }
    out.anyOfTags = opts.anyOfTags.map((t) => t.trim()).filter(Boolean);
  }
  return out;
}

// 校验/归一 dir target：允许仓库内相对路径或用户显式配置的绝对路径；拒绝 ../ 越界与控制字符。
function normalizeDirTarget(target) {
  const t = String(target).trim();
  if (!t) throw new SourceError('dir 源的 target 不能为空');
  if (hasControlOrNul(t)) throw new SourceError('dir 源的 target 含非法字符');
  if (path.isAbsolute(t)) return path.normalize(t);
  // 相对路径：必须仍落在 ROOT 内
  const resolved = path.resolve(ROOT, t);
  if (!isWithinRoot(ROOT, resolved)) {
    throw new SourceError('dir 源相对路径越出仓库根，禁止');
  }
  return resolved;
}

function normalizeUrlTarget(type, target) {
  const t = String(target).trim();
  let parsed;
  try {
    parsed = new URL(t);
  } catch {
    throw new SourceError(`${type} 源的 target 必须是合法的 http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SourceError(`${type} 源仅支持 http(s) 链接`);
  }
  return parsed.href;
}

// 校验/归一 vault target：可选子目录，仓库内 vault/ 下相对路径，拒绝越界。
function normalizeVaultTarget(target) {
  if (target === undefined || target === null || String(target).trim() === '') return '';
  const t = String(target).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (hasControlOrNul(t)) throw new SourceError('vault 源的 target 含非法字符');
  if (path.isAbsolute(t)) throw new SourceError('vault 源 target 必须是 vault 目录下的相对子路径');
  const vaultDir = path.join(ROOT, 'vault');
  const resolved = path.resolve(vaultDir, t);
  if (!isWithinRoot(vaultDir, resolved)) {
    throw new SourceError('vault 源 target 越出 vault 目录，禁止');
  }
  return path.relative(vaultDir, resolved).split(path.sep).join('/');
}

/**
 * 校验并归一化一个源对象（不含 id 分配）。
 * @returns 规范化后的源（未写入 lastFetchedAt 时保留原值/空）
 */
export function validateSource(input, { id } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SourceError('源必须是一个对象');
  }
  const type = input.type;
  if (!SOURCE_TYPES.includes(type)) {
    throw new SourceError(`type 必须是 ${SOURCE_TYPES.join('|')} 之一`);
  }
  const name = String(input.name ?? '').trim();
  if (!name) throw new SourceError('name 不能为空');
  if (name.length > NAME_MAX) throw new SourceError(`name 过长（最多 ${NAME_MAX} 字符）`);

  const targetRaw = input.target ?? '';
  if (typeof targetRaw !== 'string') throw new SourceError('target 必须是字符串');
  let target;
  if (type === 'dir') target = normalizeDirTarget(targetRaw);
  else if (type === 'url' || type === 'site') target = normalizeUrlTarget(type, targetRaw);
  else target = normalizeVaultTarget(targetRaw);

  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  const tags = normalizeTags(input.tags);
  const options = normalizeOptions(type, input.options);

  let lastFetchedAt = null;
  if (input.lastFetchedAt) {
    const d = new Date(input.lastFetchedAt);
    lastFetchedAt = Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // id：显式提供则校验；否则留给调用方生成
  let finalId = id !== undefined ? id : input.id;
  if (finalId !== undefined && finalId !== null) {
    if (typeof finalId !== 'string' || !isSafeName(finalId) || !ID_RE.test(finalId)) {
      throw new SourceError(`非法源 id（须形如 src-<slug>）：${String(finalId)}`);
    }
  }

  return {
    ...(finalId ? { id: finalId } : {}),
    type,
    name,
    target,
    enabled,
    tags,
    lastFetchedAt,
    options,
  };
}

/** 读取整个注册表；文件缺失返回空表，损坏抛 SourceError(500)。 */
export function loadSources() {
  const file = sourcesFile();
  if (!fs.existsSync(file)) return { version: 1, sources: [] };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new SourceError(`读取 sources.json 失败：${err.message}`, 500);
  }
  if (!raw.trim()) return { version: 1, sources: [] };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new SourceError(`sources.json 不是合法 JSON：${err.message}`, 500);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.sources)) {
    throw new SourceError('sources.json 结构非法（缺 sources 数组）', 500);
  }
  return { version: data.version || 1, sources: data.sources };
}

/** 原子写盘整个注册表。 */
export function saveSources(data) {
  const payload = { version: data.version || 1, sources: Array.isArray(data.sources) ? data.sources : [] };
  writeJsonAtomic(sourcesFile(), payload);
  return payload;
}

/** 全部源（浅拷贝数组）。 */
export function listSources() {
  return loadSources().sources;
}

/** 按 id 取源，找不到返回 null。 */
export function getSource(id) {
  if (typeof id !== 'string' || !isSafeName(id)) return null;
  return loadSources().sources.find((s) => s.id === id) || null;
}

/**
 * 创建或更新一个源。
 * @param {object} input 源内容
 * @param {string|null} id 传入则为更新（PUT），不传则创建（POST，id 可来自 input 或自动生成）
 * @returns {source, isNew}
 */
export function upsertSource(input, id = null) {
  const data = loadSources();
  const taken = new Set(data.sources.map((s) => s.id));

  if (id !== null && id !== undefined) {
    if (!isSafeName(id) || !ID_RE.test(id)) throw new SourceError(`非法源 id：${String(id)}`);
    const idx = data.sources.findIndex((s) => s.id === id);
    if (idx === -1) throw new SourceError(`源不存在：${id}`, 404);
    const merged = validateSource({ ...data.sources[idx], ...input }, { id });
    data.sources[idx] = merged;
    saveSources(data);
    return { source: merged, isNew: false };
  }

  // 创建：显式 id（校验唯一）或自动生成
  const explicitId = input && input.id ? String(input.id) : null;
  let newId;
  if (explicitId) {
    if (!isSafeName(explicitId) || !ID_RE.test(explicitId)) throw new SourceError(`非法源 id：${explicitId}`);
    if (taken.has(explicitId)) throw new SourceError(`源 id 已存在：${explicitId}`);
    newId = explicitId;
  } else {
    newId = makeId(input?.type, input?.name, taken);
  }
  const source = validateSource(input, { id: newId });
  data.sources.push(source);
  saveSources(data);
  return { source, isNew: true };
}

/** 删除源；不存在返回 false。 */
export function removeSource(id) {
  if (typeof id !== 'string' || !isSafeName(id)) throw new SourceError(`非法源 id：${String(id)}`);
  const data = loadSources();
  const idx = data.sources.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  data.sources.splice(idx, 1);
  saveSources(data);
  return true;
}

/** 更新 lastFetchedAt 并返回新注册表（供 refresh 完成后回填）。 */
export function markFetched(id, isoTime) {
  const data = loadSources();
  const s = data.sources.find((x) => x.id === id);
  if (!s) return null;
  s.lastFetchedAt = isoTime || new Date().toISOString();
  saveSources(data);
  return s;
}
