// tests/marketing.test.mjs — 营销大纲 + 批量 deck 引擎单测（契约 B030300）。
// 离线：全部用假 store（listItems/readItem/readManifest 注入）与假 LLM，不发真实模型请求；
// 批量生成走真实 writeDeckIndex（产物落在 projects/ 下，用例结束自行清理并断言已清干净）。
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  normalizeOutline, validateOutline, enforceEvidenceIntegrity, makeDeckName,
  makeOutlineId, isSafeOutlineId, getOutline, saveOutline, listOutlines, deleteOutline,
  updateOutline, looksLikeItemId,
} from '../scripts/marketing/store.mjs';
import { getAngleSet, DEFAULT_ANGLE_SET, findAngle, listAngleSets } from '../scripts/marketing/angles.mjs';
import {
  digestItemForAngle, assignMaterial, buildAngleMaterial, collectMaterial, sourceWarnings,
} from '../scripts/marketing/material.mjs';
import { generateOutline, extractJsonObject, normalizeAngleSlides, fallbackAnglePlan, smartTruncateHeading } from '../scripts/marketing/generate-outline.mjs';
import { batchGenerate, loadAngleItems, buildDeckFallback, cancelFlagFor } from '../scripts/marketing/batch-generate.mjs';
import { makeEmitter, withHeartbeat } from '../scripts/marketing/events.mjs';
import { llmReachable } from '../scripts/marketing/llm.mjs';
import marketingRoutes from '../routes/marketing.mjs';
import { isSafeName, getProjectDir, readConfig, ROOT_DIR, PROJECTS_ROOT } from '../scripts/config.mjs';

// ---------------------------------------------------------------------------
// 测试环境：大纲落盘进临时目录；批量产物用 TEST_ 前缀并在用例后清理
// ---------------------------------------------------------------------------
const tmpRoots = [];
function useTmpMarketing() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-outlines-'));
  process.env.AI_PPT_MARKETING_ROOT = dir;
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpRoots.length) {
    const d = tmpRoots.pop();
    fs.rmSync(d, { recursive: true, force: true });
  }
  delete process.env.AI_PPT_MARKETING_ROOT;
});

// 批量生成产出的真实项目目录（projects/ 下）与快照，逐个用例清理
const createdProjects = [];
function trackProject(name) { createdProjects.push(name); }
function cleanProjects() {
  for (const n of createdProjects.splice(0)) {
    fs.rmSync(getProjectDir(n), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT_DIR, '.snapshots', n), { recursive: true, force: true });
  }
}
afterEach(cleanProjects);

// ---------------------------------------------------------------------------
// 假 store：素材条目形状完全按 scripts/sources/store.mjs 契约
// itemId 真实形状 <sourceId>--<12hex>（不是契约示意的 it-xxx）
// 与 store.mjs makeItemId 同款算法（sha256(originKey) 前 12 位）——曾因截位方式不同
// 让中文标题的 18 条素材塌成同一个 id，把"跨角度轮转"用例整体做空（测试形状必须等于生产形状）。
// ---------------------------------------------------------------------------
function fakeItemId(sourceId, seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 12);
  return `${sourceId}--${h}`;
}

function makeFakeStore({ sources, staleIds = [], manifests = {} } = {}) {
  const items = [];
  for (const [sid, list] of Object.entries(sources)) {
    for (const it of list) {
      const id = it.id || fakeItemId(sid, it.title);
      items.push({
        id, sourceId: sid, title: it.title, origin: it.origin || `/${it.title}.md`,
        bytes: it.text.length, ...(it.stale ? { stale: true } : {}),
      });
    }
  }
  const byId = new Map(items.map((it) => {
    const src = sources[it.sourceId].find((x) => (x.id || fakeItemId(it.sourceId, x.title)) === it.id);
    return [it.id, {
      itemId: it.id, sourceId: it.sourceId,
      frontMatter: { title: it.title, source_id: it.sourceId, origin: it.origin, fetched_at: '2026-10-01T00:00:00.000Z' },
      content: src.text,
    }];
  }));
  void staleIds;
  return {
    listItemsFn: () => items.map(({ sourceId, ...rest }) => ({ ...rest, sourceId })),
    readItemFn: (id) => byId.get(id) || null,
    readManifestFn: (sid) => (manifests[sid] ?? {
      sourceId: sid, fetchedAt: new Date().toISOString(), items: items.filter((i) => i.sourceId === sid),
    }),
    items,
    byId,
  };
}

// 语料刻意按角度关键词分桶：痛点 / 能力 / 场景 / 差异化 / ROI / 落地 各有专属条目，
// 另加一条「什么都像」的泛条目，用来观察分配器是否把角度区分度做没了。
const CORPUS = {
  'src-product': [
    { title: '客户抱怨报表要手工拼', text: '很多团队反馈：每周报表要从三个系统手工导出再拼接，重复劳动严重，一线主管抱怨成本高，出错后返工困难，这是当前最大的痛点。' },
    { title: '录入环节耗时统计', text: '调研显示录入环节占用大量人工时间，重复填写同样字段，效率低，团队规模越大成本越高。' },
    { title: '产品支持自动抽取与生成', text: '平台支持从文档自动抽取内容，支持生成幻灯片，支持模板与主题切换，支持批量导出为 pptx 与 pdf，模块之间自动传递数据。' },
    { title: '知识库与检索能力', text: '内置知识库支持双链笔记、标签检索、片段收集，支持将笔记一键转成演示文稿，能力覆盖采集到呈现。' },
    { title: '通用条目', text: '本系统面向企业团队，可以在多种场合使用，具体方式取决于团队流程与组织结构。' },
  ],
  'src-industry': [
    { title: '薪人薪事销售场景', text: '在人力资源 SaaS 的销售场景里，售前顾问需要用演示文稿讲清产品价值，销售团队场景包括客户拜访、方案宣讲、培训交付。' },
    { title: '培训部门行业用法', text: '企业培训部门常用它做课件：行业场景包括新员工入职培训、产品培训、合规培训，HR 团队是最主要的客户。' },
    { title: '与自研和表格方案的差异', text: '相比自研或使用通用文档工具，差别在于内容沉淀在知识库里可复用，而通用大模型每次都要重来；这是我们的差异化优势。' },
    { title: '对比传统外包制作', text: '传统做法是外包设计或人工排版，成本高、周期长、改版困难；本产品把制作时间从数天缩短到分钟级。' },
  ],
  'src-cases': [
    { title: '试点到铺开的落地路径', text: '实施分三个阶段：先在一个部门试点两周，验证流程后接入知识库，最后全员推广。上线步骤包括导入素材、配置主题、批量生成。' },
    { title: '某客户成功上线案例', text: '某五百人客户成功部署，售前团队把材料整理成知识库后自动生成演示文稿，交付周期缩短，客户验收顺利。' },
    { title: '投入产出与周期收益', text: '按一次宣讲节省两小时制作时间估算，一个十人销售团队每月可省下数十小时，投入在数月内即可回收，成本下降明显。' },
    { title: '常见坑与规避', text: '落地阶段常见困难是素材分散与流程变更，建议先集中素材再谈自动化，否则会放大原有的重复劳动问题。' },
  ],
};

const ALL_IDS = Object.entries(CORPUS).flatMap(([sid, list]) => list.map((x) => fakeItemId(sid, x.title)));

// ---------------------------------------------------------------------------
// 角度集 / 契约形状
// ---------------------------------------------------------------------------
describe('angle sets', () => {
  it('marketing-standard has at least 6 mutually distinct angles', () => {
    const angles = getAngleSet(DEFAULT_ANGLE_SET);
    assert.ok(angles.length >= 6, `角度数应 ≥6，实际 ${angles.length}`);
    assert.equal(new Set(angles.map((a) => a.key)).size, angles.length, '角度 key 重复');
    assert.equal(new Set(angles.map((a) => a.thesis)).size, angles.length, '角度 thesis 重复');
    for (const a of angles) {
      assert.ok(a.title && a.lens && Array.isArray(a.keywords) && a.keywords.length > 0, `角度 ${a.key} 字段不全`);
    }
    assert.ok(listAngleSets().includes(DEFAULT_ANGLE_SET));
    assert.ok(findAngle(DEFAULT_ANGLE_SET, 'roi'));
  });

  it('deckName is mkt-<angleKey>-<slug> and passes project name validation', () => {
    const name = makeDeckName('pain', '薪人薪事', 'mo-abc');
    assert.match(name, /^mkt-pain-/);
    assert.ok(isSafeName(name));
    assert.ok(/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(name), `deckName 不是合法项目名：${name}`);
  });
});

describe('outline store contract', () => {
  const minimal = () => ({
    title: 'T',
    product: { name: 'P', audience: 'A', tone: 'N' },
    angles: getAngleSet(DEFAULT_ANGLE_SET).slice(0, 3).map((a) => ({
      key: a.key, title: a.title, thesis: a.thesis, audience: 'A',
      evidenceItemIds: [ALL_IDS[0]],
      slides: [{ heading: 'H', lead: 'L', points: ['p1'], evidenceItemIds: [ALL_IDS[1]] }],
      deckName: makeDeckName(a.key, 'P'),
    })),
  });

  it('normalizeOutline fills every contract field', () => {
    const o = normalizeOutline(minimal(), { id: makeOutlineId() });
    for (const k of ['id', 'title', 'createdAt', 'sourceIds', 'angleSet', 'product', 'angles', 'warnings']) {
      assert.ok(k in o, `缺少契约字段 ${k}`);
    }
    for (const k of ['name', 'audience', 'tone']) assert.ok(typeof o.product[k] === 'string');
    for (const a of o.angles) {
      for (const k of ['key', 'title', 'thesis', 'audience', 'evidenceItemIds', 'slides', 'deckName']) {
        assert.ok(k in a, `角度缺少字段 ${k}`);
      }
      for (const s of a.slides) {
        for (const k of ['heading', 'lead', 'points', 'evidenceItemIds']) assert.ok(k in s, `slide 缺少字段 ${k}`);
        assert.ok(Array.isArray(s.points));
      }
    }
  });

  it('validateOutline rejects duplicate thesis, duplicate deckName and empty angles', () => {
    const o = normalizeOutline(minimal(), { id: makeOutlineId() });
    assert.deepEqual(validateOutline(o), []);

    const dupThesis = normalizeOutline({
      ...minimal(),
      angles: minimal().angles.map((a, i) => ({ ...a, thesis: '同一个论点' + (i ? '' : '') })),
    }, { id: makeOutlineId() });
    dupThesis.angles[1].thesis = dupThesis.angles[0].thesis;
    assert.ok(validateOutline(dupThesis).some((e) => e.includes('thesis')));

    const dupDeck = normalizeOutline(minimal(), { id: makeOutlineId() });
    dupDeck.angles[1].deckName = dupDeck.angles[0].deckName;
    assert.ok(validateOutline(dupDeck).some((e) => e.includes('deckName')));

    assert.ok(validateOutline(normalizeOutline({ ...minimal(), angles: [] }, { id: makeOutlineId() })).length > 0);
  });

  it('outlineId shape is mo-<base36> and rejected when unsafe', () => {
    const id = makeOutlineId();
    assert.match(id, /^mo-[0-9a-z]+$/);
    assert.ok(isSafeOutlineId(id));
    assert.ok(!isSafeOutlineId('../etc/passwd'));
    assert.ok(!isSafeOutlineId('nope-1'));
  });

  it('CRUD round-trips through writeJsonAtomic and survives reload', () => {
    useTmpMarketing();
    const o = normalizeOutline(minimal(), { id: makeOutlineId() });
    saveOutline(o);
    assert.equal(getOutline(o.id).id, o.id);
    assert.equal(listOutlines()[0].id, o.id);
    const updated = updateOutline(o.id, { title: '改过的标题' });
    assert.equal(updated.title, '改过的标题');
    assert.ok(updated.updatedAt);
    assert.ok(deleteOutline(o.id));
    assert.equal(getOutline(o.id), null);
  });

  it('updateOutline rejects an edit that breaks the contract', () => {
    useTmpMarketing();
    const o = normalizeOutline(minimal(), { id: makeOutlineId() });
    saveOutline(o);
    assert.throws(() => updateOutline(o.id, { angles: [] }), /angles|数量不足/);
  });

  it('looksLikeItemId matches the real <sourceId>--<12hex> shape, not the doc sample', () => {
    assert.ok(looksLikeItemId('src-inrepo--a999cc96cfd4'));
    assert.ok(looksLikeItemId(fakeItemId('src-product', 'x')));
    assert.ok(!looksLikeItemId('it-0'));       // 契约示意的 it-xxx 不是真实形状
    assert.ok(!looksLikeItemId('src-a--xyz')); // 非 12 hex
  });
});

describe('evidence integrity (anti-fabrication)', () => {
  it('drops references to itemIds that do not exist and counts them', () => {
    const outline = normalizeOutline({
      title: 'T', product: { name: 'P' },
      angles: getAngleSet(DEFAULT_ANGLE_SET).slice(0, 3).map((a, i) => ({
        key: a.key, title: a.title, thesis: a.thesis,
        evidenceItemIds: [ALL_IDS[i], 'src-fake--000000000000'],
        slides: [{ heading: 'H', points: [], evidenceItemIds: [ALL_IDS[0], 'src-product--deadbeefdead', 'it-7'] }],
        deckName: makeDeckName(a.key, 'P'),
      })),
    }, { id: makeOutlineId() });

    const { outline: cleaned, dropped, droppedIds } = enforceEvidenceIntegrity(outline, { knownItemIds: new Set(ALL_IDS) });
    assert.equal(dropped, 9, `应剔除 9 处伪造引用（角度级 3 + 3 个角度各 2 处页级），实际 ${dropped}`);
    assert.deepEqual([...new Set(droppedIds)].sort(), ['it-7', 'src-fake--000000000000', 'src-product--deadbeefdead'].sort());
    for (const a of cleaned.angles) {
      for (const id of a.evidenceItemIds) assert.ok(ALL_IDS.includes(id), `角度级仍留有伪造 id：${id}`);
      for (const s of a.slides) for (const id of s.evidenceItemIds) assert.ok(ALL_IDS.includes(id), `页级仍留有伪造 id：${id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 取材：分档摘要 + 降级信号
// ---------------------------------------------------------------------------
describe('material tiered digest', () => {
  const painAngle = findAngle(DEFAULT_ANGLE_SET, 'pain');

  it('digest picks angle-relevant sentences, not an arbitrary prefix', () => {
    const text = CORPUS['src-product'][0].text;
    const d = digestItemForAngle(text, painAngle, { headChars: 20, maxChars: 400 });
    assert.ok(d.matched, '痛点角度应命中素材里的痛点关键词');
    assert.ok(d.digest.includes('痛点') || d.digest.includes('抱怨'), '摘要应含痛点句');
    assert.ok(d.digest.length <= 400);
  });

  it('digest marks non-matching material as matched=false instead of pretending relevance', () => {
    const roi = findAngle(DEFAULT_ANGLE_SET, 'roi');
    const d = digestItemForAngle('今天天气不错，适合出门散步，路上遇到一只猫。', roi);
    assert.equal(d.matched, false);
    assert.ok(d.digest.length > 0, '即便没命中也要给出可用摘要');
  });

  it('assignMaterial gives every angle material and does not hand all angles the same set', () => {
    const angles = getAngleSet(DEFAULT_ANGLE_SET);
    const fake = makeFakeStore({ sources: CORPUS });
    const material = collectMaterial({ ...fake, placeholderThreshold: 0 });
    const assign = assignMaterial(angles, material.items, { perAngleItems: 3 });
    const sets = angles.map((a) => (assign.get(a.key) || []).map((e) => e.item.itemId).join(','));
    assert.ok(sets.every(Boolean), '有角度没分到素材');
    assert.ok(new Set(sets).size >= 4, `六个角度只产出 ${new Set(sets).size} 种取材组合，区分度不足`);
  });

  // 上一条的相关度打分本身就能拉开角度，删掉跨角度 usage 次级排序它照样绿（变异自查实测）。
  // 这条把打分压成完全平手（正文不含任何角度关键词 → 每个角度对每条素材 score 都是 0），
  // 此时"角度各拿不同素材"只可能来自 usage 轮转：实测有机制 = 6 种组合 / 无机制 = 1 种。
  it('rotates material across angles even when relevance is a perfect tie (usage tiebreaker is load-bearing)', () => {
    const angles = getAngleSet(DEFAULT_ANGLE_SET);
    const flat = {};
    // 18 条 × 每角度 3 条 = 恰好够 6 个角度各拿一组互不重叠的素材（9 条只够 3 组，会误判）
    flat['src-flat'] = Array.from({ length: 18 }, (_, i) => ({
      title: `无关键词条目 ${i}`,
      text: `第${i}段：这里没有任何与营销角度相关的词，用来把相关度打分压成完全平手。`.padEnd(60 + i * 5, '字'),
    }));
    const fake = makeFakeStore({ sources: flat });
    const material = collectMaterial({ ...fake, placeholderThreshold: 0 });
    assert.equal(material.items.length, 18);
    const assign0 = assignMaterial(angles, material.items, { perAngleItems: 3 });
    // 前置确认：打分确实全平手，否则本用例退化成上一条而失去意义
    for (const a of angles) {
      const scores = (assign0.get(a.key) || []).map((e) => e.score);
      assert.ok(scores.length === 3 && scores.every((s) => s === 0),
        `角度 ${a.key} 的打分并非全平手：${scores.join(',')}`);
    }
    const sets = angles.map((a) => (assign0.get(a.key) || []).map((e) => e.item.itemId));
    assert.equal(new Set(sets.map((s) => s.join(','))).size, angles.length,
      `平手素材下 ${angles.length} 个角度只产出 ${new Set(sets.map((s) => s.join(','))).size} 种组合——跨角度轮转失效，各角度会拿到同一批素材`);
    const overlap = sets[0].filter((id) => sets[1].includes(id));
    assert.deepEqual(overlap, [], '相邻两个角度拿到了完全相同的素材，角度区分度是假的');
  });

  it('buildAngleMaterial reports how many characters actually entered the prompt', () => {
    const fake = makeFakeStore({ sources: CORPUS });
    const material = collectMaterial({ ...fake, placeholderThreshold: 0 });
    const angle = findAngle(DEFAULT_ANGLE_SET, 'roi');
    const entries = assignMaterial([angle], material.items, { perAngleItems: 3 }).get('roi');
    const built = buildAngleMaterial(entries, { title: angle.title, thesis: angle.thesis, maxChars: 600 });
    assert.ok(built.materialChars > 0 && built.includedItems > 0);
    assert.ok(built.content.length < 1200, '超出预算应少装条目而不是整篇截断');
  });

  it('stale items are excluded by default and reported, and included on opt-in', () => {
    const sources = {
      'src-a': [
        { title: '正常条目', text: '内容里有痛点与效率。' },
        { title: '过期条目', text: '内容里有痛点与效率。', stale: true },
      ],
    };
    const fake = makeFakeStore({ sources });
    const off = collectMaterial({ ...fake, placeholderThreshold: 0 });
    assert.equal(off.items.length, 1, '默认不得静默混入 stale 素材');
    assert.equal(off.stats.staleSkipped, 1);

    const on = collectMaterial({ ...fake, includeStale: true, placeholderThreshold: 0 });
    assert.equal(on.items.length, 2);
    assert.ok(on.items.some((i) => i.stale));
  });

  it('surfaces preserved / degraded / truncated / policySkipped instead of silently trusting the corpus', () => {
    const w = sourceWarnings('src-a', {
      fetchedAt: '2026-01-01T00:00:00.000Z',
      items: [],
      preserved: 'all-confirmed-gone',
      preserveReason: 'all-confirmed-gone',
      degraded: true, staleCount: 3,
      truncated: true, droppedCount: 42, totalCandidates: 100, maxPages: 58,
      policySkipped: 5,
    }, { now: Date.parse('2026-11-05T00:00:00.000Z') });
    const text = w.join('\n');
    assert.match(text, /保命/);
    assert.match(text, /all-confirmed-gone|上游报告条目已全部消失/);
    assert.match(text, /stale/);
    assert.match(text, /截断/);
    assert.match(text, /42/);
    assert.match(text, /安全清单/);
    assert.match(text, /未更新/);
  });

  it('a source with no manifest is reported, not treated as empty-by-design', () => {
    assert.match(sourceWarnings('src-x', null).join(''), /没有抓取记录/);
  });

  it('F050500-4: placeholder stub items are excluded by effective char count and reported', () => {
    const sources = {
      'src-a': [
        { title: '真实文章', text: '这是真实内容。' + '内容很长，包含大量有效信息，远远超过占位阈值。'.repeat(30) },
        { title: '占位 README', text: 'docs/marketing\n推广素材存放处（截图、演示 GIF、发布文案、社交媒体素材等），后续批次填入。' },
      ],
    };
    const fake = makeFakeStore({ sources });
    const material = collectMaterial(fake);
    assert.equal(material.items.length, 1, '占位条目应被排除');
    assert.equal(material.items[0].title, '真实文章');
    assert.equal(material.stats.excludedPlaceholderCount, 1);
    assert.ok(material.warnings.some((w) => w.includes('占位')));
    assert.ok(material.perSource[0].excludedPlaceholderCount === 1);
  });
});

// ---------------------------------------------------------------------------
// 大纲生成
// ---------------------------------------------------------------------------
async function runOutline(extra = {}) {
  const fake = makeFakeStore({ sources: CORPUS });
  const saved = [];
  const events = [];
  const emitter = makeEmitter((line) => events.push(JSON.parse(line)));
  const res = await generateOutline({
    product: { name: '薪人薪事演示助手', audience: 'HR 负责人', tone: '专业' },
    emitter,
    placeholderThreshold: 0,        // 测试语料短，关闭占位过滤
    deps: {
      listItemsFn: fake.listItemsFn,
      readItemFn: fake.readItemFn,
      readManifestFn: fake.readManifestFn,
      modelOptions: {},              // 空 → 不发任何真实 LLM 请求
      saveOutline: (o) => { saved.push(o); return o; },
      heartbeatMs: 50,
      ...extra.deps,
    },
    ...extra.opts,
  });
  return { ...res, events, saved };
}

describe('generateOutline', () => {
  it('deterministic fallback (no LLM) still satisfies the full contract', async () => {
    const { outline, summary, events } = await runOutline();
    assert.ok(outline.angles.length >= 6);
    assert.deepEqual(validateOutline(outline), [], `兜底大纲未通过校验：${validateOutline(outline).join('；')}`);
    for (const a of outline.angles) {
      assert.ok(a.slides.length >= 3, `兜底角度 ${a.key} 页数不足`);
      assert.ok(a.evidenceItemIds.length > 0, `兜底角度 ${a.key} 没有证据`);
      assert.equal(a.generatedBy, 'fallback');
      for (const id of a.evidenceItemIds) assert.ok(ALL_IDS.includes(id), `兜底引用了不存在的 itemId：${id}`);
    }
    // 兜底也要有区分度，不能六个角度同一套证据
    const evSets = new Set(outline.angles.map((a) => a.evidenceItemIds.join(',')));
    assert.ok(evSets.size >= 4, `兜底大纲角度区分度不足：${evSets.size}/${outline.angles.length} 种证据组合`);
    assert.equal(summary.llmUsed, 0);
    // 从未配置成功 ≠ 试过又失败：这种情形不该冒充"短路"
    assert.equal(summary.llmReachable, false);
    assert.equal(summary.llmAttempted, false);
    assert.equal(summary.llmShortCircuited, false);
    assert.ok(!events.some((e) => e.type === 'progress' && e.step === 'angle' && e.detail?.shortCircuited === true),
      '无 LLM 配置的兜底不该把每个角度都标成 shortCircuited');
    assert.ok(summary.corpusChars > 0 && summary.usedMaterialChars > 0);
    assert.ok(events.some((e) => e.type === 'outline' && e.outline?.id === outline.id));
    assert.ok(summary.angleKeys.length >= 6);
  });

  it('reports the real failure reason when the LLM answers garbage', async () => {
    const { summary, outline } = await runOutline({
      deps: {
        modelOptions: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        forceLlm: true,
        completeChat: async () => ({ content: '抱歉，我做不到。' }),
      },
    });
    assert.ok(summary.llmFailed > 0, 'LLM 输出不可用应计入失败');
    assert.ok(/解析|JSON|无响应/.test(summary.llmReason || ''), `应给出真实原因，实际：${summary.llmReason}`);
    assert.ok(outline.angles.every((a) => a.slides.length >= 3), 'LLM 失败后仍要产出可用大纲');
  });

  it('drops fabricated citations from LLM output and reports the count', async () => {
    const { summary, outline } = await runOutline({
      deps: {
        modelOptions: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        forceLlm: true,
        completeChat: async () => ({
          content: JSON.stringify({
            thesis: '客户被手工报表拖住',
            slides: [
              { heading: '报表之痛', lead: '每周手工拼表', points: ['三个系统', '重复导出'], evidenceItemIds: ['it-0', 'src-bogus--ffffffffffff'] },
              { heading: '录入黑洞', lead: '同样字段反复填', points: ['成本高'], evidenceItemIds: ['it-1'] },
              { heading: '返工之累', lead: '出错难追回', points: ['返工困难'], evidenceItemIds: ['it-2'] },
            ],
          }),
        }),
      },
    });
    assert.ok(summary.droppedEvidenceCount >= 1, '应统计并剔除伪造引用');
    const ids = new Set(outline.angles.flatMap((a) => [...a.evidenceItemIds, ...a.slides.flatMap((s) => s.evidenceItemIds)]));
    assert.ok(![...ids].some((i) => i === 'src-bogus--ffffffffffff'), '伪造引用仍留在大纲里');
    assert.ok(outline.warnings.join('').includes('剔除'), '大纲 warnings 应记录剔除事实');
    // 别名 it-N 已还原成真实 itemId
    assert.ok([...ids].every((i) => ALL_IDS.includes(i)), `it-N 别名未还原成真实 itemId：${[...ids].join(',')}`);
    assert.ok(outline.angles.some((a) => a.generatedBy === 'llm'));
  });

  it('material degradation of the source library reaches outline.warnings', async () => {
    const fake = makeFakeStore({
      sources: CORPUS,
      manifests: {
        'src-cases': {
          fetchedAt: '2026-02-01T00:00:00.000Z', items: [],
          preserved: true, preserveReason: 'collection-failed',
          truncated: true, droppedCount: 7,
        },
      },
    });
    const events = [];
    const { outline } = await generateOutline({
      product: { name: 'P' },
      emitter: makeEmitter((l) => events.push(JSON.parse(l))),
      placeholderThreshold: 0,
      deps: {
        listItemsFn: fake.listItemsFn, readItemFn: fake.readItemFn, readManifestFn: fake.readManifestFn,
        modelOptions: {}, saveOutline: (o) => o, heartbeatMs: 50,
      },
    });
    const text = outline.warnings.join('\n');
    assert.match(text, /保命/);
    assert.match(text, /截断/);
    assert.ok(events.some((e) => e.type === 'progress' && e.step === 'material-warning'));
  });

  it('F050500-3: warns when material items are fewer than angles and when evidence sets collapse', async () => {
    // 4 条语料喂 6 个角度：触发「素材不足」告警
    const short = {};
    short['src-short'] = [
      { title: 'A', text: '痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点痛点。' },
      { title: 'B', text: '效率效率效率效率效率效率效率效率效率效率效率效率效率效率效率效率效率效率效率效率效率效率效率。' },
      { title: 'C', text: '场景场景场景场景场景场景场景场景场景场景场景场景场景场景场景场景场景场景场景场景场景场景场景。' },
      { title: 'D', text: '落地落地落地落地落地落地落地落地落地落地落地落地落地落地落地落地落地落地落地落地落地落地落地。' },
    ];
    const fake = makeFakeStore({ sources: short });
    const events = [];
    const { outline, summary } = await generateOutline({
      product: { name: 'P' },
      emitter: makeEmitter((l) => events.push(JSON.parse(l))),
      placeholderThreshold: 0,
      deps: {
        listItemsFn: fake.listItemsFn, readItemFn: fake.readItemFn, readManifestFn: fake.readManifestFn,
        modelOptions: {}, saveOutline: (o) => o, heartbeatMs: 50,
      },
    });
    assert.ok(outline.warnings.some((w) => w.includes('素材不足')), `应有素材不足警告，实际 ${outline.warnings}`);
    assert.ok(events.some((e) => e.type === 'progress' && e.step === 'material-warning' && e.message.includes('素材不足')));
    assert.equal(summary.angleCount, 6);
    assert.equal(summary.itemCount, 4);

    // 6 条无关键词语料喂 6 个角度：score 全 0 → 各角度拿到同一集合（顺序不同），触发「区分度塌缩」告警
    const flat = {};
    flat['src-flat'] = Array.from({ length: 6 }, (_, i) => ({
      title: `条目 ${i}`,
      text: `第${i}段：这里没有任何与营销角度相关的词，用来把相关度打分压成完全平手。`.padEnd(80 + i * 5, '字'),
    }));
    const fakeFlat = makeFakeStore({ sources: flat });
    const events2 = [];
    const { outline: outline2, summary: summary2 } = await generateOutline({
      product: { name: 'P' },
      emitter: makeEmitter((l) => events2.push(JSON.parse(l))),
      placeholderThreshold: 0,
      deps: {
        listItemsFn: fakeFlat.listItemsFn, readItemFn: fakeFlat.readItemFn, readManifestFn: fakeFlat.readManifestFn,
        modelOptions: {}, saveOutline: (o) => o, heartbeatMs: 50,
      },
    });
    assert.ok(outline2.warnings.some((w) => w.includes('区分度塌缩')), `应有区分度塌缩警告，实际 ${outline2.warnings}`);
    assert.ok(events2.some((e) => e.type === 'progress' && e.step === 'material-warning' && e.message.includes('区分度塌缩')));
    assert.equal(summary2.distinctEvidenceSets, 1);
    assert.equal(summary2.angleCount, 6);
  });

  it('empty material is a real error, not a silently successful empty outline', async () => {
    const empty = { listItemsFn: () => [], readItemFn: () => null, readManifestFn: () => null };
    await assert.rejects(
      generateOutline({
        product: { name: 'P' },
        emitter: makeEmitter(() => {}),
        deps: { ...empty, modelOptions: {}, saveOutline: (o) => o, heartbeatMs: 50 },
      }),
      /素材库为空/,
    );
  });

  it('persists to marketing/outlines when using the real store (round-trip, not just in-memory)', async () => {
    useTmpMarketing();
    const fake = makeFakeStore({ sources: CORPUS });
    const { outline } = await generateOutline({
      product: { name: 'P' },
      emitter: makeEmitter(() => {}),
      placeholderThreshold: 0,
      deps: {
        listItemsFn: fake.listItemsFn, readItemFn: fake.readItemFn, readManifestFn: fake.readManifestFn,
        modelOptions: {}, heartbeatMs: 50,
      },
    });
    const file = path.join(process.env.AI_PPT_MARKETING_ROOT, 'outlines', `${outline.id}.json`);
    assert.ok(fs.existsSync(file), '大纲未落盘到 marketing/outlines/');
    // 关键：断言的是**重新读回来的文件**，不是内存对象——
    // saveOutline 会再过一遍 normalizeOutline，非契约字段会在那一步被抹掉（实测踩过）。
    const reloaded = getOutline(outline.id);
    assert.equal(reloaded.id, outline.id);
    assert.deepEqual(validateOutline(reloaded), []);
    assert.equal(reloaded.angles.length, outline.angles.length);
    for (const [i, a] of reloaded.angles.entries()) {
      assert.equal(a.thesis, outline.angles[i].thesis, `角度 ${a.key} 的 thesis 未 round-trip`);
      assert.equal(a.deckName, outline.angles[i].deckName);
      assert.deepEqual(a.evidenceItemIds, outline.angles[i].evidenceItemIds, `角度 ${a.key} 的证据未 round-trip`);
      assert.deepEqual(a.slides, outline.angles[i].slides, `角度 ${a.key} 的 slides 未 round-trip`);
      assert.equal(a.generatedBy, outline.angles[i].generatedBy,
        `角度 ${a.key} 的 generatedBy 落盘后丢失（兜底/LLM 来源不可审计）`);
    }
    assert.equal(reloaded.material.itemCount, outline.material.itemCount, '取材统计未 round-trip');
    assert.equal(reloaded.material.corpusChars, outline.material.corpusChars);
    assert.deepEqual(reloaded.warnings, outline.warnings);
  });
});

describe('LLM output parsing helpers', () => {
  it('extractJsonObject survives code fences and surrounding prose', () => {
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJsonObject('废话 {"a":{"b":2}} 更多废话'), { a: { b: 2 } });
    assert.equal(extractJsonObject('没有 JSON'), null);
  });

  it('normalizeAngleSlides maps it-N aliases to real ids and keeps unknown tokens for the integrity filter', () => {
    const idMap = new Map([['it-0', 'src-a--000000000000'], ['it-1', 'src-a--111111111111']]);
    const out = normalizeAngleSlides({
      slides: [
        { heading: 'H1', points: ['p'], evidenceItemIds: ['it-0', '[it-1]', 0] },
        { heading: 'H2', points: [], evidenceItemIds: ['src-a--madeup'] },
      ],
    }, { idMap, slideCount: 5 });
    assert.deepEqual(out[0].evidenceItemIds, ['src-a--000000000000', 'src-a--111111111111']);
    assert.deepEqual(out[1].evidenceItemIds, ['src-a--madeup']);
  });

  it('fallbackAnglePlan cites real itemIds', () => {
    const angle = findAngle(DEFAULT_ANGLE_SET, 'roi');
    const fake = makeFakeStore({ sources: CORPUS });
    const entries = assignMaterial([angle], collectMaterial({ ...fake, placeholderThreshold: 0 }).items, { perAngleItems: 3 }).get('roi');
    const plan = fallbackAnglePlan(angle, entries, 4);
    assert.ok(plan.slides.length >= 3);
    for (const s of plan.slides) for (const id of s.evidenceItemIds) assert.ok(ALL_IDS.includes(id));
  });

  it('F050500-5: smartTruncateHeading avoids hard 20-char cutoff and adds ellipsis', () => {
    assert.equal(smartTruncateHeading('期末复习实操：用 ai-ppt 把错题和知识卡片变成复习课件', 20), '期末复习实操：用 ai-ppt…');
    assert.equal(smartTruncateHeading('从散会到汇报：30 分钟把会议纪要变成一份像样的 PPT', 20), '从散会到汇报：30…');
    assert.equal(smartTruncateHeading('短标题', 20), '短标题');
    assert.ok(smartTruncateHeading('a '.repeat(30), 20).endsWith('…'));
  });
});

// ---------------------------------------------------------------------------
// LLM 可达性判定 + 失败短路
// ---------------------------------------------------------------------------
describe('llmReachable', () => {
  it('remote endpoint without an apiKey is NOT reachable', () => {
    // buildModelOptions() 无 key 时仍会给出默认 baseUrl/provider/model，
    // 旧写法 !!（apiKey||baseUrl||provider）恒真 —— 这里锁住真实信号：远程必须有 key。
    assert.equal(llmReachable({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'x', provider: 'openai' }), false);
    assert.equal(llmReachable({}), false);
    assert.equal(llmReachable(null), false);
    assert.equal(llmReachable({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1' }), true);
  });

  it('local endpoints are reachable without a key', () => {
    assert.equal(llmReachable({ baseUrl: 'http://localhost:1234/v1' }), true);
    assert.equal(llmReachable({ baseUrl: 'http://127.0.0.1:11434/v1', provider: 'openai' }), true);
    assert.equal(llmReachable({ baseUrl: 'http://0.0.0.0:1234/v1' }), true);
    assert.equal(llmReachable({ provider: 'lmstudio' }), true);
  });

  it('an explicit skip overrides everything', () => {
    assert.equal(llmReachable({ apiKey: 'sk-test' }, { explicitSkip: true }), false);
    assert.equal(llmReachable({ baseUrl: 'http://localhost:1234/v1' }, { explicitSkip: true }), false);
  });
});

describe('LLM failure short-circuit', () => {
  it('once the LLM proves unreachable, later angles skip it instead of waiting again', async () => {
    let calls = 0;
    const { summary, outline, events } = await runOutline({
      deps: {
        // 有 key → 判定为可达 → 第一个角度真会去调；注入必挂的 completeChat 模拟网络不可达
        modelOptions: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        completeChat: async () => { calls++; return null; },
        heartbeatMs: 50,
      },
    });
    assert.equal(calls, 1, `短路失效：LLM 已失败仍为每个角度重试（调用 ${calls} 次）`);
    assert.equal(summary.llmReachable, true, '可达性按配置判定，应记录为 true（是试过失败的）');
    assert.equal(summary.llmAttempted, true);
    assert.equal(summary.llmShortCircuited, true, '应记录发生过短路');
    assert.equal(summary.llmUsed, 0);
    assert.ok(summary.llmFailed > 0);
    assert.ok(events.some((e) => e.type === 'progress' && e.step === 'angle' && e.detail?.shortCircuited === true),
      '短路角度要发可见事件，前端才知道没在等网络');
    // 短路不能让大纲变成空壳
    assert.ok(outline.angles.length >= 6);
    assert.deepEqual(validateOutline(outline), [], `短路后大纲不合契约：${validateOutline(outline).join('；')}`);
    assert.ok(outline.angles.every((a) => a.generatedBy === 'fallback'));
  });

  it('an LLM call that throws also short-circuits the remaining angles', async () => {
    let calls = 0;
    const { summary, outline } = await runOutline({
      deps: {
        modelOptions: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        completeChat: async () => { calls++; throw new Error('ECONNREFUSED'); },
        heartbeatMs: 50,
      },
    });
    assert.equal(calls, 1, `抛错后仍逐角度重试（调用 ${calls} 次）`);
    assert.equal(summary.llmShortCircuited, true);
    assert.match(summary.llmReason, /ECONNREFUSED/, '真实异常原因要如实上报');
    assert.ok(outline.angles.length >= 6, '异常短路后仍须产出完整大纲');
  });

  it('garbage-but-connected LLM does NOT short-circuit (content problem ≠ dead link)', async () => {
    let calls = 0;
    const { summary } = await runOutline({
      deps: {
        modelOptions: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        completeChat: async () => { calls++; return { content: '抱歉，我做不到。' }; },
        heartbeatMs: 50,
      },
    });
    assert.ok(calls >= 2, `链路是通的、只是内容不合格，后续角度应继续尝试，实际调用 ${calls} 次`);
    assert.equal(summary.llmShortCircuited, false);
    assert.equal(summary.llmReachable, true);
  });
});

// ---------------------------------------------------------------------------
// 批量生成（真实落盘 projects/<deckName>/，用例后清理）
// ---------------------------------------------------------------------------
async function makeOutlineForBatch() {
  useTmpMarketing();
  const fake = makeFakeStore({ sources: CORPUS });
  const { outline } = await generateOutline({
    product: { name: 'mkttest', audience: 'HR', tone: '专业' },
    emitter: makeEmitter(() => {}),
    placeholderThreshold: 0,        // 测试语料短，关闭占位过滤
    deps: {
      listItemsFn: fake.listItemsFn, readItemFn: fake.readItemFn, readManifestFn: fake.readManifestFn,
      modelOptions: {}, heartbeatMs: 50,
    },
  });
  return { outline, fake };
}

describe('batchGenerate', () => {
  it('two angles produce two valid projects with outline-bound sourceSelection', async () => {
    const { outline, fake } = await makeOutlineForBatch();
    const keys = outline.angles.slice(0, 2).map((a) => a.key);
    keys.forEach((k) => trackProject(outline.angles.find((a) => a.key === k).deckName));
    const events = [];
    const emitter = makeEmitter((l) => events.push(JSON.parse(l)));

    const { summary } = await batchGenerate({
      outlineId: outline.id, angleKeys: keys, batchId: 'mb-testrun',
      outline, emitter,
      deps: {
        readItemFn: fake.readItemFn,
        modelOptions: {},        // 无 LLM → 大纲直排兜底，不发真实请求
        skipLint: true, skipCover: true, heartbeatMs: 50,
      },
    });

    assert.equal(summary.doneCount, 2, `两份 deck 应都成功：${JSON.stringify(summary.rows)}`);
    for (const [i, key] of keys.entries()) {
      const angle = outline.angles.find((a) => a.key === key);
      const dir = getProjectDir(angle.deckName);
      assert.ok(fs.existsSync(path.join(dir, 'index.html')), `${angle.deckName} 缺 index.html`);
      assert.ok(fs.existsSync(path.join(dir, 'css', 'ppt.css')), `${angle.deckName} 缺基座引擎`);
      assert.ok(fs.existsSync(path.join(dir, 'js', 'ppt.js')), `${angle.deckName} 缺 ppt.js`);
      const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
      assert.ok((html.match(/<section\b/g) || []).length >= 3, `${angle.deckName} 幻灯片太少`);
      assert.equal((html.match(/class="slide active"/g) || []).length, 1, 'active 页必须唯一');

      const cfg = readConfig(angle.deckName);
      assert.equal(cfg.sourceSelection.kind, 'outline');
      assert.equal(cfg.sourceSelection.outlineId, outline.id);
      assert.equal(cfg.sourceSelection.angleKey, key);
      assert.deepEqual(cfg.sourceSelection.sourceIds, outline.sourceIds);
      assert.equal(cfg.status, 'ready');

      const row = summary.rows[i];
      assert.equal(row.index, i, 'index 必须从 0 连续');
      assert.equal(row.deckName, angle.deckName);
    }
    // 事件契约：每份 deck 至少 running + 终态各一条，终态型为 done 且不被载荷覆盖
    const deckEvents = events.filter((e) => e.type === 'deck');
    assert.ok(deckEvents.length >= 4);
    const done = events.find((e) => e.type === 'done');
    assert.ok(done, '批量终态必须是 type:done');
    assert.equal(done.batchId, 'mb-testrun');
    assert.equal(done.total, 2);
    assert.ok(Array.isArray(done.rows) && done.rows.length === 2);
    assert.ok(done.projectDirs.every((d) => d.startsWith('projects/')));
    // 两份 deck 内容必须不同（角度不漂移）
    const h1 = fs.readFileSync(path.join(getProjectDir(outline.angles[0].deckName), 'index.html'), 'utf8');
    const h2 = fs.readFileSync(path.join(getProjectDir(outline.angles[1].deckName), 'index.html'), 'utf8');
    assert.notEqual(h1, h2, '两个角度产出完全相同的 deck，角度区分度失效');
  });

  it('existing project is skipped unless overwrite:true', async () => {
    const { outline, fake } = await makeOutlineForBatch();
    const angle = outline.angles[0];
    trackProject(angle.deckName);
    const run = (overwrite) => batchGenerate({
      outlineId: outline.id, angleKeys: [angle.key], outline, overwrite,
      emitter: makeEmitter(() => {}),
      deps: { readItemFn: fake.readItemFn, modelOptions: {}, skipLint: true, skipCover: true, heartbeatMs: 50 },
    });

    const first = await run(false);
    assert.equal(first.summary.doneCount, 1);
    const second = await run(false);
    assert.equal(second.summary.rows[0].status, 'skipped');
    assert.equal(second.summary.skippedCount, 1);
    const third = await run(true);
    assert.equal(third.summary.rows[0].status, 'done');
  });

  it('one failing angle does not take down the batch', async () => {
    const { outline, fake } = await makeOutlineForBatch();
    const keys = outline.angles.slice(0, 2).map((a) => a.key);
    keys.forEach((k) => trackProject(outline.angles.find((a) => a.key === k).deckName));
    const boom = outline.angles[0].key;
    const { summary } = await batchGenerate({
      outlineId: outline.id, angleKeys: keys, outline,
      emitter: makeEmitter(() => {}),
      deps: {
        // 第一个角度的素材全部读不到 → 该 deck 失败；第二个不受影响
        readItemFn: (id) => {
          const angle = outline.angles.find((a) => a.key === boom);
          if ((angle.evidenceItemIds || []).includes(id) || angle.slides.some((s) => s.evidenceItemIds.includes(id))) return null;
          return fake.readItemFn(id);
        },
        modelOptions: {}, skipLint: true, skipCover: true, heartbeatMs: 50,
      },
    });
    assert.equal(summary.failedCount, 1);
    assert.equal(summary.doneCount, 1);
    assert.equal(summary.rows[0].status, 'error');
    assert.equal(summary.rows[1].status, 'done');
  });

  it('cancellation stops the batch at the next deck boundary', async () => {
    const { outline, fake } = await makeOutlineForBatch();
    const keys = outline.angles.slice(0, 3).map((a) => a.key);
    keys.forEach((k) => trackProject(outline.angles.find((a) => a.key === k).deckName));
    let cancelled = false;
    const events = [];
    const { summary } = await batchGenerate({
      outlineId: outline.id, angleKeys: keys, outline,
      emitter: makeEmitter((l) => events.push(JSON.parse(l))),
      deps: {
        readItemFn: fake.readItemFn, modelOptions: {}, skipLint: true, heartbeatMs: 50,
        shouldCancel: () => cancelled,
        // 第一份 deck 收尾时（captureCover 是每份 deck 的最后一步）外部请求取消
        captureCoverFn: async () => { cancelled = true; },
      },
    });
    assert.equal(summary.rows[0].status, 'done', '取消前已完成的 deck 应保留');
    assert.equal(summary.rows[1].status, 'cancelled', '取消标记后的 deck 不再开跑');
    assert.equal(summary.rows[2].status, 'cancelled');
    assert.equal(summary.wasCancelled, true);
    assert.ok(summary.doneCount === 1 && summary.skippedCount === 0);
    assert.ok(events.filter((e) => e.type === 'deck' && e.status === 'cancelled').length === 2);
  });

  it('test artifacts are cleaned up (no generated deck left behind)', () => {
    const leftovers = fs.readdirSync(PROJECTS_ROOT).filter((n) => n.includes('mkttest'));
    assert.deepEqual(leftovers, [], `测试项目未清理：${leftovers.join(', ')}`);
  });
});

describe('batch helpers', () => {
  it('loadAngleItems unions angle-level and slide-level citations', () => {
    const angle = {
      evidenceItemIds: [ALL_IDS[0]],
      slides: [{ heading: 'h', evidenceItemIds: [ALL_IDS[1], 'src-x--000000000000'] }],
    };
    const fake = makeFakeStore({ sources: CORPUS });
    const { items, missing } = loadAngleItems(angle, { readItemFn: fake.readItemFn });
    assert.equal(items.length, 2);
    assert.deepEqual(missing, ['src-x--000000000000']);
  });

  it('buildDeckFallback renders outline slides with a single active page', () => {
    const outline = normalizeOutline({
      title: 'T', product: { name: 'P', tone: 'N' },
      angles: [{
        key: 'roi', title: 'ROI 价值', thesis: '值不值',
        slides: [
          { heading: '一', lead: 'l1', points: ['a', 'b'] },
          { heading: '二', points: ['c'] },
          { heading: '三', points: ['d'] },
        ],
        deckName: 'mkt-roi-p',
      }],
    }, { id: makeOutlineId() });
    const html = buildDeckFallback({ outline, angle: outline.angles[0] });
    assert.equal((html.match(/<section\b/g) || []).length, 5); // 封面 + 3 页 + 收尾
    assert.equal((html.match(/slide active/g) || []).length, 1);
    assert.match(html, /ROI 价值/);
  });
});

// ---------------------------------------------------------------------------
// 事件出口 / 心跳（前端看门狗依赖）
// ---------------------------------------------------------------------------
describe('events & heartbeat', () => {
  it('terminal event type is never clobbered by the payload', () => {
    const lines = [];
    const emitter = makeEmitter((l) => lines.push(JSON.parse(l)));
    emitter.done({ type: 'deck', deckName: 'x' });
    emitter.error({ type: 'oops', message: 'ignored-in-favour-of-positional' });
    assert.equal(lines[0].type, 'done');
    assert.equal(lines[0].deckName, 'x');
    assert.equal(lines[1].type, 'error');
    assert.ok(lines.every((e) => e.time));
  });

  it('withHeartbeat emits step events while a slow task runs and stops after', async () => {
    const lines = [];
    const emitter = makeEmitter((l) => lines.push(JSON.parse(l)));
    const { result } = await withHeartbeat(emitter, async () => {
      await new Promise((r) => setTimeout(r, 130));
      return 42;
    }, { message: '生成中', everyMs: 40, index: 0, total: 3 });
    assert.equal(result, 42);
    const steps = lines.filter((e) => e.type === 'step');
    assert.ok(steps.length >= 3, `130ms / 40ms 应至少 3 条心跳，实际 ${steps.length}`);
    assert.equal(steps[0].index, 0);
    assert.equal(steps[0].total, 3);
    assert.ok(!steps.some((e) => e.message === undefined));
    const before = lines.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lines.length, before, '心跳应在任务结束后停止');
  });

  it('error events carry the diagnosable message', () => {
    const lines = [];
    makeEmitter((l) => lines.push(JSON.parse(l))).error('401 Unauthorized');
    assert.match(lines[0].message, /401/);
    assert.match(lines[0].message, /API Key/);
  });
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
function makeRouteCtx() {
  const captured = {};
  const marketingOutlines = new Map();
  const marketingBatches = new Map();
  const taskRegistry = { get: () => undefined, create() {}, complete() {}, fail() {} };
  const deps = {
    send: (res, status, data) => { res.status = status; res.body = data; },
    readBody: async (req) => req._body ?? {},
    validName: (name, res, msg) => {
      if (!isSafeName(name)) { deps.send(res, 400, { error: msg || '非法名称' }); return false; }
      return true;
    },
    ROOT: process.cwd(),
    spawnNdjsonTask: (store, name, script, args) => {
      const state = { name, process: null, buffer: [], listeners: new Set(), done: false };
      store.set(name, state);
      captured.spawn = { store, name, script, args };
      return state;
    },
    serveSse: (res, state) => { res.sse = true; res.state = state; },
    hasActiveTask: (store, name) => { const s = store.get(name); return !!(s && !s.done); },
    marketingOutlines, marketingBatches, taskRegistry,
  };
  return { routes: marketingRoutes(deps), deps, captured, marketingOutlines, marketingBatches };
}

async function call(ctx, method, pathname, { body } = {}) {
  const route = ctx.routes.find((r) => r.method === method && pathname.match(r.pattern));
  assert.ok(route, `no route for ${method} ${pathname}`);
  const matches = pathname.match(route.pattern);
  const res = {};
  await route.handler({ _body: body, url: `http://x${pathname}`, headers: { host: 'x' } }, res, matches);
  return res;
}

describe('routes/marketing.mjs', () => {
  it('literal routes are matched before the :id wildcard', async () => {
    const ctx = makeRouteCtx();
    const r = await call(ctx, 'GET', '/api/marketing/outline/events');
    assert.equal(r.status, 404, '没有在跑任务时 events 应 404，而不是被 /outline/:id 吞掉');
    assert.ok(!r.body?.outline, 'events 被当成 :id 处理了');
    const cur = await call(ctx, 'GET', '/api/marketing/batch/current');
    assert.equal(cur.status, 200);
    assert.deepEqual(cur.body, { running: false }, '无在跑批次必须 {running:false} 而不是 404');
    const sets = await call(ctx, 'GET', '/api/marketing/angle-sets');
    assert.equal(sets.body.sets[0].angles.length >= 6, true);
  });

  it('POST /outline spawns the marketing outline script and 409s while running', async () => {
    const ctx = makeRouteCtx();
    const r = await call(ctx, 'POST', '/api/marketing/outline', {
      body: { sourceIds: ['src-a', 'src-b'], product: { name: 'P', audience: 'A' }, includeStale: true, slidesPerAngle: 6 },
    });
    assert.equal(r.status, 202);
    assert.equal(ctx.captured.spawn.script, 'marketing/generate-outline.mjs');
    assert.ok(ctx.captured.spawn.args.includes('--source'));
    assert.ok(ctx.captured.spawn.args.includes('--include-stale'));
    const again = await call(ctx, 'POST', '/api/marketing/outline', { body: {} });
    assert.equal(again.status, 409);
  });

  it('POST /batch validates body, 409s on a running batch and hands angleKeys to the script', async () => {
    useTmpMarketing();
    const { outline } = await makeOutlineForBatch();
    saveOutline(outline);

    const ctx = makeRouteCtx();
    assert.equal((await call(ctx, 'POST', '/api/marketing/batch', { body: {} })).status, 400, '缺 outlineId 应 400');
    assert.equal((await call(ctx, 'POST', '/api/marketing/batch', { body: { outlineId: 'nope-1' } })).status, 400, '非法 outlineId 应 400');
    assert.equal((await call(ctx, 'POST', '/api/marketing/batch', { body: { outlineId: 'mo-zzzzzzzz', angleKeys: ['roi'] } })).status, 404, '不存在的大纲应 404');
    const notThere = await call(ctx, 'POST', '/api/marketing/batch', { body: { outlineId: outline.id, angleKeys: ['不存在的角度'] } });
    assert.equal(notThere.status, 400);
    const noKeys = await call(ctx, 'POST', '/api/marketing/batch', { body: { outlineId: outline.id, angleKeys: [] } });
    assert.equal(noKeys.status, 400);

    const ok = await call(ctx, 'POST', '/api/marketing/batch', {
      body: { outlineId: outline.id, angleKeys: ['roi', 'pain'], overwrite: true },
    });
    assert.equal(ok.status, 202);
    assert.match(ok.body.batchId, /^mb-[0-9a-z]+$/);
    assert.equal(ctx.captured.spawn.script, 'marketing/batch-generate.mjs');
    assert.ok(ctx.captured.spawn.args.includes('--overwrite'));
    assert.deepEqual(ctx.captured.spawn.args.slice(
      ctx.captured.spawn.args.indexOf('--angles') + 1,
      ctx.captured.spawn.args.indexOf('--angles') + 2,
    ), ['roi,pain']);

    const conflict = await call(ctx, 'POST', '/api/marketing/batch', { body: { outlineId: outline.id, angleKeys: ['roi'] } });
    assert.equal(conflict.status, 409, '同一时刻只允许 1 个批次');

    // /batch/current 从 buffer 重建进度行
    const state = ctx.marketingBatches.get('current');
    state.batchId = ok.body.batchId;
    state.outlineId = outline.id;
    state.deckNames = ['mkt-roi-x', 'mkt-pain-x'];
    state.buffer.push({ type: 'deck', deckName: 'mkt-roi-x', index: 0, total: 2, status: 'done', message: 'ok' });
    state.buffer.push({ type: 'deck', deckName: 'mkt-pain-x', index: 1, total: 2, status: 'running', message: '进行中' });
    const cur = await call(ctx, 'GET', '/api/marketing/batch/current');
    assert.equal(cur.body.running, true);
    assert.equal(cur.body.total, 2);
    assert.equal(cur.body.index, 1);
    assert.deepEqual(cur.body.rows.map((r) => r.status), ['done', 'running']);
    assert.equal(cur.body.outlineId, outline.id);

    const cancelled = await call(ctx, 'POST', '/api/marketing/batch/cancel', { body: {} });
    assert.equal(cancelled.status, 200);
    assert.match(cancelled.body.batchId, /^mb-/);
    assert.ok(fs.existsSync(cancelFlagFor(cancelled.body.batchId)), 'cancel 应落标记文件供子进程轮询');
    fs.rmSync(cancelFlagFor(cancelled.body.batchId), { force: true });

    state.done = true;
    assert.deepEqual((await call(ctx, 'GET', '/api/marketing/batch/current')).body, { running: false });
  });

  it('outline CRUD maps ids and errors correctly', async () => {
    useTmpMarketing();
    const { outline } = await makeOutlineForBatch();
    saveOutline(outline);
    const ctx = makeRouteCtx();

    assert.equal((await call(ctx, 'GET', '/api/marketing/outline/bad..id')).status, 400);
    assert.equal((await call(ctx, 'GET', '/api/marketing/outline/mo-zzzzzzzz')).status, 404);
    const got = await call(ctx, 'GET', `/api/marketing/outline/${outline.id}`);
    assert.equal(got.body.outline.id, outline.id);
    const list = await call(ctx, 'GET', '/api/marketing/outlines');
    assert.equal(list.body.outlines[0].id, outline.id);
    const put = await call(ctx, 'PUT', `/api/marketing/outline/${outline.id}`, { body: { title: '新标题' } });
    assert.equal(put.body.outline.title, '新标题');
    const badPut = await call(ctx, 'PUT', `/api/marketing/outline/${outline.id}`, { body: { angles: [] } });
    assert.equal(badPut.status, 400);
    assert.equal((await call(ctx, 'DELETE', `/api/marketing/outline/${outline.id}`)).status, 204);
    assert.equal((await call(ctx, 'DELETE', `/api/marketing/outline/${outline.id}`)).status, 404);
  });
});
