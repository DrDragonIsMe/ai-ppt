#!/usr/bin/env node
// 笔记 AI 对话修改（契约 O）：node scripts/chat-note.mjs <note-name> <instruction>
// NDJSON 协议与 chat-modify.mjs 一致：progress 行 + done{success,changed,summary} / error 行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNote, writeNote } from './vault.mjs';
import { rebuildIndex } from './link-resolver.mjs';
import { generateSlides } from './llm-adapter.mjs';
import { emit, emitError, emitDone, buildModelOptions, splitChangeDetails, buildLineDiff } from './generation-common.mjs';
import { splitFrontMatter } from './front-matter.mjs';
import { writeFileAtomic } from './fs-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SNAPSHOTS_VAULT_DIR = path.join(ROOT, '.snapshots', '_vault');

// 去掉 LLM 输出可能携带的 markdown 代码围栏
function stripCodeFences(text) {
  let out = String(text).trim();
  const fenced = out.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) out = fenced[1].trim();
  return out;
}

function buildNotePrompt(name, content, instruction) {
  return `你是一位专业的知识管理助手。下面是知识库笔记「${name}」的完整 Markdown 内容。

【用户修改指令】
${instruction}

【当前笔记内容】
${content}

【要求】
1. 严格按指令修改笔记正文，不要改动 front matter（--- 之间的元数据），保持原样输出。
2. 保留所有 [[wikilink]] 双链写法，不要改成普通文本或 Markdown 链接。
3. 保持 Markdown 结构与格式（标题、列表、引用等），只按指令修改正文内容。
4. 输出修改后的完整笔记 Markdown，不要输出代码围栏（\`\`\`），不要在正文中输出解释文字。
5. 在完整笔记内容之后，单独一行输出 ---修改说明---，然后逐行列出你做的每处修改（位置 + 改了什么，简明扼要，每条一行）。`;
}

async function main() {
  const [name, instruction] = process.argv.slice(2);
  if (!name || !instruction) {
    console.error('Usage: node scripts/chat-note.mjs <note-name> <instruction>');
    process.exit(1);
  }

  let original;
  try {
    original = readNote(name);
  } catch (err) {
    emitError(err.message);
    process.exit(1);
  }
  if (original == null) {
    emitError(`笔记 "${name}" 不存在`);
    process.exit(1);
  }

  emit('start', `开始修改笔记 ${name}：${instruction}`);

  try {
    // 修改前备份原文到 .snapshots/_vault/<时间戳>/（与 renameNote 同约定），失败只告警不阻断
    emit('snapshot', '修改前自动备份笔记');
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = path.join(SNAPSHOTS_VAULT_DIR, ts);
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(path.join(dir, path.basename(name.replace(/\.md$/i, '') + '.md')), original);
    } catch (err) {
      console.error('笔记自动备份失败:', err);
    }

    const prompt = buildNotePrompt(name, original, instruction);
    emit('llm', '正在调用模型修改笔记');

    const result = await generateSlides(prompt, buildModelOptions());
    if (!result) {
      emitError('未配置可用 LLM：请到「设置」面板配置文本模型或填写 API Key');
      process.exit(1);
    }
    emit('llm-provider', `使用模型: ${result.provider}`);

    const cleaned = stripCodeFences(result.content);
    if (!cleaned) {
      emitError('模型返回内容为空，修改未应用');
      process.exit(1);
    }

    // 分离正文与修改说明（---修改说明--- 之后的部分不写入笔记）
    const { content: noteContent, details: llmDetails } = splitChangeDetails(cleaned);
    if (!noteContent) {
      emitError('模型返回内容为空，修改未应用');
      process.exit(1);
    }

    // front matter 保护：始终用原 front matter 拼回，LLM 返回的 front matter 一律丢弃
    const origParts = splitFrontMatter(original);
    const newParts = splitFrontMatter(noteContent);
    const finalContent = origParts.fm
      ? origParts.fm + newParts.body.replace(/^\n+/, '')
      : noteContent;
    if (!splitFrontMatter(finalContent).body.trim() && !finalContent.trim()) {
      emitError('模型未返回有效笔记内容，修改未应用');
      process.exit(1);
    }

    writeNote(name, finalContent);
    rebuildIndex();

    const summary = `笔记 ${name} 修改完成`;
    // LLM 修改说明优先；缺失时用行级 diff 兜底，方便用户知道改了哪里
    const details = llmDetails || buildLineDiff(original, finalContent);
    emit('ready', summary);
    emitDone({ success: true, changed: finalContent !== original, summary, details });
  } catch (err) {
    emitError(err.message);
    process.exit(1);
  }
}

main();
