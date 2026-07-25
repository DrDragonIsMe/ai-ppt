// routes/vault-notes.mjs — 笔记域路由（标签聚合/笔记 CRUD/重命名/chat/任务列表/查询/块引用）
// 路由顺序敏感：本数组顺序即合并后的相对顺序，由 routes/vault.mjs 按拆分前总顺序拼接
import { listNoteBackups, readNoteBackup, isValidBackupTs, readNoteOrder, writeNoteOrder } from '../scripts/vault.mjs';

// 按 note-order.json 中的自定义顺序排列：已记录的排前（按记录序），未记录的保持 mtime 倒序在后
function applyNoteOrder(notes) {
    const order = readNoteOrder();
    if (!order.length) return notes;
    const rank = new Map(order.map((n, i) => [n, i]));
    const bound = order.length;
    // V8 sort 稳定：同 rank（未记录）保持 listNotes 的 mtime 倒序
    return notes.sort((a, b) => (rank.get(a.name) ?? bound) - (rank.get(b.name) ?? bound));
}

export default function vaultNotesRoutes(ctx) {
    const {
        send, readBody, validName,
        ensureVaultApi, backupVaultNote,
        hasActiveTask, spawnNdjsonTask, serveSse,
        generators, noteChats,
    } = ctx;

    return [
        // 标签聚合（契约 N）：字面量路由，排在 vault 通配路由之前
        {
            method: 'GET', pattern: /^\/api\/vault\/tags$/, handler: async (_req, res) => {
                const api = await ensureVaultApi();
                try {
                    send(res, 200, { tags: api.getAllTags() });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/vault\/notes$/, handler: async (req, res) => {
                const api = await ensureVaultApi();
                api.ensureVaultDirs();
                const url = new URL(req.url, `http://${req.headers.host}`);
                const limitParam = url.searchParams.get('limit');
                const offsetParam = url.searchParams.get('offset');
                const notes = applyNoteOrder(api.listNotes());
                // 不传分页参数时保持原有数组响应（前端零改动兼容）
                if (limitParam === null && offsetParam === null) {
                    return send(res, 200, notes);
                }
                const offset = Math.max(0, parseInt(offsetParam || '0', 10) || 0);
                const limit = Math.max(0, parseInt(limitParam || '0', 10) || 0);
                const items = limit > 0 ? notes.slice(offset, offset + limit) : notes.slice(offset);
                send(res, 200, { items, total: notes.length, limit, offset });
            }
        },
        // ---- Logseq 特性与多笔记生成媒体（字面量路由，必须排在 notes/assets 通配路由之前） ----
        // 任务列表：?status=TODO|DOING|DONE &note=笔记名
        {
            method: 'GET', pattern: /^\/api\/vault\/tasks$/, handler: async (req, res) => {
                const api = await ensureVaultApi();
                const url = new URL(req.url, `http://${req.headers.host}`);
                const status = url.searchParams.get('status') || '';
                const noteFilter = url.searchParams.get('note') || '';
                try {
                    const index = api.rebuildIndex();
                    let tasks = index.tasks || [];
                    if (status) tasks = tasks.filter((t) => t.status === status);
                    if (noteFilter) {
                        tasks = tasks.filter((t) => api.normalizeNoteName(t.note) === api.normalizeNoteName(noteFilter));
                    }
                    send(res, 200, { tasks });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // 微型查询 DSL
        {
            method: 'POST', pattern: /^\/api\/vault\/query$/, handler: async (req, res) => {
                const api = await ensureVaultApi();
                const body = await readBody(req);
                const query = typeof body.query === 'string' ? body.query.trim() : '';
                if (!query) return send(res, 400, { error: '请提供查询语句' });
                try {
                    const index = api.rebuildIndex();
                    send(res, 200, { results: api.runQuery(index, query) });
                } catch (err) {
                    if (/查询语法错误/.test(err.message)) return send(res, 400, { error: err.message });
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // 块锚点查询
        {
            method: 'GET', pattern: /^\/api\/vault\/blocks\/([^/]+)$/, handler: async (_req, res, matches) => {
                const id = matches[1];
                if (!validName(id, res, '非法块 ID')) return;
                const api = await ensureVaultApi();
                try {
                    const index = api.rebuildIndex();
                    const block = (index.blocks || {})[id];
                    if (!block) return send(res, 404, { error: '块不存在' });
                    send(res, 200, { id, ...block });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/vault\/notes\/([^/]+)\/info$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                try {
                    api.rebuildIndex();
                    const info = api.getNoteInfo(name);
                    send(res, 200, info);
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // 笔记结构维护（契约 N）：重命名并更新全库引用
        {
            method: 'POST', pattern: /^\/api\/vault\/notes\/([^/]+)\/rename$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                const body = await readBody(req);
                const newName = typeof body.newName === 'string' ? body.newName.trim() : '';
                if (!newName) return send(res, 400, { error: '请提供新名称' });
                if (!validName(newName, res, '非法目标名称')) return;
                if (newName === name) return send(res, 400, { error: '新名称不能与原名称相同' });
                if (api.readNote(name) === null) return send(res, 404, { error: '笔记不存在' });
                if (api.readNote(newName) !== null) return send(res, 400, { error: '目标名称已存在' });
                try {
                    const result = await api.renameNote(name, newName);
                    api.rebuildIndex();
                    send(res, 200, { ok: true, newName, updatedRefs: result?.updatedRefs ?? 0 });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // 未链接提及（契约 N）
        {
            method: 'GET', pattern: /^\/api\/vault\/notes\/([^/]+)\/mentions$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                try {
                    const mentions = await api.findUnlinkedMentions(name);
                    send(res, 200, { mentions });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // 提及转链接（契约 N）
        {
            method: 'POST', pattern: /^\/api\/vault\/notes\/([^/]+)\/link-mentions$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                const body = await readBody(req);
                const source = typeof body.source === 'string' ? body.source.trim() : '';
                if (!source) return send(res, 400, { error: '请提供来源' });
                try {
                    const result = await api.linkMentions(name, source);
                    api.rebuildIndex();
                    const count = typeof result === 'number' ? result : result?.count ?? 0;
                    send(res, 200, { ok: true, count });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // 笔记 AI 对话修改（契约 O）
        {
            method: 'POST', pattern: /^\/api\/vault\/notes\/([^/]+)\/chat$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                const body = await readBody(req);
                const instruction = (body.instruction || '').trim();
                if (!instruction) return send(res, 400, { error: '请提供修改指令' });
                if (api.readNote(name) === null) return send(res, 404, { error: '笔记不存在' });
                if (hasActiveTask(noteChats, name)) {
                    return send(res, 409, { error: '该笔记正在修改中' });
                }
                spawnNdjsonTask(noteChats, name, 'chat-note.mjs', [name, instruction], body.apiKey);
                send(res, 202, { message: '修改已启动' });
            }
        },
        {
            method: 'GET', pattern: /^\/api\/vault\/notes\/([^/]+)\/chat\/events$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                const state = noteChats.get(name);
                if (!state) return send(res, 404, { error: '没有进行中的修改' });
                serveSse(res, state);
            }
        },
        {
            method: 'GET', pattern: /^\/api\/vault\/notes\/([^/]+)$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                const content = api.readNote(name);
                if (content === null) return send(res, 404, { error: '笔记不存在' });
                const { frontMatter } = api.parseFrontMatter(content);
                send(res, 200, { name, content, frontMatter });
            }
        },
        {
            method: 'POST', pattern: /^\/api\/vault\/notes$/, handler: async (req, res) => {
                const api = await ensureVaultApi();
                const body = await readBody(req);
                if (!validName(body.name, res, '非法笔记名称')) return;
                try {
                    const notePath = api.createNote(body.name, body.content || '');
                    api.rebuildIndex();
                    send(res, 201, { name: body.name, path: notePath });
                } catch (err) {
                    send(res, err.statusCode || 400, { error: err.message });
                }
            }
        },
        {
            method: 'PUT', pattern: /^\/api\/vault\/notes\/([^/]+)$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                const body = await readBody(req);
                try {
                    backupVaultNote(api, name);
                    const notePath = api.writeNote(name, body.content);
                    api.rebuildIndex();
                    send(res, 200, { name, path: notePath });
                } catch (err) {
                    send(res, err.statusCode || 400, { error: err.message });
                }
            }
        },
        {
            method: 'DELETE', pattern: /^\/api\/vault\/notes\/([^/]+)$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                try {
                    backupVaultNote(api, name);
                    api.deleteNote(name);
                    api.rebuildIndex();
                    send(res, 204, {});
                } catch (err) {
                    send(res, err.statusCode || 400, { error: err.message });
                }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/vault\/notes\/([^/]+)\/generate-ppt$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                const body = await readBody(req);
                const projectName = body.projectName || name.replace(/[^\w\u4e00-\u9fa5-]/g, '-');
                if (!validName(projectName, res, '非法项目名称')) return;
                if (hasActiveTask(generators, projectName)) {
                    return send(res, 409, { error: '该项目正在生成中' });
                }
                const includeLinked = body.includeLinked || false;
                spawnNdjsonTask(generators, projectName, 'generate-from-note.mjs', [
                    name, projectName,
                    ...(includeLinked ? ['--include-linked'] : []),
                ], body.apiKey);
                send(res, 202, { message: '生成已启动', name: projectName });
            }
        },
        // ---- 笔记列表自定义排序（拖拽排序持久化，存 vault/.meta/note-order.json） ----
        {
            method: 'GET', pattern: /^\/api\/vault\/note-order$/, handler: async (_req, res) => {
                send(res, 200, { order: readNoteOrder() });
            }
        },
        {
            method: 'PUT', pattern: /^\/api\/vault\/note-order$/, handler: async (req, res) => {
                const body = await readBody(req);
                const order = Array.isArray(body.order) ? body.order : null;
                if (!order) return send(res, 400, { error: '请提供 order 数组' });
                if (order.length > 5000) return send(res, 400, { error: 'order 数组过长' });
                for (const name of order) {
                    if (typeof name !== 'string' || !validName(name, res, '非法笔记名称')) return;
                }
                send(res, 200, { ok: true, order: writeNoteOrder(order) });
            }
        },
        // ---- 笔记历史备份（.snapshots/_vault/<ts>/<file>）：列表 / 恢复 ----
        {
            method: 'GET', pattern: /^\/api\/vault\/notes\/([^/]+)\/backups$/, handler: async (_req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                try {
                    send(res, 200, { backups: listNoteBackups(name) });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/vault\/notes\/([^/]+)\/restore-backup$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                const body = await readBody(req);
                const ts = typeof body.ts === 'string' ? body.ts : '';
                if (!isValidBackupTs(ts)) return send(res, 400, { error: '非法备份时间戳' });
                let content;
                try {
                    content = readNoteBackup(name, ts);
                } catch (err) {
                    return send(res, err.statusCode || 500, { error: err.message });
                }
                if (content === null) return send(res, 404, { error: '备份不存在' });
                try {
                    backupVaultNote(api, name); // 恢复前先把当前版本备份（笔记不存在时静默跳过）
                    api.writeNote(name, content);
                    api.rebuildIndex();
                    send(res, 200, { ok: true });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // ---- 批量打标签：向笔记 Front Matter tags 追加（去重），用统一 FM 解析器保持格式 ----
        {
            method: 'POST', pattern: /^\/api\/vault\/notes\/([^/]+)\/add-tags$/, handler: async (req, res, matches) => {
                const api = await ensureVaultApi();
                const name = matches[1];
                if (!validName(name, res, '非法笔记名称')) return;
                const body = await readBody(req);
                const tags = (Array.isArray(body.tags) ? body.tags : []).map((t) => String(t).trim()).filter(Boolean);
                if (!tags.length) return send(res, 400, { error: '请提供标签' });
                if (tags.length > 50) return send(res, 400, { error: '一次最多追加 50 个标签' });
                const content = api.readNote(name);
                if (content === null) return send(res, 404, { error: '笔记不存在' });
                try {
                    const { frontMatter, content: bodyText } = api.parseFrontMatter(content);
                    const existing = Array.isArray(frontMatter.tags)
                        ? frontMatter.tags.map(String)
                        : (frontMatter.tags ? [String(frontMatter.tags)] : []);
                    const merged = [...existing];
                    for (const t of tags) if (!merged.includes(t)) merged.push(t);
                    if (merged.length === existing.length) {
                        return send(res, 200, { ok: true, tags: merged, changed: false });
                    }
                    frontMatter.tags = merged;
                    backupVaultNote(api, name);
                    api.writeNote(name, api.stringifyFrontMatter(frontMatter) + bodyText);
                    api.rebuildIndex();
                    send(res, 200, { ok: true, tags: merged, changed: true });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
    ];
}
