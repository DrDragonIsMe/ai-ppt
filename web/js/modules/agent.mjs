import { S } from './state.mjs';
import { api, apiUpload, showToast, escapeHtml, escapeHtmlAttr } from './state.mjs';
import { t } from './i18n.mjs';

let _cb = {};
let agentHistory = [];
let knowledgeDocuments = [];

const HISTORY_KEY = 'ai-ppt-agent-history-v1';

function getAgentEls() {
    return {
        panel: document.getElementById('agent-panel'),
        sidebar: document.getElementById('agent-sidebar-content'),
        docsSearch: document.getElementById('agent-doc-search'),
        docsList: document.getElementById('agent-doc-list'),
        messages: document.getElementById('agent-chat-messages'),
        input: document.getElementById('agent-chat-input'),
        send: document.getElementById('btn-agent-send'),
        upload: document.getElementById('btn-agent-upload'),
        uploadInput: document.getElementById('agent-file-input'),
        refresh: document.getElementById('btn-agent-refresh'),
        empty: document.getElementById('agent-doc-empty'),
        title: document.getElementById('agent-panel-title'),
        subtitle: document.getElementById('agent-panel-subtitle'),
    };
}

function assistantName() {
    return String(S.globalConfig?.agentConfig?.assistantName || '薪小灵').trim() || '薪小灵';
}

function restoreHistory() {
    try {
        const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        agentHistory = Array.isArray(data) ? data : [];
    } catch {
        agentHistory = [];
    }
    if (!agentHistory.length) {
        agentHistory = [{
            id: `msg-${Date.now()}`,
            role: 'assistant',
            text: `你好，我是${assistantName()}。你可以直接问我知识库内容，也可以对我说：创建专题、给笔记打标签、把品牌名改成某个名字。`,
        }];
    }
}

function persistHistory() {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(agentHistory.slice(-60)));
    } catch { /* ignore */ }
}

function pushHistory(entry) {
    agentHistory.push({ id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...entry });
    persistHistory();
    renderAgentHistory();
}

function renderDocuments() {
    const e = getAgentEls();
    if (!e.docsList) return;
    const query = String(e.docsSearch?.value || '').trim().toLowerCase();
    const docs = knowledgeDocuments.filter((doc) => {
        if (!query) return true;
        return `${doc.title || ''}\n${doc.summary || ''}`.toLowerCase().includes(query);
    });
    e.docsList.innerHTML = docs.map((doc) => `
        <div class="agent-doc-item" data-kind="${escapeHtmlAttr(doc.kind)}" data-id="${escapeHtmlAttr(doc.openTarget?.id || '')}" data-download-url="${escapeHtmlAttr(doc.downloadUrl || '')}">
          <div class="agent-doc-head">
            <span class="agent-doc-kind ${escapeHtmlAttr(doc.kind)}">${escapeHtml(doc.kind)}</span>
            <span class="agent-doc-time">${escapeHtml(doc.mtime ? new Date(doc.mtime).toLocaleDateString() : '')}</span>
          </div>
          <div class="agent-doc-title">${escapeHtml(doc.title || '')}</div>
          <div class="agent-doc-summary">${escapeHtml(doc.summary || '')}</div>
          <div class="agent-doc-actions">
            <button class="btn-secondary agent-doc-open">${t('打开')}</button>
            ${doc.downloadUrl ? `<button class="btn-secondary agent-doc-download">${t('下载')}</button>` : ''}
          </div>
        </div>
    `).join('');
    e.empty?.classList.toggle('hidden', docs.length > 0);
}

function renderCitations(citations = []) {
    if (!citations.length) return '';
    return `<div class="agent-citations">${citations.map((item) => `
        <button class="agent-citation" data-open-kind="${escapeHtmlAttr(item.openTarget?.kind || item.kind || '')}" data-open-id="${escapeHtmlAttr(item.openTarget?.id || '')}" data-download-url="${escapeHtmlAttr(item.downloadUrl || '')}">
          <div class="agent-citation-label">${escapeHtml(item.sourceLabel || t('知识库引用'))}</div>
          <div class="agent-citation-title">${escapeHtml(item.title || '')}</div>
          <div class="agent-citation-snippet">${escapeHtml(item.snippet || item.summary || '')}</div>
        </button>
    `).join('')}</div>`;
}

function renderDocumentsBlock(documents = []) {
    if (!documents.length) return '';
    return `<div class="agent-inline-docs">${documents.map((doc) => `
        <div class="agent-inline-doc" data-kind="${escapeHtmlAttr(doc.openTarget?.kind || doc.kind || '')}" data-id="${escapeHtmlAttr(doc.openTarget?.id || '')}" data-download-url="${escapeHtmlAttr(doc.downloadUrl || '')}">
          <div class="agent-inline-doc-title">${escapeHtml(doc.title || '')}</div>
          <div class="agent-inline-doc-summary">${escapeHtml(doc.summary || '')}</div>
          <div class="agent-inline-doc-actions">
            <button class="btn-secondary agent-inline-open">${t('打开')}</button>
            ${doc.downloadUrl ? `<button class="btn-secondary agent-inline-download">${t('下载')}</button>` : ''}
          </div>
        </div>
    `).join('')}</div>`;
}

function renderPendingAction(entry) {
    if (!entry.pendingAction || entry.actionState === 'dismissed') return '';
    return `
        <div class="agent-pending-card">
          <div class="agent-pending-title">${t('待确认操作')}</div>
          <div class="agent-pending-summary">${escapeHtml(entry.pendingAction.summary || '')}</div>
          <div class="agent-pending-actions">
            <button class="btn-primary agent-confirm-action" data-message-id="${escapeHtmlAttr(entry.id)}">${t('确认执行')}</button>
            <button class="btn-secondary agent-dismiss-action" data-message-id="${escapeHtmlAttr(entry.id)}">${t('取消')}</button>
          </div>
        </div>
    `;
}

function renderOperation(operation) {
    if (!operation) return '';
    return `<div class="agent-operation-card">
        <div class="agent-operation-title">${escapeHtml(operation.title || t('执行结果'))}</div>
        <div class="agent-operation-summary">${escapeHtml(operation.summary || '')}</div>
    </div>`;
}

function renderAgentHistory() {
    const e = getAgentEls();
    if (!e.messages) return;
    e.title && (e.title.textContent = assistantName());
    e.subtitle && (e.subtitle.textContent = t('支持知识检索、知识库管理和系统设置指令'));
    e.messages.innerHTML = agentHistory.map((entry) => `
        <div class="agent-message ${escapeHtmlAttr(entry.role)}" data-message-id="${escapeHtmlAttr(entry.id)}">
          <div class="agent-message-head">${escapeHtml(entry.role === 'user' ? t('我') : assistantName())}</div>
          <div class="agent-message-body">${escapeHtml(entry.text || '')}</div>
          ${renderOperation(entry.operation)}
          ${renderCitations(entry.citations)}
          ${renderDocumentsBlock(entry.documents)}
          ${renderPendingAction(entry)}
        </div>
    `).join('');
    e.messages.scrollTop = e.messages.scrollHeight;
}

async function handleKnowledgeOpen(kind, id) {
    if (!kind || !id) return;
    if (kind === 'note') {
        _cb.switchSidebarTab?.('vault');
        setTimeout(() => _cb.selectNote?.(id), 40);
        return;
    }
    if (kind === 'fragment') {
        _cb.switchSidebarTab?.('fragments');
        setTimeout(() => _cb.revealFragment?.(id), 40);
        return;
    }
    if (kind === 'card') {
        _cb.switchSidebarTab?.('cards');
        setTimeout(() => {
            _cb.loadCards?.();
            _cb.selectCard?.(id);
        }, 40);
        return;
    }
    if (kind === 'mistake') {
        _cb.switchSidebarTab?.('study', 'mistakes');
        setTimeout(() => {
            _cb.loadMistakes?.();
            _cb.selectMistake?.(id);
        }, 40);
        return;
    }
    if (kind === 'asset') {
        window.open(`/api/vault/assets/${encodeURIComponent(id)}`, '_blank', 'noopener');
    }
}

function triggerDownload(url) {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function loadKnowledgeDocuments() {
    try {
        const data = await api('GET', '/api/knowledge/documents');
        knowledgeDocuments = data.documents || [];
        renderDocuments();
    } catch (err) {
        console.error(err);
        showToast(t('加载知识库资料失败：{msg}', { msg: err.message }), 'error');
    }
}

export async function loadAgentWorkspace() {
    restoreHistory();
    renderAgentHistory();
    await loadKnowledgeDocuments();
}

async function sendAgentMessage() {
    const e = getAgentEls();
    const message = String(e.input?.value || '').trim();
    if (!message) return;
    e.input.value = '';
    pushHistory({ role: 'user', text: message });
    e.send.disabled = true;
    try {
        const data = await api('POST', '/api/agent/chat', { message });
        pushHistory({
            role: 'assistant',
            text: data.reply || t('我处理好了。'),
            citations: data.citations || [],
            documents: data.documents || [],
            pendingAction: data.pendingAction || null,
        });
    } catch (err) {
        pushHistory({ role: 'assistant', text: t('处理失败：{msg}', { msg: err.message }) });
    } finally {
        e.send.disabled = false;
    }
}

async function confirmAgentAction(messageId) {
    const entry = agentHistory.find((item) => item.id === messageId);
    if (!entry?.pendingAction) return;
    try {
        const data = await api('POST', '/api/agent/execute', { action: entry.pendingAction });
        entry.actionState = 'confirmed';
        persistHistory();
        renderAgentHistory();
        pushHistory({
            role: 'assistant',
            text: data.reply || t('已执行完成。'),
            operation: data.operation || null,
        });
        if (data.refreshConfig) {
            await _cb.loadGlobalConfig?.();
            renderAgentHistory();
        }
        if (data.refreshKnowledge) {
            await _cb.loadNotes?.();
            await loadKnowledgeDocuments();
        }
    } catch (err) {
        pushHistory({ role: 'assistant', text: t('执行失败：{msg}', { msg: err.message }) });
    }
}

function dismissAgentAction(messageId) {
    const entry = agentHistory.find((item) => item.id === messageId);
    if (!entry) return;
    entry.actionState = 'dismissed';
    persistHistory();
    renderAgentHistory();
}

async function uploadKnowledgeFiles(files) {
    const validFiles = [...(files || [])].filter(Boolean);
    if (!validFiles.length) return;
    for (const file of validFiles) {
        try {
            const fd = new FormData();
            fd.append('name', file.name);
            fd.append('file', file, file.name);
            await apiUpload('/api/vault/assets', fd);
            pushHistory({ role: 'assistant', text: t('资料已上传：{name}', { name: file.name }) });
        } catch (err) {
            showToast(t('上传失败：{msg}', { msg: err.message }), 'error');
        }
    }
    await loadKnowledgeDocuments();
}

export function initAgentModule(callbacks) {
    _cb = callbacks;
}

export function bindAgentEvents() {
    const e = getAgentEls();
    e.send?.addEventListener('click', sendAgentMessage);
    e.input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            sendAgentMessage();
        }
    });
    e.refresh?.addEventListener('click', loadKnowledgeDocuments);
    e.upload?.addEventListener('click', () => e.uploadInput?.click());
    e.uploadInput?.addEventListener('change', async (event) => {
        await uploadKnowledgeFiles(event.target.files);
        event.target.value = '';
    });
    e.docsSearch?.addEventListener('input', renderDocuments);
    e.docsList?.addEventListener('click', (event) => {
        const item = event.target.closest('.agent-doc-item');
        if (!item) return;
        if (event.target.closest('.agent-doc-download')) {
            triggerDownload(item.dataset.downloadUrl);
            return;
        }
        handleKnowledgeOpen(item.dataset.kind, item.dataset.id);
    });
    e.messages?.addEventListener('click', (event) => {
        const citation = event.target.closest('.agent-citation');
        if (citation) {
            if (event.target.closest('.agent-citation')) {
                if (citation.dataset.downloadUrl && event.metaKey) triggerDownload(citation.dataset.downloadUrl);
                else handleKnowledgeOpen(citation.dataset.openKind, citation.dataset.openId);
                return;
            }
        }
        const doc = event.target.closest('.agent-inline-doc');
        if (doc) {
            if (event.target.closest('.agent-inline-download')) {
                triggerDownload(doc.dataset.downloadUrl);
                return;
            }
            handleKnowledgeOpen(doc.dataset.kind, doc.dataset.id);
            return;
        }
        const confirmBtn = event.target.closest('.agent-confirm-action');
        if (confirmBtn) {
            confirmAgentAction(confirmBtn.dataset.messageId);
            return;
        }
        const dismissBtn = event.target.closest('.agent-dismiss-action');
        if (dismissBtn) dismissAgentAction(dismissBtn.dataset.messageId);
    });
}
