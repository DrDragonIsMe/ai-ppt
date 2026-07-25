#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { listNotes, readNote, normalizeNoteName } from './vault.mjs';
import { parseWikiLinks } from './link-resolver.mjs';
import { getCards } from './knowledge-cards.mjs';
import {
  getProjectDir,
  writeConfig,
  writeDeckIndex,
  assertSafeProjectName,
  sanitizeProjectName,
} from './config.mjs';
import {
  emit,
  emitError,
  emitDone,
  stripMarkdown,
  buildModelOptions,
  buildSlidesPrompt,
  buildFallbackSlides as renderFallbackSlides,
  generateSlidesHtml,
} from './generation-common.mjs';
import { lintAfterGenerate } from './design-lint.mjs';
import { captureCover } from './deck-capture.mjs';

const __filename = fileURLToPath(import.meta.url);

// assertSafeProjectName 和 sanitizeProjectName 现在从 config.mjs 导入

// 去掉 Front Matter，只保留正文
function stripFrontMatter(content) {
  return String(content || '').replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

// 卡片标题/标签与节点名匹配（大小写不敏感），与 knowledge-graph.mjs 的 matchesNode 一致
function cardMatchesNodes(card, nodeIds) {
  const title = String(card.title || '').toLowerCase();
  if (title && nodeIds.includes(title)) return true;
  const tags = Array.isArray(card.tags) ? card.tags : [];
  return tags.some((t) => nodeIds.includes(String(t).toLowerCase()));
}

// 收集选区内容：选中笔记正文 + 它们的出链笔记正文（一跳）+ 标题/标签命中节点名的知识卡片
function collectGraphContent(nodeNames) {
  const notes = listNotes();
  const byId = new Map(notes.map((n) => [normalizeNoteName(n.name), n]));

  const selected = []; // { id, name, content, outlinks: [name] }
  const outlinkSections = []; // { name, content }
  const seen = new Set();

  for (const raw of nodeNames) {
    const id = normalizeNoteName(raw);
    const note = byId.get(id);
    if (!note || seen.has(id)) continue;
    seen.add(id);
    const content = stripFrontMatter(readNote(note.name) || '').trim();
    const outlinks = [];
    for (const link of parseWikiLinks(content)) {
      const target = byId.get(link.targetNormalized);
      if (!target || seen.has(link.targetNormalized)) continue;
      seen.add(link.targetNormalized);
      outlinks.push(target.name);
      outlinkSections.push({
        name: target.name,
        content: stripFrontMatter(readNote(target.name) || '').trim(),
      });
    }
    selected.push({ id, name: note.name, content, outlinks });
  }

  const nodeIds = selected.map((s) => s.id);
  const cards = nodeIds.length ? getCards().filter((c) => cardMatchesNodes(c, nodeIds)) : [];

  return { selected, outlinkSections, cards };
}

// 把收集到的内容整理成纯文本素材
function buildContentText({ selected, outlinkSections, cards }) {
  const parts = [];
  for (const s of selected) {
    parts.push(`【笔记】${s.name}\n${s.content}`);
  }
  for (const s of outlinkSections) {
    parts.push(`【关联笔记】${s.name}\n${s.content}`);
  }
  for (const [i, card] of cards.entries()) {
    const lines = [`【卡片 ${i + 1}】${card.title}`];
    if (card.tags && card.tags.length) lines.push(`标签：${card.tags.join('、')}`);
    if (card.question) lines.push(`问题：${card.question}`);
    if (card.answer) lines.push(`答案：${card.answer}`);
    if (card.explanation) lines.push(`解析：${card.explanation}`);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

// 构建提示词（统一脚手架；本源的差异在任务描述与素材标签）
function buildPrompt(content, nodeNames, cardCount, params = {}) {
  const title = params.title || `星图选区 · ${nodeNames.slice(0, 3).join('、')}`;
  const audience = params.audience || '复习者';
  const style = params.style || '知识梳理';
  const language = params.language || 'zh-CN';
  // 页数按内容数量合理取值：封面 + 每个节点一节 + 卡片页 + 结尾
  const slideCount = params.slideCount
    || Math.min(Math.max(nodeNames.length + (cardCount ? 1 : 0) + 2, 5), 15);

  return {
    title,
    audience,
    style,
    slideCount,
    language,
    content,
    prompt: buildSlidesPrompt({
      task: '请把以下知识星图选区内容整理成一套课件：以每个选中的笔记为一节，讲清核心要点；关联笔记作为补充；知识卡片提炼为问答回顾页。',
      title,
      audience,
      style,
      language,
      slideCount,
      contentLabel: '选区素材',
      content: stripMarkdown(content),
    }),
  };
}

// 确定性兜底模板：封面 + 每个节点一节 + 关联卡片页 + 结尾，全部使用真实内容
function buildFallbackSlides(title, { selected, cards }) {
  const sections = selected.map((s) => ({
    heading: s.name,
    lead: stripMarkdown(s.content).replace(/\s+/g, ' ').slice(0, 200) || undefined,
    note: s.outlinks.length ? `关联笔记：${s.outlinks.join('、')}` : undefined,
  }));
  if (cards.length) {
    sections.push({
      heading: '关联知识卡片',
      tiles: cards.slice(0, 6).map((card) => ({ title: card.title, text: card.question })),
    });
  }
  return renderFallbackSlides({
    title,
    subtitle: `共 ${selected.length} 个选区节点${cards.length ? ` · ${cards.length} 张关联卡片` : ''}`,
    closingTitle: '梳理完毕',
    sections,
  });
}

// 主函数：从知识星图选区生成 PPT 项目
async function generateFromGraph(projectName, nodeNames, options = {}) {
  if (!Array.isArray(nodeNames) || nodeNames.length === 0) {
    throw new Error('请至少提供一个星图节点');
  }

  // 确定项目名并校验
  projectName = sanitizeProjectName(projectName || `星图-${nodeNames[0]}`);
  assertSafeProjectName(projectName);

  emit('start', `从星图选区（${nodeNames.length} 个节点）生成 PPT 项目 "${projectName}"`);

  // 收集选区内容
  const collected = collectGraphContent(nodeNames);
  const content = buildContentText(collected);
  if (!stripMarkdown(content)) {
    emitError('选区内容为空：节点不存在且没有匹配的知识卡片');
    process.exit(1);
  }
  const nodeLabel = collected.selected.map((s) => s.name);
  emit('extract', `已收集 ${collected.selected.length} 篇笔记、${collected.outlinkSections.length} 篇出链笔记、${collected.cards.length} 张知识卡片`);

  // 构建提示词
  const promptData = buildPrompt(content, nodeLabel.length ? nodeLabel : nodeNames, collected.cards.length, options);
  emit('prompt', `已构建提示词，标题：${promptData.title}，约 ${promptData.slideCount} 页`);

  // 调用 LLM 生成（无 LLM 或结果不足时走统一兜底模板）
  const modelOptions = buildModelOptions(options.model);
  const slidesHtml = await generateSlidesHtml({
    prompt: promptData.prompt,
    modelOptions,
    minSections: 3,
    buildFallback: () => buildFallbackSlides(promptData.title, collected),
  });

  // 创建项目目录（writeDeckIndex 内部完成 mkdir + 复制基座引擎 + 写入 index.html）
  const projectDir = getProjectDir(projectName);
  emit('create', `创建项目目录：${projectDir}`);

  // 写入 HTML（body class 用 theme-<t> anim-<a> 写法，与 generate-from-review 一致）
  emit('write', '写入 index.html');
  const theme = options.theme || 'web-ui';
  const animation = options.animation || 'slide';
  writeDeckIndex(projectName, slidesHtml, {
    title: promptData.title,
    bodyClass: `theme-${theme} anim-${animation}`,
  });

  // 创建配置
  const cfg = {
    name: projectName,
    sourceType: 'vault-graph',
    sourceUrl: '',
    sourceNodes: nodeLabel.length ? nodeLabel : nodeNames,
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
  generateFromGraph,
  collectGraphContent,
  buildPrompt,
  buildFallbackSlides,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectName = process.argv[2];
  const nodesArg = process.argv[3];

  if (!projectName || !nodesArg) {
    console.error('Usage: node scripts/generate-from-graph.mjs <project-name> <node1,node2,...>');
    process.exit(1);
  }

  const nodeNames = nodesArg.split(',').map((s) => s.trim()).filter(Boolean);
  if (nodeNames.length === 0) {
    emitError('请至少提供一个星图节点');
    process.exit(1);
  }

  generateFromGraph(projectName, nodeNames).catch((e) => {
    emitError(e.message);
    process.exit(1);
  });
}
