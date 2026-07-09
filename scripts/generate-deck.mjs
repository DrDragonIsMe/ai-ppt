#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { readConfig, writeConfig, getProjectDir, ensureBaseEngine } from './config.mjs';
import { extractFromUrl } from './content-extractor.mjs';
import { generateSlides } from './llm-adapter.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function emit(step, message, detail = null) {
  const event = { type: 'progress', step, message, detail, time: new Date().toISOString() };
  process.stdout.write(JSON.stringify(event) + '\n');
}

function emitError(message) {
  const event = { type: 'error', message, time: new Date().toISOString() };
  process.stdout.write(JSON.stringify(event) + '\n');
}

function emitDone() {
  const event = { type: 'done', time: new Date().toISOString() };
  process.stdout.write(JSON.stringify(event) + '\n');
}

function setStatus(name, status, errorMessage = null) {
  const cfg = readConfig(name);
  cfg.status = status;
  cfg.errorMessage = errorMessage;
  if (status === 'ready') cfg.lastGeneratedAt = new Date().toISOString();
  writeConfig(name, cfg);
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  const $ = load(`<main>${html}</main>`, { xmlMode: false });
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

function chunkText(text, maxLen = 120) {
  const sentences = text.split(/([。！？.!?]\s*)/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (/^[。！？.!?]\s*$/.test(s)) {
      current += s;
      continue;
    }
    current += s;
    if (current.length >= maxLen || i === sentences.length - 1) {
      chunks.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function parseSections(content) {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const headerMatch = line.match(/^(?:#{1,6}\s*)?(?:第[一二三四五六七八九十\\d]+点[：:]?|开场[：:]?|收尾[：:]?)(.+)/);
    if (headerMatch) {
      if (current) sections.push(current);
      current = { title: headerMatch[1].replace(/[：:]$/, '').trim(), points: [] };
      continue;
    }
    if (current) {
      const point = extractPoint(line);
      if (point) current.points.push(point);
    }
  }
  if (current) sections.push(current);

  if (sections.length === 0) {
    const paras = content.split(/\n{2,}/).filter((p) => p.trim().length > 10);
    for (const p of paras.slice(0, 6)) {
      const sents = p.split(/[。！？]/).filter(Boolean);
      sections.push({ title: (sents[0] || '要点').trim(), points: sents.slice(1, 4).map(extractPoint).filter(Boolean) });
    }
  }
  return sections;
}

function extractPoint(line) {
  const cleaned = line.replace(/^[-*+•]\s*/, '').trim();
  if (!cleaned || cleaned.length < 5) return null;
  if (/^>|^#/.test(cleaned)) return null;
  // Skip narrative filler lines
  if (/^(这是|那|我想|我说|比如|例如|大家注意)/.test(cleaned)) return null;

  // Prefer the key phrase before an em-dash or colon
  let point = cleaned;
  const dashIdx = point.search(/[——：:]/);
  if (dashIdx > 3 && dashIdx < 30) point = point.slice(0, dashIdx);

  // Otherwise take the first clause
  if (point.length > 30) {
    const firstClause = point.split(/[，；。]/).find((s) => s.trim().length >= 5 && s.trim().length <= 30);
    if (firstClause) point = firstClause;
  }

  point = point.trim();
  if (point.length > 30) point = point.slice(0, 30) + '…';
  return point.length >= 5 ? point : null;
}

function buildFallbackSlides(cfg, content) {
  const title = cfg.params?.title || cfg.name;
  const sections = parseSections(content);

  let slides = '';
  slides += slideCover(title, '回到基本功 · 打赢持久战');
  slides += slideQuote('销售是长跑。笨一点，透一点，时间会成为我们最忠诚的队友。');

  for (const sec of sections.slice(0, 6)) {
    slides += slideVisual(sec.title, sec.points.slice(0, 3));
  }

  slides += slideHeroStats([
    { value: '6', label: '核心要点' },
    { value: 'Q3', label: '目标季度' },
    { value: '∞', label: '持续复利' },
  ]);
  slides += slideThankYou('Q3，一起干');
  return slides;
}

function slideCover(title, subtitle) {
  return `      <section class="slide active">
        <div class="slide-content section-hero" style="text-align: center;">
          <div class="kicker">Q3 动员</div>
          <h1>${escapeHtml(title)}</h1>
          <p class="lead" style="font-size: clamp(20px, 2.5vw, 34px);">${escapeHtml(subtitle)}</p>
          <div class="divider" style="margin: 40px auto; max-width: 160px;"></div>
          <div class="badge-row">
            <span class="badge">少文字</span>
            <span class="badge outline">多图形</span>
            <span class="badge">讲者驱动</span>
          </div>
        </div>
      </section>\n`;
}

function slideQuote(quote) {
  return `      <section class="slide">
        <div class="slide-content" style="display: flex; align-items: center; justify-content: center;">
          <div class="quote-block" style="width: 100%;">
            <p>${escapeHtml(quote)}</p>
          </div>
        </div>
      </section>\n`;
}

function slideVisual(title, points) {
  const cards = points.length
    ? points.map((p, i) => `            <div class="visual-card">\n              <div class="icon">${i + 1}</div>\n              <p>${escapeHtml(p.length > 40 ? p.slice(0, 40) + '…' : p)}</p>\n            </div>`).join('\n')
    : `            <div class="visual-card">\n              <div class="icon">★</div>\n              <p>详见讲演者口述</p>\n            </div>`;
  return `      <section class="slide">
        <div class="slide-content">
          <div class="section-title">核心观点</div>
          <h2>${escapeHtml(title)}</h2>
          <div class="visual-row">
${cards}
          </div>
        </div>
      </section>\n`;
}

function slideHeroStats(stats) {
  const items = stats.map((s) => `            <div class="hero-stat">\n              <div class="big-number">${escapeHtml(String(s.value))}</div>\n              <div class="big-number-label">${escapeHtml(s.label)}</div>\n            </div>`).join('\n');
  return `      <section class="slide">
        <div class="slide-content" style="text-align: center;">
          <div class="section-title">Data</div>
          <h2>关键数字</h2>
          <div class="split-visual" style="margin-top: 40px;">
${items}
          </div>
        </div>
      </section>\n`;
}

function slideThankYou(closing) {
  return `      <section class="slide">
        <div class="slide-content section-hero" style="text-align: center;">
          <div class="kicker">Together</div>
          <h1>${escapeHtml(closing)}</h1>
          <p class="lead">回到基本功 · 打赢持久战</p>
          <div class="badge-row">
            <span class="badge">勤奋</span>
            <span class="badge">复盘</span>
            <span class="badge">AI</span>
          </div>
        </div>
      </section>\n`;
}

function wrapSlides(slidesHtml, title) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="css/ppt.css">
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
      <div><kbd>←</kbd> 上一页 · <kbd>→</kbd> 下一页</div>
      <div><kbd>Cmd</kbd>+<kbd>←</kbd> 首页 · <kbd>Cmd</kbd>+<kbd>→</kbd> 尾页</div>
      <div><kbd>↑</kbd> 预览 · <kbd>↓</kbd> 导出 PDF</div>
      <div><kbd>Ctrl</kbd>+<kbd>P</kbd> 打印 / 导出</div>
      <div><kbd>F</kbd> 全屏 · <kbd>?</kbd> 帮助</div>
    </div>

    <div id="toast" class="toast"></div>
    <div id="progress" class="progress"></div>
    <div id="hud" class="hud"></div>
  </div>
  <script src="js/ppt.js"></script>
</body>
</html>`;
}

function extractMainContent(rawHtml) {
  if (!rawHtml) return '';
  // If LLM returned a full document, extract the body or main content.
  const mainMatch = rawHtml.match(/<main[^>]*class="stage"[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return mainMatch[1].trim();
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const source = bodyMatch ? bodyMatch[1] : rawHtml;
  // Extract only section.slide tags if present
  const $ = load(source);
  const sections = $('section.slide');
  if (sections.length > 0) {
    return sections.map((_, el) => $.html(el)).get().join('\n');
  }
  return source.trim();
}

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts/generate-deck.mjs <project>');
    process.exit(1);
  }

  const projectDir = getProjectDir(name);
  if (!fs.existsSync(projectDir)) {
    emitError(`项目 ${name} 不存在`);
    process.exit(1);
  }

  const cfg = readConfig(name);
  setStatus(name, 'generating');
  emit('start', `开始生成项目 ${name} 的幻灯片`);

  try {
    let content = '';
    if (cfg.sourceType === 'url' && cfg.sourceUrl) {
      emit('extract', `正在从 URL 提取内容: ${cfg.sourceUrl}`);
      content = await extractFromUrl(cfg.sourceUrl);
    } else if (cfg.sourceType === 'article') {
      content = cfg.articleText || '';
      emit('extract', `使用用户提供的文章内容，长度 ${content.length}`);
    }

    if (!content.trim()) {
      content = cfg.params?.title || cfg.name;
      emit('extract', '未检测到内容，使用标题作为生成依据');
    } else {
      content = stripMarkdown(content);
      emit('extract', '已清理 Markdown 标记');
    }

    const prompt = buildPrompt(cfg, content);
    emit('prompt', '正在构建生成提示词');

    const modelOptions = cfg.modelConfig
      ? {
          apiKey: cfg.modelConfig.apiKey || undefined,
          baseUrl: cfg.modelConfig.baseUrl || undefined,
          model: cfg.modelConfig.model || cfg.params?.model,
        }
      : { model: cfg.params?.model };
    let slidesHtml = '';
    const llmResult = await generateSlides(prompt, modelOptions);
    if (llmResult) {
      emit('llm', 'LLM 返回内容，正在解析');
      slidesHtml = extractMainContent(llmResult);
      const sectionCount = (slidesHtml.match(/<section\b/g) || []).length;
      const expected = Math.max(3, Math.round((cfg.params?.slideCount || 8) * 0.7));
      if (sectionCount < expected) {
        emit('fallback', `LLM 仅返回 ${sectionCount} 页（预期 ${expected} 页），使用视觉模板兜底`);
        slidesHtml = buildFallbackSlides(cfg, content);
      }
    } else {
      emit('llm', '未配置 LLM，使用确定性模板生成');
    }

    if (!slidesHtml || slidesHtml.length < 200) {
      emit('fallback', '使用内置模板生成幻灯片');
      slidesHtml = buildFallbackSlides(cfg, content);
    }

    // Strip any remaining Markdown markers from slide text nodes
    slidesHtml = cleanSlideMarkdown(slidesHtml);

    // Ensure exactly one slide has active class
    const $ = load(`<main>${slidesHtml}</main>`, { xmlMode: false });
    $('section.slide').removeClass('active');
    $('section.slide').first().addClass('active');
    slidesHtml = $('main').html();

    emit('build', '正在写入 index.html');
    ensureBaseEngine(name);
    const html = wrapSlides(slidesHtml, cfg.params?.title || cfg.name);
    fs.writeFileSync(path.join(projectDir, 'index.html'), html, 'utf8');

    setStatus(name, 'ready');
    emit('ready', '生成完成');
    emitDone();
  } catch (err) {
    setStatus(name, 'error', err.message);
    emitError(err.message);
    process.exit(1);
  }
}

function buildPrompt(cfg, content) {
  const p = cfg.params || {};
  return `请根据以下内容为名为 "${p.title || cfg.name}" 的演示文稿生成 HTML 幻灯片片段。

要求：
- 只返回 <main id="stage" class="stage"> 内部的内容，即多个 <section class="slide"> 元素。
- 第一个 <section> 需要带有 class="slide active"，其余为 class="slide"。
- 使用项目已有的 CSS 类：slide-content, kicker, section-title, h1, h2, h3, lead, tile-row, tile, two-col, ppt-table, divider。
- 额外可用视觉类（优先使用）：big-number, big-number-label, hero-stat, visual-row, visual-card, icon, quote-block, timeline, timeline-item, badge-row, badge, split-visual, gradient-text, section-hero。
- 目标受众：${p.audience || '通用'}；风格：${p.style || '商业汇报'}；语言：${p.language || 'zh-CN'}；大约 ${p.slideCount || 8} 页。
- 设计原则：少文字、多图形、大气 keynote 风格；每页只保留 1-3 个核心词/短句，详细内容由讲演者口述。
- 用大字标题、巨型数字、图标卡片、引用块、时间轴、标签云等视觉元素突出重点，避免大段正文。
- 幻灯片正文使用纯文本，不要使用 Markdown 语法（#、**、>、-、\`[链接]\` 等）。
- 不要输出 <html>, <head>, <body>, <script>, <style> 或任何解释文字。

来源内容（已提取关键文本）：
${content.slice(0, 6000)}
`;
}

main();
