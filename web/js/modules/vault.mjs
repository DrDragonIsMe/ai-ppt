// web/js/modules/vault.mjs — 知识库笔记管理 + 编辑器 + 快速跳转 + 标签 + AI 对话
import { S } from './state.mjs';
import { api, apiUpload, showToast, escapeHtml, escapeHtmlAttr, withLlmSettingsHint } from './state.mjs';
import { showConfirmModal, showInputModal } from './modals.mjs';
import { t } from './i18n.mjs';

// 外部回调（通过 initVaultModule 注入）
let _cb = {};

export function initVaultModule(callbacks) {
    _cb = callbacks; // { switchSidebarTab, loadFragments, loadDashboard, loadCards, selectCard, stopPhysics, hideAllMainPanels }
}

// ============================================================
// DOM 辅助
// ============================================================
function getVaultEls() {
    return {
        sidebarTabs: document.querySelectorAll('.sidebar-tab'),
        projectSidebar: document.getElementById('project-sidebar-content'),
        vaultSidebar: document.getElementById('vault-sidebar-content'),
        vaultNoteList: document.getElementById('vault-note-list'),
        vaultSearchInput: document.getElementById('vault-search-input'),
        btnVaultRefresh: document.getElementById('btn-vault-refresh'),
        btnVaultNew: document.getElementById('btn-vault-new'),
        vaultEmptyState: document.getElementById('vault-no-note-selected'),
        vaultNotePanel: document.getElementById('vault-note-panel'),
        vaultNoteTitle: document.getElementById('vault-note-title'),
        vaultNoteFrontmatter: document.getElementById('vault-note-frontmatter'),
        vaultNoteContent: document.getElementById('vault-note-content'),
        btnVaultNotePreview: document.getElementById('btn-vault-note-preview'),
        btnVaultOutlineToggle: document.getElementById('btn-vault-outline-toggle'),
        vaultNoteEditArea: document.getElementById('vault-note-edit-area'),
        vaultNotePreview: document.getElementById('vault-note-preview'),
        vaultNoteOutline: document.getElementById('vault-note-outline'),
        vaultNoteOutlineList: document.getElementById('vault-note-outline-list'),
        wikiSuggestEl: document.getElementById('wiki-suggest'),
        btnVaultNoteSave: document.getElementById('btn-vault-note-save'),
        btnVaultNoteDelete: document.getElementById('btn-vault-note-delete'),
        btnVaultNoteGenerate: document.getElementById('btn-vault-note-generate'),
        vaultOutlinks: document.getElementById('vault-outlinks'),
        vaultBacklinks: document.getElementById('vault-backlinks'),
        configTabs: document.querySelectorAll('.config-tab'),
        configPanels: document.querySelectorAll('.config-panel')
    };
}

// ============================================================
// 笔记列表加载与渲染
// ============================================================
export async function loadNotes() {
    try {
        const res = await fetch('/api/vault/notes');
        S.notes = await res.json();
        renderNoteList();
    } catch (e) {
        console.error('Failed to load notes:', e);
        showToast(t('加载笔记列表失败'));
    }
}

function renderNoteList(filter) {
    const els = getVaultEls();
    const query = (filter !== undefined ? filter : els.vaultSearchInput.value || '').trim();
    if (query) { scheduleVaultSearch(query); return; }
    S.vaultSearchQuery = '';
    let html = '';
    if (S.notes.length === 0) {
        html = `<div class="vault-empty" style="padding:20px;text-align:center;opacity:0.6;font-size:13px;">${t('暂无笔记')}</div>`;
    } else {
        for (const note of S.notes) {
            html += `<div class="vault-note-item ${S.currentNote === note.name ? 'active' : ''}" data-name="${escapeHtmlAttr(note.name)}" draggable="true" title="${t('拖拽可调整顺序')}">
          <input type="checkbox" class="vault-note-check" data-name="${escapeHtmlAttr(note.name)}" title="${t('选择笔记')}" ${S.selectedNotes.has(note.name) ? 'checked' : ''}>
          <div class="vault-note-item-main">
            <div class="vault-note-item-title">${escapeHtml(note.name)}</div>
            <div class="vault-note-item-meta">${note.mtime ? new Date(note.mtime).toLocaleDateString() : ''}</div>
          </div>
        </div>`;
        }
    }
    els.vaultNoteList.innerHTML = html;
    updateNoteSelectBar();
}

// ============================================================
// 多选笔记 → 生成媒体
// ============================================================
function updateNoteSelectBar() {
    const bar = document.getElementById('vault-note-select-bar');
    const count = document.getElementById('vault-note-select-count');
    if (!bar || !count) return;
    const n = S.selectedNotes.size;
    bar.classList.toggle('hidden', n === 0);
    count.textContent = t('已选 {n} 篇', { n });
}

function clearSelectedNotes() {
    S.selectedNotes.clear();
    renderNoteList();
}

// 批量删除：逐个 DELETE（服务端删前自动备份到 .snapshots/_vault）
async function batchDeleteNotes() {
    const names = [...S.selectedNotes];
    if (!names.length) { showToast(t('请先勾选笔记')); return; }
    const ok = await showConfirmModal({
        title: t('批量删除笔记'),
        message: t('确定删除选中的 {count} 篇笔记吗？（删除前会自动备份，可在「历史版本」中恢复）', { count: names.length }),
        confirmText: t('全部删除'),
        danger: true,
    });
    if (!ok) return;
    let done = 0, failed = 0;
    for (const name of names) {
        try {
            await api('DELETE', `/api/vault/notes/${encodeURIComponent(name)}`);
            removeNoteDraft(name);
            S.selectedNotes.delete(name);
            done++;
        } catch (e) {
            console.error('Failed to delete note:', name, e);
            failed++;
        }
    }
    // 当前打开的笔记被删除时收起编辑区
    if (S.currentNote && names.includes(S.currentNote)) {
        S.currentNote = null;
        resetNoteDirtyState();
        document.getElementById('vault-note-panel').classList.add('hidden');
        document.getElementById('vault-no-note-selected').classList.remove('hidden');
    }
    await loadNotes();
    showToast(failed ? t('已删除 {done} 篇，失败 {failed} 篇', { done, failed }) : t('已删除 {done} 篇笔记', { done }), failed ? 'error' : undefined);
}

// 批量打标签：追加进各笔记 Front Matter tags（服务端去重、保持 FM 格式）
async function batchTagNotes() {
    const names = [...S.selectedNotes];
    if (!names.length) { showToast(t('请先勾选笔记')); return; }
    const input = await showInputModal({ title: t('批量打标签'), label: t('为 {count} 篇笔记追加标签（多个用逗号或空格分隔）', { count: names.length }), placeholder: t('例如：重要, 工作') });
    if (input === null) return;
    const tags = input.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!tags.length) { showToast(t('请输入标签')); return; }
    let done = 0, failed = 0;
    for (const name of names) {
        try {
            await api('POST', `/api/vault/notes/${encodeURIComponent(name)}/add-tags`, { tags });
            done++;
        } catch (e) {
            console.error('Failed to tag note:', name, e);
            failed++;
        }
    }
    await loadNotes();
    // 当前打开的笔记被打过标签则重载，刷新 Front Matter 显示
    if (S.currentNote && names.includes(S.currentNote)) await selectNote(S.currentNote);
    showToast(failed ? t('已为 {done} 篇笔记打标签，失败 {failed} 篇', { done, failed }) : t('已为 {done} 篇笔记追加标签', { done }), failed ? 'error' : undefined);
}

// ============================================================
// 笔记列表拖拽排序（HTML5 DnD，顺序持久化到服务端 note-order.json）
// ============================================================
function bindNoteListDragEvents() {
    const list = getVaultEls().vaultNoteList;
    let dragEl = null;
    list.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.vault-note-item');
        if (!item) return;
        dragEl = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.name || '');
    });
    list.addEventListener('dragover', (e) => {
        if (!dragEl) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const target = e.target.closest('.vault-note-item');
        list.querySelectorAll('.vault-note-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
        if (!target || target === dragEl) return;
        const rect = target.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        target.classList.add('drag-over');
        list.insertBefore(dragEl, before ? target : target.nextSibling);
    });
    list.addEventListener('drop', (e) => { if (dragEl) e.preventDefault(); });
    list.addEventListener('dragend', () => {
        if (!dragEl) return;
        dragEl.classList.remove('dragging');
        list.querySelectorAll('.vault-note-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
        dragEl = null;
        persistNoteOrder();
    });
}

// 把当前 DOM 顺序保存到服务端；失败则重载列表还原
async function persistNoteOrder() {
    const order = [...getVaultEls().vaultNoteList.querySelectorAll('.vault-note-item')]
        .map((el) => el.dataset.name).filter(Boolean);
    if (!order.length) return;
    const byName = new Map(S.notes.map((n) => [n.name, n]));
    S.notes = [...order.map((n) => byName.get(n)).filter(Boolean), ...S.notes.filter((n) => !order.includes(n.name))];
    try {
        await api('PUT', '/api/vault/note-order', { order });
        showToast(t('顺序已保存'));
    } catch (e) {
        console.error('Failed to save note order:', e);
        showToast(t('顺序保存失败：{msg}', { msg: e.message || '' }), 'error');
        await loadNotes();
    }
}

// ============================================================
// 侧边栏全文搜索（契约 M）
// ============================================================
function scheduleVaultSearch(query) {
    S.vaultSearchQuery = query;
    clearTimeout(S.vaultSearchTimer);
    S.vaultSearchTimer = setTimeout(() => runVaultSearch(query), 300);
}

async function runVaultSearch(query) {
    const els = getVaultEls();
    try {
        const results = await api('GET', `/api/vault/search?q=${encodeURIComponent(query)}`);
        if (query !== S.vaultSearchQuery) return;
        renderVaultSearchResults(Array.isArray(results) ? results : [], query);
    } catch (e) {
        console.error('Failed to search notes:', e);
        if (query !== S.vaultSearchQuery) return;
        const filtered = S.notes.filter(n => n.name && n.name.toLowerCase().includes(query.toLowerCase()));
        renderVaultSearchResults(filtered.map(n => ({ name: n.name, snippet: '' })), query);
    }
}

function highlightSearchHit(text, query) {
    const escaped = escapeHtml(text || '');
    const q = escapeHtml(query);
    if (!q) return escaped;
    const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.replace(new RegExp(pattern, 'gi'), (m) => `<mark>${m}</mark>`);
}

function renderVaultSearchResults(results, query) {
    const els = getVaultEls();
    if (results.length === 0) {
        els.vaultNoteList.innerHTML = `<div class="vault-empty" style="padding:20px;text-align:center;opacity:0.6;font-size:13px;">${t('无匹配笔记')}</div>`;
        return;
    }
    els.vaultNoteList.innerHTML = results.map((r) => {
        const name = r.name || '';
        return `<div class="vault-note-item ${S.currentNote === name ? 'active' : ''}" data-name="${escapeHtmlAttr(name)}">
        <div class="vault-note-item-main">
          <div class="vault-note-item-title">${highlightSearchHit(r.title || name, query)}</div>
          <div class="vault-note-item-meta">${r.snippet ? highlightSearchHit(r.snippet, query) : ''}</div>
        </div>
      </div>`;
    }).join('');
}

// ============================================================
// 选择笔记
// ============================================================
export async function selectNote(name) {
    if (_cb.closeSidebarDrawer) _cb.closeSidebarDrawer(); // 移动端：选中笔记后收起抽屉进入阅读
    if (S.currentNote !== name) {
        const noteChatMessages = document.getElementById('note-chat-messages');
        if (noteChatMessages) noteChatMessages.innerHTML = '';
        // 切换笔记前自动保存当前笔记
        await saveNote({ auto: true });
    }
    S.currentNote = name;
    const els = getVaultEls();
    try {
        const res = await fetch(`/api/vault/notes/${encodeURIComponent(name)}`);
        const data = await res.json();
        if (S.currentNote !== name) return; // 加载期间已切换到其他笔记
        els.vaultEmptyState.classList.add('hidden');
        els.vaultNotePanel.classList.remove('hidden');
        els.vaultNoteTitle.dataset.baseTitle = data.frontMatter?.title || name;
        let frontmatterText = '';
        if (data.frontMatter && Object.keys(data.frontMatter).length > 0) {
            frontmatterText = '---\n';
            for (const [key, val] of Object.entries(data.frontMatter)) {
                frontmatterText += Array.isArray(val) ? `${key}: [${val.join(', ')}]\n` : `${key}: ${val}\n`;
            }
            frontmatterText += '---\n\n';
        }
        els.vaultNoteFrontmatter.value = frontmatterText;
        const contentWithoutFrontmatter = data.content.replace(/^---[\s\S]*?---\n*/, '');
        els.vaultNoteContent.value = contentWithoutFrontmatter;
        resetNoteUndoStack(contentWithoutFrontmatter); // 切换笔记清空撤销栈
        resetNoteDirtyState();
        checkNoteDraft(name, frontmatterText + contentWithoutFrontmatter);
        await loadNoteLinks(name);
        renderNoteList();
        setNotePreviewMode(false);
        buildOutline();
        hideWikiSuggest();
        updateJournalNav();
    } catch (e) {
        console.error('Failed to load note:', e);
    }
}

// 打开笔记时检查 localStorage 草稿：比笔记内容更新且不同则提示恢复/丢弃
function checkNoteDraft(name, serverContent) {
    const draft = readNoteDraft(name);
    if (!draft || typeof draft.content !== 'string' || draft.content === serverContent) return;
    const noteMeta = S.notes.find((n) => n.name === name);
    const mtime = noteMeta && noteMeta.mtime ? new Date(noteMeta.mtime).getTime() : 0;
    if (mtime && (draft.time || 0) <= mtime) return;
    const when = draft.time ? new Date(draft.time).toLocaleString() : t('未知时间');
    showConfirmModal({
        title: t('发现未保存草稿'),
        message: t('检测到「{name}」有一版未保存的草稿（{when}），与当前内容不同。是否恢复？', { name, when }),
        confirmText: t('恢复草稿')
    }).then((restore) => {
        if (restore) {
            if (S.currentNote !== name) { showToast(t('草稿仍在本地，重新打开该笔记可再次恢复')); return; }
            applyNoteDraft(draft);
            showToast(t('已恢复未保存草稿'));
        } else {
            removeNoteDraft(name);
        }
    });
}

function applyNoteDraft(draft) {
    const els = getVaultEls();
    const m = draft.content.match(/^---\n[\s\S]*?\n---\n*/);
    if (m) {
        els.vaultNoteFrontmatter.value = m[0];
        els.vaultNoteContent.value = draft.content.slice(m[0].length);
    } else {
        els.vaultNoteFrontmatter.value = '';
        els.vaultNoteContent.value = draft.content;
    }
    resetNoteUndoStack(els.vaultNoteContent.value); // 草稿整体替换，撤销栈以草稿内容为基线
    buildOutline();
    if (S.notePreviewMode) renderNotePreview();
    markNoteDirty(); // 恢复进编辑器并标脏，等待自动/手动保存
}

async function loadNoteLinks(name) {
    const els = getVaultEls();
    try {
        const res = await fetch(`/api/vault/notes/${encodeURIComponent(name)}/info`);
        const info = await res.json();
        renderLinksList(els.vaultOutlinks, info.outlinks);
        renderLinksList(els.vaultBacklinks, info.backlinks);
    } catch (e) { console.error('Failed to load note links:', e); }
    await loadNoteMentions(name);
}

function renderLinksList(el, links) {
    if (!links || links.length === 0) { el.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('暂无')}</div>`; return; }
    let html = '';
    for (const link of links) {
        const name = link.name || link;
        const snippets = Array.isArray(link.snippets) ? link.snippets.slice(0, 2) : [];
        html += `<div class="vault-link-item" data-name="${escapeHtmlAttr(name)}">
        <div class="vault-link-name">${escapeHtml(name)}</div>
        ${snippets.map((s) => `<div class="vault-link-snippet">${escapeHtml(s)}</div>`).join('')}
      </div>`;
    }
    el.innerHTML = html;
}

// ============================================================
// 未链接提及（契约 N）
// ============================================================
async function loadNoteMentions(name) {
    const el = document.getElementById('vault-mentions');
    if (!el) return;
    try {
        const data = await api('GET', `/api/vault/notes/${encodeURIComponent(name)}/mentions`);
        renderNoteMentions(data.mentions || []);
    } catch (e) {
        console.error('Failed to load note mentions:', e);
        el.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('暂无未链接提及')}</div>`;
    }
}

function renderNoteMentions(mentions) {
    const el = document.getElementById('vault-mentions');
    if (!mentions.length) { el.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('暂无未链接提及')}</div>`; return; }
    el.innerHTML = mentions.map((m) => {
        const source = m.source || '';
        const isFragment = source.startsWith('fragment:');
        const badge = isFragment ? t('碎片') : t('笔记');
        const label = isFragment ? source.slice('fragment:'.length) : source;
        return `<div class="vault-mention-item" data-source="${escapeHtmlAttr(source)}">
        <div class="vault-mention-head">
          <span class="vault-mention-badge">${badge}</span>
          <span class="vault-mention-source">${escapeHtml(label)}</span>
          <button class="btn-secondary vault-mention-link-btn">${t('转为链接')}</button>
        </div>
        <div class="vault-mention-snippet">${escapeHtml(m.snippet || '')}</div>
      </div>`;
    }).join('');
}

async function linkMention(source) {
    if (!S.currentNote) return;
    try {
        const data = await api('POST', `/api/vault/notes/${encodeURIComponent(S.currentNote)}/link-mentions`, { source });
        showToast(t('已转换 {count} 处提及', { count: data.count ?? 0 }));
        await loadNoteMentions(S.currentNote);
        await loadNoteLinks(S.currentNote);
    } catch (e) { console.error('Failed to link mention:', e); showToast(e.message || t('转换失败')); }
}

// ============================================================
// 笔记重命名
// ============================================================
function openRenameModal() {
    if (!S.currentNote) return;
    const input = document.getElementById('rename-note-input');
    input.value = S.currentNote;
    document.getElementById('rename-modal').classList.remove('hidden');
    input.focus(); input.select();
}
function closeRenameModal() { document.getElementById('rename-modal').classList.add('hidden'); }

async function confirmRename() {
    if (!S.currentNote) return;
    const newName = document.getElementById('rename-note-input').value.trim();
    if (!newName || newName === S.currentNote) { closeRenameModal(); return; }
    try {
        const data = await api('POST', `/api/vault/notes/${encodeURIComponent(S.currentNote)}/rename`, { newName });
        closeRenameModal();
        const finalName = data.newName || newName;
        showToast(t('已重命名为 {name}，更新 {count} 处引用', { name: finalName, count: data.updatedRefs ?? 0 }));
        await loadNotes(); selectNote(finalName);
    } catch (e) { console.error('Failed to rename note:', e); showToast(e.message || t('重命名失败')); }
}

// ============================================================
// 历史版本（.snapshots/_vault 备份列表 / 恢复）
// ============================================================
function formatBackupTs(ts) {
    const m = String(ts).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-\d{3}Z$/);
    return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : String(ts);
}

function closeNoteHistoryModal() { document.getElementById('note-history-modal').classList.add('hidden'); }

async function openNoteHistoryModal() {
    if (!S.currentNote) return;
    const list = document.getElementById('note-history-list');
    list.innerHTML = `<div class="note-history-empty">${t('加载中…')}</div>`;
    document.getElementById('note-history-modal').classList.remove('hidden');
    let backups = [];
    try {
        const data = await api('GET', `/api/vault/notes/${encodeURIComponent(S.currentNote)}/backups`);
        backups = data.backups || [];
    } catch (e) {
        console.error('Failed to load note backups:', e);
        list.innerHTML = `<div class="note-history-empty">${t('加载失败')}</div>`;
        return;
    }
    if (!backups.length) {
        list.innerHTML = `<div class="note-history-empty">${t('暂无历史版本（笔记在覆盖 / 删除 / AI 修改前会自动备份）')}</div>`;
        return;
    }
    list.innerHTML = backups.map((b) => `<div class="note-history-item">
      <div class="note-history-item-main">
        <div class="note-history-item-time">${escapeHtml(formatBackupTs(b.ts))}</div>
        <div class="note-history-item-preview">${escapeHtml(b.preview || '')}</div>
      </div>
      <button class="btn-secondary note-history-restore" data-ts="${escapeHtmlAttr(b.ts)}" style="padding:6px 10px;font-size:12px;white-space:nowrap;">${t('恢复此版本')}</button>
    </div>`).join('');
}

async function restoreNoteBackup(ts) {
    if (!S.currentNote) return;
    const ok = await showConfirmModal({
        title: t('恢复历史版本'),
        message: t('确定恢复到 {ts} 的版本吗？当前内容会先自动备份，可再次恢复。', { ts: formatBackupTs(ts) }),
        confirmText: t('恢复'),
    });
    if (!ok) return;
    const name = S.currentNote;
    try {
        await api('POST', `/api/vault/notes/${encodeURIComponent(name)}/restore-backup`, { ts });
        removeNoteDraft(name);
        closeNoteHistoryModal();
        if (S.currentNote === name) await selectNote(name);
        showToast(t('已恢复历史版本'));
    } catch (e) {
        console.error('Failed to restore note backup:', e);
        showToast(t('恢复失败：{msg}', { msg: e.message || '' }), 'error');
    }
}

// AI 修改完成后在对话消息下附加「撤销本次修改」按钮：恢复本次修改前自动创建的备份
function addNoteChatUndoButton(msgDiv, noteName, sinceTs) {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary chat-undo-btn';
    btn.textContent = t('撤销本次修改');
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            const data = await api('GET', `/api/vault/notes/${encodeURIComponent(noteName)}/backups`);
            const backups = data.backups || [];
            // 取本次修改开始后创建的最早一份备份（= 修改前内容）；找不到则退化为最近一份
            const pick = [...backups].reverse().find((b) => b.ts >= sinceTs) || backups[0];
            if (!pick) { showToast(t('没有可回滚的备份')); btn.remove(); return; }
            if (!(await showConfirmModal({ title: t('撤销 AI 修改'), message: t('将回滚到本次 AI 修改前的版本（当前内容会先自动备份）。确定吗？'), confirmText: t('撤销修改') }))) { btn.disabled = false; return; }
            await api('POST', `/api/vault/notes/${encodeURIComponent(noteName)}/restore-backup`, { ts: pick.ts });
            removeNoteDraft(noteName);
            if (S.currentNote === noteName) await selectNote(noteName);
            showToast(t('已撤销本次 AI 修改'));
            btn.remove();
        } catch (e) {
            console.error('Failed to undo note chat:', e);
            btn.disabled = false;
            showToast(t('撤销失败：{msg}', { msg: e.message || '' }), 'error');
        }
    });
    msgDiv.appendChild(btn);
}

// ============================================================
// 标签浏览（契约 N）
// ============================================================
function showTagsPanel() {
    if (_cb.hideAllMainPanels) _cb.hideAllMainPanels();
    document.getElementById('tags-panel').classList.remove('hidden');
    loadTags();
}
function hideTagsPanel() {
    document.getElementById('tags-panel').classList.add('hidden');
    if (_cb.switchSidebarTab) _cb.switchSidebarTab(S.currentSidebarTab);
}

async function loadTags() {
    try {
        const data = await api('GET', '/api/vault/tags');
        S.vaultTags = data.tags || {};
        renderTagCloud(); renderTagDetail();
    } catch (e) { console.error('Failed to load tags:', e); showToast(t('加载标签失败')); }
}

function renderTagCloud() {
    const el = document.getElementById('tags-cloud');
    const entries = Object.entries(S.vaultTags || {}).map(([tag, info]) => ({
        tag, count: (info.notes?.length || 0) + (info.cards?.length || 0) + (info.fragments?.length || 0)
    })).filter((e) => e.count > 0).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    if (!entries.length) { el.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('暂无标签')}</div>`; return; }
    const max = entries[0].count;
    el.innerHTML = entries.map((e) => {
        const ratio = e.count / max;
        const tier = ratio > 0.66 ? 'tags-chip-lg' : ratio > 0.33 ? 'tags-chip-md' : '';
        const active = e.tag === S.currentTag ? ' active' : '';
        const opacity = (0.55 + ratio * 0.45).toFixed(2);
        return `<button class="tags-chip ${tier}${active}" data-tag="${escapeHtmlAttr(e.tag)}" style="opacity:${opacity};">#${escapeHtml(e.tag)}<span class="tags-chip-count">${e.count}</span></button>`;
    }).join('');
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
    const id = String(item.id || item.name || '');
    const label = String(item.title || item.name || item.id || '');
    return { id, label };
}

function renderTagColumn(elId, items, type) {
    const el = document.getElementById(elId);
    const list = Array.isArray(items) ? items : [];
    if (!list.length) { el.innerHTML = `<div style="opacity:0.5;font-size:12px;">${t('暂无')}</div>`; return; }
    const badge = t({ note: '笔记', card: '卡片', fragment: '碎片' }[type]);
    el.innerHTML = list.map((item) => {
        const { id, label } = tagItemInfo(item);
        return `<div class="tags-item" data-type="${type}" data-id="${escapeHtmlAttr(id)}">
        <span class="tags-item-name">${escapeHtml(label)}</span><span class="tags-item-badge">${badge}</span></div>`;
    }).join('');
}

function openTagItem(type, id) {
    if (!id) return;
    if (type === 'note') { if (_cb.switchSidebarTab) _cb.switchSidebarTab('vault'); selectNote(id); }
    else if (type === 'card') {
        if (_cb.switchSidebarTab) _cb.switchSidebarTab('cards');
        if (_cb.loadCards) _cb.loadCards().then(() => { if (_cb.selectCard) _cb.selectCard(id); });
    } else if (type === 'fragment') {
        if (_cb.switchSidebarTab) _cb.switchSidebarTab('fragments');
        showToast(t('已切换到速记'));
    }
}

// ============================================================
// 笔记 CRUD（含自动保存 / 脏标记 / localStorage 草稿兜底）
// ============================================================
let noteSaving = false;
let noteSaveQueued = false;
let autoSaveTimer = null;

function noteDraftKey(name) { return `ai-ppt-note-draft:${name}`; }

function readNoteDraft(name) {
    try {
        const raw = localStorage.getItem(noteDraftKey(name));
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function writeNoteDraft() {
    if (!S.currentNote) return;
    try {
        const els = getVaultEls();
        localStorage.setItem(noteDraftKey(S.currentNote), JSON.stringify({
            content: els.vaultNoteFrontmatter.value + els.vaultNoteContent.value,
            time: Date.now()
        }));
    } catch { /* localStorage 不可用时静默 */ }
}

function removeNoteDraft(name) {
    try { localStorage.removeItem(noteDraftKey(name)); } catch { /* ignore */ }
}

function updateNoteDirtyUI() {
    const els = getVaultEls();
    const base = els.vaultNoteTitle.dataset.baseTitle || els.vaultNoteTitle.textContent.replace(/ ●$/, '');
    els.vaultNoteTitle.dataset.baseTitle = base;
    els.vaultNoteTitle.textContent = S.noteDirty ? `${base} ●` : base;
    els.vaultNoteTitle.title = S.noteDirty ? t('有未保存的修改') : '';
    if (els.btnVaultNoteSave) {
        els.btnVaultNoteSave.textContent = S.noteDirty ? t('保存 ●') : t('保存');
        els.btnVaultNoteSave.title = S.noteDirty ? t('有未保存的修改') : '';
    }
}

function markNoteDirty() {
    if (!S.currentNote) return;
    if (!S.noteDirty) { S.noteDirty = true; updateNoteDirtyUI(); }
    writeNoteDraft();
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => { if (S.noteDirty) saveNote({ auto: true }); }, 2000);
}

function resetNoteDirtyState() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    S.noteDirty = false;
    updateNoteDirtyUI();
}

async function saveNote(opts = {}) {
    const auto = !!opts.auto;
    if (!S.currentNote) return;
    // 保存进行中再次触发：排队一次，结束后补一次自动保存
    if (noteSaving) { noteSaveQueued = true; return; }
    if (auto && !S.noteDirty) return;
    noteSaving = true;
    const els = getVaultEls();
    const name = S.currentNote;
    const content = els.vaultNoteFrontmatter.value + els.vaultNoteContent.value;
    try {
        const res = await fetch(`/api/vault/notes/${encodeURIComponent(name)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (res.ok) {
            if (!auto) showToast(t('保存成功'));
            // 保存期间又有新输入则保持脏标记，交给下一次自动保存
            if (S.currentNote === name && els.vaultNoteFrontmatter.value + els.vaultNoteContent.value === content) {
                S.noteDirty = false;
                updateNoteDirtyUI();
                removeNoteDraft(name);
            }
            await loadNotes();
            if (S.currentNote === name) await loadNoteLinks(name);
        } else {
            showToast(auto ? t('自动保存失败，请检查网络后重试') : t('保存失败'), 'error');
        }
    } catch (e) {
        console.error('Failed to save note:', e);
        showToast(auto ? t('自动保存失败，请检查网络后重试') : t('保存失败'), 'error');
    } finally {
        noteSaving = false;
        if (noteSaveQueued) { noteSaveQueued = false; saveNote({ auto: true }); }
    }
}

// Ctrl+S 分派入口（projects.mjs 键盘快捷键调用）
export function saveCurrentNote() { saveNote(); }

async function deleteNote() {
    if (!S.currentNote) return;
    if (!(await showConfirmModal({ title: t('删除笔记'), message: t('确定要删除笔记「{name}」吗？此操作不可恢复。', { name: S.currentNote }), confirmText: t('删除'), danger: true }))) return;
    const els = getVaultEls();
    try {
        const res = await fetch(`/api/vault/notes/${encodeURIComponent(S.currentNote)}`, { method: 'DELETE' });
        if (res.ok) {
            removeNoteDraft(S.currentNote);
            S.currentNote = null;
            resetNoteDirtyState();
            els.vaultNotePanel.classList.add('hidden');
            els.vaultEmptyState.classList.remove('hidden');
            await loadNotes(); showToast(t('删除成功'));
        }
    } catch (e) { console.error('Failed to delete note:', e); showToast(t('删除失败')); }
}

export async function createNewNote() {
    const input = await showInputModal({ title: t('新建笔记'), label: t('笔记名称'), placeholder: t('输入笔记名称') });
    if (input === null) return;
    const name = input.trim();
    if (!name) { showToast(t('请输入笔记名称')); return; }
    try {
        const res = await fetch('/api/vault/notes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (res.ok) { showToast(t('创建成功')); await loadNotes(); selectNote(name); }
    } catch (e) { console.error('Failed to create note:', e); showToast(t('创建失败')); }
}

// ============================================================
// 编辑器：自定义撤销/重做栈（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）
// 浏览器原生 undo 会被程序化修改（wikilink 补全、任务切换、插图）打断，
// 这里对正文内容维护快照栈：连续输入 500ms 防抖合并为一步，程序化修改各自独立入栈。
// ============================================================
const NOTE_UNDO_LIMIT = 100;
const NOTE_UNDO_DEBOUNCE = 500;
let noteUndoStack = [];   // [{value, selStart, selEnd}]，栈顶 = 最近一次可撤销状态
let noteRedoStack = [];
let noteLastValue = '';   // 最近一次入栈/加载时的正文值（输入批的「批前内容」）
let noteTypingTimer = null;

function resetNoteUndoStack(value) {
    clearTimeout(noteTypingTimer);
    noteTypingTimer = null;
    noteUndoStack = [];
    noteRedoStack = [];
    noteLastValue = value;
}

function pushNoteHistory(stack, entry) {
    stack.push(entry);
    if (stack.length > NOTE_UNDO_LIMIT) stack.shift();
}

// 新编辑（输入批结算 / 程序化修改）入栈，并使 redo 栈失效
function pushNoteUndo(entry) {
    pushNoteHistory(noteUndoStack, entry);
    noteRedoStack = [];
}

// 连续输入：防抖 500ms，一批结束后把「批前内容」作为一步入栈
function scheduleTypingUndo() {
    if (S.imeComposing) return; // IME 组合期间不结算，compositionend 统一处理
    clearTimeout(noteTypingTimer);
    noteTypingTimer = setTimeout(commitTypingUndo, NOTE_UNDO_DEBOUNCE);
}

function commitTypingUndo() {
    clearTimeout(noteTypingTimer);
    noteTypingTimer = null;
    const ta = getVaultEls().vaultNoteContent;
    if (ta.value !== noteLastValue) {
        pushNoteUndo({ value: noteLastValue, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
        noteLastValue = ta.value;
    }
}

// 程序化修改前：先结算未完成的输入批，再把当前状态作为独立步进入栈
function noteUndoPoint() {
    commitTypingUndo();
    const ta = getVaultEls().vaultNoteContent;
    pushNoteUndo({ value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
}

// 程序化修改后：同步批前基线，避免紧接的输入把这次修改合并掉
function noteEdited() {
    noteLastValue = getVaultEls().vaultNoteContent.value;
}

function applyNoteHistoryEntry(entry) {
    const els = getVaultEls();
    const ta = els.vaultNoteContent;
    ta.value = entry.value;
    const pos = Math.min(entry.selStart ?? entry.value.length, entry.value.length);
    ta.selectionStart = ta.selectionEnd = pos;
    noteLastValue = ta.value;
    buildOutline();
    if (S.notePreviewMode) renderNotePreview();
    markNoteDirty();
}

function noteUndo() {
    commitTypingUndo(); // 进行中的输入批先结算为一步
    const entry = noteUndoStack.pop();
    if (!entry) { showToast(t('没有可撤销的操作')); return; }
    const ta = getVaultEls().vaultNoteContent;
    pushNoteHistory(noteRedoStack, { value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
    applyNoteHistoryEntry(entry);
}

function noteRedo() {
    commitTypingUndo();
    const entry = noteRedoStack.pop();
    if (!entry) { showToast(t('没有可重做的操作')); return; }
    const ta = getVaultEls().vaultNoteContent;
    pushNoteHistory(noteUndoStack, { value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
    applyNoteHistoryEntry(entry);
}

// ============================================================
// 编辑器：预览 / [[ 补全 / 大纲
// ============================================================
function noteNameExists(name) { return S.notes.some(n => n.name === name); }

function decodeHtmlEntities(str) {
    const ta = document.createElement('textarea'); ta.innerHTML = str; return ta.value;
}

function taskBadgeClass(status) {
    const s = String(status || '').toUpperCase();
    if (s === 'DOING') return 'task-doing';
    if (s === 'DONE') return 'task-done';
    return 'task-todo';
}

function pdfEmbedHtml(pdf) {
    const src = `/api/vault/assets/${encodeURIComponent(pdf.name)}` + (pdf.page ? `#page=${pdf.page}` : '');
    return `<iframe class="pdf-embed" src="${escapeHtmlAttr(src)}" loading="lazy"></iframe><div class="pdf-embed-actions"><a href="${escapeHtmlAttr(src)}" target="_blank" rel="noopener">${t('新窗口打开 {name}', { name: escapeHtml(pdf.name) })}</a></div>`;
}

// 多媒体嵌入（图片/视频/音频/docx 链接），name 为 decodeHtmlEntities 后的原始文件名
function mediaEmbedHtml(name) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    const src = escapeHtmlAttr(`/api/vault/assets/${encodeURIComponent(name)}`);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
        return `<img class="note-media-img" src="${src}" loading="lazy" alt="${escapeHtmlAttr(name)}">`;
    }
    if (['mp4', 'webm', 'mov'].includes(ext)) {
        // 语音听记录音（voice-*.webm）以音频播放器渲染
        if (/^voice-/i.test(name)) {
            return `<audio class="note-media-audio" src="${src}" controls></audio>`;
        }
        return `<video class="note-media-video" src="${src}" controls preload="metadata"></video>`;
    }
    if (['mp3', 'wav', 'm4a', 'ogg'].includes(ext)) {
        return `<audio class="note-media-audio" src="${src}" controls></audio>`;
    }
    // docx 等文档：复用 PDF 的链接式展示（新窗口打开，不嵌 iframe）
    return `<div class="pdf-embed-actions"><a href="${src}" target="_blank" rel="noopener">${t('新窗口打开 {name}', { name: escapeHtml(name) })}</a></div>`;
}

// 渲染管线顺序即 XSS 防线：整体 escapeHtml → 各语法在转义后文本上替换
// （块级语法换成 %%TOKEN%% 占位，marked 渲染后统一替换回 HTML）→ marked.parse → 后处理
function renderNotePreview() {
    const els = getVaultEls();
    let escaped = escapeHtml(els.vaultNoteContent.value);
    const pending = { pdfs: [], media: [], blocks: [], queries: [] };
    // 1. PDF 嵌入 ![[name.pdf|page]]（必须先于 wikilink）
    escaped = escaped.replace(/!\[\[([^\]]+?\.pdf)(?:\|(\d+))?\]\]/gi, (_m, name, page) => {
        const idx = pending.pdfs.length;
        pending.pdfs.push({ name: decodeHtmlEntities(name), page: page || '' });
        return `%%AIPPTPDF${idx}%%`;
    });
    // 1b. 多媒体嵌入 ![[name.ext]]（图片/视频/音频/docx，同阶段先于 wikilink）
    escaped = escaped.replace(/!\[\[([^\]]+?\.(?:png|jpe?g|gif|webp|mp4|webm|mov|mp3|wav|m4a|ogg|docx))\]\]/gi, (_m, name) => {
        const idx = pending.media.length;
        pending.media.push(decodeHtmlEntities(name));
        return `%%AIPPTMEDIA${idx}%%`;
    });
    // 2. 块引用 ((id))
    escaped = escaped.replace(/\(\(([A-Za-z0-9-]{4,})\)\)/g, (_m, id) => {
        const idx = pending.blocks.length;
        pending.blocks.push(id);
        return `%%AIPPTBLOCK${idx}%%`;
    });
    // 3. 查询块 {{query ...}}（先于 wikilink，保护查询参数中的 [[ ]]）
    escaped = escaped.replace(/\{\{query\s+([\s\S]+?)\}\}/g, (_m, q) => {
        const idx = pending.queries.length;
        pending.queries.push(decodeHtmlEntities(q).trim());
        return `%%AIPPTQUERY${idx}%%`;
    });
    // 4. [[wikilink]]
    escaped = escaped.replace(/\[\[([^\[\]\n]+)\]\]/g, (_m, rawName) => {
        const exists = noteNameExists(decodeHtmlEntities(rawName));
        const cls = exists ? 'wiki-link' : 'wiki-link wiki-link-dead';
        const title = exists ? '' : t('待创建：');
        return `<a href="#" class="${cls}" data-note="${rawName}" title="${title}${rawName}">${rawName}</a>`;
    });
    escaped = escaped.replace(/^((?:&gt;\s?)+)/gm, m => m.replace(/&gt;/g, '>'));
    // 5. 任务标记：行首 - TODO/DOING/DONE（含优先级 [#A]）
    escaped = escaped.replace(/^(\s*[-*]\s+)(TODO|DOING|DONE)(\s+\[#([ABC])\])?/gm, (_m, prefix, status, _pri, pri) => {
        return `${prefix}<span class="task-badge ${taskBadgeClass(status)}">${status}</span>${pri ? `<sup class="task-pri">${pri}</sup> ` : ''}`;
    });
    // 6. 属性行 key:: value
    escaped = escaped.replace(/^(\s*(?:[-*]\s+)?)([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)::[ \t]+(.+)$/gm, (_m, prefix, key, value) => {
        return `${prefix}<span class="prop-row"><b>${key}</b>: ${value}</span>`;
    });
    let html = marked.parse(escaped);
    html = html.replace(/%%AIPPTPDF(\d+)%%/g, (_m, i) => pdfEmbedHtml(pending.pdfs[Number(i)]));
    html = html.replace(/%%AIPPTMEDIA(\d+)%%/g, (_m, i) => mediaEmbedHtml(pending.media[Number(i)]));
    html = html.replace(/%%AIPPTBLOCK(\d+)%%/g, (_m, i) => `<blockquote class="block-ref" data-block-id="${pending.blocks[Number(i)]}"><span class="block-ref-loading">${t('加载中…')}</span></blockquote>`);
    html = html.replace(/%%AIPPTQUERY(\d+)%%/g, (_m, i) => `<div class="query-result" data-query="${escapeHtmlAttr(pending.queries[Number(i)])}"><span class="query-loading">${t('查询中…')}</span></div>`);
    els.vaultNotePreview.innerHTML = html;
    els.vaultNotePreview.querySelectorAll('img').forEach((img) => {
        const m = (img.getAttribute('alt') || '').match(/^(.*?)\|(\d{2,4})$/);
        if (m) { img.alt = m[1]; img.style.maxWidth = `${m[2]}px`; img.dataset.noteWidth = m[2]; }
        img.title = t('点击调整图片大小');
    });
    els.vaultNotePreview.querySelectorAll('h1, h2, h3').forEach((h, i) => { h.id = `note-h-${i}`; });
    els.vaultNotePreview.querySelectorAll('li').forEach((li) => {
        if (li.querySelector('.task-badge.task-done')) li.classList.add('task-done');
    });
    fillBlockRefs(els.vaultNotePreview);
    fillQueryBlocks(els.vaultNotePreview);
}

// 块引用异步填充（点击跳源笔记）
function fillBlockRefs(previewEl) {
    previewEl.querySelectorAll('.block-ref').forEach((el) => {
        const id = el.dataset.blockId;
        api('GET', `/api/vault/blocks/${encodeURIComponent(id)}`).then((data) => {
            el.innerHTML = `<span class="block-ref-text">${escapeHtml(data.text || '')}</span>`;
            el.dataset.note = data.note || '';
            el.title = data.note ? t('来自笔记：{note}（点击跳转）', { note: data.note }) : t('点击跳转来源');
        }).catch(() => {
            el.outerHTML = `<span class="block-ref-missing">${t('引用缺失 (({id}))', { id: escapeHtml(id) })}</span>`;
        });
    });
}

// 查询块异步填充
function fillQueryBlocks(previewEl) {
    previewEl.querySelectorAll('.query-result').forEach((el) => {
        const query = el.dataset.query;
        api('POST', '/api/vault/query', { query }).then((data) => {
            const results = data.results || [];
            if (!results.length) { el.innerHTML = `<div class="query-empty">${t('无结果')}</div>`; return; }
            el.innerHTML = results.map((r) => `<div class="query-item" data-note="${escapeHtmlAttr(r.note || '')}">${r.status ? `<span class="task-badge ${taskBadgeClass(r.status)}">${escapeHtml(String(r.status).toUpperCase())}</span>` : ''}${r.priority ? `<sup class="task-pri">${escapeHtml(String(r.priority).replace(/[#\[\]]/g, ''))}</sup>` : ''}<span class="query-item-note">${escapeHtml(r.note || '')}</span><span class="query-item-text">${escapeHtml(r.text || '')}</span></div>`).join('');
        }).catch((err) => {
            el.innerHTML = `<div class="query-error">${escapeHtml(err.message || t('查询失败'))}</div>`;
        });
    });
}

function setNotePreviewMode(on) {
    S.notePreviewMode = on;
    const els = getVaultEls();
    els.vaultNoteEditArea.classList.toggle('hidden', on);
    els.vaultNotePreview.classList.toggle('hidden', !on);
    els.btnVaultNotePreview.textContent = on ? t('编辑') : t('预览');
    els.btnVaultNotePreview.classList.toggle('active', on);
    if (on) renderNotePreview(); else hideWikiSuggest();
}

async function createNoteFromWikiLink(name) {
    try {
        const res = await fetch('/api/vault/notes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, content: `# ${name}\n` })
        });
        if (res.ok) { showToast(t('已创建笔记「{name}」', { name })); await loadNotes(); selectNote(name); }
        else { const err = await res.json(); showToast(err.error || t('创建失败')); }
    } catch (e) { console.error('Failed to create note from wikilink:', e); showToast(t('创建失败')); }
}

function getCaretPixelPos(textarea, caretIndex) {
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const props = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
        'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];
    mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;';
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.boxSizing = style.boxSizing;
    for (const p of props) mirror.style[p] = style[p];
    mirror.textContent = textarea.value.substring(0, caretIndex);
    const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    const pos = { left: marker.offsetLeft, top: marker.offsetTop, lineHeight };
    document.body.removeChild(mirror);
    return pos;
}

function hideWikiSuggest() {
    S.wikiSuggest.open = false;
    const el = getVaultEls().wikiSuggestEl;
    if (el) el.classList.add('hidden');
}

async function ensureVaultAssets() {
    if (S.vaultAssets) return S.vaultAssets;
    try {
        const data = await api('GET', '/api/vault/assets');
        S.vaultAssets = (data.files || []).map((f) => f.name);
    } catch (e) {
        console.error('Failed to load vault assets:', e);
        S.vaultAssets = [];
    }
    return S.vaultAssets;
}

function positionWikiSuggest(ta, caret) {
    const el = getVaultEls().wikiSuggestEl;
    const pos = getCaretPixelPos(ta, caret);
    el.style.left = `${pos.left - ta.scrollLeft}px`;
    el.style.top = `${pos.top + pos.lineHeight - ta.scrollTop}px`;
    el.classList.remove('hidden');
}

function updateWikiSuggest() {
    const els = getVaultEls();
    const ta = els.vaultNoteContent;
    if (S.imeComposing || S.notePreviewMode) { hideWikiSuggest(); return; }
    const caret = ta.selectionStart;
    const before = ta.value.substring(0, caret);
    const mp = before.match(/!\[\[([^\[\]\n]*)$/);
    if (mp) {
        const filter = mp[1].toLowerCase();
        const startPos = caret - mp[1].length - 3;
        ensureVaultAssets().then((assets) => {
            if (S.imeComposing || S.notePreviewMode) { hideWikiSuggest(); return; }
            const items = assets.filter((n) => /\.(pdf|docx|png|jpe?g|gif|webp|mp4|webm|mov|mp3|wav|m4a|ogg)$/i.test(n) && n.toLowerCase().includes(filter)).slice(0, 20);
            if (items.length === 0) { hideWikiSuggest(); return; }
            S.wikiSuggest = { open: true, startPos, items, activeIndex: 0, mode: 'pdf' };
            renderWikiSuggest();
            positionWikiSuggest(ta, caret);
        });
        return;
    }
    const m = before.match(/\[\[([^\[\]\n]*)$/);
    if (!m) { hideWikiSuggest(); return; }
    const filter = m[1].toLowerCase();
    const items = S.notes.map(n => n.name).filter(name => name && name.toLowerCase().includes(filter)).slice(0, 20);
    if (items.length === 0) { hideWikiSuggest(); return; }
    S.wikiSuggest = { open: true, startPos: caret - m[1].length - 2, items, activeIndex: 0 };
    renderWikiSuggest();
    positionWikiSuggest(ta, caret);
}

function renderWikiSuggest() {
    const els = getVaultEls();
    els.wikiSuggestEl.innerHTML = S.wikiSuggest.items.map((name, i) =>
        `<div class="wiki-suggest-item ${i === S.wikiSuggest.activeIndex ? 'active' : ''}" data-index="${i}">${escapeHtml(name)}</div>`
    ).join('');
}

function applyWikiSuggest(index) {
    const name = S.wikiSuggest.items[index];
    if (!name) return;
    const els = getVaultEls();
    const ta = els.vaultNoteContent;
    const caret = ta.selectionStart;
    const inserted = S.wikiSuggest.mode === 'pdf' ? `![[${name}]]` : `[[${name}]]`;
    noteUndoPoint();
    ta.value = ta.value.substring(0, S.wikiSuggest.startPos) + inserted + ta.value.substring(caret);
    const newCaret = S.wikiSuggest.startPos + inserted.length;
    ta.selectionStart = ta.selectionEnd = newCaret;
    noteEdited();
    ta.focus(); hideWikiSuggest(); buildOutline();
    markNoteDirty();
}

function handleWikiSuggestKeydown(e) {
    if (!S.wikiSuggest.open) return false;
    if (e.key === 'ArrowDown') { S.wikiSuggest.activeIndex = (S.wikiSuggest.activeIndex + 1) % S.wikiSuggest.items.length; renderWikiSuggest(); return true; }
    if (e.key === 'ArrowUp') { S.wikiSuggest.activeIndex = (S.wikiSuggest.activeIndex - 1 + S.wikiSuggest.items.length) % S.wikiSuggest.items.length; renderWikiSuggest(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { applyWikiSuggest(S.wikiSuggest.activeIndex); return true; }
    if (e.key === 'Escape') { hideWikiSuggest(); return true; }
    return false;
}

function buildOutline() {
    const els = getVaultEls();
    const lines = els.vaultNoteContent.value.split('\n');
    S.outlineItems = [];
    let inCode = false;
    lines.forEach((line, lineNo) => {
        if (/^\s*```/.test(line)) { inCode = !inCode; return; }
        if (inCode) return;
        const m = line.match(/^(#{1,3})\s+(.+)$/);
        if (m) S.outlineItems.push({ level: m[1].length, text: m[2].trim(), line: lineNo });
    });
    if (S.outlineItems.length === 0) {
        els.vaultNoteOutlineList.innerHTML = `<div style="opacity:0.5;font-size:12px;padding:4px 0;">${t('暂无标题')}</div>`;
        return;
    }
    els.vaultNoteOutlineList.innerHTML = S.outlineItems.map((item, i) =>
        `<div class="vault-outline-item vault-outline-level-${item.level}" data-index="${i}" title="${escapeHtmlAttr(item.text)}">${escapeHtml(item.text)}</div>`
    ).join('');
}

function jumpToOutlineItem(index) {
    const item = S.outlineItems[index];
    if (!item) return;
    const els = getVaultEls();
    if (S.notePreviewMode) {
        const target = document.getElementById(`note-h-${index}`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    const ta = els.vaultNoteContent;
    const lines = ta.value.split('\n');
    let offset = 0;
    for (let i = 0; i < item.line; i++) offset += lines[i].length + 1;
    ta.focus(); ta.selectionStart = ta.selectionEnd = offset;
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 21;
    ta.scrollTop = Math.max(0, (item.line - 2) * lineHeight);
}

function openNoteGenerateModal() {
    if (!S.currentNote) return;
    if (_cb.openGenerateModal) _cb.openGenerateModal({ kind: 'note', name: S.currentNote });
}

// ============================================================
// 快速跳转（Quick Switcher，Ctrl+Shift+O）
// ============================================================
function getQuickOpenEls() {
    return {
        modal: document.getElementById('quick-open-modal'),
        input: document.getElementById('quick-open-input'),
        list: document.getElementById('quick-open-list')
    };
}

async function openQuickOpen() {
    const qo = getQuickOpenEls();
    if (!qo.modal) return;
    if (S.notes.length === 0) {
        try { const res = await fetch('/api/vault/notes'); S.notes = await res.json(); } catch (e) { console.error(e); }
    }
    S.quickOpen = { items: [], activeIndex: 0 };
    qo.input.value = '';
    qo.modal.classList.remove('hidden');
    renderQuickOpenList();
    qo.input.focus();
}
export { openQuickOpen };

function closeQuickOpen() {
    const qo = getQuickOpenEls();
    if (qo.modal) qo.modal.classList.add('hidden');
}

function filterQuickOpenItems(query) {
    const sorted = [...S.notes].sort((a, b) => {
        const ta = a.mtime ? new Date(a.mtime).getTime() : 0;
        const tb = b.mtime ? new Date(b.mtime).getTime() : 0;
        if (ta !== tb) return tb - ta;
        return (a.name || '').localeCompare(b.name || '');
    });
    const q = query.trim().toLowerCase();
    const matched = q ? sorted.filter((n) => n.name && n.name.toLowerCase().includes(q)) : sorted;
    matched.sort((a, b) => {
        if (!q) return 0;
        const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return pa - pb;
    });
    return matched.slice(0, 50);
}

function renderQuickOpenList() {
    const qo = getQuickOpenEls();
    S.quickOpen.items = filterQuickOpenItems(qo.input.value);
    if (S.quickOpen.activeIndex >= S.quickOpen.items.length) S.quickOpen.activeIndex = 0;
    if (S.quickOpen.items.length === 0) { qo.list.innerHTML = `<div class="quick-open-empty">${t('无匹配笔记')}</div>`; return; }
    qo.list.innerHTML = S.quickOpen.items.map((n, i) =>
        `<div class="quick-open-item ${i === S.quickOpen.activeIndex ? 'active' : ''}" data-index="${i}">${escapeHtml(n.name)}</div>`
    ).join('');
}

function openQuickOpenItem(index) {
    const item = S.quickOpen.items[index];
    if (!item) return;
    closeQuickOpen();
    if (S.currentSidebarTab !== 'vault' && _cb.switchSidebarTab) _cb.switchSidebarTab('vault');
    document.getElementById('sidebar')?.classList.remove('collapsed');
    selectNote(item.name);
}

export function bindQuickOpenEvents() {
    const qo = getQuickOpenEls();
    if (!qo.modal) return;
    qo.input.addEventListener('input', () => { S.quickOpen.activeIndex = 0; renderQuickOpenList(); });
    qo.input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (S.quickOpen.items.length) { S.quickOpen.activeIndex = (S.quickOpen.activeIndex + 1) % S.quickOpen.items.length; renderQuickOpenList(); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (S.quickOpen.items.length) { S.quickOpen.activeIndex = (S.quickOpen.activeIndex - 1 + S.quickOpen.items.length) % S.quickOpen.items.length; renderQuickOpenList(); } }
        else if (e.key === 'Enter') { e.preventDefault(); openQuickOpenItem(S.quickOpen.activeIndex); }
        else if (e.key === 'Escape') { e.preventDefault(); closeQuickOpen(); }
    });
    qo.list.addEventListener('click', (e) => {
        const item = e.target.closest('.quick-open-item');
        if (item) openQuickOpenItem(Number(item.dataset.index));
    });
    qo.modal.querySelector('.modal-backdrop').addEventListener('click', closeQuickOpen);
}

// ============================================================
// 每日笔记（Logseq 式，journal-YYYY-MM-DD）
// ============================================================
function pad2(n) { return String(n).padStart(2, '0'); }
function todayJournalName() {
    const d = new Date();
    return `journal-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

async function ensureTodayNote() {
    const name = todayJournalName();
    const res = await fetch(`/api/vault/notes/${encodeURIComponent(name)}`);
    if (res.status === 404) {
        const dateStr = name.replace('journal-', '');
        const content = `---\ntype: journal\ntags: [日记]\n---\n\n# ${dateStr}\n`;
        const createRes = await fetch('/api/vault/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) });
        if (!createRes.ok) throw new Error(t('创建今日笔记失败'));
        await loadNotes();
        return { name, content };
    }
    if (!res.ok) throw new Error(t('读取今日笔记失败'));
    const data = await res.json();
    return { name, content: data.content || '' };
}

export async function openTodayNote() {
    try {
        const { name } = await ensureTodayNote();
        if (S.currentSidebarTab !== 'vault' && _cb.switchSidebarTab) _cb.switchSidebarTab('vault');
        document.getElementById('sidebar')?.classList.remove('collapsed');
        selectNote(name);
    } catch (e) { console.error('Failed to open today note:', e); showToast(e.message || t('打开今日笔记失败')); }
}

export async function appendFragmentToToday(id) {
    const f = S.fragments.find((x) => x.id === id);
    if (!f) return;
    try {
        const { name, content } = await ensureTodayNote();
        const now = new Date();
        const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
        const text = (f.content || '').replace(/\s+/g, ' ').trim();
        const line = `- ${time} ${text}`;
        const newContent = (content.endsWith('\n') ? content : content + '\n') + line + '\n';
        const putRes = await fetch(`/api/vault/notes/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: newContent }) });
        if (!putRes.ok) throw new Error(t('写入今日笔记失败'));
        await api('PUT', `/api/vault/fragments/${encodeURIComponent(id)}`, { status: 'organized' });
        showToast(t('已附加到今日笔记（{date}）', { date: name.replace('journal-', '') }));
        if (_cb.loadFragments) await _cb.loadFragments();
    } catch (e) { console.error('Failed to append fragment to today note:', e); showToast(e.message || t('操作失败')); }
}

// ============================================================
// 笔记 AI 对话修改（契约 O）
// ============================================================
let noteChatBusy = false;

function getNoteChatEls() {
    return {
        dock: document.getElementById('note-chat-dock'),
        messages: document.getElementById('note-chat-messages'),
        input: document.getElementById('note-chat-input'),
        sendBtn: document.getElementById('btn-note-chat-send')
    };
}

function toggleNoteChatDock() {
    const { dock, input } = getNoteChatEls();
    dock.classList.toggle('hidden');
    if (!dock.classList.contains('hidden')) input.focus();
}

function appendNoteChatMessage(text, role) {
    const { messages } = getNoteChatEls();
    const div = document.createElement('div');
    div.className = 'chat-message ' + role;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
}

async function sendNoteChatMessage() {
    const { input, sendBtn } = getNoteChatEls();
    const instruction = input.value.trim();
    if (!instruction || !S.currentNote || noteChatBusy) return;
    appendNoteChatMessage(instruction, 'user');
    input.value = '';
    noteChatBusy = true;
    sendBtn.disabled = true;
    const progressMsg = appendNoteChatMessage(t('修改已启动…'), 'system');
    const noteName = S.currentNote;
    const chatStartTs = new Date().toISOString().replace(/[:.]/g, '-'); // 与 .snapshots/_vault 目录名同格式，用于定位本次修改前的备份
    try {
        const sessionApiKey = S.els.inputModelApiKey?.value.trim();
        await api('POST', `/api/vault/notes/${encodeURIComponent(noteName)}/chat`, {
            instruction, ...(sessionApiKey ? { apiKey: sessionApiKey } : {})
        });
    } catch (err) {
        progressMsg.remove();
        appendNoteChatMessage(t('修改失败：{msg}', { msg: withLlmSettingsHint(err.message) }), 'error');
        noteChatBusy = false; sendBtn.disabled = false; return;
    }
    const finish = () => { noteChatBusy = false; sendBtn.disabled = false; };
    const es = new EventSource(`/api/vault/notes/${encodeURIComponent(noteName)}/chat/events`);
    es.onmessage = (e) => {
        let event;
        try { event = JSON.parse(e.data); } catch { event = { type: 'progress', message: e.data }; }
        if (event.type === 'progress') { progressMsg.textContent = event.message || event.step || t('修改中…'); }
        else if (event.type === 'done') {
            progressMsg.remove();
            const content = (event.summary || t('修改已完成.')) + (event.details ? '\n\n' + event.details : '');
            const msgDiv = appendNoteChatMessage(content, 'assistant');
            addNoteChatUndoButton(msgDiv, noteName, chatStartTs);
            es.close(); finish();
            // AI 已直接改写服务端笔记：清除本地脏标记与草稿后重新加载
            removeNoteDraft(noteName);
            if (S.currentNote === noteName) selectNote(noteName);
        } else if (event.type === 'error') {
            progressMsg.remove();
            appendNoteChatMessage(t('修改失败：{msg}', { msg: withLlmSettingsHint(event.message) }), 'error');
            es.close(); finish();
        }
    };
    es.onerror = () => {
        progressMsg.remove();
        appendNoteChatMessage(t('进度连接中断，请稍后手动刷新笔记查看结果。'), 'error');
        es.close(); finish();
    };
}

// ============================================================
// AI 配图（笔记 / 项目共用）：生成后结果区按上下文提供「插入笔记 / 插入幻灯片」
// ============================================================
let aiImageTarget = null;
let lastAiImage = null; // { name, webPath, prompt, fromVault }

export function openAiImageModal(target) {
    aiImageTarget = target;
    lastAiImage = null;
    const input = document.getElementById('ai-image-prompt');
    const btn = document.getElementById('btn-confirm-ai-image');
    document.getElementById('ai-image-modal-title').textContent = target === 'vault' ? t('生成笔记配图') : t('生成幻灯片配图');
    input.value = ''; btn.disabled = false; btn.textContent = t('生成');
    document.getElementById('ai-image-result').classList.add('hidden');
    document.getElementById('ai-image-modal').classList.remove('hidden');
    input.focus();
}

export async function confirmAiImage() {
    const prompt = document.getElementById('ai-image-prompt').value.trim();
    if (!prompt) { showToast(t('请输入图片描述')); return; }
    if (!aiImageTarget) return;
    const btn = document.getElementById('btn-confirm-ai-image');
    btn.disabled = true; btn.textContent = t('生成中…');
    try {
        const data = await api('POST', '/api/media/image', { prompt, target: aiImageTarget });
        const webPath = data.webPath || '';
        if (!webPath) { showToast(t('配图已生成，但未返回图片路径')); return; }
        lastAiImage = {
            webPath,
            name: decodeURIComponent(webPath.split('/').pop()),
            prompt,
            fromVault: aiImageTarget === 'vault',
        };
        // 结果区按上下文显隐动作：打开笔记时可插入笔记，选中项目时可插入幻灯片
        document.getElementById('ai-image-preview').src = webPath;
        document.getElementById('btn-ai-image-insert-note').classList.toggle('hidden', !S.currentNote);
        document.getElementById('btn-ai-image-insert-slide').classList.toggle('hidden', !S.currentProject);
        document.getElementById('ai-image-result').classList.remove('hidden');
    } catch (e) { console.error('Failed to generate image:', e); showToast(t('生成配图失败：{msg}', { msg: e.message })); }
    finally { btn.disabled = false; btn.textContent = t('生成'); }
}

// 插入当前笔记光标处：vault 资产用 ![[name]] 嵌入（复用插入文本逻辑，触发脏标记 + 自动保存），
// 项目资产无法按名嵌入，回退为 Markdown 图片链接
export function insertAiImageIntoNote() {
    if (!lastAiImage) { showToast(t('请先生成配图')); return; }
    if (!S.currentNote) { showToast(t('请先选择一篇笔记')); return; }
    if (!lastAiImage.fromVault) { insertImageIntoNote(lastAiImage); return; }
    insertTextAtCursor(`![[${lastAiImage.name}]]`);
    showToast(t('配图已插入笔记，记得保存'));
    document.getElementById('ai-image-modal').classList.add('hidden');
}

// 插入选中项目：默认在末页前新建图片页（vault 产物由服务端先复制进项目 assets 并快照落盘）
export async function insertAiImageIntoSlide() {
    if (!lastAiImage) { showToast(t('请先生成配图')); return; }
    if (!S.currentProject) { showToast(t('请先选择项目')); return; }
    try {
        const data = await api('POST', `/api/projects/${encodeURIComponent(S.currentProject)}/insert-image`, {
            asset: lastAiImage.name,
            from: lastAiImage.fromVault ? 'vault' : undefined,
            title: lastAiImage.prompt.slice(0, 20),
        });
        showToast(data.mode === 'append' ? t('配图已追加到第 {page} 页', { page: data.slide }) : t('已新建图片页（第 {page} 页）', { page: data.slide }));
        document.getElementById('ai-image-modal').classList.add('hidden');
        if (_cb.updatePreview) _cb.updatePreview();
    } catch (e) { console.error('Failed to insert image into deck:', e); showToast(t('插入幻灯片失败：{msg}', { msg: e.message })); }
}

function insertImageIntoNote(data) {
    const webPath = data.webPath || '';
    if (!webPath) { showToast(t('配图已生成，但未返回图片路径')); return; }
    const textarea = document.getElementById('vault-note-content');
    const md = `![配图|480](${webPath})`;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    noteUndoPoint();
    textarea.value = textarea.value.slice(0, start) + md + textarea.value.slice(end);
    const pos = start + md.length;
    textarea.focus(); textarea.setSelectionRange(pos, pos);
    noteEdited();
    if (S.notePreviewMode) renderNotePreview();
    markNoteDirty();
    showToast(t('配图已插入笔记，预览中点击图片可调整大小，记得保存'));
    document.getElementById('ai-image-modal').classList.add('hidden');
}

function updateNoteImageWidth(src, width) {
    const els = getVaultEls();
    const ta = els.vaultNoteContent;
    const escSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(!\\[)([^\\]\\|]*)(\\|\\d{2,4})?(\\]\\(' + escSrc + '[^)]*\\))');
    noteUndoPoint();
    ta.value = ta.value.replace(re, (_m, p1, alt, _w, p4) => width ? `${p1}${alt}|${width}${p4}` : `${p1}${alt}${p4}`);
    noteEdited();
    markNoteDirty();
}

let imgResizeFor = null;
function showImgResizeBar(img) {
    hideImgResizeBar();
    imgResizeFor = img;
    const bar = document.createElement('div'); bar.id = 'note-img-resize';
    const sizes = [[t('小'), 320], [t('中'), 480], [t('大'), 720], [t('原始'), null]];
    for (const [label, w] of sizes) {
        const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = label;
        const current = img.dataset.noteWidth || '';
        if ((w === null && !current) || String(w) === current) btn.classList.add('active');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const src = img.getAttribute('src') || '';
            updateNoteImageWidth(src, w);
            renderNotePreview();
            showToast(w ? t('图片宽度已调整为 {w}px，记得保存', { w }) : t('图片已恢复原始大小，记得保存'));
        });
        bar.appendChild(btn);
    }
    const preview = getVaultEls().vaultNotePreview;
    preview.appendChild(bar);
    const pr = preview.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    bar.style.top = `${ir.bottom - pr.top + preview.scrollTop + 6}px`;
    bar.style.left = `${ir.left - pr.left + preview.scrollLeft}px`;
}
function hideImgResizeBar() { imgResizeFor = null; document.getElementById('note-img-resize')?.remove(); }

// ============================================================
// 编辑器：任务状态循环（Ctrl/Cmd+Enter）
// ============================================================
function toggleTaskInTextarea(ta) {
    const pos = ta.selectionStart;
    const value = ta.value;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    let lineEnd = value.indexOf('\n', pos);
    if (lineEnd < 0) lineEnd = value.length;
    const line = value.slice(lineStart, lineEnd);
    const m = line.match(/^(\s*[-*]\s+)(?:(TODO|DOING|DONE)\s+)?(.*)$/);
    if (!m) return;
    const cycle = { '': 'TODO', TODO: 'DOING', DOING: 'DONE', DONE: '' };
    const next = cycle[m[2] || ''];
    const newLine = next ? `${m[1]}${next} ${m[3]}` : `${m[1]}${m[3]}`;
    if (newLine === line) return;
    const delta = newLine.length - line.length;
    noteUndoPoint();
    ta.setRangeText(newLine, lineStart, lineEnd, 'preserve');
    const newPos = Math.min(Math.max(lineStart, pos + delta), lineStart + newLine.length);
    ta.selectionStart = ta.selectionEnd = newPos;
    noteEdited();
    buildOutline();
    markNoteDirty();
}

function insertTextAtCursor(text) {
    const els = getVaultEls();
    const ta = els.vaultNoteContent;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    noteUndoPoint();
    ta.setRangeText(text, start, end, 'end');
    noteEdited();
    ta.focus();
    if (S.notePreviewMode) renderNotePreview();
    buildOutline();
    markNoteDirty();
}

// ============================================================
// 附件上传（笔记工具栏，图片/文档/音频/视频）
// ============================================================
const ASSET_LIMITS = { image: 10 * 1024 * 1024, doc: 20 * 1024 * 1024, audio: 80 * 1024 * 1024, video: 80 * 1024 * 1024 };
const ASSET_LIMIT_LABEL = { image: '10MB', doc: '20MB', audio: '80MB', video: '80MB' };

function classifyAssetKind(file) {
    const ext = (String(file.name || '').split('.').pop() || '').toLowerCase();
    const mime = String(file.type || '');
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) || mime.startsWith('image/')) return 'image';
    if (['pdf', 'docx'].includes(ext)) return 'doc';
    if (['mp3', 'wav', 'm4a', 'ogg'].includes(ext) || mime.startsWith('audio/')) return 'audio';
    if (['mp4', 'webm', 'mov'].includes(ext) || mime.startsWith('video/')) return 'video';
    return null;
}

function handleAssetUpload(file) {
    if (!file) return;
    const kind = classifyAssetKind(file);
    if (!kind) { showToast(t('不支持的附件类型：{name}', { name: file.name }), 'error'); return; }
    if (file.size > ASSET_LIMITS[kind]) { showToast(t('附件不能超过 {limit}', { limit: ASSET_LIMIT_LABEL[kind] }), 'error'); return; }
    // multipart 流式上传（不再 base64 转 JSON）
    const fd = new FormData();
    fd.append('name', file.name);
    fd.append('file', file, file.name);
    apiUpload('/api/vault/assets', fd).then((data) => {
        S.vaultAssets = null;
        insertTextAtCursor(`![[${data.name || file.name}]]`);
        showToast(t('附件已上传并插入：{name}', { name: data.name || file.name }));
    }).catch((err) => {
        console.error('Failed to upload asset:', err);
        showToast(t('附件上传失败：{msg}', { msg: err.message }), 'error');
    });
}

// ============================================================
// 资产库（vault/assets 管理：列表 / 插入笔记 / 删除，删除有引用保护）
// ============================================================
const ASSET_KIND_ICON = { video: '🎬', audio: '🎵', doc: '📄', other: '📎' };

function assetKindOf(name) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'm4a', 'ogg'].includes(ext)) return 'audio';
    if (['pdf', 'docx'].includes(ext)) return 'doc';
    return 'other';
}

function formatAssetSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

export function openAssetsModal() {
    document.getElementById('assets-modal').classList.remove('hidden');
    loadAssetsIntoModal();
}

async function loadAssetsIntoModal() {
    const list = document.getElementById('assets-list');
    list.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('加载中…')}</div>`;
    try {
        const data = await api('GET', '/api/vault/assets?refs=1');
        renderAssetsList(data.files || []);
    } catch (e) {
        console.error('Failed to load assets:', e);
        list.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('加载失败：{msg}', { msg: escapeHtml(e.message) })}</div>`;
    }
}

function renderAssetsList(files) {
    const list = document.getElementById('assets-list');
    if (!files.length) {
        list.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('暂无资产，可通过「附件」上传或「生成配图」生成')}</div>`;
        return;
    }
    list.innerHTML = files.map((f) => {
        const kind = assetKindOf(f.name);
        const thumb = kind === 'image'
            ? `<img class="asset-thumb" src="/api/vault/assets/${encodeURIComponent(f.name)}" alt="">`
            : `<div class="asset-thumb">${ASSET_KIND_ICON[kind]}</div>`;
        const refBadge = f.referenced ? `<span class="asset-ref-badge">${t('被引用')}</span>` : t('未被引用');
        return `<div class="asset-item" data-name="${escapeHtmlAttr(f.name)}">
          ${thumb}
          <div class="asset-info">
            <div class="asset-name">${escapeHtml(f.name)}</div>
            <div class="asset-meta">${formatAssetSize(f.size)} · ${refBadge}</div>
          </div>
          <div class="asset-actions">
            <button class="btn-secondary asset-btn-insert">${t('插入')}</button>
            <button class="btn-secondary asset-btn-delete" style="color:var(--danger);">${t('删除')}</button>
          </div>
        </div>`;
    }).join('');
    list.querySelectorAll('.asset-item').forEach((item) => {
        const name = item.dataset.name;
        item.querySelector('.asset-btn-insert').addEventListener('click', () => insertAssetIntoNote(name));
        item.querySelector('.asset-btn-delete').addEventListener('click', () => deleteAsset(name));
    });
}

function insertAssetIntoNote(name) {
    if (!S.currentNote) { showToast(t('请先选择一篇笔记')); return; }
    insertTextAtCursor(`![[${name}]]`);
    showToast(t('已插入笔记：{name}，记得保存', { name }));
    document.getElementById('assets-modal').classList.add('hidden');
}

// 删除资产：被引用时服务端返回 409 + 引用方列表，确认后带 force=true 重试
async function deleteAsset(name, force = false) {
    try {
        await api('DELETE', `/api/vault/assets/${encodeURIComponent(name)}${force ? '?force=true' : ''}`);
        showToast(t('已删除：{name}', { name }));
        loadAssetsIntoModal();
    } catch (e) {
        if (e.status === 409 && e.data?.references) {
            const refs = [...(e.data.references.notes || []), ...(e.data.references.fragments || [])];
            const ok = await showConfirmModal({
                title: t('资产仍被引用'),
                message: t('「{name}」正被引用：{refs}。删除后这些嵌入将失效，确认强制删除？', { name, refs: refs.join('、') }),
                confirmText: t('强制删除'),
                danger: true,
            });
            if (ok) return deleteAsset(name, true);
            return;
        }
        console.error('Failed to delete asset:', e);
        showToast(t('删除失败：{msg}', { msg: e.message }), 'error');
    }
}

// ============================================================
// 任务面板（#tasks-panel）
// ============================================================
function showTasksPanel() {
    if (_cb.hideAllMainPanels) _cb.hideAllMainPanels();
    document.getElementById('tasks-panel').classList.remove('hidden');
    loadTasks();
}

function hideTasksPanel() {
    document.getElementById('tasks-panel').classList.add('hidden');
    if (_cb.switchSidebarTab) _cb.switchSidebarTab(S.currentSidebarTab);
}

async function loadTasks() {
    const body = document.getElementById('tasks-body');
    if (!body) return;
    body.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('加载中…')}</div>`;
    try {
        const data = await api('GET', '/api/vault/tasks');
        renderTasks(data.tasks || []);
    } catch (e) {
        console.error('Failed to load tasks:', e);
        body.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('加载任务失败')}</div>`;
    }
}

function renderTasks(tasks) {
    const body = document.getElementById('tasks-body');
    if (!tasks.length) { body.innerHTML = `<div style="opacity:0.5;font-size:13px;">${t('暂无任务，在笔记中写 - TODO 事项即可')}</div>`; return; }
    const groups = [['DOING', '进行中'], ['TODO', '待办'], ['DONE', '已完成']];
    body.innerHTML = groups.map(([status, label]) => {
        const items = tasks.filter((t) => String(t.status || '').toUpperCase() === status);
        if (!items.length) return '';
        return `<div class="tasks-group">
        <div class="tasks-group-title">${t(label)}（${items.length}）</div>
        <div class="tasks-group-list">${items.map((t) => `<div class="tasks-item" data-note="${escapeHtmlAttr(t.note || '')}">
          <span class="task-badge ${taskBadgeClass(status)}">${status}</span>${t.priority ? `<sup class="task-pri">${escapeHtml(String(t.priority).replace(/[#\[\]]/g, ''))}</sup>` : ''}
          <span class="tasks-item-text">${escapeHtml(t.text || '')}</span>
          <span class="tasks-item-note">${escapeHtml(t.note || '')}</span>
        </div>`).join('')}</div>
      </div>`;
    }).join('');
}

// ============================================================
// Journal 导航（journal-YYYY-MM-DD）
// ============================================================
function updateJournalNav() {
    const nav = document.getElementById('vault-journal-nav');
    if (!nav) return;
    const isJournal = /^journal-\d{4}-\d{2}-\d{2}$/.test(S.currentNote || '');
    nav.classList.toggle('hidden', !isJournal);
    if (!isJournal) document.getElementById('journal-list-dropdown')?.classList.add('hidden');
}

async function gotoJournal(offsetDays) {
    const m = (S.currentNote || '').match(/^journal-(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offsetDays);
    const name = `journal-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    if (!noteNameExists(name)) {
        const dateStr = name.replace('journal-', '');
        const content = `---\ntype: journal\ntags: [日记]\n---\n\n# ${dateStr}\n`;
        try {
            const res = await fetch('/api/vault/notes', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, content })
            });
            if (!res.ok) { const err = await res.json().catch(() => ({})); showToast(err.error || t('创建日记失败')); return; }
            await loadNotes();
        } catch (e) { console.error('Failed to create journal:', e); showToast(t('创建日记失败')); return; }
    }
    selectNote(name);
}

function toggleJournalList() {
    const dd = document.getElementById('journal-list-dropdown');
    if (!dd) return;
    if (!dd.classList.contains('hidden')) { dd.classList.add('hidden'); return; }
    const journals = S.notes
        .filter((n) => /^journal-\d{4}-\d{2}-\d{2}$/.test(n.name))
        .sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0));
    dd.innerHTML = journals.length
        ? journals.map((n) => `<div class="journal-list-item ${n.name === S.currentNote ? 'active' : ''}" data-name="${escapeHtmlAttr(n.name)}">${escapeHtml(n.name.replace('journal-', ''))}</div>`).join('')
        : `<div class="journal-list-empty">${t('暂无日记')}</div>`;
    dd.classList.remove('hidden');
}

// ============================================================
// 事件绑定
// ============================================================
export function bindVaultEvents() {
    const els = getVaultEls();
    for (const tab of els.sidebarTabs) { tab.addEventListener('click', () => { if (_cb.switchSidebarTab) _cb.switchSidebarTab(tab.dataset.tab); }); }
    els.vaultNoteList.addEventListener('click', (e) => {
        const check = e.target.closest('.vault-note-check');
        if (check) {
            const name = check.dataset.name;
            if (name) {
                if (check.checked) S.selectedNotes.add(name);
                else S.selectedNotes.delete(name);
                updateNoteSelectBar();
            }
            return;
        }
        const item = e.target.closest('.vault-note-item');
        const linkItem = e.target.closest('.vault-link-item');
        if (linkItem) { const name = linkItem.dataset.name; if (name) selectNote(name); return; }
        if (item) selectNote(item.dataset.name);
    });
    els.vaultSearchInput.addEventListener('input', e => renderNoteList(e.target.value));
    els.btnVaultRefresh.addEventListener('click', loadNotes);
    els.btnVaultNew.addEventListener('click', createNewNote);
    document.getElementById('btn-vault-journal')?.addEventListener('click', openTodayNote);
    document.getElementById('btn-vault-tasks')?.addEventListener('click', showTasksPanel);
    document.getElementById('btn-tasks-close')?.addEventListener('click', hideTasksPanel);
    document.getElementById('tasks-body')?.addEventListener('click', (e) => {
        const item = e.target.closest('.tasks-item');
        const name = item?.dataset.note;
        if (!name) return;
        hideTasksPanel();
        if (S.currentSidebarTab !== 'vault' && _cb.switchSidebarTab) _cb.switchSidebarTab('vault');
        selectNote(name);
    });
    document.getElementById('btn-journal-prev')?.addEventListener('click', () => gotoJournal(-1));
    document.getElementById('btn-journal-next')?.addEventListener('click', () => gotoJournal(1));
    document.getElementById('btn-journal-list')?.addEventListener('click', (e) => { e.stopPropagation(); toggleJournalList(); });
    document.getElementById('journal-list-dropdown')?.addEventListener('click', (e) => {
        const item = e.target.closest('.journal-list-item');
        if (!item || !item.dataset.name) return;
        document.getElementById('journal-list-dropdown').classList.add('hidden');
        selectNote(item.dataset.name);
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.journal-list-wrap')) document.getElementById('journal-list-dropdown')?.classList.add('hidden');
    });
    // 「⋯ 更多」下拉（与项目工具栏导出下拉同一套 .dropdown 样式与交互）
    document.getElementById('btn-vault-note-more')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelector('#vault-note-more-dropdown .dropdown-menu')?.classList.toggle('hidden');
    });
    document.addEventListener('click', () => {
        document.querySelector('#vault-note-more-dropdown .dropdown-menu')?.classList.add('hidden');
    });
    document.getElementById('btn-vault-note-pdf')?.addEventListener('click', () => {
        if (!S.currentNote) { showToast(t('请先选择一篇笔记')); return; }
        document.getElementById('input-vault-pdf')?.click();
    });
    document.getElementById('input-vault-pdf')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        handleAssetUpload(file);
    });
    document.getElementById('btn-note-gen-open')?.addEventListener('click', () => {
        if (!S.selectedNotes.size) { showToast(t('请先勾选笔记')); return; }
        if (_cb.openGenerateModal) _cb.openGenerateModal({ kind: 'notes', notes: [...S.selectedNotes], onDone: clearSelectedNotes });
    });
    document.getElementById('btn-note-select-clear')?.addEventListener('click', clearSelectedNotes);
    document.getElementById('btn-note-batch-delete')?.addEventListener('click', batchDeleteNotes);
    document.getElementById('btn-note-batch-tag')?.addEventListener('click', batchTagNotes);
    bindNoteListDragEvents();
    // 历史版本弹窗
    document.getElementById('btn-vault-note-history')?.addEventListener('click', openNoteHistoryModal);
    document.getElementById('btn-close-note-history')?.addEventListener('click', closeNoteHistoryModal);
    document.querySelector('#note-history-modal .modal-backdrop')?.addEventListener('click', closeNoteHistoryModal);
    document.getElementById('note-history-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.note-history-restore');
        if (btn && btn.dataset.ts) restoreNoteBackup(btn.dataset.ts);
    });
    for (const listEl of [els.vaultOutlinks, els.vaultBacklinks]) {
        listEl.addEventListener('click', (e) => { const item = e.target.closest('.vault-link-item'); if (item && item.dataset.name) selectNote(item.dataset.name); });
    }
    document.getElementById('vault-mentions')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.vault-mention-link-btn');
        if (!btn) return;
        const source = btn.closest('.vault-mention-item')?.dataset.source;
        if (source) linkMention(source);
    });
    document.getElementById('btn-vault-note-rename')?.addEventListener('click', openRenameModal);
    document.getElementById('btn-cancel-rename')?.addEventListener('click', closeRenameModal);
    document.getElementById('btn-confirm-rename')?.addEventListener('click', confirmRename);
    document.querySelector('#rename-modal .modal-backdrop')?.addEventListener('click', closeRenameModal);
    document.getElementById('rename-note-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); confirmRename(); }
        else if (e.key === 'Escape') closeRenameModal();
    });
    document.getElementById('btn-vault-tags')?.addEventListener('click', () => { S.currentTag = null; showTagsPanel(); });
    document.getElementById('btn-tags-close')?.addEventListener('click', hideTagsPanel);
    document.getElementById('tags-cloud')?.addEventListener('click', (e) => {
        const chip = e.target.closest('.tags-chip');
        if (!chip || !chip.dataset.tag) return;
        S.currentTag = chip.dataset.tag; renderTagCloud(); renderTagDetail();
    });
    document.getElementById('tags-detail')?.addEventListener('click', (e) => {
        const item = e.target.closest('.tags-item');
        if (!item) return;
        openTagItem(item.dataset.type, item.dataset.id);
    });
    els.btnVaultNoteSave.addEventListener('click', saveNote);
    els.btnVaultNoteDelete.addEventListener('click', deleteNote);
    els.btnVaultNoteGenerate.addEventListener('click', openNoteGenerateModal);
    document.getElementById('btn-vault-note-chat')?.addEventListener('click', toggleNoteChatDock);
    document.getElementById('btn-note-chat-send')?.addEventListener('click', sendNoteChatMessage);
    document.getElementById('note-chat-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sendNoteChatMessage(); });
    els.btnVaultNotePreview.addEventListener('click', () => setNotePreviewMode(!S.notePreviewMode));
    els.btnVaultOutlineToggle.addEventListener('click', () => {
        const collapsed = els.vaultNoteOutline.classList.toggle('collapsed');
        els.btnVaultOutlineToggle.textContent = collapsed ? t('展开大纲') : t('大纲');
    });
    els.vaultNoteOutlineList.addEventListener('click', (e) => {
        const item = e.target.closest('.vault-outline-item');
        if (item) jumpToOutlineItem(Number(item.dataset.index));
    });
    els.vaultNotePreview.addEventListener('click', (e) => {
        const img = e.target.closest('img');
        if (img) { e.preventDefault(); showImgResizeBar(img); return; }
        if (!e.target.closest('#note-img-resize')) hideImgResizeBar();
        const blockRef = e.target.closest('.block-ref');
        if (blockRef && blockRef.dataset.note) { e.preventDefault(); selectNote(blockRef.dataset.note); return; }
        const queryItem = e.target.closest('.query-item');
        if (queryItem && queryItem.dataset.note) { e.preventDefault(); selectNote(queryItem.dataset.note); return; }
        const link = e.target.closest('.wiki-link');
        if (!link) return;
        e.preventDefault();
        const name = link.dataset.note;
        if (!name) return;
        if (link.classList.contains('wiki-link-dead')) createNoteFromWikiLink(name);
        else selectNote(name);
    });
    els.vaultNoteContent.addEventListener('input', () => { scheduleTypingUndo(); buildOutline(); updateWikiSuggest(); markNoteDirty(); });
    els.vaultNoteFrontmatter.addEventListener('input', markNoteDirty);
    window.addEventListener('beforeunload', (e) => {
        if (!S.noteDirty) return;
        e.preventDefault();
        e.returnValue = '';
    });
    els.vaultNoteContent.addEventListener('keydown', (e) => {
        // 自定义撤销/重做（阻止浏览器原生 undo，避免与自定义栈双重生效）
        const key = e.key.toLowerCase();
        if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            const el = e.target;
            const start = el.selectionStart;
            const end = el.selectionEnd;
            if (e.shiftKey) {
                // Shift+Tab 去缩进：移除开头的空格/制表符
                const before = el.value.slice(0, start);
                const lineStart = before.lastIndexOf('\n') + 1;
                const line = el.value.slice(lineStart, start);
                const leadingSpaces = line.match(/^[ \t]+/);
                if (leadingSpaces) {
                    el.value = el.value.slice(0, lineStart) + line.slice(leadingSpaces[0].length) + el.value.slice(start);
                    el.selectionStart = el.selectionEnd = start - leadingSpaces[0].length;
                }
            } else {
                // Tab 插入缩进（2空格）
                el.value = el.value.slice(0, start) + '  ' + el.value.slice(end);
                el.selectionStart = el.selectionEnd = start + 2;
            }
            markNoteDirty();
            scheduleTypingUndo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'z') {
            e.preventDefault();
            if (e.shiftKey) noteRedo(); else noteUndo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'y') { e.preventDefault(); noteRedo(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); toggleTaskInTextarea(e.target); return; }
        if (handleWikiSuggestKeydown(e)) e.preventDefault();
    });
    els.vaultNoteContent.addEventListener('compositionstart', () => { S.imeComposing = true; commitTypingUndo(); });
    els.vaultNoteContent.addEventListener('compositionend', () => { S.imeComposing = false; commitTypingUndo(); updateWikiSuggest(); });
    els.vaultNoteContent.addEventListener('blur', () => { setTimeout(hideWikiSuggest, 150); });
    els.wikiSuggestEl.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.wiki-suggest-item');
        if (!item) return;
        e.preventDefault();
        applyWikiSuggest(Number(item.dataset.index));
    });
    document.addEventListener('click', (e) => {
        if (!S.wikiSuggest.open) return;
        if (e.target.closest('#wiki-suggest') || e.target === els.vaultNoteContent) return;
        hideWikiSuggest();
    });
}
