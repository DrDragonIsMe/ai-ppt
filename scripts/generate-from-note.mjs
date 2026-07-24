#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  readNote,
  parseFrontMatter,
  getNotePath,
} from './vault.mjs';
import {
  getNoteInfo,
  rebuildIndex,
} from './link-resolver.mjs';
import {
  getProjectDir,
  writeConfig,
  writeDeckIndex,
  sanitizeProjectName,
  assertSafeProjectName,
} from './config.mjs';
import {
  emit,
  emitError,
  emitDone,
  stripMarkdown,
  buildModelOptions,
  buildSlidesPrompt,
  buildFallbackSlides,
  generateSlidesHtml,
} from './generation-common.mjs';

// 从笔记提取内容，包括关联笔记（可选）
function extractContentFromNote(noteName, includeLinked = false, depth = 1) {
  const info = getNoteInfo(noteName);
  if (!info.exists) {
    throw new Error(`笔记 "${noteName}" 不存在`);
  }

  const { frontMatter, content: body } = parseFrontMatter(info.content);
  let content = body.trim();

  // 添加上下文信息
  const header = `# ${frontMatter.title || noteName}\n\n`;
  content = header + content;

  // 如果包含关联笔记
  if (includeLinked && depth > 0) {
    const linked = [];
    for (const link of info.outlinks.slice(0, 5)) {
      try {
        const linkedContent = extractContentFromNote(link, false, 0);
        linked.push(`\n\n---\n\n## 关联：${link}\n\n${linkedContent}`);
      } catch { }
    }
    if (linked.length > 0) {
      content += '\n\n【关联笔记内容】\n' + linked.join('');
    }
  }

  return content;
}

// 构建提示词（统一脚手架；笔记源只提供任务描述与素材）
function buildPromptFromNote(noteName, params = {}) {
  const info = getNoteInfo(noteName);
  const { frontMatter } = parseFrontMatter(info.content);

  // 优先使用笔记中的参数，其次使用传入的参数
  const title = params.title || frontMatter.title || noteName;
  const audience = params.audience || frontMatter.audience || '通用';
  const style = params.style || frontMatter.style || '商业汇报';
  const slideCount = params.slideCount || frontMatter.slideCount || 8;
  const language = params.language || frontMatter.language || 'zh-CN';
  const includeLinked = params.includeLinked || false;

  const content = stripMarkdown(extractContentFromNote(noteName, includeLinked));

  return {
    title,
    audience,
    style,
    slideCount,
    language,
    content,
    prompt: buildSlidesPrompt({
      task: '请根据以下笔记内容生成一套演示文稿幻灯片。',
      title,
      audience,
      style,
      language,
      slideCount,
      contentLabel: '笔记内容',
      content,
    }),
  };
}

// 备用模板：段落整理成 sections 交给统一参数化兜底模板
function buildNoteFallback(title, content) {
  const paras = content.split(/\n{2,}/).filter(p => p.trim().length > 10);
  const sections = paras.slice(0, 6).map((para) => {
    const lines = para.split('\n').filter(Boolean).slice(0, 3);
    return {
      heading: lines[0]?.slice(0, 40) || '要点',
      lead: lines.slice(1).map((l) => l.slice(0, 150)),
    };
  });
  return buildFallbackSlides({ title, closingTitle: '谢谢', sections });
}

// 主函数：从笔记生成PPT项目
async function generateFromNote(noteName, projectName, options = {}) {
  // 先确保索引是最新的
  rebuildIndex();

  // 确定项目名
  if (!projectName) {
    projectName = sanitizeProjectName(noteName);
  }
  assertSafeProjectName(projectName);

  emit('start', `从笔记 "${noteName}" 生成PPT项目 "${projectName}"`);

  // 构建提示词
  const promptData = buildPromptFromNote(noteName, options);
  emit('prompt', `已构建提示词，标题：${promptData.title}`);

  // 调用LLM生成（无 LLM 或结果不足时走统一兜底模板）
  const modelOptions = buildModelOptions(options.model);
  const slidesHtml = await generateSlidesHtml({
    prompt: promptData.prompt,
    modelOptions,
    minSections: 3,
    buildFallback: () => buildNoteFallback(promptData.title, promptData.content),
  });

  // 创建项目目录（writeDeckIndex 内部完成 mkdir + 复制基座引擎 + 写入 index.html）
  const projectDir = getProjectDir(projectName);
  emit('create', `创建项目目录：${projectDir}`);

  // 写入HTML（保持本脚本原有的 body class 写法：主题与动画类始终输出）
  emit('write', '写入index.html');
  const theme = options.theme || 'web-ui';
  const animation = options.animation || 'slide';
  writeDeckIndex(projectName, slidesHtml, {
    title: promptData.title,
    bodyClass: `theme-${theme} anim-${animation}`,
  });

  // 创建配置
  const cfg = {
    name: projectName,
    sourceType: 'vault-note',
    sourceNote: noteName,
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

  emit('done', `生成完成！项目：${projectName}`);
  emitDone();

  return { projectName, projectDir };
}

export {
  generateFromNote,
  buildPromptFromNote,
  extractContentFromNote,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const noteName = process.argv[2];
  let projectName = process.argv[3];
  const includeLinked = process.argv.includes('--include-linked');

  if (!noteName) {
    console.error('Usage: node scripts/generate-from-note.mjs <note-name> [project-name] [--include-linked]');
    process.exit(1);
  }

  generateFromNote(noteName, projectName, { includeLinked }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
