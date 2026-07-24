// routes/vault-assets.mjs — 资产域路由（列表/上传/解析/parse-tasks/静态服务）
// 路由顺序敏感：本数组顺序即合并后的相对顺序，由 routes/vault.mjs 按拆分前总顺序拼接
import fs from 'node:fs';
import path from 'node:path';
import { parseAsset } from '../scripts/parse-asset.mjs';
import { isActiveStatus, publicTask } from '../scripts/task-registry.mjs';
import { MB, detectAssetKind, handleMultipartAssetUpload as handleMultipartAssetUploadWithDeps } from './vault-commons.mjs';

export default function vaultAssetsRoutes(ctx) {
    const {
        send, readBody, validName, sendFile, ROOT,
        ensureVaultApi,
        randomUUID, taskRegistry,
    } = ctx;

    // 共享上传实现注入本域依赖后保持原函数名，路由体与拆分前逐字一致
    const handleMultipartAssetUpload = (req, res, contentType) =>
        handleMultipartAssetUploadWithDeps({ send, validName, ensureVaultApi, ROOT }, req, res, contentType);

    return [
        // 资产列表
        {
            method: 'GET', pattern: /^\/api\/vault\/assets$/, handler: async (_req, res) => {
                const api = await ensureVaultApi();
                api.ensureVaultDirs();
                try {
                    const dir = path.join(ROOT, 'vault', 'assets');
                    const files = [];
                    if (fs.existsSync(dir)) {
                        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                            if (!entry.isFile()) continue;
                            const stat = fs.statSync(path.join(dir, entry.name));
                            files.push({ name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() });
                        }
                    }
                    files.sort((a, b) => b.mtime.localeCompare(a.mtime));
                    send(res, 200, { files });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // 资产上传（multipart 流式为主，base64 JSON 兼容回退；后缀 + 魔数双重校验，白名单见文件顶部 ASSET_TYPES）
        {
            method: 'POST', pattern: /^\/api\/vault\/assets$/, handler: async (req, res) => {
                const contentType = String(req.headers['content-type'] || '');
                if (contentType.toLowerCase().startsWith('multipart/form-data')) {
                    return handleMultipartAssetUpload(req, res, contentType);
                }
                // JSON base64 兼容回退（旧客户端/冒烟测试）：
                // 音视频上限 80MB，base64 膨胀约 4/3，body 统一放宽到 110MB 后按类型校验实际大小
                const body = await readBody(req, 110 * 1024 * 1024);
                const name = typeof body.name === 'string' ? body.name.trim() : '';
                if (!validName(name, res, '非法文件名')) return;
                if (typeof body.dataBase64 !== 'string' || !body.dataBase64) {
                    return send(res, 400, { error: '请提供文件内容（dataBase64）' });
                }
                const buf = Buffer.from(body.dataBase64, 'base64');
                const detected = detectAssetKind(name, buf);
                if (detected.error) return send(res, 400, { error: detected.error });
                if (buf.length > detected.maxBytes) {
                    return send(res, 400, { error: `文件超过 ${detected.kind} 类型大小上限（${Math.round(detected.maxBytes / MB)}MB）` });
                }
                const api = await ensureVaultApi();
                api.ensureVaultDirs();
                try {
                    const dir = path.join(ROOT, 'vault', 'assets');
                    let finalName = name;
                    // 重名自动改为 名-<base36时间戳>.扩展名
                    if (fs.existsSync(path.join(dir, finalName))) {
                        const ext = path.extname(name);
                        finalName = `${name.slice(0, name.length - ext.length)}-${Date.now().toString(36)}${ext}`;
                    }
                    fs.writeFileSync(path.join(dir, finalName), buf);
                    send(res, 201, { ok: true, name: finalName, webPath: `/api/vault/assets/${encodeURIComponent(finalName)}`, kind: detected.kind });
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // 资产内容解析（异步任务，202 + 轮询 parse-tasks；字面量段路由排在 assets/:file 通配之前）
        {
            method: 'POST', pattern: /^\/api\/vault\/assets\/([^/]+)\/parse$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法文件名')) return;
                if (!fs.existsSync(path.join(ROOT, 'vault', 'assets', name))) {
                    return send(res, 404, { error: '文件不存在' });
                }
                const body = await readBody(req);
                const taskId = `parse-${randomUUID()}`;
                taskRegistry.create(taskId, { kind: 'parse', status: 'running' });
                // 后台异步解析，结果写回任务状态（已取消/已中断则忽略迟到结果）
                (async () => {
                    const stillActive = () => isActiveStatus(taskRegistry.get(taskId)?.status);
                    try {
                        const result = await parseAsset(name, { apiKey: body.apiKey });
                        if (!stillActive()) return;
                        taskRegistry.complete(taskId, {
                            text: result.text,
                            degraded: result.degraded,
                            provider: result.provider,
                        });
                    } catch (err) {
                        if (!stillActive()) return;
                        taskRegistry.fail(taskId, err.message || '解析失败');
                    }
                })();
                send(res, 202, { taskId });
            }
        },
        {
            method: 'GET', pattern: /^\/api\/vault\/assets\/parse-tasks\/([^/]+)$/, handler: async (_req, res, matches) => {
                const id = matches[1];
                if (!validName(id, res, '非法任务 ID')) return;
                const task = taskRegistry.get(id);
                if (!task || task.kind !== 'parse') return send(res, 404, { status: 'unknown', error: '任务不存在或已过期' });
                send(res, 200, publicTask(task));
            }
        },
        // 取消解析任务：标记 cancelled 后忽略后续结果
        {
            method: 'POST', pattern: /^\/api\/vault\/assets\/parse-tasks\/([^/]+)\/cancel$/, handler: async (_req, res, matches) => {
                const id = matches[1];
                if (!validName(id, res, '非法任务 ID')) return;
                const task = taskRegistry.get(id);
                if (!task || task.kind !== 'parse') return send(res, 404, { status: 'unknown', error: '任务不存在或已过期' });
                taskRegistry.cancel(id);
                send(res, 200, { taskId: id, status: taskRegistry.get(id).status });
            }
        },
        // 媒体资产静态服务（契约 F）
        {
            method: 'GET', pattern: /^\/api\/vault\/assets\/([^/]+)$/, handler: async (_req, res, matches) => {
                const file = matches[1];
                if (!validName(file, res, '非法文件名')) return;
                const filePath = path.join(ROOT, 'vault', 'assets', file);
                if (!fs.existsSync(filePath)) return send(res, 404, { error: '文件不存在' });
                sendFile(res, filePath);
            }
        },
    ];
}
