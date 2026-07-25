// 生成类脚本（generate-deck / generate-from-note(s) / generate-from-graph / generate-from-review / chat-modify）的公共工具：
// NDJSON 进度事件、幻灯片 HTML 清洗与包装、userEdits 约束、模型配置、
// 统一生成管线（buildSlidesPrompt → generateSlidesHtml → writeDeckIndex）、
// 参数化兜底模板 buildFallbackSlides、主题链接（单一数据源 ai-ppt-base/themes.json）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { readGlobalConfig } from './global-config.mjs';
import { generateSlides } from './llm-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE_DIR = path.join(ROOT, 'ai-ppt-base');
const THEMES_JSON = path.join(BASE_DIR, 'themes.json');

// ---- NDJSON 事件输出（服务端按行解析，字段勿随意增删） ----

export function emit(step, message, detail = null) {
  const event = { type: 'progress', step, message, detail, time: new Date().toISOString() };
  process.stdout.write(JSON.stringify(event) + '\n');
}

export function emitError(message) {
  const hint = diagnoseError(message);
  const fullMessage = hint ? `${message}\n💡 ${hint}` : message;
  const event = { type: 'error', message: fullMessage, time: new Date().toISOString() };
  process.stdout.write(JSON.stringify(event) + '\n');
}

// ---- 错误诊断指引 ----

const ERROR_DIAGNOSES = [
  { pattern: /\b401\b|Unauthorized|invalid.*api.*key|apikey.*invalid/i, hint: 'API Key 无效或过期，请到「设置」面板检查' },
  { pattern: /\b403\b|Forbidden/i, hint: '访问被拒绝，请检查 API Key 权限或套餐状态' },
  { pattern: /\b429\b|rate.*limit|too.*many.*request/i, hint: '请求频率超限，请稍后重试或升级套餐' },
  { pattern: /\b500\b|\b502\b|\b503\b|\b504\b/i, hint: '服务端内部错误，请稍后重试' },
  { pattern: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch.*failed|network.*error|socket.*hang.*up/i, hint: '无法连接 API 服务，请检查网络或 Base URL 配置' },
  { pattern: /timeout|aborted/i, hint: '请求超时，可能是网络不稳定或模型响应过慢，请重试' },
  { pattern: /未配置.{0,6}LLM|无可用模型/i, hint: '请到「设置」面板配置文本模型与 API Key' },
];

export function diagnoseError(message) {
  const text = String(message || '');
  for (const { pattern, hint } of ERROR_DIAGNOSES) {
    if (pattern.test(text)) return hint;
  }
  return null;
}

export function emitDone(extra = {}) {
  const event = { type: 'done', ...extra, time: new Date().toISOString() };
  process.stdout.write(JSON.stringify(event) + '\n');
}

// ---- 文本 / HTML 工具 ----

// AI 对话修改：LLM 输出中正文与修改说明的分隔标记
export const CHANGE_DETAILS_MARKER = '---修改说明---';

// 从 LLM 输出中分离正文与修改说明：{ content, details }（无标记时 details 为空）
export function splitChangeDetails(text) {
  const m = String(text).match(/\n?\s*---修改说明---\s*\n([\s\S]*)$/);
  if (!m) return { content: String(text).trim(), details: '' };
  return {
    content: String(text).slice(0, m.index).trim(),
    details: m[1].trim().slice(0, 2000),
  };
}

// 无修改说明时的兜底：LCS 行级 diff（- 删除行 / + 新增行），最多 maxLines 行
export function buildLineDiff(oldText, newText, maxLines = 40) {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  const n = a.length, m = b.length;
  if (n * m > 4000000) return `内容变化较大（旧 ${n} 行 → 新 ${m} 行）`;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(`- ${a[i++]}`);
    else ops.push(`+ ${b[j++]}`);
  }
  while (i < n) ops.push(`- ${a[i++]}`);
  while (j < m) ops.push(`+ ${b[j++]}`);
  if (!ops.length) return '（内容无变化）';
  const trimmed = ops.slice(0, maxLines);
  if (ops.length > maxLines) trimmed.push(`… 其余 ${ops.length - maxLines} 处变化`);
  return trimmed.join('\n');
}

export function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function stripMarkdown(text) {
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
    // images (must come before links to avoid partial match)
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // links [text](url)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // collapse blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 清理幻灯片文本节点中残留的 Markdown 标记
export function cleanSlideMarkdown(html) {
  if (!html) return html;
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

// 从 LLM 返回内容中提取 <main class="stage"> 内部的幻灯片片段
export function extractMainContent(rawHtml) {
  if (!rawHtml) return '';
  const mainMatch = rawHtml.match(/<main[^>]*class="stage"[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return mainMatch[1].trim();
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const source = bodyMatch ? bodyMatch[1] : rawHtml;
  const $ = load(source);
  const sections = $('section.slide');
  if (sections.length > 0) {
    return sections.map((_, el) => $.html(el)).get().join('\n');
  }
  return source.trim();
}

// 确保只有第一张幻灯片带 active 类
export function ensureSingleActive(slidesHtml) {
  const $ = load(`<main>${slidesHtml}</main>`, { xmlMode: false });
  $('section.slide').removeClass('active');
  $('section.slide').first().addClass('active');
  return $('main').html();
}

// ---- userEdits 保护约束（可视化编辑过的页面禁止 LLM 重写） ----

export function formatUserEdits(cfg) {
  const edits = cfg.userEdits;
  if (!edits || !edits.htmlSnapshot || edits.htmlSnapshot.length === 0) return '';
  const lines = edits.htmlSnapshot.map((s) => {
    const heading = s.heading ? `标题：${s.heading}` : '';
    const text = s.text ? `内容：${s.text}` : '';
    return `第 ${s.index + 1} 页\n${heading}\n${text}`;
  });
  return `\n【用户手动编辑过的幻灯片（必须保留）】\n以下幻灯片是用户曾在可视化编辑器中手动编辑并保存的。重新生成时，这些幻灯片的文字内容、核心观点、数据必须原样保留或仅做最小化润色，禁止整体重写、删除或替换为不同内容。未在此列表中的幻灯片可按来源内容正常生成。\n\n${lines.join('\n\n')}\n`;
}

// ---- 模型配置（系统级 .ai-ppt-config.json + 环境变量） ----

export function buildModelOptions(extraModel) {
  const globalCfg = readGlobalConfig();
  const mcfg = globalCfg.modelConfig || {};
  return {
    // apiKey 优先级：环境变量 > 配置文件（persistApiKey 落盘的）> 无
    apiKey: process.env.AI_PPT_API_KEY || process.env.OPENAI_API_KEY || mcfg.apiKey || undefined,
    baseUrl: mcfg.baseUrl || undefined,
    model: mcfg.model || extraModel || undefined,
    provider: mcfg.provider || undefined,
  };
}

// ---- 主题注册（单一数据源：ai-ppt-base/themes.json） ----
// 新增主题只需：themes.json 加一条 + css/themes/<id>.css 加一个文件。
// wrapSlides 与基座 index.html 的主题 <link> 都由这里动态生成；
// ppt.js 内的同名列表仅是 /api/themes 不可用时的运行时兜底。

export function loadThemesMeta() {
  try {
    const data = JSON.parse(fs.readFileSync(THEMES_JSON, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// 主题相关 <link> 行（theme-switcher 固定在前，随后按 themes.json 顺序）
export function buildThemeLinks() {
  const lines = ['  <link rel="stylesheet" href="css/themes/theme-switcher.css">'];
  for (const t of loadThemesMeta()) {
    if (t && t.id) lines.push(`  <link rel="stylesheet" href="css/themes/${t.id}.css">`);
  }
  return lines.join('\n');
}

// 基座 ai-ppt-base/index.html 中主题链接区块的标记（upgrade-decks 同步时刷新该区块）
export const THEME_LINKS_START = '<!-- theme-links:start（由 ai-ppt-base/themes.json 自动生成，请勿手改） -->';
export const THEME_LINKS_END = '<!-- theme-links:end -->';

// 重建 html 中 theme-links 标记区块的内容；无标记时原样返回
export function syncThemeLinksBlock(html) {
  const start = html.indexOf(THEME_LINKS_START);
  const end = html.indexOf(THEME_LINKS_END);
  if (start === -1 || end === -1 || end < start) return html;
  return html.slice(0, start + THEME_LINKS_START.length)
    + '\n' + buildThemeLinks() + '\n  '
    + html.slice(end);
}

// ---- 统一提示词脚手架（各源只提供任务描述、素材与差异化规则） ----

export function buildSlidesPrompt({
  task,
  title,
  audience = '通用',
  style = '商业汇报',
  language = 'zh-CN',
  slideCount = 8,
  contentLabel = '来源内容',
  content = '',
  contentLimit = 8000,
  extraRules = '',
  userEditsSection = '',
}) {
  return `${task}

演示文稿标题："${title}"。

输出格式：
- 只返回 <main id="stage" class="stage"> 内部的内容，即多个 <section class="slide"> 元素。
- 第一个 <section> 需要带有 class="slide active"，其余为 class="slide"。
- 目标受众：${audience}；风格：${style}；语言：${language}；大约 ${slideCount} 页。
- 不要输出 <html>, <head>, <body>, <script>, <style> 或任何解释文字。
- 幻灯片正文使用纯文本，不要使用 Markdown 语法（#、**、>、-、\`[链接]\` 等）。

可用 CSS 类（只能使用这些，禁止手写 style 属性和新组件）：
- 结构：slide-content, h1, h2, h3, lead, divider, section-hero。
- 要点并列：tile-row, tile, two-col, visual-row, visual-card, icon。
- 数据：split-visual, hero-stat, big-number, big-number-label, chart-bar, chart-bar-item, progress-ring, data-matrix, waterfall, waterfall-item, ppt-table。
- 数据图表（SVG，声明式 data-chart）：chart-line（折线/面积）, chart-pie（饼/环）, chart-bars（分组/堆叠柱）。
- 流程与强调：chart-steps, timeline, timeline-item, timeline-horizontal, quote-block, badge-row, badge。

数据图表用法（素材中有真实序列/占比数据时优先使用，禁止编造数据）：
- 写法：<div class="chart-line" data-chart='{...JSON...}'></div>，属性外层单引号、JSON 内双引号，内部不要写任何内容，ppt.js 会自动渲染为 SVG。
- chart-line 折线/面积图：{"labels":["Q1","Q2","Q3","Q4"],"series":[{"name":"客户数","data":[120,180,260,320]}]}，多序列直接加 series 元素；可选 "area":true（面积填充）、"valueLabels":true（点数值）。
- chart-pie 饼/环图：{"labels":["薪酬","考勤","其他"],"data":[45,25,30]}，可选 "donut":true（环图）、"centerLabel":"文字"；自动生成占比标签与图例，数据应为占比或数值总量。
- chart-bars 柱状图：{"labels":["Q1","Q2","Q3","Q4"],"series":[{"name":"2024","data":[45,58,72,85]},{"name":"2025","data":[52,66,81,97]}]}，默认分组柱，"stacked":true 为堆叠柱。
- 一页最多放 1-2 个图表；labels 不超过 8 个；series 不超过 4 个。

设计原则（必须遵守，优先级高于一切）：
- 一页只讲一个核心观点，标题即结论；每页保留 1-3 个核心词/短句，详细内容由讲演者口述，任何正文段落不超过 3 行。
- 版式必须轮换：相邻两页不使用同一种结构。
- 只使用素材中的真实内容，禁止编造数据、案例或题目。
- 标题不超过 20 个汉字，避免折行溢出。
${extraRules}${userEditsSection}
${contentLabel}：
${String(content).slice(0, contentLimit)}
`;
}

// ---- 参数化兜底模板（唯一实现；各源把素材整理成 sections 传入即可） ----
// section 形状：{ heading, lead?, paragraphs?, points?, tiles?, note? }
//   lead        字符串或字符串数组 → <p class="lead">
//   paragraphs  字符串数组         → <p>
//   points      字符串数组         → visual-row/visual-card 序号卡片（空数组 → ★ 占位卡）
//   tiles       [{title, text}]    → tile-row 卡片
//   note        字符串             → 弱化说明行

function renderFallbackSection(sec) {
  const parts = [`          <h2>${escapeHtml(sec.heading)}</h2>`];
  const leads = Array.isArray(sec.lead) ? sec.lead : (sec.lead ? [sec.lead] : []);
  for (const l of leads) parts.push(`          <p class="lead">${escapeHtml(l)}</p>`);
  for (const p of sec.paragraphs || []) parts.push(`          <p>${escapeHtml(p)}</p>`);
  if (sec.points) {
    const cards = sec.points.length
      ? sec.points.map((p, i) => `            <div class="visual-card">\n              <div class="icon">${i + 1}</div>\n              <p>${escapeHtml(p.length > 40 ? p.slice(0, 40) + '…' : p)}</p>\n            </div>`).join('\n')
      : `            <div class="visual-card">\n              <div class="icon">★</div>\n              <p>详见讲演者口述</p>\n            </div>`;
    parts.push(`          <div class="visual-row">\n${cards}\n          </div>`);
  }
  if (sec.tiles && sec.tiles.length) {
    const items = sec.tiles.map((t) =>
      `            <div class="tile"><strong>${escapeHtml(String(t.title || '').slice(0, 30))}</strong>${t.text ? `<p>${escapeHtml(String(t.text).slice(0, 60))}</p>` : ''}</div>`
    ).join('\n');
    parts.push(`          <div class="tile-row">\n${items}\n          </div>`);
  }
  if (sec.note) parts.push(`          <p style="opacity: 0.7;">${escapeHtml(sec.note)}</p>`);
  return `      <section class="slide">
        <div class="slide-content">
${parts.join('\n')}
        </div>
      </section>\n`;
}

export function buildFallbackSlides({
  title,
  subtitle = '',
  fancyCover = false,
  closingTitle = '谢谢观看',
  closingLead = '',
  sections = [],
}) {
  const coverLead = subtitle
    ? (fancyCover
      ? `<p class="lead" style="font-size: clamp(20px, 2.5vw, 34px);">${escapeHtml(subtitle)}</p>\n          <div class="divider" style="margin: 40px auto; max-width: 160px;"></div>`
      : `<p class="lead">${escapeHtml(subtitle)}</p>`)
    : '';
  let slides = `      <section class="slide active">
        <div class="slide-content section-hero" style="text-align: center;">
          <h1>${escapeHtml(title)}</h1>
          ${coverLead}
        </div>
      </section>\n`;
  for (const sec of sections) slides += renderFallbackSection(sec);
  slides += `      <section class="slide">
        <div class="slide-content section-hero" style="text-align: center;">
          <h1>${escapeHtml(closingTitle)}</h1>
          ${closingLead ? `<p class="lead">${escapeHtml(closingLead)}</p>` : ''}
        </div>
      </section>\n`;
  return slides;
}

// ---- 统一生成管线：LLM 调用 → 页数校验 → 兜底模板 → Markdown 清洗 → 单 active ----
// 落盘（ensureBaseEngine / wrapSlides / writeConfig）由调用方用 config.mjs 的共享实现完成。

export async function generateSlidesHtml({ prompt, modelOptions, minSections = 3, buildFallback }) {
  let slidesHtml = '';
  let fallbackNotified = false;
  const llmResult = await generateSlides(prompt, modelOptions);
  if (llmResult) {
    emit('llm', `LLM 返回内容（provider: ${llmResult.provider}）`);
    slidesHtml = extractMainContent(llmResult.content);
    const sectionCount = (slidesHtml.match(/<section\b/g) || []).length;
    if (sectionCount < minSections) {
      emit('fallback', `LLM 仅返回 ${sectionCount} 页（预期至少 ${minSections} 页），使用兜底模板`);
      fallbackNotified = true;
      slidesHtml = '';
    }
  } else {
    emit('llm', '未配置 LLM 或无可用模型，使用确定性模板生成');
  }

  if (!slidesHtml || slidesHtml.length < 200) {
    if (!fallbackNotified) emit('fallback', '使用内置兜底模板生成幻灯片');
    slidesHtml = buildFallback();
  }

  return ensureSingleActive(cleanSlideMarkdown(slidesHtml));
}

// ---- 整页 HTML 包装 ----

// generate-deck / chat-modify 使用的 body class 写法：默认主题 web-ui 与动画 none 不加类
export function buildBodyClass(cfg) {
  const theme = cfg.theme || 'web-ui';
  const animation = cfg.animation || 'slide';
  const themeClass = theme !== 'web-ui' ? ` theme-${theme}` : '';
  const animClass = animation !== 'none' ? ` anim-${animation}` : '';
  return `${themeClass}${animClass}`;
}

// bodyClass 由调用方给定（各脚本的 class 写法略有差异，保持原行为）
// 主题 <link> 由 buildThemeLinks() 按 ai-ppt-base/themes.json 动态生成
export function wrapSlides(slidesHtml, title, bodyClass) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="css/ppt.css">
${buildThemeLinks()}
</head>
<body class="${bodyClass}">
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
        <div class="help-group">
          <div class="help-group-title">标识笔</div>
          <div class="help-row"><kbd>M</kbd><span>开启/退出标识笔</span></div>
          <div class="help-row"><kbd>1</kbd>-<kbd>5</kbd><span>画笔/箭头/矩形/圆/椭圆</span></div>
          <div class="help-row"><kbd>C</kbd><span>清除本页标记</span></div>
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
