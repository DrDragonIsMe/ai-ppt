#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCards, loadMastery } from './knowledge-cards.mjs';
import { readGlobalConfig } from './global-config.mjs';
import { generateSlides } from './llm-adapter.mjs';
import { writeJsonAtomic } from './fs-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const VAULT_DIR = path.join(ROOT, 'vault');
const EXAMS_DIR = path.join(VAULT_DIR, 'exam-papers');
const MISTAKES_DIR = path.join(VAULT_DIR, 'mistakes');

function ensureDirs() {
  if (!fs.existsSync(EXAMS_DIR)) {
    fs.mkdirSync(EXAMS_DIR, { recursive: true });
  }
  if (!fs.existsSync(MISTAKES_DIR)) {
    fs.mkdirSync(MISTAKES_DIR, { recursive: true });
  }
}

// 纵深防御：拒绝路径穿越
function getExamPaperPath(id) {
  if (/[/\\]/.test(id) || id.includes('..')) {
    throw new Error(`非法试卷 ID：${id}`);
  }
  return path.join(EXAMS_DIR, `${id}.json`);
}

function getMistakePath(id) {
  if (/[/\\]/.test(id) || id.includes('..')) {
    throw new Error(`非法错题 ID：${id}`);
  }
  return path.join(MISTAKES_DIR, `${id}.json`);
}

// ==== Exam Papers ====
function getExamPapers() {
  ensureDirs();
  const papers = [];

  if (!fs.existsSync(EXAMS_DIR)) return papers;

  for (const file of fs.readdirSync(EXAMS_DIR)) {
    if (file.endsWith('.json')) {
      try {
        const content = fs.readFileSync(path.join(EXAMS_DIR, file), 'utf8');
        const paper = JSON.parse(content);
        papers.push(paper);
      } catch (e) {
        // skip invalid files
      }
    }
  }

  papers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return papers;
}

function getExamPaper(id) {
  ensureDirs();
  const file = getExamPaperPath(id);
  if (!fs.existsSync(file)) return null;

  try {
    const content = fs.readFileSync(file, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function saveExamPaper(id, paper) {
  ensureDirs();
  const file = getExamPaperPath(id);

  const data = {
    id,
    title: paper.title || '新试卷',
    subject: paper.subject || '',
    description: paper.description || '',
    questions: paper.questions || [],
    tags: paper.tags || [],
    difficulty: paper.difficulty || 'medium',
    examDate: paper.examDate || '',
    createdAt: paper.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writeJsonAtomic(file, data);
  return data;
}

function deleteExamPaper(id) {
  const file = getExamPaperPath(id);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

function getExamStats() {
  const papers = getExamPapers();
  let totalQuestions = 0;
  const subjects = new Set();

  for (const paper of papers) {
    totalQuestions += (paper.questions || []).length;
    if (paper.subject) subjects.add(paper.subject);
  }

  return {
    examCount: papers.length,
    questionCount: totalQuestions,
    subjects: Array.from(subjects),
  };
}

// ==== Mistakes / Wrong Questions ====
function getMistakes(filters = {}) {
  ensureDirs();
  let mistakes = [];

  if (!fs.existsSync(MISTAKES_DIR)) return mistakes;

  for (const file of fs.readdirSync(MISTAKES_DIR)) {
    if (file.endsWith('.json')) {
      try {
        const content = fs.readFileSync(path.join(MISTAKES_DIR, file), 'utf8');
        const mistake = JSON.parse(content);
        mistakes.push(mistake);
      } catch (e) {
        // skip invalid files
      }
    }
  }

  // Apply filters
  if (filters.subject) {
    mistakes = mistakes.filter(m => m.subject === filters.subject);
  }
  if (filters.masteryRange) {
    const [min, max] = filters.masteryRange.split('-').map(Number);
    mistakes = mistakes.filter(m => {
      const mastery = m.mastery || 0;
      return mastery >= min && mastery <= max;
    });
  }

  mistakes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return mistakes;
}

function getMistake(id) {
  ensureDirs();
  const file = getMistakePath(id);
  if (!fs.existsSync(file)) return null;

  try {
    const content = fs.readFileSync(file, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function saveMistake(id, mistake) {
  ensureDirs();
  const file = getMistakePath(id);

  const data = {
    id,
    question: mistake.question || '',
    wrongAnswer: mistake.wrongAnswer || '',
    correctAnswer: mistake.correctAnswer || '',
    analysis: mistake.analysis || '',
    subject: mistake.subject || '',
    tags: mistake.tags || [],
    sourceExam: mistake.sourceExam || '',
    source: mistake.source || '',
    questionType: mistake.questionType || 'other',
    difficulty: mistake.difficulty || 'medium',
    mastery: mistake.mastery || 0,
    reviewCount: mistake.reviewCount || 0,
    lastReviewedAt: mistake.lastReviewedAt || null,
    createdAt: mistake.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writeJsonAtomic(file, data);
  return data;
}

function deleteMistake(id) {
  const file = getMistakePath(id);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

function recordMistakeReview(id, mastery) {
  const mistake = getMistake(id);
  if (!mistake) return null;

  mistake.mastery = Math.min(5, Math.max(0, mastery));
  mistake.reviewCount = (mistake.reviewCount || 0) + 1;
  mistake.lastReviewedAt = new Date().toISOString();

  return saveMistake(id, mistake);
}

function getMistakeStats() {
  const mistakes = getMistakes();
  let totalReviews = 0;
  let masteredCount = 0;
  const subjects = new Set();

  for (const m of mistakes) {
    totalReviews += m.reviewCount || 0;
    if ((m.mastery || 0) >= 4) masteredCount++;
    if (m.subject) subjects.add(m.subject);
  }

  return {
    mistakeCount: mistakes.length,
    reviewCount: totalReviews,
    masteredCount,
    subjects: Array.from(subjects),
  };
}

function addMistakeFromExam(examId, questionIndex) {
  const exam = getExamPaper(examId);
  if (!exam || !exam.questions || !exam.questions[questionIndex]) {
    throw new Error('试卷或题目不存在');
  }

  const question = exam.questions[questionIndex];
  const id = `mistake-from-exam-${examId}-${Date.now()}`;

  return saveMistake(id, {
    question: question.question || '',
    wrongAnswer: '',
    correctAnswer: question.answer || '',
    analysis: question.explanation || '',
    subject: exam.subject || '',
    tags: [...(exam.tags || []), ...(question.tags || [])],
    sourceExam: examId,
    questionType: question.type || 'other',
    difficulty: question.difficulty || exam.difficulty || 'medium',
  });
}

// ==== Smart Exam（智能组卷） ====

// 选题池条目：{ kind: 'card'|'mistake', id, question, answer, explanation, tags, subject, difficulty, level, lastActivity, wrongAnswer?, correctAnswer? }
function buildSmartPool(subject) {
  const mastery = loadMastery();
  const now = new Date();
  const pool = [];
  let lowMasteryCards = 0;
  let dueCards = 0;
  let mistakesUsed = 0;

  const matchSubject = (entrySubject, entryTags) => {
    if (!subject) return true;
    if (entrySubject === subject) return true;
    return (entryTags || []).includes(subject);
  };

  for (const card of getCards()) {
    if (!card.question || !card.answer) continue;
    if (!matchSubject(card.subject, card.tags)) continue;
    const m = mastery[card.id] || {};
    const level = m.level ?? 0;
    const nextReview = m.nextReview ?? m['next-review'] ?? null;
    const isLow = level <= 2;
    const isDue = !!nextReview && new Date(nextReview) <= now;
    if (!isLow && !isDue) continue;
    if (isLow) lowMasteryCards++;
    if (isDue) dueCards++;
    const reviews = m.reviews || [];
    pool.push({
      kind: 'card',
      id: card.id,
      question: card.question,
      answer: card.answer,
      explanation: card.explanation || '',
      tags: card.tags || [],
      subject: card.subject || '',
      difficulty: card.difficulty,
      level,
      lastActivity: reviews.length ? reviews[reviews.length - 1].date : null,
    });
  }

  for (const mistake of getMistakes()) {
    if ((mistake.mastery || 0) > 3) continue;
    if (!matchSubject(mistake.subject, mistake.tags)) continue;
    if (!mistake.question || !mistake.correctAnswer) continue;
    mistakesUsed++;
    pool.push({
      kind: 'mistake',
      id: mistake.id,
      question: mistake.question,
      answer: mistake.correctAnswer,
      explanation: mistake.analysis || '',
      tags: mistake.tags || [],
      subject: mistake.subject || '',
      difficulty: mistake.difficulty,
      level: mistake.mastery || 0,
      lastActivity: mistake.lastReviewedAt || null,
      wrongAnswer: mistake.wrongAnswer || '',
      correctAnswer: mistake.correctAnswer,
    });
  }

  return { pool, lowMasteryCards, dueCards, mistakesUsed };
}

// 低熟练优先、最近未复习优先（从未复习过的排最前）
function sortPoolForFallback(pool) {
  return [...pool].sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    if (!a.lastActivity && !b.lastActivity) return 0;
    if (!a.lastActivity) return -1;
    if (!b.lastActivity) return 1;
    return new Date(a.lastActivity) - new Date(b.lastActivity);
  });
}

function mapCardDifficulty(d) {
  const n = parseInt(d, 10);
  if (Number.isNaN(n) || n <= 1) return 'easy';
  if (n === 2) return 'medium';
  return 'hard';
}

function poolItemToQuestion(item) {
  const q = {
    question: item.question,
    answer: item.answer,
    explanation: item.explanation || '',
    type: item.kind === 'mistake' ? '错题回顾' : '简答题',
    difficulty: item.kind === 'card' ? mapCardDifficulty(item.difficulty) : (item.difficulty || 'medium'),
    tags: item.tags || [],
  };
  if (item.kind === 'mistake') {
    q.wrongAnswer = item.wrongAnswer || '';
    q.correctAnswer = item.correctAnswer || '';
  }
  return q;
}

function buildSmartExamPrompt(pool, count) {
  const items = pool.slice(0, 20).map((item, i) => {
    const q = item.question.length > 300 ? item.question.slice(0, 300) + '…' : item.question;
    const a = item.answer.length > 300 ? item.answer.slice(0, 300) + '…' : item.answer;
    return `${i + 1}. 题干：${q}\n   答案：${a}`;
  }).join('\n');
  return `你是一位出题老师。请基于以下 ${pool.length > 20 ? 20 : pool.length} 道真实题目（来自用户的低熟练度知识卡片与历史错题），生成 ${count} 道变式题（可以改换问法、举一反三、替换数字或场景），帮助用户巩固薄弱点。

原题：
${items}

要求：
- 严格输出一个 JSON 数组，不要输出任何其他文字或 Markdown 代码块标记
- 数组共 ${count} 项，每项格式：{"question": "题干", "answer": "参考答案", "explanation": "解析", "type": "简答题|判断题|选择题|填空题", "difficulty": "easy|medium|hard", "tags": ["标签"]}
- 题目内容必须基于上面给出的原题知识点，不要编造无关内容`;
}

function parseSmartQuestions(text, count) {
  if (!text) return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const questions = [];
  for (const item of arr) {
    if (!item || typeof item.question !== 'string' || typeof item.answer !== 'string') continue;
    if (!item.question.trim() || !item.answer.trim()) continue;
    questions.push({
      question: item.question.trim(),
      answer: item.answer.trim(),
      explanation: typeof item.explanation === 'string' ? item.explanation.trim() : '',
      type: typeof item.type === 'string' && item.type.trim() ? item.type.trim() : '简答题',
      difficulty: ['easy', 'medium', 'hard'].includes(item.difficulty) ? item.difficulty : 'medium',
      tags: Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string') : [],
    });
    if (questions.length >= count) break;
  }
  return questions.length ? questions : null;
}

function uniqueSmartTitle(base) {
  const titles = new Set(getExamPapers().map(p => p.title));
  if (!titles.has(base)) return base;
  let n = 2;
  while (titles.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export async function buildSmartExam({ count = 5, subject } = {}) {
  const n = Number.isInteger(count) && count > 0 ? count : 5;
  const { pool, lowMasteryCards, dueCards, mistakesUsed } = buildSmartPool(subject);
  if (pool.length === 0) {
    throw new Error('没有足够的可组卷内容（低熟练度卡片/错题）');
  }

  // 优先 LLM 生成变式题，失败自动降级为确定性选题
  let questions = null;
  let degraded = true;
  const mcfg = readGlobalConfig().modelConfig || {};
  try {
    const llmResult = await generateSlides(buildSmartExamPrompt(pool, n), {
      apiKey: process.env.AI_PPT_API_KEY || undefined,
      baseUrl: mcfg.baseUrl || undefined,
      model: mcfg.model || undefined,
      provider: mcfg.provider || undefined,
    });
    questions = parseSmartQuestions(llmResult?.content, n);
    if (questions) degraded = false;
  } catch {
    questions = null;
  }

  if (!questions) {
    questions = sortPoolForFallback(pool).slice(0, n).map(poolItemToQuestion);
  }

  const parts = [];
  if (lowMasteryCards) parts.push(`${lowMasteryCards} 张低熟练度卡片`);
  if (dueCards) parts.push(`${dueCards} 张到期复习卡片`);
  if (mistakesUsed) parts.push(`${mistakesUsed} 道历史错题`);
  let description = `基于 ${parts.join('、') || '复习内容'} 智能组卷`;
  description += degraded ? '；无可用模型，按「低熟练优先、最近未复习优先」直接选题' : '；由模型生成变式题';

  const dateStr = new Date().toISOString().slice(0, 10);
  const exam = saveExamPaper(`exam-${Date.now()}`, {
    title: uniqueSmartTitle(`智能测验 ${dateStr}`),
    subject: subject || '智能组卷',
    description,
    questions,
    tags: ['智能组卷'],
  });

  return {
    exam,
    meta: {
      poolSize: pool.length,
      lowMasteryCards,
      dueCards,
      mistakesUsed,
      degraded,
    },
  };
}

// ==== CLI ====
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  switch (command) {
    case 'list': {
      const papers = getExamPapers();
      console.log(`测验：${papers.length} 份`);
      for (const p of papers) {
        console.log(`- ${p.title}（${p.subject || '未分类'}，${(p.questions || []).length} 题）`);
      }
      break;
    }
    case 'list-mistakes': {
      const mistakes = getMistakes();
      console.log(`错题：${mistakes.length} 道`);
      for (const m of mistakes) {
        console.log(`- ${(m.question || '').slice(0, 40)}（${m.subject || '未分类'}，熟练度 ${m.mastery || 0}/5）`);
      }
      break;
    }
    case 'stats': {
      const examStats = getExamStats();
      const mistakeStats = getMistakeStats();
      console.log(`测验：${examStats.examCount} 份，共 ${examStats.questionCount} 题`);
      console.log(`错题：${mistakeStats.mistakeCount} 道，已掌握 ${mistakeStats.masteredCount} 道，累计复习 ${mistakeStats.reviewCount} 次`);
      const subjects = [...new Set([...examStats.subjects, ...mistakeStats.subjects])];
      console.log(`分类：${subjects.join('、') || '无'}`);
      break;
    }
    case 'smart': {
      const raw = parseInt(process.argv[3], 10);
      const count = Number.isInteger(raw) && raw > 0 ? raw : undefined;
      buildSmartExam({ count }).then(({ exam, meta }) => {
        console.log(`智能组卷完成：${exam.title}（${exam.id}）`);
        console.log(`题目：${exam.questions.length} 道｜题池 ${meta.poolSize}｜低熟练卡片 ${meta.lowMasteryCards}｜到期卡片 ${meta.dueCards}｜历史错题 ${meta.mistakesUsed}`);
        console.log(`模式：${meta.degraded ? '确定性选题（无可用模型）' : 'LLM 变式题'}`);
        for (const [i, q] of exam.questions.entries()) {
          console.log(`${i + 1}. ${q.question.slice(0, 50)}`);
        }
      }).catch((err) => {
        console.error(err.message);
        process.exit(1);
      });
      break;
    }
    default:
      console.log('Usage: node scripts/exam-papers.mjs [list|list-mistakes|stats|smart [count]]');
  }
}

// ==== Export ====
export {
  getExamPapers,
  getExamPaper,
  saveExamPaper,
  deleteExamPaper,
  getExamStats,
  getMistakes,
  getMistake,
  saveMistake,
  deleteMistake,
  recordMistakeReview,
  getMistakeStats,
  addMistakeFromExam,
};
