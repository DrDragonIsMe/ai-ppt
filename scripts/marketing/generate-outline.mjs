#!/usr/bin/env node
// scripts/marketing/generate-outline.mjs — 营销大纲生成（契约 B030300）。
// 从多源素材库（scripts/sources）取材 → 分档摘要 → 逐角度调 LLM 产出契约形状的 angles/slides →
// 严格校验（角度数、thesis 互不重复、slides 形状、evidenceItemIds 存在性）→ 落盘 marketing/outlines/。
// LLM 不可用时走确定性兜底大纲：仍满足契约形状与角度区分度（thesis 取角度集定义、素材按关键词分桶），
// 并在事件里给出真实失败原因，不谎称成功。
// CLI: node scripts/marketing/generate-outline.mjs [--source src-a,src-b] [--product 名称]
//      [--audience X] [--tone Y] [--angle-set marketing-standard] [--title T] [--include-stale]
// stdout 输出 NDJSON 事件（协议同 scripts/sources/refresh.mjs）。
import { fileURLToPath } from 'node:url';
import { getAngleSet, angleSetId, DEFAULT_ANGLE_SET } from './angles.mjs';
import { collectMaterial, assignMaterial, buildAngleMaterial, digestItemForAngle } from './material.mjs';
import {
  makeOutlineId, normalizeOutline, validateOutline, enforceEvidenceIntegrity,
  saveOutline, slugify, makeDeckName,
} from './store.mjs';
import { makeEmitter, withHeartbeat } from './events.mjs';
import { buildModelOptions, stripMarkdown } from '../generation-common.mjs';
import { llmReachable } from './llm.mjs';
import { completeChat, getLastLlmError } from '../llm-adapter.mjs';

const SLIDES_PER_ANGLE_DEFAULT = 5;
const SLIDES_PER_ANGLE_MAX = 8;

// ---- LLM 提示词 ----

function anglePrompt({ angle, product, material, slideCount, knownIds }) {
  const idList = knownIds.slice(0, 200).join(' , ');
  return `你是一名 B2B 营销策划。请只为「${angle.title}」这一个角度产出幻灯片大纲，不要写其他角度。

产品：${product.name}
目标听众：${product.audience}
语气：${product.tone}

本角度必须回答的问题：${angle.lens}
本角度既定论点（可润色措辞，但立场不得改变、不得与其他角度混同）：${angle.thesis}

输出严格 JSON，不要任何解释文字、不要 Markdown 代码块围栏：
{"thesis":"一句话论点（不超过 40 字）","slides":[{"heading":"页标题（不超过 20 字）","lead":"一句话导语（不超过 40 字）","points":["要点1","要点2","要点3"],"evidenceItemIds":["it-0"]}]}

硬性要求：
- 恰好 ${slideCount} 页。每页只讲一个观点；points 每页 2-4 条，每条不超过 30 字。
- 只使用下面素材里真实出现的信息。禁止编造数字、客户名、案例、竞品对比。素材里没有数字就不要写数字。
- evidenceItemIds 只能引用素材块里出现过的 [编号]（形如 it-0），且必须逐页填写，指向真正支撑该页的素材。
  可用编号全集：${idList}
- 标题与要点必须体现「${angle.title}」这个角度的立场，换成别的角度就不能成立。

素材（已按本角度筛选压缩）：
${material}
`;
}

// ---- LLM 输出解析 ----

/** 从可能带围栏/前后废话的回答里抠出第一个 JSON 对象。 */
export function extractJsonObject(text) {
  const s = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 把 LLM 的单角度回答规整成契约形状。
 * 引用序号（it-0 / 裸数字）按 idMap 还原成真实 itemId；还原不了的先留着，交给完整性校验剔除并计数。
 */
export function normalizeAngleSlides(raw, { idMap, slideCount }) {
  const slides = Array.isArray(raw?.slides) ? raw.slides : [];
  const resolveIds = (list) => {
    const out = [];
    for (const v of (Array.isArray(list) ? list : [])) {
      const token = String(v ?? '').trim().replace(/^\[|\]$/g, '');
      if (!token) continue;
      let id = idMap.get(token) || null;
      if (!id && /^\d+$/.test(token)) {
        // 只有纯数字 token 才按下标还原；"it-7" 这类越界假引用必须原样透给防编造校验，
        // 否则 Number('it-7'.replace(/^it-?/,'')) === 7 会让伪造引用换个写法就绕过闸门。
        id = idMap.get(`it-${Number(token)}`) || null;
      }
      const resolved = id || token;
      if (!out.includes(resolved)) out.push(resolved);
    }
    return out;
  };

  const out = slides.slice(0, SLIDES_PER_ANGLE_MAX).map((s) => ({
    heading: stripMarkdown(String(s?.heading || '')).slice(0, 60),
    lead: stripMarkdown(String(s?.lead || '')).slice(0, 120),
    points: (Array.isArray(s?.points) ? s.points : [])
      .map((p) => stripMarkdown(String(p ?? '')).slice(0, 80))
      .filter(Boolean)
      .slice(0, 4),
    evidenceItemIds: resolveIds(s?.evidenceItemIds),
  })).filter((s) => s.heading);
  return out;
}

// ---- 确定性兜底 ----

/**
 * 无 LLM（或 LLM 输出不可用）时的兜底角度规划。
 * 区分度来源：角度关键词分桶 + thesis 取角度集定义；素材不足时各角度会复用条目，
 * 但每页只呈现该角度关键词命中的句子，因此不会退化成"同一批素材换六个标题"。
 */
export function fallbackAnglePlan(angle, entries, slideCount = SLIDES_PER_ANGLE_DEFAULT) {
  if (!entries.length) return { thesis: angle.thesis, slides: [] };
  const slides = [];
  for (const e of entries) {
    const sentences = String(e.digest || '').split(/\n—\s*/)[1] || '';
    const picked = (sentences ? sentences.split(' / ') : [])
      .map((s) => stripMarkdown(s).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 3);
    const headingRaw = stripMarkdown(e.item.title || '').replace(/\s+/g, ' ').trim();
    slides.push({
      heading: (headingRaw || angle.title).slice(0, 20),
      lead: picked[0] ? picked[0].slice(0, 40) : angle.lens.slice(0, 40),
      points: picked.slice(0, 3),
      evidenceItemIds: [e.item.itemId],
    });
    if (slides.length >= slideCount) break;
  }
  // 素材条数少于页数时，用同一批条目按角度视角再拆页（保证页数契约成立）
  let i = 0;
  while (slides.length < slideCount && i < 24) {
    const e = entries[i % entries.length];
    const body = String(e.digest || '').replace(/\s+/g, ' ').trim();
    slides.push({
      heading: `${angle.title} · 补充 ${slides.length + 1}`.slice(0, 20),
      lead: body.slice(0, 40),
      points: body ? [body.slice(0, 40), body.slice(40, 80)].filter(Boolean) : [],
      evidenceItemIds: [e.item.itemId],
    });
    i++;
  }
  return { thesis: angle.thesis, slides };
}

// ---- 主流程 ----

/**
 * 生成营销大纲。
 * @param {{sourceIds?:string[], product?:{name?:string,audience?:string,tone?:string},
 *          angleSet?:string, title?:string, slidesPerAngle?:number, includeStale?:boolean,
 *          emitter?:object, deps?:{completeChat?:Function,collectMaterial?:Function,
 *                 saveOutline?:Function,heartbeatMs?:number}}} [opts]
 * @returns {Promise<{outline:object, summary:object}>}
 */
export async function generateOutline(opts = {}) {
  const emitter = opts.emitter || makeEmitter();
  const deps = opts.deps || {};
  const doComplete = deps.completeChat || completeChat;
  const doCollect = deps.collectMaterial || collectMaterial;
  const doSave = deps.saveOutline || saveOutline;
  const heartbeatMs = deps.heartbeatMs;

  const setId = angleSetId(opts.angleSet || DEFAULT_ANGLE_SET);
  const angles = getAngleSet(setId);
  const product = {
    name: String(opts.product?.name || opts.productName || '').trim() || '本产品',
    audience: String(opts.product?.audience || '').trim() || '企业决策者',
    tone: String(opts.product?.tone || '').trim() || '专业、克制、以事实说服',
  };
  const slideCount = Math.min(
    Math.max(Number(opts.slidesPerAngle) || SLIDES_PER_ANGLE_DEFAULT, 3),
    SLIDES_PER_ANGLE_MAX,
  );
  const outlineId = opts.outlineId || makeOutlineId();

  emitter.progress('collect', '开始汇总多源素材', { sourceIds: opts.sourceIds || null, angleSet: setId });
  const material = doCollect({
    sourceIds: opts.sourceIds,
    includeStale: !!opts.includeStale,
    listItemsFn: deps.listItemsFn,
    readItemFn: deps.readItemFn,
    readManifestFn: deps.readManifestFn,
  });
  const knownItemIds = new Set(material.items.map((it) => it.itemId));
  if (!material.items.length) {
    const err = new Error('素材库为空：没有可用条目（可能全部被标 stale 或源未刷新），无法生成营销大纲');
    err.code = 'EMPTY_MATERIAL';
    throw err;
  }
  emitter.progress('collect',
    `素材汇总完成：${material.stats.itemCount} 条 / ${material.stats.corpusChars} 字`
    + (material.stats.staleSkipped ? `，另有 ${material.stats.staleSkipped} 条 stale 未纳入` : ''),
    { perSource: material.perSource, warnings: material.warnings });
  for (const w of material.warnings) emitter.progress('material-warning', w);

  const assignment = assignMaterial(angles, material.items, { perAngleItems: Math.max(slideCount, 6) });

  const modelOptions = deps.modelOptions ?? buildModelOptions();
  // 可达性用 llmReachable（真信号：远程必须有 key），再加"失败一次即短路"的探测位：
  // 避免未配置 LLM 的用户为 6 个角度各等一次网络超时。原因仍如实上报，不谎称成功。
  const llmProbed = { attempted: false, disabledAfterFailure: false };
  let llmUsable = llmReachable(modelOptions, { explicitSkip: deps.skipLlm === true });

  const planPerAngle = new Map();
  let llmUsed = 0;
  let llmFailed = 0;
  let llmReason = null;
  let materialChars = 0;

  for (const [idx, angle] of angles.entries()) {
    const entries = (assignment.get(angle.key) || []).map((e, i) => ({ ...e, alias: `it-${i}` }));
    const built = buildAngleMaterial(entries, { title: angle.title, thesis: angle.thesis });
    // 引用编号表：LLM 只见短编号，落盘一律还原成真实 itemId（防它对 itemId 依样画葫芦地编）
    const idMap = new Map(entries.map((e, i) => [`it-${i}`, e.item.itemId]));
    materialChars += built.materialChars;

    if (!entries.length) {
      emitter.progress('angle', `角度「${angle.title}」无可分配素材，跳过 LLM 直接兜底`, { angleKey: angle.key });
      planPerAngle.set(angle.key, { ...fallbackAnglePlan(angle, [], slideCount), source: 'fallback', materialChars: 0 });
      continue;
    }

    if ((!llmUsable || llmProbed.disabledAfterFailure) && !deps.forceLlm) {
      planPerAngle.set(angle.key, {
        ...fallbackAnglePlan(angle, entries, slideCount),
        source: 'fallback',
        materialChars: built.materialChars,
      });
      emitter.progress('angle',
        llmProbed.disabledAfterFailure
          ? `角度 ${idx + 1}/${angles.length}「${angle.title}」：前序 LLM 调用已失败（${llmReason || '未知原因'}），直接用确定性兜底，不再等待网络`
          : `角度 ${idx + 1}/${angles.length}「${angle.title}」：未配置可用 LLM（远程无 API Key），使用确定性兜底规划`,
        // shortCircuited 只标「试过且失败后跳过」；从未配置成功是 reachable=false，不是短路
        { angleKey: angle.key, index: idx, total: angles.length, llm: false, shortCircuited: llmProbed.disabledAfterFailure });
      continue;
    }

    llmProbed.attempted = true;
    emitter.progress('angle', `角度 ${idx + 1}/${angles.length}「${angle.title}」调用 LLM`, {
      angleKey: angle.key, index: idx, total: angles.length, llm: true,
    });
    let plan = null;
    try {
      const { result } = await withHeartbeat(emitter, async () => doComplete(
        [
          { role: 'system', content: '你是营销策划助手，只输出合法 JSON。' },
          { role: 'user', content: anglePrompt({ angle, product, material: built.content, slideCount, knownIds: [...idMap.keys()] }) },
        ],
        modelOptions,
      ), {
        message: `角度「${angle.title}」等待 LLM 回应`,
        everyMs: heartbeatMs,
        deckIndex: idx,
        index: idx,
        total: angles.length,
        angleKey: angle.key,
      });
      const parsed = extractJsonObject(result?.content);
      const slides = normalizeAngleSlides(parsed, { idMap, slideCount });
      // LLM 常见偷工：只给一两页就当成功会让 deck 质量不可用，低于 3 页一律判失败走兜底
      if (slides.length >= Math.min(3, slideCount)) {
        plan = {
          thesis: String(parsed?.thesis || '').trim().slice(0, 80) || angle.thesis,
          slides,
          source: 'llm',
          materialChars: built.materialChars,
        };
        llmUsed++;
        emitter.progress('angle', `角度「${angle.title}」LLM 产出 ${slides.length} 页`, { angleKey: angle.key });
      } else {
        llmFailed++;
        llmReason = result ? 'LLM 返回内容无法解析为幻灯片 JSON' : `LLM 无响应（${getLastLlmError() || '未配置或全部 provider 失败'}）`;
        // 只有"没打通"才短路后续角度；打通了但内容不合格（result 有值）属内容问题，后续角度仍值得再试
        if (!result) llmProbed.disabledAfterFailure = true;
        emitter.progress('angle', `角度「${angle.title}」：${llmReason}，改用确定性兜底`, { angleKey: angle.key });
      }
    } catch (err) {
      llmFailed++;
      llmReason = err.message;
      llmProbed.disabledAfterFailure = true;
      emitter.progress('angle', `角度「${angle.title}」：LLM 调用异常（${err.message}），改用确定性兜底`, { angleKey: angle.key });
    }
    if (!plan) {
      plan = {
        ...fallbackAnglePlan(angle, entries, slideCount),
        source: 'fallback',
        materialChars: built.materialChars,
      };
    }
    planPerAngle.set(angle.key, plan);
  }

  const angleOutlines = angles.map((angle) => {
    const plan = planPerAngle.get(angle.key) || { thesis: angle.thesis, slides: [], source: 'fallback', materialChars: 0 };
    const entries = assignment.get(angle.key) || [];
    return {
      key: angle.key,
      title: angle.title,
      thesis: plan.thesis || angle.thesis,
      audience: angle.audience,
      evidenceItemIds: Array.from(new Set(entries.map((e) => e.item.itemId))),
      slides: plan.slides,
      deckName: makeDeckName(angle.key, product.name, outlineId),
      _source: plan.source,
    };
  });

  // thesis 互不重复校验：角度集已保证默认值互不重复；LLM 若把两个角度写成同一句，退回该角度默认 thesis。
  const seenThesis = new Set();
  let thesisCollisions = 0;
  for (const a of angleOutlines) {
    const norm = String(a.thesis || '').replace(/\s+/g, '');
    if (!norm) { a.thesis = getAngleSet(setId).find((d) => d.key === a.key)?.thesis || a.title; continue; }
    if (seenThesis.has(norm)) {
      thesisCollisions++;
      const def = getAngleSet(setId).find((d) => d.key === a.key);
      a.thesis = def ? def.thesis : `${a.title}（角度 ${a.key}）`;
    }
    seenThesis.add(String(a.thesis).replace(/\s+/g, ''));
  }

  const rawOutline = normalizeOutline({
    id: outlineId,
    title: String(opts.title || '').trim() || `${product.name} · 多角度营销大纲`,
    angleSet: setId,
    product,
    sourceIds: material.perSource.map((s) => s.sourceId),
    angles: angleOutlines,
    warnings: material.warnings,
    status: 'ready',
  }, { id: outlineId, sourceIds: material.perSource.map((s) => s.sourceId) });

  // 防编造：剔除指向不存在 itemId 的引用并计数上报
  const integrity = enforceEvidenceIntegrity(rawOutline, { knownItemIds });
  const outline = {
    ...integrity.outline,
    angles: integrity.outline.angles.map((a, i) => ({ ...a, generatedBy: angleOutlines[i]?._source || 'fallback' })),
    material: {
      itemCount: material.stats.itemCount,
      corpusChars: material.stats.corpusChars,
      usedMaterialChars: materialChars,
      staleSkipped: material.stats.staleSkipped,
      includeStale: material.stats.includeStale,
      droppedEvidenceCount: integrity.dropped,
      perSource: material.perSource,
      llm: {
        used: llmUsed, failed: llmFailed,
        reachable: llmUsable, attempted: llmProbed.attempted, shortCircuited: llmProbed.disabledAfterFailure,
        reason: llmReason,
      },
      thesisCollisions,
    },
  };

  if (integrity.dropped > 0) {
    outline.warnings = [
      ...new Set([...(outline.warnings || []),
        `大纲中有 ${integrity.dropped} 处引用指向素材库不存在的条目，已剔除（防编造）`])];
    emitter.progress('evidence', `剔除 ${integrity.dropped} 处伪造素材引用`, {
      dropped: integrity.dropped, droppedIds: integrity.droppedIds.slice(0, 40),
    });
  }

  const errors = validateOutline(outline);
  if (errors.length) {
    const err = new Error(`大纲校验未通过：${errors.join('；')}`);
    err.code = 'OUTLINE_INVALID';
    err.errors = errors;
    throw err;
  }

  doSave(outline);
  emitter.progress('save', `大纲已落盘：marketing/outlines/${outline.id}.json`, { outlineId: outline.id });
  // 大纲事件：前端一次拿到完整大纲 + 取材真实状况
  emitter.emit('outline', { outline });

  const summary = {
    outlineId: outline.id,
    title: outline.title,
    angleCount: outline.angles.length,
    angleKeys: outline.angles.map((a) => a.key),
    deckNames: outline.angles.map((a) => a.deckName),
    itemCount: material.stats.itemCount,
    corpusChars: material.stats.corpusChars,
    usedMaterialChars: materialChars,
    droppedEvidenceCount: integrity.dropped,
    thesisCollisions,
    llmUsed,
    llmFailed,
    llmReachable: llmUsable,
    llmAttempted: llmProbed.attempted,
    llmShortCircuited: llmProbed.disabledAfterFailure,
    llmReason,
    staleSkipped: material.stats.staleSkipped,
    warnings: outline.warnings,
    perSource: material.perSource,
    fallbackOnly: llmUsed === 0,
  };
  emitter.done({ ...summary });
  return { outline, summary };
}

// 事件协议归属：终态 done 由库函数自己发（CLI 与路由内调用走同一条收尾路径）；
// error 终态由调用方在 catch 里发，因为抛错点可能落在库函数任意位置。

// ---- CLI ----

function parseArgs(argv) {
  const out = { product: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') out.sourceIds = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--product') out.product.name = argv[++i];
    else if (a === '--audience') out.product.audience = argv[++i];
    else if (a === '--tone') out.product.tone = argv[++i];
    else if (a === '--angle-set') out.angleSet = argv[++i];
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--slides') out.slidesPerAngle = Number(argv[++i]);
    else if (a === '--include-stale') out.includeStale = true;
  }
  return out;
}

async function runCli() {
  const emitter = makeEmitter();
  const opts = parseArgs(process.argv.slice(2));
  emitter.progress('start', '开始生成营销大纲', { product: opts.product?.name || null });
  try {
    await generateOutline(opts); // 终态 done 由 generateOutline 自己发
  } catch (err) {
    emitter.error(err.message || '大纲生成失败', { code: err.code || null });
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) runCli();

export { slugify };
