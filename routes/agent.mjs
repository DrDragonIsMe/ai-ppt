import fs from 'node:fs';
import path from 'node:path';
import { listKnowledgeDocuments, searchKnowledge } from '../scripts/knowledge-base.mjs';
import { completeChat, getLastLlmError } from '../scripts/llm-adapter.mjs';

const DEFAULT_AGENT_CONFIG = {
    assistantName: '薪小灵',
    responseStyle: 'concise',
    allowSettingsMutation: true,
    allowKnowledgeMutation: true,
};

function normalizeAgentConfig(cfg) {
    return { ...DEFAULT_AGENT_CONFIG, ...(cfg?.agentConfig || {}) };
}

function splitTags(raw) {
    return String(raw || '')
        .replace(/标签/g, ' ')
        .split(/[、，,\s和]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 20);
}

function stripCodeFence(text) {
    const value = String(text || '').trim();
    const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : value;
}

function parseJsonBlock(text) {
    const clean = stripCodeFence(text);
    try {
        return JSON.parse(clean);
    } catch {
        const match = clean.match(/\{[\s\S]*\}$/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

function buildKnowledgeReply(hits, style = 'concise') {
    if (!hits.length) {
        return '我暂时没有在知识库里检索到直接相关的内容。你可以换个关键词，或者先上传资料后再问我。';
    }
    const lead = style === 'detailed'
        ? `我从知识库里找到了 ${hits.length} 条相关内容，先把最有用的结论整理给你：`
        : '我先根据知识库里最相关的几条内容回答你：';
    const lines = hits.slice(0, style === 'detailed' ? 4 : 3).map((item, index) => {
        const prefix = style === 'detailed' ? `${index + 1}.` : '•';
        return `${prefix} ${item.title}：${item.snippet || item.summary || '命中了相关内容'}`;
    });
    return [lead, ...lines].join('\n');
}

function exactDocumentByName(name) {
    const query = String(name || '').trim().toLowerCase();
    if (!query) return null;
    const docs = listKnowledgeDocuments({ limit: 400 });
    return docs.find((doc) => String(doc.title || '').toLowerCase() === query)
        || docs.find((doc) => String(doc.title || '').toLowerCase().includes(query));
}

function exactNoteByName(name) {
    const match = exactDocumentByName(name);
    if (!match || match.kind !== 'note') return null;
    return match.openTarget?.id || match.title || null;
}

function parseAgentAction(message) {
    const text = String(message || '').trim();
    if (!text) return null;

    let m = text.match(/(?:品牌名|项目名称|应用名称|名字).{0,12}(?:改成|改为|设为|换成|叫)\s*[「“"《]?([^」”"》]+)[」”"》]?$/);
    if (m) {
        return {
            type: 'set-brand-name',
            brandName: m[1].trim(),
            summary: `把项目品牌改成「${m[1].trim()}」`,
            requiresConfirm: true,
        };
    }

    m = text.match(/(?:把|将)?(?:薪小灵|助手|Agent).{0,10}(?:改名|命名为|名字改成|设为|叫)\s*[「“"《]?([^」”"》]+)[」”"》]?$/i);
    if (m) {
        return {
            type: 'set-assistant-name',
            assistantName: m[1].trim(),
            summary: `把助手名称改成「${m[1].trim()}」`,
            requiresConfirm: true,
        };
    }

    if (/(回答|回复|输出).*(简洁|简短|精炼)/.test(text)) {
        return {
            type: 'set-response-style',
            responseStyle: 'concise',
            summary: '把薪小灵的回答风格切到简洁模式',
            requiresConfirm: true,
        };
    }

    if (/(回答|回复|输出).*(详细|展开|完整)/.test(text)) {
        return {
            type: 'set-response-style',
            responseStyle: 'detailed',
            summary: '把薪小灵的回答风格切到详细模式',
            requiresConfirm: true,
        };
    }

    m = text.match(/(?:创建|新建|建立)(?:一个)?专题[：:\s]*([^\n]+)$/);
    if (m) {
        return {
            type: 'create-topic',
            topicPath: m[1].trim(),
            summary: `创建知识库专题「${m[1].trim()}」`,
            requiresConfirm: true,
        };
    }

    m = text.match(/给(?:笔记|知识库笔记)[《“"]?(.+?)[》”"]?(?:打上|添加|加上)?(.+?)标签/);
    if (m) {
        const tags = splitTags(m[2]);
        if (tags.length) {
            return {
                type: 'tag-note',
                noteName: m[1].trim(),
                tags,
                summary: `给笔记「${m[1].trim()}」添加标签：${tags.join('、')}`,
                requiresConfirm: true,
            };
        }
    }

    if (/(重建|刷新).*(知识库|索引)/.test(text)) {
        return {
            type: 'reindex-knowledge',
            summary: '重建知识库索引',
            requiresConfirm: true,
        };
    }

    m = text.match(/(?:允许|开启).*(薪小灵|助手).*(修改|管理).*(设置)/);
    if (m) {
        return {
            type: 'toggle-settings-mutation',
            allow: true,
            summary: '允许薪小灵通过自然语言修改系统设置',
            requiresConfirm: true,
        };
    }

    m = text.match(/(?:禁止|关闭).*(薪小灵|助手).*(修改|管理).*(设置)/);
    if (m) {
        return {
            type: 'toggle-settings-mutation',
            allow: false,
            summary: '关闭薪小灵通过自然语言修改系统设置的权限',
            requiresConfirm: true,
        };
    }

    return null;
}

function normalizeHistory(history) {
    const list = Array.isArray(history) ? history : [];
    return list
        .map((item) => ({
            role: item?.role === 'assistant' || item?.role === 'system' ? item.role : 'user',
            content: String(item?.content || item?.text || '').trim(),
        }))
        .filter((item) => item.content)
        .slice(-8);
}

function summarizeAgentTools(agentConfig) {
    const tools = [
        'searchKnowledge(query)',
        'listKnowledgeDocuments(query)',
        'downloadKnowledgeDocument(title)',
    ];
    if (agentConfig.allowKnowledgeMutation !== false) {
        tools.push('createTopic(topicPath)', 'tagNote(noteName, tags)', 'reindexKnowledge()');
    }
    if (agentConfig.allowSettingsMutation !== false) {
        tools.push('setBrandName(brandName)', 'setAssistantName(assistantName)', 'setResponseStyle(concise|detailed)');
    }
    return tools.join('、');
}

function buildAgentSystemPrompt({ agentConfig, globalConfig, hits, documents }) {
    const brandName = String(globalConfig.appConfig?.brandName || '小龙哥@薪灵AI').trim() || '小龙哥@薪灵AI';
    const assistantName = agentConfig.assistantName || '薪小灵';
    const hitLines = hits.length
        ? hits.map((item) => `- ${item.id} | ${item.kind} | ${item.title} | ${item.snippet || item.summary || ''}`).join('\n')
        : '- 无';
    const docLines = documents.length
        ? documents.slice(0, 12).map((item) => `- ${item.id} | ${item.kind} | ${item.title} | ${item.summary || ''}`).join('\n')
        : '- 无';
    return [
        `你是本地知识工作台里的智能助手「${assistantName}」。当前品牌名：${brandName}。`,
        `你的职责：1) 与用户对话并形成方案；2) 基于知识库回答；3) 当用户明确要求系统执行时，输出结构化 action 供系统确认执行。`,
        `回答语言必须是中文，语气专业、直接、友好。回答风格偏${agentConfig.responseStyle === 'detailed' ? '详细' : '简洁'}。`,
        `你可调用的系统能力只有这些：${summarizeAgentTools(agentConfig)}。`,
        '如果用户只是讨论方案、让你分析、比较、梳理步骤，不要生成 action；直接给方案即可。',
        '如果用户明确要求执行创建专题、给笔记打标签、改品牌名、改助手名、改回答风格、重建索引等动作，才生成 action。',
        '如果信息不够，不要瞎填 action 参数，应先提问澄清。',
        '如果引用知识库，请优先使用候选命中项的 id 作为 citationIds 返回。',
        '严格只返回 JSON，不要输出 Markdown 代码块，不要解释 JSON。',
        'JSON 格式：{"reply":"给用户的话","citationIds":["note:xxx"],"documents":["asset:yyy"],"action":null}',
        'action 可选格式示例：',
        '{"type":"create-topic","topicPath":"销售培训","summary":"创建知识库专题「销售培训」","requiresConfirm":true}',
        '{"type":"tag-note","noteName":"员工手册/差旅制度","tags":["制度","报销"],"summary":"给笔记「员工手册/差旅制度」添加标签：制度、报销","requiresConfirm":true}',
        '{"type":"set-brand-name","brandName":"薪小灵知识台","summary":"把项目品牌改成「薪小灵知识台」","requiresConfirm":true}',
        `候选知识命中：\n${hitLines}`,
        `候选文档：\n${docLines}`,
    ].join('\n');
}

function camelToKebab(str) {
    return String(str || '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function normalizeAgentAction(rawAction) {
    if (!rawAction || typeof rawAction !== 'object') return null;
    let type = String(rawAction.type || '').trim();
    if (!type) return null;
    // 兼容 camelCase（LLM 按工具名生成）与 kebab-case（示例格式）
    if (!type.includes('-') && /[A-Z]/.test(type)) type = camelToKebab(type);

    if (type === 'set-brand-name') {
        const brandName = String(rawAction.brandName || '').trim();
        if (!brandName) return null;
        return {
            type,
            brandName,
            summary: rawAction.summary || `把项目品牌改成「${brandName}」`,
            requiresConfirm: true,
        };
    }
    if (type === 'set-assistant-name') {
        const assistantName = String(rawAction.assistantName || '').trim();
        if (!assistantName) return null;
        return {
            type,
            assistantName,
            summary: rawAction.summary || `把助手名称改成「${assistantName}」`,
            requiresConfirm: true,
        };
    }
    if (type === 'set-response-style') {
        const responseStyle = rawAction.responseStyle === 'detailed' ? 'detailed' : 'concise';
        return {
            type,
            responseStyle,
            summary: rawAction.summary || `把薪小灵的回答风格切到${responseStyle === 'detailed' ? '详细' : '简洁'}模式`,
            requiresConfirm: true,
        };
    }
    if (type === 'create-topic') {
        const topicPath = String(rawAction.topicPath || '').trim();
        if (!topicPath) return null;
        return {
            type,
            topicPath,
            summary: rawAction.summary || `创建知识库专题「${topicPath}」`,
            requiresConfirm: true,
        };
    }
    if (type === 'tag-note') {
        const noteName = String(rawAction.noteName || '').trim();
        const tags = Array.isArray(rawAction.tags) ? rawAction.tags.map((item) => String(item).trim()).filter(Boolean).slice(0, 20) : [];
        if (!noteName || !tags.length) return null;
        return {
            type,
            noteName,
            tags,
            summary: rawAction.summary || `给笔记「${noteName}」添加标签：${tags.join('、')}`,
            requiresConfirm: true,
        };
    }
    if (type === 'reindex-knowledge') {
        return {
            type,
            summary: rawAction.summary || '重建知识库索引',
            requiresConfirm: true,
        };
    }
    if (type === 'toggle-settings-mutation') {
        const allow = rawAction.allow !== false;
        return {
            type,
            allow,
            summary: rawAction.summary || (allow ? '开启修改系统设置的权限' : '关闭修改系统设置的权限'),
            requiresConfirm: true,
        };
    }
    return null;
}

function pickKnowledgeArtifacts(ids, candidates) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map((item) => String(item)));
    return candidates.filter((item) => wanted.has(String(item.id)));
}

async function planWithLlm({ message, history, agentConfig, globalConfig }) {
    const hits = searchKnowledge(message, { limit: 6 });
    const documents = listKnowledgeDocuments({ query: message, limit: 10 });
    const messages = [
        { role: 'system', content: buildAgentSystemPrompt({ agentConfig, globalConfig, hits, documents }) },
        ...normalizeHistory(history),
        { role: 'user', content: message },
    ];
    const llmResult = await completeChat(messages, {
        provider: globalConfig.modelConfig?.provider,
        baseUrl: globalConfig.modelConfig?.baseUrl,
        model: globalConfig.modelConfig?.model,
        apiKey: globalConfig.modelConfig?.apiKey,
    });
    if (!llmResult?.content) return null;
    const parsed = parseJsonBlock(llmResult.content);
    if (!parsed || typeof parsed !== 'object') return null;

    const citationCandidates = pickKnowledgeArtifacts(parsed.citationIds, hits);
    const documentCandidates = pickKnowledgeArtifacts(parsed.documents, documents);
    return {
        reply: String(parsed.reply || '').trim(),
        citations: citationCandidates,
        documents: documentCandidates,
        pendingAction: normalizeAgentAction(parsed.action),
        provider: llmResult.provider,
        model: llmResult.model || globalConfig.modelConfig?.model || '',
    };
}

function isDocumentListIntent(message) {
    return /(列出|看看|查看|浏览).*(资料|文档|文件|知识库)/.test(message);
}

function isDownloadIntent(message) {
    return /下载.*(资料|文档|文件|笔记)?/.test(message);
}

function extractDownloadTarget(message) {
    const m = String(message || '').match(/下载(?:资料|文档|文件|笔记)?[《“"]?(.+?)[》”"]?$/);
    return m ? m[1].trim() : '';
}

function noteContentWithTags(api, noteName, tags) {
    const content = api.readNote(noteName);
    if (content === null) {
        const err = new Error('笔记不存在');
        err.statusCode = 404;
        throw err;
    }
    const { frontMatter, content: body } = api.parseFrontMatter(content);
    const existing = Array.isArray(frontMatter.tags)
        ? frontMatter.tags.map(String)
        : (frontMatter.tags ? [String(frontMatter.tags)] : []);
    const merged = [...existing];
    for (const tag of tags) {
        if (!merged.includes(tag)) merged.push(tag);
    }
    frontMatter.tags = merged;
    return api.stringifyFrontMatter(frontMatter) + body;
}

function sendAttachment(res, filePath, downloadName, contentType = 'application/octet-stream') {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': data.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    });
    res.end(data);
}

export default function agentRoutes(ctx) {
    const {
        send, readBody, validName, validNoteName, ROOT,
        ensureVaultApi, backupVaultNote,
        readGlobalConfig, writeGlobalConfig, buildSearchIndex,
    } = ctx;

    return [
        {
            method: 'GET', pattern: /^\/api\/knowledge\/documents$/, handler: async (req, res) => {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const query = url.searchParams.get('q') || '';
                const kind = url.searchParams.get('kind') || 'all';
                send(res, 200, { documents: listKnowledgeDocuments({ query, kind }) });
            }
        },
        {
            method: 'POST', pattern: /^\/api\/knowledge\/search$/, handler: async (req, res) => {
                const body = await readBody(req);
                const query = String(body.query || '').trim();
                if (!query) return send(res, 400, { error: '请提供检索内容' });
                send(res, 200, { results: searchKnowledge(query, { limit: body.limit || 8 }) });
            }
        },
        {
            method: 'GET', pattern: /^\/api\/knowledge\/documents\/(note|asset)\/(.+)\/download$/, handler: async (_req, res, matches) => {
                const kind = matches[1];
                const target = decodeURIComponent(matches[2]);
                if (kind === 'note') {
                    if (!validNoteName(target, res, '非法笔记名称')) return;
                    const api = await ensureVaultApi();
                    const content = api.readNote(target);
                    if (content === null) return send(res, 404, { error: '笔记不存在' });
                    res.writeHead(200, {
                        'Content-Type': 'text/markdown; charset=utf-8',
                        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target.replace(/\/+/g, '-')))}.md`,
                    });
                    res.end(content);
                    return;
                }
                if (!validName(target, res, '非法文件名')) return;
                const filePath = path.join(ROOT, 'vault', 'assets', target);
                if (!fs.existsSync(filePath)) return send(res, 404, { error: '文件不存在' });
                sendAttachment(res, filePath, target);
            }
        },
        {
            method: 'POST', pattern: /^\/api\/agent\/chat$/, handler: async (req, res) => {
                const body = await readBody(req);
                const message = String(body.message || '').trim();
                if (!message) return send(res, 400, { error: '请提供对话内容' });
                const globalConfig = readGlobalConfig();
                const agentConfig = normalizeAgentConfig(globalConfig);
                const history = normalizeHistory(body.history);

                if (/上传/.test(message)) {
                    return send(res, 200, {
                        assistantName: agentConfig.assistantName,
                        reply: '资料上传需要你把文件拖进面板，或者点「上传资料」。上传完成后，我就能继续帮你检索、整理和引用它们。',
                    });
                }

                try {
                    const llmPlan = await planWithLlm({ message, history, agentConfig, globalConfig });
                    if (llmPlan?.reply) {
                        if (llmPlan.pendingAction?.type === 'tag-note') {
                            const exactNoteName = exactNoteByName(llmPlan.pendingAction.noteName);
                            if (exactNoteName) llmPlan.pendingAction.noteName = exactNoteName;
                        }
                        let documents = llmPlan.documents || [];
                        let citations = llmPlan.citations || [];
                        if (isDocumentListIntent(message) && !documents.length) {
                            documents = listKnowledgeDocuments({ limit: 80 });
                        }
                        if (isDownloadIntent(message) && !documents.length) {
                            const target = extractDownloadTarget(message);
                            const doc = exactDocumentByName(target);
                            if (doc) {
                                documents = [doc];
                                citations = citations.length ? citations : [{
                                    kind: doc.kind,
                                    title: doc.title,
                                    snippet: doc.summary,
                                    sourceLabel: doc.kind === 'asset' ? '资料附件' : '知识库笔记',
                                    downloadUrl: doc.downloadUrl,
                                    openTarget: doc.openTarget,
                                }];
                            }
                        }
                        return send(res, 200, {
                            assistantName: agentConfig.assistantName,
                            reply: llmPlan.reply,
                            citations,
                            documents,
                            pendingAction: llmPlan.pendingAction || null,
                            meta: llmPlan.provider ? { provider: llmPlan.provider, model: llmPlan.model } : undefined,
                        });
                    }
                } catch (err) {
                    console.error('[agent] llm planning failed:', err.message || err);
                }

                if (isDocumentListIntent(message)) {
                    const documents = listKnowledgeDocuments({ limit: 80 });
                    return send(res, 200, {
                        assistantName: agentConfig.assistantName,
                        reply: documents.length
                            ? '我把当前知识库里的资料和知识项整理出来了，你可以直接下载、打开或继续让我筛选。'
                            : '当前知识库还是空的，先上传资料或创建笔记后我就能帮你管理了。',
                        documents,
                    });
                }

                if (isDownloadIntent(message)) {
                    const target = extractDownloadTarget(message);
                    const doc = exactDocumentByName(target);
                    if (doc) {
                        return send(res, 200, {
                            assistantName: agentConfig.assistantName,
                            reply: `我找到这份资料了，下面可以直接下载或打开：${doc.title}`,
                            documents: [doc],
                            citations: [{
                                kind: doc.kind,
                                title: doc.title,
                                snippet: doc.summary,
                                sourceLabel: doc.kind === 'asset' ? '资料附件' : '知识库笔记',
                                downloadUrl: doc.downloadUrl,
                                openTarget: doc.openTarget,
                            }],
                        });
                    }
                }

                const pendingAction = parseAgentAction(message);
                if (pendingAction) {
                    if (pendingAction.type === 'tag-note') {
                        const exactNoteName = exactNoteByName(pendingAction.noteName);
                        if (exactNoteName) pendingAction.noteName = exactNoteName;
                    }
                    return send(res, 200, {
                        assistantName: agentConfig.assistantName,
                        reply: `我理解你的意思是：${pendingAction.summary}。确认后我就执行。`,
                        pendingAction,
                    });
                }

                const hits = searchKnowledge(message, { limit: 6 });
                send(res, 200, {
                    assistantName: agentConfig.assistantName,
                    reply: getLastLlmError()
                        ? `${buildKnowledgeReply(hits, agentConfig.responseStyle)}\n\n补充说明：这次没有成功调用到 LLM，我先用本地检索结果给你回复。`
                        : buildKnowledgeReply(hits, agentConfig.responseStyle),
                    citations: hits,
                });
            }
        },
        {
            method: 'POST', pattern: /^\/api\/agent\/execute$/, handler: async (req, res) => {
                const body = await readBody(req);
                const action = body.action || {};
                const globalConfig = readGlobalConfig();
                const agentConfig = normalizeAgentConfig(globalConfig);
                const settingsMutation = new Set(['set-brand-name', 'set-response-style', 'set-assistant-name', 'toggle-settings-mutation']);
                const knowledgeMutation = new Set(['create-topic', 'tag-note', 'reindex-knowledge']);
                if (!action.type) return send(res, 400, { error: '缺少待执行动作' });
                if (settingsMutation.has(action.type) && agentConfig.allowSettingsMutation === false) {
                    return send(res, 403, { error: '当前已禁止薪小灵修改系统设置，请先在设置中开启权限。' });
                }
                if (knowledgeMutation.has(action.type) && agentConfig.allowKnowledgeMutation === false) {
                    return send(res, 403, { error: '当前已禁止薪小灵修改知识库，请先在设置中开启权限。' });
                }

                const api = await ensureVaultApi();
                if (action.type === 'set-brand-name') {
                    const brandName = String(action.brandName || '').trim();
                    if (!brandName) return send(res, 400, { error: '品牌名不能为空' });
                    writeGlobalConfig({ appConfig: { brandName } });
                    return send(res, 200, {
                        reply: `已把项目品牌更新为「${brandName}」。`,
                        operation: { title: '系统设置已更新', summary: `品牌名已改为 ${brandName}` },
                        refreshConfig: true,
                    });
                }
                if (action.type === 'set-assistant-name') {
                    const assistantName = String(action.assistantName || '').trim();
                    if (!assistantName) return send(res, 400, { error: '助手名称不能为空' });
                    writeGlobalConfig({ agentConfig: { assistantName } });
                    return send(res, 200, {
                        reply: `以后我会以「${assistantName}」的名字和你对话。`,
                        operation: { title: '系统设置已更新', summary: `助手名称已改为 ${assistantName}` },
                        refreshConfig: true,
                    });
                }
                if (action.type === 'set-response-style') {
                    const responseStyle = action.responseStyle === 'detailed' ? 'detailed' : 'concise';
                    writeGlobalConfig({ agentConfig: { responseStyle } });
                    return send(res, 200, {
                        reply: `好的，后续我会按${responseStyle === 'detailed' ? '详细' : '简洁'}模式回答。`,
                        operation: { title: '回答风格已更新', summary: `当前模式：${responseStyle === 'detailed' ? '详细' : '简洁'}` },
                        refreshConfig: true,
                    });
                }
                if (action.type === 'toggle-settings-mutation') {
                    writeGlobalConfig({ agentConfig: { allowSettingsMutation: action.allow !== false } });
                    return send(res, 200, {
                        reply: action.allow === false
                            ? '已关闭我修改系统设置的权限。'
                            : '已开启我修改系统设置的权限，后续仍然会在执行前向你确认。',
                        operation: { title: '权限已更新', summary: action.allow === false ? '已关闭设置修改权限' : '已开启设置修改权限' },
                        refreshConfig: true,
                    });
                }
                if (action.type === 'create-topic') {
                    const topicPath = String(action.topicPath || '').trim();
                    if (!validNoteName(topicPath, res, '非法专题路径')) return;
                    api.createTopic(topicPath);
                    api.rebuildIndex();
                    return send(res, 200, {
                        reply: `专题「${topicPath}」已经创建好了。`,
                        operation: { title: '知识库已更新', summary: `已创建专题 ${topicPath}` },
                        refreshKnowledge: true,
                    });
                }
                if (action.type === 'tag-note') {
                    const noteName = exactNoteByName(action.noteName) || String(action.noteName || '').trim();
                    const tags = Array.isArray(action.tags) ? action.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
                    if (!validNoteName(noteName, res, '非法笔记名称')) return;
                    if (!tags.length) return send(res, 400, { error: '请提供标签' });
                    backupVaultNote(api, noteName);
                    api.writeNote(noteName, noteContentWithTags(api, noteName, tags));
                    api.rebuildIndex();
                    return send(res, 200, {
                        reply: `已经给笔记「${noteName}」添加标签：${tags.join('、')}。`,
                        operation: { title: '知识库已更新', summary: `笔记 ${noteName} 已添加 ${tags.length} 个标签` },
                        refreshKnowledge: true,
                    });
                }
                if (action.type === 'reindex-knowledge') {
                    api.rebuildIndex();
                    buildSearchIndex();
                    return send(res, 200, {
                        reply: '知识库索引已经重建完成。',
                        operation: { title: '索引已重建', summary: '知识检索结果已刷新' },
                        refreshKnowledge: true,
                    });
                }
                send(res, 400, { error: '暂不支持这个动作' });
            }
        },
    ];
}
