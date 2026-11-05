// web/js/modules/sources.mjs — 素材库：多数据源管理（列表/编辑/刷新 SSE/条目抽屉/预览）
// API 契约（M9 后端同步实现）：
//   GET/POST /api/sources · PUT/DELETE /api/sources/:id
//   POST /api/sources/:id/refresh → 202；GET /api/sources/:id/refresh/events（SSE：progress|done|error）
//   GET /api/sources/:id/items → {items:[{id,title,origin,hash,bytes,tags}]}
//   GET /api/sources/items?q=&limit= · POST /api/sources/preview
import { S, api, showToast, escapeHtml, escapeHtmlAttr } from './state.mjs';
import { showConfirmModal } from './modals.mjs';
import { t } from './i18n.mjs';

let _cb = {};
export function initSourcesModule(callbacks) {
    _cb = callbacks; // { switchSidebarTab }
}

const SOURCE_TYPES = ['dir', 'url', 'site', 'vault'];

// 后端路由未注册时 server 回退 SPA 壳（2xx + text/html），api() 会在 res.json() 处抛 SyntaxError；
// 只有这种「2xx 非 JSON」才是后端未就绪的特征。真 404 说明路由已注册、资源确实不存在，
// 必须透传后端错误体而不是误报「服务未就绪」。
export function isNotReadyError(err) {
    return err instanceof SyntaxError;
}

// 集合类端点（GET /api/sources、/api/marketing/outlines、/api/marketing/batches）兼容：
// 路由未挂载时后端也可能直接回 404，空列表比报错横幅对首屏更友好，故仍降级「未就绪」空态。
export function isCollectionEmptyError(err) {
    return isNotReadyError(err) || err?.status === 404;
}

// 统一错误文案：优先信任 api() 挂到 err.data 的 JSON 错误体；SPA 壳 → 未就绪；404 → 资源不存在
export function errText(err) {
    if (isNotReadyError(err)) return t('后端服务尚未就绪（接口未注册或版本过旧）');
    if (err?.data?.error) return err.data.error;
    if (err?.status === 404) return t('资源不存在或已被删除（404）');
    return err?.message || t('未知错误');
}

function sourceTypeLabel(type) {
    const map = { dir: '本地目录', url: '网页 URL', site: '站点抓取', vault: '知识库' };
    return map[type] ? t(map[type]) : String(type || '?');
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

function formatBytes(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b <= 0) return '';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ============================================================
// 源列表
// ============================================================
export async function ensureSourcesLoaded(force = false) {
    if (!force && !S.sources.error && S.sources.list.length) return S.sources.list;
    return loadSources();
}

export async function loadSources() {
    S.sources.loading = true;
    renderSourceList();
    try {
        const data = await api('GET', '/api/sources');
        S.sources.list = Array.isArray(data?.sources) ? data.sources : (Array.isArray(data) ? data : []);
        S.sources.error = null;
    } catch (err) {
        S.sources.list = [];
        S.sources.error = isCollectionEmptyError(err)
            ? t('素材源服务尚未就绪（后端未启用或版本过旧）')
            : t('素材源加载失败：{msg}', { msg: errText(err) });
    }
    S.sources.loading = false;
    renderSourceList();
    loadSourceCounts();
    return S.sources.list;
}

// 条目计数：优先直接消费 GET /api/sources 每源返回的 itemCount（M9 契约已带，零额外请求）。
// 仅对不带该字段的后端降级为逐源取 items，且并发上限 3 + 合并重渲染，避免 N+1 风暴。
const COUNT_FETCH_CONCURRENCY = 3;
let countRenderTimer = null;

function scheduleCountRender() {
    if (countRenderTimer) return;
    countRenderTimer = setTimeout(() => { countRenderTimer = null; renderSourceList(); }, 250);
}

async function loadSourceCounts() {
    const pending = S.sources.list.filter(
        (src) => src?.id && src.itemCount == null && !(src.id in S.sources.itemsCache));
    if (!pending.length) return;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(COUNT_FETCH_CONCURRENCY, pending.length) }, async () => {
        while (cursor < pending.length) {
            const src = pending[cursor++];
            const items = await fetchSourceItems(src.id);
            if (items) scheduleCountRender();
        }
    });
    await Promise.all(workers);
}

async function fetchSourceItems(id) {
    try {
        const data = await api('GET', `/api/sources/${encodeURIComponent(id)}/items`);
        const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
        S.sources.itemsCache[id] = items;
        return items;
    } catch {
        return null;
    }
}

function renderSourceList() {
    const list = document.getElementById('source-list');
    const empty = document.getElementById('sources-empty');
    const banner = document.getElementById('sources-banner');
    if (!list || !empty) return;
    if (banner) {
        banner.classList.toggle('hidden', !S.sources.error);
        if (S.sources.error) banner.textContent = `⚠️ ${S.sources.error}`;
    }
    if (S.sources.loading) {
        list.innerHTML = '';
        empty.classList.remove('hidden');
        empty.textContent = t('加载中…');
        return;
    }
    if (!S.sources.list.length) {
        list.innerHTML = '';
        empty.classList.remove('hidden');
        empty.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'sources-empty-title';
        title.textContent = t('还没有素材源');
        const desc = document.createElement('div');
        desc.className = 'sources-empty-desc';
        desc.textContent = t('新建一个本地目录 / URL / 站点 / 知识库源，把外部资料纳入素材库');
        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.textContent = t('+ 新建源');
        btn.addEventListener('click', () => openSourceModal(null));
        empty.append(title, desc, btn);
        return;
    }
    empty.classList.add('hidden');
    list.innerHTML = S.sources.list.map((src) => sourceCardHtml(src)).join('');
    list.querySelectorAll('[data-source-id]').forEach((card) => {
        const id = card.dataset.sourceId;
        card.querySelector('[data-act="refresh"]')?.addEventListener('click', () => refreshSource(id));
        card.querySelector('[data-act="items"]')?.addEventListener('click', () => openItemsDrawer(id));
        card.querySelector('[data-act="edit"]')?.addEventListener('click', () => openSourceModal(id));
        card.querySelector('[data-act="delete"]')?.addEventListener('click', () => deleteSource(id));
    });
}

function sourceCardHtml(src) {
    const known = SOURCE_TYPES.includes(src.type);
    const cached = S.sources.itemsCache[src.id];
    // 可选跟进：maxPages 截断可观测 —— 优先消费 droppedCount（其次由 totalCandidates 推出），
    // 有确切数字就把「120+」升级为「120 · 另有 N 条未入库」，没数字时保留 + 号兜底
    const dropped = src.truncated
        ? (Number.isFinite(src.droppedCount) && src.droppedCount > 0 ? src.droppedCount
            : (Number.isFinite(src.totalCandidates) && src.itemCount != null ? Math.max(0, src.totalCandidates - src.itemCount) : 0))
        : 0;
    let count;
    if (src.itemCount != null) count = `${src.itemCount}${src.truncated && !dropped ? '+' : ''}`;
    else if (cached) count = String(cached.length);
    else count = S.sources.loading ? '…' : '—';
    const state = S.sources.refresh[src.id];
    const time = src.lastFetchedAt ? relativeTime(src.lastFetchedAt) : t('从未抓取');
    const tags = Array.isArray(src.tags) && src.tags.length
        ? src.tags.map((tag) => `<span class="source-tag">#${escapeHtml(tag)}</span>`).join('') : '';
    const stateHtml = state
        ? `<div class="source-refresh-state ${state.status}">${state.status === 'running' ? `<span class="spinner"></span> ${escapeHtml(state.message || t('抓取中…'))}` : escapeHtml(state.message || '')}</div>`
        : '';
    return `<div class="source-card${src.enabled === false ? ' disabled' : ''}" data-source-id="${escapeHtmlAttr(src.id)}">
      <div class="source-card-head">
        <span class="source-type-badge${known ? ' type-' + escapeHtmlAttr(src.type) : ''}">${escapeHtml(sourceTypeLabel(src.type))}</span>
        <span class="source-name">${escapeHtml(src.name || src.id)}</span>
        ${src.enabled === false ? `<span class="source-off-badge">${t('已停用')}</span>` : ''}
      </div>
      <div class="source-target" title="${escapeHtmlAttr(src.target || '')}">${escapeHtml(src.target || '')}</div>
      <div class="source-meta">
        <span>${t('条目')} ${count}</span><span>·</span>
        ${dropped > 0 ? `<span class="source-trunc-badge">${escapeHtml(t('另有 {n} 条未入库', { n: dropped }))}</span>` : ''}
        <span>${t('最后抓取')} ${escapeHtml(time)}</span>
      </div>
      ${tags ? `<div class="source-tags">${tags}</div>` : ''}
      ${stateHtml}
      <div class="source-card-actions">
        <button class="btn-secondary" data-act="refresh" ${state?.status === 'running' ? 'disabled' : ''}>${t('刷新')}</button>
        <button class="btn-secondary" data-act="items">${t('条目')}</button>
        <button class="btn-secondary" data-act="edit">${t('编辑')}</button>
        <button class="btn-secondary btn-danger-text" data-act="delete">${t('删除')}</button>
      </div>
    </div>`;
}

// ============================================================
// 新建 / 编辑 / 删除
// ============================================================
let editingSourceId = null;

export function openSourceModal(id) {
    editingSourceId = id || null;
    const src = id ? S.sources.list.find((s) => s.id === id) : null;
    const titleEl = document.getElementById('source-modal-title');
    if (titleEl) titleEl.textContent = src ? t('编辑素材源') : t('新建素材源');
    const opt = src?.options || {};
    const nameEl = document.getElementById('source-input-name');
    if (nameEl) nameEl.value = src?.name || '';
    const typeSel = document.getElementById('source-input-type');
    typeSel.value = src && SOURCE_TYPES.includes(src.type) ? src.type : 'dir';
    const targetEl = document.getElementById('source-input-target');
    if (targetEl) targetEl.value = src?.target || '';
    const tagsEl = document.getElementById('source-input-tags');
    if (tagsEl) tagsEl.value = Array.isArray(src?.tags) ? src.tags.join(',') : '';
    document.getElementById('source-input-enabled').checked = src ? src.enabled !== false : true;
    document.getElementById('source-input-max-pages').value = opt.maxPages ?? '';
    document.getElementById('source-input-depth').value = opt.depth ?? '';
    document.getElementById('source-input-include').value = opt.include ?? '';
    document.getElementById('source-modal')?.classList.remove('hidden');
    document.getElementById('source-input-name')?.focus();
}

function closeSourceModal() {
    document.getElementById('source-modal')?.classList.add('hidden');
    editingSourceId = null;
}

async function saveSource() {
    const name = document.getElementById('source-input-name').value.trim();
    const type = document.getElementById('source-input-type').value;
    const target = document.getElementById('source-input-target').value.trim();
    if (!name) { showToast(t('请填写源名称'), 'error'); return; }
    if (!target) { showToast(t('请填写目标路径 / 地址'), 'error'); return; }
    const options = {};
    const maxPages = document.getElementById('source-input-max-pages').value;
    const depth = document.getElementById('source-input-depth').value;
    const include = document.getElementById('source-input-include').value.trim();
    if (maxPages) options.maxPages = Number(maxPages);
    if (depth) options.depth = Number(depth);
    if (include) options.include = include;
    const body = {
        type,
        name,
        target,
        enabled: document.getElementById('source-input-enabled').checked,
        tags: document.getElementById('source-input-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        options,
    };
    const btn = document.getElementById('btn-save-source');
    btn.disabled = true;
    try {
        if (editingSourceId) {
            await api('PUT', `/api/sources/${encodeURIComponent(editingSourceId)}`, { id: editingSourceId, ...body });
            showToast(t('素材源已更新'));
        } else {
            await api('POST', '/api/sources', body);
            showToast(t('素材源已创建'));
        }
        closeSourceModal();
        await loadSources();
    } catch (err) {
        showToast(t('保存失败：{msg}', { msg: errText(err) }), 'error');
    } finally {
        btn.disabled = false;
    }
}

async function deleteSource(id) {
    const src = S.sources.list.find((s) => s.id === id);
    const ok = await showConfirmModal({
        title: t('删除素材源'),
        message: t('确定删除素材源「{name}」吗？已抓取的条目也会一并移除。', { name: src?.name || id }),
        confirmText: t('删除'),
        danger: true,
    });
    if (!ok) return;
    try {
        await api('DELETE', `/api/sources/${encodeURIComponent(id)}`);
        delete S.sources.itemsCache[id];
        delete S.sources.refresh[id];
        clearRefreshStream(id); // O2：回收在途刷新流（close + 清 Map），删源后不再往已删 id 写状态
        showToast(t('已删除'));
        await loadSources();
    } catch (err) {
        showToast(t('删除失败：{msg}', { msg: errText(err) }), 'error');
    }
}

// ============================================================
// 刷新（POST 202 → SSE progress|done|error）
// ============================================================
const refreshEventSources = new Map(); // sourceId -> EventSource
const refreshClearTimers = new Map();  // sourceId -> done 后清理状态的定时器句柄
const refreshIdleCancels = new Map();  // sourceId -> 撤销本流 idle 看门狗（被替换/结束时调用）
const refreshGens = new Map();         // sourceId -> 当前流代次（reap 不清，仅终态清）
const REFRESH_WATCHDOG_MS = 4 * 60 * 1000; // SSE 连续零事件兜底（P2-4 / r2 P1-1：idle 语义）

function clearRefreshTimer(id) {
    const t = refreshClearTimers.get(id);
    if (t) { clearTimeout(t); refreshClearTimers.delete(id); }
}

// 供子 tab / 侧边栏切换时显式回收已结束的刷新流（P2-4）
export function reapFinishedRefreshStreams() {
    for (const [id, es] of refreshEventSources) {
        if (!es || es.readyState === EventSource.CLOSED) {
            es?.close?.();
            refreshEventSources.delete(id);
        }
    }
}

// O2：删除源时整体回收在途刷新流 —— close 事件源 + 清三个 Map + 撤销延迟清理。
// 否则删掉的源仍在刷新时，流会继续往已删 id 写状态，Map 键上界随「会话内刷新过的源数」膨胀。
function clearRefreshStream(id) {
    refreshIdleCancels.get(id)?.();       // 撤销 idle 看门狗定时器（gen 失配后其回调已静默，但定时器仍挂着）
    refreshEventSources.get(id)?.close(); // close 后已入队事件不再派发（EventSource 语义）
    refreshEventSources.delete(id);
    refreshIdleCancels.delete(id);
    refreshGens.delete(id);
    clearRefreshTimer(id);
}

async function refreshSource(id) {
    const src = S.sources.list.find((s) => s.id === id);
    if (!src || S.sources.refresh[id]?.status === 'running') return;
    clearRefreshTimer(id); // 撤销上一次 done 的延迟清理，避免抹掉本次进行中状态（P2-2）
    S.sources.refresh[id] = { status: 'running', message: t('正在启动抓取…') };
    renderSourceList();
    try {
        await api('POST', `/api/sources/${encodeURIComponent(id)}/refresh`);
    } catch (err) {
        S.sources.refresh[id] = { status: 'error', message: t('启动刷新失败：{msg}', { msg: errText(err) }) };
        renderSourceList();
        return;
    }
    subscribeRefresh(id);
}

function subscribeRefresh(id) {
    clearRefreshTimer(id);
    refreshIdleCancels.get(id)?.(); // 撤销被本流替换掉的旧流看门狗（idle 语义下该路径可达）
    refreshEventSources.get(id)?.close();
    const es = new EventSource(`/api/sources/${encodeURIComponent(id)}/refresh/events`);
    refreshEventSources.set(id, es);
    const gen = (refreshGens.get(id) || 0) + 1;
    refreshGens.set(id, gen); // 本连接代次：之后任何新连接都会作废它
    let done = false;
    const fire = () => {
        if (done || refreshGens.get(id) !== gen) return; // 已终止或已被新连接替换
        done = true;
        finish('error', t('刷新超时（无进度回报），请重试'));
    };
    // idle 型看门狗：每条事件重置计时，只有连续 REFRESH_WATCHDOG_MS 收不到任何事件才判超时
    const arm = () => setTimeout(fire, REFRESH_WATCHDOG_MS);
    let watchdog = arm();
    const cancel = () => clearTimeout(watchdog);
    refreshIdleCancels.set(id, cancel);
    const finish = (status, message) => {
        if (done && status !== 'error') return;
        done = true;
        cancel();
        if (refreshIdleCancels.get(id) === cancel) refreshIdleCancels.delete(id);
        es.close();
        if (refreshEventSources.get(id) === es) refreshEventSources.delete(id); // 身份校验：不误删更新的连接（P2-2）
        if (refreshGens.get(id) === gen) refreshGens.delete(id); // 终态清记账（reap 不清，保证兜底仍在）
        const stateObj = { status, message };
        S.sources.refresh[id] = stateObj;
        if (status === 'done') {
            delete S.sources.itemsCache[id];
            api('GET', '/api/sources').then((data) => {
                const list = Array.isArray(data?.sources) ? data.sources : S.sources.list;
                S.sources.list = list;
                renderSourceList();
                loadSourceCounts();
            }).catch(() => renderSourceList());
            // 延迟清理，但校验状态仍是本次写入的 stateObj 才删，避免抹掉后续新刷新（P2-2）
            clearRefreshTimer(id);
            refreshClearTimers.set(id, setTimeout(() => {
                refreshClearTimers.delete(id);
                if (S.sources.refresh[id] === stateObj) { delete S.sources.refresh[id]; renderSourceList(); }
            }, 6000));
        } else {
            renderSourceList();
        }
    };
    es.onmessage = (ev) => {
        clearTimeout(watchdog); watchdog = arm(); // 活着就续期：事件到达即重置 idle 计时
        let event; try { event = JSON.parse(ev.data); } catch { event = { type: 'progress', message: ev.data }; }
        const message = event.message || event.step || '';
        if (event.type === 'progress') {
            S.sources.refresh[id] = { status: 'running', message };
            renderSourceList();
        } else if (event.type === 'done') {
            finish('done', message || t('抓取完成'));
        } else if (event.type === 'error') {
            finish('error', message || t('抓取失败'));
            showToast(t('素材源刷新失败：{msg}', { msg: message || t('未知错误') }), 'error');
        }
    };
    es.onerror = () => {
        if (refreshEventSources.get(id) !== es) return; // 已正常结束或已被新连接替换
        finish('error', t('刷新进度连接中断（后端可能未就绪），请稍后重试'));
    };
}

// ============================================================
// 素材条目抽屉 + 正文预览
// ============================================================
let drawerSourceId = null;   // 当前列表展示：某源 id，或 null（全局搜索结果）
let drawerOwnerSourceId = null; // 打开抽屉时所属的源；清空搜索框时回到该源列表

export async function openItemsDrawer(sourceId) {
    drawerSourceId = sourceId || null;
    drawerOwnerSourceId = sourceId || null;
    const drawer = document.getElementById('items-drawer');
    const searchInput = document.getElementById('items-search-input');
    const titleEl = document.getElementById('items-drawer-title');
    const src = sourceId ? S.sources.list.find((s) => s.id === sourceId) : null;
    if (titleEl) titleEl.textContent = src ? `${t('素材条目')} · ${src.name || src.id}` : t('素材条目');
    if (searchInput) searchInput.value = '';
    drawer?.classList.remove('hidden');
    hideItemPreview();
    await renderItemsList();
}

async function renderItemsList() {
    const list = document.getElementById('items-list');
    if (!list) return;
    list.innerHTML = `<div class="items-loading">${t('加载中…')}</div>`;
    let items;
    if (drawerSourceId) {
        items = S.sources.itemsCache[drawerSourceId] || await fetchSourceItems(drawerSourceId) || [];
        if (!S.sources.itemsCache[drawerSourceId]) renderSourceList();
    } else {
        items = []; // 搜索词触发时替换
    }
    paintItems(items);
}

function paintItems(items) {
    const list = document.getElementById('items-list');
    if (!list) return;
    if (!items.length) {
        list._items = [];
        list.innerHTML = `<div class="items-loading">${escapeHtml(t('暂无条目（源可能还未抓取或后端未就绪）'))}</div>`;
        return;
    }
    list.innerHTML = items.map((it, i) => {
        const size = formatBytes(it.bytes);
        const tags = Array.isArray(it.tags) ? it.tags.map((tag) => `<span class="source-tag">#${escapeHtml(tag)}</span>`).join('') : '';
        return `<div class="item-row" data-item-idx="${i}">
          <div class="item-row-title">${escapeHtml(it.title || it.id)}</div>
          <div class="item-row-meta">${escapeHtml(it.origin || '')}${size ? ' · ' + escapeHtml(size) : ''}</div>
          ${tags ? `<div class="item-row-tags">${tags}</div>` : ''}
        </div>`;
    }).join('');
    list._items = items;
    list.querySelectorAll('.item-row').forEach((row) => {
        row.addEventListener('click', () => showItemPreview(row.dataset.itemIdx));
    });
}

async function searchAllItems(q) {
    const list = document.getElementById('items-list');
    if (!list) return;
    list.innerHTML = `<div class="items-loading">${t('加载中…')}</div>`;
    try {
        const data = await api('GET', `/api/sources/items?q=${encodeURIComponent(q)}&limit=100`);
        paintItems(Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []));
    } catch (err) {
        list.innerHTML = `<div class="items-loading">${escapeHtml(t('搜索失败：{msg}', { msg: errText(err) }))}</div>`;
    }
}

function currentDrawerItem(idx) {
    const list = document.getElementById('items-list');
    return list?._items?.[Number(idx)] || null;
}

async function showItemPreview(idx) {
    const item = currentDrawerItem(idx);
    if (!item) return;
    const preview = document.getElementById('items-preview');
    const titleEl = document.getElementById('items-preview-title');
    const contentEl = document.getElementById('items-preview-content');
    if (!preview) return;
    if (titleEl) titleEl.textContent = item.title || item.id || '';
    if (contentEl) contentEl.textContent = t('加载中…');
    preview.classList.remove('hidden');
    const body = { itemId: item.id, id: item.id, hash: item.hash };
    if (drawerSourceId) body.sourceId = drawerSourceId;
    else if (item.sourceId) body.sourceId = item.sourceId;
    try {
        const data = await api('POST', '/api/sources/preview', body);
        const text = data?.content ?? data?.text ?? data?.preview ?? '';
        if (contentEl) contentEl.textContent = String(text) || t('（无可预览的正文）');
    } catch (err) {
        if (contentEl) contentEl.textContent = t('预览失败：{msg}', { msg: errText(err) });
    }
}

function hideItemPreview() {
    document.getElementById('items-preview')?.classList.add('hidden');
}

function closeItemsDrawer() {
    document.getElementById('items-drawer')?.classList.add('hidden');
    drawerSourceId = null;
}

// ============================================================
// 事件绑定（app.mjs 启动链调用一次）
// ============================================================
let itemsSearchTimer = null;

export function bindSourcesEvents() {
    document.getElementById('btn-materials-new-source')?.addEventListener('click', () => {
        _cb.switchSidebarTab?.('materials', 'sources');
        openSourceModal(null);
    });
    document.getElementById('btn-materials-refresh-sources')?.addEventListener('click', () => {
        _cb.switchSidebarTab?.('materials', 'sources');
        loadSources();
    });
    document.getElementById('btn-cancel-source')?.addEventListener('click', closeSourceModal);
    document.getElementById('btn-save-source')?.addEventListener('click', saveSource);
    document.querySelector('#source-modal .modal-backdrop')?.addEventListener('click', closeSourceModal);

    document.getElementById('btn-close-items-drawer')?.addEventListener('click', closeItemsDrawer);
    document.querySelector('.items-drawer-backdrop')?.addEventListener('click', closeItemsDrawer);
    document.getElementById('btn-items-preview-back')?.addEventListener('click', hideItemPreview);
    document.getElementById('items-search-input')?.addEventListener('input', (e) => {
        clearTimeout(itemsSearchTimer);
        const q = e.target.value.trim();
        itemsSearchTimer = setTimeout(() => {
            if (q) {
                drawerSourceId = null;
                searchAllItems(q);
            } else {
                drawerSourceId = drawerOwnerSourceId;
                renderItemsList();
            }
        }, 300);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const drawer = document.getElementById('items-drawer');
        if (drawer && !drawer.classList.contains('hidden')) {
            if (!document.getElementById('items-preview')?.classList.contains('hidden')) hideItemPreview();
            else closeItemsDrawer();
        } else if (document.getElementById('source-modal')?.classList.contains('hidden') === false) {
            closeSourceModal();
        }
    });
}
