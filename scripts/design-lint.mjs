#!/usr/bin/env node
// scripts/design-lint.mjs — 设计质量护栏：生成后对 deck 的 index.html 做静态校验。
// 规则蒸馏自 skills/ppt-design/SKILL.md 与 AGENTS.md（版式轮换、眉毛节制、禁渐变文字、
// 禁编造数据、一行大数字 ≤4 等）。既是 CLI（node scripts/design-lint.mjs <name> [--fix]），
// 也是库（lintHtml / lintProject / lintAfterGenerate）。
// 问题对象统一为 { page, rule, severity, message, autoFixed? }：
//   page     1-based 幻灯片页码（0 表示整文档级）
//   severity error（确定坏了）/ warning（违反设计规范）/ info（提示，不影响退出码）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { getProjectDir, isSafeName } from './config.mjs';
import { writeFileAtomic } from './fs-utils.mjs';
import { createSnapshot } from './snapshot.mjs';

export const SEVERITIES = ['error', 'warning', 'info'];

// ---- 幻灯片定位（与 chat-modify.mjs 的 selectSlides 同一套放宽策略） ----

export function selectSlides($) {
  let slides = $('main.stage > section.slide');
  if (!slides.length) slides = $('main.stage section.slide');
  if (!slides.length) slides = $('section.slide');
  if (!slides.length) slides = $('.slide');
  return slides;
}

function issue(page, rule, severity, message) {
  return { page, rule, severity, message };
}

// ---- 规则集（每条独立纯函数：($, slides, ctx) => issues[]） ----

// 一行 hero-stat / big-number 超过 4 个（AGENTS.md 第 11 条）。
// 按容器统计：优先 .split-visual，无则退到整页；hero-stat 内嵌 big-number 不重复计数。
export function ruleHeroStatOverflow($, slides) {
  const issues = [];
  slides.each((i, el) => {
    const $slide = $(el);
    const containers = $slide.find('.split-visual').length ? $slide.find('.split-visual') : $slide;
    containers.each((_, c) => {
      const $c = $(c);
      const heroes = $c.find('.hero-stat').length;
      const count = heroes || $c.find('.big-number').length;
      if (count > 4) {
        issues.push(issue(i + 1, 'hero-stat-overflow', 'warning',
          `一行大数字（hero-stat/big-number）共 ${count} 个，超过 4 个上限，请拆页或改表格/卡片`));
      }
    });
  });
  return issues;
}

// 标题缺失或过长（h1/h2 超 30 字警告）
export function ruleHeadingIssues($, slides) {
  const issues = [];
  slides.each((i, el) => {
    const $slide = $(el);
    const heading = $slide.find('h1, h2').first();
    if (!heading.length) {
      issues.push(issue(i + 1, 'missing-heading', 'warning', '缺少 h1/h2 标题'));
      return;
    }
    const text = heading.text().replace(/\s+/g, '');
    if (text.length > 30) {
      issues.push(issue(i + 1, 'long-heading', 'warning',
        `标题过长（${text.length} 字，建议 ≤30）：「${text.slice(0, 20)}…」`));
    }
  });
  return issues;
}

// 渐变文字 .gradient-text（已弃用类；唯一的安全自动修复项：移除该类）
export function ruleGradientText($, slides) {
  const issues = [];
  slides.each((i, el) => {
    const count = $(el).find('.gradient-text').length + ($(el).hasClass('gradient-text') ? 1 : 0);
    if (count > 0) {
      issues.push(issue(i + 1, 'gradient-text', 'warning',
        `使用了已弃用的 gradient-text 类（${count} 处），--fix 可自动移除`));
    }
  });
  return issues;
}

// 空 slide / 无实质内容（文本不足且无图/表/矢量）
export function ruleEmptySlide($, slides) {
  const issues = [];
  slides.each((i, el) => {
    const $slide = $(el);
    const text = $slide.text().replace(/\s+/g, '');
    const hasMedia = $slide.find('img, svg, table, video, iframe').length > 0;
    if (text.length < 10 && !hasMedia) {
      issues.push(issue(i + 1, 'empty-slide', 'error', '幻灯片为空或无实质内容'));
    }
  });
  return issues;
}

// kicker / section-title 每页超过 1 个（眉毛节制）
export function ruleKickerOveruse($, slides) {
  const issues = [];
  slides.each((i, el) => {
    const count = $(el).find('.kicker, .section-title').length;
    if (count > 1) {
      issues.push(issue(i + 1, 'kicker-overuse', 'warning',
        `kicker/section-title 共 ${count} 个，每页最多 1 个（眉毛节制）`));
    }
  });
  return issues;
}

// 疑似编造/占位数据痕迹（lorem、XX% 占位、示例文案等）——只提示，不自动改。
// 误报风险高，定级 info。
const SUSPECT_PATTERNS = [
  { re: /lorem|ipsum/i, label: 'lorem 占位文字' },
  { re: /X{2,}/i, label: 'XX 占位符（如 XX%、XXX 万）' },
  { re: /占位(文本|符|内容|数据)?/, label: '占位文案' },
  { re: /示例(文本|数据|文案|内容)/, label: '示例文案' },
  { re: /_{3,}/, label: '下划线填空' },
  { re: /(待补充|待填写|TODO|TBD)/i, label: '待补充标记' },
];
export function ruleSuspectData($, slides) {
  const issues = [];
  slides.each((i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ');
    const hits = SUSPECT_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label);
    if (hits.length) {
      issues.push(issue(i + 1, 'suspect-data', 'info',
        `疑似编造/占位数据痕迹：${hits.join('、')}，请核对是否为来源中的真实内容`));
    }
  });
  return issues;
}

// 连续 3 页以上同一版式（版式轮换）：按 section class + slide-content 直接子节点
// 的「标签+类」组合做指纹。软规范，定级 info。
export function slideLayoutFingerprint($, slideEl) {
  const sectionClass = String($(slideEl).attr('class') || '')
    .split(/\s+/).filter((c) => c && c !== 'slide' && c !== 'active').sort().join(' ');
  const content = $(slideEl).find('.slide-content').first();
  const children = (content.length ? content.children() : $(slideEl).children())
    .map((_, el) => {
      const cls = String($(el).attr('class') || '').split(/\s+/).sort().join('.');
      return `${el.tagName}${cls ? '.' + cls : ''}`;
    }).get().join('|');
  return `${sectionClass}::${children}`;
}

export function ruleLayoutMonotony($, slides) {
  const issues = [];
  const prints = slides.map((_, el) => slideLayoutFingerprint($, el)).get();
  let runStart = 0;
  for (let i = 1; i <= prints.length; i++) {
    if (i < prints.length && prints[i] === prints[runStart]) continue;
    const runLen = i - runStart;
    if (runLen >= 3 && prints[runStart] !== '') {
      issues.push(issue(runStart + 1, 'layout-monotony', 'info',
        `第 ${runStart + 1}–${i} 页连续 ${runLen} 页使用同一版式，建议轮换结构`));
    }
    runStart = i;
  }
  return issues;
}

// 表格密度：超 6 行（不含表头）或超 4 列
export function ruleDenseTable($, slides) {
  const issues = [];
  slides.each((i, el) => {
    $(el).find('table').each((_, t) => {
      const $t = $(t);
      const bodyRows = $t.find('tbody tr').length || Math.max(0, $t.find('tr').length - ($t.find('thead tr').length ? 1 : 0));
      let cols = 0;
      $t.find('tr').each((__, tr) => {
        cols = Math.max(cols, $(tr).find('th, td').length);
      });
      const problems = [];
      if (bodyRows > 6) problems.push(`${bodyRows} 行（建议 ≤6）`);
      if (cols > 4) problems.push(`${cols} 列（建议 ≤4）`);
      if (problems.length) {
        issues.push(issue(i + 1, 'dense-table', 'warning', `表格密度过高：${problems.join('，')}`));
      }
    });
  });
  return issues;
}

// 图片引用不存在（本地相对路径检查文件存在性；需 ctx.projectDir）
export function ruleMissingImage($, slides, ctx = {}) {
  const issues = [];
  if (!ctx.projectDir) return issues;
  slides.each((i, el) => {
    $(el).find('img[src]').each((_, img) => {
      const src = String($(img).attr('src') || '').trim();
      if (!src || /^(https?:)?\/\//i.test(src) || src.startsWith('data:') || src.startsWith('#')) return;
      const target = path.resolve(ctx.projectDir, decodeURIComponent(src.split(/[?#]/)[0]));
      // 防路径穿越：只允许项目目录内的引用
      if (!target.startsWith(path.resolve(ctx.projectDir) + path.sep)) return;
      if (!fs.existsSync(target)) {
        issues.push(issue(i + 1, 'missing-image', 'error', `图片不存在：${src}`));
      }
    });
  });
  return issues;
}

export const RULES = [
  ruleHeroStatOverflow,
  ruleHeadingIssues,
  ruleGradientText,
  ruleEmptySlide,
  ruleKickerOveruse,
  ruleSuspectData,
  ruleLayoutMonotony,
  ruleDenseTable,
  ruleMissingImage,
];

// ---- lint 主流程 ----

// 对整份 index.html 跑全部规则。
// options.fix=true 时应用安全自动修复（目前仅 gradient-text 移除）并返回修复后 html；
// 无可修复项时 html 原样返回（不做 cheerio 整文档重序列化）。
export function lintHtml(html, options = {}) {
  const { projectDir = null, fix = false } = options;
  const $ = load(html);
  const slides = selectSlides($);
  const issues = [];
  for (const rule of RULES) issues.push(...rule($, slides, { projectDir }));

  let fixedHtml = html;
  let fixedCount = 0;
  if (fix && $('.gradient-text').length > 0) {
    $('.gradient-text').each((_, el) => {
      const cls = String($(el).attr('class') || '').split(/\s+/).filter((c) => c && c !== 'gradient-text');
      if (cls.length) $(el).attr('class', cls.join(' '));
      else $(el).removeAttr('class');
    });
    fixedHtml = $.html();
    fixedCount = issues.filter((it) => it.rule === 'gradient-text').length;
    for (const it of issues) if (it.rule === 'gradient-text') it.autoFixed = true;
  }
  return { issues, html: fixedHtml, fixedCount };
}

// 项目级 lint：读 projects/<name>/index.html。
// options.fix=true 时写回修复结果（writeFileAtomic）；options.snapshot=true 修复前自动快照。
export function lintProject(name, options = {}) {
  const { fix = false, snapshot = true } = options;
  if (!isSafeName(name)) throw new Error(`非法项目名：${name}`);
  const projectDir = getProjectDir(name);
  const htmlPath = path.join(projectDir, 'index.html');
  if (!fs.existsSync(htmlPath)) throw new Error(`项目 ${name} 不存在或尚未生成幻灯片`);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const result = lintHtml(html, { projectDir, fix });
  if (fix && result.fixedCount > 0 && result.html !== html) {
    if (snapshot) createSnapshot(name, '设计检查自动修复前');
    writeFileAtomic(htmlPath, result.html);
  }
  return { name, file: htmlPath, ...result };
}

export function summarizeIssues(issues) {
  const summary = { error: 0, warning: 0, info: 0, autoFixed: 0 };
  for (const it of issues) {
    summary[it.severity] = (summary[it.severity] || 0) + 1;
    if (it.autoFixed) summary.autoFixed++;
  }
  summary.total = issues.length;
  return summary;
}

// 生成管线接入点：writeDeckIndex 完成后调用；lint 失败不阻断生成。
// 自动修复仅安全项（gradient-text），不开快照（刚生成的文件无历史价值）。
export function lintAfterGenerate(name, emitFn) {
  try {
    const { issues, fixedCount } = lintProject(name, { fix: true, snapshot: false });
    if (typeof emitFn === 'function') {
      const s = summarizeIssues(issues);
      const msg = s.total > 0
        ? `设计检查：${s.total} 个问题（error ${s.error} / warning ${s.warning} / info ${s.info}）`
          + (s.autoFixed ? `，已自动修复 ${s.autoFixed} 处` : '')
        : `设计检查：未发现问题`;
      emitFn('lint', msg, { issues, fixedCount });
    }
    return issues;
  } catch (err) {
    if (typeof emitFn === 'function') emitFn('lint', `设计检查失败（不影响生成结果）：${err.message}`);
    return [];
  }
}

// ---- CLI ----

function printReport(name, result) {
  const { issues } = result;
  const s = summarizeIssues(issues);
  console.log(`\n设计检查报告：${name}`);
  console.log('='.repeat(50));
  if (!issues.length) {
    console.log('✓ 未发现问题');
    return s;
  }
  const icons = { error: '✗', warning: '⚠', info: 'ℹ' };
  for (const it of issues) {
    const page = it.page > 0 ? `第 ${String(it.page).padStart(2)} 页` : '全局  ';
    const fixed = it.autoFixed ? '（已自动修复）' : '';
    console.log(`${icons[it.severity] || '?'} [${it.severity.padEnd(7)}] ${page} ${it.rule}: ${it.message}${fixed}`);
  }
  console.log('-'.repeat(50));
  console.log(`共 ${s.total} 个问题：error ${s.error} / warning ${s.warning} / info ${s.info}`
    + (s.autoFixed ? `；已自动修复 ${s.autoFixed} 处` : ''));
  return s;
}

function main() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('-'));
  const fix = args.includes('--fix');
  if (!name) {
    console.error('Usage: node scripts/design-lint.mjs <project> [--fix]');
    process.exit(2);
  }
  try {
    const result = lintProject(name, { fix, snapshot: true });
    const s = printReport(name, result);
    // error / warning 影响退出码；info 仅提示
    process.exit(s.error + s.warning > 0 ? 1 : 0);
  } catch (err) {
    console.error(`设计检查失败：${err.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
