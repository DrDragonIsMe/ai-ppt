#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, getProjectDir, readConfig } from './config.mjs';
import { load } from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 分词：将文本拆为小写 token，过滤停用词与过短 token
// ============================================================
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'this', 'that',
  'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he',
  'she', 'it', 'they', 'them', 'what', 'which', 'who', 'whom',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
]);

function tokenize(text) {
  if (!text) return [];
  // Split on non-alphanumeric (keep CJK characters)
  const raw = text.toLowerCase().match(/[\w\u4e00-\u9fff\u3400-\u4dbf]+/g);
  if (!raw) return [];
  return raw.filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

// ============================================================
// 倒排索引 SearchIndex
// ============================================================
export class SearchIndex {
  constructor() {
    /** @type {Map<string, {name:string, title:string, snippet:string, status:string, lastGeneratedAt:string, tokens:Set<string>}>} */
    this.docs = new Map();
    /** @type {Map<string, Set<string>>} token -> Set<doc name> */
    this.invertedIndex = new Map();
    this.built = false;
  }

  // -- 全量构建 --
  build() {
    this.docs.clear();
    this.invertedIndex.clear();
    const projects = listProjects();
    for (const project of projects) {
      const doc = this._scanProject(project.name);
      if (doc) this._addDoc(project.name, doc.title, doc.description, doc.textContent, doc.status, doc.lastGeneratedAt);
    }
    this.built = true;
  }

  // -- 单项目扫描（全量构建与单条重建共用） --
  _scanProject(name) {
    const dir = getProjectDir(name);
    if (!fs.existsSync(dir)) return null;
    const cfg = readConfig(name);
    const htmlPath = path.join(dir, 'index.html');
    const textContent = extractTextFromHtml(htmlPath);
    const title = (cfg.params?.title || name);
    const description = (cfg.sourceUrl || cfg.articleText || '');
    return { title, description, textContent, status: cfg.status || 'draft', lastGeneratedAt: cfg.lastGeneratedAt || null };
  }

  // -- 增量添加/更新 --
  add(name, { title, description, textContent, status, lastGeneratedAt }) {
    // 先移除旧条目（如果有）
    this.remove(name);
    this._addDoc(name, title || name, description || '', textContent || '', status || 'draft', lastGeneratedAt || null);
  }

  // -- 增量删除 --
  remove(name) {
    const doc = this.docs.get(name);
    if (!doc) return;
    // 从倒排索引中移除
    for (const token of doc.tokens) {
      const set = this.invertedIndex.get(token);
      if (set) {
        set.delete(name);
        if (set.size === 0) this.invertedIndex.delete(token);
      }
    }
    this.docs.delete(name);
  }

  // -- 失效：项目存在时单独重建该条索引，不存在时从索引移除 --
  invalidate(name) {
    if (!name) {
      this.built = false;
      return;
    }
    if (!this.built) return; // 未构建时下次 search() 会全量重建
    const doc = this._scanProject(name);
    if (doc) {
      this.add(name, doc);
    } else {
      this.remove(name);
    }
  }

  // -- 搜索 --
  search(query) {
    if (!this.built) this.build();
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const queryTokens = tokenize(q);
    if (queryTokens.length === 0) {
      // Fallback: substring match on title/snippet for very short queries
      return this._substringSearch(q);
    }

    // Boolean AND: intersect sets for each query token
    let resultNames = null;
    for (const token of queryTokens) {
      // Prefix matching: find all tokens in index that start with query token
      const matching = new Set();
      for (const [indexToken, names] of this.invertedIndex) {
        if (indexToken.startsWith(token) || token.startsWith(indexToken)) {
          for (const n of names) matching.add(n);
        }
      }
      if (resultNames === null) {
        resultNames = matching;
      } else {
        // Intersect
        resultNames = new Set([...resultNames].filter(n => matching.has(n)));
      }
    }

    if (!resultNames || resultNames.size === 0) {
      // Fallback to substring
      return this._substringSearch(q);
    }

    return [...resultNames].map(name => {
      const doc = this.docs.get(name);
      return {
        name: doc.name,
        title: doc.title,
        snippet: doc.snippet,
        status: doc.status,
        lastGeneratedAt: doc.lastGeneratedAt,
      };
    });
  }

  // -- 内部方法 --
  _addDoc(name, title, description, textContent, status, lastGeneratedAt) {
    const fullText = `${name} ${title} ${description} ${textContent}`;
    const tokens = new Set(tokenize(fullText));
    const snippet = textContent.length > 200
      ? textContent.substring(0, 200) + '...'
      : textContent;

    this.docs.set(name, { name, title, snippet, status, lastGeneratedAt, tokens });

    for (const token of tokens) {
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Set());
      }
      this.invertedIndex.get(token).add(name);
    }
  }

  _substringSearch(q) {
    const results = [];
    for (const doc of this.docs.values()) {
      if (doc.title.toLowerCase().includes(q) || doc.snippet.toLowerCase().includes(q)) {
        results.push({
          name: doc.name,
          title: doc.title,
          snippet: doc.snippet,
          status: doc.status,
          lastGeneratedAt: doc.lastGeneratedAt,
        });
      }
    }
    return results;
  }
}

// ============================================================
// HTML 文本提取
// ============================================================
function extractTextFromHtml(htmlPath) {
  if (!fs.existsSync(htmlPath)) return '';
  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const $ = load(html);
    let text = '';
    $('.slide').each((i, el) => {
      text += $(el).text() + '\n';
    });
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  } catch {
    return '';
  }
}

// ============================================================
// 全局单例索引（server.mjs 启动时调用 buildSearchIndex）
// ============================================================
const globalIndex = new SearchIndex();

export function buildSearchIndex() {
  globalIndex.build();
}

export function invalidateSearchIndex(name) {
  globalIndex.invalidate(name);
}

export function getSearchIndex() {
  return globalIndex;
}

// ============================================================
// 向后兼容：search(query) 函数
// ============================================================
export function search(query) {
  return globalIndex.search(query);
}

// CLI 入口
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const query = process.argv[2];
  if (!query) {
    console.log('Usage: node scripts/search.mjs <query>');
    process.exit(0);
  }
  buildSearchIndex();
  const results = search(query);
  console.log(JSON.stringify(results, null, 2));
}
