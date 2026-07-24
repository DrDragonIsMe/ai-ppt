// web/js/modules/generate.mjs — 统一「生成」入口（#gen-modal）
// 各入口（笔记/多选笔记/星图节点/星图选区/卡片/错题）只负责组装来源参数，
// 收集来源 → 调 API → 进度反馈的逻辑全部收敛在本模块。
import { api, showToast, escapeHtml, escapeHtmlAttr, withLlmSettingsHint } from './state.mjs';

// 外部回调（通过 initGenerateModule 注入）
let _cb = {};

export function initGenerateModule(callbacks) {
    _cb = callbacks; // { loadProjects, selectProject }
}

// ============================================================
// 来源配置（由调用方传入 openGenerateModal）
//   { kind: 'note',   name }                 单篇笔记（笔记工具栏 / 星图节点）
//   { kind: 'notes',  notes: [...], onDone } 多选笔记
//   { kind: 'graph',  nodes: [...], onDone } 星图选区节点（仅 PPT）
//   { kind: 'review', reviewType: 'cards'|'mistakes' } 复习 PPT（仅 PPT）
// ============================================================
let genSource = null;
let genPollTimer = null;
let genEventSource = null;

function getGenEls() {
    return {
        modal: document.getElementById('gen-modal'),
        title: document.getElementById('gen-modal-title'),
        source: document.getElementById('gen-source'),
        typeField: document.getElementById('gen-type-field'),
        paramsPpt: document.getElementById('gen-params-ppt'),
        pptExtraParams: document.getElementById('gen-ppt-extra-params'),
        projectNameField: document.getElementById('gen-project-name-field'),
        projectName: document.getElementById('gen-project-name'),
        paramsVideo: document.getElementById('gen-params-video'),
        paramsReport: document.getElementById('gen-params-report'),
        result: document.getElementById('gen-result'),
        confirmBtn: document.getElementById('btn-confirm-gen'),
        cancelBtn: document.getElementById('btn-cancel-gen')
    };
}

function defaultProjectName(prefix) {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `${prefix}-${ymd}`;
}

function currentGenType() {
    return document.querySelector('input[name="gen-type"]:checked')?.value || 'ppt';
}

export function openGenerateModal(source) {
    if (!source || !source.kind) return;
    if (source.kind === 'notes' && !source.notes?.length) { showToast('请先勾选笔记'); return; }
    if (source.kind === 'graph' && !source.nodes?.length) { showToast('请先用 Shift+点击选择节点'); return; }
    genSource = source;
    const e = getGenEls();

    // 来源摘要
    if (source.kind === 'note') {
        e.title.textContent = '生成';
        e.source.innerHTML = `<div>笔记「${escapeHtml(source.name)}」</div>`;
    } else if (source.kind === 'notes') {
        e.title.textContent = '生成';
        e.source.innerHTML = source.notes.map((n) => `<div>${escapeHtml(n)}</div>`).join('');
    } else if (source.kind === 'graph') {
        e.title.textContent = '生成';
        e.source.textContent = `已选 ${source.nodes.length} 个星图节点：${source.nodes.join('、')}`;
    } else if (source.kind === 'review') {
        e.title.textContent = '生成复习 PPT';
        e.source.textContent = source.reviewType === 'mistakes' ? '错题集（全部错题）' : '知识卡片（全部卡片）';
    }

    // 类型与参数区：仅 PPT 的来源隐藏类型选择与附加参数
    const pptOnly = source.kind === 'graph' || source.kind === 'review';
    e.typeField.classList.toggle('hidden', pptOnly);
    document.querySelector('input[name="gen-type"][value="ppt"]').checked = true;
    e.pptExtraParams.classList.toggle('hidden', source.kind !== 'notes');
    // 单篇笔记 PPT 走 /generate-ppt 路由，项目名由服务端派生，无需填写
    const needProjectName = !(source.kind === 'note');
    e.projectNameField.classList.toggle('hidden', !needProjectName);
    if (needProjectName) {
        if (source.kind === 'review') e.projectName.value = defaultProjectName(`review-${source.reviewType}`);
        else if (source.kind === 'graph') e.projectName.value = defaultProjectName('graph');
        else e.projectName.value = defaultProjectName('notes-deck');
    }

    updateGenParamsVisibility();
    e.result.classList.add('hidden');
    e.result.innerHTML = '';
    e.confirmBtn.disabled = false;
    e.confirmBtn.classList.remove('hidden');
    e.cancelBtn.textContent = '取消';
    e.modal.classList.remove('hidden');
}

function closeGenerateModal() {
    const e = getGenEls();
    if (genPollTimer) { clearInterval(genPollTimer); genPollTimer = null; }
    if (genEventSource) { genEventSource.close(); genEventSource = null; }
    genSource = null;
    e.modal.classList.add('hidden');
}

function updateGenParamsVisibility() {
    const e = getGenEls();
    const type = currentGenType();
    e.paramsPpt.classList.toggle('hidden', type !== 'ppt');
    e.paramsVideo.classList.toggle('hidden', type !== 'video');
    e.paramsReport.classList.toggle('hidden', type !== 'report');
}

function showGenResult(html) {
    const e = getGenEls();
    e.result.innerHTML = html;
    e.result.classList.remove('hidden');
    e.cancelBtn.textContent = '关闭';
}

function confirmGenerate() {
    if (!genSource) return;
    const type = currentGenType();
    const notes = genSource.kind === 'note' ? [genSource.name] : genSource.notes;
    if (genSource.kind === 'review') return startReviewDeck();
    if (genSource.kind === 'graph') return startGraphDeck();
    if (type === 'video') return startVideoFromNotes(notes);
    if (type === 'report') return startReportFromNotes(notes);
    if (genSource.kind === 'note') return startDeckFromNote(genSource.name);
    return startDeckFromNotes(notes);
}

// ============================================================
// PPT：单篇笔记（服务端派生项目名，fire-and-forget）
// ============================================================
async function startDeckFromNote(noteName) {
    const e = getGenEls();
    e.confirmBtn.disabled = true;
    try {
        await api('POST', `/api/vault/notes/${encodeURIComponent(noteName)}/generate-ppt`, { includeLinked: false });
        const projectName = noteName.replace(/[^\w一-龥-]/g, '-');        closeGenerateModal();
        showToast(`生成已开始（${projectName}），请在项目列表中查看进度`);
        if (_cb.loadProjects) _cb.loadProjects();
    } catch (err) {
        showGenResult(`<div class="note-gen-error">生成启动失败：${escapeHtml(err.message)}</div>`);
        e.confirmBtn.disabled = false;
    }
}

// ============================================================
// PPT：多选笔记（SSE 进度，完成后跳转到项目）
// ============================================================
async function startDeckFromNotes(notes) {
    const e = getGenEls();
    const projectName = e.projectName.value.trim();
    if (!projectName) { showToast('请输入项目标识'); return; }
    const params = {
        slideCount: parseInt(document.getElementById('gen-slide-count').value, 10) || 8,
        audience: document.getElementById('gen-audience').value.trim(),
        style: document.getElementById('gen-style').value.trim()
    };
    e.confirmBtn.disabled = true;
    showGenResult('<div class="note-gen-progress">正在启动生成…</div>');
    try {
        await api('POST', '/api/vault/notes/generate-deck', { notes, projectName, params });
    } catch (err) {
        showGenResult(`<div class="note-gen-error">生成启动失败：${escapeHtml(err.message)}</div>`);
        e.confirmBtn.disabled = false;
        return;
    }
    const onDone = genSource?.onDone;
    const progressEl = getGenEls().result.querySelector('.note-gen-progress');
    const es = new EventSource(`/api/projects/${encodeURIComponent(projectName)}/generate/events`);
    genEventSource = es;
    es.onmessage = (ev) => {
        let event;
        try { event = JSON.parse(ev.data); } catch { event = { type: 'log', message: ev.data }; }
        if (event.type === 'progress' || event.type === 'log' || event.type === 'stderr') {
            if (progressEl) { progressEl.textContent += `${event.message || ''}\n`; progressEl.scrollTop = progressEl.scrollHeight; }
        } else if (event.type === 'error') {
            es.close(); genEventSource = null;
            showGenResult(`<div class="note-gen-error">生成失败：${escapeHtml(withLlmSettingsHint(event.message))}</div>`);
            e.confirmBtn.disabled = false;
        } else if (event.type === 'done') {
            es.close(); genEventSource = null;
            closeGenerateModal();
            showToast(`PPT 生成完成（${projectName}）`);
            if (onDone) onDone();
            if (_cb.loadProjects) _cb.loadProjects().then(() => { if (_cb.selectProject) _cb.selectProject(projectName); });
        }
    };
    es.onerror = () => {
        es.close(); genEventSource = null;
        showGenResult('<div class="note-gen-error">进度连接中断，请稍后到 PPT 作品列表查看结果。</div>');
        e.confirmBtn.disabled = false;
    };
}

// ============================================================
// PPT：星图选区（fire-and-forget）
// ============================================================
async function startGraphDeck() {
    const e = getGenEls();
    const projectName = e.projectName.value.trim();
    if (!projectName) { showToast('请输入项目标识'); return; }
    const { nodes, onDone } = genSource;
    e.confirmBtn.disabled = true;
    try {
        await api('POST', '/api/vault/graph/generate-deck', { nodes, projectName });
        closeGenerateModal();
        showToast('已开始生成，可在项目列表查看进度');
        if (onDone) onDone();
        if (_cb.loadProjects) _cb.loadProjects();
    } catch (err) {
        showGenResult(`<div class="note-gen-error">生成失败：${escapeHtml(err.message)}</div>`);
        e.confirmBtn.disabled = false;
    }
}

// ============================================================
// PPT：复习课件（卡片 / 错题，fire-and-forget）
// ============================================================
async function startReviewDeck() {
    const e = getGenEls();
    const projectName = e.projectName.value.trim();
    if (!projectName) { showToast('请输入项目标识'); return; }
    e.confirmBtn.disabled = true;
    try {
        await api('POST', '/api/vault/review-deck', { type: genSource.reviewType, projectName });
        closeGenerateModal();
        showToast('已开始生成，可在项目列表查看');
        if (_cb.loadProjects) _cb.loadProjects();
    } catch (err) {
        showGenResult(`<div class="note-gen-error">生成复习 PPT 失败：${escapeHtml(err.message)}</div>`);
        e.confirmBtn.disabled = false;
    }
}

// ============================================================
// 视频：笔记（异步任务轮询）
// ============================================================
async function startVideoFromNotes(notes) {
    const e = getGenEls();
    const prompt = document.getElementById('gen-video-prompt').value.trim();
    e.confirmBtn.disabled = true;
    showGenResult('<div class="note-gen-progress">视频生成中，通常需要几分钟…</div>');
    let taskId;
    try {
        const data = await api('POST', '/api/vault/notes/generate-video', { notes, ...(prompt ? { prompt } : {}) });
        taskId = data.taskId;
    } catch (err) {
        showGenResult(`<div class="note-gen-error">视频生成启动失败：${escapeHtml(err.message)}</div>`);
        e.confirmBtn.disabled = false;
        return;
    }
    // 进度区加「取消」按钮
    showGenResult('<div class="note-gen-progress">视频生成中，通常需要几分钟… <button id="btn-gen-cancel-video" class="btn-secondary" style="padding:4px 10px;font-size:12px;">取消</button></div>');
    document.getElementById('btn-gen-cancel-video')?.addEventListener('click', async () => {
        try {
            await api('POST', `/api/media/tasks/${encodeURIComponent(taskId)}/cancel`);
        } catch { /* 任务可能已结束，轮询会收敛到终态 */ }
    });
    genPollTimer = setInterval(async () => {
        const stop = (html) => {
            clearInterval(genPollTimer); genPollTimer = null;
            showGenResult(html);
            e.confirmBtn.disabled = false;
        };
        try {
            const t = await api('GET', `/api/media/tasks/${encodeURIComponent(taskId)}`);
            if (t.status === 'done') {
                clearInterval(genPollTimer); genPollTimer = null;
                showGenResult(`<video controls src="${escapeHtmlAttr(t.webPath)}" class="note-gen-video"></video><div style="margin-top:8px;"><a href="${escapeHtmlAttr(t.webPath)}" target="_blank" rel="noopener">新窗口打开</a></div>`);
                showToast('视频生成完成');
            } else if (t.status === 'error') {
                stop(`<div class="note-gen-error">视频生成失败：${escapeHtml(t.error || t.message || '未知错误')}</div>`);
            } else if (t.status === 'cancelled') {
                stop('<div class="note-gen-progress">视频生成已取消。</div>');
            } else if (t.status === 'interrupted') {
                stop('<div class="note-gen-error">服务已重启，任务中断，请重试。</div>');
                showToast('服务已重启，任务中断，请重试', 'error');
            }
        } catch (err) {
            // 任务未知（404 + status:'unknown'）多为服务重启后任务丢失
            if (err.status === 404 && err.data && err.data.status === 'unknown') {
                stop('<div class="note-gen-error">服务已重启，任务中断，请重试。</div>');
                showToast('服务已重启，任务中断，请重试', 'error');
                return;
            }
            clearInterval(genPollTimer); genPollTimer = null;
            showGenResult(`<div class="note-gen-error">查询视频任务失败：${escapeHtml(err.message)}</div>`);
            e.confirmBtn.disabled = false;
        }
    }, 3000);
}

// ============================================================
// 报告：笔记（同步生成，modal 内渲染 + 客户端导出 HTML）
// ============================================================
async function startReportFromNotes(notes) {
    const e = getGenEls();
    const title = document.getElementById('gen-report-title').value.trim();
    const name = document.getElementById('gen-report-name').value.trim();
    e.confirmBtn.disabled = true;
    showGenResult('<div class="note-gen-progress">正在生成报告…</div>');
    try {
        const data = await api('POST', '/api/vault/notes/generate-report', { notes, ...(title ? { title } : {}), ...(name ? { name } : {}) });
        const reportName = data.name || name || 'report';
        const contentHtml = marked.parse(escapeHtml(data.content || ''));
        showGenResult(`<div class="note-gen-report">${contentHtml}</div>
        <div style="margin-top:12px;"><button id="btn-gen-export-report" class="btn-secondary" style="padding:6px 12px;font-size:12px;">导出 HTML</button></div>`);
        document.getElementById('btn-gen-export-report')?.addEventListener('click', () => exportReportHtml(reportName, contentHtml));
        e.confirmBtn.disabled = false;
    } catch (err) {
        showGenResult(`<div class="note-gen-error">报告生成失败：${escapeHtml(err.message)}</div>`);
        e.confirmBtn.disabled = false;
    }
}

function exportReportHtml(name, contentHtml) {
    const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(name)}</title>
<style>
body { max-width: 760px; margin: 40px auto; padding: 0 20px; font-family: "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif; line-height: 1.7; color: #151A19; }
h1, h2, h3 { line-height: 1.3; }
code { background: #EDF1F0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
pre { background: #EDF1F0; padding: 12px; border-radius: 8px; overflow: auto; }
blockquote { border-left: 3px solid #439288; margin: 0; padding-left: 16px; color: #555; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #E3E9E7; padding: 6px 10px; }
</style>
</head>
<body>
${contentHtml}
</body>
</html>`;
    const blob = new Blob([doc], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    showToast('报告已导出');
}

// ============================================================
// 事件绑定（app.mjs 启动时调用一次）
// ============================================================
export function bindGenerateEvents() {
    document.getElementById('btn-cancel-gen')?.addEventListener('click', closeGenerateModal);
    document.querySelector('#gen-modal .modal-backdrop')?.addEventListener('click', closeGenerateModal);
    document.getElementById('btn-confirm-gen')?.addEventListener('click', confirmGenerate);
    document.querySelectorAll('input[name="gen-type"]').forEach((radio) => {
        radio.addEventListener('change', updateGenParamsVisibility);
    });
}
