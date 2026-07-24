#!/usr/bin/env node
// scripts/generate-from-notes.mjs — 从多篇知识库笔记生成 PPT 项目。
// 内容收集：选中笔记全文 + 一跳出链笔记摘要（参考 generate-from-graph.mjs）。
// CLI: node scripts/generate-from-notes.mjs <project-name> <note1,note2,...> [--slides N --audience X --style Y]
// stdout 输出 NDJSON 进度事件（协议同 generate-from-graph.mjs）。
import { fileURLToPath } from 'node:url';
import { listNotes, readNote, normalizeNoteName } from './vault.mjs';
import { parseWikiLinks } from './link-resolver.mjs';
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

const __filename = fileURLToPath(import.meta.url);

// 去掉 Front Matter，只保留正文
function stripFrontMatter(content) {
  return String(content || '').replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

// 收集内容：选中笔记全文 + 一跳出链笔记摘要（300 字）
function collectNotesContent(noteNames) {
  const notes = listNotes();
  const byId = new Map(notes.map((n) => [normalizeNoteName(n.name), n]));

  const selected = []; // { id, name, content, outlinks: [name] }
  const outlinkSections = []; // { name, excerpt }
  const seen = new Set();

  for (const raw of noteNames) {
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
        excerpt: stripMarkdown(stripFrontMatter(readNote(target.name) || ''))
          .replace(/\s+/g, ' ').trim().slice(0, 300),
      });
    }
    selected.push({ id, name: note.name, content, outlinks });
  }

  return { selected, outlinkSections };
}

// 把收集到的内容整理成纯文本素材
function buildContentText({ selected, outlinkSections }) {
  const parts = [];
  for (const s of selected) {
    parts.push(`【笔记】${s.name}\n${s.content}`);
  }
  for (const s of outlinkSections) {
    parts.push(`【关联笔记】${s.name}\n摘要：${s.excerpt || '（无正文内容）'}`);
  }
  return parts.join('\n\n');
}

// 构建提示词（统一脚手架；本源的差异在任务描述与素材标签）
function buildPrompt(content, noteNames, params = {}) {
  const title = params.title || `笔记精选 · ${noteNames.slice(0, 3).join('、')}`;
  const audience = params.audience || '普通听众';
  const style = params.style || '知识梳理';
  const language = params.language || 'zh-CN';
  const slideCount = params.slideCount
    || Math.min(Math.max(noteNames.length + 2, 5), 15);

  return {
    title,
    audience,
    style,
    slideCount,
    language,
    content,
    prompt: buildSlidesPrompt({
      task: '请把以下知识库笔记内容整理成一套演示文稿：以每篇选中的笔记为一节，讲清核心要点；关联笔记作为补充。',
      title,
      audience,
      style,
      language,
      slideCount,
      contentLabel: '笔记素材',
      content: stripMarkdown(content),
    }),
  };
}

// 确定性兜底模板：封面 + 每篇笔记一节 + 结尾，全部使用真实内容
function buildFallbackSlides(title, { selected }) {
  const sections = selected.map((s) => ({
    heading: s.name,
    lead: stripMarkdown(s.content).replace(/\s+/g, ' ').slice(0, 200) || undefined,
    note: s.outlinks.length ? `关联笔记：${s.outlinks.join('、')}` : undefined,
  }));
  return renderFallbackSlides({
    title,
    subtitle: `共 ${selected.length} 篇笔记`,
    closingTitle: '梳理完毕',
    sections,
  });
}

// 主函数：从多篇笔记生成 PPT 项目
async function generateFromNotes(projectName, noteNames, options = {}) {
  if (!Array.isArray(noteNames) || noteNames.length === 0) {
    throw new Error('请至少提供一篇笔记');
  }

  // 确定项目名并校验
  projectName = sanitizeProjectName(projectName || `笔记-${noteNames[0]}`);
  assertSafeProjectName(projectName);

  emit('start', `从 ${noteNames.length} 篇笔记生成 PPT 项目 "${projectName}"`);

  // 收集笔记内容
  const collected = collectNotesContent(noteNames);
  const content = buildContentText(collected);
  if (!stripMarkdown(content)) {
    emitError('笔记内容为空：所选笔记不存在或没有正文');
    process.exit(1);
  }
  const noteLabel = collected.selected.map((s) => s.name);
  emit('extract', `已收集 ${collected.selected.length} 篇笔记、${collected.outlinkSections.length} 篇出链笔记`);

  // 构建提示词
  const promptData = buildPrompt(content, noteLabel.length ? noteLabel : noteNames, options);
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

  // 写入 HTML
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
    sourceType: 'vault-notes',
    sourceUrl: '',
    sourceNotes: noteLabel.length ? noteLabel : noteNames,
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

  emit('done', `生成完成！项目：${projectName}`);
  emitDone();

  return { projectName, projectDir };
}

export {
  generateFromNotes,
  collectNotesContent,
  buildPrompt,
  buildFallbackSlides,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectName = process.argv[2];
  const notesArg = process.argv[3];

  if (!projectName || !notesArg) {
    console.error('Usage: node scripts/generate-from-notes.mjs <project-name> <note1,note2,...> [--slides N --audience X --style Y]');
    process.exit(1);
  }

  const noteNames = notesArg.split(',').map((s) => s.trim()).filter(Boolean);
  if (noteNames.length === 0) {
    emitError('请至少提供一篇笔记');
    process.exit(1);
  }

  const options = {};
  const rest = process.argv.slice(4);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--slides') {
      const n = Number(rest[++i]);
      if (Number.isInteger(n) && n > 0) options.slideCount = n;
    } else if (rest[i] === '--audience') {
      options.audience = rest[++i];
    } else if (rest[i] === '--style') {
      options.style = rest[++i];
    }
  }

  generateFromNotes(projectName, noteNames, options).catch((e) => {
    emitError(e.message);
    process.exit(1);
  });
}
