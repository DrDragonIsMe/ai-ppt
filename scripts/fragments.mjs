#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore } from './store.mjs';
import { parseFrontMatter } from './front-matter.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const VAULT_DIR = path.join(ROOT, 'vault');
const FRAGMENTS_DIR = path.join(VAULT_DIR, 'fragments');

// 使用 FileStore 提供原子写入和变更通知
const store = new FileStore(FRAGMENTS_DIR, { ext: '.md' });

const VALID_STATUS = ['inbox', 'organized'];

function ensureDir() {
  // FileStore 已在构造函数中确保目录存在
}

function getFragmentPath(id) {
  if (/[/\\]/.test(id) || id.includes('..')) {
    throw new Error(`非法碎片 ID：${id}`);
  }
  return path.join(FRAGMENTS_DIR, `${id}.md`);
}

function generateId() {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `f-${Date.now().toString(36)}-${rand}`;
}

// 从正文中提取 #标签（支持中文、字母、数字、下划线、中划线）
function extractTags(content) {
  const tags = [];
  const re = /#([\p{L}\p{N}_-]+)/gu;
  let m;
  while ((m = re.exec(content)) !== null) {
    tags.push(m[1]);
  }
  return tags;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(t => String(t).trim()).filter(Boolean))];
}

function loadFragment(id) {
  const raw = store.getRaw(id);
  if (raw === null) return null;

  const { frontMatter, content: parsedBody } = parseFrontMatter(raw);
  const body = parsedBody.trim();

  return {
    id,
    type: frontMatter.type || 'fragment',
    content: body,
    tags: Array.isArray(frontMatter.tags) ? frontMatter.tags : [],
    status: frontMatter.status || 'inbox',
    created: frontMatter.created || ''
  };
}

function saveFragment(fragment) {
  ensureDir();
  const raw = `---
id: ${fragment.id}
type: fragment
tags: [${fragment.tags.join(', ')}]
created: ${fragment.created}
status: ${fragment.status}
---

${fragment.content}
`;
  store.setRaw(fragment.id, raw);
  return fragment;
}

// listFragments 结果缓存：store 变更（本进程写入/删除）即时失效，
// 短 TTL 兜底跨进程改动（CLI 等直接写文件的场景）。
const LIST_CACHE_TTL_MS = 2000;
let _listCache = null; // { at: number, items: Fragment[] }
store.on('change', () => { _listCache = null; });

function loadAllFragments() {
  const fragments = [];
  if (!fs.existsSync(FRAGMENTS_DIR)) return fragments;

  for (const entry of fs.readdirSync(FRAGMENTS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const fragment = loadFragment(entry.name.replace('.md', ''));
      if (fragment) fragments.push(fragment);
    }
  }

  fragments.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  return fragments;
}

function listFragments({ status } = {}) {
  if (!_listCache || Date.now() - _listCache.at >= LIST_CACHE_TTL_MS) {
    _listCache = { at: Date.now(), items: loadAllFragments() };
  }
  // 返回副本，避免调用方原地修改污染缓存
  const items = status ? _listCache.items.filter(f => f.status === status) : _listCache.items.slice();
  return items;
}

function getFragment(id) {
  return loadFragment(id);
}

function createFragment({ content, tags = [] } = {}) {
  const text = String(content || '').trim();
  if (!text) {
    throw new Error('碎片内容不能为空');
  }

  const mergedTags = normalizeTags([...normalizeTags(tags), ...extractTags(text)]);
  const fragment = {
    id: generateId(),
    type: 'fragment',
    content: text,
    tags: mergedTags,
    status: 'inbox',
    created: new Date().toISOString()
  };

  return saveFragment(fragment);
}

function updateFragment(id, { content, tags, status } = {}) {
  const fragment = loadFragment(id);
  if (!fragment) {
    throw new Error(`碎片不存在：${id}`);
  }

  if (content !== undefined) {
    const text = String(content || '').trim();
    if (!text) {
      throw new Error('碎片内容不能为空');
    }
    fragment.content = text;
    // 内容变化时重新解析 #标签 并去重合并
    const base = tags !== undefined ? normalizeTags(tags) : fragment.tags;
    fragment.tags = normalizeTags([...base, ...extractTags(text)]);
  } else if (tags !== undefined) {
    fragment.tags = normalizeTags(tags);
  }

  if (status !== undefined) {
    if (!VALID_STATUS.includes(status)) {
      throw new Error(`非法状态：${status}`);
    }
    fragment.status = status;
  }

  return saveFragment(fragment);
}

function deleteFragment(id) {
  return store.delete(id);
}

// ---------- 碎片附件（v2.5.0）：![[name]] token 与解析块 ----------

// 已支持的资产扩展名（与 routes/vault-commons.mjs 的 ASSET_TYPES 保持一致）
const ASSET_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'webm', 'mov'];

// 从碎片正文提取附件名（![[name.ext]] token）
function extractAttachmentNames(content) {
  const names = [];
  const re = /!\[\[([^\[\]\n]+?\.(png|jpe?g|gif|webp|pdf|docx|mp3|wav|m4a|ogg|mp4|webm|mov))\]\]/gi;
  let m;
  while ((m = re.exec(String(content || ''))) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// 写入/替换某附件的「📎 <name> 解析（provider）：」块；已存在则整块替换，否则追加到末尾
function upsertParseBlock(content, name, blockText, provider) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = `📎 ${name} 解析（${provider || 'unknown'}）：\n${blockText}`;
  const text = String(content || '');
  const re = new RegExp(`\\n*📎 ${esc} 解析(（[^）]*）|)：\\n[\\s\\S]*?(?=\\n\\n📎 |$)`);
  if (re.test(text)) return text.replace(re, `\n\n${block}`);
  return `${text}\n\n${block}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];

  switch (command) {
    case 'add': {
      const content = process.argv[3];
      if (!content) {
        console.log('Usage: node scripts/fragments.mjs add "<内容>"');
        process.exit(1);
      }
      const fragment = createFragment({ content });
      console.log(`创建碎片：${fragment.id}`);
      break;
    }

    case 'list': {
      const fragments = listFragments();
      console.log(`碎片：${fragments.length} 条`);
      for (const f of fragments) {
        const preview = f.content.split('\n')[0].slice(0, 50);
        console.log(`- [${f.status}] ${f.id} ${preview} (${f.tags.join(', ')})`);
      }
      break;
    }

    case 'delete': {
      const id = process.argv[3];
      if (!id) {
        console.log('Usage: node scripts/fragments.mjs delete <id>');
        process.exit(1);
      }
      const ok = deleteFragment(id);
      console.log(ok ? `已删除：${id}` : `碎片不存在：${id}`);
      break;
    }

    case 'reparse': {
      const id = process.argv[3];
      if (!id) {
        console.log('Usage: node scripts/fragments.mjs reparse <id>');
        process.exit(1);
      }
      const fragment = getFragment(id);
      if (!fragment) {
        console.log(`碎片不存在：${id}`);
        process.exit(1);
      }
      const attachments = extractAttachmentNames(fragment.content);
      if (!attachments.length) {
        console.log('该碎片没有附件');
        process.exit(1);
      }
      const { parseAsset } = await import('./parse-asset.mjs');
      for (const name of attachments) {
        console.log(`解析 ${name} …`);
        const result = await parseAsset(name);
        const text = result.text || '（暂无法解析，已仅保存附件）';
        const current = getFragment(id);
        updateFragment(id, { content: upsertParseBlock(current.content, name, text, result.provider) });
        console.log(`  → provider=${result.provider} degraded=${result.degraded} text=${text.length} 字`);
      }
      console.log('完成');
      break;
    }

    default:
      console.log('Usage: node scripts/fragments.mjs [add "<内容>"|list|delete <id>|reparse <id>]');
  }
}

export {
  FRAGMENTS_DIR,
  store as fragmentStore,
  listFragments,
  getFragment,
  createFragment,
  updateFragment,
  deleteFragment,
  extractAttachmentNames,
  upsertParseBlock
};
