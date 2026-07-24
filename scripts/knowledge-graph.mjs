#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listNotes, readNote, normalizeNoteName } from './vault.mjs';
import { parseWikiLinks } from './link-resolver.mjs';
import { FRAGMENTS_DIR } from './fragments.mjs';
import { getCards } from './knowledge-cards.mjs';
import { getMistakes } from './exam-papers.mjs';
import { parseFrontMatter } from './front-matter.mjs';
import { writeJsonAtomic } from './fs-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const VAULT_DIR = path.join(ROOT, 'vault');
const CARDS_DIR = path.join(VAULT_DIR, 'knowledge-cards');
const MISTAKES_DIR = path.join(VAULT_DIR, 'mistakes');
const META_DIR = path.join(VAULT_DIR, '.meta');
const GRAPH_PATH = path.join(META_DIR, 'graph.json');

function ensureMetaDir() {
  if (!fs.existsSync(META_DIR)) {
    fs.mkdirSync(META_DIR, { recursive: true });
  }
}

// 统计 search 在 text 中出现的次数（text 需已转小写，search 同样）
function countOccurrences(text, search) {
  if (!search) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

// 收集语料：全部笔记正文 + 碎片 + 知识卡片 + 错题的原始文本
function collectCorpus(notes) {
  const docs = [];
  for (const note of notes) {
    docs.push({
      key: `note:${normalizeNoteName(note.name)}`,
      text: (readNote(note.name) || '').toLowerCase()
    });
  }
  const extraDirs = [
    { dir: FRAGMENTS_DIR, prefix: 'fragment', ext: '.md' },
    { dir: CARDS_DIR, prefix: 'card', ext: '.md' },
    { dir: MISTAKES_DIR, prefix: 'mistake', ext: '.json' }
  ];
  for (const { dir, prefix, ext } of extraDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(ext)) {
        try {
          docs.push({
            key: `${prefix}:${entry.name}`,
            text: fs.readFileSync(path.join(dir, entry.name), 'utf8').toLowerCase()
          });
        } catch (e) {}
      }
    }
  }
  return docs;
}

// 卡片/错题的 title 或 tags 与节点名匹配（大小写不敏感）
function matchesNode(title, tags, node) {
  if (title && String(title).toLowerCase() === node.id) return true;
  return (Array.isArray(tags) ? tags : []).some(t => String(t).toLowerCase() === node.id);
}

function buildGraph() {
  ensureMetaDir();
  const notes = listNotes();
  
  const nodes = [];
  const edges = [];
  const nodeIndex = new Map();
  
  // 先创建所有节点
  for (const note of notes) {
    const id = normalizeNoteName(note.name);
    const content = readNote(note.name) || '';
    const links = parseWikiLinks(content);
    
    let frontmatter = {};
    try {
      frontmatter = parseFrontMatter(content).frontMatter;
    } catch (e) {}
    
    const size = Math.max(15, Math.min(50, 15 + Math.sqrt(content.length / 10)));
    
    nodes.push({
      id,
      name: note.name,
      label: note.name.length > 15 ? note.name.substring(0, 12) + '...' : note.name,
      size,
      tags: Array.isArray(frontmatter.tags)
        ? frontmatter.tags
        : (frontmatter.tags ? String(frontmatter.tags).split(',').map(t => t.trim()).filter(Boolean) : []),
      type: frontmatter.type || 'note',
      mtime: note.mtime
    });
    
    nodeIndex.set(id, nodes.length - 1);
  }
  
  // 再创建边
  for (const note of notes) {
    const sourceId = normalizeNoteName(note.name);
    const content = readNote(note.name) || '';
    const links = parseWikiLinks(content);
    
    for (const link of links) {
      const targetId = normalizeNoteName(link.target);
      if (nodeIndex.has(targetId) && sourceId !== targetId) {
        edges.push({
          source: sourceId,
          target: targetId
        });
      }
    }
  }
  
  // ==== 加权统计：mentions / reviews / weight ====
  const corpus = collectCorpus(notes);
  
  // mentions：节点名在语料中的出现次数（自身笔记不计）
  for (const node of nodes) {
    const selfKey = `note:${node.id}`;
    let mentions = 0;
    for (const doc of corpus) {
      if (doc.key === selfKey) continue;
      mentions += countOccurrences(doc.text, node.id);
    }
    node.mentions = mentions;
  }
  
  // reviews：关联卡片/错题的复习次数（按 title 或 tags 与节点名匹配汇总）
  for (const node of nodes) node.reviews = 0;
  for (const card of getCards()) {
    const reviewCount = ((card.mastery && card.mastery.reviews) || []).length;
    if (!reviewCount) continue;
    for (const node of nodes) {
      if (matchesNode(card.title, card.tags, node)) node.reviews += reviewCount;
    }
  }
  for (const mistake of getMistakes()) {
    const reviewCount = mistake.reviewCount || 0;
    if (!reviewCount) continue;
    for (const node of nodes) {
      if (matchesNode('', mistake.tags, node)) node.reviews += reviewCount;
    }
  }
  
  // weight = 度数（出链 + 入链数）+ mentions
  for (const node of nodes) {
    const degree = edges.filter(e => e.source === node.id || e.target === node.id).length;
    node.weight = degree + (node.mentions || 0);
  }
  
  // 边 weight = 1 + 两个节点名在同一文档中共现的次数
  for (const edge of edges) {
    let cooccur = 0;
    for (const doc of corpus) {
      if (doc.text.includes(edge.source) && doc.text.includes(edge.target)) cooccur++;
    }
    edge.weight = 1 + cooccur;
  }
  
  const graph = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    nodes,
    edges
  };
  
  writeJsonAtomic(GRAPH_PATH, graph);
  return graph;
}

function readGraph() {
  if (fs.existsSync(GRAPH_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
    } catch (e) {
      return buildGraph();
    }
  }
  return buildGraph();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  switch (command) {
    case 'build':
      const graph = buildGraph();
      console.log(`Graph built: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
      break;
    case 'read':
      console.log(JSON.stringify(readGraph(), null, 2));
      break;
    default:
      console.log('Usage: node scripts/knowledge-graph.mjs [build|read]');
  }
}

export { buildGraph, readGraph };
