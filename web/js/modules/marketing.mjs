// web/js/modules/marketing.mjs — 营销大纲工作台 + 批量生成进度
// API 契约（M10 后端同步实现）：
//   POST /api/marketing/outline → 202；GET /api/marketing/outline/events（SSE）
//   GET/PUT/DELETE /api/marketing/outline(s)/:id
//   POST /api/marketing/batch {outlineId,angleKeys,overwrite} → 202
//   GET /api/marketing/batch/events（SSE：{type:'deck',deckName,index,total,status} / {type:'done'}）
//   GET /api/marketing/batches · POST /api/marketing/batch/cancel
// 大纲 JSON：{id,title,createdAt,sourceIds,angleSet,product,angles:[{key,title,thesis,audience,
//            evidenceItemIds,slides:[{heading,lead,points,evidenceItemIds}],deckName}]}
import { S, api, showToast, escapeHtml, escapeHtmlAttr } from './state.mjs';
import { showConfirmModal } from './modals.mjs';
import { t } from './i18n.mjs';
import { ensureSourcesLoaded, isNotReadyError, errText } from './sources.mjs';

let _cb = {};
export function initMarketingModule(callbacks) {
    _cb = callbacks; // { switchSidebarTab, loadProjects, selectProject }
}

function relativeTime(iso) {
    const ts = new Date(iso).getTime();
    if (!ts) return '';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return t('刚刚');
    if (m < 60) return t('{m} 分钟前', { m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('{h} 小时前', { h });
    const d = Math.floor(h / 24);
    if (d < 7) return t('{d} 天前', { d });
    return new Date(iso).toLocaleDateString();
}

// ============================================================
// 子 tab 编排（sources 子 tab 由 sources.mjs 负责数据加载）
// ============================================================
export function switchMaterialsSubtab(subtab) {
    if (!['sources', 'outline', 'batch'].includes(subtab)) subtab = 'sources';
    S.marketingSubtab = subtab;
    document.querySelectorAll('.materials-subtab').forEach((el) => {
        el.classList.toggle('active', el.dataset.subtab === subtab);
    });
    document.querySelectorAll('.materials-nav-btn').forEach((el) => {
        el.classList.toggle('active', el.dataset.materialsTarget === subtab);
    });
    document.getElementById('sources-panel').classList.toggle('hidden', subtab !== 'sources');
    document.getElementById('outline-panel').classList.toggle('hidden', subtab !== 'outline');
    document.getElementById('batch-panel').classList.toggle('hidden', subtab !== 'batch');
    if (subtab === 'sources') ensureSourcesLoaded(true);
    else if (subtab === 'outline') loadOutlineTab();
    else if (subtab === 'batch') loadBatchTab();
}

// ============================================================
// 营销大纲：生成（SSE）
// ============================================================
async function loadOutlineTab() {
    await ensureSourcesLoaded();
    renderSourceChips();
    await loadOutlines();
}

function renderSourceChips() {
    const box = document.getElementById('outline-source-chips');
    if (!box) return;
    const selected = S.marketing.selectedSourceIds || (S.marketing.selectedSourceIds = []);
    if (!S.sources.list.length) {
        box.innerHTML = `<span class="chips-empty">${escapeHtml(S.sources.error ? t('素材源服务未就绪，请先在「素材源」建源') : t('还没有素材源，请先到「素材源」新建'))}</span>`;
        return;
    }
    box.innerHTML = S.sources.list.map((src) => {
        const on = src.enabled !== false && selected.includes(src.id);
        const dis = src.enabled === false ? 'disabled' : '';
        return `<label class="source-chip${on ? ' checked' : ''}"${src.enabled === false ? ' title="' + escapeHtmlAttr(t('该源已停用')) + '"' : ''}>
          <input type="checkbox" data-source-id="${escapeHtmlAttr(src.id)}" ${on ? 'checked' : ''} ${dis}>
          ${escapeHtml(src.name || src.id)}
          <span class="source-chip-type">${escapeHtml(src.type || '')}</span>
        </label>`;
    }).join('');
    box.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const id = cb.dataset.sourceId;
            const arr = S.marketing.selectedSourceIds;
            const i = arr.indexOf(id);
            if (cb.checked && i < 0) arr.push(id);
            if (!cb.checked && i >= 0) arr.splice(i, 1);
            cb.closest('.source-chip').classList.toggle('checked', cb.checked);
        });
    });
}

let outlineEs = null;

export async function generateOutline() {
    if (S.marketing.generating) return;
    const sourceIds = [...(S.marketing.selectedSourceIds || [])];
    if (!sourceIds.length) { showToast(t('请先勾选至少一个素材源'), 'error'); return; }
    const productName = document.getElementById('outline-input-product-name').value.trim();
    if (!productName) { showToast(t('请填写产品名'), 'error'); return; }
    const body = {
        sourceIds,
        title: document.getElementById('outline-input-title').value.trim(),
        angleSet: document.getElementById('outline-input-angle-set').value.trim() || 'standard',
        product: {
            name: productName,
            audience: document.getElementById('outline-input-audience').value.trim(),
            tone: document.getElementById('outline-input-tone').value.trim(),
        },
    };
    const btn = document.getElementById('btn-generate-outline');
    const progress = document.getElementById('outline-gen-progress');
    S.marketing.generating = true;
    btn.disabled = true;
    progress.classList.remove('hidden');
    progress.textContent = t('正在启动大纲生成…');
    try {
        await api('POST', '/api/marketing/outline', body);
    } catch (err) {
        finishOutlineGen(t('大纲生成启动失败：{msg}', { msg: errText(err) }), true);
        return;
    }
    outlineEs?.close();
    const es = new EventSource('/api/marketing/outline/events');
    outlineEs = es;
    es.onmessage = (ev) => {
        let event; try { event = JSON.parse(ev.data); } catch { event = { type: 'progress', message: ev.data }; }
        const message = event.message || event.step || '';
        if (event.type === 'progress') {
            progress.textContent = message || t('大纲生成中…');
        } else if (event.type === 'done') {
            es.close(); outlineEs = null;
            finishOutlineGen(t('大纲已生成'), false);
            loadOutlines();
            showToast(t('营销大纲生成完成'));
        } else if (event.type === 'error') {
            es.close(); outlineEs = null;
            finishOutlineGen(t('大纲生成失败：{msg}', { msg: message || t('未知错误') }), true);
            showToast(t('大纲生成失败：{msg}', { msg: message || t('未知错误') }), 'error');
        }
    };
    es.onerror = () => {
        if (!outlineEs) return; // 已正常结束
        es.close(); outlineEs = null;
        finishOutlineGen(t('大纲进度连接中断（后端可能未就绪），请稍后在列表中确认结果'), true);
    };
}

function finishOutlineGen(text, isError) {
    S.marketing.generating = false;
    const btn = document.getElementById('btn-generate-outline');
    const progress = document.getElementById('outline-gen-progress');
    btn.disabled = false;
    progress.classList.remove('hidden');
    progress.textContent = text;
    progress.classList.toggle('error', isError);
    if (!isError) setTimeout(() => progress.classList.add('hidden'), 5000);
}

// ============================================================
// 大纲列表
// ============================================================
async function loadOutlines() {
    const list = document.getElementById('outline-list');
    const empty = document.getElementById('outline-list-empty');
    if (list) list.innerHTML = `<div class="items-loading">${t('加载中…')}</div>`;
    try {
        const data = await api('GET', '/api/marketing/outlines');
        S.marketing.outlines = Array.isArray(data?.outlines) ? data.outlines : (Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []));
        S.marketing.outlineError = null;
    } catch (err) {
        S.marketing.outlines = [];
        S.marketing.outlineError = isNotReadyError(err) ? t('营销大纲服务尚未就绪（后端未启用或版本过旧）') : err.message;
    }
    if (list) {
        list.innerHTML = S.marketing.outlines.map(renderOutlineCardHtml).join('');
        list.querySelectorAll('[data-outline-id]').forEach((card) => {
            const id = card.dataset.outlineId;
            card.querySelector('[data-act="open"]')?.addEventListener('click', () => openOutlineEditor(id));
            card.querySelector('[data-act="delete"]')?.addEventListener('click', () => deleteOutline(id));
        });
    }
    if (empty) {
        empty.classList.remove('hidden');
        empty.textContent = S.marketing.outlineError ? `⚠️ ${S.marketing.outlineError}` : (S.marketing.outlines.length ? '' : t('还没有营销大纲。选好素材源、填好产品信息，点上方「生成大纲」开始。'));
    }
}

function renderOutlineCardHtml(o) {
    const angles = Array.isArray(o.angles) ? o.angles.length : (o.angleCount ?? '—');
    const active = S.marketing.currentOutline && S.marketing.currentOutline.id === o.id ? ' active' : '';
    return `<div class="outline-card${active}" data-outline-id="${escapeHtmlAttr(o.id)}">
      <div class="outline-card-title">${escapeHtml(o.title || o.id)}</div>
      <div class="outline-card-meta">
        <span>${t('{n} 个角度', { n: angles })}</span>
        ${o.product?.name ? `<span>· ${escapeHtml(o.product.name)}</span>` : ''}
        ${o.createdAt ? `<span>· ${escapeHtml(relativeTime(o.createdAt))}</span>` : ''}
      </div>
      <div class="outline-card-actions">
        <button class="btn-primary" data-act="open">${t('打开编辑')}</button>
        <button class="btn-secondary btn-danger-text" data-act="delete">${t('删除')}</button>
      </div>
    </div>`;
}

async function deleteOutline(id) {
    const o = S.marketing.outlines.find((x) => x.id === id);
    const ok = await showConfirmModal({
        title: t('删除大纲'),
        message: t('确定删除营销大纲「{name}」吗？已生成的 PPT 不会被删除。', { name: o?.title || id }),
        confirmText: t('删除'),
        danger: true,
    });
    if (!ok) return;
    try {
        await api('DELETE', `/api/marketing/outline/${encodeURIComponent(id)}`);
        if (S.marketing.currentOutline?.id === id) closeOutlineEditor();
        showToast(t('已删除'));
        loadOutlines();
    } catch (err) {
        showToast(t('删除失败：{msg}', { msg: errText(err) }), 'error');
    }
}

// ============================================================
// 大纲编辑视图
// ============================================================
export async function openOutlineEditor(id) {
    let outline = null;
    try {
        const data = await api('GET', `/api/marketing/outline/${encodeURIComponent(id)}`);
        outline = data?.outline || data;
    } catch (err) {
        showToast(t('大纲加载失败：{msg}', { msg: errText(err) }), 'error');
        return;
    }
    if (!outline || outline.id == null) outline = { ...outline, id };
    S.marketing.currentOutline = outline;
    S.marketing.selectedAngleKeys = (outline.angles || []).map((a) => a.key);
    renderOutlineEditor();
}

function closeOutlineEditor() {
    S.marketing.currentOutline = null;
    const box = document.getElementById('outline-editor');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function statusBadgeClass(status) {
    const s = String(status || '').toLowerCase();
    if (['done', 'success', 'ready'].includes(s)) return 'ok';
    if (['error', 'failed'].includes(s)) return 'fail';
    if (['running', 'generating'].includes(s)) return 'run';
    return '';
}

function deckStatusLabel(status) {
    const map = { pending: '排队中', queued: '排队中', running: '生成中', generating: '生成中', done: '成功', success: '成功', ready: '成功', error: '失败', failed: '失败', cancelled: '已取消', skipped: '已跳过' };
    return map[String(status || '').toLowerCase()] ? t(map[String(status).toLowerCase()]) : String(status || '');
}

function renderOutlineEditor() {
    const box = document.getElementById('outline-editor');
    if (!box) return;
    const o = S.marketing.currentOutline;
    if (!o) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const angles = Array.isArray(o.angles) ? o.angles : [];
    box.innerHTML = `
      <div class="outline-editor-head">
        <input type="text" id="outline-edit-title" class="outline-edit-title" value="${escapeHtmlAttr(o.title || '')}" placeholder="${escapeHtmlAttr(t('大纲标题'))}">
        <div class="outline-editor-actions">
          <button id="btn-save-outline" class="btn-secondary">${t('保存')}</button>
          <button id="btn-close-outline-editor" class="btn-icon" title="${escapeHtmlAttr(t('关闭'))}">×</button>
        </div>
      </div>
      ${angles.map((a, ai) => angleEditorHtml(a, ai)).join('') || `<div class="items-loading">${escapeHtml(t('该大纲没有角度数据'))}</div>`}
      <div class="outline-editor-footer">
        <label class="outline-overwrite-row"><input type="checkbox" id="batch-input-overwrite"><span>${t('覆盖同名已有项目')}</span></label>
        <button id="btn-batch-generate" class="btn-primary"${angles.length ? '' : ' disabled'}>${t('批量生成 PPT')}</button>
      </div>`;
    box.querySelector('#btn-close-outline-editor')?.addEventListener('click', closeOutlineEditor);
    box.querySelector('#btn-save-outline')?.addEventListener('click', saveOutline);
    box.querySelector('#btn-batch-generate')?.addEventListener('click', startBatch);
    box.querySelectorAll('[data-angle-check]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const key = cb.dataset.angleCheck;
            const arr = S.marketing.selectedAngleKeys;
            const i = arr.indexOf(key);
            if (cb.checked && i < 0) arr.push(key);
            if (!cb.checked && i >= 0) arr.splice(i, 1);
        });
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function angleEditorHtml(a, ai) {
    const checked = S.marketing.selectedAngleKeys.includes(a.key) ? 'checked' : '';
    const deckBadge = a.deckName
        ? `<span class="angle-deck-badge status-${statusBadgeClass(a.deckStatus || 'done')}">${escapeHtml(a.deckName)}</span>`
        : '';
    const slides = Array.isArray(a.slides) ? a.slides : [];
    return `<div class="angle-card" data-angle-key="${escapeHtmlAttr(a.key)}">
      <div class="angle-card-head">
        <label class="angle-select-row"><input type="checkbox" data-angle-check="${escapeHtmlAttr(a.key)}" ${checked}></label>
        <span class="angle-key-badge">#${escapeHtml(a.key || String(ai + 1))}</span>
        <input type="text" class="angle-field angle-title" data-field="title" value="${escapeHtmlAttr(a.title || '')}" placeholder="${escapeHtmlAttr(t('角度标题'))}">
        ${deckBadge}
      </div>
      <textarea class="angle-field angle-thesis" data-field="thesis" rows="2" placeholder="${escapeHtmlAttr(t('核心论点'))}">${escapeHtml(a.thesis || '')}</textarea>
      ${a.audience ? `<div class="angle-audience">${t('受众')}：${escapeHtml(a.audience)}</div>` : ''}
      ${Array.isArray(a.evidenceItemIds) && a.evidenceItemIds.length ? `<div class="angle-evidence">${t('引用素材')} ${a.evidenceItemIds.length} ${t('项')}</div>` : ''}
      <div class="angle-slides">
        ${slides.map((s, si) => `<div class="angle-slide" data-slide-idx="${si}">
          <div class="angle-slide-no">${si + 1}</div>
          <div class="angle-slide-fields">
            <input type="text" class="angle-field slide-heading" data-field="heading" value="${escapeHtmlAttr(s.heading || '')}" placeholder="${escapeHtmlAttr(t('页标题'))}">
            <input type="text" class="angle-field slide-lead" data-field="lead" value="${escapeHtmlAttr(s.lead || '')}" placeholder="${escapeHtmlAttr(t('一句话导语'))}">
            <textarea class="angle-field slide-points" data-field="points" rows="3" placeholder="${escapeHtmlAttr(t('要点（每行一条）'))}">${escapeHtml(Array.isArray(s.points) ? s.points.join('\n') : (s.points || ''))}</textarea>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
}

// 把编辑器里的当前 DOM 值收集回 outline 对象（保存 / 批量生成前都调用）
function syncOutlineFromDom() {
    const o = S.marketing.currentOutline;
    const box = document.getElementById('outline-editor');
    if (!o || !box) return o;
    o.title = box.querySelector('#outline-edit-title')?.value.trim() || o.title;
    box.querySelectorAll('.angle-card').forEach((card) => {
        const key = card.dataset.angleKey;
        const angle = (o.angles || []).find((a) => String(a.key) === key);
        if (!angle) return;
        angle.title = card.querySelector('[data-field="title"]')?.value ?? angle.title;
        angle.thesis = card.querySelector('[data-field="thesis"]')?.value ?? angle.thesis;
        card.querySelectorAll('.angle-slide').forEach((slideEl, si) => {
            const slide = (angle.slides || [])[si];
            if (!slide) return;
            slide.heading = slideEl.querySelector('[data-field="heading"]')?.value ?? slide.heading;
            slide.lead = slideEl.querySelector('[data-field="lead"]')?.value ?? slide.lead;
            const raw = slideEl.querySelector('[data-field="points"]')?.value ?? '';
            slide.points = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        });
    });
    return o;
}

async function saveOutline() {
    const o = syncOutlineFromDom();
    if (!o || o.id == null) return;
    const btn = document.getElementById('btn-save-outline');
    btn.disabled = true;
    try {
        await api('PUT', `/api/marketing/outline/${encodeURIComponent(o.id)}`, o);
        showToast(t('大纲已保存'));
        loadOutlines();
    } catch (err) {
        showToast(t('大纲保存失败：{msg}', { msg: errText(err) }), 'error');
    } finally {
        btn.disabled = false;
    }
}

// ============================================================
// 批量生成
// ============================================================
let batchEs = null;

async function startBatch() {
    const o = syncOutlineFromDom();
    if (!o || o.id == null) { showToast(t('请先打开一个大纲'), 'error'); return; }
    const angleKeys = (S.marketing.selectedAngleKeys || []).filter((k) => (o.angles || []).some((a) => String(a.key) === k));
    if (!angleKeys.length) { showToast(t('请至少勾选一个角度'), 'error'); return; }
    // 勾选角度变更过标题/论点时先保存，保证后端按最新内容生成
    try { await api('PUT', `/api/marketing/outline/${encodeURIComponent(o.id)}`, o); }
    catch (err) { showToast(t('大纲保存失败：{msg}', { msg: errText(err) }), 'error'); return; }
    const overwrite = !!document.getElementById('batch-input-overwrite')?.checked;
    try {
        await api('POST', '/api/marketing/batch', { outlineId: o.id, angleKeys, overwrite });
    } catch (err) {
        showToast(t('批量生成启动失败：{msg}', { msg: errText(err) }), 'error');
        return;
    }
    S.marketing.batch = { outlineId: o.id, outlineTitle: o.title || String(o.id), total: angleKeys.length, rows: [], finished: false, cancelling: false };
    _cb.switchSidebarTab?.('materials', 'batch');
    attachBatchEvents();
}

function attachBatchEvents() {
    batchEs?.close();
    const es = new EventSource('/api/marketing/batch/events');
    batchEs = es;
    const finishBatch = (message, isError) => {
        es.close(); batchEs = null;
        if (S.marketing.batch) {
            S.marketing.batch.finished = true;
            S.marketing.batch.message = message;
            S.marketing.batch.error = !!isError;
        }
        renderBatch();
        loadBatchHistory();
        _cb.loadProjects?.(); // 新 deck 出现在作品列表
        if (isError) showToast(message, 'error');
        else if (message) showToast(message);
    };
    es.onmessage = (ev) => {
        let event; try { event = JSON.parse(ev.data); } catch { event = { type: 'log', message: ev.data }; }
        if (!S.marketing.batch) return;
        const b = S.marketing.batch;
        if (event.type === 'deck') {
            const idx = Number(event.index);
            const row = {
                deckName: event.deckName || `#${isNaN(idx) ? b.rows.length + 1 : idx + 1}`,
                index: Number.isFinite(idx) ? idx : b.rows.length,
                total: Number(event.total) || b.total,
                status: event.status || 'running',
                message: event.message || '',
            };
            const existing = b.rows.findIndex((r) => r.deckName === row.deckName);
            if (existing >= 0) b.rows[existing] = row;
            else b.rows.push(row);
            b.total = row.total || b.total;
            renderBatch();
        } else if (event.type === 'progress' || event.type === 'log') {
            b.message = event.message || b.message || '';
            renderBatch();
        } else if (event.type === 'done') {
            b.rows.forEach((r) => { if (String(r.status).toLowerCase() === 'running') r.status = 'done'; });
            finishBatch(t('批量生成完成'), false);
        } else if (event.type === 'error') {
            finishBatch(t('批量生成失败：{msg}', { msg: event.message || t('未知错误') }), true);
        }
    };
    es.onerror = () => {
        if (!batchEs) return; // 已正常结束
        batchEs = null;
        es.close();
        if (S.marketing.batch && !S.marketing.batch.finished) {
            finishBatch(t('批量生成进度连接中断（后端可能未就绪），请到作品列表确认结果'), true);
        }
    };
}

async function cancelBatch() {
    if (!S.marketing.batch || S.marketing.batch.finished) return;
    const ok = await showConfirmModal({
        title: t('取消批量生成'),
        message: t('确定取消当前批次吗？进行中的任务会被中断，已完成的项目保留。'),
        confirmText: t('取消批次'),
        danger: true,
    });
    if (!ok) return;
    S.marketing.batch.cancelling = true;
    renderBatch();
    try {
        await api('POST', '/api/marketing/batch/cancel', {});
        showToast(t('已请求取消批次'));
    } catch (err) {
        S.marketing.batch.cancelling = false;
        showToast(t('取消失败：{msg}', { msg: errText(err) }), 'error');
        renderBatch();
    }
}

async function loadBatchTab() {
    renderBatch();
    loadBatchHistory();
}

function renderBatch() {
    const active = document.getElementById('batch-active');
    const hint = document.getElementById('batch-hint');
    const b = S.marketing.batch;
    if (!active || !hint) return;
    active.classList.toggle('hidden', !b);
    hint.classList.toggle('hidden', !!b);
    if (!b) return;
    document.getElementById('batch-active-title').textContent = b.finished && !b.error
        ? t('批量生成完成') : b.error ? t('批量生成中断') : t('批量生成进行中');
    const doneCount = b.rows.filter((r) => ['done', 'success'].includes(String(r.status).toLowerCase())).length;
    const total = b.total || b.rows.length || 0;
    document.getElementById('batch-progress-text').textContent = `${doneCount} / ${total}${b.message ? ' · ' + b.message : ''}`;
    const fill = document.getElementById('batch-progress-fill');
    if (fill) fill.style.width = total ? `${Math.round((doneCount / total) * 100)}%` : '0%';
    const cancelBtn = document.getElementById('btn-batch-cancel');
    if (cancelBtn) {
        cancelBtn.classList.toggle('hidden', !!b.finished);
        cancelBtn.disabled = !!b.cancelling && !b.finished;
        cancelBtn.textContent = b.cancelling && !b.finished ? t('取消中…') : t('取消');
    }
    const goBtn = document.getElementById('btn-batch-go-projects');
    if (goBtn) goBtn.classList.toggle('hidden', !b.finished);
    const rowsBox = document.getElementById('batch-rows');
    if (rowsBox) {
        rowsBox.innerHTML = b.rows.length ? b.rows.map((r) => batchRowHtml(r)).join('')
            : `<div class="batch-row empty"><span class="batch-row-status run"><span class="spinner"></span> ${escapeHtml(t('等待后端逐页回报…'))}</span></div>`;
        rowsBox.querySelectorAll('[data-open-deck]').forEach((btn) => {
            btn.addEventListener('click', () => openBatchDeck(btn.dataset.openDeck, btn.dataset.mode));
        });
    }
}

function batchRowHtml(r) {
    const cls = statusBadgeClass(r.status);
    const isFail = cls === 'fail';
    const isOpenable = ['done', 'success', 'ready'].includes(String(r.status).toLowerCase());
    const name = escapeHtml(r.deckName);
    const actions = isOpenable
        ? `<span class="batch-row-actions">
            <button class="btn-link" data-open-deck="${escapeHtmlAttr(r.deckName)}" data-mode="preview">${t('打开预览')}</button>
            <button class="btn-link" data-open-deck="${escapeHtmlAttr(r.deckName)}" data-mode="workspace">${t('进工作区')}</button>
          </span>`
        : '';
    return `<div class="batch-row${isFail ? ' fail' : ''}">
      <span class="batch-row-idx">${Number.isFinite(r.index) ? r.index + 1 : ''}</span>
      <span class="batch-row-name" title="${escapeHtmlAttr(r.message || r.deckName)}">${name}</span>
      <span class="batch-row-status ${cls}">${escapeHtml(deckStatusLabel(r.status))}</span>
      ${actions}
    </div>`;
}

function openBatchDeck(deckName, mode) {
    if (mode === 'preview') {
        window.open(`/projects/${encodeURIComponent(deckName)}/`, '_blank');
        return;
    }
    _cb.switchSidebarTab?.('projects');
    if (_cb.selectProject) _cb.selectProject(deckName);
}

async function loadBatchHistory() {
    const box = document.getElementById('batch-history');
    const empty = document.getElementById('batch-history-empty');
    if (!box) return;
    try {
        const data = await api('GET', '/api/marketing/batches');
        S.marketing.batches = Array.isArray(data?.batches) ? data.batches : (Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []));
        S.marketing.batchError = null;
    } catch (err) {
        S.marketing.batches = [];
        S.marketing.batchError = isNotReadyError(err) ? t('批量生成服务尚未就绪（后端未启用或版本过旧）') : err.message;
    }
    box.innerHTML = S.marketing.batches.map((rec) => {
        const title = rec.outlineTitle || rec.title || rec.name || rec.outlineId || t('未命名批次');
        const time = rec.createdAt || rec.startedAt || rec.time;
        const status = rec.status || rec.state;
        const count = rec.total ?? (Array.isArray(rec.decks) ? rec.decks.length : (Array.isArray(rec.angleKeys) ? rec.angleKeys.length : ''));
        return `<div class="batch-row">
          <span class="batch-row-name">${escapeHtml(String(title))}</span>
          ${count !== '' ? `<span class="batch-row-idx">${escapeHtml(t('共 {n} 个', { n: count }))}</span>` : ''}
          ${status ? `<span class="batch-row-status ${statusBadgeClass(status)}">${escapeHtml(deckStatusLabel(status))}</span>` : ''}
          ${time ? `<span class="batch-row-meta-time">${escapeHtml(relativeTime(time))}</span>` : ''}
        </div>`;
    }).join('');
    if (empty) {
        const show = !S.marketing.batches.length;
        empty.classList.toggle('hidden', !show);
        empty.textContent = S.marketing.batchError ? `⚠️ ${S.marketing.batchError}` : t('暂无历史批次记录');
    }
}

// ============================================================
// 事件绑定（app.mjs 启动链调用一次）
// ============================================================
export function bindMarketingEvents() {
    document.querySelectorAll('.materials-subtab').forEach((el) => {
        el.addEventListener('click', () => switchMaterialsSubtab(el.dataset.subtab));
    });
    document.querySelectorAll('.materials-nav-btn').forEach((el) => {
        el.addEventListener('click', () => _cb.switchSidebarTab?.('materials', el.dataset.materialsTarget));
    });
    document.getElementById('btn-generate-outline')?.addEventListener('click', generateOutline);
    document.getElementById('btn-batch-cancel')?.addEventListener('click', cancelBatch);
    document.getElementById('btn-batch-go-projects')?.addEventListener('click', () => _cb.switchSidebarTab?.('projects'));
}
