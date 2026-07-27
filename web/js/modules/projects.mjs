// web/js/modules/projects.mjs — 项目管理、配置、生成、导出、标签、Dashboard
import { S, animations, THEME_VAR_DEFAULTS, steps, api, showToast, escapeHtml, escapeHtmlAttr, withLlmSettingsHint, statusLabel } from './state.mjs';
import { showConfirmModal } from './modals.mjs';
import { t } from './i18n.mjs';

const _cb = {};
export function initProjectsModule(callbacks) { Object.assign(_cb, callbacks); }

// 模块级私有状态
let chatBusy = false;
let searchTimer = null;
let editModeActive = false;
let vaultSourceSelection = { notes: [], cards: [], fragments: [], mistakes: [] };
const els = () => S.els;

const SOURCE_BADGE_LABELS = { article: t('文章'), url: t('网页'), 'vault-note': t('笔记'), 'vault-cards': t('卡片'), 'vault-mistakes': t('错题'), 'vault-graph': t('星图') };
const VAULT_SOURCE_GROUPS = [
    { key: 'notes', label: '笔记' }, { key: 'cards', label: '知识卡片' },
    { key: 'fragments', label: '碎片' }, { key: 'mistakes', label: '错题' }
];

const components = [
    { id: 'cover', name: t('封面页'), desc: t('kicker + 大标题 + 副标题'), html: '<section class="slide">\n  <div class="slide-content" style="text-align:center;"><div class="kicker">Section</div><h1>封面标题</h1><p class="lead">一句话副标题说明</p><div class="divider" style="margin:32px auto;max-width:120px;"></div><p style="font-size:16px;opacity:0.55;">补充说明文字</p></div>\n</section>' },
    { id: 'hero-stats', name: t('大数字统计'), desc: t('split-visual + 4 个 hero-stat'), html: '<section class="slide">\n  <div class="slide-content"><div class="section-title">Data</div><h2>关键数据</h2><div class="split-visual" style="margin-top:32px;"><div class="hero-stat"><div class="big-number">0%</div><div class="big-number-label">指标一</div></div><div class="hero-stat"><div class="big-number">0%</div><div class="big-number-label">指标二</div></div><div class="hero-stat"><div class="big-number">0</div><div class="big-number-label">指标三</div></div><div class="hero-stat"><div class="big-number">0</div><div class="big-number-label">指标四</div></div></div></div>\n</section>' },
    { id: 'table', name: t('表格页'), desc: t('三列 ppt-table 数据表'), html: '<section class="slide">\n  <div class="slide-content"><div class="section-title">Table</div><h2>数据表格</h2><table class="ppt-table small"><thead><tr><th style="width:30%">项目</th><th style="width:40%">说明</th><th style="width:30%">备注</th></tr></thead><tbody><tr><td><strong>项目一</strong></td><td>说明文字</td><td>备注</td></tr><tr><td><strong>项目二</strong></td><td>说明文字</td><td>备注</td></tr><tr><td><strong>项目三</strong></td><td>说明文字</td><td>备注</td></tr></tbody></table></div>\n</section>' },
    { id: 'progress-ring', name: t('进度环'), desc: t('3 个 progress-ring'), html: '<section class="slide">\n  <div class="slide-content"><div class="section-title">Progress</div><h2>完成度概览</h2><div class="progress-ring"><div class="progress-ring-item"><svg class="progress-ring-svg" viewBox="0 0 120 120"><circle class="progress-ring-circle-bg" cx="60" cy="60" r="50"></circle><circle class="progress-ring-circle" cx="60" cy="60" r="50" style="--progress-pct:75"></circle></svg><div class="progress-ring-value">75%</div><div class="progress-ring-label">维度一</div></div><div class="progress-ring-item"><svg class="progress-ring-svg" viewBox="0 0 120 120"><circle class="progress-ring-circle-bg" cx="60" cy="60" r="50"></circle><circle class="progress-ring-circle" cx="60" cy="60" r="50" style="--progress-pct:60"></circle></svg><div class="progress-ring-value">60%</div><div class="progress-ring-label">维度二</div></div><div class="progress-ring-item"><svg class="progress-ring-svg" viewBox="0 0 120 120"><circle class="progress-ring-circle-bg" cx="60" cy="60" r="50"></circle><circle class="progress-ring-circle" cx="60" cy="60" r="50" style="--progress-pct:45"></circle></svg><div class="progress-ring-value">45%</div><div class="progress-ring-label">维度三</div></div></div></div>\n</section>' },
    { id: 'timeline', name: t('时间线'), desc: 'timeline-horizontal', html: '<section class="slide">\n  <div class="slide-content"><div class="section-title">Roadmap</div><h2>发展里程碑</h2><div class="timeline-horizontal"><div class="timeline-horizontal-item"><div class="timeline-horizontal-dot"></div><div class="timeline-horizontal-content"><div class="timeline-horizontal-title">阶段一</div><div class="timeline-horizontal-desc">里程碑事件</div></div></div><div class="timeline-horizontal-item"><div class="timeline-horizontal-dot"></div><div class="timeline-horizontal-content"><div class="timeline-horizontal-title">阶段二</div><div class="timeline-horizontal-desc">里程碑事件</div></div></div><div class="timeline-horizontal-item"><div class="timeline-horizontal-dot"></div><div class="timeline-horizontal-content"><div class="timeline-horizontal-title">阶段三</div><div class="timeline-horizontal-desc">里程碑事件</div></div></div><div class="timeline-horizontal-item"><div class="timeline-horizontal-dot"></div><div class="timeline-horizontal-content"><div class="timeline-horizontal-title">阶段四</div><div class="timeline-horizontal-desc">里程碑事件</div></div></div></div></div>\n</section>' },
    { id: 'waterfall', name: t('瀑布图'), desc: t('waterfall 增减构成'), html: '<section class="slide">\n  <div class="slide-content"><div class="section-title">Analysis</div><h2>构成分析</h2><div class="waterfall"><div class="waterfall-item"><div class="waterfall-label">初始值</div><div class="waterfall-bar"><div class="waterfall-fill neutral" style="--width:40%;width:40%"></div></div><div class="waterfall-value">100</div></div><div class="waterfall-item"><div class="waterfall-label">因素一</div><div class="waterfall-bar"><div class="waterfall-fill negative" style="--width:25%;width:25%"></div></div><div class="waterfall-value">-40</div></div><div class="waterfall-item"><div class="waterfall-label">因素二</div><div class="waterfall-bar"><div class="waterfall-fill negative" style="--width:18%;width:18%"></div></div><div class="waterfall-value">-30</div></div><div class="waterfall-item"><div class="waterfall-label">因素三</div><div class="waterfall-bar"><div class="waterfall-fill negative" style="--width:12%;width:12%"></div></div><div class="waterfall-value">-20</div></div><div class="waterfall-item"><div class="waterfall-label">最终值</div><div class="waterfall-bar"><div class="waterfall-fill positive" style="--width:10%;width:10%"></div></div><div class="waterfall-value">10</div></div></div></div>\n</section>' },
    { id: 'steps', name: t('步骤流程'), desc: t('chart-steps 四步'), html: '<section class="slide">\n  <div class="slide-content"><div class="section-title">Workflow</div><h2>实施流程</h2><div class="chart-steps"><div class="chart-step"><div class="chart-step-number">1</div><div class="chart-step-content"><div class="chart-step-title">步骤一</div><div class="chart-step-desc">步骤说明</div></div></div><div class="chart-step"><div class="chart-step-number">2</div><div class="chart-step-content"><div class="chart-step-title">步骤二</div><div class="chart-step-desc">步骤说明</div></div></div><div class="chart-step"><div class="chart-step-number">3</div><div class="chart-step-content"><div class="chart-step-title">步骤三</div><div class="chart-step-desc">步骤说明</div></div></div><div class="chart-step"><div class="chart-step-number">4</div><div class="chart-step-content"><div class="chart-step-title">步骤四</div><div class="chart-step-desc">步骤说明</div></div></div></div></div>\n</section>' },
    { id: 'thanks', name: t('结尾页'), desc: 'Thank You', html: '<section class="slide">\n  <div class="slide-content" style="text-align:center;"><div class="kicker">Thank You</div><h1>谢谢</h1><p class="lead">感谢聆听，欢迎交流探讨。</p></div>\n</section>' }
];

// === 模型加载 ===
export async function loadModels() {
    const select = els().inputModelPreset;
    try { S.models = await api('GET', '/api/models'); }
    catch { S.models = []; select.innerHTML = `<option value="">${t('加载失败，请检查服务')}</option>`; return; }
    select.innerHTML = S.models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
}

export async function loadGlobalConfig() {
    try { S.globalConfig = await api('GET', '/api/config'); }
    catch (err) { S.globalConfig = { modelConfig: {} }; showToast(t('加载模型配置失败：{msg}', { msg: err.message }), 'error'); }
}

// === 项目列表 ===
export async function loadProjects(selectName = null) {
    try {
        S.projects = await api('GET', '/api/projects');
        renderProjects();
        if (selectName) selectProject(selectName);
    } catch (e) {
        showToast('加载项目列表失败', 'error');
    }
}

function sourceBadgeLabel(p) {
    const sel = p.sourceSelection;
    if (sel && typeof sel === 'object' && Object.values(sel).some((arr) => Array.isArray(arr) && arr.length)) return t('知识选材');
    return SOURCE_BADGE_LABELS[p.sourceType] || '';
}

function renderProjects() {
    const projectListEl = document.getElementById('project-list');
    if (!projectListEl) return;
    projectListEl.innerHTML = '';
    S.projects.forEach((p, idx) => {
        const badge = sourceBadgeLabel(p);
        const coverUrl = `/projects/${encodeURIComponent(p.name)}/cover.png${p.lastGeneratedAt ? `?t=${encodeURIComponent(p.lastGeneratedAt)}` : ''}`;
        const item = document.createElement('div');
        item.className = 'project-item' + (p.name === S.currentProject ? ' active' : '');
        item.dataset.index = idx;
        const statusBadgeClass = p.status === 'error' ? 'error' : (p.status === 'ready' || p.status === 'published') ? 'ready' : (p.status === 'generating' ? 'generating' : 'draft');
        item.innerHTML = `<div style="display:flex;align-items:center;gap:10px;min-width:0;"><img class="project-cover" src="${coverUrl}" alt="" loading="lazy" onerror="this.remove()"><div style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:11px;font-family:var(--font-mono);background:${idx < 9 ? 'var(--tile)' : 'transparent'};border-radius:4px;color:var(--ink);opacity:0.6;flex-shrink:0;">${idx < 9 ? idx + 1 : ''}</div><div style="min-width:0;"><div class="project-name">${escapeHtml(p.title || p.name)}</div><div class="project-meta">${escapeHtml(p.name)}<span class="status-badge ${statusBadgeClass}">${statusLabel(p.status)}</span>${badge ? `<span class="source-badge">${escapeHtml(badge)}</span>` : ''}</div></div></div><button class="project-delete" title="${t('删除')}">×</button>`;
        item.addEventListener('click', (e) => {
            if (e.target.classList.contains('project-delete')) { e.stopPropagation(); deleteProject(p.name); }
            else selectProject(p.name);
        });
        projectListEl.appendChild(item);
    });
}

export async function selectProject(name) {
    if (_cb.closeSidebarDrawer) _cb.closeSidebarDrawer(); // 移动端：选中项目后收起抽屉进入工作区
    S.currentProject = name;
    renderProjects();
    const projectPanelEl = document.getElementById('project-panel');
    const chatMessagesEl = document.getElementById('chat-messages');
    if (chatMessagesEl) chatMessagesEl.innerHTML = '';
    const knowledgeOnlyTabs = ['vault', 'cards', 'study', 'settings'];
    if (knowledgeOnlyTabs.includes(S.currentSidebarTab)) _cb.switchSidebarTab('projects');
    else { _cb.hideAllMainPanels(); if (projectPanelEl) projectPanelEl.classList.remove('hidden'); }
    const cfg = await api('GET', `/api/projects/${encodeURIComponent(name)}/config`);
    S.currentConfig = cfg;
    renderConfig(cfg); renderThemeOptions(); renderThemeOverrides(cfg); renderAnimationOptions();
    renderComponents(); loadPublishHistory(); loadSnapshots(); updatePreview(); loadChatHistory(name);
}

// === Chat ===
async function loadChatHistory(name) {
    try {
        const data = await api('GET', `/api/projects/${encodeURIComponent(name)}/chat/history`);
        if (name !== S.currentProject) return;
        for (const m of data.messages || []) { if (m.role === 'user' || m.role === 'assistant') appendChatMessage(m.content || '', m.role); }
    } catch { /* no history */ }
}

// === Config ===
function renderConfig(cfg) {
    const e = els();
    e.projectTitle.textContent = cfg.params?.title || cfg.name;
    e.projectStatus.textContent = statusLabel(cfg.status);
    e.projectStatus.className = 'status ' + cfg.status;
    setSourceTab(cfg.sourceType || 'article');
    e.inputUrl.value = cfg.sourceUrl || '';
    e.inputArticle.value = cfg.articleText || '';
    e.inputTitle.value = cfg.params?.title || '';
    e.inputAudience.value = cfg.params?.audience || '';
    e.inputStyle.value = cfg.params?.style || '商业汇报';
    e.inputSlideCount.value = cfg.params?.slideCount || 8;
    e.inputLanguage.value = cfg.params?.language || 'zh-CN';
    updatePipeline(cfg.status);
    S.vaultSourceSelection = normalizeSourceSelection(cfg.sourceSelection);
    vaultSourceSelection = S.vaultSourceSelection;
    if (S.vaultSourceData) renderVaultSourceGroups();
    updateVaultSourceActions();
    renderModelConfigUI();
    const canExport = cfg.status === 'ready';
    [e.btnGenerate, e.btnEditMode, e.btnOpenPreview].forEach((btn) => { if (btn) btn.disabled = !S.currentProject; });
    if (e.btnExport) e.btnExport.disabled = !S.currentProject || !canExport;
    if (e.btnPublishQuick) e.btnPublishQuick.disabled = !S.currentProject || !canExport;
    if (e.btnGenerateContent) e.btnGenerateContent.disabled = false;
    e.btnPreview.disabled = !canExport;
    if (e.btnOpenPreviewHeader) e.btnOpenPreviewHeader.disabled = !canExport;
    if (e.btnDesignLint) e.btnDesignLint.disabled = !canExport;
    e.progressCard.classList.add('hidden');
    editModeActive = false;
    updateEditModeUI();
    checkProjectFiles();
}

// === Model Config UI ===
export function renderModelConfigUI() {
    const e = els();
    const mcfg = S.globalConfig?.modelConfig || {};
    const presetId = mcfg.presetId || 'kimi-code';
    e.inputModelPreset.value = S.models.some((m) => m.id === presetId) ? presetId : 'custom';
    e.inputModelProvider.value = mcfg.provider || '';
    ensureModelOption(mcfg.model);
    e.inputModelBaseUrl.value = mcfg.baseUrl || '';
    e.inputModelApiKey.value = '';
    e.inputModelApiKey.placeholder = mcfg.apiKeySet ? t('已保存，留空保持不变') : 'sk-...';
    if (e.inputModelPersistApiKey) e.inputModelPersistApiKey.checked = false;
    updateModelPresetUI(presetId);
    renderMediaModelConfigs();
    renderPdfConfigUI();
}

function updateModelPresetUI(presetId) {
    els().lmstudioHint.classList.toggle('hidden', presetId !== 'lmstudio');
}

async function refreshModelList() {
    const e = els();
    const baseUrl = e.inputModelBaseUrl.value;
    const apiKey = e.inputModelApiKey.value;
    if (!baseUrl) { showToast(t('请先填写 Base URL')); return; }
    try {
        showToast(t('正在获取模型列表...'));
        const remoteModels = await api('POST', '/api/models/list-remote', { baseUrl, apiKey });
        const cur = e.inputModelName.value;
        e.inputModelName.innerHTML = `<option value="">${t('选择或输入模型...')}</option>` + remoteModels.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`).join('');
        if (cur) ensureModelOption(cur);
        showToast(t('获取到 {count} 个模型', { count: remoteModels.length }));
    } catch (err) { showToast(t('获取模型列表失败: {msg}', { msg: err.message })); }
}

function ensureModelOption(value) {
    if (!value) return;
    const select = els().inputModelName;
    select.querySelectorAll('option[data-custom]').forEach((opt) => opt.remove());
    if (!Array.from(select.options).some((opt) => opt.value === value)) {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = value; opt.dataset.custom = 'true';
        select.appendChild(opt);
    }
    select.value = value;
}

function getModelConfigFromUI() {
    const e = els();
    const presetId = e.inputModelPreset.value;
    const preset = S.models.find((m) => m.id === presetId);
    return { presetId, provider: e.inputModelProvider.value.trim() || (preset?.provider || ''), model: e.inputModelName.value.trim() || (preset?.model || ''), baseUrl: e.inputModelBaseUrl.value.trim() || (preset?.baseUrl || '') };
}

function getMediaModelConfigFromUI(kind) {
    const e = els();
    const provider = kind === 'image' ? e.inputImageModelProvider.value : e.inputVideoModelProvider.value;
    const model = (kind === 'image' ? e.inputImageModelName : e.inputVideoModelName).value.trim();
    const baseUrl = (kind === 'image' ? e.inputImageModelBaseUrl : e.inputVideoModelBaseUrl).value.trim();
    const cfg = { provider, model };
    if (baseUrl) cfg.baseUrl = baseUrl;
    return cfg;
}

function renderMediaModelConfigs() {
    const e = els();
    const img = S.globalConfig?.imageModelConfig || {};
    e.inputImageModelProvider.value = img.provider || 'arkcli';
    e.inputImageModelName.value = img.model || '';
    e.inputImageModelBaseUrl.value = img.baseUrl || '';
    e.inputImageModelApiKey.value = '';
    e.inputImageModelApiKey.placeholder = img.apiKeySet ? t('已保存，留空保持不变') : 'sk-...';
    if (e.inputImageModelPersistApiKey) e.inputImageModelPersistApiKey.checked = false;
    const vid = S.globalConfig?.videoModelConfig || {};
    e.inputVideoModelProvider.value = vid.provider || 'arkcli';
    e.inputVideoModelName.value = vid.model || '';
    e.inputVideoModelBaseUrl.value = vid.baseUrl || '';
    e.inputVideoModelApiKey.value = '';
    e.inputVideoModelApiKey.placeholder = vid.apiKeySet ? t('已保存，留空保持不变') : 'sk-...';
    if (e.inputVideoModelPersistApiKey) e.inputVideoModelPersistApiKey.checked = false;
    updateMediaProviderUI('image'); updateMediaProviderUI('video');
}

function renderPdfConfigUI() {
    const sel = document.getElementById('input-pdf-engine');
    if (!sel) return;
    const engine = S.globalConfig?.pdfConfig?.defaultEngine || 'puppeteer';
    sel.value = engine;
}

function updateMediaProviderUI(kind) {
    const e = els();
    const provider = kind === 'image' ? e.inputImageModelProvider.value : e.inputVideoModelProvider.value;
    const fields = kind === 'image' ? e.imageModelOpenaiFields : e.videoModelOpenaiFields;
    fields.classList.toggle('hidden', provider !== 'openai');
}

async function testMediaModel(kind) {
    const label = kind === 'image' ? t('生图') : t('生视频');
    try {
        showToast(t('正在测试{label}模型…', { label }));
        const result = await api('POST', '/api/media/test', { kind });
        showToast(result?.ok ? (result.message || t('{label}模型可用', { label })) : t('{label}模型测试失败：{msg}', { label, msg: result?.message || t('未知错误') }));
    } catch (err) { showToast(t('{label}模型测试失败：{msg}', { label, msg: err.message }), 'error'); }
}

export async function saveGlobalModelConfig() {
    const e = els();
    try {
        const modelConfig = getModelConfigFromUI();
        const imageModelConfig = getMediaModelConfigFromUI('image');
        const videoModelConfig = getMediaModelConfigFromUI('video');
        const pdfEngineSel = document.getElementById('input-pdf-engine');
        const pdfConfig = pdfEngineSel ? { defaultEngine: pdfEngineSel.value || 'puppeteer' } : undefined;
        const persistApiKey = !!(e.inputModelPersistApiKey?.checked || e.inputImageModelPersistApiKey?.checked || e.inputVideoModelPersistApiKey?.checked);
        let keyPersisted = false;
        if (e.inputModelPersistApiKey?.checked && e.inputModelApiKey.value.trim()) { modelConfig.apiKey = e.inputModelApiKey.value.trim(); keyPersisted = true; }
        if (e.inputImageModelPersistApiKey?.checked && e.inputImageModelApiKey.value.trim()) { imageModelConfig.apiKey = e.inputImageModelApiKey.value.trim(); keyPersisted = true; }
        if (e.inputVideoModelPersistApiKey?.checked && e.inputVideoModelApiKey.value.trim()) { videoModelConfig.apiKey = e.inputVideoModelApiKey.value.trim(); keyPersisted = true; }
        const body = { modelConfig, imageModelConfig, videoModelConfig, ...(persistApiKey ? { persistApiKey: true } : {}) };
        if (pdfConfig) body.pdfConfig = pdfConfig;
        S.globalConfig = await api('POST', '/api/config', body);
        renderModelConfigUI();
        showToast(keyPersisted ? t('模型配置已保存（含 API Key）') : t('配置已保存'));
    } catch (err) { showToast(t('保存配置失败：{msg}', { msg: err.message }), 'error'); }
}

export async function backupNow() {
    try { showToast(t('正在备份…')); const data = await api('POST', '/api/backup'); showToast(t('已备份到 {dir}', { dir: data.dir })); }
    catch (err) { showToast(t('备份失败：{msg}', { msg: err.message }), 'error'); }
}

// === Search ===
async function performSearch(query) {
    const e = els();
    if (!query.trim()) { e.searchResults.classList.add('hidden'); return; }
    try { const results = await api('GET', `/api/search?q=${encodeURIComponent(query)}`); renderSearchResults(results); }
    catch { e.searchResults.classList.add('hidden'); }
}

function renderSearchResults(results) {
    const e = els();
    if (!results || results.length === 0) { e.searchResults.innerHTML = `<div class="search-result-empty">${t('无匹配结果')}</div>`; e.searchResults.classList.remove('hidden'); return; }
    e.searchResults.innerHTML = results.map((r) => `<div class="search-result-item" data-name="${escapeHtml(r.name)}"><div class="search-result-title">${escapeHtml(r.title || r.name)}</div><div class="search-result-meta">${escapeHtml(r.name)} · ${statusLabel(r.status)}</div></div>`).join('');
    e.searchResults.classList.remove('hidden');
    e.searchResults.querySelectorAll('.search-result-item').forEach((item) => {
        item.addEventListener('click', () => { e.searchResults.classList.add('hidden'); e.inputGlobalSearch.value = ''; selectProject(item.dataset.name); });
    });
}

function closeSearchResults() { els().searchResults.classList.add('hidden'); }

// === Chat ===
function toggleChatDock() { els().chatDock.classList.toggle('hidden'); }

function appendChatMessage(text, role) {
    const div = document.createElement('div');
    div.className = 'chat-message ' + role;
    div.textContent = text;
    els().chatMessages.appendChild(div);
    els().chatMessages.scrollTop = els().chatMessages.scrollHeight;
    return div;
}

async function sendChatMessage() {
    const e = els();
    const instruction = e.chatInput.value.trim();
    if (!instruction || !S.currentProject || chatBusy) return;
    appendChatMessage(instruction, 'user');
    e.chatInput.value = '';
    chatBusy = true;
    e.btnChatSend.disabled = true;
    const progressMsg = appendChatMessage(t('修改已启动…'), 'system');
    const projectName = S.currentProject;
    const chatStartIso = new Date().toISOString(); // 用于定位本次修改前自动创建的快照
    try {
        const sessionApiKey = e.inputModelApiKey.value.trim();
        await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/chat`, { instruction, ...(sessionApiKey ? { apiKey: sessionApiKey } : {}) });
    } catch (err) {
        progressMsg.remove();
        appendChatMessage(t('修改失败：{msg}', { msg: withLlmSettingsHint(err.message) }), 'error');
        chatBusy = false; e.btnChatSend.disabled = false; return;
    }
    const finish = () => { chatBusy = false; e.btnChatSend.disabled = false; };
    const es = new EventSource(`/api/projects/${encodeURIComponent(S.currentProject)}/chat/events`);
    es.onmessage = (ev) => {
        let event;
        try { event = JSON.parse(ev.data); } catch { event = { type: 'progress', message: ev.data }; }
        if (event.type === 'progress') progressMsg.textContent = event.message || event.step || t('修改中…');
        else if (event.type === 'done') {
            progressMsg.remove();
            const msgDiv = appendChatMessage((event.summary || t('修改已完成，预览已刷新。')) + (event.details ? '\n\n' + event.details : ''), 'assistant');
            addChatUndoButton(msgDiv, projectName, chatStartIso);
            es.close(); finish(); updatePreview(); loadSnapshots();
        } else if (event.type === 'error') {
            progressMsg.remove();
            appendChatMessage(t('修改失败：{msg}', { msg: withLlmSettingsHint(event.message) }), 'error');
            es.close(); finish();
        }
    };
    es.onerror = () => { progressMsg.remove(); appendChatMessage(t('进度连接中断，请稍后手动刷新预览查看结果。'), 'error'); es.close(); finish(); };
}

async function checkProjectFiles() {
    if (!S.currentProject) return;
    const e = els();
    try {
        const res = await fetch(`/projects/${encodeURIComponent(S.currentProject)}/index.html`, { method: 'HEAD' });
        if (res.ok) { e.btnPreview.disabled = false; if (e.btnExport) e.btnExport.disabled = false; if (e.btnPublishQuick) e.btnPublishQuick.disabled = false; if (e.btnOpenPreview) e.btnOpenPreview.disabled = false; if (e.btnOpenPreviewHeader) e.btnOpenPreviewHeader.disabled = false; }
    } catch { }
}

// === Source Tab / Pipeline ===
function setSourceTab(type) {
    const e = els();
    e.tabs.forEach((t) => t.classList.toggle('active', t.dataset.source === type));
    e.fieldUrl.classList.toggle('hidden', type !== 'url');
    e.fieldArticle.classList.toggle('hidden', type !== 'article');
    const vaultField = document.getElementById('field-vault-source');
    if (vaultField) vaultField.classList.toggle('hidden', type !== 'vault');
    if (type === 'vault') loadVaultSourceData();
}

function updatePipeline(status) {
    document.querySelectorAll('#pipeline-bar .pipeline-step').forEach((s) => s.classList.remove('active', 'in-progress', 'error'));
    const mark = (stage, cls) => { document.querySelector(`#pipeline-bar .pipeline-step[data-stage="${stage}"]`)?.classList.add(cls); };
    if (status === 'generating') mark('generate', 'in-progress');
    else if (status === 'ready') { mark('modify', 'active'); mark('publish', 'active'); }
    else if (status === 'error') mark('generate', 'error');
    else { mark('select', 'active'); mark('generate', 'active'); }
}

function activateConfigTab(tabName) { document.querySelector(`.config-tab[data-tab="${tabName}"]`)?.click(); }

function handlePipelineStep(stage) {
    if (stage === 'select') activateConfigTab('content');
    else if (stage === 'generate') { activateConfigTab('content'); if (els().btnGenerateContent) { els().btnGenerateContent.scrollIntoView({ behavior: 'smooth', block: 'center' }); els().btnGenerateContent.focus(); } }
    else if (stage === 'modify') { if (els().previewFrame) els().previewFrame.focus(); showToast(t('可点击「编辑模式」直接改字，或用「AI 修改」对话调整')); }
    else if (stage === 'publish') activateConfigTab('publish');
}

// === Vault Source ===
function normalizeSourceSelection(raw) {
    const sel = { notes: [], cards: [], fragments: [], mistakes: [] };
    if (raw && typeof raw === 'object') for (const key of Object.keys(sel)) { if (Array.isArray(raw[key])) sel[key] = raw[key].slice(); }
    return sel;
}

async function loadVaultSourceData() {
    if (S.vaultSourceData) { renderVaultSourceGroups(); return; }
    renderVaultSourceGroups();
    try {
        const [notesData, cardsData, fragmentsData, mistakesData] = await Promise.all([api('GET', '/api/vault/notes'), api('GET', '/api/vault/cards'), api('GET', '/api/vault/fragments'), api('GET', '/api/mistakes')]);
        S.vaultSourceData = { notes: Array.isArray(notesData) ? notesData : [], cards: Array.isArray(cardsData) ? cardsData : [], fragments: fragmentsData?.fragments || [], mistakes: Array.isArray(mistakesData) ? mistakesData : [] };
    } catch (err) { showToast(t('加载知识库素材失败：{msg}', { msg: err.message }), 'error'); S.vaultSourceData = null; }
    renderVaultSourceGroups();
}

function vaultSourceItems(group) {
    if (!S.vaultSourceData) return [];
    if (group === 'notes') return S.vaultSourceData.notes.map((n) => ({ id: n.name, label: n.name }));
    if (group === 'cards') return S.vaultSourceData.cards.map((c) => ({ id: c.id, label: c.title || c.question || c.id }));
    if (group === 'fragments') return S.vaultSourceData.fragments.map((f) => ({ id: f.id, label: (f.content || '').replace(/\s+/g, ' ').slice(0, 40) }));
    if (group === 'mistakes') return S.vaultSourceData.mistakes.map((m) => ({ id: m.id, label: (m.question || '').replace(/\s+/g, ' ').slice(0, 40) }));
    return [];
}

function renderVaultSourceGroup(group) {
    const listEl = document.getElementById('vault-source-' + group);
    if (!listEl) return;
    if (!S.vaultSourceData) { listEl.innerHTML = `<div class="vault-source-empty">${t('加载中…')}</div>`; return; }
    const filter = (document.querySelector(`.vault-source-filter[data-group="${group}"]`)?.value || '').trim().toLowerCase();
    const items = vaultSourceItems(group).filter((it) => !filter || it.label.toLowerCase().includes(filter));
    if (!items.length) { listEl.innerHTML = `<div class="vault-source-empty">${t('暂无内容')}</div>`; return; }
    const selected = new Set(vaultSourceSelection[group] || []);
    listEl.innerHTML = items.map((it) => `<label class="vault-source-item"><input type="checkbox" data-group="${group}" value="${escapeHtml(it.id)}" ${selected.has(it.id) ? 'checked' : ''}><span>${escapeHtml(it.label)}</span></label>`).join('');
}

function renderVaultSourceGroups() { VAULT_SOURCE_GROUPS.forEach((g) => renderVaultSourceGroup(g.key)); updateVaultSourceActions(); }

function updateVaultSourceActions() {
    const btn = document.getElementById('btn-vault-source-review-deck');
    if (btn) btn.disabled = !(vaultSourceSelection.cards.length || vaultSourceSelection.mistakes.length);
}

async function collectVaultSource() {
    const sel = vaultSourceSelection;
    const total = sel.notes.length + sel.cards.length + sel.fragments.length + sel.mistakes.length;
    if (!total) { showToast(t('请先勾选素材')); return; }
    if (!S.vaultSourceData) await loadVaultSourceData();
    const parts = [];
    for (const name of sel.notes) {
        try { const data = await api('GET', `/api/vault/notes/${encodeURIComponent(name)}`); parts.push(`## 笔记：${name}\n\n${(data.content || '').replace(/^---[\s\S]*?---\n*/, '').trim()}`); }
        catch { parts.push(`## 笔记：${name}`); }
    }
    for (const id of sel.cards) { const c = S.vaultSourceData?.cards.find((x) => x.id === id); if (!c) continue; let t = `## 卡片：${c.title || ''}\n\n问：${c.question || ''}\n答：${c.answer || ''}`; if (c.explanation) t += `\n解析：${c.explanation}`; parts.push(t); }
    for (const id of sel.fragments) { const f = S.vaultSourceData?.fragments.find((x) => x.id === id); if (!f) continue; const c = (f.content || '').trim(); parts.push(`## 碎片：${c.replace(/\s+/g, ' ').slice(0, 20)}\n\n${c}`); }
    for (const id of sel.mistakes) { const m = S.vaultSourceData?.mistakes.find((x) => x.id === id); if (!m) continue; let t = `## 错题：${(m.question || '').replace(/\s+/g, ' ').slice(0, 30)}\n\n题目：${m.question || ''}\n正确答案：${m.correctAnswer || m.answer || ''}`; if (m.analysis) t += `\n解析：${m.analysis}`; parts.push(t); }
    els().inputArticle.value = parts.join('\n\n');
    setSourceTab('article');
    showToast(t('已汇总 {count} 项素材', { count: total }));
}

// === Themes ===
function renderThemeOptions() {
    const e = els();
    e.themeGrid.innerHTML = '';
    const cur = S.currentConfig?.theme || 'web-ui';
    S.themes.forEach((theme) => {
        const card = document.createElement('div');
        card.className = 'theme-card' + (theme.id === cur ? ' active' : '');
        card.innerHTML = `<div class="theme-preview"><div class="theme-preview-bar" style="background:${theme.color}"></div></div><div class="theme-name">${escapeHtml(theme.name)}</div><div class="theme-desc">${escapeHtml(theme.desc)}</div>`;
        card.addEventListener('click', () => selectTheme(theme.id));
        e.themeGrid.appendChild(card);
    });
}

function selectTheme(themeId) {
    els().themeGrid.querySelectorAll('.theme-card').forEach((card, i) => card.classList.toggle('active', S.themes[i].id === themeId));
    saveAndRefreshPreview();
}

function setFontSelect(select, value) {
    if (!value) return;
    select.querySelectorAll('option[data-custom]').forEach((opt) => opt.remove());
    if (!Array.from(select.options).some((opt) => opt.value === value)) {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = t('自定义 · {value}', { value }); opt.dataset.custom = 'true';
        select.appendChild(opt);
    }
    select.value = value;
}

function renderThemeOverrides(cfg) {
    const e = els();
    const o = cfg.themeOverrides || {};
    e.inputVarTeal.value = o['--teal'] || THEME_VAR_DEFAULTS['--teal'];
    e.inputVarInk.value = o['--ink'] || THEME_VAR_DEFAULTS['--ink'];
    e.inputVarCream.value = o['--cream'] || THEME_VAR_DEFAULTS['--cream'];
    setFontSelect(e.inputVarFontHeading, o['--font-heading']);
    setFontSelect(e.inputVarFontBody, o['--font-body']);
}

async function applyThemeOverrides() {
    if (!S.currentProject) return;
    const e = els();
    try {
        await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/theme-overrides`, { overrides: { '--teal': e.inputVarTeal.value, '--ink': e.inputVarInk.value, '--cream': e.inputVarCream.value, '--font-heading': e.inputVarFontHeading.value, '--font-body': e.inputVarFontBody.value } });
        showToast(t('变量已应用')); updatePreview();
    } catch (err) { showToast(t('应用变量失败：{msg}', { msg: err.message })); }
}

async function clearThemeOverrides() {
    if (!S.currentProject) return;
    const e = els();
    try {
        await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/theme-overrides`, { overrides: {} });
        e.inputVarTeal.value = THEME_VAR_DEFAULTS['--teal']; e.inputVarInk.value = THEME_VAR_DEFAULTS['--ink']; e.inputVarCream.value = THEME_VAR_DEFAULTS['--cream'];
        e.inputVarFontHeading.selectedIndex = 0; e.inputVarFontBody.selectedIndex = 1;
        showToast(t('变量已清除')); updatePreview();
    } catch (err) { showToast(t('清除变量失败：{msg}', { msg: err.message })); }
}

// === Components / Animations ===
function renderComponents() {
    const e = els();
    e.componentGrid.innerHTML = '';
    components.forEach((comp) => {
        const card = document.createElement('div');
        card.className = 'component-card';
        card.innerHTML = `<div class="component-preview">${escapeHtml(comp.desc)}</div><div class="component-name">${escapeHtml(comp.name)}</div><button class="btn-secondary component-insert">${t('插入')}</button>`;
        card.querySelector('.component-insert').addEventListener('click', () => insertComponent(comp));
        e.componentGrid.appendChild(card);
    });
}

async function insertComponent(comp) {
    if (!S.currentProject) return;
    try { await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/component`, { html: comp.html }); showToast(t('已插入「{name}」', { name: comp.name })); updatePreview(); }
    catch (err) { showToast(t('插入组件失败：{msg}', { msg: err.message })); }
}

function renderAnimationOptions() {
    const e = els();
    e.animationOptions.innerHTML = '';
    const cur = S.currentConfig?.animation || 'slide';
    animations.forEach((anim) => {
        const opt = document.createElement('div');
        opt.className = 'animation-option' + (anim.id === cur ? ' active' : '');
        opt.innerHTML = `<div class="animation-icon">${anim.icon}</div><div class="animation-info"><div class="animation-title">${escapeHtml(t(anim.name))}</div><div class="animation-desc">${escapeHtml(t(anim.desc))}</div></div>`;
        opt.addEventListener('click', () => selectAnimation(anim.id));
        e.animationOptions.appendChild(opt);
    });
}

function selectAnimation(animId) {
    els().animationOptions.querySelectorAll('.animation-option').forEach((opt, i) => opt.classList.toggle('active', animations[i].id === animId));
    saveAndRefreshPreview();
}

async function saveAndRefreshPreview() {
    if (!S.currentProject) return;
    try { await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/config`, getConfigPayload()); els().previewFrame.src = `/projects/${encodeURIComponent(S.currentProject)}/index.html?t=${Date.now()}`; }
    catch (err) { console.error('Failed to save config:', err); }
}

// === Snapshots / Publish ===
async function loadPublishHistory() {
    try { renderPublishHistory(await api('GET', `/api/projects/${encodeURIComponent(S.currentProject)}/publish`)); }
    catch { renderPublishHistory([]); }
}

async function loadSnapshots() {
    if (!S.currentProject) return;
    try { renderSnapshots(await api('GET', `/api/projects/${encodeURIComponent(S.currentProject)}/snapshots`)); }
    catch { renderSnapshots([]); }
}

function renderSnapshots(snapshots) {
    const e = els();
    if (!snapshots || !snapshots.length) { e.snapshotList.innerHTML = `<div style="padding:40px 20px;text-align:center;opacity:0.5;font-size:13px;">${t('暂无快照')}</div>`; return; }
    e.snapshotList.innerHTML = snapshots.map((s) => `<div class="publish-item"><div class="publish-version">${escapeHtml(new Date(s.createdAt).toLocaleString())}</div><div class="publish-info"><div class="publish-time">${escapeHtml(s.description || t('（无说明）'))}</div><div class="publish-meta">${escapeHtml(s.title || s.name)} · ${statusLabel(s.status)}</div></div><div style="display:flex;gap:6px;"><button class="btn-secondary snapshot-restore" data-id="${escapeHtml(s.id)}" style="padding:6px 10px;font-size:12px;">${t('恢复')}</button><button class="btn-secondary snapshot-delete" data-id="${escapeHtml(s.id)}" style="padding:6px 10px;font-size:12px;">${t('删除')}</button></div></div>`).join('');
    e.snapshotList.querySelectorAll('.snapshot-restore').forEach((btn) => btn.addEventListener('click', () => restoreSnapshotById(btn.dataset.id)));
    e.snapshotList.querySelectorAll('.snapshot-delete').forEach((btn) => btn.addEventListener('click', () => deleteSnapshotById(btn.dataset.id)));
}

async function createSnapshotNow() {
    if (!S.currentProject) return;
    try { await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/snapshots`, { description: els().snapshotDescription.value.trim() }); els().snapshotDescription.value = ''; showToast(t('快照已保存')); loadSnapshots(); }
    catch (err) { showToast(t('保存快照失败：{msg}', { msg: err.message })); }
}

async function restoreSnapshotById(id) {
    if (!(await showConfirmModal({ title: t('恢复快照'), message: t('恢复此快照将覆盖当前项目内容，确定吗？'), confirmText: t('恢复'), danger: true }))) return;
    try { await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/snapshots/${encodeURIComponent(id)}/restore`); showToast(t('已恢复快照')); const cfg = await api('GET', `/api/projects/${encodeURIComponent(S.currentProject)}/config`); S.currentConfig = cfg; renderConfig(cfg); updatePreview(); }
    catch (err) { showToast(t('恢复失败：{msg}', { msg: err.message })); }
}

// AI 修改完成后在对话消息下附加「撤销本次修改」按钮：
// 恢复 chat-modify 改前自动创建的快照（restore 本身会再建安全快照，操作可逆）
function addChatUndoButton(msgDiv, projectName, sinceIso) {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary chat-undo-btn';
    btn.textContent = t('撤销本次修改');
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            const snapshots = await api('GET', `/api/projects/${encodeURIComponent(projectName)}/snapshots`);
            // 列表按时间倒序：取本次修改开始后创建的最早一份快照（= 修改前自动快照），找不到则退化为最近一份
            const pick = [...(snapshots || [])].reverse().find((s) => s.createdAt >= sinceIso) || (snapshots || [])[0];
            if (!pick) { showToast(t('没有可回滚的快照')); btn.remove(); return; }
            if (!(await showConfirmModal({ title: t('撤销 AI 修改'), message: t('将回滚到本次 AI 修改前的版本（恢复前会再建安全快照，可再次恢复）。确定吗？'), confirmText: t('撤销修改') }))) { btn.disabled = false; return; }
            await api('POST', `/api/projects/${encodeURIComponent(projectName)}/snapshots/${encodeURIComponent(pick.id)}/restore`);
            const cfg = await api('GET', `/api/projects/${encodeURIComponent(projectName)}/config`);
            S.currentConfig = cfg;
            renderConfig(cfg);
            updatePreview();
            loadSnapshots();
            showToast(t('已撤销本次 AI 修改'));
            btn.remove();
        } catch (err) {
            btn.disabled = false;
            showToast(t('撤销失败：{msg}', { msg: err.message }));
        }
    });
    msgDiv.appendChild(btn);
}

async function deleteSnapshotById(id) {
    if (!(await showConfirmModal({ title: t('删除快照'), message: t('确定删除此快照吗？此操作不可恢复。'), confirmText: t('删除'), danger: true }))) return;
    try { await api('DELETE', `/api/projects/${encodeURIComponent(S.currentProject)}/snapshots/${encodeURIComponent(id)}`); showToast(t('快照已删除')); loadSnapshots(); }
    catch (err) { showToast(t('删除失败：{msg}', { msg: err.message })); }
}

function renderPublishHistory(history) {
    const e = els();
    if (history?.length) {
        e.publishStatusTitle.textContent = t('已发布');
        e.publishStatusDesc.textContent = t('最新版本: {version}', { version: history[0].version });
        e.publishLatest.textContent = `${window.location.origin}/published/${encodeURIComponent(S.currentProject)}/latest/index.html`;
        e.publishList.innerHTML = history.map((item) => `<div class="publish-item"><div class="publish-version">${escapeHtml(item.version)}</div><div class="publish-info"><div class="publish-time">${new Date(item.publishedAt).toLocaleString()}</div><div class="publish-meta">${t('主题: {theme} · 动画: {anim}', { theme: escapeHtml(item.theme || 'web-ui'), anim: escapeHtml(item.animation || 'slide') })}</div></div><a href="/published/${encodeURIComponent(S.currentProject)}/${encodeURIComponent(item.version)}/index.html" target="_blank" class="publish-link">${t('打开')}</a></div>`).join('');
    } else {
        e.publishStatusTitle.textContent = t('草稿状态'); e.publishStatusDesc.textContent = t('尚未发布过任何版本'); e.publishLatest.textContent = t('暂未发布');
        e.publishList.innerHTML = `<div style="padding:40px 20px;text-align:center;opacity:0.5;font-size:13px;">${t('暂无发布历史')}</div>`;
    }
}

export function updatePreview() {
    if (!S.currentProject) return;
    els().previewFrame.src = `/projects/${encodeURIComponent(S.currentProject)}/index.html?t=${Date.now()}`;
}

// === 设计检查 ===
const LINT_SEVERITY_ICONS = { error: '✗', warning: '⚠', info: 'ℹ' };

function formatLintIssues(issues, max = 15) {
    const lines = issues.slice(0, max).map((it) => {
        const page = it.page > 0 ? t('第{page}页', { page: it.page }) : t('全局');
        return `${LINT_SEVERITY_ICONS[it.severity] || '•'} ${page} ${it.message}${it.autoFixed ? t('（已自动修复）') : ''}`;
    });
    if (issues.length > max) lines.push(t('… 其余 {count} 条', { count: issues.length - max }));
    return lines.join('\n');
}

async function runDesignLint() {
    const name = S.currentProject;
    if (!name) return;
    let data;
    try { data = await api('GET', `/api/projects/${encodeURIComponent(name)}/design-lint`); }
    catch (err) { showToast(t('设计检查失败：{msg}', { msg: err.message })); return; }
    const issues = data.issues || [];
    if (!issues.length) { showToast(t('设计检查通过，未发现问题')); return; }
    const s = data.summary || {};
    const fixable = issues.filter((it) => it.rule === 'gradient-text' && !it.autoFixed).length;
    const confirmed = await showConfirmModal({
        title: t('设计检查：{total} 个问题（error {error} / warning {warning} / info {info}）', { total: s.total ?? issues.length, error: s.error ?? 0, warning: s.warning ?? 0, info: s.info ?? 0 }),
        message: formatLintIssues(issues),
        confirmText: fixable > 0 ? t('一键修复（{count} 处）', { count: fixable }) : t('知道了'),
    });
    if (!confirmed || fixable === 0) return;
    try {
        const res = await api('POST', `/api/projects/${encodeURIComponent(name)}/design-lint/fix`);
        showToast(t('已自动修复 {count} 处，预览已刷新', { count: res.fixedCount }));
        updatePreview();
        loadSnapshots();
    } catch (err) { showToast(t('自动修复失败：{msg}', { msg: err.message })); }
}

// === Edit Mode ===
function toggleEditMode() {
    if (!S.currentProject) return;
    if (editModeActive) els().previewFrame.contentWindow.postMessage({ type: 'ai-ppt:edit-cancel' }, '*');
    else { editModeActive = true; updateEditModeUI(); els().previewFrame.contentWindow.postMessage({ type: 'ai-ppt:edit-start' }, '*'); }
}

function updateEditModeUI() {
    const e = els();
    if (!e.btnEditMode) return;
    e.btnEditMode.classList.toggle('active', editModeActive);
    e.btnEditMode.textContent = editModeActive ? t('退出编辑') : t('编辑模式');
    if (e.editStatus) { e.editStatus.textContent = editModeActive ? t('可直接点击文字编辑') : ''; e.editStatus.classList.toggle('visible', editModeActive); }
}

async function handleEditSaved(html) {
    if (!S.currentProject) return;
    try { await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/save-edits`, { html }); showToast(t('编辑已保存')); editModeActive = false; updateEditModeUI(); updatePreview(); loadSnapshots(); }
    catch (err) { showToast(t('保存失败：{msg}', { msg: err.message })); }
}

function handleEditCancelled() { editModeActive = false; updateEditModeUI(); showToast(t('已取消编辑')); updatePreview(); }

// === Generate / Export / Publish ===
function getConfigPayload() {
    const e = els();
    const activeTab = document.querySelector('.tab.active');
    const sourceType = activeTab ? activeTab.dataset.source : 'article';
    const selectedTheme = S.themes.find((t, i) => e.themeGrid.querySelectorAll('.theme-card')[i]?.classList.contains('active'));
    const selectedAnim = animations.find((t, i) => e.animationOptions.querySelectorAll('.animation-option')[i]?.classList.contains('active'));
    return {
        sourceType, sourceUrl: e.inputUrl.value.trim(), articleText: e.inputArticle.value.trim(),
        sourceSelection: vaultSourceSelection,
        params: { title: e.inputTitle.value.trim(), audience: e.inputAudience.value.trim(), style: e.inputStyle.value, slideCount: parseInt(e.inputSlideCount.value, 10) || 8, language: e.inputLanguage.value },
        theme: selectedTheme?.id || S.currentConfig?.theme || 'web-ui',
        animation: selectedAnim?.id || S.currentConfig?.animation || 'slide'
    };
}

export async function saveConfig() {
    if (!S.currentProject) return;
    await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/config`, getConfigPayload());
    await saveGlobalModelConfig();
    showToast(t('配置已保存'));
    S.currentConfig = await api('GET', `/api/projects/${encodeURIComponent(S.currentProject)}/config`);
    renderConfig(S.currentConfig); updatePreview();
}

function initProgress() {
    const e = els();
    e.progressCard.classList.remove('hidden');
    e.progressSteps.innerHTML = steps.map((s) => `<div class="step pending" data-step="${s.key}"><span>${escapeHtml(t(s.label))}</span></div>`).join('');
    e.progressLog.textContent = '';
}

function updateProgress(step, state, message) {
    const e = els();
    const el = e.progressSteps.querySelector(`[data-step="${step}"]`);
    if (el) el.className = 'step ' + state;
    if (message) { e.progressLog.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`; e.progressLog.scrollTop = e.progressLog.scrollHeight; }
}

async function generate() {
    if (!S.currentProject) return;
    const e = els();
    const sessionApiKey = e.inputModelApiKey.value.trim();
    await saveConfig(); initProgress();
    e.btnGenerate.disabled = true; if (e.btnGenerateContent) e.btnGenerateContent.disabled = true;
    updateProgress('start', 'active', t('开始生成'));
    try { await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/generate`, sessionApiKey ? { apiKey: sessionApiKey } : undefined); }
    catch (err) { updateProgress('start', 'error', withLlmSettingsHint(err.message)); e.btnGenerate.disabled = false; if (e.btnGenerateContent) e.btnGenerateContent.disabled = false; return; }
    const es = new EventSource(`/api/projects/${encodeURIComponent(S.currentProject)}/generate/events`);
    es.onmessage = (ev) => {
        let event; try { event = JSON.parse(ev.data); } catch { event = { type: 'log', message: ev.data }; }
        if (event.type === 'progress') { updateProgress(event.step, 'done', event.message); const idx = steps.findIndex((s) => s.key === event.step); if (idx >= 0 && idx < steps.length - 1) updateProgress(steps[idx + 1].key, 'active'); }
        else if (event.type === 'log' || event.type === 'stderr') e.progressLog.textContent += event.message + '\n';
        else if (event.type === 'error') { updateProgress(event.step || 'ready', 'error', withLlmSettingsHint(event.message)); es.close(); e.btnGenerate.disabled = false; if (e.btnGenerateContent) e.btnGenerateContent.disabled = false; showToast(t('生成失败：{msg}', { msg: withLlmSettingsHint(event.message) })); }
        else if (event.type === 'done') { updateProgress('ready', 'done', t('生成完成')); es.close(); e.btnGenerate.disabled = false; if (e.btnGenerateContent) e.btnGenerateContent.disabled = false; loadProjects(S.currentProject).then(() => updatePreview()); }
    };
    es.onerror = () => { es.close(); e.btnGenerate.disabled = false; if (e.btnGenerateContent) e.btnGenerateContent.disabled = false; updateProgress('ready', 'error', t('生成连接中断')); showToast(t('生成连接中断，请重试')); };
}

function openPreview() { window.open(`/projects/${encodeURIComponent(S.currentProject)}/`, '_blank'); }

// 异步导出（pptx / pptx-image）：POST 202 → SSE 进度 → done 事件携带 downloadUrl 自动下载
function exportAsync(type, label, downloadName) {
    if (!S.currentProject) return;
    const name = S.currentProject;
    showToast(t('{label}导出已启动...', { label }));
    api('POST', `/api/projects/${encodeURIComponent(name)}/export/${type}`)
        .then(() => {
            const es = new EventSource(`/api/projects/${encodeURIComponent(name)}/export/${type}/events`);
            es.onmessage = (ev) => {
                let event; try { event = JSON.parse(ev.data); } catch { event = { type: 'log', message: ev.data }; }
                if (event.type === 'progress') { if (event.message) showToast(event.message); }
                else if (event.type === 'error') { es.close(); showToast(t('{label}导出失败：{msg}', { label, msg: event.message }), 'error'); }
                else if (event.type === 'done') {
                    es.close();
                    if (event.downloadUrl) {
                        const a = document.createElement('a'); a.href = event.downloadUrl; a.download = downloadName; document.body.appendChild(a); a.click(); a.remove();
                        showToast(t('{label}已下载', { label }));
                    } else if (event.note) {
                        showToast(event.note);
                    } else {
                        showToast(t('{label}导出完成但未返回下载地址', { label }), 'error');
                    }
                }
            };
            es.onerror = () => { es.close(); showToast(t('{label}导出连接中断，请重试', { label }), 'error'); };
        })
        .catch((err) => { showToast(t('{label}导出失败：{msg}', { label, msg: err.message }), 'error'); });
}

async function exportPptx() {
    exportAsync('pptx', 'PPTX', `${S.currentProject}.pptx`);
}

async function exportPptxImage() {
    exportAsync('pptx-image', t('高清图片 PPTX'), `${S.currentProject}-image.pptx`);
}

async function exportHtml() {
    if (!S.currentProject) return;
    showToast(t('正在生成单文件 HTML...'));
    try { const res = await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/export/html`); if (res.downloadUrl) { const a = document.createElement('a'); a.href = res.downloadUrl; a.download = `${S.currentProject}.html`; document.body.appendChild(a); a.click(); a.remove(); showToast(t('单文件 HTML 已下载')); } }
    catch (err) { showToast(t('单文件 HTML 导出失败：{msg}', { msg: err.message })); }
}

async function exportVideo() {
    exportAsync('video', t('视频 MP4'), `${S.currentProject}.mp4`);
}

async function exportPdfVector() {
    exportAsync('pdf-vector', t('矢量 PDF'), `${S.currentProject}-vector.pdf`);
}

async function exportSite() {
    if (!S.currentProject) return;
    showToast(t('正在打包静态站点...'));
    try { const res = await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/export/site`); if (res.downloadUrl) { const a = document.createElement('a'); a.href = res.downloadUrl; a.download = `${S.currentProject}-site.zip`; document.body.appendChild(a); a.click(); a.remove(); showToast(t('静态站点包已下载')); } }
    catch (err) { showToast(t('静态站点包导出失败：{msg}', { msg: err.message })); }
}

async function doPublish() {
    if (!S.currentProject) return;
    showToast(t('正在发布...'));
    try {
        const res = await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/publish`);
        showToast(t('发布成功！'));
        loadPublishHistory();
        showPublishModal(res);
    }
    catch (err) { showToast(t('发布失败：{msg}', { msg: err.message })); }
}

// 发布结果弹窗：完整链接（优先局域网 IP 形态）+ 复制 + 二维码
function showPublishModal(res) {
    const name = S.currentProject;
    const modal = document.getElementById('publish-modal');
    if (!modal || !name) return;
    const localUrl = `${window.location.origin}/published/${encodeURIComponent(name)}/latest/index.html`;
    const url = res?.lanUrl || localUrl;
    document.getElementById('publish-modal-url').value = url;
    document.getElementById('publish-modal-hint').textContent = res?.lanUrl
        ? t('手机扫码访问：需与本机同一局域网，且服务以 AI_PPT_HOST=0.0.0.0 启动')
        : t('未检测到局域网地址，二维码使用当前访问地址');
    document.getElementById('publish-modal-qr-img').src =
        `/api/projects/${encodeURIComponent(name)}/publish/qr?url=${encodeURIComponent(url)}`;
    modal.classList.remove('hidden');
}

function closePublishModal() {
    document.getElementById('publish-modal')?.classList.add('hidden');
}

async function copyPublishUrl() {
    const input = document.getElementById('publish-modal-url');
    if (!input?.value) return;
    try {
        await navigator.clipboard.writeText(input.value);
        showToast(t('链接已复制'));
    } catch {
        input.select();
        document.execCommand('copy');
        showToast(t('链接已复制'));
    }
}

// === CRUD helpers ===
function toggleSidebarCollapse() { els().projectSidebar.classList.toggle('collapsed'); }
function toggleExportDropdown() { els().exportDropdown.querySelector('.dropdown-menu').classList.toggle('hidden'); }
function closeExportDropdown() { els().exportDropdown.querySelector('.dropdown-menu').classList.add('hidden'); }
function openExportDropdown() {
    if (!S.currentProject) { showToast(t('请先选择项目')); return; }
    if (S.currentSidebarTab !== 'projects' && _cb.switchSidebarTab) _cb.switchSidebarTab('projects');
    els().exportDropdown.querySelector('.dropdown-menu').classList.remove('hidden');
}
function openCreateModal() {
    const e = els();
    e.newProjectName.value = '';
    e.newProjectTitle.value = '';
    if (e.newProjectTemplate) e.newProjectTemplate.value = '';
    clearNameValidity();
    e.createModal.classList.remove('hidden');
}

function validateProjectName(name) {
    return /^[a-z0-9][a-z0-9\-]*$/.test(name);
}

function updateNameValidity(name) {
    const hintEl = document.getElementById('name-validity');
    if (!hintEl || !name.trim()) { clearNameValidity(); return; }
    if (validateProjectName(name)) {
        hintEl.textContent = '✓ 名称有效';
        hintEl.className = 'field-hint success';
    } else {
        hintEl.textContent = '✕ 仅支持小写字母、数字和中划线（不能以中划线开头）';
        hintEl.className = 'field-hint error';
    }
}

function clearNameValidity() {
    const hintEl = document.getElementById('name-validity');
    if (hintEl) { hintEl.textContent = ''; hintEl.className = 'field-hint hidden'; }
}
function openHelpPanel() { els().helpPanel.classList.remove('hidden'); }
function closeHelpPanel() { els().helpPanel.classList.add('hidden'); }
function isInputActive() { const a = document.activeElement; return a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName); }
function handleEscapeKey() {
    if (!els().helpPanel.classList.contains('hidden')) { closeHelpPanel(); return; }
    const m = document.querySelector('.modal:not(.hidden)'); if (m) m.classList.add('hidden');
}

async function createProject() {
    const e = els();
    const name = e.newProjectName.value.trim().toLowerCase();
    if (!name) { showToast(t('请输入项目标识')); return; }
    if (!validateProjectName(name)) { showToast(t('名称仅支持小写字母、数字和中划线（不能以中划线开头）')); return; }
    const template = e.newProjectTemplate ? e.newProjectTemplate.value : '';
    try { await api('POST', '/api/projects', { name, title: e.newProjectTitle.value.trim(), ...(template ? { template } : {}) }); e.createModal.classList.add('hidden'); clearNameValidity(); await loadProjects(name); showToast(t('项目已创建')); const toastEl = document.getElementById('toast'); if (toastEl) toastEl.className = 'toast show success'; setTimeout(() => { if (toastEl) toastEl.className = 'toast'; }, 2500); }
    catch (err) { showToast(err.message); }
}

// === 主题画廊（iframe 加载基座 theme-showcase，点选主题经 postMessage 回传） ===
function openThemeGallery() {
    const e = els();
    const cur = S.currentConfig?.theme || 'web-ui';
    e.themeGalleryFrame.src = `/base/theme-showcase.html?current=${encodeURIComponent(cur)}`;
    e.themeGalleryModal.classList.remove('hidden');
}

function closeThemeGallery() {
    els().themeGalleryModal.classList.add('hidden');
}

function handleGalleryThemeSelected(themeId) {
    if (!S.currentProject) { showToast(t('请先选择项目')); return; }
    if (!S.themes.some((t) => t.id === themeId)) return;
    selectTheme(themeId); // 标记主题卡 active 并经配置 API 保存 + 刷新预览
    showToast(t('主题已切换为「{name}」', { name: S.themes.find((t) => t.id === themeId).name }));
}

async function deleteProject(name) {
    if (!(await showConfirmModal({ title: t('删除项目'), message: t('确定删除项目 {name} 吗？项目文件将被移除，此操作不可恢复。', { name }), confirmText: t('删除'), danger: true }))) return;
    try {
        await api('DELETE', `/api/projects/${encodeURIComponent(name)}`);
        if (S.currentProject === name) { S.currentProject = null; els().projectPanel.classList.add('hidden'); els().emptyState.classList.remove('hidden'); }
        await loadProjects(); showToast(t('项目已删除'));
    } catch (err) { showToast(t('删除项目失败：{msg}', { msg: err.message })); }
}

// === Tags ===
export function showTagsPanel() { _cb.hideAllMainPanels(); document.getElementById('tags-panel').classList.remove('hidden'); loadTags(); }

async function loadTags() {
    try { const data = await api('GET', '/api/vault/tags'); S.vaultTags = data.tags || {}; renderTagCloud(); renderTagDetail(); }
    catch (e) { console.error('Failed to load tags:', e); showToast(t('加载标签失败')); }
}

function renderTagCloud() {
    const el = document.getElementById('tags-cloud');
    const entries = Object.entries(S.vaultTags || {}).map(([tag, info]) => ({ tag, count: (info.notes?.length || 0) + (info.cards?.length || 0) + (info.fragments?.length || 0) })).filter((e) => e.count > 0).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    if (!entries.length) { el.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('暂无标签')}</div>`; return; }
    const max = entries[0].count;
    el.innerHTML = entries.map((e) => { const r = e.count / max; const t = r > 0.66 ? 'tags-chip-lg' : r > 0.33 ? 'tags-chip-md' : ''; const a = e.tag === S.currentTag ? ' active' : ''; return `<button class="tags-chip ${t}${a}" data-tag="${escapeHtmlAttr(e.tag)}" style="opacity:${(0.55 + r * 0.45).toFixed(2)};">#${escapeHtml(e.tag)}<span class="tags-chip-count">${e.count}</span></button>`; }).join('');
}

function renderTagDetail() {
    const detail = document.getElementById('tags-detail');
    if (!S.currentTag || !S.vaultTags || !S.vaultTags[S.currentTag]) { detail.classList.add('hidden'); return; }
    detail.classList.remove('hidden');
    document.getElementById('tags-detail-name').textContent = S.currentTag;
    const info = S.vaultTags[S.currentTag];
    renderTagColumn('tags-detail-notes', info.notes, 'note');
    renderTagColumn('tags-detail-cards', info.cards, 'card');
    renderTagColumn('tags-detail-fragments', info.fragments, 'fragment');
}

function tagItemInfo(item) {
    if (typeof item === 'string') return { id: item, label: item };
    return { id: String(item.id || item.name || ''), label: String(item.title || item.name || item.id || '') };
}

function renderTagColumn(elId, items, type) {
    const el = document.getElementById(elId);
    const list = Array.isArray(items) ? items : [];
    if (!list.length) { el.innerHTML = `<div style="opacity:0.5;font-size:12px;">${t('暂无')}</div>`; return; }
    const badge = { note: t('笔记'), card: t('卡片'), fragment: t('碎片') }[type];
    el.innerHTML = list.map((item) => { const { id, label } = tagItemInfo(item); return `<div class="tags-item" data-type="${type}" data-id="${escapeHtmlAttr(id)}"><span class="tags-item-name">${escapeHtml(label)}</span><span class="tags-item-badge">${badge}</span></div>`; }).join('');
}

function openTagItem(type, id) {
    if (!id) return;
    if (type === 'note') { _cb.switchSidebarTab('vault'); _cb.selectNote(id); }
    else if (type === 'card') { _cb.switchSidebarTab('cards'); _cb.loadCards().then(() => _cb.selectCard(id)); }
    else if (type === 'fragment') { _cb.switchSidebarTab('fragments'); showToast(t('已切换到速记')); }
}

// === Dashboard ===
export async function loadDashboard() {
    try {
        const data = await api('GET', '/api/dashboard');
        S.inboxFragments = data.inboxFragments ?? 0;
        S.dueCards = data.dueCards ?? 0;
        renderDashboard(data);
        updateTabBadges();
    }
    catch (e) { console.error('Failed to load dashboard:', e); showToast(t('加载工作台数据失败')); }
}

function relativeTime(iso) {
    const ts = new Date(iso).getTime(); if (!ts) return '';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return t('刚刚'); if (m < 60) return t('{n} 分钟前', { n: m });
    const h = Math.floor(m / 60); if (h < 24) return t('{n} 小时前', { n: h });
    const d = Math.floor(h / 24); if (d < 7) return t('{n} 天前', { n: d });
    return new Date(iso).toLocaleDateString();
}

function renderDashboard(data) {
    document.getElementById('dash-stat-today').textContent = data.todayFragments ?? 0;
    document.getElementById('dash-stat-inbox').textContent = data.inboxFragments ?? 0;
    document.getElementById('dash-stat-due').textContent = data.dueCards ?? 0;
    document.getElementById('dash-stat-mistakes').textContent = data.lowMasteryMistakes ?? 0;

    // Recent projects (top 5 by lastGeneratedAt, fallback to name)
    const listEl = document.getElementById('dashboard-recent-list');
    if (!listEl) return;
    const recentProjects = [...(S.projects || [])]
        .sort((a, b) => {
            if (a.lastGeneratedAt && b.lastGeneratedAt) return new Date(b.lastGeneratedAt) - new Date(a.lastGeneratedAt);
            if (a.lastGeneratedAt) return -1;
            if (b.lastGeneratedAt) return 1;
            return a.name.localeCompare(b.name);
        })
        .slice(0, 5);

    if (!recentProjects.length) {
        listEl.innerHTML = `<div style="grid-column:1/-1;padding:24px;text-align:center;font-size:13px;color:var(--ink);opacity:0.5;">${t('暂无项目，点击上方「+ 新建 PPT」开始')}</div>`;
    } else {
        listEl.innerHTML = recentProjects.map((p) => {
            const coverUrl = `/projects/${encodeURIComponent(p.name)}/cover.png?t=${encodeURIComponent(p.lastGeneratedAt || '')}`;
            return `<div class="recent-project-card" data-name="${escapeHtmlAttr(p.name)}">
                <img class="recent-project-cover" src="${coverUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling?.classList.remove('hidden');">
                <div class="recent-project-placeholder hidden">📊</div>
                <div class="recent-project-info">
                    <div class="recent-project-name">${escapeHtml(p.title || p.name)}</div>
                    <div class="recent-project-meta">${statusLabel(p.status)}${p.lastGeneratedAt ? ' · ' + relativeTime(p.lastGeneratedAt) : ''}</div>
                </div>
            </div>`;
        }).join('');

        listEl.querySelectorAll('.recent-project-card').forEach((card) => {
            card.addEventListener('click', () => _cb.selectProject(card.dataset.name));
        });
    }

    const counts = data.counts || {};
    document.getElementById('dashboard-counts').innerHTML = [[t('笔记'), counts.notes], [t('知识卡片'), counts.cards], [t('测验'), counts.exams], [t('错题'), counts.mistakes], [t('项目'), counts.projects]].map(([l, n]) => `<div class="dashboard-count-row"><span>${l}</span><strong>${Number(n) || 0}</strong></div>`).join('');
}

export function updateTabBadges() {
    // Update sidebar tab badges with pending counts
    const inboxCount = S.inboxFragments ?? 0;
    const dueCards = S.dueCards ?? 0;
    if (inboxCount > 0) setBadge('badge-fragments', inboxCount);
    else hideBadge('badge-fragments');
    if (dueCards > 0) {
        setBadge('badge-cards', dueCards);
        setBadge('badge-study', dueCards);
    } else {
        hideBadge('badge-cards');
        hideBadge('badge-study');
    }
}

function setBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count > 99 ? '99+' : count;
    el.classList.remove('hidden');
}

function hideBadge(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
}

export function bindDashboardEvents() {
    document.getElementById('btn-dash-new-ppt')?.addEventListener('click', openCreateModal);
    document.getElementById('btn-dash-journal')?.addEventListener('click', () => _cb.openTodayNote());
    document.getElementById('btn-dash-write')?.addEventListener('click', () => _cb.focusFragmentInput());
    document.getElementById('btn-dash-organize')?.addEventListener('click', () => _cb.openOrganizeModal());
    document.getElementById('btn-dash-smart-exam')?.addEventListener('click', () => _cb.openSmartExamModal());
    document.getElementById('btn-dash-graph')?.addEventListener('click', () => _cb.showGraphPanel());
}

// === Main Event Binding ===
export function bindEvents() {
    const e = els();
    window.addEventListener('message', (ev) => {
        const data = ev.data || {};
        if (data.type === 'ai-ppt:edit-saved') handleEditSaved(data.html);
        else if (data.type === 'ai-ppt:edit-cancelled') handleEditCancelled();
        else if (data.type === 'ai-ppt:select-theme') handleGalleryThemeSelected(data.theme);
    });
    if (e.btnThemeGallery) e.btnThemeGallery.addEventListener('click', openThemeGallery);
    if (e.btnCloseThemeGallery) e.btnCloseThemeGallery.addEventListener('click', closeThemeGallery);
    document.querySelector('#theme-gallery-modal .modal-backdrop')?.addEventListener('click', closeThemeGallery);
    if (e.btnEditMode) e.btnEditMode.addEventListener('click', toggleEditMode);
    if (e.btnCollapseSidebar) e.btnCollapseSidebar.addEventListener('click', toggleSidebarCollapse);
    // Create modal name validation live feedback
    document.getElementById('new-project-name')?.addEventListener('input', (ev) => {
        updateNameValidity(ev.target.value.trim());
    });
    if (e.btnCreateProject) e.btnCreateProject.addEventListener('click', openCreateModal);
    if (e.exportDropdown) {
        const btn = e.exportDropdown.querySelector('#btn-export');
        if (btn) btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleExportDropdown(); });
        document.addEventListener('click', () => closeExportDropdown());
    }
    e.tabs.forEach((t) => t.addEventListener('click', () => setSourceTab(t.dataset.source)));
    document.querySelectorAll('#pipeline-bar .pipeline-step').forEach((step) => step.addEventListener('click', () => handlePipelineStep(step.dataset.stage)));
    const vsge = document.querySelector('.vault-source-groups');
    if (vsge) {
        vsge.addEventListener('change', (ev) => { const cb = ev.target.closest('input[type="checkbox"][data-group]'); if (!cb) return; const g = cb.dataset.group; const arr = vaultSourceSelection[g] || (vaultSourceSelection[g] = []); const idx = arr.indexOf(cb.value); if (cb.checked && idx < 0) arr.push(cb.value); if (!cb.checked && idx >= 0) arr.splice(idx, 1); updateVaultSourceActions(); });
        vsge.addEventListener('input', (ev) => { const f = ev.target.closest('.vault-source-filter'); if (f) renderVaultSourceGroup(f.dataset.group); });
    }
    document.getElementById('btn-vault-source-collect')?.addEventListener('click', collectVaultSource);
    document.getElementById('btn-vault-source-review-deck')?.addEventListener('click', () => _cb.openReviewDeckModal(vaultSourceSelection.mistakes.length ? 'mistakes' : 'cards'));
    e.inputModelPreset.addEventListener('change', () => {
        const preset = S.models.find((m) => m.id === e.inputModelPreset.value);
        if (!preset) return;
        if (preset.id === 'custom') { e.inputModelProvider.value = 'openai'; e.inputModelName.value = ''; e.inputModelBaseUrl.value = ''; }
        else { e.inputModelProvider.value = preset.provider || ''; ensureModelOption(preset.model); e.inputModelBaseUrl.value = preset.baseUrl || ''; }
        updateModelPresetUI(preset.id);
    });
    e.btnRefreshModels.addEventListener('click', refreshModelList);
    e.inputImageModelProvider.addEventListener('change', () => updateMediaProviderUI('image'));
    e.inputVideoModelProvider.addEventListener('change', () => updateMediaProviderUI('video'));
    e.btnTestImageModel.addEventListener('click', () => testMediaModel('image'));
    e.btnTestVideoModel.addEventListener('click', () => testMediaModel('video'));
    e.btnSaveModelConfig?.addEventListener('click', saveGlobalModelConfig);
    document.getElementById('btn-backup-now')?.addEventListener('click', backupNow);
    e.btnCreateSnapshot.addEventListener('click', createSnapshotNow);
    e.btnToggleChat.addEventListener('click', toggleChatDock);
    // Fullscreen preview toggle (button + F key when in project panel)
    document.getElementById('btn-fullscreen-preview')?.addEventListener('click', () => {
        const canvas = document.querySelector('.workspace-canvas');
        const isFs = !!canvas?.classList.contains('fullscreen');
        if (!isFs && canvas) { canvas.classList.add('fullscreen'); }
        else if (canvas) { canvas.classList.remove('fullscreen'); }
    });

    // Esc exits fullscreen preview (check no modal is open first)
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
            const anyModalOpen = document.querySelector('.modal:not(.hidden), .help-panel:not(.hidden)');
            if (!anyModalOpen && document.querySelector('.workspace-canvas.fullscreen')) {
                document.querySelector('.workspace-canvas.fullscreen').classList.remove('fullscreen');
            }
        }
    });
    e.btnDesignLint?.addEventListener('click', runDesignLint);
    e.btnChatSend.addEventListener('click', sendChatMessage);
    e.chatInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); sendChatMessage(); } });
    e.btnImportMd.addEventListener('click', () => e.inputMdFile.click());
    e.inputMdFile.addEventListener('change', () => {
        const file = e.inputMdFile.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { e.inputArticle.value = reader.result || ''; showToast(t('已导入 {name}', { name: file.name })); e.inputMdFile.value = ''; };
        reader.onerror = () => showToast(t('文件读取失败'));
        reader.readAsText(file);
    });
    e.inputGlobalSearch.addEventListener('input', (ev) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => performSearch(ev.target.value), 300); });
    e.inputGlobalSearch.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { closeSearchResults(); e.inputGlobalSearch.blur(); } });
    document.addEventListener('click', (ev) => { if (!ev.target.closest('.topbar-search')) closeSearchResults(); });
    e.configTabs.forEach((tab) => tab.addEventListener('click', () => {
        e.configTabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.config-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab));
    }));
    e.btnSave.addEventListener('click', saveConfig);
    e.btnSaveTheme.addEventListener('click', saveConfig);
    e.btnSaveAnimation.addEventListener('click', saveConfig);
    e.btnApplyThemeVars.addEventListener('click', applyThemeOverrides);
    e.btnClearThemeVars.addEventListener('click', clearThemeOverrides);
    e.btnGenerate.addEventListener('click', generate);
    e.btnPreview.addEventListener('click', openPreview);
    e.btnOpenPreview.addEventListener('click', openPreview);
    e.btnPublish.addEventListener('click', doPublish);
    if (e.btnCreate) e.btnCreate.addEventListener('click', openCreateModal);
    e.newProjectName?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); createProject(); }
    });
    e.newProjectTitle?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); createProject(); }
    });
    e.btnCancelCreate.addEventListener('click', () => e.createModal.classList.add('hidden'));
    e.btnConfirmCreate.addEventListener('click', createProject);
    if (e.btnGenerateContent) e.btnGenerateContent.addEventListener('click', generate);
    if (e.btnOpenPreviewHeader) e.btnOpenPreviewHeader.addEventListener('click', openPreview);
    const dd = e.exportDropdown;
    dd?.querySelector('#dropdown-export-pptx')?.addEventListener('click', exportPptx);
    dd?.querySelector('#dropdown-export-pptx-image')?.addEventListener('click', exportPptxImage);
    dd?.querySelector('#dropdown-export-pdf')?.addEventListener('click', () => { if (S.currentProject) window.open(`/projects/${encodeURIComponent(S.currentProject)}/`, '_blank'); });
    dd?.querySelector('#dropdown-export-pdf-vector')?.addEventListener('click', exportPdfVector);
    dd?.querySelector('#dropdown-export-html')?.addEventListener('click', exportHtml);
    dd?.querySelector('#dropdown-export-video')?.addEventListener('click', exportVideo);
    dd?.querySelector('#dropdown-export-site')?.addEventListener('click', exportSite);
    e.btnPublishQuick?.addEventListener('click', doPublish);
    document.getElementById('btn-close-publish-modal')?.addEventListener('click', closePublishModal);
    document.getElementById('btn-copy-publish-url')?.addEventListener('click', copyPublishUrl);
    document.querySelector('#publish-modal .modal-backdrop')?.addEventListener('click', closePublishModal);
    e.btnHelp.addEventListener('click', openHelpPanel);
    e.btnCloseHelp.addEventListener('click', closeHelpPanel);
    e.helpOverlay.addEventListener('click', closeHelpPanel);
    if (e.btnSettings) e.btnSettings.addEventListener('click', () => _cb.switchSidebarTab('settings'));

    // Tags panel delegation
    document.getElementById('tags-cloud')?.addEventListener('click', (ev) => {
        const chip = ev.target.closest('.tags-chip');
        if (chip) { S.currentTag = chip.dataset.tag; renderTagCloud(); renderTagDetail(); }
    });
    document.getElementById('tags-detail')?.addEventListener('click', (ev) => {
        const item = ev.target.closest('.tags-item');
        if (item) openTagItem(item.dataset.type, item.dataset.id);
    });
    document.getElementById('btn-tags-back')?.addEventListener('click', () => { document.getElementById('tags-panel').classList.add('hidden'); _cb.switchSidebarTab(S.currentSidebarTab); });

    // Keyboard shortcuts
    document.addEventListener('keydown', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'n') { ev.preventDefault(); _cb.focusFragmentInput(); return; }
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'o') { ev.preventDefault(); _cb.openQuickOpen(); return; }
        const key = ev.key.toLowerCase();
        const isMod = ev.ctrlKey || ev.metaKey;
        // Ctrl+S 按上下文分派：知识库 tab 且打开了笔记 → 保存笔记；否则保存项目配置
        if (isMod && key === 's') {
            ev.preventDefault();
            if (S.currentSidebarTab === 'vault' && S.currentNote && _cb.saveCurrentNote) _cb.saveCurrentNote();
            else saveConfig();
            return;
        }
        if (isInputActive()) { if (ev.key === 'Escape') handleEscapeKey(); return; }
        if (key === '?') { ev.preventDefault(); els().helpPanel.classList.contains('hidden') ? openHelpPanel() : closeHelpPanel(); return; }
        if (key === 'escape') { handleEscapeKey(); return; }
        if (isMod && key === 'n') { ev.preventDefault(); e.createModal.classList.remove('hidden'); return; }
        if (isMod && key === 'k') { ev.preventDefault(); e.inputGlobalSearch.focus(); return; }
        if (isMod && key === 'p') { ev.preventDefault(); openExportDropdown(); return; }
        if (isMod && key === 'g') { ev.preventDefault(); if (S.currentProject && !e.btnGenerate.disabled) generate(); return; }
        if (isMod && key === 'o') { ev.preventDefault(); if (S.currentProject && !e.btnPreview.disabled) openPreview(); return; }
        if (key === 'tab' && !ev.shiftKey) {
            const inConfig = document.activeElement?.closest('.workspace-config');
            if (!inConfig) return;
            const activeTab = document.querySelector('.config-tab.active');
            if (activeTab) { ev.preventDefault(); const tabs = Array.from(e.configTabs); tabs[(tabs.indexOf(activeTab) + 1) % tabs.length].click(); }
        }
    });
}
