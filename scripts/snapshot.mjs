#!/usr/bin/env node
// scripts/snapshot.mjs — 项目快照管理（创建/列表/恢复/删除/清理）
// 每个项目快照保存在 .snapshots/<项目名>/<快照ID>/，快照 ID 为时间戳格式
// 默认保留策略：每个项目最近 20 个快照；快照时默认排除 export/ 目录以节省空间
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR, getProjectDir, readConfig, isSafeName } from './config.mjs';

const __filename = fileURLToPath(import.meta.url);
const SNAPSHOTS_DIR = path.join(ROOT_DIR, '.snapshots');

// 保留策略：每个项目最多保留最近 SNAPSHOT_KEEP 个快照
const SNAPSHOT_KEEP = 20;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirSync(src, dst) {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // 快照时默认排除 export/ 目录（导出产物可重新生成，节省快照空间）
    if (entry.isDirectory() && entry.name === 'export') continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function snapshotDir(name) {
  return path.join(SNAPSHOTS_DIR, name);
}

// 防路径注入：项目名走 isSafeName 校验，快照 ID 仅允许时间戳格式字符
function assertSafeSnapshotTarget(name, snapshotId) {
  if (!isSafeName(name)) {
    throw new Error(`非法项目名：${name}`);
  }
  if (snapshotId !== undefined && !/^[0-9A-Za-z-]+$/.test(snapshotId)) {
    throw new Error(`非法快照 ID：${snapshotId}`);
  }
}

// 保留策略：按快照 ID（时间戳，字典序=时间序）删除最旧的，保留最近 keep 个
export function pruneSnapshots(name, keep = SNAPSHOT_KEEP, protectIds = []) {
  assertSafeSnapshotTarget(name);
  const dir = snapshotDir(name);
  if (!fs.existsSync(dir)) return 0;
  const protectedSet = new Set(protectIds);
  const ids = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  let removed = 0;
  while (ids.length > keep) {
    const oldest = ids.find((id) => !protectedSet.has(id));
    if (!oldest) break;
    const target = path.join(dir, oldest);
    if (path.dirname(target) !== dir) break; // 防路径注入
    fs.rmSync(target, { recursive: true, force: true });
    ids.splice(ids.indexOf(oldest), 1);
    removed++;
  }
  return removed;
}

// Stable, sortable snapshot id: timestamp-based.
function newSnapshotId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function createSnapshot(name, description = '', protectIds = []) {
  assertSafeSnapshotTarget(name);
  const projectDir = getProjectDir(name);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`项目 ${name} 不存在`);
  }

  const id = newSnapshotId();
  const dst = path.join(snapshotDir(name), id);
  copyDirSync(projectDir, dst);

  const cfg = readConfig(name);
  const meta = {
    id,
    name,
    description,
    createdAt: new Date().toISOString(),
    status: cfg.status || 'draft',
    title: cfg.params?.title || name,
  };
  fs.writeFileSync(path.join(dst, 'snapshot.json'), JSON.stringify(meta, null, 2));
  pruneSnapshots(name, SNAPSHOT_KEEP, protectIds);
  return meta;
}

export function listSnapshots(name) {
  const dir = snapshotDir(name);
  if (!fs.existsSync(dir)) return [];
  const snapshots = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, 'snapshot.json');
    if (fs.existsSync(metaPath)) {
      try {
        snapshots.push(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
      } catch {
        // skip invalid meta
      }
    }
  }
  snapshots.sort((a, b) => b.id.localeCompare(a.id)); // newest first
  return snapshots;
}

export function restoreSnapshot(name, snapshotId) {
  assertSafeSnapshotTarget(name, snapshotId);
  const src = path.join(snapshotDir(name), snapshotId);
  if (!fs.existsSync(src)) {
    throw new Error(`快照 ${snapshotId} 不存在`);
  }

  const projectDir = getProjectDir(name);
  // 恢复前自动备份当前项目内容，保证恢复可逆；protectIds 防止保留策略清掉被恢复的快照
  if (fs.existsSync(projectDir)) {
    createSnapshot(name, `auto-backup before restore to ${snapshotId}`, [snapshotId]);
  }
  // Replace project content, excluding export artifacts from the snapshot copy step.
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  copyDirSync(src, projectDir);
  fs.rmSync(path.join(projectDir, 'snapshot.json'), { force: true });
}

export function deleteSnapshot(name, snapshotId) {
  assertSafeSnapshotTarget(name, snapshotId);
  const dir = path.join(snapshotDir(name), snapshotId);
  if (!fs.existsSync(dir)) {
    throw new Error(`快照 ${snapshotId} 不存在`);
  }
  if (path.dirname(dir) !== snapshotDir(name)) {
    throw new Error(`非法快照路径：${snapshotId}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, name, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'create') {
      console.log(JSON.stringify(createSnapshot(name, rest.join(' ')), null, 2));
    } else if (cmd === 'list') {
      console.log(JSON.stringify(listSnapshots(name), null, 2));
    } else if (cmd === 'restore') {
      restoreSnapshot(name, rest[0]);
      console.log(`已恢复快照 ${rest[0]} 到项目 ${name}`);
    } else if (cmd === 'delete') {
      deleteSnapshot(name, rest[0]);
      console.log(`已删除快照 ${rest[0]}`);
    } else if (cmd === 'prune') {
      const removed = pruneSnapshots(name);
      console.log(`已清理项目 ${name} 的 ${removed} 个旧快照（保留最近 ${SNAPSHOT_KEEP} 个）`);
    } else {
      console.log('Usage: node scripts/snapshot.mjs [create <name> [desc] | list <name> | restore <name> <id> | delete <name> <id> | prune <name>]');
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
