#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { readConfig, writeConfig, getProjectDir } from './config.mjs';
import { generateSlides } from './llm-adapter.mjs';
import { createSnapshot } from './snapshot.mjs';
import { injectThemeOverrides } from './theme-overrides.mjs';
import { writeFileAtomic } from './fs-utils.mjs';
import {
  emit,
  emitError,
  emitDone,
  ensureSingleActive,
  formatUserEdits,
  buildModelOptions,
  buildBodyClass,
  wrapSlides,
  splitChangeDetails,
  buildLineDiff,
} from './generation-common.mjs';
import { lintAfterGenerate } from './design-lint.mjs';

// 超过该页数时 prompt 只放与指令相关的页（+ 前后各 1 页上下文）
export const PARTIAL_THRESHOLD = 15;

function extractSlidesHtml(html) {
  const $ = load(html);
  const sections = $('main.stage section.slide, .slide');
  if (sections.length === 0) return '';
  return sections.map((_, el) => $.html(el)).get().join('\n');
}

// 文档内幻灯片定位：优先 main.stage 内的 section.slide，逐级放宽
function selectSlides($) {
  let slides = $('main.stage > section.slide');
  if (!slides.length) slides = $('main.stage section.slide');
  if (!slides.length) slides = $('section.slide');
  if (!slides.length) slides = $('.slide');
  return slides;
}

// ---- 局部编辑协议：解析 / 合并 ----
// LLM 只返回需要修改的页，每页前单独一行标记：
//   === slide N ===（N 为 1-based 页序）或 === slide new ===（末尾新增）
// 兼容 <!-- slide:N --> 注释写法。未提及的页不返回、保持原样。

export function parsePartialSlides(text) {
  if (!text) return null;
  const markerRe = /(?:={2,}\s*slide\s+(\d+|new)\s*={2,}|<!--\s*slide\s*:?\s*(\d+|new)\s*-->)/gi;
  const matches = [...String(text).matchAll(markerRe)];
  if (matches.length === 0) return null;
  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    const raw = (matches[i][1] || matches[i][2]).toLowerCase();
    const index = raw === 'new' ? 'new' : Number(raw);
    const $ = load(body);
    const section = $('section.slide').first();
    if (section.length === 0) continue; // 无有效 section 的块跳过
    blocks.push({ index, html: $.html(section) });
  }
  return blocks.length ? blocks : null;
}

// DOM 级合并：替换第 N 页 section（1-based）、new 追加到末尾；
// head / 主题 link / script / 用户模板外定制 / 未修改页全部原样保留。
// 返回 { html, applied, slideCount }；无可应用区块或文档内无幻灯片时返回 null。
export function mergePartialSlides(html, blocks) {
  const $ = load(html);
  const slides = selectSlides($);
  if (!slides.length) return null;
  const container = slides.first().parent();
  const applied = [];
  for (const block of blocks) {
    if (block.index === 'new') {
      container.append('\n' + block.html);
      applied.push('new');
    } else {
      const target = selectSlides($).eq(block.index - 1);
      if (!target.length) continue;
      target.replaceWith(block.html);
      applied.push(block.index);
    }
  }
  if (!applied.length) return null;
  // active 归一：保留原文档的 active 页（替换/新增的 section 不继承 active），全无时补第一页
  const all = selectSlides($);
  let activeIdx = -1;
  all.each((i, el) => { if ($(el).hasClass('active')) activeIdx = i; });
  all.removeClass('active');
  selectSlides($).eq(activeIdx === -1 ? 0 : activeIdx).addClass('active');
  return { html: $.html(), applied, slideCount: selectSlides($).length };
}

// ---- 大 deck 分页：与指令相关的页 + 前后各 1 页上下文 ----

function extractKeywords(text) {
  const tokens = new Set();
  for (const m of String(text).matchAll(/[A-Za-z0-9][A-Za-z0-9_.-]{1,}/g)) tokens.add(m[0].toLowerCase());
  for (const seg of String(text).replace(/[^一-鿿]/g, ' ').split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) tokens.add(seg.slice(i, i + 2));
  }
  return [...tokens];
}

// 返回 { slides: [{ i, html }], total, truncated }；i 为 1-based 页序
export function selectRelevantSlides(slidesHtml, instruction, threshold = PARTIAL_THRESHOLD) {
  const $ = load(`<main>${slidesHtml}</main>`);
  const all = $('section.slide').map((i, el) => ({ i: i + 1, html: $.html(el), text: $(el).text() })).get();
  const total = all.length;
  if (total <= threshold) return { slides: all, total, truncated: false };
  const rawTokens = extractKeywords(instruction);
  // 命中超过半数页面的词（如「标题」「内容」）没有区分度，忽略
  const tokens = rawTokens.filter((t) => all.filter((s) => s.text.toLowerCase().includes(t)).length <= total / 2);
  const explicit = new Set([...String(instruction).matchAll(/第\s*(\d+)\s*页/g)].map((m) => Number(m[1])));
  const keep = new Set();
  for (const s of all) {
    const hit = explicit.has(s.i) || tokens.some((t) => t && s.text.toLowerCase().includes(t));
    if (hit) {
      keep.add(s.i);
      if (s.i > 1) keep.add(s.i - 1);
      if (s.i < total) keep.add(s.i + 1);
    }
  }
  if (!keep.size) { keep.add(1); keep.add(2); } // 无命中时保底前两页
  return { slides: all.filter((s) => keep.has(s.i)), total, truncated: true };
}

function buildModifyPrompt(cfg, selection, instruction) {
  const title = cfg.params?.title || cfg.name;
  const userEditsSection = formatUserEdits(cfg);
  const slidesBlock = selection.slides.map((s) => `--- 第 ${s.i} 页 ---\n${s.html}`).join('\n\n');
  const scopeNote = selection.truncated
    ? `（共 ${selection.total} 页，下面只列出与指令最相关的 ${selection.slides.length} 页及其相邻页；未列出的页保持原样，不要返回）`
    : `（共 ${selection.total} 页，全部列出）`;
  return `你是一位专业的演示文稿设计师。下面是一个 HTML 幻灯片项目「${title}」当前的幻灯片代码${scopeNote}。

【用户修改指令】
${instruction}
${userEditsSection}
【当前幻灯片 HTML】
${slidesBlock}

【输出要求（局部编辑协议）】
1. 只返回需要修改的幻灯片，不要返回未修改的页。每页完整 HTML 前单独一行写 === slide N ===（N 为上面标注的页码，1-based）；需要在末尾新增一页时写 === slide new ===。
2. 严格按指令修改内容，不要改变整体设计风格和组件类名（如 kicker、tile、lead、ppt-table、hero-stat 等），保持 <section class="slide"> 结构。
3. 返回的页不要带 active 类（系统会自动保留原 active 页）。
4. 若存在「用户手动编辑过的幻灯片」，仅当用户指令明确涉及这些页面时才修改它们；否则保持原文字不变。
5. 不要输出 <html>/<head>/<body>/<main> 标签，不要输出任何解释文字。
6. 在全部幻灯片区块之后，单独一行输出 ---修改说明---，然后逐行列出你做的每处修改（第几页 + 改了什么，简明扼要，每条一行）。`;
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

    const selection = selectRelevantSlides(slidesHtml, instruction);
    if (selection.truncated) {
      emit('llm', `共 ${selection.total} 页，只将与指令相关的 ${selection.slides.length} 页发给模型`);
    }
    const prompt = buildModifyPrompt(cfg, selection, instruction);
    emit('llm', '正在调用模型修改内容');

    const modelOptions = buildModelOptions();

    const result = await generateSlides(prompt, modelOptions);
    if (!result) {
      emitError('未配置可用 LLM：请到「设置」面板配置文本模型或填写 API Key');
      process.exit(1);
    }
    emit('llm-provider', `使用模型: ${result.provider}`);

    // 分离幻灯片 HTML 与修改说明（---修改说明--- 之后的部分不写入文件）
    const { content: slidesOut, details: llmDetails } = splitChangeDetails(result.content);

    // 优先走局部编辑协议：按页码区块做 DOM 级合并，保留未修改页与模板外定制
    let finalHtml = '';
    let mergedSlideCount = 0;
    let partialDiffHtml = '';
    const partials = parsePartialSlides(slidesOut);
    if (partials) {
      const merged = mergePartialSlides(html, partials);
      if (merged) {
        finalHtml = merged.html;
        mergedSlideCount = merged.slideCount;
        partialDiffHtml = extractSlidesHtml(finalHtml);
        emit('merge', `局部合并：应用 ${merged.applied.length} 个区块（合并后共 ${merged.slideCount} 页）`);
      }
    }

    if (finalHtml) {
      // 局部路径成功：写盘并收尾
      writeFileAtomic(htmlPath, finalHtml);
      cfg.status = 'ready';
      cfg.lastGeneratedAt = new Date().toISOString();
      writeConfig(name, cfg);

      lintAfterGenerate(name, emit);
      const summary = `修改完成，共 ${mergedSlideCount} 页幻灯片`;
      const details = llmDetails || buildLineDiff(slidesHtml, partialDiffHtml);
      emit('ready', summary);
      emitDone({ success: true, changed: finalHtml !== html, summary, details });
      return;
    }

    // 降级：模型输出无法解析为局部区块，回退「全部幻灯片 + wrapSlides」整页重写（旧行为）
    emit('fallback', '模型输出未按局部协议返回，回退整页重写');

    // Extract slide sections from the model output
    const newSlides = extractSlidesHtml(slidesOut) || slidesOut.trim();
    const sectionCount = (newSlides.match(/<section\b/g) || []).length;
    if (sectionCount === 0) {
      emitError('模型未返回有效幻灯片内容，修改未应用');
      process.exit(1);
    }

    // Ensure exactly one active slide
    const activeSlides = ensureSingleActive(newSlides);

    finalHtml = wrapSlides(activeSlides, cfg.params?.title || name, buildBodyClass(cfg));
    if (cfg.themeOverrides && Object.keys(cfg.themeOverrides).length > 0) {
      finalHtml = injectThemeOverrides(finalHtml, cfg.themeOverrides);
    }
    writeFileAtomic(htmlPath, finalHtml);

    cfg.status = 'ready';
    cfg.lastGeneratedAt = new Date().toISOString();
    writeConfig(name, cfg);

    lintAfterGenerate(name, emit);
    const summary = `修改完成，共 ${sectionCount} 页幻灯片`;
    // LLM 修改说明优先；缺失时用行级 diff 兜底，方便用户知道改了哪里
    const details = llmDetails || buildLineDiff(slidesHtml, newSlides);
    emit('ready', summary);
    emitDone({ success: true, changed: finalHtml !== html, summary, details });
  } catch (err) {
    emitError(err.message);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
