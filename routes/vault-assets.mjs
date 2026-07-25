// routes/vault-assets.mjs — 资产域路由（列表/上传/解析/parse-tasks/删除/静态服务）
// 路由顺序敏感：本数组顺序即合并后的相对顺序，由 routes/vault.mjs 按拆分前总顺序拼接
import fs from 'node:fs';
import path from 'node:path';
import { parseAsset } from '../scripts/parse-asset.mjs';
import { isActiveStatus, publicTask } from '../scripts/task-registry.mjs';
import { findAssetReferences } from '../scripts/asset-refs.mjs';
import { MB, detectAssetKind, handleMultipartAssetUpload as handleMultipartAssetUploadWithDeps } from './vault-commons.mjs';

export default function vaultAssetsRoutes(ctx) {
    const {
        send, readBody, validName, sendFile, ROOT,
        ensureVaultApi, listFragments,
        randomUUID, taskRegistry,
    } = ctx;

    // 共享上传实现注入本域依赖后保持原函数名，路由体与拆分前逐字一致
    const handleMultipartAssetUpload = (req, res, contentType) =>
        handleMultipartAssetUploadWithDeps({ send, validName, ensureVaultApi, ROOT }, req, res, contentType);

    // 扫描笔记与碎片正文中的 ![[name]] 引用；单域读取失败按无引用降级，不阻断主流程
    async function scanAssetReferences(name) {
        const refs = { notes: [], fragments: [] };
        try {
            const api = await ensureVaultApi();
            const notes = api.listNotes().map((n) => ({ name: n.name, content: api.readNote(n.name) }));
            refs.notes = findAssetReferences(name, { notes }).notes;
        } catch { /* 笔记读取失败时不阻断 */ }
        try {
            const fragments = listFragments().map((f) => ({ id: f.id, content: f.content }));
            refs.fragments = findAssetReferences(name, { fragments }).fragments;
        } catch { /* 碎片读取失败时不阻断 */ }
        return refs;
    }

    return [
        // 资产列表（?refs=1 时附带 referenced 引用状态，供资产库 UI 展示）
        {
            method: 'GET', pattern: /^\/api\/vault\/assets$/, handler: async (req, res) => {
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
                    const withRefs = new URL(req.url, `http://${req.headers.host}`).searchParams.get('refs') === '1';
                    if (withRefs) {
                        let notes = [];
                        try { notes = api.listNotes().map((n) => ({ name: n.name, content: api.readNote(n.name) })); } catch { /* 降级 */ }
                        let fragments = [];
                        try { fragments = listFragments().map((f) => ({ id: f.id, content: f.content })); } catch { /* 降级 */ }
                        for (const f of files) {
                            const refs = findAssetReferences(f.name, { notes, fragments });
                            f.referenced = refs.notes.length + refs.fragments.length > 0;
                        }
                    }
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
        // 资产删除：被笔记/碎片正文 ![[name]] 引用时默认 409 拒绝（返回引用方列表），?force=true 强制删除
        {
            method: 'DELETE', pattern: /^\/api\/vault\/assets\/([^/]+)$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法文件名')) return;
                const filePath = path.join(ROOT, 'vault', 'assets', name);
                if (!fs.existsSync(filePath)) return send(res, 404, { error: '文件不存在' });
                const force = new URL(req.url, `http://${req.headers.host}`).searchParams.get('force') === 'true';
                if (!force) {
                    const refs = await scanAssetReferences(name);
                    if (refs.notes.length || refs.fragments.length) {
                        return send(res, 409, { error: '资产仍被引用，确认后可强制删除', references: refs });
                    }
                }
                fs.unlinkSync(filePath);
                send(res, 204, {});
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
