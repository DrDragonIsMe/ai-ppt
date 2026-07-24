// routes/projects.mjs — 项目管理路由（CRUD/配置/快照/对话/生成/导出/组件/主题/发布）
import fs from 'node:fs';
import path from 'node:path';

export default function projectRoutes(ctx) {
    const {
        send, readBody, validName, ROOT, PROJECTS_DIR, PUBLISHED_DIR,
        listProjects, createProject, deleteProject,
        readConfig, writeConfig, getProjectDir, projectExists,
        applyThemeAndAnimation,
        generators, chats, spawnGenerator, spawnNdjsonTask,
        hasActiveTask, serveSse, exportTasks,
        readChatHistory, appendChatHistory,
        exportSingleHtml,
        loadHtml, injectThemeOverrides,
        saveEditedHtml, search, invalidateSearchIndex,
        createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot,
    } = ctx;

    // 导出任务（NDJSON + SSE，模式同 generate/chat）：
    // store 键 `${name}:${type}`，同项目同类型重复 POST → 409；
    // puppeteer 类导出（pdf / pptx-image）全局最多 2 个并发，超出 → 429。
    const EXPORT_TASK_DEFS = {
        pptx: { script: 'export-pptx.mjs', args: [] },
        'pptx-image': { script: 'export-pptx.mjs', args: ['--image'] },
        pdf: { script: 'export-pdf.mjs', args: [] },
    };
    const PUPPETEER_EXPORT_TYPES = new Set(['pptx-image', 'pdf']);
    const MAX_PUPPETEER_EXPORTS = 2;

    function exportTaskKey(name, type) { return `${name}:${type}`; }

    function activePuppeteerExportCount() {
        let count = 0;
        for (const state of exportTasks.values()) {
            if (!state.done && PUPPETEER_EXPORT_TYPES.has(state.exportType)) count++;
        }
        return count;
    }

    // Insert a component slide before the last slide.
    function insertComponent(name, componentHtml) {
        const htmlPath = path.join(getProjectDir(name), 'index.html');
        if (!fs.existsSync(htmlPath)) throw new Error('项目尚未生成幻灯片');
        const $ = loadHtml(fs.readFileSync(htmlPath, 'utf8'));
        const slides = $('main.stage section.slide');
        if (slides.length === 0) throw new Error('未找到幻灯片结构');
        let section = componentHtml;
        if (!/class="[^"]*slide/.test(section)) {
            section = `<section class="slide">${section}</section>`;
        }
        if (slides.length > 1) {
            $(slides[slides.length - 1]).before('\n' + section + '\n');
        } else {
            $('main.stage').append('\n' + section + '\n');
        }
        $('main.stage section.slide').removeClass('active');
        $('main.stage section.slide').first().addClass('active');
        fs.writeFileSync(htmlPath, $.html(), 'utf8');
    }

    // Inject/replace a <style id="theme-overrides"> block.
    function applyThemeOverrides(name, overrides) {
        const htmlPath = path.join(getProjectDir(name), 'index.html');
        if (!fs.existsSync(htmlPath)) throw new Error('项目尚未生成幻灯片');
        let html = fs.readFileSync(htmlPath, 'utf8');
        html = injectThemeOverrides(html, overrides);
        fs.writeFileSync(htmlPath, html, 'utf8');
        const cfg = readConfig(name);
        cfg.themeOverrides = overrides;
        writeConfig(name, cfg);
    }

    // Publish helpers
    function ensureDir(dir) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    function copyDirSync(src, dst) {
        ensureDir(dst);
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const srcPath = path.join(src, entry.name);
            const dstPath = path.join(dst, entry.name);
            if (entry.isDirectory()) copyDirSync(srcPath, dstPath);
            else fs.copyFileSync(srcPath, dstPath);
        }
    }

    function getPublishHistory(name) {
        const projectPublishDir = path.join(PUBLISHED_DIR, name);
        if (!fs.existsSync(projectPublishDir)) return [];
        const versions = [];
        for (const entry of fs.readdirSync(projectPublishDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === 'latest') continue;
            const metaPath = path.join(projectPublishDir, entry.name, 'meta.json');
            if (fs.existsSync(metaPath)) {
                try { versions.push(JSON.parse(fs.readFileSync(metaPath, 'utf8'))); } catch { /* skip */ }
            }
        }
        versions.sort((a, b) => {
            const va = parseInt(a.version.replace('v', ''), 10);
            const vb = parseInt(b.version.replace('v', ''), 10);
            return vb - va;
        });
        return versions;
    }

    function listPublishedProjects() {
        if (!fs.existsSync(PUBLISHED_DIR)) return [];
        const projects = [];
        for (const entry of fs.readdirSync(PUBLISHED_DIR, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const history = getPublishHistory(entry.name);
            projects.push({ name: entry.name, latest: history[0] || null, versions: history.length });
        }
        return projects;
    }

    async function publishProject(name) {
        const cfg = readConfig(name);
        const projectDir = getProjectDir(name);
        if (!fs.existsSync(path.join(projectDir, 'index.html'))) {
            throw new Error('项目尚未生成幻灯片，请先生成再发布');
        }
        ensureDir(PUBLISHED_DIR);
        const projectPublishDir = path.join(PUBLISHED_DIR, name);
        ensureDir(projectPublishDir);
        const history = getPublishHistory(name);
        const nextVersionNum = history.length > 0
            ? parseInt(history[0].version.replace('v', ''), 10) + 1 : 1;
        const version = `v${nextVersionNum}`;
        const versionDir = path.join(projectPublishDir, version);
        const latestDir = path.join(projectPublishDir, 'latest');
        copyDirSync(projectDir, versionDir);
        const meta = {
            version,
            publishedAt: new Date().toISOString(),
            theme: cfg.theme || 'web-ui',
            animation: cfg.animation || 'slide',
            url: `/published/${name}/${version}/index.html`,
        };
        fs.writeFileSync(path.join(versionDir, 'meta.json'), JSON.stringify(meta, null, 2));
        if (fs.existsSync(latestDir)) {
            if (fs.lstatSync(latestDir).isSymbolicLink()) fs.unlinkSync(latestDir);
            else fs.rmSync(latestDir, { recursive: true, force: true });
        }
        try { fs.symlinkSync(version, latestDir, 'dir'); }
        catch { copyDirSync(versionDir, latestDir); }
        fs.writeFileSync(path.join(latestDir, 'meta.json'), JSON.stringify({
            ...meta, version: 'latest', url: `/published/${name}/latest/index.html`,
        }, null, 2));
        return meta;
    }

    return [
        {
            method: 'GET', pattern: /^\/api\/projects$/, handler: async (_req, res) => {
                send(res, 200, listProjects());
            }
        },
        {
            method: 'GET', pattern: /^\/api\/search$/, handler: async (req, res) => {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const query = url.searchParams.get('q') || '';
                try { send(res, 200, search(query)); }
                catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/projects$/, handler: async (req, res) => {
                const body = await readBody(req);
                try { send(res, 201, createProject(body.name, body.title)); invalidateSearchIndex(body.name); }
                catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)$/, handler: async (req, res, matches) => {
                if (!validName(matches[1], res, '非法项目名称')) return;
                try { deleteProject(matches[1]); invalidateSearchIndex(matches[1]); send(res, 204, {}); }
                catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        // 合并项目加载接口（P2）：一次返回 config + snapshots + publish + chat history
        {
            method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/full$/, handler: async (_req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                const result = { config: readConfig(name) };
                try { result.snapshots = listSnapshots(name); } catch { result.snapshots = []; }
                try { result.publishHistory = getPublishHistory(name); } catch { result.publishHistory = []; }
                try { result.chatHistory = readChatHistory(name); } catch { result.chatHistory = []; }
                send(res, 200, result);
            }
        },
        {
            method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/config$/, handler: async (_req, res, matches) => {
                if (!validName(matches[1], res, '非法项目名称')) return;
                if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
                send(res, 200, readConfig(matches[1]));
            }
        },
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/config$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                const body = await readBody(req);
                const cfg = readConfig(name);
                if (body.sourceType !== undefined) cfg.sourceType = body.sourceType;
                if (body.sourceUrl !== undefined) cfg.sourceUrl = body.sourceUrl;
                if (body.articleText !== undefined) cfg.articleText = body.articleText;
                if (body.params) cfg.params = { ...cfg.params, ...body.params };
                if (body.modelConfig) cfg.modelConfig = { ...cfg.modelConfig, ...body.modelConfig };
                if (body.theme !== undefined) cfg.theme = body.theme;
                if (body.animation !== undefined) cfg.animation = body.animation;
                if (body.sourceSelection !== undefined) cfg.sourceSelection = body.sourceSelection;
                writeConfig(name, cfg);
                try { applyThemeAndAnimation(name, cfg.theme || 'web-ui', cfg.animation || 'slide'); }
                catch (err) { console.error('Failed to apply theme/animation:', err); }
                send(res, 200, readConfig(name));
            }
        },
        // Snapshots
        {
            method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/snapshots$/, handler: async (_req, res, matches) => {
                if (!validName(matches[1], res, '非法项目名称')) return;
                if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
                send(res, 200, listSnapshots(matches[1]));
            }
        },
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/snapshots$/, handler: async (req, res, matches) => {
                if (!validName(matches[1], res, '非法项目名称')) return;
                if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
                const body = await readBody(req);
                try { send(res, 201, createSnapshot(matches[1], body.description || '')); }
                catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/snapshots\/([^/]+)\/restore$/, handler: async (_req, res, matches) => {
                if (!validName(matches[1], res, '非法项目名称')) return;
                if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
                try { restoreSnapshot(matches[1], matches[2]); send(res, 200, { restored: matches[2] }); }
                catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        {
            method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)\/snapshots\/([^/]+)$/, handler: async (_req, res, matches) => {
                if (!validName(matches[1], res, '非法项目名称')) return;
                if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
                try { deleteSnapshot(matches[1], matches[2]); send(res, 204, {}); }
                catch (err) { send(res, err.statusCode || 400, { error: err.message }); }
            }
        },
        // AI 修改（契约 B）
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/chat$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                const body = await readBody(req);
                const instruction = (body.instruction || '').trim();
                if (!instruction) return send(res, 400, { error: '请提供修改指令' });
                if (hasActiveTask(chats, name)) return send(res, 409, { error: '该项目正在修改中' });
                const state = spawnNdjsonTask(chats, name, 'chat-modify.mjs', [name, instruction], body.apiKey);
                appendChatHistory(name, 'user', instruction);
                let historyRecorded = false;
                state.listeners.add((event) => {
                    if (event.type === 'done' || event.type === 'error') {
                        // 修改完成后重建该项目搜索索引
                        invalidateSearchIndex(name);
                    }
                    if (historyRecorded) return;
                    if (event.type === 'done' || event.type === 'error') {
                        historyRecorded = true;
                        const content = event.type === 'done'
                            ? (event.summary || '修改完成') + (event.details ? '\n\n' + event.details : '')
                            : (event.message || '修改失败');
                        appendChatHistory(name, 'assistant', content);
                    }
                });
                send(res, 202, { message: '修改已启动', name });
            }
        },
        {
            method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/chat\/events$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                const state = chats.get(name);
                if (!state) return send(res, 404, { error: '没有进行中的修改' });
                serveSse(res, state);
            }
        },
        // PPT chat 历史（契约 P）
        {
            method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/chat\/history$/, handler: async (_req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                send(res, 200, { messages: readChatHistory(name) });
            }
        },
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/save-edits$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                const body = await readBody(req);
                const html = (body.html || '').trim();
                if (!html) return send(res, 400, { error: '请提供编辑后的 HTML' });
                try {
                    const result = saveEditedHtml(name, html);
                    // 保存可视化编辑后重建该项目搜索索引
                    invalidateSearchIndex(name);
                    send(res, 200, result);
                }
                catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        // Generate
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/generate$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                const body = await readBody(req);
                if (hasActiveTask(generators, name)) return send(res, 409, { error: '该项目正在生成中' });
                spawnGenerator(name, body.apiKey);
                // 生成完成后刷新搜索索引
                const genState = generators.get(name);
                if (genState) {
                    const origListener = (event) => {
                        if (event.type === 'done' || event.type === 'error') {
                            invalidateSearchIndex(name);
                        }
                    };
                    genState.listeners.add(origListener);
                    // 如果已经完成了（回放 buffer）
                    if (genState.done) invalidateSearchIndex(name);
                }
                send(res, 202, { message: '生成已启动', name });
            }
        },
        {
            method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/generate\/events$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                const state = generators.get(name);
                if (state) return serveSse(res, state);
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                send(res, 404, { error: '没有进行中的生成' });
            }
        },
        // Export（异步任务：POST 202 → GET .../events SSE → done 事件带 downloadUrl）
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/export\/(pptx|pptx-image|pdf)$/, handler: async (req, res, matches) => {
                const name = matches[1];
                const type = matches[2];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                const key = exportTaskKey(name, type);
                if (hasActiveTask(exportTasks, key)) return send(res, 409, { error: '该导出任务正在进行中，请等待完成' });
                if (PUPPETEER_EXPORT_TYPES.has(type) && activePuppeteerExportCount() >= MAX_PUPPETEER_EXPORTS) {
                    return send(res, 429, { error: '同时进行的浏览器导出任务过多，请稍后重试' });
                }
                const def = EXPORT_TASK_DEFS[type];
                const state = spawnNdjsonTask(exportTasks, key, def.script, [...def.args, name]);
                state.exportType = type;
                send(res, 202, { message: '导出已启动', name, type });
            }
        },
        {
            method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/export\/(pptx|pptx-image|pdf)\/events$/, handler: async (req, res, matches) => {
                const name = matches[1];
                const type = matches[2];
                if (!validName(name, res, '非法项目名称')) return;
                const state = exportTasks.get(exportTaskKey(name, type));
                if (state) return serveSse(res, state);
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                send(res, 404, { error: '没有进行中的导出任务' });
            }
        },
        // 单文件 HTML 导出很快，保持同步返回
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/export\/html$/, handler: async (_req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                try {
                    const file = await exportSingleHtml(name);
                    const rel = path.relative(ROOT, file);
                    send(res, 200, { file: rel, downloadUrl: '/' + rel.replace(/\\/g, '/') });
                } catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        // Component & Theme Overrides
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/component$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                const body = await readBody(req);
                const componentHtml = (body.html || '').trim();
                if (!componentHtml) return send(res, 400, { error: '请提供组件 HTML' });
                try { insertComponent(name, componentHtml); send(res, 200, { ok: true }); }
                catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/theme-overrides$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                const body = await readBody(req);
                try { applyThemeOverrides(name, body.overrides || {}); send(res, 200, { ok: true }); }
                catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        // Publish
        {
            method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/publish$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                try { send(res, 201, await publishProject(name)); }
                catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
            }
        },
        {
            method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/publish$/, handler: async (req, res, matches) => {
                const name = matches[1];
                if (!validName(name, res, '非法项目名称')) return;
                if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
                send(res, 200, getPublishHistory(name));
            }
        },
        {
            method: 'GET', pattern: /^\/api\/published$/, handler: async (req, res) => {
                send(res, 200, listPublishedProjects());
            }
        },
    ];
}
