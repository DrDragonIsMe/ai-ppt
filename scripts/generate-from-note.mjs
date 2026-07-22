#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
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
  ensureBaseEngine,
  readConfig,
  writeConfig,
} from './config.mjs';
import { readGlobalConfig } from './global-config.mjs';
import { generateSlides } from './llm-adapter.mjs';

import { load as loadHtml } from 'cheerio';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function emit(step, message, detail = null) {
  const event = { type: 'progress', step, message, detail, time: new Date().toISOString() };
  console.log(JSON.stringify(event));
}

function emitError(message) {
  const event = { type: 'error', message, time: new Date().toISOString() };
  console.log(JSON.stringify(event));
}

function emitDone() {
  const event = { type: 'done', time: new Date().toISOString() };
  console.log(JSON.stringify(event));
}

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
        const linkedContent = extractContentFromNote(link.name, false, 0);
        linked.push(`\n\n---\n\n## 关联：${link.display || link.name}\n\n${linkedContent}`);
      } catch {}
    }
    if (linked.length > 0) {
      content += '\n\n【关联笔记内容】\n' + linked.join('');
    }
  }
  
  return content;
}

// 构建提示词
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
    prompt: `请根据以下笔记内容为名为 "${title}" 的演示文稿生成 HTML 幻灯片片段。

输出格式：
- 只返回 <main id="stage" class="stage"> 内部的内容，即多个 <section class="slide"> 元素。
- 第一个 <section> 需要带有 class="slide active"，其余为 class="slide"。
- 目标受众：${audience}；风格：${style}；语言：${language}；大约 ${slideCount} 页。
- 不要输出 <html>, <head>, <body>, <script>, <style> 或任何解释文字。
- 幻灯片正文使用纯文本，不要使用 Markdown 语法（#、**、>、-、\`[链接]\` 等）。

可用 CSS 类：
- 结构：slide-content, h1, h2, h3, lead, divider, section-hero。
- 要点并列：tile-row, tile, two-col, visual-row, visual-card, icon。
- 数据：split-visual, hero-stat, big-number, big-number-label, chart-bar, progress-ring, data-matrix, waterfall, ppt-table。
- 流程与强调：chart-steps, timeline, timeline-horizontal, quote-block, badge-row, badge。

设计原则：
- 一页只讲一个核心观点，标题即结论；每页保留 1-3 个核心词/短句。
- 版式必须轮换：相邻两页不使用同一种结构。
- 内容中有数据、指标、百分比时，优先用可视化组件展示；禁止编造数据。
- 标题不超过 20 个汉字。

笔记内容：
${content.slice(0, 8000)}
`,
  };
}

// 复用generate-deck.mjs的wrapSlides逻辑
function wrapSlides(slidesHtml, title, cfg = {}) {
  const theme = cfg.theme || 'web-ui';
  const animation = cfg.animation || 'slide';
  const themeClass = theme !== 'web-ui' ? ` theme="${theme}"` : '';
  const animClass = animation !== 'none' ? ` anim="${animation}"` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="css/ppt.css">
  <link rel="stylesheet" href="css/themes/theme-switcher.css">
  <link rel="stylesheet" href="css/themes/web-ui.css">
  <link rel="stylesheet" href="css/themes/business-blue.css">
  <link rel="stylesheet" href="css/themes/elegant-purple.css">
  <link rel="stylesheet" href="css/themes/warm-orange.css">
  <link rel="stylesheet" href="css/themes/sunset-red.css">
  <link rel="stylesheet" href="css/themes/tech-green.css">
  <link rel="stylesheet" href="css/themes/minimal-gray.css">
  <link rel="stylesheet" href="css/themes/dark-mode.css">
</head>
<body>
  <div id="app">
    <main id="stage" class="stage">
${slidesHtml}    </main>

    <div id="overview" class="overview hidden">
      <div class="overview-title">幻灯片预览 · 点击跳转</div>
      <div class="overview-grid"></div>
    </div>

    <div id="help" class="help">
      <div class="help-header">
        <div class="help-title">快捷键</div>
        <div class="help-hint">按 <kbd>?</kbd> 隐藏/显示</div>
      </div>
      <div class="help-content">
        <div class="help-group">
          <div class="help-group-title">导航</div>
          <div class="help-row"><kbd>←</kbd><span>上一页</span></div>
          <div class="help-row"><kbd>→</kbd><span>下一页</span></div>
          <div class="help-row"><kbd>Cmd</kbd>+<kbd>←</kbd><span>首页</span></div>
          <div class="help-row"><kbd>Cmd</kbd>+<kbd>→</kbd><span>尾页</span></div>
        </div>
        <div class="help-group">
          <div class="help-group-title">视图</div>
          <div class="help-row"><kbd>↑</kbd><span>幻灯片预览</span></div>
          <div class="help-row"><kbd>F</kbd><span>全屏模式</span></div>
          <div class="help-row"><kbd>T</kbd><span>切换主题</span></div>
        </div>
        <div class="help-group">
          <div class="help-group-title">导出</div>
          <div class="help-row"><kbd>↓</kbd><span>导出 PDF</span></div>
          <div class="help-row"><kbd>Ctrl</kbd>+<kbd>P</kbd><span>打印/导出面板</span></div>
        </div>
      </div>
      <div class="help-footer">
        <span>全屏时：点击左侧/右侧翻页</span>
      </div>
    </div>

    <div id="toast" class="toast"></div>
    <div id="progress" class="progress"></div>
    <div id="hud" class="hud"></div>
  </div>

  <script src="js/ppt.js"></script>
</body>
</html>`;
}

function stripMarkdown(text) {
  if (text == null) return '';
  return String(text)
    // horizontal rules
    .replace(/^[\-*_]{3,}\s*$/gm, '')
    // ATX headers
    .replace(/^#{1,6}\s+/gm, '')
    // blockquotes
    .replace(/^\s*>\s?/gm, '')
    // unordered list markers
    .replace(/^\s*[-*+]\s+/gm, '')
    // ordered list markers
    .replace(/^\s*\d+\.\s+/gm, '')
    // bold / italic
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_(?!\s)([^_\n]+?)(?<!\s)_(?!_)/g, '$1')
    // inline code
    .replace(/`([^`]+)`/g, '$1')
    // links [text](url)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // images
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // collapse blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanSlideMarkdown(html) {
  if (!html) return html;
  const $ = loadHtml(`<main>${html}</main>`, { xmlMode: false });
  $('main *').contents().each((_, node) => {
    if (node.nodeType === 3 && node.nodeValue) {
      const cleaned = stripMarkdown(node.nodeValue);
      if (cleaned !== node.nodeValue) {
        $(node).replaceWith(cleaned);
      }
    }
  });
  return $('main').html();
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 提取main内容（从generate-deck.mjs复用）
function extractMainContent(rawHtml) {
  if (!rawHtml) return '';
  const mainMatch = rawHtml.match(/<main[^>]*class="stage"[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return mainMatch[1].trim();
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const source = bodyMatch ? bodyMatch[1] : rawHtml;
  const $ = loadHtml(source);
  const sections = $('section.slide');
  if (sections.length > 0) {
    return sections.map((_, el) => $.html(el)).get().join('\n');
  }
  return source.trim();
}

// 简单的备用模板
function buildFallbackSlides(title, content) {
  const paras = content.split(/\n{2,}/).filter(p => p.trim().length > 10);
  let slides = '';
  slides += `      <section class="slide active">
        <div class="slide-content section-hero" style="text-align: center;">
          <h1>${escapeHtml(title)}</h1>
        </div>
      </section>\n`;
  
  for (const para of paras.slice(0, 6)) {
    const lines = para.split('\n').filter(Boolean).slice(0, 3);
    slides += `      <section class="slide">
        <div class="slide-content">
          <h2>${escapeHtml(lines[0]?.slice(0, 40) || '要点')}</h2>
          ${lines.slice(1).map(l => `<p class="lead">${escapeHtml(l.slice(0, 150))}</p>`).join('\n')}
        </div>
      </section>\n`;
  }
  
  slides += `      <section class="slide">
        <div class="slide-content section-hero" style="text-align: center;">
          <h1>谢谢</h1>
        </div>
      </section>\n`;
  return slides;
}

// 主函数：从笔记生成PPT项目
async function generateFromNote(noteName, projectName, options = {}) {
  // 先确保索引是最新的
  rebuildIndex();
  
  // 确定项目名
  if (!projectName) {
    projectName = noteName.replace(/[^\w\u4e00-\u9fa5-]/g, '-');
  }
  
  emit('start', `从笔记 "${noteName}" 生成PPT项目 "${projectName}"`);
  
  // 构建提示词
  const promptData = buildPromptFromNote(noteName, options);
  emit('prompt', `已构建提示词，标题：${promptData.title}`);
  
  // 调用LLM生成
  const globalCfg = readGlobalConfig();
  const mcfg = globalCfg.modelConfig || {};
  const modelOptions = {
    apiKey: process.env.AI_PPT_API_KEY || undefined,
    baseUrl: mcfg.baseUrl || undefined,
    model: mcfg.model || options.model || undefined,
    provider: mcfg.provider || undefined,
  };
  
  let slidesHtml = '';
  try {
    const llmResult = await generateSlides(promptData.prompt, modelOptions);
    if (llmResult) {
      emit('llm', 'LLM返回内容');
      slidesHtml = extractMainContent(llmResult);
      const sectionCount = (slidesHtml.match(/<section\b/g) || []).length;
      if (sectionCount < 3) {
        emit('fallback', 'LLM返回内容不足，使用备用模板');
        slidesHtml = buildFallbackSlides(promptData.title, promptData.content);
      }
    }
  } catch (e) {
    emit('fallback', `LLM调用失败：${e.message}，使用备用模板`);
  }
  
  if (!slidesHtml || slidesHtml.length < 200) {
    slidesHtml = buildFallbackSlides(promptData.title, promptData.content);
  }
  
  // 清理Markdown标记
  slidesHtml = cleanSlideMarkdown(slidesHtml);
  
  // 确保有active类
  const $ = loadHtml(`<main>${slidesHtml}</main>`, { xmlMode: false });
  $('section.slide').removeClass('active');
  $('section.slide').first().addClass('active');
  slidesHtml = $('main').html();
  
  // 创建项目目录
  const projectDir = getProjectDir(projectName);
  emit('create', `创建项目目录：${projectDir}`);
  fs.mkdirSync(projectDir, { recursive: true });
  
  // 复制基础引擎
  ensureBaseEngine(projectName);
  
  // 写入HTML
  emit('write', '写入index.html');
  const html = wrapSlides(slidesHtml, promptData.title, options);
  fs.writeFileSync(path.join(projectDir, 'index.html'), html, 'utf8');
  
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
