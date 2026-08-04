#!/usr/bin/env node
// scripts/generate-unified.mjs — 统一生成矩阵：上下文 × 输出类型的交叉分发。
// 上下文 context.kind ∈ topic | note | selection（选字/选句）
// 输出类型 outputType ∈ ppt | image | video
// 在执行前查询资源库注册表（resource-registry），命中则直接返回已有资产，避免重复生成。
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { listNotes, readNote, parseFrontMatter, getNotePath, ensureVaultDirs } from './vault.mjs';
import { getProjectDir, writeConfig, writeDeckIndex, sanitizeProjectName, assertSafeProjectName } from './config.mjs';
import { snapshotBeforeGenerate } from './snapshot.mjs';
import {
  emit, emitError, emitDone, stripMarkdown, buildModelOptions, getEffectiveTheme,
  buildSlidesPrompt, buildFallbackSlides as renderFallbackSlides, generateSlidesHtml,
} from './generation-common.mjs';
import { lintAfterGenerate } from './design-lint.mjs';
import { captureCover } from './deck-capture.mjs';
import { readGlobalConfig } from './global-config.mjs';
import { generateImage, generateVideo } from './media-gen.mjs';
import { findAsset, registerAsset, ensureResourceDir } from './resource-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VAULT_DIR = path.join(ROOT, 'vault');

// ---- 上下文收集：从 topic / note / selection 提取文本内容 ----

function collectTopicContent(topicPath) {
  // 收集专题下的所有笔记正文（去 Front Matter）
  const notes = listNotes();
  const topicNotes = notes.filter((n) => n.topic === topicPath);
  if (topicNotes.length === 0) return null;

  let content = '';
  for (const note of topicNotes) {
    const raw = readNote(note.name);
    if (!raw) continue;
    const { frontMatter, content: body } = parseFrontMatter(raw);
    content += `\n\n【${frontMatter.title || note.name}】\n${stripMarkdown(body.trim())}`;
  }
  return stripMarkdown(content).trim();
}

function collectNoteContent(noteName) {
  const raw = readNote(noteName);
  if (!raw) throw new Error(`笔记 "${noteName}" 不存在`);
  const { frontMatter, content: body } = parseFrontMatter(raw);
  return { title: frontMatter.title || noteName.split('/').pop() || noteName, content: stripMarkdown(body.trim()) };
}

function collectSelectionContent(selection) {
  // selection 可以是纯文本或 { text, source?, context? }
  if (typeof selection === 'string') return { title: '选区内容', content: stripMarkdown(selection.trim()) };
  const text = typeof selection?.text === 'string' ? selection.text : '';
  if (!text.trim()) throw new Error('选中内容为空');
  return {
    title: selection.title || (selection.source ? `${path.basename(selection.source)} - 选区` : '选区内容'),
    content: stripMarkdown(text.trim()),
  };
}

// ---- PPT 生成（复用 generation-common 的管线） ----

function buildPptPrompt(content, context, options = {}) {
  const title = options.title || (context.kind === 'note' ? context.noteName.split('/').pop() : null) || '生成的演示文稿';
  const slideCount = Math.min(Math.max(options.slideCount || 8, 3), 20);

  let taskDesc;
  if (context.kind === 'topic') {
    taskDesc = `请根据以下专题 "${context.topicPath}" 下的全部笔记内容，生成一套结构清晰、论述完整的演示文稿。`;
  } else if (context.kind === 'note') {
    taskDesc = `请根据以下知识库笔记内容生成一套演示文稿，每个要点作为一个或多个幻灯片展开。`;
  } else {
    // selection
    taskDesc = `请将以下选中文本整理为一页或多页演示文稿幻灯片，用简洁的标题、要点和适当的可视化表达。`;
  }

  const contentLabel = context.kind === 'topic' ? '专题内容' : (context.kind === 'note' ? '笔记内容' : '选中文本');

  return {
    title,
    slideCount,
    prompt: buildSlidesPrompt({
      task: taskDesc,
      title,
      audience: options.audience || '通用',
      style: context.kind === 'topic' ? '知识梳理' : (context.kind === 'note' ? '商业汇报' : '要点总结'),
      language: options.language || 'zh-CN',
      slideCount,
      contentLabel,
      content: stripMarkdown(content),
    }),
  };
}

function buildPptFallback(title, content) {
  const paras = String(content).split(/\n{2,}/).filter((p) => p.trim().length > 10);
  const sections = paras.slice(0, 6).map((para) => {
    const lines = para.split('\n').filter(Boolean).slice(0, 3);
    return {
      heading: lines[0]?.slice(0, 40) || '要点',
      lead: lines.slice(1).map((l) => l.slice(0, 150)),
    };
  });
  if (sections.length === 0 && content.trim()) {
    sections.push({ heading: title, lead: [content.trim().slice(0, 200)] });
  }
  return renderFallbackSlides({ title, closingTitle: '谢谢', sections });
}

async function generatePpt(context, options = {}) {
  // 收集内容
  let content;
  if (context.kind === 'topic') {
    content = collectTopicContent(context.topicPath);
    if (!content) throw new Error(`专题 "${context.topicPath}" 下没有笔记`);
  } else if (context.kind === 'note') {
    const info = collectNoteContent(context.noteName);
    content = info.content;
    options.title = options.title || info.title;
  } else {
    const sel = collectSelectionContent(context.selection);
    content = sel.content;
    options.title = options.title || sel.title;
  }

  // 生成项目名
  let projectName = options.projectName;
  if (!projectName) {
    if (context.kind === 'topic') projectName = `专题-${sanitizeProjectName(context.topicPath)}`;
    else if (context.kind === 'note') projectName = sanitizeProjectName(context.noteName);
    else projectName = sanitizeProjectName(options.title || '选区PPT');
  }
  assertSafeProjectName(projectName);

  emit('start', `从 ${describeContext(context)} 生成 PPT：${projectName}`);

  // 构建提示词 + LLM 生成幻灯片 HTML
  const promptData = buildPptPrompt(content, context, options);
  emit('prompt', `已构建提示词，标题：${promptData.title}，约 ${promptData.slideCount} 页`);

  const modelOptions = buildModelOptions(options.model);
  const slidesHtml = await generateSlidesHtml({
    prompt: promptData.prompt,
    modelOptions,
    minSections: context.kind === 'selection' ? 1 : 3,
    buildFallback: () => buildPptFallback(promptData.title, content),
  });

  // 写入项目（snapshot + writeDeckIndex）
  emit('create', `创建项目目录：${getProjectDir(projectName)}`);
  // 主题优先级：笔记 FrontMatter theme → options.theme → 默认 web-ui
  let frontMatter = null;
  if (context.kind === 'note') {
    const raw = readNote(context.noteName);
    if (raw) ({ frontMatter } = parseFrontMatter(raw));
  } else if (context.kind === 'topic' && context.topicPath) {
    // 使用专题下第一篇笔记的主题（若一致）
    const notes = listNotes();
    const topicNote = notes.find((n) => n.topic === context.topicPath);
    if (topicNote) {
      const raw = readNote(topicNote.name);
      if (raw) ({ frontMatter } = parseFrontMatter(raw));
    }
  }
  const theme = getEffectiveTheme(frontMatter, options);
  const animation = options.animation || 'slide';
  snapshotBeforeGenerate(projectName);
  writeDeckIndex(projectName, slidesHtml, {
    title: promptData.title,
    bodyClass: `theme-${theme} anim-${animation}`,
  });

  // 配置写入：记录来源上下文，实现 PPT ↔ 笔记双向绑定
  const sourceSelection = buildSourceSelection(context);
  const cfg = {
    name: projectName,
    title: promptData.title,
    status: 'ready',
    lastGeneratedAt: new Date().toISOString(),
    errorMessage: null,
    ...buildSourceConfig(context),
    sourceSelection,
    params: {
      title: promptData.title,
      audience: options.audience || (context.kind === 'topic' ? '普通听众' : (context.kind === 'note' ? '通用' : '收件人')),
      style: context.kind === 'topic' ? '知识梳理' : (context.kind === 'note' ? '商业汇报' : '要点总结'),
      slideCount: promptData.slideCount,
      language: options.language || 'zh-CN',
      theme, animation,
    },
  };
  writeConfig(projectName, cfg);

  // 后处理：设计检查 + 封面捕获
  lintAfterGenerate(projectName, emit);
  await captureCover(projectName);

  emit('done', `PPT 生成完成！项目：${projectName}`);
  emitDone();
  return { projectName, dir: getProjectDir(projectName) };
}

// ---- 图片生成（检查资源库 → 命中直接返回 / 未命中调用 media-gen 并注册） ----

async function generateImageFromContext(context, options = {}) {
  let prompt;
  if (options.prompt) {
    prompt = options.prompt;
  } else if (context.kind === 'note') {
    const info = collectNoteContent(context.noteName);
    // 取笔记标题 + 前 200 字作为生图提示词
    prompt = `${info.title}，${stripMarkdown(info.content).slice(0, 200)}`;
  } else if (context.kind === 'selection') {
    const sel = collectSelectionContent(context.selection);
    prompt = stripMarkdown(sel.content.slice(0, 300));
  } else {
    // topic — 用专题名 + 内容摘要
    const content = collectTopicContent(context.topicPath) || '';
    prompt = `主题：${context.topicPath}；内容：${stripMarkdown(content).slice(0, 200)}`;
  }

  emit('start', '生成配图');
  // 检查资源库：是否有匹配的已有图片
  const existing = findAsset('image', prompt);
  if (existing) {
    emit('resource-hit', `命中已有资源：${existing.fileName}`);
    return { filePath: existing.filePath, webPath: existing.webPath, reused: true };
  }

  // 未命中 — 调用 media-gen 生成新图，落盘到 vault/assets/ 并注册
  ensureResourceDir();
  const outPath = path.join(VAULT_DIR, 'assets', `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  emit('generate-image', '调用生成后端，产出新图片');

  // 使用 media-gen 的 generateImage（自动降级：arkcli → bailian → openai）
  const cfg = readGlobalConfig().imageModelConfig || {};
  const result = await generateImage(prompt, {
    provider: options.provider || cfg.provider,
    model: options.model || cfg.model,
    baseUrl: options.baseUrl || cfg.baseUrl,
    apiKey: options.apiKey,
    outPath,
    onProgress: options.onProgress,
  });
  if (!result || !result.filePath) throw new Error('图片生成失败或所有 provider 不可用');

  // 注册到资源库
  registerAsset({
    type: 'image',
    prompt,
    fileName: path.basename(result.filePath),
    filePath: result.filePath,
    webPath: `/api/vault/assets/${encodeURIComponent(path.basename(result.filePath))}`,
    tags: context.kind === 'topic' ? ['topic'] : (context.kind === 'note' ? ['note'] : ['selection']),
  });

  emit('done', `配图生成完成：${result.filePath}`);
  return { filePath: result.filePath, webPath: `/api/vault/assets/${encodeURIComponent(path.basename(result.filePath))}`, reused: false };
}

// ---- 视频生成（检查资源库 → 命中直接返回 / 未命中调用 media-gen 并注册） ----

async function generateVideoFromContext(context, options = {}) {
  let prompt;
  if (options.prompt) {
    prompt = options.prompt;
  } else if (context.kind === 'note') {
    const info = collectNoteContent(context.noteName);
    // 取笔记标题 + 前 500 字作为视频脚本
    prompt = `以"${info.title}"为主题，讲述：${stripMarkdown(info.content).slice(0, 500)}`;
  } else if (context.kind === 'selection') {
    const sel = collectSelectionContent(context.selection);
    prompt = stripMarkdown(sel.content.slice(0, 500));
  } else {
    // topic — 用专题内容生成概述视频
    const content = collectTopicContent(context.topicPath) || '';
    prompt = `介绍主题：${context.topicPath}。${stripMarkdown(content).slice(0, 300)}`;
  }

  emit('start', '生成配视频');
  // 检查资源库
  const existing = findAsset('video', prompt);
  if (existing) {
    emit('resource-hit', `命中已有资源：${existing.fileName}`);
    return { filePath: existing.filePath, webPath: `/api/vault/assets/${encodeURIComponent(path.basename(existing.filePath))}`, reused: true };
  }

  // 未命中 — 调用 media-gen 生成新视频，落盘到 vault/assets/ 并注册
  ensureResourceDir();
  const outPath = path.join(VAULT_DIR, 'assets', `video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
  emit('generate-video', '调用生成后端，产出新视频');

  let progressMsg = '';
  const result = await generateVideo(prompt, { ...options, onProgress: (msg) => { progressMsg = msg; } });
  if (!result || !result.filePath) throw new Error('视频生成失败或所有 provider 不可用');

  // 注册到资源库
  registerAsset({
    type: 'video',
    prompt,
    fileName: path.basename(result.filePath),
    filePath: result.filePath,
    webPath: `/api/vault/assets/${encodeURIComponent(path.basename(result.filePath))}`,
    tags: context.kind === 'topic' ? ['topic'] : (context.kind === 'note' ? ['note'] : ['selection']),
  });

  emit('done', `视频生成完成：${result.filePath}`);
  return { filePath: result.filePath, webPath: `/api/vault/assets/${encodeURIComponent(path.basename(result.filePath))}`, reused: false };
}

// ---- 上下文描述与来源配置构建 ----

function describeContext(context) {
  if (context.kind === 'topic') return `专题 "${context.topicPath}"`;
  if (context.kind === 'note') return `笔记 "${context.noteName}"`;
  return '选中文本';
}

// 为 PPT 配置写入 sourceType/sourceNote/sourceSelection 等字段，实现双向绑定
function buildSourceConfig(context) {
  const base = { articleText: '' };
  if (context.kind === 'topic') {
    Object.assign(base, {
      sourceType: 'vault-topic',
      topicPath: context.topicPath,
    });
  } else if (context.kind === 'note') {
    Object.assign(base, {
      sourceType: 'vault-note',
      sourceNote: context.noteName,
    });
  } else {
    // selection — 没有持久化的笔记来源，用临时标记
    Object.assign(base, {
      sourceType: 'selection',
      sourceSelection: buildSourceSelection(context),
    });
  }
  return base;
}

// sourceSelection 持久化选区上下文，供 PPT-笔记同步查找使用
function buildSourceSelection(context) {
  if (context.kind === 'topic') {
    return { kind: 'topic', topicPath: context.topicPath };
  }
  if (context.kind === 'note') {
    return { kind: 'note', noteName: context.noteName, selection: context.selection || null };
  }
  // selection from any source (may be a specific line range in a note)
  const sel = typeof context.selection === 'object' ? context.selection : {};
  return {
    kind: 'selection',
    sourceNote: sel.sourceNote || null,
    text: typeof context.selection === 'string' ? context.selection : (sel.text || ''),
    startOffset: sel.startOffset || null,
    endOffset: sel.endOffset || null,
  };
}

// ---- 统一分发入口 ----

export async function generateUnified(context, outputType, options = {}) {
  if (!context || !context.kind) throw new Error('必须提供 context.kind');
  if (!['topic', 'note', 'selection'].includes(context.kind)) {
    throw new Error(`不支持的上下文类型: ${context.kind}`);
  }
  if (context.kind === 'topic' && !context.topicPath) throw new Error('专题生成缺少 topicPath');
  if (context.kind === 'note' && !context.noteName) throw new Error('笔记生成缺少 noteName');
  if (context.kind === 'selection') {
    const text = typeof context.selection === 'string' ? context.selection : context.selection?.text;
    if (!text || !text.trim()) throw new Error('选区生成缺少 selection.text');
  }

  switch (outputType) {
    case 'ppt': return generatePpt(context, options);
    case 'image': return generateImageFromContext(context, options);
    case 'video': return generateVideoFromContext(context, options);
    default: throw new Error(`不支持的输出类型: ${outputType}`);
  }
}

// ---- CLI ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = 'Usage:\n' +
    '  node scripts/generate-unified.mjs ppt <topic|note:name|selection> [project-name]\n' +
    '  node scripts/generate-unified.mjs image <topic|note:name|selection> [--prompt X]\n' +
    '  node scripts/generate-unified.mjs video <topic|note:name|selection>\n\n' +
    'Context:\n' +
    '  topic:产品方法论          生成专题下全部笔记的 PPT/图/视频\n' +
    '  note:需求分析             从指定笔记生成\n' +
    '  selection                从 stdin 读取选中文本生成';

  const outputType = args[0];
  const contextArg = args[1];
  if (!outputType || !contextArg) { console.error(usage); process.exit(1); }

  let context;
  if (contextArg.startsWith('topic:')) {
    context = { kind: 'topic', topicPath: contextArg.slice(6) };
  } else if (contextArg.startsWith('note:')) {
    context = { kind: 'note', noteName: contextArg.slice(5) };
  } else if (contextArg === 'selection') {
    // 从 stdin 读取选中文本
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    context = { kind: 'selection', selection: Buffer.concat(chunks).toString('utf8').trim() };
  } else {
    console.error(`无法解析上下文: ${contextArg}`);
    process.exit(1);
  }

  const options = {};
  // 简单参数解析
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--prompt') options.prompt = args[++i];
    else if (args[i] === '--slides' && outputType === 'ppt') options.slideCount = Number(args[++i]);
    else if (args[i] === '--title') options.title = args[++i];
  }

  // PPT 的 project-name 从位置参数获取（第二个非选项参数）
  if (outputType === 'ppt') {
    for (let i = 2; i < args.length; i++) {
      if (!args[i].startsWith('--')) options.projectName = args[i];
    }
  }

  generateUnified(context, outputType, options).catch((e) => {
    emitError(e.message);
    process.exit(1);
  });
}
