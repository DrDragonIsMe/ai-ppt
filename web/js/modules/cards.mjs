// web/js/modules/cards.mjs — 知识卡片 CRUD / AI 扩展 / 复习评级
import { S } from './state.mjs';
import { api, showToast, escapeHtml, escapeHtmlAttr, withLlmSettingsHint } from './state.mjs';
import { showConfirmModal, showInputModal } from './modals.mjs';

let _cb = {};
export function initCardsModule(callbacks) {
    _cb = callbacks; // { hideAllMainPanels, showTagsPanel, loadProjects }
}

// ============================================================
// 面板与列表
// ============================================================
export function showCardsPanel() {
    if (_cb.hideAllMainPanels) _cb.hideAllMainPanels();
    document.getElementById('cards-panel').classList.remove('hidden');
    loadCards();
}

export async function loadCards() {
    try {
        const url = S.cardDueOnly ? '/api/vault/cards/due' : '/api/vault/cards';
        const res = await fetch(url);
        S.cards = await res.json();
        renderCardsList();
    } catch (e) { console.error('Failed to load cards:', e); showToast('加载知识卡片失败'); }
}

function renderCardsList() {
    const container = document.querySelector('.cards-list-container');
    if (S.cards.length === 0) {
        container.innerHTML = `<div style="padding:40px 20px;text-align:center;opacity:0.6;">暂无知识卡片<br><button id="btn-first-card" class="btn-primary" style="margin-top:12px;">创建第一个卡片</button></div>`;
        document.getElementById('btn-first-card')?.addEventListener('click', createNewCard);
        return;
    }
    const masteryColors = ['#fee2e2', '#fef3c7', '#fde68a', '#d9f99d', '#86efac', '#22c55e'];
    let html = '';
    for (const card of S.cards) {
        const level = (card.mastery && card.mastery.level) || 0;
        html += `<div class="card-list-item ${S.currentCard?.id === card.id ? 'active' : ''}" data-id="${escapeHtml(card.id)}">
          <div class="card-list-item-title">${escapeHtml(card.title)}</div>
          <div class="card-list-item-meta">
            ${card.tags && card.tags.length ? card.tags.slice(0, 3).map(t => `<span class="card-list-item-tag" data-tag="${escapeHtmlAttr(t)}">${escapeHtml(t)}</span>`).join('') : ''}
            ${card.subject ? `<span style="opacity:0.7;">${escapeHtml(card.subject)}</span>` : ''}
            <span style="margin-left:auto;width:12px;height:12px;border-radius:50%;background:${masteryColors[level]};"></span>
          </div></div>`;
    }
    container.innerHTML = html;
    container.querySelectorAll('.card-list-item').forEach(el => {
        el.addEventListener('click', (e) => {
            const tagEl = e.target.closest('.card-list-item-tag');
            if (tagEl && tagEl.dataset.tag) {
                S.currentTag = tagEl.dataset.tag;
                if (_cb.showTagsPanel) _cb.showTagsPanel();
                return;
            }
            selectCard(el.dataset.id);
        });
    });
}

// ============================================================
// 选择 / 导航
// ============================================================
export function selectCard(id) {
    const card = S.cards.find(c => c.id === id);
    if (!card) return;
    S.currentCard = card;
    S.cardEditMode = false;
    renderCardsList();
    document.getElementById('cards-list-view').classList.add('hidden');
    document.getElementById('cards-detail-view').classList.remove('hidden');
    document.getElementById('card-title').textContent = card.title;
    document.getElementById('card-question').textContent = card.question || '';
    document.getElementById('card-answer').textContent = card.answer || '';
    document.getElementById('card-explanation').textContent = card.explanation || '';
    const masteryLevel = (card.mastery && card.mastery.level) || 0;
    const masteryLabels = ['未评级', '不记得', '有点印象', '基本掌握', '掌握得好', '完全掌握'];
    document.getElementById('card-mastery').textContent = `熟练度：${masteryLabels[masteryLevel] || '未评级'}`;
    document.getElementById('card-answer-section').classList.add('hidden');
    document.getElementById('btn-show-answer').style.display = '';
    document.getElementById('card-view-mode').classList.remove('hidden');
    document.getElementById('card-edit-mode').classList.add('hidden');
    document.getElementById('btn-card-edit').style.display = '';
    document.getElementById('btn-card-save').style.display = 'none';
    document.getElementById('btn-card-delete').style.display = 'none';
    const idx = S.cards.findIndex(c => c.id === card.id);
    document.getElementById('btn-card-prev').disabled = idx <= 0;
    document.getElementById('btn-card-next').disabled = idx === -1 || idx >= S.cards.length - 1;
    document.getElementById('ai-expand-section').classList.add('hidden');
    document.getElementById('ai-expand-result').innerHTML = '';
    document.getElementById('ai-expand-actions').classList.add('hidden');
}

function navigateCard(delta) {
    if (!S.currentCard || !S.cards.length) return;
    const idx = S.cards.findIndex(c => c.id === S.currentCard.id);
    if (idx === -1) return;
    const target = S.cards[idx + delta];
    if (target) selectCard(target.id);
}

// ============================================================
// AI 扩展
// ============================================================
let lastExpandResult = null;

async function aiExpandCard() {
    if (!S.currentCard) return;
    const expandSection = document.getElementById('ai-expand-section');
    const expandResult = document.getElementById('ai-expand-result');
    const expandActions = document.getElementById('ai-expand-actions');
    expandSection.classList.remove('hidden');
    expandResult.innerHTML = '<div style="padding:16px;text-align:center;opacity:0.6;">AI 正在思考中...</div>';
    expandActions.classList.add('hidden');
    try {
        const config = await (await fetch('/api/config')).json();
        const mc = config.modelConfig || {};
        const text = `标题：${S.currentCard.title}\n问题：${S.currentCard.question || ''}\n答案：${S.currentCard.answer || ''}\n解析：${S.currentCard.explanation || ''}`;
        const res = await fetch('/api/vault/expand', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, type: 'card', config: { baseUrl: mc.baseUrl, model: mc.model, provider: mc.provider } })
        });
        if (!res.ok) { const err = await res.json(); expandResult.innerHTML = `<div style="padding:16px;color:#ef4444;">错误：${escapeHtml(withLlmSettingsHint(err.error || '扩展失败'))}</div>`; return; }
        const data = await res.json();
        lastExpandResult = data.result;
        let parsed = null;
        try { const jsonStr = data.result.replace(/^[\s\S]*?(\[[\s\S]*\])[\s\S]*$/, '$1'); parsed = JSON.parse(jsonStr); } catch { /* not JSON */ }
        if (parsed && Array.isArray(parsed)) {
            let html = '<div style="display:flex;flex-direction:column;gap:16px;">';
            for (const item of parsed) {
                html += `<div style="padding:12px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;">
              <div style="font-weight:600;margin-bottom:8px;">${escapeHtml(item.title || '新卡片')}</div>
              <div style="font-size:14px;opacity:0.8;margin-bottom:4px;"><strong>问题：</strong>${escapeHtml(item.question || '')}</div>
              <div style="font-size:14px;opacity:0.8;margin-bottom:4px;"><strong>答案：</strong>${escapeHtml(item.answer || '')}</div>
              ${item.explanation ? `<div style="font-size:14px;opacity:0.8;"><strong>解析：</strong>${escapeHtml(item.explanation)}</div>` : ''}
              ${item.tags?.length ? `<div style="margin-top:8px;">${item.tags.map(t => `<span style="display:inline-block;padding:2px 8px;background:#e0f2fe;color:#0369a1;border-radius:9999px;font-size:12px;margin-right:4px;">${escapeHtml(t)}</span>`).join('')}</div>` : ''}</div>`;
            }
            html += '</div>';
            expandResult.innerHTML = html;
            expandActions.classList.remove('hidden');
        } else {
            expandResult.innerHTML = `<div style="padding:12px;white-space:pre-wrap;">${escapeHtml(data.result)}</div>`;
        }
    } catch (e) {
        console.error('AI expand error:', e);
        expandResult.innerHTML = `<div style="padding:16px;color:#ef4444;">错误：${escapeHtml(withLlmSettingsHint(e.message))}</div>`;
    }
}

async function createCardsFromExpand() {
    if (!lastExpandResult) return;
    try {
        const jsonStr = lastExpandResult.replace(/^[\s\S]*?(\[[\s\S]*\])[\s\S]*$/, '$1');
        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed)) { showToast('无法解析扩展结果'); return; }
        let created = 0;
        for (const item of parsed) {
            const id = item.title?.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') || `card-${Date.now()}-${created}`;
            const res = await fetch('/api/vault/cards', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, title: item.title || '新卡片', tags: item.tags || ['AI 生成'], subject: item.subject || S.currentCard?.subject || '', difficulty: item.difficulty || 1, question: item.question || '', answer: item.answer || '', explanation: item.explanation || '' })
            });
            if (res.ok) created++;
        }
        showToast(`成功创建 ${created} 个知识卡片！`);
        await loadCards();
        document.getElementById('ai-expand-section').classList.add('hidden');
    } catch (e) { console.error('Create cards error:', e); showToast('创建卡片失败'); }
}

// ============================================================
// 复习评级
// ============================================================
function showAnswer() {
    document.getElementById('card-answer-section').classList.remove('hidden');
    document.getElementById('btn-show-answer').style.display = 'none';
}

async function submitRating(rating) {
    if (!S.currentCard) return;
    try {
        const res = await fetch(`/api/vault/cards/${encodeURIComponent(S.currentCard.id)}/review`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating })
        });
        if (res.ok) {
            showToast('记录成功！');
            const currentId = S.currentCard.id;
            await loadCards();
            const updated = S.cards.find(c => c.id === currentId);
            if (updated) {
                selectCard(updated.id);
                document.getElementById('card-answer-section').classList.remove('hidden');
                document.getElementById('btn-show-answer').style.display = 'none';
            } else {
                S.currentCard = null;
                document.getElementById('cards-list-view').classList.remove('hidden');
                document.getElementById('cards-detail-view').classList.add('hidden');
            }
        }
    } catch (e) { console.error('Failed to submit rating:', e); showToast('提交失败'); }
}

// ============================================================
// 编辑 / 保存 / 删除 / 创建
// ============================================================
function editCard() {
    if (!S.currentCard) return;
    S.cardEditMode = true;
    document.getElementById('card-view-mode').classList.add('hidden');
    document.getElementById('card-edit-mode').classList.remove('hidden');
    document.getElementById('btn-card-edit').style.display = 'none';
    document.getElementById('btn-card-save').style.display = '';
    document.getElementById('btn-card-delete').style.display = '';
    document.getElementById('card-edit-title').value = S.currentCard.title || '';
    document.getElementById('card-edit-subject').value = S.currentCard.subject || '';
    document.getElementById('card-edit-tags').value = (S.currentCard.tags || []).join(', ');
    document.getElementById('card-edit-difficulty').value = S.currentCard.difficulty || '1';
    document.getElementById('card-edit-question').value = S.currentCard.question || '';
    document.getElementById('card-edit-answer').value = S.currentCard.answer || '';
    document.getElementById('card-edit-explanation').value = S.currentCard.explanation || '';
}

async function saveCard() {
    if (!S.currentCard) return;
    const data = {
        title: document.getElementById('card-edit-title').value,
        subject: document.getElementById('card-edit-subject').value,
        tags: document.getElementById('card-edit-tags').value.split(/[,\s]+/).map(t => t.trim()).filter(t => t),
        difficulty: parseInt(document.getElementById('card-edit-difficulty').value) || 1,
        question: document.getElementById('card-edit-question').value,
        answer: document.getElementById('card-edit-answer').value,
        explanation: document.getElementById('card-edit-explanation').value,
    };
    try {
        const res = await fetch(`/api/vault/cards/${encodeURIComponent(S.currentCard.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { showToast('保存成功！'); await loadCards(); const updated = S.cards.find(c => c.id === S.currentCard.id); if (updated) selectCard(updated.id); }
    } catch (e) { console.error('Failed to save card:', e); showToast('保存失败'); }
}

async function deleteCard() {
    if (!S.currentCard || !(await showConfirmModal({ title: '删除知识卡片', message: '确定要删除这个知识卡片吗？此操作不可恢复。', confirmText: '删除', danger: true }))) return;
    try {
        const res = await fetch(`/api/vault/cards/${encodeURIComponent(S.currentCard.id)}`, { method: 'DELETE' });
        if (res.ok) { S.currentCard = null; await loadCards(); document.getElementById('cards-list-view').classList.remove('hidden'); document.getElementById('cards-detail-view').classList.add('hidden'); showToast('删除成功！'); }
    } catch (e) { console.error('Failed to delete card:', e); showToast('删除失败'); }
}

async function createNewCard() {
    const input = await showInputModal({ title: '新建知识卡片', label: '卡片标题', placeholder: '输入卡片标题' });
    if (input === null) return;
    const title = input.trim();
    if (!title) { showToast('请输入卡片标题'); return; }
    try {
        const id = title.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') || `card-${Date.now()}`;
        const data = { id, title, tags: ['未分类'], difficulty: 1, question: '', answer: '', explanation: '' };
        const res = await fetch('/api/vault/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { await loadCards(); selectCard(id); editCard(); showToast('创建成功！'); }
    } catch (e) { console.error('Failed to create card:', e); showToast('创建失败'); }
}

function toggleDueOnly() {
    S.cardDueOnly = !S.cardDueOnly;
    document.getElementById('btn-cards-due').classList.toggle('active');
    loadCards();
}

// ============================================================
// 复习 PPT 生成（cards / mistakes 共用）
// ============================================================
let reviewDeckType = null;

function defaultReviewDeckName(type) {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `review-${type}-${ymd}`;
}

export function openReviewDeckModal(type) {
    reviewDeckType = type;
    const input = document.getElementById('review-deck-name');
    input.value = defaultReviewDeckName(type);
    document.getElementById('review-deck-modal').classList.remove('hidden');
    input.focus(); input.select();
}

async function confirmReviewDeck() {
    const projectName = document.getElementById('review-deck-name').value.trim();
    if (!projectName) { showToast('请输入项目标识'); return; }
    if (!reviewDeckType) return;
    try {
        await api('POST', '/api/vault/review-deck', { type: reviewDeckType, projectName });
        document.getElementById('review-deck-modal').classList.add('hidden');
        showToast('已开始生成，可在项目列表查看');
        if (_cb.loadProjects) _cb.loadProjects();
    } catch (err) { showToast('生成复习 PPT 失败：' + err.message); }
}

export function bindReviewDeckEvents() {
    document.getElementById('btn-mistakes-review-deck')?.addEventListener('click', () => {
        if (_cb.openGenerateModal) _cb.openGenerateModal({ kind: 'review', reviewType: 'mistakes' });
    });
    document.getElementById('btn-cancel-review-deck')?.addEventListener('click', () => { document.getElementById('review-deck-modal').classList.add('hidden'); });
    document.getElementById('btn-confirm-review-deck')?.addEventListener('click', confirmReviewDeck);
    document.getElementById('review-deck-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) confirmReviewDeck(); });
}

// ============================================================
// 事件绑定
// ============================================================
export function bindCardsEvents() {
    document.getElementById('btn-cards-due').addEventListener('click', toggleDueOnly);
    document.getElementById('btn-cards-refresh').addEventListener('click', loadCards);
    document.getElementById('btn-cards-new').addEventListener('click', createNewCard);
    document.getElementById('btn-show-answer').addEventListener('click', showAnswer);
    document.getElementById('btn-card-edit').addEventListener('click', editCard);
    document.getElementById('btn-card-save').addEventListener('click', saveCard);
    document.getElementById('btn-card-delete').addEventListener('click', deleteCard);
    document.getElementById('btn-ai-expand').addEventListener('click', aiExpandCard);
    document.getElementById('btn-create-cards-from-expand').addEventListener('click', createCardsFromExpand);
    document.getElementById('btn-card-prev').addEventListener('click', () => navigateCard(-1));
    document.getElementById('btn-card-next').addEventListener('click', () => navigateCard(1));
    document.getElementById('btn-cards-review-deck').addEventListener('click', () => {
        if (_cb.openGenerateModal) _cb.openGenerateModal({ kind: 'review', reviewType: 'cards' });
    });
    document.querySelectorAll('.card-rating-btn').forEach(btn => { btn.addEventListener('click', () => { submitRating(parseInt(btn.dataset.rating)); }); });
}
