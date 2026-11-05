// routes/marketing.mjs — 营销大纲与批量生成 HTTP 端点（契约 B030300）。
// 端点：
//   POST   /api/marketing/outline          202 + GET /api/marketing/outline/events（NDJSON SSE）
//   GET    /api/marketing/outlines         大纲列表（摘要）
//   GET    /api/marketing/outline/:id      单份大纲
//   PUT    /api/marketing/outline/:id      局部更新（title/product/angles/status）
//   DELETE /api/marketing/outline/:id      删除
//   GET    /api/marketing/angle-sets       内置角度集（前端下拉用）
//   POST   /api/marketing/batch            202 + GET /api/marketing/batch/events；已有批次在跑 → 409
//   GET    /api/marketing/batch/current    在跑批次状态（无在跑 → {running:false}，不返回 404）
//   GET    /api/marketing/batches          批次历史
//   POST   /api/marketing/batch/cancel     取消在跑批次（标记文件，子进程在 deck 边界停止）
// 全局同一时刻只允许 1 个批次与 1 个大纲生成（任务键固定 'current'），与本仓导出/刷新的 409 去重语义一致。
// 子进程任务元信息进 taskRegistry（kind marketing-batch / marketing-outline），重启后标 interrupted。
import {
  listOutlines, getOutline, updateOutline, deleteOutline, isSafeOutlineId,
  validateOutline, normalizeOutline, listBatchRecords, readBatchRecord, makeBatchId, isSafeBatchId,
} from '../scripts/marketing/store.mjs';
import { ANGLE_SETS, DEFAULT_ANGLE_SET } from '../scripts/marketing/angles.mjs';
import { cancelFlagFor } from '../scripts/marketing/batch-generate.mjs';
import { isActiveStatus } from '../scripts/task-registry.mjs';
import { saveOutline } from '../scripts/marketing/store.mjs';
import fs from 'node:fs';
import path from 'node:path';

const TASK_KEY = 'current';

export default function marketingRoutes(deps) {
  const {
    send, readBody, validName,
    spawnNdjsonTask, serveSse, hasActiveTask,
    marketingOutlines, marketingBatches, taskRegistry,
  } = deps;

  // POST /api/marketing/outline 的 body → CLI 参数（值一律字符串化，脚本侧再解析）
  function outlineArgs(body) {
    const args = [];
    const sourceIds = Array.isArray(body?.sourceIds) ? body.sourceIds.filter((s) => typeof s === 'string' && s) : [];
    if (sourceIds.length) args.push('--source', sourceIds.join(','));
    if (body?.product?.name) args.push('--product', String(body.product.name).slice(0, 120));
    if (body?.product?.audience) args.push('--audience', String(body.product.audience).slice(0, 120));
    if (body?.product?.tone) args.push('--tone', String(body.product.tone).slice(0, 120));
    if (body?.angleSet && ANGLE_SETS[body.angleSet]) args.push('--angle-set', String(body.angleSet));
    if (body?.title) args.push('--title', String(body.title).slice(0, 160));
    if (Number.isFinite(Number(body?.slidesPerAngle))) args.push('--slides', String(Math.round(Number(body.slidesPerAngle))));
    if (body?.includeStale === true) args.push('--include-stale');
    return args;
  }

  function validOutlineId(id, res) {
    if (!validName(id, res, '非法大纲 id')) return false;
    if (!isSafeOutlineId(id)) {
      send(res, 400, { error: `非法大纲 id（须形如 mo-<base36>）：${id}` });
      return false;
    }
    return true;
  }

  /** 从在跑任务的 buffer 里重建每份 deck 的最新状态（M11 进度表主键是 index）。 */
  function rowsFromBuffer(buffer, deckNames) {
    const byIndex = new Map();
    (deckNames || []).forEach((deckName, i) => byIndex.set(i, { deckName, index: i, status: 'pending', message: '' }));
    for (const ev of buffer || []) {
      if (ev?.type !== 'deck') continue;
      const i = Number(ev.index);
      if (!Number.isInteger(i) || i < 0) continue;
      const prev = byIndex.get(i) || { deckName: ev.deckName, index: i, status: 'pending', message: '' };
      byIndex.set(i, {
        ...prev,
        deckName: ev.deckName || prev.deckName,
        status: ev.status || prev.status,
        message: ev.message || prev.message,
      });
    }
    return Array.from(byIndex.keys()).sort((a, b) => a - b).map((k) => byIndex.get(k));
  }

  return [
    // ---- 角度集（字面量路由必须排在 /outline/:id 通配之前） ----
    {
      method: 'GET',
      pattern: /^\/api\/marketing\/angle-sets$/,
      handler: async (_req, res) => {
        const sets = Object.entries(ANGLE_SETS).map(([id, defs]) => ({
          id,
          isDefault: id === DEFAULT_ANGLE_SET,
          angles: defs.map((a) => ({ key: a.key, title: a.title, thesis: a.thesis, audience: a.audience })),
        }));
        send(res, 200, { defaultSet: DEFAULT_ANGLE_SET, sets });
      },
    },

    // ---- 大纲 CRUD ----
    {
      method: 'GET',
      pattern: /^\/api\/marketing\/outlines$/,
      handler: async (_req, res) => {
        try {
          send(res, 200, { outlines: listOutlines() });
        } catch (err) {
          send(res, err.statusCode || 500, { error: err.message });
        }
      },
    },

    // 生成大纲（202 + SSE）。同一时刻只允许一个大纲生成任务。
    {
      method: 'POST',
      pattern: /^\/api\/marketing\/outline$/,
      handler: async (req, res) => {
        try {
          if (hasActiveTask(marketingOutlines, TASK_KEY)) {
            return send(res, 409, { error: '已有营销大纲正在生成，请等待完成' });
          }
          if (isActiveStatus(taskRegistry.get(`ndjson:marketing-outline:${TASK_KEY}`)?.status)) {
            return send(res, 409, { error: '已有营销大纲正在生成，请等待完成' });
          }
          const body = await readBody(req);
          const args = outlineArgs(body);
          spawnNdjsonTask(marketingOutlines, TASK_KEY, 'marketing/generate-outline.mjs', args, body?.apiKey);
          send(res, 202, { message: '营销大纲生成已启动' });
        } catch (err) {
          send(res, err.statusCode || 500, { error: err.message });
        }
      },
    },

    // 大纲生成进度 SSE
    {
      method: 'GET',
      pattern: /^\/api\/marketing\/outline\/events$/,
      handler: async (_req, res) => {
        const state = marketingOutlines.get(TASK_KEY);
        if (state) return serveSse(res, state);
        send(res, 404, { error: '没有进行中的大纲生成' });
      },
    },

    {
      method: 'GET',
      pattern: /^\/api\/marketing\/outline\/([^/]+)$/,
      handler: async (_req, res, matches) => {
        const id = matches[1];
        if (!validOutlineId(id, res)) return;
        const outline = getOutline(id);
        if (!outline) return send(res, 404, { error: `大纲不存在：${id}` });
        send(res, 200, { outline });
      },
    },

    {
      method: 'PUT',
      pattern: /^\/api\/marketing\/outline\/([^/]+)$/,
      handler: async (req, res, matches) => {
        const id = matches[1];
        if (!validOutlineId(id, res)) return;
        try {
          const body = await readBody(req);
          if (!getOutline(id)) return send(res, 404, { error: `大纲不存在：${id}` });
          const outline = updateOutline(id, body || {});
          send(res, 200, { outline });
        } catch (err) {
          if (err.errors) return send(res, err.statusCode || 400, { error: err.message, errors: err.errors });
          send(res, err.statusCode || 500, { error: err.message });
        }
      },
    },

    {
      method: 'DELETE',
      pattern: /^\/api\/marketing\/outline\/([^/]+)$/,
      handler: async (_req, res, matches) => {
        const id = matches[1];
        if (!validOutlineId(id, res)) return;
        if (!getOutline(id)) return send(res, 404, { error: `大纲不存在：${id}` });
        // 大纲在用（批次在跑）时不允许删，避免批次读到半路消失的大纲
        const batch = marketingBatches.get(TASK_KEY);
        if (batch && !batch.done && batch.outlineId === id) {
          return send(res, 409, { error: '该大纲正在被批量生成使用，无法删除' });
        }
        deleteOutline(id);
        send(res, 204, {});
      },
    },

    // 手工新建/覆盖大纲（前端可视化编辑整份大纲时用；仍走同一套校验）
    {
      method: 'POST',
      pattern: /^\/api\/marketing\/outline\/save$/,
      handler: async (req, res) => {
        try {
          const body = await readBody(req);
          const outline = normalizeOutline(body?.outline || body);
          const errors = validateOutline(outline);
          if (errors.length) return send(res, 400, { error: errors[0], errors });
          send(res, outline.createdAt ? 200 : 201, { outline: saveOutline(outline) });
        } catch (err) {
          send(res, err.statusCode || 500, { error: err.message });
        }
      },
    },

    // ---- 批量生成 ----
    {
      method: 'GET',
      pattern: /^\/api\/marketing\/batches$/,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const limit = Number(url.searchParams.get('limit')) || 50;
          const running = marketingBatches.get(TASK_KEY);
          const records = listBatchRecords(limit).map((r) => {
            // 记录里还是 running 但内存中已无该任务 ⇒ 进程已退出/服务重启过，如实标 interrupted
            const staleRunning = r.status === 'running'
              && !(running && !running.done && running.batchId === r.id);
            return staleRunning ? { ...r, status: 'interrupted' } : r;
          });
          send(res, 200, { batches: records });
        } catch (err) {
          send(res, err.statusCode || 500, { error: err.message });
        }
      },
    },

    // 在跑批次探测（前端进 batch 子 tab 时调一次即可重建进度表并重挂 SSE）
    {
      method: 'GET',
      pattern: /^\/api\/marketing\/batch\/current$/,
      handler: async (_req, res) => {
        const state = marketingBatches.get(TASK_KEY);
        if (!state || state.done) return send(res, 200, { running: false });
        const meta = readBatchRecord(state.batchId) || {};
        const rows = rowsFromBuffer(state.buffer, meta.deckNames || state.deckNames);
        send(res, 200, {
          running: true,
          batchId: state.batchId || null,
          outlineId: state.outlineId || meta.outlineId || null,
          outlineTitle: state.outlineTitle || meta.outlineTitle || '',
          total: rows.length || state.total || meta.total || 0,
          index: rows.filter((r) => r.status === 'running').length
            ? rows.find((r) => r.status === 'running').index
            : rows.filter((r) => r.status === 'done').length,
          rows,
          startedAt: state.startedAt || meta.startedAt || null,
        });
      },
    },

    {
      method: 'POST',
      pattern: /^\/api\/marketing\/batch$/,
      handler: async (req, res) => {
        try {
          const body = await readBody(req);
          const outlineId = typeof body?.outlineId === 'string' ? body.outlineId : '';
          if (!isSafeOutlineId(outlineId)) {
            return send(res, 400, { error: `非法大纲 id（须形如 mo-<base36>）：${outlineId || '(空)'}` });
          }
          const outline = getOutline(outlineId);
          if (!outline) return send(res, 404, { error: `大纲不存在：${outlineId}` });
          const angleKeys = Array.isArray(body?.angleKeys) ? body.angleKeys.map(String) : [];
          if (!angleKeys.length) return send(res, 400, { error: 'angleKeys 不能为空（要生成哪些角度）' });
          const known = new Set(outline.angles.map((a) => a.key));
          const unknown = angleKeys.filter((k) => !known.has(k));
          if (unknown.length) return send(res, 400, { error: `大纲里没有这些角度：${unknown.join('、')}` });

          // 全局单批次：与 routes/projects.mjs / routes/sources.mjs 的 409 去重语义一致
          if (hasActiveTask(marketingBatches, TASK_KEY)) {
            return send(res, 409, { error: '已有批量生成任务在进行中，请等待完成或先取消' });
          }
          if (isActiveStatus(taskRegistry.get(`ndjson:marketing-batch:${TASK_KEY}`)?.status)) {
            return send(res, 409, { error: '已有批量生成任务在进行中，请等待完成或先取消' });
          }

          const batchId = isSafeBatchId(body?.batchId) ? body.batchId : makeBatchId();
          const args = [outlineId, '--angles', angleKeys.join(','), '--batch-id', batchId];
          if (body?.overwrite === true) args.push('--overwrite');
          if (Number.isFinite(Number(body?.slidesPerDeck))) args.push('--slides', String(Math.round(Number(body.slidesPerDeck))));
          if (body?.theme) args.push('--theme', String(body.theme).slice(0, 40));
          if (body?.animation) args.push('--animation', String(body.animation).slice(0, 40));

          const state = spawnNdjsonTask(marketingBatches, TASK_KEY, 'marketing/batch-generate.mjs', args, body?.apiKey);
          // 挂上批次上下文，供 /batch/current 与 DELETE 保护读取
          state.batchId = batchId;
          state.outlineId = outlineId;
          state.outlineTitle = outline.title;
          state.deckNames = angleKeys.map((k) => outline.angles.find((a) => a.key === k)?.deckName).filter(Boolean);
          state.total = angleKeys.length;
          state.startedAt = new Date().toISOString();
          // 新批次清掉上一次遗留的取消标记，否则一启动就被判为已取消
          try { fs.unlinkSync(cancelFlagFor(batchId)); } catch { /* 不存在即正常 */ }
          send(res, 202, { message: '批量生成已启动', batchId, total: angleKeys.length, deckNames: state.deckNames });
        } catch (err) {
          send(res, err.statusCode || 500, { error: err.message });
        }
      },
    },

    {
      method: 'GET',
      pattern: /^\/api\/marketing\/batch\/events$/,
      handler: async (_req, res) => {
        const state = marketingBatches.get(TASK_KEY);
        if (state) return serveSse(res, state);
        send(res, 404, { error: '没有进行中的批量生成' });
      },
    },

    // 取消：落一个标记文件，子进程在 deck 边界读到即停（正在跑的 LLM 调用不被强杀，其结果被忽略）
    {
      method: 'POST',
      pattern: /^\/api\/marketing\/batch\/cancel$/,
      handler: async (req, res) => {
        try {
          const state = marketingBatches.get(TASK_KEY);
          if (!state || state.done) return send(res, 404, { error: '没有进行中的批量生成' });
          const body = await readBody(req).catch(() => ({}));
          const batchId = body?.batchId && isSafeBatchId(body.batchId) ? body.batchId : state.batchId;
          if (!batchId) return send(res, 400, { error: '缺少 batchId' });
          const flag = cancelFlagFor(batchId);
          fs.mkdirSync(path.dirname(flag), { recursive: true });
          fs.writeFileSync(flag, `${new Date().toISOString()}\n`);
          send(res, 200, { message: '已请求取消，当前 deck 完成后停止', batchId });
        } catch (err) {
          send(res, err.statusCode || 500, { error: err.message });
        }
      },
    },
  ];
}
