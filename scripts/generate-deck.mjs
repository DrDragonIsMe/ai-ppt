#!/usr/bin/env node
import fs from 'node:fs';
import { readConfig, writeConfig, getProjectDir, writeDeckIndex } from './config.mjs';
import { extractFromUrl } from './content-extractor.mjs';
import {
  emit,
  emitError,
  emitDone,
  stripMarkdown,
  formatUserEdits,
  buildModelOptions,
  buildBodyClass,
  buildSlidesPrompt,
  buildFallbackSlides,
  generateSlidesHtml,
} from './generation-common.mjs';

function setStatus(name, status, errorMessage = null) {
  const cfg = readConfig(name);
  cfg.status = status;
  cfg.errorMessage = errorMessage;
  if (status === 'ready') cfg.lastGeneratedAt = new Date().toISOString();
  writeConfig(name, cfg);
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

// 差异化指令：URL/文章来源的提示词（通用脚手架 + 本源的严格规则 + userEdits 约束）
function buildPrompt(cfg, content) {
  const p = cfg.params || {};
  return buildSlidesPrompt({
    task: '请根据以下内容生成一套演示文稿幻灯片。',
    title: p.title || cfg.name,
    audience: p.audience || '通用',
    style: p.style || '商业汇报',
    language: p.language || 'zh-CN',
    slideCount: p.slideCount || 8,
    contentLabel: '来源内容（已提取关键文本）',
    content,
    contentLimit: 6000,
    extraRules: `- 卡片式页面（tile-row / visual-row）不超过总页数的 1/3，能用表格、图表、时间轴、大数字表达的不要用卡片。
- 内容中有数据、指标、百分比时，优先用可视化组件展示（big-number、chart-bar、progress-ring、waterfall、timeline-horizontal 等）；数字只使用来源内容中真实存在的；同一行大数字不超过 4 个。
- kicker / section-title 只允许出现在封面和收尾页；内容页一律不用。
- 禁止使用 gradient-text 类；禁止在封面放置描述演示原则的标签（badge）；封面只放标题、副标题、署名/日期。
`,
    userEditsSection: formatUserEdits(cfg),
  });
}

// 兜底：标题 + 解析出的章节要点交给统一参数化模板
function buildDeckFallback(cfg, content) {
  const title = cfg.params?.title || cfg.name;
  const subtitle = [cfg.params?.style, cfg.params?.audience]
    .filter(Boolean)
    .join(' · ');
  const sections = parseSections(content).slice(0, 6)
    .map((sec) => ({ heading: sec.title, points: sec.points.slice(0, 3) }));
  return buildFallbackSlides({
    title,
    subtitle,
    fancyCover: true,
    closingTitle: '谢谢观看',
    closingLead: title,
    sections,
  });
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

    // Model config is now system-level (global config). The API key comes from
    // the environment (AI_PPT_API_KEY passed by the Web UI for this session, or
    // OPENAI_API_KEY from .env.kimi) - never from persisted config.
    const modelOptions = buildModelOptions(cfg.params?.model);
    const minSections = Math.max(3, Math.round((cfg.params?.slideCount || 8) * 0.7));
    const slidesHtml = await generateSlidesHtml({
      prompt,
      modelOptions,
      minSections,
      buildFallback: () => buildDeckFallback(cfg, content),
    });

    emit('build', '正在写入 index.html');
    writeDeckIndex(name, slidesHtml, {
      title: cfg.params?.title || cfg.name,
      bodyClass: buildBodyClass(cfg),
      themeOverrides: cfg.themeOverrides,
    });

    setStatus(name, 'ready');
    emit('ready', '生成完成');
    emitDone();
  } catch (err) {
    setStatus(name, 'error', err.message);
    emitError(err.message);
    process.exit(1);
  }
}

main();
