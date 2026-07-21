#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR, getProjectDir, readConfig } from './config.mjs';

const __filename = fileURLToPath(import.meta.url);
const SNAPSHOTS_DIR = path.join(ROOT_DIR, '.snapshots');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirSync(src, dst) {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
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

// Stable, sortable snapshot id: timestamp-based.
function newSnapshotId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function createSnapshot(name, description = '') {
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
  const src = path.join(snapshotDir(name), snapshotId);
  if (!fs.existsSync(src)) {
    throw new Error(`快照 ${snapshotId} 不存在`);
  }

  const projectDir = getProjectDir(name);
  // Replace project content, excluding export artifacts from the snapshot copy step.
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  copyDirSync(src, projectDir);
  fs.rmSync(path.join(projectDir, 'snapshot.json'), { force: true });
}

export function deleteSnapshot(name, snapshotId) {
  const dir = path.join(snapshotDir(name), snapshotId);
  if (!fs.existsSync(dir)) {
    throw new Error(`快照 ${snapshotId} 不存在`);
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
    } else {
      console.log('Usage: node scripts/snapshot.mjs [create <name> [desc] | list <name> | restore <name> <id> | delete <name> <id>]');
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
