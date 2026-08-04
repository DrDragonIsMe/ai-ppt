#!/usr/bin/env node
// scripts/generate-note-from-deck.mjs — P6: 从 PPT 反向生成笔记
// 用于没有来源笔记的 PPT，或同步更新已有笔记内容。
// 用法：node scripts/generate-note-from-deck.mjs <projectName> [noteName] [--overwrite]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { readConfig, getProjectDir } from './config.mjs';
import { readNote, writeNote, createNote, stringifyFrontMatter, ensureVaultDirs } from './vault.mjs';
import { generateSlides } from './llm-adapter.mjs';
import { emit, emitError, emitDone, stripMarkdown, buildModelOptions } from './generation-common.mjs';
import { captureCover } from './deck-capture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 从 PPT index.html 提取幻灯片文本内容（标题 + 要点）
function extractDeckText(html) {
  const $ = load(html);
  const slides = $('main.stage > section.slide, .slide');
  let textParts = [];
  slides.each((_, el) => {
    const slideTitle = $(el).find('h1, h2, h3').first().text().trim();
    if (slideTitle) textParts.push(`## ${slideTitle}`);

    // 提取要点列表
    const bullets = [];
    $(el).find('.bullet-item, li').each((_, li) => {
      const txt = $(li).text().trim();
      if (txt && !bullets.includes(txt)) bullets.push(txt);
    });
    for (const b of bullets) textParts.push(`- ${b}`);

    // 提取段落文本（非列表项）
    $(el).find('p').each((_, p) => {
      const txt = $(p).text().trim();
      if (txt && !txt.startsWith('-') && !bullets.includes(txt)) textParts.push(txt);
    });

    // 提取 big-number 等特殊元素
    $(el).find('.big-number').each((_, bn) => {
      const txt = $(bn).text().trim();
      if (txt) textParts.push(`**${txt}**`);
    });
  });
  return stripMarkdown(textParts.join('\n')).trim();
}

// 生成笔记正文：调用 LLM 将 PPT 文本结构化为笔记
async function generateNoteContent(deckText, projectName, cfg) {
  const title = cfg.params?.title || projectName;
  const prompt = `请将以下 PPT 幻灯片内容整理为一篇结构清晰的知识库笔记，使用 Markdown 格式。\n\n` +
    `PPT 标题：${title}\n\n` +
    `PPT 内容（已提取的文本）：\n${deckText.slice(0, 8000)}\n\n` +
    `要求：\n1. 生成一个引言段落总结主题\n2. 按 PPT 的逻辑顺序整理为多个带标题的章节，每个章节包含要点和解释\n3. 使用 Markdown 的 ## 和 ### 结构\n4. 如果有数据/数字，用 **加粗** 强调关键结论\n5. 字数控制在 800-2000 字\n6. 不要输出 Front Matter，只输出笔记正文`;

  const modelOptions = buildModelOptions();
  const result = await generateSlides(prompt, modelOptions);
  if (!result) throw new Error('未配置可用 LLM：请到「设置」面板配置文本模型或填写 API Key');
  emit('llm-provider', `使用模型: ${result.provider}`);

  return stripMarkdown(result.content.trim());
}

export async function generateNoteFromDeck(projectName, options = {}) {
  const projectDir = getProjectDir(projectName);
  const htmlPath = path.join(projectDir, 'index.html');
  if (!fs.existsSync(htmlPath)) throw new Error(`项目 ${projectName} 的 index.html 不存在`);

  const cfg = readConfig(projectName);
  emit('start', `从 PPT 生成笔记：${options.noteName || projectName}`);

  // 检查是否已有来源笔记（如果有，更新而非创建）
  let noteName;
  if (cfg.sourceSelection?.kind === 'note' && cfg.sourceSelection.noteName) {
    noteName = cfg.sourceSelection.noteName;
  } else if (options.overwrite && options.noteName) {
    // 如果指定了笔记名且 force，则覆盖已有
    const existing = readNote(options.noteName);
    if (!existing) noteName = options.noteName;
    else noteName = null; // need to create new
  }

  ensureVaultDirs();

  emit('extract', '提取 PPT 幻灯片文本内容');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const deckText = extractDeckText(html);
  if (!deckText) throw new Error('无法从 PPT 中提取有效内容');

  emit('llm', '调用模型生成笔记正文');
  const noteContent = await generateNoteContent(deckText, projectName, cfg);

  // 确定最终的笔记名称
  let finalNoteName;
  if (noteName) {
    finalNoteName = noteName;
  } else if (options.noteName) {
    finalNoteName = options.noteName;
  } else {
    // 默认以 PPT-项目名 为笔记名，避免冲突
    let base = `PPT-${projectName}`;
    let candidate = base;
    let suffix = 1;
    while (readNote(candidate) !== null) {
      candidate = `${base}-${suffix++}`;
    }
    finalNoteName = candidate;
  }

  // 检查笔记是否已存在 — 如果存在则更新，否则创建
  const existingContent = readNote(finalNoteName);
  if (existingContent !== null && !options.overwrite) {
    throw new Error(`笔记 "${finalNoteName}" 已存在，请使用 --overwrite 或指定其他名称`);
  }

  // 构建 Front Matter + 正文
  const frontMatter = {
    title: cfg.params?.title || projectName,
    tags: ['PPT-生成', 'ai-ppt'],
    sourceType: 'ppt-generated',
    sourceProject: projectName,
    lastGeneratedAt: new Date().toISOString(),
  };

  const fullContent = stringifyFrontMatter(frontMatter) + '\n' + noteContent;

  if (existingContent !== null && options.overwrite) {
    emit('update', `更新已有笔记：${finalNoteName}`);
    writeNote(finalNoteName, fullContent);
  } else {
    emit('create', `创建新笔记：${finalNoteName}`);
    createNote(finalNoteName, fullContent);
  }

  // 更新 PPT 配置中的 sourceSelection，建立双向绑定
  if (cfg.sourceSelection?.kind !== 'note') {
    cfg.sourceSelection = { kind: 'note', noteName: finalNoteName, selection: null };
    const { writeConfig } = await import('./config.mjs');
    writeConfig(projectName, cfg);
    emit('bind', `PPT 与笔记双向绑定：${projectName} ↔ ${finalNoteName}`);
  }

  // 更新封面（内容可能已变更）
  try { await captureCover(projectName); } catch {}

  emit('done', `笔记生成完成！"${finalNoteName}"`);
  emitDone({ success: true, noteName: finalNoteName });
  return { noteName: finalNoteName };
}

// ---- CLI ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args[0]) { console.error('用法：node scripts/generate-note-from-deck.mjs <projectName> [noteName] [--overwrite]'); process.exit(1); }

  const projectName = args[0];
  let noteName, overwrite = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--overwrite') overwrite = true;
    else if (!args[i].startsWith('--')) noteName = args[i];
  }

  generateNoteFromDeck(projectName, { noteName, overwrite }).catch((e) => { emitError(e.message); process.exit(1); });
}
