// routes/media.mjs — 图片/视频生成与任务轮询路由
import path from 'node:path';
import { isActiveStatus, publicTask } from '../scripts/task-registry.mjs';
import { findAsset, registerAsset, listAssets, removeAsset, pruneOrphanedAssets, ensureResourceDir } from '../scripts/resource-registry.mjs';

export default function mediaRoutes({ send, readBody, validName, isSafeNoteName, ensureVaultApi, DEFAULT_MEDIA_MODEL_CONFIG, ensureDir, randomUUID, generateImage, generateVideo, probeMediaProvider, taskRegistry, ROOT, projectExists, getProjectDir }) {
    // 解析媒体生成落盘目标：'vault' → vault/assets，否则为指定项目的 assets 目录。
    function resolveMediaTarget(target, res) {
        if (target === 'vault') {
            return { dir: path.join(ROOT, 'vault', 'assets'), webBase: '/api/vault/assets' };
        }
        if (!validName(target, res, '非法目标名称')) return null;
        if (!projectExists(target)) {
            send(res, 404, { error: '项目不存在' });
            return null;
        }
        return { dir: path.join(getProjectDir(target), 'assets'), webBase: `/projects/${target}/assets` };
    }

    // ---- 上下文解析：从请求体构建 generation matrix 的 context 对象 ----
    // 支持三种上下文：topic（专题路径）、note（笔记名）、selection（选中文本）
    function parseGenerationContext(body) {
        const ctx = body.context || {};
        if (ctx.kind === 'topic') {
            if (!ctx.topicPath || !isSafeNoteName(ctx.topicPath)) return null;
            return { kind: 'topic', topicPath: ctx.topicPath };
        }
        if (ctx.kind === 'note') {
            if (!ctx.noteName || !isSafeNoteName(ctx.noteName)) return null;
            return { kind: 'note', noteName: ctx.noteName, selection: ctx.selection || null };
        }
        if (ctx.kind === 'selection') {
            const sel = typeof ctx.selection === 'string' ? { text: ctx.selection } : ctx.selection;
            if (!sel || !sel.text || !String(sel.text).trim()) return null;
            return { kind: 'selection', selection: sel };
        }
        // 兼容：直接在 body 中提供 prompt 的老式调用 → 当作 selection 处理
        const directPrompt = (body.prompt || '').trim();
        if (directPrompt) {
            return { kind: 'selection', selection: { text: directPrompt, sourceNote: body.noteName || null } };
        }
        return null;
    }

    return [
        // 媒体生成（契约 F）：生图同步返回，视频异步任务 + 轮询
        {
            method: 'POST', pattern: /^\/api\/media\/image$/, handler: async (req, res) => {
                const body = await readBody(req);
                const prompt = (body.prompt || '').trim();
                if (!prompt) return send(res, 400, { error: '请提供生成提示词' });
                const target = resolveMediaTarget(body.target || 'vault', res);
                if (!target) return;
                const cfg = readGlobalConfig().imageModelConfig || DEFAULT_MEDIA_MODEL_CONFIG;
                ensureDir(target.dir);
                const outPath = path.join(target.dir, `img-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
                let result = null;
                try {
                    result = await generateImage(prompt, {
                        provider: cfg.provider,
                        model: cfg.model,
                        baseUrl: cfg.baseUrl,
                        apiKey: body.apiKey, // 临时透传，不落盘
                        outPath,
                    });
                } catch (e) {
                    console.error('生图失败:', e.message);
                    result = null;
                }
                const errMsg = result ? null : '生图失败或后端不可用';
                if (errMsg) return send(res, 502, { error: errMsg });
                send(res, 200, {
                    filePath: result.filePath,
                    webPath: `${target.webBase}/${encodeURIComponent(path.basename(result.filePath))}`,
                });
            }
        },
        {
            method: 'POST', pattern: /^\/api\/media\/video$/, handler: async (req, res) => {
                const body = await readBody(req);
                const prompt = (body.prompt || '').trim();
                if (!prompt) return send(res, 400, { error: '请提供生成提示词' });
                const target = resolveMediaTarget(body.target || 'vault', res);
                if (!target) return;
                const cfg = readGlobalConfig().videoModelConfig || DEFAULT_MEDIA_MODEL_CONFIG;
                ensureDir(target.dir);
                const outPath = path.join(target.dir, `video-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`);
                const taskId = `video-${randomUUID()}`;
                taskRegistry.create(taskId, { kind: 'media', status: 'pending' });
                // 后台异步执行（提交 + 轮询 + 下载由 media-gen 封装），结果写回任务状态
                (async () => {
                    // 已取消/已中断的任务忽略迟到结果
                    const stillActive = () => isActiveStatus(taskRegistry.get(taskId)?.status);
                    try {
                        const result = await generateVideo(prompt, {
                            provider: cfg.provider,
                            model: cfg.model,
                            baseUrl: cfg.baseUrl,
                            apiKey: body.apiKey, // 临时透传，不落盘
                            outPath,
                        });
                        if (!stillActive()) return;
                        if (result) {
                            taskRegistry.complete(taskId, {
                                filePath: result.filePath,
                                webPath: `${target.webBase}/${encodeURIComponent(path.basename(result.filePath))}`,
                            });
                        } else {
                            taskRegistry.fail(taskId, '视频生成失败或后端不可用');
                        }
                    } catch (err) {
                        if (!stillActive()) return;
                        taskRegistry.fail(taskId, err.message || '视频生成失败或后端不可用');
                    }
                })();
                send(res, 202, { taskId });
            }
        },
        {
            method: 'GET', pattern: /^\/api\/media\/tasks\/([^/]+)$/, handler: async (_req, res, matches) => {
                const taskId = matches[1];
                if (!validName(taskId, res, '非法任务 ID')) return;
                const task = taskRegistry.get(taskId);
                if (!task || task.kind !== 'media') return send(res, 404, { status: 'unknown', error: '任务不存在或已过期' });
                send(res, 200, { taskId, ...publicTask(task) });
            }
        },
        // 取消媒体任务：HTTP 等待型任务标记 cancelled 后忽略后续结果
        {
            method: 'POST', pattern: /^\/api\/media\/tasks\/([^/]+)\/cancel$/, handler: async (_req, res, matches) => {
                const taskId = matches[1];
                if (!validName(taskId, res, '非法任务 ID')) return;
                const task = taskRegistry.get(taskId);
                if (!task || task.kind !== 'media') return send(res, 404, { status: 'unknown', error: '任务不存在或已过期' });
                taskRegistry.cancel(taskId);
                send(res, 200, { taskId, status: taskRegistry.get(taskId).status });
            }
        },
        // 探测图像/视频后端是否可用（契约 F）
        {
            method: 'POST', pattern: /^\/api\/media\/test$/, handler: async (req, res) => {
                const body = await readBody(req);
                if (body.kind !== 'image' && body.kind !== 'video') {
                    return send(res, 400, { error: "kind 必须是 'image' 或 'video'" });
                }
                const globalCfg = readGlobalConfig();
                const group = (body.kind === 'image' ? globalCfg.imageModelConfig : globalCfg.videoModelConfig)
                    || DEFAULT_MEDIA_MODEL_CONFIG;
                // 允许请求体临时覆盖 provider/model/baseUrl/apiKey（探测未保存的配置，不落盘）
                const cfg = { ...group };
                for (const key of ['provider', 'model', 'baseUrl', 'apiKey']) {
                    if (body[key] !== undefined) cfg[key] = body[key];
                }
                try {
                    send(res, 200, await probeMediaProvider(body.kind, cfg));
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // ---- 统一生成矩阵：context × outputType（契约 P1） ----
        // context.kind ∈ topic|note|selection，outputType ∈ ppt|image|video
        {
            method: 'POST', pattern: /^\/api\/media\/ppt-from-context$/, handler: async (req, res) => {
                const body = await readBody(req);
                const context = parseGenerationContext(body);
                if (!context) return send(res, 400, { error: '请提供有效的生成上下文（context.kind/topicPath/noteName/selection）' });

                // PPT 生成异步任务：202 + NDJSON SSE，产物落 projects/<name>/
                const projectName = body.projectName;
                if (!projectName) return send(res, 400, { error: '请提供 projectName' });
                if (!validName(projectName, res, '非法项目名称')) return;

                // 检查是否已有正在生成的同名任务（防并发）
                const existing = taskRegistry.get(`ppt:${projectName}`);
                if (existing && isActiveStatus(existing.status)) {
                    return send(res, 409, { error: '该项目正在生成中' });
                }

                // 如果 context 来源于笔记，校验笔记存在（topic 不强制校验）
                if (context.kind === 'note') {
                    const api = await ensureVaultApi();
                    if (!api.readNote(context.noteName)) return send(res, 404, { error: `笔记不存在：${context.noteName}` });
                }

                // 构建传递给 generate-unified.mjs 的 CLI 参数
                let contextArg;
                if (context.kind === 'topic') contextArg = `topic:${context.topicPath}`;
                else if (context.kind === 'note') contextArg = `note:${context.noteName}`;
                else contextArg = 'selection';

                // PPT 使用 NDJSON 子进程（generate-unified.mjs 输出进度事件）
                const taskId = `ppt:${projectName}`;
                taskRegistry.create(taskId, { kind: 'generation', status: 'pending' });

                // 构建 CLI 参数：outputType contextArg [options...]
                const childArgs = ['ppt', contextArg];
                for (const key of ['title']) {
                    if (body[key] !== undefined) childArgs.push('--' + key, String(body[key]));
                }
                // project-name 作为位置参数传递给 generate-unified.mjs 的 PPT 生成
                childArgs.push(projectName);

                const env = { ...process.env };
                if (body.apiKey) env.AI_PPT_API_KEY = body.apiKey;

                const childProcModule = await import('node:child_process');
                const rlModule = await import('node:readline');
                const child = childProcModule.spawn(
                    process.execPath, [path.join(ROOT, 'scripts', 'generate-unified.mjs'), ...childArgs], { cwd: ROOT, env }
                );

                // selection 上下文需要通过 stdin 传递选中文本
                if (context.kind === 'selection') {
                    const selText = typeof context.selection === 'string' ? context.selection : context.selection?.text;
                    child.stdin.write(selText);
                    child.stdin.end();
                }

                // 读取 stdout NDJSON，转发到 taskRegistry
                const rl = rlModule.createInterface({ input: child.stdout });
                const buffer = [];
                rl.on('line', (line) => {
                    if (!line.trim()) return;
                    let event;
                    try { event = JSON.parse(line); } catch { event = { type: 'log', message: line }; }
                    buffer.push(event);
                });

                child.stderr.on('data', (d) => {
                    const ev = { type: 'stderr', message: d.toString() };
                    buffer.push(ev);
                });

                child.on('close', (code) => {
                    if (code === 0 && !buffer.some((e) => e.type === 'done')) {
                        buffer.push({ type: 'done' });
                    } else if (code !== 0 && !buffer.some((e) => e.type === 'error')) {
                        buffer.push({ type: 'error', message: `进程退出码 ${code}` });
                    }
                    const last = buffer[buffer.length - 1];
                    if (last?.type === 'error') {
                        taskRegistry.fail(taskId, last.message || 'PPT 生成失败');
                    } else {
                        // 查找生成产物路径
                        const createdEv = buffer.find((e) => e.step === 'create' && e.message);
                        taskRegistry.complete(taskId, { events: buffer });
                    }
                });

                send(res, 202, { message: '生成已启动', name: projectName, taskId });
            }
        },
        // ---- 从选区/笔记生成图片（同步返回，检查资源库）----
        {
            method: 'POST', pattern: /^\/api\/media\/image-from-context$/, handler: async (req, res) => {
                const body = await readBody(req);
                const context = parseGenerationContext(body);
                if (!context) return send(res, 400, { error: '请提供有效的生成上下文' });

                try {
                    const mod = await import('../scripts/generate-unified.mjs');
                    const result = await mod.generateUnified(context, 'image', body);
                    send(res, 200, result);
                } catch (err) {
                    console.error('图片生成失败:', err.message);
                    send(res, 502, { error: err.message || '图片生成失败或后端不可用' });
                }
            }
        },
        // ---- 从选区/笔记生成视频（异步任务 + 轮询）----
        {
            method: 'POST', pattern: /^\/api\/media\/video-from-context$/, handler: async (req, res) => {
                const body = await readBody(req);
                const context = parseGenerationContext(body);
                if (!context) return send(res, 400, { error: '请提供有效的生成上下文' });

                // 校验 context 来源于笔记时，笔记必须存在
                if (context.kind === 'note') {
                    const api = await ensureVaultApi();
                    if (!api.readNote(context.noteName)) return send(res, 404, { error: `笔记不存在：${context.noteName}` });
                }

                // 构建 prompt 从上下文提取文本内容
                let prompt;
                try {
                    if (context.kind === 'note') {
                        const api = await ensureVaultApi();
                        const raw = api.readNote(context.noteName);
                        if (!raw) return send(res, 404, { error: `笔记不存在：${context.noteName}` });
                        const { content: bodyText } = api.parseFrontMatter(raw);
                        prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
                        if (!prompt) prompt = `以"${context.noteName}"为主题，讲述：${bodyText.trim().slice(0, 500)}`;
                    } else if (context.kind === 'selection') {
                        const sel = context.selection;
                        prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
                        if (!prompt) prompt = String(sel.text || '').trim().slice(0, 500);
                    } else {
                        // topic — 用专题内容概括
                        const api = await ensureVaultApi();
                        let content = '';
                        for (const n of api.listNotes()) {
                            if (n.topic === context.topicPath) {
                                const raw = api.readNote(n.name);
                                if (!raw) continue;
                                const { content: bodyText } = api.parseFrontMatter(raw);
                                content += `\n${bodyText.trim()}`;
                            }
                        }
                        prompt = `介绍主题：${context.topicPath}。${content.slice(0, 300)}`;
                    }
                } catch (err) {
                    return send(res, err.statusCode || 500, { error: err.message });
                }

                if (!prompt || !prompt.trim()) {
                    return send(res, 400, { error: '无法从上下文提取生成提示词' });
                }

                // 检查资源库是否有匹配视频（同步命中）
                const existing = findAsset('video', prompt);
                if (existing) {
                    return send(res, 200, {
                        filePath: existing.filePath,
                        webPath: `/api/vault/assets/${encodeURIComponent(path.basename(existing.filePath))}`,
                        reused: true,
                    });
                }

                // 未命中 — 异步生成任务，轮询走 GET /api/media/tasks/:id
                const cfg = readGlobalConfig().videoModelConfig || DEFAULT_MEDIA_MODEL_CONFIG;
                ensureResourceDir();
                let baseName = `video-${Date.now()}`;
                if (typeof body.name === 'string' && body.name.trim()) {
                    if (!isSafeNoteName(body.name.trim())) return send(res, 400, { error: '非法文件名称' });
                    baseName = body.name.trim().replace(/\.mp4$/i, '');
                }
                const outPath = path.join(ROOT, 'vault', 'assets', `${baseName}.mp4`);
                const taskId = `video-${randomUUID()}`;
                taskRegistry.create(taskId, { kind: 'media', status: 'pending' });

                (async () => {
                    const stillActive = () => isActiveStatus(taskRegistry.get(taskId)?.status);
                    try {
                        const result = await generateVideo(prompt, {
                            provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl,
                            apiKey: body.apiKey, outPath, onProgress: (msg) => {},
                        });
                        if (!stillActive()) return;
                        if (result && result.filePath) {
                            // 注册到资源库
                            registerAsset({
                                type: 'video', prompt, fileName: path.basename(result.filePath),
                                filePath: result.filePath, webPath: `/api/vault/assets/${encodeURIComponent(path.basename(result.filePath))}`,
                                tags: context.kind === 'topic' ? ['topic'] : (context.kind === 'note' ? ['note'] : ['selection']),
                            });
                            taskRegistry.complete(taskId, {
                                filePath: result.filePath,
                                webPath: `/api/vault/assets/${encodeURIComponent(path.basename(result.filePath))}`,
                                reused: false,
                            });
                        } else {
                            taskRegistry.fail(taskId, '视频生成失败或后端不可用');
                        }
                    } catch (err) {
                        if (!stillActive()) return;
                        taskRegistry.fail(taskId, err.message || '视频生成失败');
                    }
                })();

                send(res, 202, { taskId });
            }
        },
        // ---- 资源库管理（契约 P2）----
        // GET /api/media/resources?type=image|video — 列出注册的可复用媒体资产
        {
            method: 'GET', pattern: /^\/api\/media\/resources$/, handler: async (req, res) => {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const type = url.searchParams.get('type');
                try {
                    ensureResourceDir();
                    send(res, 200, { assets: listAssets(type) });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // DELETE /api/media/resources/:id — 删除注册条目（force=true 时同时删除物理文件）
        {
            method: 'DELETE', pattern: /^\/api\/media\/resources\/([^/]+)$/, handler: async (_req, res, matches) => {
                const id = matches[1];
                if (!validName(id, res, '非法资源 ID')) return;
                try {
                    ensureResourceDir();
                    const url = new URL(_req.url, `http://${_req.headers.host}`);
                    const force = url.searchParams.get('force') === 'true';
                    const ok = removeAsset(id, { deleteFile: force });
                    if (!ok) return send(res, 404, { error: '资源不存在' });
                    send(res, 204, {});
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // POST /api/media/resources/prune — 清理注册表中指向已删除文件的孤儿条目
        {
            method: 'POST', pattern: /^\/api\/media\/resources\/prune$/, handler: async (_req, res) => {
                try {
                    ensureResourceDir();
                    const removed = pruneOrphanedAssets();
                    send(res, 200, { removed });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
    ];
}
