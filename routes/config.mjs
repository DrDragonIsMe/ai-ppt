// routes/config.mjs — 全局配置（品牌名 / 模型 / 预设）相关路由
export default function configRoutes({ send, readBody, presentGlobalConfig, readGlobalConfig, writeGlobalConfig, PRESET_MODELS, listModels }) {
    return [
        {
            method: 'GET', pattern: /^\/api\/config$/, handler: async (_req, res) => {
                send(res, 200, presentGlobalConfig(readGlobalConfig()));
            }
        },
        {
            method: 'GET', pattern: /^\/manifest\.webmanifest$/, handler: async (_req, res) => {
                const cfg = readGlobalConfig();
                const brandName = String(cfg.appConfig?.brandName || '小龙哥@薪灵AI').trim() || '小龙哥@薪灵AI';
                send(res, 200, {
                    name: `${brandName} 知识中枢`,
                    short_name: brandName,
                    description: '笔记 → 幻灯片 → 复习 的本地知识工作台',
                    lang: 'zh-CN',
                    start_url: '/',
                    scope: '/',
                    display: 'standalone',
                    theme_color: '#0D9488',
                    background_color: '#0D9488',
                    icons: [
                        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
                        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
                    ],
                }, 'application/manifest+json; charset=utf-8');
            }
        },
        {
            method: 'POST', pattern: /^\/api\/config$/, handler: async (req, res) => {
                const body = await readBody(req);
                // 三组配置可任一/全部提交；persistApiKey === true 时 apiKey 允许落盘，否则一律剥离
                const persistApiKey = body.persistApiKey === true;
                const safe = {};
                if (body.appConfig && typeof body.appConfig === 'object') {
                    const brandName = String(body.appConfig.brandName || '').trim();
                    safe.appConfig = { brandName: brandName || '小龙哥@薪灵AI' };
                }
                if (body.agentConfig && typeof body.agentConfig === 'object') {
                    const assistantName = String(body.agentConfig.assistantName || '').trim() || '薪小灵';
                    const responseStyle = body.agentConfig.responseStyle === 'detailed' ? 'detailed' : 'concise';
                    safe.agentConfig = {
                        assistantName,
                        responseStyle,
                        allowSettingsMutation: body.agentConfig.allowSettingsMutation !== false,
                        allowKnowledgeMutation: body.agentConfig.allowKnowledgeMutation !== false,
                    };
                }
                if (body.sourcesConfig && typeof body.sourcesConfig === 'object') {
                    safe.sourcesConfig = {
                        allowExternalPaths: body.sourcesConfig.allowExternalPaths === true,
                    };
                }
                for (const key of ['modelConfig', 'imageModelConfig', 'videoModelConfig']) {
                    if (body[key] && typeof body[key] === 'object') {
                        if (persistApiKey) {
                            safe[key] = body[key];
                        } else {
                            const { apiKey: _apiKey, ...rest } = body[key];
                            safe[key] = rest;
                        }
                    }
                }
                // pdfConfig 是纯配置（无密钥），直接透传
                if (body.pdfConfig && typeof body.pdfConfig === 'object') {
                    safe.pdfConfig = body.pdfConfig;
                }
                if (persistApiKey) safe.persistApiKey = true;
                try {
                    writeGlobalConfig(safe);
                    send(res, 200, presentGlobalConfig(readGlobalConfig()));
                } catch (err) {
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/models$/, handler: async (_req, res) => {
                send(res, 200, PRESET_MODELS);
            }
        },
        {
            method: 'POST', pattern: /^\/api\/models\/list-remote$/, handler: async (req, res) => {
                const body = await readBody(req);
                try {
                    const models = await listModels({
                        baseUrl: body.baseUrl,
                        apiKey: body.apiKey,
                    });
                    send(res, 200, models);
                } catch (err) {
                    send(res, 200, []); // silently fail - just return empty list
                }
            }
        },
    ];
}
