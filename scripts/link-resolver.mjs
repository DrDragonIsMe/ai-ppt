#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listNotes,
  readNote,
  writeNote,
  readIndex,
  writeIndex,
  normalizeNoteName,
  parseFrontMatter,
} from './vault.mjs';
import { listFragments, getFragment, updateFragment } from './fragments.mjs';
import { getCards } from './knowledge-cards.mjs';
import { splitFrontMatter } from './front-matter.mjs';
import {
  parseTasks,
  parseProperties,
  parseBlockAnchors,
  toggleTaskLine,
  runQuery,
} from './vault-features.mjs';

const __filename = fileURLToPath(import.meta.url);

// 解析[[Wiki链接]]，返回所有找到的链接
function parseWikiLinks(content) {
  const links = [];
  // 匹配 [[笔记名]] 或 [[笔记名|显示文本]]
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const target = match[1].trim();
    const display = match[2] ? match[2].trim() : target;
    links.push({
      target,
      targetNormalized: normalizeNoteName(target),
      display,
      raw: match[0],
    });
  }
  return links;
}

// 按行解析[[Wiki链接]]，同时截取链接所在行 ±40 字作为上下文
function parseWikiLinksWithSnippets(body) {
  const results = [];
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  for (const line of body.split('\n')) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const start = Math.max(0, match.index - 40);
      const end = Math.min(line.length, match.index + match[0].length + 40);
      let snippet = line.slice(start, end).trim();
      if (start > 0) snippet = '…' + snippet;
      if (end < line.length) snippet += '…';
      results.push({
        targetNormalized: normalizeNoteName(match[1].trim()),
        snippet,
      });
    }
  }
  return results;
}

// 索引结构版本：结构（字段）变化时 +1；旧版本索引触发一次全量重建
const INDEX_VERSION = 1;

// 默认 IO（测试可通过 rebuildIndex({ io }) 注入假实现，避免触碰真实 vault）
const defaultIO = { readIndex, writeIndex, listNotes, readNote };

// 解析单个笔记内容，生成索引条目（纯函数，供增量/全量重建共用）
function parseNoteContent(name, mtime, content) {
  const { frontMatter, content: body } = parseFrontMatter(content);
  const links = parseWikiLinksWithSnippets(body);
  return {
    title: frontMatter.title || name,
    tags: frontMatter.tags || [],
    links: links.map(l => l.targetNormalized),
    snippets: links.map(l => l.snippet), // 与 links 等长，供反链上下文增量重算
    tasks: parseTasks(body),
    properties: parseProperties(body),
    blocks: parseBlockAnchors(body),
    content, // 原文缓存，searchNotes 免二次读盘
    mtime,
  };
}

// 从 index.notes 重算派生数据：tags / blocks / tasks / backlinks
function deriveIndex(index) {
  index.backlinks = {};
  index.tags = {};
  index.blocks = {}; // 块锚点：id → {note, text, line}（id 冲突时后写覆盖）
  index.tasks = [];  // 扁平任务列表：[{note, status, priority, text, line}]

  // 归一化名 → 实际名 查找表，替代循环内 Object.keys().find() 的 O(n²)
  const normalizedToName = new Map();
  for (const name of Object.keys(index.notes)) {
    normalizedToName.set(normalizeNoteName(name), name);
  }

  for (const [name, entry] of Object.entries(index.notes)) {
    for (const block of (entry.blocks || [])) {
      index.blocks[block.id] = { note: name, text: block.text, line: block.line };
    }
    for (const task of (entry.tasks || [])) {
      index.tasks.push({ note: name, ...task });
    }
    for (const tag of (entry.tags || [])) {
      if (!index.tags[tag]) index.tags[tag] = [];
      if (!index.tags[tag].includes(name)) index.tags[tag].push(name);
    }
    // 反向链接（含上下文 snippet，同一来源合并为一个条目）
    const links = entry.links || [];
    const snippets = entry.snippets || [];
    for (let i = 0; i < links.length; i++) {
      const targetName = normalizedToName.get(links[i]);
      if (targetName && targetName !== name) {
        if (!index.backlinks[targetName]) index.backlinks[targetName] = [];
        let backlink = index.backlinks[targetName].find(e => e.source === name);
        if (!backlink) {
          backlink = { source: name, snippets: [] };
          index.backlinks[targetName].push(backlink);
        }
        const snippet = snippets[i] || '';
        if (snippet && !backlink.snippets.includes(snippet)) {
          backlink.snippets.push(snippet);
        }
      }
    }
  }
}

// 重建/同步索引（mtime 驱动增量）：
// - 索引不存在、_version 不符或 force=true 时全量重建；
// - 否则逐笔记比对 mtime，只重解析新增/变化的文件，剔除已删除文件；
// - 仅当有变化时才重算派生数据并写盘（只读路径重复调用不产生写盘）。
function rebuildIndex({ force = false, io = defaultIO } = {}) {
  const existing = io.readIndex();
  const stale = force
    || existing._version !== INDEX_VERSION
    || !existing.notes || typeof existing.notes !== 'object';
  const index = stale ? { ...existing, _version: INDEX_VERSION, notes: {} } : existing;

  const notes = io.listNotes();
  let changed = stale;
  const seen = new Set();
  for (const note of notes) {
    seen.add(note.name);
    const entry = index.notes[note.name];
    if (stale || !entry || entry.mtime !== note.mtime) {
      const content = io.readNote(note.name);
      if (content === null || content === undefined) continue;
      index.notes[note.name] = parseNoteContent(note.name, note.mtime, content);
      changed = true;
    }
  }
  // 剔除已删除的笔记
  for (const name of Object.keys(index.notes)) {
    if (!seen.has(name)) {
      delete index.notes[name];
      changed = true;
    }
  }

  if (changed) {
    deriveIndex(index);
    io.writeIndex(index);
  }
  return index;
}

// 获取单个笔记的详细信息（包括反向链接）
function getNoteInfo(name) {
  const index = rebuildIndex(); // 增量同步，无变化时是廉价只读
  // 归一化名 → 实际名 查找表（替代循环内 Object.keys().find() 的 O(n²)）
  const normalizedToName = new Map();
  for (const n of Object.keys(index.notes || {})) {
    normalizedToName.set(normalizeNoteName(n), n);
  }
  const normalized = normalizeNoteName(name);
  const actualName = normalizedToName.get(normalized) || name;

  const note = index.notes[actualName];
  // 优先用索引缓存的原文，索引未覆盖时回退读文件
  const content = note && typeof note.content === 'string' ? note.content : readNote(actualName);
  const links = content ? parseWikiLinks(content) : [];

  // 解析出链目标的实际笔记名
  const resolvedOutlinks = [];
  for (const link of links) {
    const targetName = normalizedToName.get(link.targetNormalized);
    if (targetName && !resolvedOutlinks.includes(targetName)) {
      resolvedOutlinks.push(targetName);
    }
  }
  
  // 入链：对象数组 [{name, snippets}]
  const backlinks = (index.backlinks[actualName] || []).map(entry => ({
    name: entry.source,
    snippets: entry.snippets || [],
  }));
  
  return {
    name: actualName,
    title: note?.title || actualName,
    tags: note?.tags || [],
    tasks: note?.tasks || [],
    properties: note?.properties || {},
    outlinks: resolvedOutlinks,
    backlinks,
    content,
    exists: !!content,
  };
}

// 搜索笔记（简单搜索标题和内容；优先用索引缓存的原文，未覆盖时回退读文件）
function searchNotes(query) {
  const q = query.toLowerCase().trim();
  const index = rebuildIndex(); // 增量同步，无变化时是廉价只读
  // 与 listNotes() 一致按 mtime 倒序
  const entries = Object.entries(index.notes || {})
    .sort((a, b) => String(b[1].mtime || '').localeCompare(String(a[1].mtime || '')));
  const results = [];

  for (const [name, entry] of entries) {
    const content = typeof entry.content === 'string' ? entry.content : (readNote(name) || '');
    const title = (entry.title || name).toLowerCase();
    const body = content.toLowerCase();

    if (title.includes(q) || body.includes(q)) {
      // snippet 以第一个命中位置为中心截取 ±60 字；仅标题命中时取正文开头
      const hit = body.indexOf(q);
      let snippet;
      if (hit >= 0) {
        const start = Math.max(0, hit - 60);
        const end = Math.min(content.length, hit + q.length + 60);
        snippet = content.slice(start, end);
        if (start > 0) snippet = '…' + snippet;
        if (end < content.length) snippet += '…';
      } else {
        snippet = content.slice(0, 120);
        if (content.length > 120) snippet += '…';
      }
      results.push({
        name,
        title: entry.title || name,
        snippet: snippet.replace(/\n/g, ' '),
      });
    }
  }

  return results;
}

// 在正文中查找未包在 [[...]] 内的 name 出现位置（大小写不敏感），返回 [{index, text}]
function findUnlinkedOccurrences(body, name) {
  const results = [];
  if (!body || !name) return results;
  // 把 [[...]] 区域整体打码（保留长度），已链接的出现不会再命中
  const masked = body.replace(/\[\[[^\]]*\]\]/g, m => ' '.repeat(m.length)).toLowerCase();
  const lowerName = name.toLowerCase();
  let idx = masked.indexOf(lowerName);
  while (idx !== -1) {
    results.push({ index: idx, text: body.slice(idx, idx + name.length) });
    idx = masked.indexOf(lowerName, idx + name.length);
  }
  return results;
}

// 以命中位置为中心截取 ±40 字作为上下文
function makeMentionSnippet(body, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(body.length, index + length + 40);
  let snippet = body.slice(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < body.length) snippet += '…';
  return snippet;
}

// 查找其他笔记正文与碎片正文中未链接的 name 出现（排除自身与 front matter 区域）
function findUnlinkedMentions(name) {
  const mentions = [];
  const target = String(name || '').trim().replace(/\.md$/i, '');
  if (!target) return mentions;
  const self = normalizeNoteName(target);

  // 其他笔记正文
  for (const note of listNotes()) {
    if (normalizeNoteName(note.name) === self) continue;
    const content = readNote(note.name);
    if (!content) continue;
    const { content: body } = parseFrontMatter(content);
    for (const hit of findUnlinkedOccurrences(body, target)) {
      mentions.push({
        source: note.name,
        snippet: makeMentionSnippet(body, hit.index, target.length),
      });
    }
  }

  // 碎片正文（loadFragment 已剥离 front matter）
  for (const fragment of listFragments()) {
    for (const hit of findUnlinkedOccurrences(fragment.content, target)) {
      mentions.push({
        source: `fragment:${fragment.id}`,
        snippet: makeMentionSnippet(fragment.content, hit.index, target.length),
      });
    }
  }

  return mentions;
}

// 把正文中所有未链接的 name 出现包成 [[name]]；大小写不一致时用 [[name|原文]] 保留显示文本
function wrapUnlinkedOccurrences(body, name) {
  const hits = findUnlinkedOccurrences(body, name);
  let text = body;
  // 从后往前替换，保持前面的索引有效
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i];
    const replacement = hit.text === name ? `[[${name}]]` : `[[${name}|${hit.text}]]`;
    text = text.slice(0, hit.index) + replacement + text.slice(hit.index + name.length);
  }
  return { text, count: hits.length };
}

// 把 source（笔记名或 fragment:<id>）中所有未链接的 name 出现包成 [[name]]，返回 {count}
function linkMentions(name, source) {
  const target = String(name || '').trim().replace(/\.md$/i, '');
  if (!target) throw new Error('笔记名不能为空');
  const src = String(source || '').trim();

  if (src.startsWith('fragment:')) {
    const id = src.slice('fragment:'.length);
    const fragment = getFragment(id);
    if (!fragment) throw new Error(`碎片不存在：${id}`);
    const { text, count } = wrapUnlinkedOccurrences(fragment.content, target);
    if (count > 0) updateFragment(id, { content: text });
    return { count };
  }

  const content = readNote(src);
  if (content === null) throw new Error(`笔记 "${src}" 不存在`);
  // 只处理正文，front matter 原样保留
  const { fm: head, body } = splitFrontMatter(content);
  const { text, count } = wrapUnlinkedOccurrences(body, target);
  if (count > 0) {
    writeNote(src, head + text);
    rebuildIndex();
  }
  return { count };
}

// 聚合全部标签：索引中的笔记标签 + 卡片 front matter 标签 + 碎片标签
function getAllTags() {
  const tags = {};
  const ensure = (tag) => {
    if (!tags[tag]) tags[tag] = { notes: [], cards: [], fragments: [] };
    return tags[tag];
  };

  // 笔记标签（索引重建时已从 front matter 收集）
  const index = rebuildIndex(); // 增量同步，保证标签新鲜且多数情况下零写盘
  for (const [tag, noteNames] of Object.entries(index.tags || {})) {
    const entry = ensure(tag);
    for (const noteName of noteNames) {
      if (!entry.notes.includes(noteName)) entry.notes.push(noteName);
    }
  }

  // 卡片 front matter 标签
  for (const card of getCards()) {
    for (const tag of (card.tags || [])) {
      const entry = ensure(tag);
      if (!entry.cards.includes(card.id)) entry.cards.push(card.id);
    }
  }

  // 碎片标签
  for (const fragment of listFragments()) {
    for (const tag of (fragment.tags || [])) {
      const entry = ensure(tag);
      if (!entry.fragments.includes(fragment.id)) entry.fragments.push(fragment.id);
    }
  }

  return tags;
}

export {
  parseWikiLinks,
  rebuildIndex,
  getNoteInfo,
  searchNotes,
  findUnlinkedMentions,
  linkMentions,
  getAllTags,
  INDEX_VERSION,
  // Logseq 特性（vault-features.mjs 的转出口，供路由层统一使用）
  parseTasks,
  parseProperties,
  parseBlockAnchors,
  toggleTaskLine,
  runQuery,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  switch (command) {
    case 'rebuild': {
      const index = rebuildIndex({ force: true });
      console.log('索引已重建');
      console.log(`笔记数：${Object.keys(index.notes).length}`);
      console.log(`标签数：${Object.keys(index.tags).length}`);
      console.log(`反向链接数：${Object.keys(index.backlinks).length}`);
      break;
    }
    case 'info': {
      const name = process.argv[3];
      if (!name) {
        console.error('Usage: node scripts/link-resolver.mjs info <name>');
        process.exit(1);
      }
      const info = getNoteInfo(name);
      console.log(`笔记：${info.title}`);
      console.log(`标签：${info.tags.join(', ') || '无'}`);
      console.log(`出链：${info.outlinks.join(', ') || '无'}`);
      if (info.backlinks.length === 0) {
        console.log('入链：无');
      } else {
        console.log('入链：');
        for (const b of info.backlinks) {
          console.log(`- ${b.name}`);
          for (const s of b.snippets.slice(0, 3)) {
            console.log(`  ${s}`);
          }
        }
      }
      break;
    }
    case 'search': {
      const query = process.argv[3];
      if (!query) {
        console.error('Usage: node scripts/link-resolver.mjs search <query>');
        process.exit(1);
      }
      const results = searchNotes(query);
      console.log(`搜索结果：${results.length} 条`);
      for (const r of results) {
        console.log(`- ${r.title}`);
        console.log(`  ${r.snippet}`);
      }
      break;
    }
    default:
      console.log('可用命令：');
      console.log('  rebuild              - 重建索引');
      console.log('  info <name>          - 查看笔记信息');
      console.log('  search <query>       - 搜索笔记');
  }
}
