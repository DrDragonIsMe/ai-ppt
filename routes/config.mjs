// routes/config.mjs — 模型配置与预设相关路由
export default function configRoutes({ send, readBody, presentGlobalConfig, readGlobalConfig, writeGlobalConfig, PRESET_MODELS, listModels }) {
    return [
        {
            method: 'GET', pattern: /^\/api\/config$/, handler: async (_req, res) => {
                send(res, 200, presentGlobalConfig(readGlobalConfig()));
            }
        },
        {
            method: 'POST', pattern: /^\/api\/config$/, handler: async (req, res) => {
                const body = await readBody(req);
                // 三组配置可任一/全部提交；persistApiKey === true 时 apiKey 允许落盘，否则一律剥离
                const persistApiKey = body.persistApiKey === true;
                const safe = {};
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
