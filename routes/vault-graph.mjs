// routes/vault-graph.mjs — 星图/搜索/报告/多笔记生成入口域路由
// 路由顺序敏感：本数组顺序即合并后的相对顺序，由 routes/vault.mjs 按拆分前总顺序拼接
import fs from 'node:fs';
import path from 'node:path';
import { isActiveStatus } from '../scripts/task-registry.mjs';
import { condenseForVideo as condenseForVideoWithDeps } from './vault-commons.mjs';

export default function vaultGraphRoutes(ctx) {
    const {
        send, readBody, validName, ROOT,
        ensureVaultApi,
        hasActiveTask, spawnNdjsonTask,
        generators,
        buildGraph, readGraph,
        generateSlides,
        readGlobalConfig, DEFAULT_MEDIA_MODEL_CONFIG, ensureDir, randomUUID,
        generateVideo, taskRegistry,
    } = ctx;

    // 共享视频提示词浓缩注入本域依赖后保持原函数名，路由体与拆分前逐字一致
    const condenseForVideo = (source, apiKey) => condenseForVideoWithDeps({ generateSlides }, source, apiKey);

    return [
        // 多笔记 → PPT（202 + NDJSON 进度，复用 GET /api/projects/:name/generate/events）
        {
            method: 'POST', pattern: /^\/api\/vault\/notes\/generate-deck$/, handler: async (req, res) => {
                const body = await readBody(req);
                const notes = Array.isArray(body.notes)
                    ? body.notes.map((n) => String(n).trim()).filter(Boolean)
                    : [];
                if (notes.length === 0) return send(res, 400, { error: '请选择至少一篇笔记' });
                for (const n of notes) {
                    if (!validName(n, res, '非法笔记名称')) return;
                }
                const projectName = body.projectName;
                if (!validName(projectName, res, '非法项目名称')) return;
                if (hasActiveTask(generators, projectName)) {
                    return send(res, 409, { error: '该项目正在生成中' });
                }
                const params = body.params || {};
                const args = [projectName, notes.join(',')];
                if (params.slideCount) args.push('--slides', String(params.slideCount));
                if (params.audience) args.push('--audience', String(params.audience));
                if (params.style) args.push('--style', String(params.style));
                spawnNdjsonTask(generators, projectName, 'generate-from-notes.mjs', args, body.apiKey);
                send(res, 202, { message: '生成已启动', name: projectName });
            }
        },
        // 多笔记 → 视频（异步任务，轮询走 GET /api/media/tasks/:id）
        {
            method: 'POST', pattern: /^\/api\/vault\/notes\/generate-video$/, handler: async (req, res) => {
                const api = await ensureVaultApi();
                const body = await readBody(req);
                const notes = Array.isArray(body.notes)
                    ? body.notes.map((n) => String(n).trim()).filter(Boolean)
                    : [];
                if (notes.length === 0) return send(res, 400, { error: '请选择至少一篇笔记' });
                const texts = [];
                for (const n of notes) {
                    if (!validName(n, res, '非法笔记名称')) return;
                    const content = api.readNote(n);
                    if (content === null) return send(res, 404, { error: `笔记不存在：${n}` });
                    const { content: bodyText } = api.parseFrontMatter(content);
                    texts.push(`【${n}】\n${bodyText.trim()}`);
                }
                const source = texts.join('\n\n');
                let prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
                if (!prompt) prompt = await condenseForVideo(source, body.apiKey);
                const cfg = readGlobalConfig().videoModelConfig || DEFAULT_MEDIA_MODEL_CONFIG;
                const dir = path.join(ROOT, 'vault', 'assets');
                ensureDir(dir);
                let base = `video-${Date.now()}`;
                if (typeof body.name === 'string' && body.name.trim()) {
                    if (!validName(body.name.trim(), res, '非法文件名称')) return;
                    base = body.name.trim().replace(/\.mp4$/i, '');
                }
                const outPath = path.join(dir, `${base}.mp4`);
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
                                webPath: `/api/vault/assets/${encodeURIComponent(path.basename(result.filePath))}`,
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
        // 多笔记 → 结构化 Markdown 报告（同步，落盘 vault/reports/）
        {
            method: 'POST', pattern: /^\/api\/vault\/notes\/generate-report$/, handler: async (req, res) => {
                const api = await ensureVaultApi();
                const body = await readBody(req);
                const notes = Array.isArray(body.notes)
                    ? body.notes.map((n) => String(n).trim()).filter(Boolean)
                    : [];
                if (notes.length === 0) return send(res, 400, { error: '请选择至少一篇笔记' });
                try {
                    const result = await api.generateReport(notes, body.title, body.apiKey);
                    send(res, 200, result);
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // 报告列表
        {
            method: 'GET', pattern: /^\/api\/vault\/reports$/, handler: async (_req, res) => {
                const api = await ensureVaultApi();
                api.ensureVaultDirs();
                try {
                    const dir = path.join(ROOT, 'vault', 'reports');
                    const reports = [];
                    if (fs.existsSync(dir)) {
                        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                            if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
                            const stat = fs.statSync(path.join(dir, entry.name));
                            reports.push({ name: entry.name.replace(/\.md$/, ''), mtime: stat.mtime.toISOString() });
                        }
                    }
                    reports.sort((a, b) => b.mtime.localeCompare(a.mtime));
                    send(res, 200, { reports });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/vault\/search$/, handler: async (req, res) => {
                const api = await ensureVaultApi();
                const url = new URL(req.url, `http://${req.headers.host}`);
                const query = url.searchParams.get('q') || '';
                try {
                    const results = api.searchNotes(query);
                    send(res, 200, results);
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/vault\/index$/, handler: async (_req, res) => {
                const api = await ensureVaultApi();
                const index = api.rebuildIndex();
                send(res, 200, { notesCount: Object.keys(index.notes).length });
            }
        },
        // 星图选区 → PPT（契约 J）
        {
            method: 'POST', pattern: /^\/api\/vault\/graph\/generate-deck$/, handler: async (req, res) => {
                const body = await readBody(req);
                const nodes = Array.isArray(body.nodes)
                    ? body.nodes.map((n) => String(n).trim()).filter(Boolean)
                    : [];
                if (nodes.length === 0) {
                    return send(res, 400, { error: '请选择至少一个节点' });
                }
                const projectName = body.projectName;
                if (!validName(projectName, res, '非法项目名称')) return;
                if (hasActiveTask(generators, projectName)) {
                    return send(res, 409, { error: '该项目正在生成中' });
                }
                spawnNdjsonTask(generators, projectName, 'generate-from-graph.mjs', [projectName, nodes.join(',')], body.apiKey);
                send(res, 202, { message: '生成已启动', name: projectName });
            }
        },
        // Knowledge Graph
        {
            method: 'GET', pattern: /^\/api\/vault\/graph$/, handler: async (_req, res) => {
                try {
                    send(res, 200, readGraph());
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/vault\/graph$/, handler: async (_req, res) => {
                try {
                    const graph = buildGraph();
                    send(res, 200, { nodes: graph.nodes.length, edges: graph.edges.length });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
    ];
}
