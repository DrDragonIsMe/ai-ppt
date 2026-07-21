#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'cheerio';
import { readConfig, writeConfig, getProjectDir } from './config.mjs';
import { readGlobalConfig } from './global-config.mjs';
import { generateSlides } from './llm-adapter.mjs';
import { createSnapshot } from './snapshot.mjs';
import { injectThemeOverrides } from './theme-overrides.mjs';

function emit(step, message, detail = null) {
  const event = { type: 'progress', step, message, detail, time: new Date().toISOString() };
  process.stdout.write(JSON.stringify(event) + '\n');
}

function emitError(message) {
  process.stdout.write(JSON.stringify({ type: 'error', message, time: new Date().toISOString() }) + '\n');
}

function emitDone() {
  process.stdout.write(JSON.stringify({ type: 'done', time: new Date().toISOString() }) + '\n');
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractSlidesHtml(html) {
  const $ = load(html);
  const sections = $('main.stage section.slide, .slide');
  if (sections.length === 0) return '';
  return sections.map((_, el) => $.html(el)).get().join('\n');
}

function wrapSlides(slidesHtml, title, cfg) {
  const theme = cfg.theme || 'web-ui';
  const animation = cfg.animation || 'slide';
  const themeClass = theme !== 'web-ui' ? ` theme-${theme}` : '';
  const animClass = animation !== 'none' ? ` anim-${animation}` : '';
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
<body class="${themeClass}${animClass}">
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

function formatUserEdits(cfg) {
  const edits = cfg.userEdits;
  if (!edits || !edits.htmlSnapshot || edits.htmlSnapshot.length === 0) return '';
  const lines = edits.htmlSnapshot.map((s) => {
    const heading = s.heading ? `标题：${s.heading}` : '';
    const text = s.text ? `内容：${s.text}` : '';
    return `第 ${s.index + 1} 页\n${heading}\n${text}`;
  });
  return `\n【用户手动编辑过的幻灯片（必须保留）】\n以下幻灯片是用户曾在可视化编辑器中手动编辑并保存的。除非用户指令明确要求修改这些页面，否则必须原样保留其文字、观点和数据，禁止重写、删除或替换。\n\n${lines.join('\n\n')}\n`;
}

function buildModifyPrompt(cfg, slidesHtml, instruction) {
  const title = cfg.params?.title || cfg.name;
  const userEditsSection = formatUserEdits(cfg);
  return `你是一位专业的演示文稿设计师。下面是一个 HTML 幻灯片项目「${title}」当前的全部幻灯片代码。

【用户修改指令】
${instruction}
${userEditsSection}
【当前幻灯片 HTML】
${slidesHtml}

【要求】
1. 严格按指令修改幻灯片内容，不要改变整体设计风格和组件类名（如 kicker、tile、lead、ppt-table、hero-stat 等）。
2. 保持 <section class="slide"> 结构，幻灯片数量不变，除非指令明确要求增删。
3. 只输出修改后的幻灯片 HTML 片段（若干 <section class="slide">...</section>），不要输出 <html>/<head>/<body>/<main> 标签，不要输出任何解释文字。
4. 第一页 slide 保留 class="slide active"，其余只保留 class="slide"。
5. 若存在「用户手动编辑过的幻灯片」，仅当用户指令明确涉及这些页面时才修改它们；否则保持原文字不变。`;
}

async function main() {
  const [name, instruction] = process.argv.slice(2);
  if (!name || !instruction) {
    console.error('Usage: node scripts/chat-modify.mjs <project> <instruction>');
    process.exit(1);
  }

  const projectDir = getProjectDir(name);
  const htmlPath = path.join(projectDir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    emitError(`项目 ${name} 不存在或尚未生成幻灯片`);
    process.exit(1);
  }

  const cfg = readConfig(name);
  emit('start', `开始修改项目 ${name}：${instruction}`);

  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const slidesHtml = extractSlidesHtml(html);
    if (!slidesHtml) {
      emitError('未在 index.html 中找到幻灯片内容');
      process.exit(1);
    }

    emit('snapshot', '修改前自动保存快照');
    createSnapshot(name, `对话修改前：${instruction.slice(0, 50)}`);

    const prompt = buildModifyPrompt(cfg, slidesHtml, instruction);
    emit('llm', '正在调用模型修改内容');

    const globalCfg = readGlobalConfig();
    const mcfg = globalCfg.modelConfig || {};
    const modelOptions = {
      apiKey: process.env.AI_PPT_API_KEY || undefined,
      baseUrl: mcfg.baseUrl || undefined,
      model: mcfg.model || undefined,
      provider: mcfg.provider || undefined,
    };

    const result = await generateSlides(prompt, modelOptions);
    if (!result) {
      emitError('未配置可用 LLM，无法完成修改');
      process.exit(1);
    }

    // Extract slide sections from the model output
    const newSlides = extractSlidesHtml(result) || result.trim();
    const sectionCount = (newSlides.match(/<section\b/g) || []).length;
    if (sectionCount === 0) {
      emitError('模型未返回有效幻灯片内容，修改未应用');
      process.exit(1);
    }

    // Ensure exactly one active slide
    const $ = load(`<main>${newSlides}</main>`, { xmlMode: false });
    $('section.slide').removeClass('active');
    $('section.slide').first().addClass('active');

    let finalHtml = wrapSlides($('main').html(), cfg.params?.title || name, cfg);
    if (cfg.themeOverrides && Object.keys(cfg.themeOverrides).length > 0) {
      finalHtml = injectThemeOverrides(finalHtml, cfg.themeOverrides);
    }
    fs.writeFileSync(htmlPath, finalHtml, 'utf8');

    cfg.status = 'ready';
    cfg.lastGeneratedAt = new Date().toISOString();
    writeConfig(name, cfg);

    emit('ready', `修改完成，共 ${sectionCount} 页幻灯片`);
    emitDone();
  } catch (err) {
    emitError(err.message);
    process.exit(1);
  }
}

main();
