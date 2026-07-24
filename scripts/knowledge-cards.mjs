#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter } from './front-matter.mjs';
import { writeFileAtomic, writeJsonAtomic } from './fs-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const VAULT_DIR = path.join(ROOT, 'vault');
const CARDS_DIR = path.join(VAULT_DIR, 'knowledge-cards');
const META_DIR = path.join(VAULT_DIR, '.meta');
const MASTERY_FILE = path.join(META_DIR, 'mastery.json');

function ensureDirs() {
  if (!fs.existsSync(CARDS_DIR)) {
    fs.mkdirSync(CARDS_DIR, { recursive: true });
  }
  if (!fs.existsSync(META_DIR)) {
    fs.mkdirSync(META_DIR, { recursive: true });
  }
}

function loadMastery() {
  if (!fs.existsSync(MASTERY_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(MASTERY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveMastery(mastery) {
  ensureDirs();
  writeJsonAtomic(MASTERY_FILE, mastery);
}

function getCardPath(id) {
  if (/[/\\]/.test(id) || id.includes('..')) {
    throw new Error(`非法卡片 ID：${id}`);
  }
  return path.join(CARDS_DIR, `${id}.md`);
}

function getCards() {
  const cards = [];
  const mastery = loadMastery();
  
  if (!fs.existsSync(CARDS_DIR)) return [];
  
  for (const entry of fs.readdirSync(CARDS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const id = entry.name.replace('.md', '');
      const card = loadCard(id);
      if (card) {
        cards.push({
          ...card,
          mastery: mastery[id] || { level: 0, nextReview: null, reviews: [] }
        });
      }
    }
  }
  
  return cards;
}

function loadCard(id) {
  const cardPath = getCardPath(id);
  if (!fs.existsSync(cardPath)) return null;
  
  const content = fs.readFileSync(cardPath, 'utf8');
  const { frontMatter, content: parsedBody } = parseFrontMatter(content);
  
  // 提取内容部分
  let body = parsedBody.trim();
  
  // 解析各个部分（按 ## 标题切分，支持多行内容）
  let question = '', answer = '', explanation = '';

  const segments = body.split(/^##\s*([^\n]+)\n/m);
  for (let i = 1; i < segments.length - 1; i += 2) {
    const head = segments[i].trim();
    const text = (segments[i + 1] || '').trim();
    if (/^(问题|Question)$/.test(head)) question = text;
    else if (/^(答案|Answer)$/.test(head)) answer = text;
    else if (/^(解析|Explanation)$/.test(head)) explanation = text;
  }
  
  // 如果没有明确的分段，尝试用其他方式
  if (!question && !answer) {
    const parts = body.split(/\n-{3,}\n/);
    if (parts.length >= 2) {
      question = parts[0].trim();
      answer = parts[1].trim();
      if (parts.length >= 3) explanation = parts[2].trim();
    } else {
      question = body;
    }
  }
  
  return {
    id,
    title: frontMatter.title || id,
    tags: frontMatter.tags || [],
    subject: frontMatter.subject || '',
    difficulty: parseInt(frontMatter.difficulty || '1'),
    question,
    answer,
    explanation
  };
}

function saveCard(id, cardData) {
  ensureDirs();
  
  const cardPath = getCardPath(id);
  let frontMatter = {
    title: cardData.title || id,
    tags: cardData.tags || [],
    subject: cardData.subject || '',
    difficulty: cardData.difficulty || 1,
    type: 'knowledge-card'
  };
  
  let content = `---
title: ${frontMatter.title}
tags: [${frontMatter.tags.join(', ')}]
subject: ${frontMatter.subject}
difficulty: ${frontMatter.difficulty}
type: knowledge-card
---

## 问题
${cardData.question || ''}

## 答案
${cardData.answer || ''}

## 解析
${cardData.explanation || ''}
`;
  
  writeFileAtomic(cardPath, content);
  
  return id;
}

function deleteCard(id) {
  const cardPath = getCardPath(id);
  if (fs.existsSync(cardPath)) {
    fs.unlinkSync(cardPath);
    return true;
  }
  return false;
}

function recordReview(id, rating) {
  const mastery = loadMastery();
  const now = new Date().toISOString();
  
  if (!mastery[id]) {
    mastery[id] = { level: 0, nextReview: null, reviews: [] };
  }
  
  // 间隔重复算法（简化版）
  const currentLevel = mastery[id].level;
  let newLevel = rating >= 3 ? Math.min(currentLevel + 1, 5) : Math.max(currentLevel - 1, 0);
  
  // 计算下次复习时间
  let nextDays = 0;
  switch (newLevel) {
    case 0: nextDays = 1; break;
    case 1: nextDays = 1; break;
    case 2: nextDays = 3; break;
    case 3: nextDays = 7; break;
    case 4: nextDays = 14; break;
    case 5: nextDays = 30; break;
  }
  
  const nextReview = new Date();
  nextReview.setDate(nextReview.getDate() + nextDays);
  
  mastery[id].level = newLevel;
  mastery[id].nextReview = nextReview.toISOString();
  mastery[id].reviews.push({
    date: now,
    rating,
    previousLevel: currentLevel,
    newLevel
  });
  
  saveMastery(mastery);
  
  return mastery[id];
}

function getDueCards() {
  const mastery = loadMastery();
  const cards = getCards();
  const now = new Date();
  
  return cards.filter(card => {
    const m = mastery[card.id];
    if (!m || !m.nextReview) return true;
    return new Date(m.nextReview) <= now;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  
  switch (command) {
    case 'list':
      const cards = getCards();
      console.log(`知识卡片：${cards.length} 个`);
      for (const card of cards) {
        console.log(`- ${card.title} (${card.tags.join(', ')})`);
      }
      break;
      
    case 'due':
      const due = getDueCards();
      console.log(`待复习卡片：${due.length} 个`);
      for (const card of due) {
        console.log(`- ${card.title}`);
      }
      break;
      
    case 'create':
      const id = process.argv[3] || `card-${Date.now()}`;
      const title = process.argv[4] || id;
      saveCard(id, { title, question: '请输入问题...', answer: '请输入答案...', tags: ['未分类'] });
      console.log(`创建卡片：${id}`);
      break;

    default:
      console.log('Usage: node scripts/knowledge-cards.mjs [list|due|create [id] [title]]');
  }
}

export {
  getCards,
  loadCard,
  saveCard,
  deleteCard,
  recordReview,
  getDueCards,
  loadMastery,
  saveMastery
};
