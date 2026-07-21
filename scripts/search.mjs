#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, getProjectDir, readConfig } from './config.mjs';
import { load } from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractTextFromHtml(htmlPath) {
  if (!fs.existsSync(htmlPath)) return '';
  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const $ = load(html);
    let text = '';
    // Extract text from slide content
    $('.slide').each((i, el) => {
      text += $(el).text() + '\n';
    });
    // Normalize whitespace
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  } catch {
    return '';
  }
}

function buildIndex() {
  const projects = listProjects();
  const index = [];
  for (const project of projects) {
    const dir = getProjectDir(project.name);
    const cfg = readConfig(project.name);
    const htmlPath = path.join(dir, 'index.html');
    const textContent = extractTextFromHtml(htmlPath);
    const title = (cfg.params?.title || project.title || project.name).toLowerCase();
    const description = (cfg.sourceUrl || cfg.articleText || '').toLowerCase();
    index.push({
      name: project.name,
      title: title,
      description: description,
      content: textContent,
      status: project.status,
      lastGeneratedAt: project.lastGeneratedAt,
    });
  }
  return index;
}

export function search(query) {
  const index = buildIndex();
  const q = query.toLowerCase().trim();
  if (!q) return [];

  return index.filter(item => {
    return item.title.includes(q) ||
           item.description.includes(q) ||
           item.content.includes(q);
  }).map(item => {
    // Build a snippet from the content
    const snippet = item.content.length > 200
      ? item.content.substring(0, 200) + '...'
      : item.content;
    return {
      name: item.name,
      title: item.title,
      snippet: snippet,
      status: item.status,
      lastGeneratedAt: item.lastGeneratedAt,
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const query = process.argv[2];
  if (!query) {
    console.log('Usage: node scripts/search.mjs <query>');
    process.exit(0);
  }
  const results = search(query);
  console.log(JSON.stringify(results, null, 2));
}
