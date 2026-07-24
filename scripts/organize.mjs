#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  listFragments,
  getFragment,
  updateFragment,
  deleteFragment
} from './fragments.mjs';
import { listNotes, createNote, getNotePath } from './vault.mjs';
import { rebuildIndex } from './link-resolver.mjs';
import { getCards, saveCard } from './knowledge-cards.mjs';
import { saveMistake } from './exam-papers.mjs';
import { generateSlides } from './llm-adapter.mjs';
import { readGlobalConfig } from './global-config.mjs';

const VALID_ACTIONS = ['promote', 'tag', 'link', 'merge', 'leave'];
const VALID_PROMOTE_TO = ['card', 'note', 'mistake'];
// 疑问词：命中这些特征的碎片在降级规则中优先建议升格为知识卡片
const QUESTION_RE = /什么|如何|为什么|区别|[?？]/;

function isUnsafeName(name) {
  return typeof name !== 'string' || /[/\\]/.test(name) || name.includes('..');
}

function fragmentPreview(content) {
  return (content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// 标题/题干去掉 #标签 标记，避免截断后残留 #
function plainFirstLine(content) {
  const firstLine = ((content || '').split('\n')[0] || '').trim();
  return firstLine.replace(/#[\p{L}\p{N}_-]+/gu, '').replace(/\s{2,}/g, ' ').trim();
}

function buildPrompt(inbox, noteTitles, cardTitles) {
  const fragmentList = inbox.map(f => ({
    id: f.id,
    content: f.content.slice(0, 500),
    tags: f.tags
  }));
  return `你是知识管理助手。下面是收件箱中的速记碎片（JSON）、现有笔记标题和知识卡片标题。请为每条碎片建议一个整理动作。

动作枚举：
- promote：升格为正式内容，附 "to"（card=知识卡片 / note=笔记 / mistake=错题）。疑问、定义、知识点类碎片适合 card；成体系的内容适合 note；易错点适合 mistake。
- tag：补充标签，附 "tags"（字符串数组）。
- link：关联到现有笔记，附 "linkNote"（必须是下方笔记标题之一，不要编造）。
- merge：与另一条内容重复的碎片合并，附 "mergeWith"（目标碎片 id，必须是碎片列表中的 id）。
- leave：暂不处理。

只输出严格的 JSON 数组，不要输出任何其他文字。每项格式：
{"fragmentId":"碎片id","action":"promote","to":"card","reason":"原因"}

碎片列表：
${JSON.stringify(fragmentList, null, 2)}

现有笔记标题：${JSON.stringify(noteTitles)}
现有卡片标题：${JSON.stringify(cardTitles)}`;
}

// 清洗 LLM 输出：去掉 markdown 围栏，截取第一个 [ 到最后一个 ]
function parseSuggestionsJson(text) {
  if (!text) return null;
  let cleaned = String(text).replace(/```(?:json)?\s*/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 校验并补全 LLM 返回的建议，丢弃不合法条目
function sanitizeSuggestions(rawList, inbox, noteTitles) {
  const inboxIds = new Set(inbox.map(f => f.id));
  const noteSet = new Set(noteTitles);
  const suggestions = [];
  for (const raw of rawList) {
    if (!raw || !inboxIds.has(raw.fragmentId) || !VALID_ACTIONS.includes(raw.action)) continue;
    const fragment = inbox.find(f => f.id === raw.fragmentId);
    const suggestion = {
      fragmentId: raw.fragmentId,
      fragmentPreview: fragmentPreview(fragment.content),
      action: raw.action,
      reason: String(raw.reason || '').slice(0, 120)
    };
    if (raw.action === 'promote') {
      if (!VALID_PROMOTE_TO.includes(raw.to)) continue;
      suggestion.to = raw.to;
    } else if (raw.action === 'tag') {
      const tags = Array.isArray(raw.tags) ? raw.tags.map(t => String(t).trim()).filter(Boolean) : [];
      if (tags.length === 0) continue;
      suggestion.tags = [...new Set(tags)];
    } else if (raw.action === 'link') {
      if (!noteSet.has(raw.linkNote)) continue;
      suggestion.linkNote = raw.linkNote;
    } else if (raw.action === 'merge') {
      if (!inboxIds.has(raw.mergeWith) || raw.mergeWith === raw.fragmentId) continue;
      suggestion.mergeWith = raw.mergeWith;
    }
    suggestions.push(suggestion);
  }
  return suggestions;
}

// 无 LLM 时的确定性降级规则
function buildFallbackSuggestions(inbox, notes, cards) {
  const suggestions = [];
  for (const fragment of inbox) {
    const base = {
      fragmentId: fragment.id,
      fragmentPreview: fragmentPreview(fragment.content)
    };
    if (QUESTION_RE.test(fragment.content)) {
      suggestions.push({
        ...base,
        action: 'promote',
        to: 'card',
        reason: '包含疑问词，适合整理为知识卡片'
      });
      continue;
    }
    const other = inbox.find(f => f.id !== fragment.id && f.tags.some(t => fragment.tags.includes(t)));
    if (fragment.tags.length > 0 && other) {
      suggestions.push({
        ...base,
        action: 'merge',
        mergeWith: other.id,
        reason: `与碎片 ${other.id} 共享标签（${fragment.tags.filter(t => other.tags.includes(t)).join('、')}），建议合并`
      });
      continue;
    }
    if (fragment.tags.length > 0) {
      // 有标签但结构单薄：从共享标签的笔记/卡片中补充关联标签
      const extra = [];
      for (const note of notes) {
        const noteTags = Array.isArray(note.tags) ? note.tags : [];
        if (noteTags.some(t => fragment.tags.includes(t))) extra.push(...noteTags);
      }
      for (const card of cards) {
        if ((card.tags || []).some(t => fragment.tags.includes(t))) extra.push(...card.tags);
      }
      const tags = [...new Set([...fragment.tags, ...extra])].slice(0, 5);
      suggestions.push({
        ...base,
        action: 'tag',
        tags,
        reason: '已有标签，建议参考同标签笔记/卡片补全标签'
      });
      continue;
    }
    suggestions.push({ ...base, action: 'leave', reason: '无明确整理线索，留在收件箱' });
  }
  return suggestions;
}

async function buildOrganizeSuggestions() {
  const inbox = listFragments({ status: 'inbox' });
  if (inbox.length === 0) {
    return { suggestions: [], degraded: false };
  }
  const notes = listNotes();
  const noteTitles = notes.map(n => n.name);
  const cards = getCards();
  const cardTitles = cards.map(c => c.title);

  // 优先走 LLM；不可用或输出无法解析时降级为确定性规则
  try {
    const { modelConfig } = readGlobalConfig();
    const output = await generateSlides(buildPrompt(inbox, noteTitles, cardTitles), {
      provider: modelConfig.provider,
      baseUrl: modelConfig.baseUrl,
      model: modelConfig.model
    });
    const parsed = parseSuggestionsJson(output?.content);
    if (parsed) {
      const suggestions = sanitizeSuggestions(parsed, inbox, noteTitles);
      if (suggestions.length > 0) {
        return { suggestions, degraded: false };
      }
    }
  } catch (err) {
    if (process.env.AI_PPT_DEBUG) console.error('[organize] LLM 失败：', err.message);
  }
  return { suggestions: buildFallbackSuggestions(inbox, notes, cards), degraded: true };
}

// 升格碎片为卡片 / 笔记 / 错题，成功后标记 organized；字段映射与 server.mjs promote 路由一致
function promoteFragment(fragment, to) {
  const content = fragment.content || '';
  const tags = fragment.tags || [];
  const plain = plainFirstLine(content);
  let target;
  if (to === 'card') {
    const cardId = `card-${Date.now()}`;
    saveCard(cardId, {
      title: plain.slice(0, 30) || cardId,
      question: plain.slice(0, 80) || content.slice(0, 80),
      answer: content,
      tags
    });
    target = { cardId };
  } else if (to === 'note') {
    // 标题取第一行截断 30 字，剔除不安全字符；重名自动加 -2/-3 后缀
    let base = plain.slice(0, 30).replace(/[/\\]|[\x00-\x1f\x7f]/g, '').replace(/\.\./g, '').trim();
    if (!base) base = `碎片-${fragment.id}`;
    let name = base;
    for (let n = 2; fs.existsSync(getNotePath(name)); n++) name = `${base}-${n}`;
    const notePath = createNote(name, content);
    rebuildIndex();
    target = { name, path: notePath };
  } else {
    const mistakeId = `mistake-${Date.now()}`;
    saveMistake(mistakeId, {
      question: content,
      answer: '',
      tags,
      source: 'organize'
    });
    target = { mistakeId };
  }
  updateFragment(fragment.id, { status: 'organized' });
  return target;
}

function applyOrganizeActions(actions) {
  const results = [];
  const errors = [];
  let applied = 0;

  for (const action of Array.isArray(actions) ? actions : []) {
    const fragmentId = action && action.fragmentId;
    try {
      if (isUnsafeName(fragmentId)) {
        errors.push({ fragmentId: String(fragmentId ?? ''), error: '非法碎片 ID' });
        continue;
      }
      if (!VALID_ACTIONS.includes(action.action)) {
        errors.push({ fragmentId, error: `非法动作：${action.action}` });
        continue;
      }
      const fragment = getFragment(fragmentId);
      if (!fragment) {
        errors.push({ fragmentId, error: '碎片不存在' });
        continue;
      }

      if (action.action === 'promote') {
        if (!VALID_PROMOTE_TO.includes(action.to)) {
          errors.push({ fragmentId, error: `非法转化目标：${action.to}` });
          continue;
        }
        const target = promoteFragment(fragment, action.to);
        results.push({ fragmentId, action: 'promote', to: action.to, target });
      } else if (action.action === 'tag') {
        const tags = Array.isArray(action.tags) ? action.tags.map(t => String(t).trim()).filter(Boolean) : [];
        if (tags.length === 0) {
          errors.push({ fragmentId, error: '缺少标签' });
          continue;
        }
        const updated = updateFragment(fragmentId, { tags: [...fragment.tags, ...tags] });
        results.push({ fragmentId, action: 'tag', tags: updated.tags });
      } else if (action.action === 'link') {
        if (isUnsafeName(action.linkNote)) {
          errors.push({ fragmentId, error: '非法笔记名称' });
          continue;
        }
        updateFragment(fragmentId, { content: `${fragment.content}\n\n[[${action.linkNote}]]` });
        results.push({ fragmentId, action: 'link', linkNote: action.linkNote });
      } else if (action.action === 'merge') {
        if (isUnsafeName(action.mergeWith)) {
          errors.push({ fragmentId, error: '非法目标碎片 ID' });
          continue;
        }
        const target = getFragment(action.mergeWith);
        if (!target) {
          errors.push({ fragmentId, error: `目标碎片不存在：${action.mergeWith}` });
          continue;
        }
        updateFragment(action.mergeWith, { content: `${target.content}\n\n${fragment.content}` });
        deleteFragment(fragmentId);
        results.push({ fragmentId, action: 'merge', mergeWith: action.mergeWith });
      } else {
        // leave：只记录原因，不动数据
        results.push({ fragmentId, action: 'leave', reason: String(action.reason || '') });
      }
      applied++;
    } catch (err) {
      errors.push({ fragmentId, error: err.message });
    }
  }

  return { applied, errors, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  switch (command) {
    case 'suggest': {
      const { suggestions, degraded } = await buildOrganizeSuggestions();
      console.log(JSON.stringify({ suggestions, degraded }, null, 2));
      break;
    }
    default:
      console.log('Usage: node scripts/organize.mjs [suggest]');
  }
}

export {
  buildOrganizeSuggestions,
  applyOrganizeActions
};
