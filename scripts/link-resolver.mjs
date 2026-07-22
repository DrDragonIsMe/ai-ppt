#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listNotes,
  readNote,
  readIndex,
  writeIndex,
  normalizeNoteName,
  parseFrontMatter,
} from './vault.mjs';

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

// 重建整个索引
function rebuildIndex() {
  const index = readIndex();
  index.notes = {};
  index.backlinks = {};
  index.tags = {};
  
  const notes = listNotes();
  
  // 第一遍：收集所有笔记的正向链接和标签
  for (const note of notes) {
    const content = readNote(note.name);
    if (!content) continue;
    
    const { frontMatter, content: body } = parseFrontMatter(content);
    const links = parseWikiLinks(body);
    
    index.notes[note.name] = {
      title: frontMatter.title || note.name,
      tags: frontMatter.tags || [],
      links: links.map(l => l.targetNormalized),
      mtime: note.mtime,
    };
    
    // 收集标签
    for (const tag of (frontMatter.tags || [])) {
      if (!index.tags[tag]) index.tags[tag] = [];
      if (!index.tags[tag].includes(note.name)) {
        index.tags[tag].push(note.name);
      }
    }
  }
  
  // 第二遍：构建反向链接
  for (const sourceName of Object.keys(index.notes)) {
    const source = index.notes[sourceName];
    for (const targetNormalized of source.links) {
      // 找到实际的笔记名
      const targetName = Object.keys(index.notes).find(
        n => normalizeNoteName(n) === targetNormalized
      );
      if (targetName && targetName !== sourceName) {
        if (!index.backlinks[targetName]) {
          index.backlinks[targetName] = [];
        }
        if (!index.backlinks[targetName].includes(sourceName)) {
          index.backlinks[targetName].push(sourceName);
        }
      }
    }
  }
  
  writeIndex(index);
  return index;
}

// 获取单个笔记的详细信息（包括反向链接）
function getNoteInfo(name) {
  const index = readIndex();
  const normalized = normalizeNoteName(name);
  const actualName = Object.keys(index.notes).find(
    n => normalizeNoteName(n) === normalized
  ) || name;
  
  const note = index.notes[actualName];
  const content = readNote(actualName);
  const links = content ? parseWikiLinks(content) : [];
  
  // 解析出链目标的实际笔记名
  const resolvedOutlinks = [];
  for (const link of links) {
    const targetName = Object.keys(index.notes).find(
      n => normalizeNoteName(n) === link.targetNormalized
    );
    if (targetName) {
      resolvedOutlinks.push({ name: targetName, display: link.display });
    }
  }
  
  return {
    name: actualName,
    title: note?.title || actualName,
    tags: note?.tags || [],
    outlinks: resolvedOutlinks,
    backlinks: index.backlinks[actualName] || [],
    content,
    exists: !!content,
  };
}

// 搜索笔记（简单搜索标题和内容）
function searchNotes(query) {
  const q = query.toLowerCase().trim();
  const notes = listNotes();
  const results = [];
  
  for (const note of notes) {
    const content = readNote(note.name) || '';
    const { frontMatter } = parseFrontMatter(content);
    const title = (frontMatter.title || note.name).toLowerCase();
    const body = content.toLowerCase();
    
    if (title.includes(q) || body.includes(q)) {
      results.push({
        name: note.name,
        title: frontMatter.title || note.name,
        snippet: content.slice(0, 200).replace(/\n/g, ' ') + '...',
      });
    }
  }
  
  return results;
}

export {
  parseWikiLinks,
  rebuildIndex,
  getNoteInfo,
  searchNotes,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  switch (command) {
    case 'rebuild': {
      const index = rebuildIndex();
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
      console.log(`出链：${info.outlinks.map(l => l.name).join(', ') || '无'}`);
      console.log(`入链：${info.backlinks.join(', ') || '无'}`);
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
