// routes/vault-fragments.mjs — 碎片域路由（速记碎片 CRUD/reparse/promote/AI 整理）
// 路由顺序敏感：本数组顺序即合并后的相对顺序，由 routes/vault.mjs 按拆分前总顺序拼接
import fs from 'node:fs';
import { extractAttachmentNames } from '../scripts/fragments.mjs';
import { appendAttachmentTokens, startFragmentParseTasks as startFragmentParseTasksWithDeps } from './vault-commons.mjs';

export default function vaultFragmentsRoutes(ctx) {
    const {
        send, readBody, validName,
        ensureVaultApi,
        listFragments, getFragment, createFragment, updateFragment, deleteFragment,
        buildOrganizeSuggestions, applyOrganizeActions,
        saveCard, loadCard, saveMistake,
        randomUUID, taskRegistry,
    } = ctx;

    // 共享附件解析任务注入本域依赖后保持原函数名，路由体与拆分前逐字一致
    const startFragmentParseTasks = (fragmentId, attachments, opts) =>
        startFragmentParseTasksWithDeps({ taskRegistry, randomUUID, getFragment, updateFragment }, fragmentId, attachments, opts);

    return [
        // AI 整理（契约 G）
        {
            method: 'POST', pattern: /^\/api\/vault\/organize$/, handler: async (_req, res) => {
                try {
                    const result = await buildOrganizeSuggestions();
                    send(res, 200, { suggestions: result.suggestions || [], degraded: !!result.degraded });
                } catch (err) {
                    send(res, 500, { error: err.message });
                }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/vault\/organize\/apply$/, handler: async (req, res) => {
                try {
                    const body = await readBody(req);
                    if (!Array.isArray(body.actions)) {
                        return send(res, 400, { error: '请提供整理动作列表' });
                    }
                    send(res, 200, await applyOrganizeActions(body.actions));
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // Fragments（速记碎片）
        {
            method: 'POST', pattern: /^\/api\/vault\/fragments$/, handler: async (req, res) => {
                try {
                    const body = await readBody(req);
                    if (typeof body.content !== 'string' || !body.content.trim()) {
                        return send(res, 400, { error: '请提供碎片内容' });
                    }
                    // 附件：逐一校验名称后，以 ![[name]] token 追加进正文
                    const attachments = Array.isArray(body.attachments)
                        ? body.attachments.map((a) => String(a).trim()).filter(Boolean)
                        : [];
                    for (const a of attachments) {
                        if (!validName(a, res, '非法附件名')) return;
                    }
                    const fragment = createFragment({
                        content: appendAttachmentTokens(body.content, attachments),
                        tags: body.tags,
                    });
                    // parse: true 且有附件：后台顺序解析，结果追加回碎片并记录 parseTask 供前端轮询
                    const parseTaskIds = body.parse === true && attachments.length
                        ? startFragmentParseTasks(fragment.id, attachments, { apiKey: body.apiKey })
                        : [];
                    send(res, 201, { ...fragment, ...(parseTaskIds.length ? { parseTaskIds } : {}) });
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        // 重新解析碎片附件（解析失败/结果不满意时重跑，写回时替换旧解析块）
        {
            method: 'POST', pattern: /^\/api\/vault\/fragments\/([^/]+)\/reparse$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法碎片 ID')) return;
                    const fragment = getFragment(id);
                    if (!fragment) return send(res, 404, { error: '碎片不存在' });
                    const attachments = extractAttachmentNames(fragment.content);
                    if (!attachments.length) return send(res, 400, { error: '该碎片没有附件' });
                    const body = await readBody(req);
                    const parseTaskIds = startFragmentParseTasks(id, attachments, { apiKey: body.apiKey });
                    send(res, 202, { ok: true, count: attachments.length, parseTaskIds });
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/vault\/fragments$/, handler: async (req, res) => {
                try {
                    const url = new URL(req.url, `http://${req.headers.host}`);
                    const status = url.searchParams.get('status') || '';
                    const all = listFragments(status ? { status } : {});
                    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
                    const limit = Math.max(0, parseInt(url.searchParams.get('limit') || '0', 10) || 0);
                    // 不传分页参数时 items 即全量（前端零改动兼容）；total 恒为过滤后总数
                    const items = (limit > 0 || offset > 0)
                        ? (limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset))
                        : all;
                    send(res, 200, { fragments: items, total: all.length });
                } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        // 碎片转化为知识卡片 / 笔记 / 错题
        {
            method: 'POST', pattern: /^\/api\/vault\/fragments\/([^/]+)\/promote$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    const body = await readBody(req);
                    if (!['card', 'note', 'mistake'].includes(body.to)) {
                        return send(res, 400, { error: '非法转化目标' });
                    }
                    const fragment = getFragment(id);
                    if (!fragment) return send(res, 404, { error: '碎片不存在' });
                    const content = fragment.content || '';
                    const tags = fragment.tags || [];
                    const firstLine = (content.split('\n')[0] || '').trim();
                    const plainFirstLine = firstLine.replace(/#[\p{L}\p{N}_-]+/gu, '').replace(/\s{2,}/g, ' ').trim();
                    let target;
                    if (body.to === 'card') {
                        const cardId = `card-${Date.now()}`;
                        saveCard(cardId, {
                            title: plainFirstLine.slice(0, 30) || cardId,
                            question: plainFirstLine.slice(0, 80) || content.slice(0, 80),
                            answer: content, tags,
                        });
                        target = loadCard(cardId);
                    } else if (body.to === 'note') {
                        const api = await ensureVaultApi();
                        let base = plainFirstLine.slice(0, 30).replace(/[/\\]|[\x00-\x1f\x7f]/g, '').replace(/\.\./g, '').trim();
                        if (!base) base = `碎片-${id}`;
                        let name = base;
                        for (let n = 2; fs.existsSync(api.getNotePath(name)); n++) name = `${base}-${n}`;
                        const notePath = api.createNote(name, content);
                        api.rebuildIndex();
                        target = { name, path: notePath };
                    } else {
                        target = saveMistake(`mistake-${Date.now()}`, {
                            question: content, answer: '', tags, source: 'fragment',
                        });
                    }
                    updateFragment(id, { status: 'organized' });
                    send(res, 200, { ok: true, target });
                } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'PUT', pattern: /^\/api\/vault\/fragments\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    if (!getFragment(id)) return send(res, 404, { error: '碎片不存在' });
                    const body = await readBody(req);
                    send(res, 200, updateFragment(id, { content: body.content, tags: body.tags, status: body.status }));
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'DELETE', pattern: /^\/api\/vault\/fragments\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    if (!getFragment(id)) return send(res, 404, { error: '碎片不存在' });
                    deleteFragment(id);
                    send(res, 204, {});
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
    ];
}
