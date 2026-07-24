// routes/vault-learn.mjs — 学习域路由（复习 PPT/知识卡片/AI 扩展/测验/错题）
// 路由顺序敏感：本数组顺序即合并后的相对顺序，由 routes/vault.mjs 按拆分前总顺序拼接
export default function vaultLearnRoutes(ctx) {
    const {
        send, readBody, validName,
        hasActiveTask, spawnNdjsonTask,
        generators,
        getCards, loadCard, saveCard, deleteCard, recordReview, getDueCards,
        getExamPapers, getExamPaper, saveExamPaper, deleteExamPaper, getExamStats,
        getMistakes, getMistake, saveMistake, deleteMistake, recordMistakeReview,
        getMistakeStats, addMistakeFromExam, buildSmartExam,
        generateSlides,
    } = ctx;

    return [
        // 复习内容 → PPT（契约 A）
        {
            method: 'POST', pattern: /^\/api\/vault\/review-deck$/, handler: async (req, res) => {
                const body = await readBody(req);
                const type = body.type;
                if (type !== 'cards' && type !== 'mistakes') {
                    return send(res, 400, { error: "type 必须是 'cards' 或 'mistakes'" });
                }
                const projectName = body.projectName;
                if (!validName(projectName, res, '非法项目名称')) return;
                if (hasActiveTask(generators, projectName)) {
                    return send(res, 409, { error: '该项目正在生成中' });
                }
                spawnNdjsonTask(generators, projectName, 'generate-from-review.mjs', [type, projectName], body.apiKey);
                send(res, 202, { message: '生成已启动', name: projectName });
            }
        },
        // Knowledge Cards
        {
            method: 'GET', pattern: /^\/api\/vault\/cards$/, handler: async (_req, res) => {
                try { send(res, 200, getCards()); } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/vault\/cards\/due$/, handler: async (_req, res) => {
                try { send(res, 200, getDueCards()); } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/vault\/cards\/([^/]+)$/, handler: async (_req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    const card = loadCard(id);
                    if (!card) return send(res, 404, { error: '卡片不存在' });
                    send(res, 200, card);
                } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/vault\/cards$/, handler: async (req, res) => {
                try {
                    const body = await readBody(req);
                    const id = body.id || `card-${Date.now()}`;
                    if (!validName(id, res, '非法 ID')) return;
                    saveCard(id, body);
                    send(res, 201, { id });
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'PUT', pattern: /^\/api\/vault\/cards\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    const body = await readBody(req);
                    saveCard(id, body);
                    send(res, 200, { id });
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'DELETE', pattern: /^\/api\/vault\/cards\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    deleteCard(id);
                    send(res, 204, {});
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/vault\/cards\/([^/]+)\/review$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    const body = await readBody(req);
                    send(res, 200, recordReview(id, body.rating));
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        // AI knowledge expansion
        {
            method: 'POST', pattern: /^\/api\/vault\/expand$/, handler: async (req, res) => {
                try {
                    const body = await readBody(req);
                    const { text, type, config } = body;
                    if (!text) return send(res, 400, { error: '请提供要扩展的内容' });
                    let prompt = '';
                    if (type === 'card') {
                        prompt = `基于以下内容生成 3 个知识卡片。只返回 JSON 数组，不要任何其他说明：\n[{"title":"卡片标题","question":"问题","answer":"答案","explanation":"解析","tags":["标签1","标签2"],"subject":"内容分类"}]\n\n内容：${text}`;
                    } else if (type === 'note') {
                        prompt = `基于以下笔记做知识扩展，用结构化 Markdown 返回，包含：相关背景知识、关键点、复习或应用建议、几个思考问题。\n\n笔记内容：${text}`;
                    } else {
                        prompt = `扩展以下内容，使其更丰富和系统化，用结构化格式返回：\n\n${text}`;
                    }
                    const options = {
                        apiKey: config?.apiKey, baseUrl: config?.baseUrl,
                        model: config?.model, provider: config?.provider,
                    };
                    const result = await generateSlides(prompt, options);
                    if (!result) return send(res, 500, { error: 'AI生成失败，请检查模型配置' });
                    send(res, 200, { result: result.content });
                } catch (err) {
                    console.error('AI expand error:', err);
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        // Exam Papers
        {
            method: 'GET', pattern: /^\/api\/exams$/, handler: async (req, res) => {
                try { send(res, 200, getExamPapers()); } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/exams\/stats$/, handler: async (req, res) => {
                try { send(res, 200, getExamStats()); } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/exams\/smart-generate$/, handler: async (req, res) => {
                try {
                    const body = await readBody(req);
                    const rawCount = Number(body.count);
                    const count = Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 20 ? rawCount : 5;
                    const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 100) : undefined;
                    const { exam, meta } = await buildSmartExam({ count, subject });
                    send(res, 201, { exam, meta });
                } catch (err) {
                    if (err && typeof err.message === 'string' && err.message.includes('没有足够的可组卷内容')) {
                        return send(res, 400, { error: err.message });
                    }
                    console.error('smart-generate error:', err);
                    send(res, err.statusCode || 500, { error: err.message });
                }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/exams\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    const paper = getExamPaper(id);
                    if (!paper) return send(res, 404, { error: '试卷不存在' });
                    send(res, 200, paper);
                } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/exams$/, handler: async (req, res) => {
                try {
                    const body = await readBody(req);
                    const id = body.id || `exam-${Date.now()}`;
                    if (!validName(id, res, '非法 ID')) return;
                    send(res, 201, saveExamPaper(id, body));
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'PUT', pattern: /^\/api\/exams\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    const body = await readBody(req);
                    send(res, 200, saveExamPaper(id, body));
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'DELETE', pattern: /^\/api\/exams\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    deleteExamPaper(id);
                    send(res, 204, {});
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        // Mistakes
        {
            method: 'GET', pattern: /^\/api\/mistakes$/, handler: async (req, res) => {
                try {
                    const url = new URL(req.url, `http://${req.headers.host}`);
                    const filters = {
                        subject: url.searchParams.get('subject') || '',
                        masteryRange: url.searchParams.get('masteryRange') || '',
                    };
                    send(res, 200, getMistakes(filters));
                } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/mistakes\/stats$/, handler: async (req, res) => {
                try { send(res, 200, getMistakeStats()); } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/mistakes\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    const mistake = getMistake(id);
                    if (!mistake) return send(res, 404, { error: '错题不存在' });
                    send(res, 200, mistake);
                } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/mistakes$/, handler: async (req, res) => {
                try {
                    const body = await readBody(req);
                    const id = body.id || `mistake-${Date.now()}`;
                    if (!validName(id, res, '非法 ID')) return;
                    send(res, 201, saveMistake(id, body));
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/mistakes\/from-exam$/, handler: async (req, res) => {
                try {
                    const body = await readBody(req);
                    send(res, 201, addMistakeFromExam(body.examId, body.questionIndex));
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'PUT', pattern: /^\/api\/mistakes\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    const body = await readBody(req);
                    send(res, 200, saveMistake(id, body));
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'DELETE', pattern: /^\/api\/mistakes\/([^/]+)$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    deleteMistake(id);
                    send(res, 204, {});
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/mistakes\/([^/]+)\/review$/, handler: async (req, res, matches) => {
                try {
                    const id = matches[1];
                    if (!validName(id, res, '非法 ID')) return;
                    const body = await readBody(req);
                    const result = recordMistakeReview(id, body.mastery);
                    if (!result) return send(res, 404, { error: '错题不存在' });
                    send(res, 200, result);
                } catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
    ];
}
