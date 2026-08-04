#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listNotes, readNote, parseFrontMatter } from './vault.mjs';
import { listFragments } from './fragments.mjs';
import { getCards } from './knowledge-cards.mjs';
import { getMistakes } from './exam-papers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'vault', 'assets');

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/---[\s\S]*?---/, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[`#>*_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLine(text) {
  return normalizeText(String(text || '').split('\n').find((line) => line.trim()) || '');
}

function clip(text, max = 140) {
  const clean = normalizeText(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function makeSnippet(text, query, radius = 68) {
  const clean = normalizeText(text);
  const q = String(query || '').trim().toLowerCase();
  if (!clean) return '';
  if (!q) return clip(clean, radius * 2);
  const index = clean.toLowerCase().indexOf(q);
  if (index < 0) return clip(clean, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(clean.length, index + q.length + radius);
  let snippet = clean.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < clean.length) snippet = `${snippet}…`;
  return snippet;
}

function countHits(text, query) {
  const clean = normalizeText(text).toLowerCase();
  const q = String(query || '').trim().toLowerCase();
  if (!clean || !q) return 0;
  let count = 0;
  let cursor = clean.indexOf(q);
  while (cursor >= 0) {
    count += 1;
    cursor = clean.indexOf(q, cursor + q.length);
  }
  return count;
}

function formatAssetSize(size) {
  const bytes = Number(size) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function assetKindOf(name) {
  const lower = String(name || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp)$/i.test(lower)) return 'image';
  if (/\.(mp4|webm|mov)$/i.test(lower)) return 'video';
  if (/\.(mp3|wav|m4a|ogg)$/i.test(lower)) return 'audio';
  if (/\.(pdf|docx)$/i.test(lower)) return 'doc';
  return 'file';
}

function noteDocuments() {
  return listNotes().map((note) => {
    const content = readNote(note.name) || '';
    const { content: body, frontMatter } = parseFrontMatter(content);
    return {
      id: `note:${note.name}`,
      kind: 'note',
      title: note.name,
      summary: clip(frontMatter.summary || firstLine(body) || '知识库笔记'),
      text: normalizeText(body),
      mtime: note.mtime,
      downloadUrl: `/api/knowledge/documents/note/${encodeURIComponent(note.name)}/download`,
      openTarget: { kind: 'note', id: note.name },
    };
  });
}

function assetDocuments() {
  if (!fs.existsSync(ASSETS_DIR)) return [];
  return fs.readdirSync(ASSETS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(ASSETS_DIR, entry.name);
      const stat = fs.statSync(fullPath);
      const kind = assetKindOf(entry.name);
      return {
        id: `asset:${entry.name}`,
        kind: 'asset',
        title: entry.name,
        summary: `${kind} · ${formatAssetSize(stat.size)}`,
        text: normalizeText(entry.name),
        mtime: stat.mtime.toISOString(),
        downloadUrl: `/api/knowledge/documents/asset/${encodeURIComponent(entry.name)}/download`,
        openTarget: { kind: 'asset', id: entry.name },
      };
    });
}

function fragmentDocuments() {
  return listFragments().map((fragment) => ({
    id: `fragment:${fragment.id}`,
    kind: 'fragment',
    title: firstLine(fragment.content) || fragment.id,
    summary: clip(fragment.content),
    text: normalizeText(fragment.content),
    mtime: fragment.created || fragment.updated || '',
    openTarget: { kind: 'fragment', id: fragment.id },
  }));
}

function cardDocuments() {
  return getCards().map((card) => ({
    id: `card:${card.id}`,
    kind: 'card',
    title: card.title || firstLine(card.question) || card.id,
    summary: clip(card.answer || card.question || ''),
    text: normalizeText(`${card.title || ''}\n${card.question || ''}\n${card.answer || ''}\n${card.explanation || ''}`),
    mtime: card.updatedAt || card.createdAt || '',
    openTarget: { kind: 'card', id: card.id },
  }));
}

function mistakeDocuments() {
  return getMistakes().map((item) => ({
    id: `mistake:${item.id}`,
    kind: 'mistake',
    title: firstLine(item.question) || item.id,
    summary: clip(item.answer || item.analysis || item.question || ''),
    text: normalizeText(`${item.question || ''}\n${item.answer || ''}\n${item.analysis || ''}`),
    mtime: item.updatedAt || item.createdAt || '',
    openTarget: { kind: 'mistake', id: item.id },
  }));
}

export function listKnowledgeDocuments({ kind = 'all', query = '', limit = 200 } = {}) {
  const all = [
    ...assetDocuments(),
    ...noteDocuments(),
    ...cardDocuments(),
    ...fragmentDocuments(),
    ...mistakeDocuments(),
  ];
  const q = String(query || '').trim().toLowerCase();
  const filtered = all.filter((doc) => {
    if (kind !== 'all' && doc.kind !== kind) return false;
    if (!q) return true;
    return `${doc.title}\n${doc.summary}\n${doc.text}`.toLowerCase().includes(q);
  });
  return filtered
    .sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')))
    .slice(0, Math.max(1, Number(limit) || 200))
    .map(({ text, ...doc }) => doc);
}

export function searchKnowledge(query, { limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const corpus = [
    ...noteDocuments(),
    ...fragmentDocuments(),
    ...cardDocuments(),
    ...mistakeDocuments(),
    ...assetDocuments(),
  ];
  const ranked = [];
  for (const doc of corpus) {
    const haystack = `${doc.title}\n${doc.summary}\n${doc.text}`;
    const hits = countHits(haystack, q);
    if (!hits) continue;
    let score = hits * 10;
    if (String(doc.title || '').toLowerCase().includes(q.toLowerCase())) score += 18;
    if (doc.kind === 'note') score += 8;
    if (doc.kind === 'asset') score -= 4;
    ranked.push({
      ...doc,
      score,
      snippet: makeSnippet(haystack, q),
      sourceLabel: {
        note: '知识库笔记',
        asset: '资料附件',
        fragment: '速记碎片',
        card: '知识卡片',
        mistake: '错题',
      }[doc.kind] || '知识库',
    });
  }
  return ranked
    .sort((a, b) => b.score - a.score || String(b.mtime || '').localeCompare(String(a.mtime || '')))
    .slice(0, Math.max(1, Number(limit) || 6))
    .map(({ text, score, ...doc }) => doc);
}
