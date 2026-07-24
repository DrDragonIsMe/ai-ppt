#!/usr/bin/env node
// scripts/generate-report.mjs — 从多篇知识库笔记生成结构化中文 Markdown 报告。
// LLM 不可用时降级为确定性拼接模板（笔记标题 + 正文摘录）。
// 产物落盘 vault/reports/<safe-name>.md。
// CLI: node scripts/generate-report.mjs <note1,note2,...> [title]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNote, parseFrontMatter, ensureVaultDirs, REPORTS_DIR } from './vault.mjs';
import { isSafeName } from './config.mjs';
import { generateSlides } from './llm-adapter.mjs';
import { buildModelOptions, stripMarkdown } from './generation-common.mjs';

const __filename = fileURLToPath(import.meta.url);

// 收集笔记内容：[{ name, title, body }]
function collectNotes(noteNames) {
  if (!Array.isArray(noteNames) || noteNames.length === 0) {
    throw new Error('请至少选择一篇笔记');
  }
  const collected = [];
  for (const raw of noteNames) {
    const name = String(raw).trim().replace(/\.md$/i, '');
    if (!name) continue;
    if (!isSafeName(name)) throw new Error(`非法笔记名称：${name}`);
    const content = readNote(name);
    if (content === null) throw new Error(`笔记不存在：${name}`);
    const { frontMatter, content: body } = parseFrontMatter(content);
    collected.push({ name, title: frontMatter.title || name, body: body.trim() });
  }
  if (!collected.length) throw new Error('请至少选择一篇笔记');
  return collected;
}

// 确定性降级模板：# 标题 / 摘要 / 要点（每篇笔记摘录）/ 结论
function buildFallbackReport(title, collected) {
  const lines = [
    `# ${title}`,
    '',
    '## 摘要',
    '',
    `本报告基于 ${collected.length} 篇笔记生成：${collected.map((n) => n.title).join('、')}。`,
    '',
    '## 要点',
    '',
  ];
  for (const n of collected) {
    const excerpt = stripMarkdown(n.body).replace(/\s+/g, ' ').slice(0, 200);
    lines.push(`- **${n.title}**：${excerpt || '（无正文内容）'}`);
  }
  lines.push('', '## 结论', '', '以上为笔记内容的确定性汇总（未调用 LLM）。');
  return lines.join('\n');
}

// 报告标题 → 安全文件名（不含扩展名）
function toSafeFileName(title) {
  const base = String(title)
    .replace(/\.md$/i, '')
    .replace(/[^\w一-龥-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return base || `report-${Date.now()}`;
}

// 生成报告：读笔记 → 文本模型生成结构化 Markdown；LLM 失败降级为确定性模板。
// 返回 { name, content }，name 为不含扩展名的文件名。
async function generateReport(noteNames, title, apiKey) {
  const collected = collectNotes(noteNames);
  const reportTitle = (typeof title === 'string' && title.trim())
    || `笔记报告 · ${collected[0].title}${collected.length > 1 ? ` 等 ${collected.length} 篇` : ''}`;

  const source = collected.map((n) => `【${n.title}】\n${n.body}`).join('\n\n');

  let content = null;
  try {
    const options = buildModelOptions();
    if (apiKey) options.apiKey = apiKey; // 临时透传，不落盘
    const prompt = `请把以下笔记内容整理成一份结构化中文报告，使用 Markdown 格式，包含：# 标题、## 摘要、## 要点（无序列表）、## 结论。只输出 Markdown 正文，不要输出其他解释。
报告标题：${reportTitle}

笔记内容：
${stripMarkdown(source).slice(0, 8000)}`;
    const result = await generateSlides(prompt, options);
    if (result && result.content && result.content.trim().length > 50) {
      content = result.content.trim();
    }
  } catch {
    // LLM 失败，降级到确定性模板
  }
  if (!content) content = buildFallbackReport(reportTitle, collected);

  ensureVaultDirs();
  const base = toSafeFileName(reportTitle);
  let name = base;
  for (let n = 2; fs.existsSync(path.join(REPORTS_DIR, `${name}.md`)); n++) {
    name = `${base}-${n}`;
  }
  fs.writeFileSync(path.join(REPORTS_DIR, `${name}.md`), content, 'utf8');
  return { name, content };
}

export { generateReport, buildFallbackReport, collectNotes };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const notesArg = process.argv[2];
  if (!notesArg) {
    console.error('Usage: node scripts/generate-report.mjs <note1,note2,...> [title]');
    process.exit(1);
  }
  const noteNames = notesArg.split(',').map((s) => s.trim()).filter(Boolean);
  generateReport(noteNames, process.argv[3]).then(({ name }) => {
    console.log(`报告已生成：vault/reports/${name}.md`);
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
