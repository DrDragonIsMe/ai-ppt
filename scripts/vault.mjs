#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const VAULT_DIR = path.join(ROOT, 'vault');
const VAULT_INDEX = path.join(ROOT, '.vault-index.json');
const ASSETS_DIR = path.join(VAULT_DIR, 'assets');

// 确保目录存在
function ensureVaultDirs() {
  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }
}

// 读取索引
function readIndex() {
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
  index.updated = new Date().toISOString();
  fs.writeFileSync(VAULT_INDEX, JSON.stringify(index, null, 2), 'utf8');
}

// 规范化笔记名（用于链接匹配）
function normalizeNoteName(name) {
  return name.trim().replace(/\.md$/i, '').toLowerCase();
}

// 获取笔记文件路径
function getNotePath(name) {
  const baseName = name.trim().replace(/\.md$/i, '') + '.md';
  return path.join(VAULT_DIR, baseName);
}

// 列出所有笔记
function listNotes() {
  ensureVaultDirs();
  const notes = [];
  if (!fs.existsSync(VAULT_DIR)) return notes;
  
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
  fs.writeFileSync(notePath, content, 'utf8');
  return notePath;
}

// 创建新笔记
function createNote(name, content = '') {
  const notePath = getNotePath(name);
  if (fs.existsSync(notePath)) {
    throw new Error(`笔记 "${name}" 已存在`);
  }
  // 自动添加简单的Front Matter
  const finalContent = content.trim()
    ? content
    : `---
title: ${name}
created: ${new Date().toISOString().slice(0, 10)}
---

# ${name}

在此处添加内容...
`;
  return writeNote(name, finalContent);
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

// 解析Front Matter
function parseFrontMatter(content) {
  const frontMatter = {};
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (match) {
    const lines = match[1].split('\n');
    for (const line of lines) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) {
        const key = kv[1].trim();
        let val = kv[2].trim();
        // 解析数组，如 [HR, SaaS]
        if (val.startsWith('[') && val.endsWith(']')) {
          val = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
        }
        frontMatter[key] = val;
      }
    }
    return { frontMatter, content: match[2] };
  }
  return { frontMatter: {}, content };
}

// 生成Front Matter字符串
function stringifyFrontMatter(frontMatter) {
  if (!frontMatter || Object.keys(frontMatter).length === 0) return '';
  let lines = ['---'];
  for (const [key, val] of Object.entries(frontMatter)) {
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.join(', ')}]`);
    } else if (val !== undefined && val !== null) {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---\n');
  return lines.join('\n');
}

export {
  ensureVaultDirs,
  readIndex,
  writeIndex,
  normalizeNoteName,
  getNotePath,
  listNotes,
  readNote,
  writeNote,
  createNote,
  deleteNote,
  parseFrontMatter,
  stringifyFrontMatter,
  VAULT_DIR,
  ASSETS_DIR,
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
