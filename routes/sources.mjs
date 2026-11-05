// routes/sources.mjs — 素材源 HTTP 端点（契约 B020200）。
// 端点：GET/POST /api/sources、PUT/DELETE /api/sources/:id、
//        POST /api/sources/:id/refresh（202 + SSE）、GET /api/sources/:id/refresh/events、
//        GET /api/sources/:id/items、GET /api/sources/items?q=&limit=、POST /api/sources/preview。
// 错误映射：非法 id/target → 400；源不存在 → 404；刷新进行中重复触发 → 409；磁盘/网络真实失败 → 500。
// 刷新走 202 + NDJSON SSE：spawnNdjsonTask(store=sourceRefreshes, script='sources/refresh.mjs', args=[id])，
// 同 id 重复刷新 409；服务重启后由 taskRegistry.load()/restoreInterruptedNdjsonTasks 标为 interrupted。
import {
  loadSources, getSource, upsertSource, removeSource, SourceError,
} from '../scripts/sources/registry.mjs';
import { listItems, readManifest, removeCache } from '../scripts/sources/store.mjs';
import { previewSource } from '../scripts/sources/refresh.mjs';
import { isActiveStatus } from '../scripts/task-registry.mjs';

export default function sourcesRoutes(deps) {
  const {
    send, readBody, validName,
    spawnNdjsonTask, serveSse, hasActiveTask,
    sourceRefreshes, taskRegistry,
  } = deps;

  // 源 id 校验：形如 src-<slug>，非法返回 false 并发送响应。
  function validSourceId(id, res) {
    if (!validName(id, res, '非法源 id')) return false;
    if (!/^src-[a-z0-9][a-z0-9-]*$/.test(id)) {
      send(res, 400, { error: `非法源 id（须形如 src-<slug>）：${id}` });
      return false;
    }
    return true;
  }

  const errStatus = (err) => (err instanceof SourceError ? err.statusCode : (err.statusCode || 500));

  return [
    // 列出全部源（附缓存条目数，供前端展示）
    {
      method: 'GET',
      pattern: /^\/api\/sources$/,
      handler: async (_req, res) => {
        try {
          const data = loadSources();
          const sources = data.sources.map((s) => {
            const m = readManifest(s.id);
            return { ...s, itemCount: m ? m.items.length : 0 };
          });
          send(res, 200, { version: data.version, sources });
        } catch (err) {
          send(res, errStatus(err), { error: err.message });
        }
      },
    },

    // 跨源列出条目（?q=&limit=）
    {
      method: 'GET',
      pattern: /^\/api\/sources\/items$/,
      handler: async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const q = url.searchParams.get('q') || undefined;
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw != null && limitRaw !== '' ? Number(limitRaw) : undefined;
        try {
          const items = listItems({ q, limit });
          send(res, 200, { items });
        } catch (err) {
          send(res, errStatus(err), { error: err.message });
        }
      },
    },

    // 单源条目（?q=&limit=）
    {
      method: 'GET',
      pattern: /^\/api\/sources\/([^/]+)\/items$/,
      handler: async (req, res, matches) => {
        const id = matches[1];
        if (!validSourceId(id, res)) return;
        if (!getSource(id)) return send(res, 404, { error: `源不存在：${id}` });
        const url = new URL(req.url, `http://${req.headers.host}`);
        const q = url.searchParams.get('q') || undefined;
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw != null && limitRaw !== '' ? Number(limitRaw) : undefined;
        try {
          const items = listItems({ sourceId: id, q, limit });
          send(res, 200, { sourceId: id, items });
        } catch (err) {
          send(res, errStatus(err), { error: err.message });
        }
      },
    },

    // 新建源
    {
      method: 'POST',
      pattern: /^\/api\/sources$/,
      handler: async (req, res) => {
        try {
          const body = await readBody(req);
          const { source } = upsertSource(body);
          send(res, 201, { source });
        } catch (err) {
          send(res, errStatus(err), { error: err.message });
        }
      },
    },

    // 试抓预览（不落盘）：body 为源定义（可未保存），或 {id} 引用已有源
    {
      method: 'POST',
      pattern: /^\/api\/sources\/preview$/,
      handler: async (req, res) => {
        try {
          const body = await readBody(req);
          const target = body && body.id ? body.id : body;
          const result = await previewSource(target, {});
          if (!result.ok) {
            return send(res, 500, { error: result.error || '试抓失败', origin: result.origin || null });
          }
          send(res, 200, result);
        } catch (err) {
          send(res, errStatus(err), { error: err.message });
        }
      },
    },

    // 更新源
    {
      method: 'PUT',
      pattern: /^\/api\/sources\/([^/]+)$/,
      handler: async (req, res, matches) => {
        const id = matches[1];
        if (!validSourceId(id, res)) return;
        try {
          const body = await readBody(req);
          const { source } = upsertSource(body, id);
          send(res, 200, { source });
        } catch (err) {
          send(res, errStatus(err), { error: err.message });
        }
      },
    },

    // 删除源（?purge=true 一并清缓存）
    {
      method: 'DELETE',
      pattern: /^\/api\/sources\/([^/]+)$/,
      handler: async (req, res, matches) => {
        const id = matches[1];
        if (!validSourceId(id, res)) return;
        try {
          const state = sourceRefreshes.get(id);
          if (state && !state.done) return send(res, 409, { error: '该源正在刷新中，无法删除' });
          const ok = removeSource(id);
          if (!ok) return send(res, 404, { error: `源不存在：${id}` });
          const url = new URL(req.url, `http://${req.headers.host}`);
          if (url.searchParams.get('purge') === 'true') removeCache(id);
          send(res, 204, {});
        } catch (err) {
          send(res, errStatus(err), { error: err.message });
        }
      },
    },

    // 触发刷新（202 + SSE）。同 id 已在刷新 → 409。
    {
      method: 'POST',
      pattern: /^\/api\/sources\/([^/]+)\/refresh$/,
      handler: async (_req, res, matches) => {
        const id = matches[1];
        if (!validSourceId(id, res)) return;
        const source = getSource(id);
        if (!source) return send(res, 404, { error: `源不存在：${id}` });
        if (hasActiveTask(sourceRefreshes, id)) {
          return send(res, 409, { error: '该源正在刷新中，请等待完成' });
        }
        // 双保险：任务注册表里同名活跃任务也视为占用（跨 store 一致性）
        const metaId = `ndjson:source-refresh:${id}`;
        if (isActiveStatus(taskRegistry.get(metaId)?.status)) {
          return send(res, 409, { error: '该源正在刷新中，请等待完成' });
        }
        spawnNdjsonTask(sourceRefreshes, id, 'sources/refresh.mjs', [id]);
        send(res, 202, { message: '刷新已启动', sourceId: id });
      },
    },

    // 刷新进度 SSE
    {
      method: 'GET',
      pattern: /^\/api\/sources\/([^/]+)\/refresh\/events$/,
      handler: async (req, res, matches) => {
        const id = matches[1];
        if (!validSourceId(id, res)) return;
        const state = sourceRefreshes.get(id);
        if (state) return serveSse(res, state);
        if (!getSource(id)) return send(res, 404, { error: `源不存在：${id}` });
        send(res, 404, { error: '没有进行中的刷新' });
      },
    },
  ];
}
