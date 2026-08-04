#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 循环依赖说明：link-resolver.mjs 也 import 本模块，双方模块顶层都不访问对方绑定，
// 仅在函数运行时通过 live binding 调用，因此静态循环 import 是安全的。
import { rebuildIndex } from './link-resolver.mjs';
import { parseFrontMatter, stringifyFrontMatter } from './front-matter.mjs';
import { writeFileAtomic, writeJsonAtomic } from './fs-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const VAULT_DIR = path.join(ROOT, 'vault');
const TOPICS_DIR = path.join(VAULT_DIR, 'topics');
const META_DIR = path.join(VAULT_DIR, '.meta');
const VAULT_INDEX = path.join(META_DIR, 'index.json');
// 旧索引位置（仓库根目录），仅用于一次性迁移
const LEGACY_VAULT_INDEX = path.join(ROOT, '.vault-index.json');
const ASSETS_DIR = path.join(VAULT_DIR, 'assets');
const FRAGMENTS_DIR = path.join(VAULT_DIR, 'fragments');
const CARDS_DIR = path.join(VAULT_DIR, 'knowledge-cards');
const REPORTS_DIR = path.join(VAULT_DIR, 'reports');
const SNAPSHOTS_VAULT_DIR = path.join(ROOT, '.snapshots', '_vault');

// 保留策略：.snapshots/_vault 最多保留最近 VAULT_BACKUP_KEEP 个笔记备份目录
const VAULT_BACKUP_KEEP = 200;

// 笔记列表自定义排序持久化（拖拽排序）：vault/.meta/note-order.json
const NOTE_ORDER_FILE = path.join(META_DIR, 'note-order.json');

// 笔记备份保留策略：备份目录按 ISO 时间戳命名（字典序=时间序），删除最旧的
export function pruneVaultBackups(keep = VAULT_BACKUP_KEEP) {
  if (!fs.existsSync(SNAPSHOTS_VAULT_DIR)) return 0;
  const ids = fs.readdirSync(SNAPSHOTS_VAULT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  let removed = 0;
  while (ids.length > keep) {
    const oldest = ids.shift();
    const target = path.join(SNAPSHOTS_VAULT_DIR, oldest);
    if (path.dirname(target) !== SNAPSHOTS_VAULT_DIR) break; // 防路径注入
    fs.rmSync(target, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

// 确保目录存在
function ensureVaultDirs() {
  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }
  if (!fs.existsSync(META_DIR)) {
    fs.mkdirSync(META_DIR, { recursive: true });
  }
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
  if (!fs.existsSync(TOPICS_DIR)) {
    fs.mkdirSync(TOPICS_DIR, { recursive: true });
  }
}

// 索引迁移：新路径不存在而旧的根目录索引存在时，复制后删除旧文件
function migrateIndexIfNeeded() {
  if (!fs.existsSync(VAULT_INDEX) && fs.existsSync(LEGACY_VAULT_INDEX)) {
    ensureVaultDirs();
    fs.copyFileSync(LEGACY_VAULT_INDEX, VAULT_INDEX);
    fs.unlinkSync(LEGACY_VAULT_INDEX);
  }
}

// 读取索引
function readIndex() {
  migrateIndexIfNeeded();
  if (!fs.existsSync(VAULT_INDEX)) {
    return { notes: {}, backlinks: {}, tags: {}, created: new Date().toISOString() };
  }
  try {
    const content = fs.readFileSync(VAULT_INDEX, 'utf8');
    return JSON.parse(content);
  } catch {
    return { notes: {}, backlinks: {}, tags: {}, created: new Date().toISOString() };
  }
}

// 写入索引
function writeIndex(index) {
  migrateIndexIfNeeded();
  ensureVaultDirs();
  index.updated = new Date().toISOString();
  writeJsonAtomic(VAULT_INDEX, index);
}

// 规范化笔记名（用于链接匹配）
// 支持专题路径："产品方法论/需求分析" → "产品方法论/需求分析"
function normalizeNoteName(name) {
  return name.trim().replace(/\.md$/i, '').toLowerCase();
}

// 判断笔记名是否包含专题路径
function hasTopicPath(name) {
  const clean = name.trim().replace(/\.md$/i, '');
  return clean.includes('/');
}

// 专题路径段安全校验：禁止 ..、空段、绝对路径、非法字符
function validateTopicSegments(segments) {
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) throw new Error('专题路径段不能为空');
    if (s === '..') throw new Error('专题路径不能包含 ..');
    if (/[\\:*?"<>|]/.test(s)) throw new Error(`专题路径段包含非法字符：${s}`);
  }
}

// 获取笔记文件路径
// - 平铺笔记："需求分析" → vault/需求分析.md
// - 专题笔记："产品方法论/需求分析" → vault/topics/产品方法论/需求分析.md
function getNotePath(name) {
  const cleanName = name.trim().replace(/\.md$/i, '');
  const baseName = cleanName + '.md';
  // 纵深防御：拒绝路径穿越
  if (baseName.includes('..') || path.isAbsolute(baseName)) {
    throw new Error(`非法笔记名称：${name}`);
  }
  if (cleanName.includes('/')) {
    const segments = cleanName.split('/');
    validateTopicSegments(segments);
    return path.join(TOPICS_DIR, ...segments) + '.md';
  }
  // 平铺笔记保留在 vault/ 根目录
  return path.join(VAULT_DIR, baseName);
}

// 列出所有笔记（平铺 + 专题递归）
function listNotes() {
  ensureVaultDirs();
  const notes = [];
  if (!fs.existsSync(VAULT_DIR)) return notes;

  // 平铺笔记
  for (const entry of fs.readdirSync(VAULT_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const notePath = path.join(VAULT_DIR, entry.name);
      const stat = fs.statSync(notePath);
      notes.push({
        name: entry.name.replace(/\.md$/, ''),
        fileName: entry.name,
        path: notePath,
        mtime: stat.mtime.toISOString(),
        size: stat.size,
      });
    }
  }

  // 专题目录递归
  function scanTopics(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanTopics(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const stat = fs.statSync(fullPath);
        const relativeName = prefix ? `${prefix}/${entry.name.replace(/\.md$/, '')}` : entry.name.replace(/\.md$/, '');
        notes.push({
          name: relativeName,
          fileName: entry.name,
          path: fullPath,
          topic: prefix || null,
          mtime: stat.mtime.toISOString(),
          size: stat.size,
        });
      }
    }
  }
  scanTopics(TOPICS_DIR, '');

  return notes.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

// 读取笔记内容
function readNote(name) {
  const notePath = getNotePath(name);
  if (!fs.existsSync(notePath)) return null;
  return fs.readFileSync(notePath, 'utf8');
}

// 写入笔记内容
function writeNote(name, content) {
  ensureVaultDirs();
  const notePath = getNotePath(name);
  writeFileAtomic(notePath, content);
  return notePath;
}

// 创建新笔记
// options.topic: 专题路径，如 "产品方法论"，笔记会落到 vault/topics/产品方法论/<name>.md
function createNote(name, content = '', { topic } = {}) {
  const fullName = topic ? `${topic}/${name}` : name;
  const notePath = getNotePath(fullName);
  if (fs.existsSync(notePath)) {
    throw new Error(`笔记 "${fullName}" 已存在`);
  }
  // 自动添加简单的Front Matter
  const displayTitle = name.includes('/') ? name.split('/').pop() : name;
  const finalContent = content.trim()
    ? content
    : `---
title: ${displayTitle}
topic: ${topic || ''}
created: ${new Date().toISOString().slice(0, 10)}
---

# ${displayTitle}

在此处添加内容...
`;
  return writeNote(fullName, finalContent);
}

// 删除笔记
function deleteNote(name) {
  const notePath = getNotePath(name);
  if (!fs.existsSync(notePath)) {
    throw new Error(`笔记 "${name}" 不存在`);
  }
  fs.unlinkSync(notePath);
  return true;
}

// ---- 专题目录管理 ----

// 列出所有专题（递归返回路径列表）
function listTopics() {
  ensureVaultDirs();
  const topics = [];
  if (!fs.existsSync(TOPICS_DIR)) return topics;

  function scan(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      const topicPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      topics.push(topicPath);
      scan(fullPath, topicPath);
    }
  }
  scan(TOPICS_DIR, '');
  return topics.sort();
}

// 获取专题元数据文件路径
function getTopicMetaPath(topicPath) {
  const segments = topicPath.split('/').filter(Boolean);
  validateTopicSegments(segments);
  return path.join(TOPICS_DIR, ...segments, '_topic-meta.json');
}

// 读取专题元数据
function readTopicMeta(topicPath) {
  const metaPath = getTopicMetaPath(topicPath);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

// 写入专题元数据
function writeTopicMeta(topicPath, meta) {
  const metaPath = getTopicMetaPath(topicPath);
  const dir = path.dirname(metaPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(metaPath, { ...meta, updated: new Date().toISOString() });
}

// 创建专题目录
function createTopic(topicPath) {
  const segments = topicPath.split('/').filter(Boolean);
  validateTopicSegments(segments);
  const dir = path.join(TOPICS_DIR, ...segments);
  if (fs.existsSync(dir)) {
    throw new Error(`专题 "${topicPath}" 已存在`);
  }
  fs.mkdirSync(dir, { recursive: true });
  writeTopicMeta(topicPath, { name: segments[segments.length - 1], created: new Date().toISOString() });
  return dir;
}

// 删除专题目录（要求为空，或 force=true 时连同笔记一起删除）
function deleteTopic(topicPath, { force = false } = {}) {
  const segments = topicPath.split('/').filter(Boolean);
  validateTopicSegments(segments);
  const dir = path.join(TOPICS_DIR, ...segments);
  if (!fs.existsSync(dir)) {
    throw new Error(`专题 "${topicPath}" 不存在`);
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const hasNotes = entries.some((e) => e.isFile() && e.name.endsWith('.md'));
  const hasSubTopics = entries.some((e) => e.isDirectory());
  if ((hasNotes || hasSubTopics) && !force) {
    throw new Error(`专题 "${topicPath}" 非空，请使用 force=true 强制删除`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// 更新笔记 Front Matter 的 topic 字段，使其与所在目录一致
function syncNoteTopicField(noteName) {
  const notePath = getNotePath(noteName);
  if (!fs.existsSync(notePath)) return false;
  const content = fs.readFileSync(notePath, 'utf8');
  const { frontMatter, content: body } = parseFrontMatter(content);
  const topic = hasTopicPath(noteName) ? noteName.split('/').slice(0, -1).join('/') : '';
  if (frontMatter.topic !== topic) {
    frontMatter.topic = topic;
    const newContent = stringifyFrontMatter(frontMatter) + body;
    writeFileAtomic(notePath, newContent);
    return true;
  }
  return false;
}

// 重命名/移动专题目录
function renameTopic(oldTopicPath, newTopicPath) {
  const oldSegments = oldTopicPath.split('/').filter(Boolean);
  const newSegments = newTopicPath.split('/').filter(Boolean);
  validateTopicSegments(oldSegments);
  validateTopicSegments(newSegments);
  const oldDir = path.join(TOPICS_DIR, ...oldSegments);
  const newDir = path.join(TOPICS_DIR, ...newSegments);
  if (!fs.existsSync(oldDir)) {
    throw new Error(`专题 "${oldTopicPath}" 不存在`);
  }
  if (fs.existsSync(newDir)) {
    throw new Error(`专题 "${newTopicPath}" 已存在`);
  }

  // 收集所有受影响的笔记，用于后续级联替换链接
  const affectedNotes = listNotes()
    .filter((n) => n.topic && (n.topic === oldTopicPath || n.topic.startsWith(`${oldTopicPath}/`)))
    .map((n) => n.name);

  // 重命名目录
  fs.renameSync(oldDir, newDir);

  // 更新受影响笔记的 topic 字段，并级联替换正文中的 [[旧路径/笔记]] → [[新路径/笔记]
  for (const noteName of affectedNotes) {
    const notePath = getNotePath(noteName);
    if (!fs.existsSync(notePath)) continue;
    const newNoteName = noteName.replace(
      new RegExp(`^${escapeRegExp(oldTopicPath)}(/|$)`),
      `${newTopicPath}$1`
    );
    syncNoteTopicField(newNoteName);
  }

  // 级联替换全局所有笔记/碎片/卡片中的 [[oldTopicPath/...]] 链接
  const updatedRefs = cascadeRenameTopicLinks(oldTopicPath, newTopicPath);

  rebuildIndex();
  return { newTopicPath, affectedNotes: affectedNotes.length, updatedRefs };
}

// 级联替换专题路径前缀：[[oldTopic/笔记]] → [[newTopic/笔记]]
function cascadeRenameTopicLinks(oldTopicPath, newTopicPath) {
  const regex = new RegExp(`\\[\\[\\s*${escapeRegExp(oldTopicPath)}(?=\\s*(?:\\||\\]\\]))`, 'gi');
  let updatedRefs = 0;
  for (const dir of [VAULT_DIR, TOPICS_DIR, FRAGMENTS_DIR, CARDS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    const files = [];
    function collectFiles(currentDir) {
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const filePath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          collectFiles(filePath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(filePath);
        }
      }
    }
    collectFiles(dir);
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const replaced = content.replace(regex, () => {
        updatedRefs++;
        return `[[${newTopicPath}`;
      });
      if (replaced !== content) {
        writeFileAtomic(filePath, replaced);
      }
    }
  }
  return updatedRefs;
}

// 转义正则特殊字符
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- 笔记备份（.snapshots/_vault/<ts>/<file>）查询与读取 ----
// 备份目录名格式：new Date().toISOString().replace(/[:.]/g, '-')，如 2026-07-24T17-02-37-704Z
const BACKUP_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
export function isValidBackupTs(ts) {
  return BACKUP_TS_RE.test(String(ts || ''));
}

// 列出某笔记的历史备份，按时间倒序返回 [{ts, preview}]（preview 取前 100 字）
export function listNoteBackups(name, { snapshotsDir = SNAPSHOTS_VAULT_DIR } = {}) {
  const fileName = path.basename(getNotePath(name)); // getNotePath 内含名称校验
  if (!fs.existsSync(snapshotsDir)) return [];
  const backups = [];
  for (const entry of fs.readdirSync(snapshotsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidBackupTs(entry.name)) continue;
    const file = path.join(snapshotsDir, entry.name, fileName);
    if (!fs.existsSync(file)) continue;
    let preview = '';
    try { preview = fs.readFileSync(file, 'utf8').slice(0, 100); } catch { continue; }
    backups.push({ ts: entry.name, preview });
  }
  return backups.sort((a, b) => b.ts.localeCompare(a.ts));
}

// 读取指定时间戳的备份内容；时间戳非法或备份不存在返回 null
export function readNoteBackup(name, ts, { snapshotsDir = SNAPSHOTS_VAULT_DIR } = {}) {
  if (!isValidBackupTs(ts)) return null;
  const fileName = path.basename(getNotePath(name));
  const file = path.join(snapshotsDir, ts, fileName);
  if (path.dirname(file) !== path.join(snapshotsDir, ts)) return null; // 防路径穿越（双保险）
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

// ---- 笔记列表自定义排序（拖拽排序持久化）----
export function readNoteOrder({ orderFile = NOTE_ORDER_FILE } = {}) {
  try {
    if (!fs.existsSync(orderFile)) return [];
    const data = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
    return Array.isArray(data?.order) ? data.order.filter((n) => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export function writeNoteOrder(order, { orderFile = NOTE_ORDER_FILE } = {}) {
  const clean = [...new Set((Array.isArray(order) ? order : []).filter((n) => typeof n === 'string'))];
  ensureVaultDirs();
  writeJsonAtomic(orderFile, { order: clean });
  return clean;
}


// 级联替换全部笔记 / 碎片 / 卡片中的 [[oldName]] 与 [[oldName|显示文本]]（只改链接前半部分）
function cascadeRenameLinks(oldBase, newBase) {
  const regex = new RegExp(`\\[\\[\\s*${escapeRegExp(oldBase)}(?=\\s*(?:\\||\\]\\]))`, 'gi');
  let updatedRefs = 0;
  for (const dir of [VAULT_DIR, TOPICS_DIR, FRAGMENTS_DIR, CARDS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    const files = [];
    function collectFiles(currentDir) {
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const filePath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          collectFiles(filePath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(filePath);
        }
      }
    }
    collectFiles(dir);
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const replaced = content.replace(regex, () => {
        updatedRefs++;
        return `[[${newBase}`;
      });
      if (replaced !== content) {
        writeFileAtomic(filePath, replaced);
      }
    }
  }
  return updatedRefs;
}

// 重命名笔记：备份原文件、fs 重命名、级联更新所有 [[Wiki链接]] 引用，最后重建索引
// 支持在同一专题内重命名，也支持跨专题移动（newName 可含 topic 路径）
function renameNote(oldName, newName) {
  // getNotePath 内含非法名称（/、\、..）防御
  const oldPath = getNotePath(oldName);
  const newPath = getNotePath(newName);
  const newBase = newName.trim().replace(/\.md$/i, '');
  if (!fs.existsSync(oldPath)) {
    throw new Error(`笔记 "${oldName}" 不存在`);
  }
  if (!newBase) {
    throw new Error('新名称不能为空');
  }
  if (normalizeNoteName(oldName) === normalizeNoteName(newName)) {
    throw new Error('新旧名称相同');
  }
  if (fs.existsSync(newPath)) {
    throw new Error(`笔记 "${newBase}" 已存在`);
  }
  // 备份原文件到 .snapshots/_vault/<时间戳>/（与 server 的 backupVaultNote 同约定），失败只告警不阻断
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(SNAPSHOTS_VAULT_DIR, ts);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(oldPath, path.join(dir, path.basename(oldPath)));
    pruneVaultBackups();
  } catch (err) {
    console.error('笔记自动备份失败:', err);
  }
  fs.renameSync(oldPath, newPath);

  // 若跨专题移动，同步更新 Front Matter 的 topic 字段
  syncNoteTopicField(newName);

  const oldBase = oldName.trim().replace(/\.md$/i, '');
  const updatedRefs = cascadeRenameLinks(oldBase, newBase);
  rebuildIndex();
  return { newName: newBase, updatedRefs };
}

// parseFrontMatter / stringifyFrontMatter 统一由 ./front-matter.mjs 提供（顶部 import + 下方 re-export）

export {
  ensureVaultDirs,
  readIndex,
  writeIndex,
  normalizeNoteName,
  getNotePath,
  hasTopicPath,
  listNotes,
  listTopics,
  readNote,
  writeNote,
  createNote,
  deleteNote,
  renameNote,
  createTopic,
  deleteTopic,
  renameTopic,
  readTopicMeta,
  writeTopicMeta,
  syncNoteTopicField,
  parseFrontMatter,
  stringifyFrontMatter,
  VAULT_DIR,
  TOPICS_DIR,
  ASSETS_DIR,
  REPORTS_DIR,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  switch (command) {
    case 'list': {
      const notes = listNotes();
      console.log('知识库笔记：');
      for (const n of notes) {
        console.log(`- ${n.name} (${n.mtime.slice(0, 10)})`);
      }
      console.log(`共 ${notes.length} 篇笔记`);
      break;
    }
    case 'create': {
      const name = process.argv[3];
      if (!name) {
        console.error('Usage: node scripts/vault.mjs create <name>');
        process.exit(1);
      }
      const notePath = createNote(name);
      console.log(`创建笔记：${notePath}`);
      break;
    }
    case 'delete': {
      const name = process.argv[3];
      if (!name) {
        console.error('Usage: node scripts/vault.mjs delete <name>');
        process.exit(1);
      }
      deleteNote(name);
      console.log(`删除笔记：${name}`);
      break;
    }
    default:
      console.log('可用命令：');
      console.log('  list              - 列出所有笔记');
      console.log('  create <name>     - 创建新笔记');
      console.log('  delete <name>     - 删除笔记');
  }
}
