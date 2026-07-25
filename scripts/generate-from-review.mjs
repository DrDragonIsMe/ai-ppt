#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { getCards } from './knowledge-cards.mjs';
import { getMistakes } from './exam-papers.mjs';
import {
  getProjectDir,
  writeConfig,
  writeDeckIndex,
  assertSafeProjectName,
  sanitizeProjectName,
} from './config.mjs';
import {
  emit, emitError, emitDone,
  stripMarkdown,
  buildModelOptions,
  buildBodyClass,
  buildSlidesPrompt,
  buildFallbackSlides as renderFallbackSlides,
  generateSlidesHtml,
} from './generation-common.mjs';
import { lintAfterGenerate } from './design-lint.mjs';
import { captureCover } from './deck-capture.mjs';

const __filename = fileURLToPath(import.meta.url);

// 把知识卡片整理成纯文本素材
function buildCardsContent(cards) {
  return cards.map((card, i) => {
    const parts = [`【卡片 ${i + 1}】${card.title}`];
    if (card.subject) parts.push(`分类：${card.subject}`);
    if (card.tags && card.tags.length) parts.push(`标签：${card.tags.join('、')}`);
    if (card.question) parts.push(`问题：${card.question}`);
    if (card.answer) parts.push(`答案：${card.answer}`);
    if (card.explanation) parts.push(`解析：${card.explanation}`);
    return parts.join('\n');
  }).join('\n\n');
}

// 把错题整理成纯文本素材
function buildMistakesContent(mistakes) {
  return mistakes.map((m, i) => {
    const parts = [`【错题 ${i + 1}】`];
    if (m.subject) parts.push(`分类：${m.subject}`);
    if (m.question) parts.push(`题干：${m.question}`);
    if (m.wrongAnswer) parts.push(`错误答案：${m.wrongAnswer}`);
    if (m.correctAnswer) parts.push(`正确答案：${m.correctAnswer}`);
    if (m.analysis) parts.push(`解析：${m.analysis}`);
    return parts.join('\n');
  }).join('\n\n');
}

// 构建提示词（统一脚手架；本源的差异在任务描述与素材标签）
function buildPrompt(type, items, params = {}) {
  const isCards = type === 'cards';
  const title = params.title || (isCards ? '知识卡片复习' : '错题讲解复习');
  const audience = params.audience || '复习者';
  const style = params.style || '教学讲解';
  const language = params.language || 'zh-CN';
  // 页数按内容数量合理取值：封面 + 内容页 + 结尾
  const slideCount = params.slideCount
    || Math.min(Math.max(items.length + 2, 5), 15);
  const content = isCards ? buildCardsContent(items) : buildMistakesContent(items);

  const task = isCards
    ? '请把以下知识卡片整理成一套复习课件：按主题归类，每张卡片提炼问题与答案要点，适合考前快速回顾。'
    : '请把以下错题整理成一套错题讲解课件：每道错题讲清题干、错因（错误答案错在哪）和正确解法，适当归纳共性问题。';

  return {
    title,
    audience,
    style,
    slideCount,
    language,
    content,
    prompt: buildSlidesPrompt({
      task,
      title,
      audience,
      style,
      language,
      slideCount,
      contentLabel: '复习素材',
      content: stripMarkdown(content),
    }),
  };
}

// 确定性兜底模板：用真实卡片/错题数据，不编造
function buildFallbackSlides(type, title, items) {
  const sections = items.map((item) => type === 'cards'
    ? {
      heading: item.title,
      lead: item.question ? `问：${item.question.slice(0, 150)}` : undefined,
      paragraphs: item.answer ? [`答：${item.answer.slice(0, 200)}`] : undefined,
      note: item.explanation ? item.explanation.slice(0, 150) : undefined,
    }
    : {
      heading: (item.question || '错题').slice(0, 40),
      lead: item.wrongAnswer ? `错因：${item.wrongAnswer.slice(0, 120)}` : undefined,
      paragraphs: item.correctAnswer ? [`正确解法：${item.correctAnswer.slice(0, 200)}`] : undefined,
      note: item.analysis ? item.analysis.slice(0, 150) : undefined,
    });
  return renderFallbackSlides({
    title,
    subtitle: `共 ${items.length} ${type === 'cards' ? '张知识卡片' : '道错题'}`,
    closingTitle: '复习完毕',
    sections,
  });
}

// 主函数：从复习内容（知识卡片/错题集）生成 PPT 项目
async function generateFromReview(type, projectName, options = {}) {
  if (type !== 'cards' && type !== 'mistakes') {
    throw new Error(`未知复习类型：${type}（仅支持 cards / mistakes）`);
  }

  // 读取复习素材
  const items = type === 'cards' ? getCards() : getMistakes();
  if (!items || items.length === 0) {
    throw new Error(type === 'cards' ? '知识卡片为空，无法生成复习 PPT' : '错题集为空，无法生成复习 PPT');
  }

  // 确定项目名并校验
  if (!projectName) {
    projectName = sanitizeProjectName(type === 'cards' ? '复习-知识卡片' : '复习-错题集');
  }
  projectName = sanitizeProjectName(projectName);
  assertSafeProjectName(projectName);

  emit('start', `从${type === 'cards' ? `知识卡片（${items.length} 张）` : `错题集（${items.length} 道）`}生成复习 PPT 项目 "${projectName}"`);

  // 构建提示词
  const promptData = buildPrompt(type, items, options);
  emit('prompt', `已构建提示词，标题：${promptData.title}，约 ${promptData.slideCount} 页`);

  // 调用 LLM 生成（无 LLM 或结果不足时走统一兜底模板）
  const modelOptions = buildModelOptions(options.model);
  const slidesHtml = await generateSlidesHtml({
    prompt: promptData.prompt,
    modelOptions,
    minSections: 3,
    buildFallback: () => buildFallbackSlides(type, promptData.title, items),
  });

  // 创建项目目录（writeDeckIndex 内部完成 mkdir + 复制基座引擎 + 写入 index.html）
  const projectDir = getProjectDir(projectName);
  emit('create', `创建项目目录：${projectDir}`);

  // 写入 HTML
  emit('write', '写入 index.html');
  writeDeckIndex(projectName, slidesHtml, {
    title: promptData.title,
    bodyClass: buildBodyClass(options),
  });

  // 创建配置
  const cfg = {
    name: projectName,
    sourceType: type === 'cards' ? 'vault-cards' : 'vault-mistakes',
    sourceUrl: '',
    articleText: promptData.content,
    params: {
      title: promptData.title,
      audience: promptData.audience,
      style: promptData.style,
      slideCount: promptData.slideCount,
      language: promptData.language,
    },
    status: 'ready',
    lastGeneratedAt: new Date().toISOString(),
    errorMessage: null,
  };
  writeConfig(projectName, cfg);

  lintAfterGenerate(projectName, emit);
  await captureCover(projectName); // 顺手更新封面（静默失败，不阻断生成）
  emit('done', `生成完成！项目：${projectName}`);
  emitDone();

  return { projectName, projectDir };
}

export {
  generateFromReview,
  buildPrompt,
  buildCardsContent,
  buildMistakesContent,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const type = process.argv[2];
  const projectName = process.argv[3];

  if (!type || !projectName || (type !== 'cards' && type !== 'mistakes')) {
    console.error('Usage: node scripts/generate-from-review.mjs <cards|mistakes> <project-name>');
    process.exit(1);
  }

  generateFromReview(type, projectName).catch(e => {
    emitError(e.message);
    process.exit(1);
  });
}
