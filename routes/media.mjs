// routes/media.mjs — 图片/视频生成与任务轮询路由
import path from 'node:path';
import { isActiveStatus, publicTask } from '../scripts/task-registry.mjs';

export default function mediaRoutes({ send, readBody, validName, readGlobalConfig, DEFAULT_MEDIA_MODEL_CONFIG, ensureDir, randomUUID, generateImage, generateVideo, probeMediaProvider, taskRegistry, ROOT, projectExists, getProjectDir }) {
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
                } catch {
                    result = null;
                }
                if (!result) return send(res, 502, { error: '生图失败或后端不可用' });
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
    ];
}
