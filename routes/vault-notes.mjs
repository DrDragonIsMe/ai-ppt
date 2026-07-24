// routes/vault-notes.mjs — 笔记域路由（标签聚合/笔记 CRUD/重命名/chat/任务列表/查询/块引用）
// 路由顺序敏感：本数组顺序即合并后的相对顺序，由 routes/vault.mjs 按拆分前总顺序拼接
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
                const notes = api.listNotes();
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
    ];
}
