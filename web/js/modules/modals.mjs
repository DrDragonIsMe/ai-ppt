// web/js/modules/modals.mjs — 通用输入/确认弹窗（Promise 风格，替代原生 prompt/confirm）
// 复用 index.html 中的 #input-modal / #confirm-modal，Esc 与点遮罩关闭行为与现有 modal 一致
import { t } from './i18n.mjs';

// ============================================================
// 输入弹窗：showInputModal({ title, label, placeholder, defaultValue, confirmText })
// resolve: 确认 → 输入字符串（未 trim）；取消/Esc/遮罩 → null
// ============================================================
let inputModalResolve = null;

function getInputModalEls() {
    return {
        modal: document.getElementById('input-modal'),
        title: document.getElementById('input-modal-title'),
        label: document.getElementById('input-modal-label'),
        input: document.getElementById('input-modal-input'),
        btnConfirm: document.getElementById('btn-confirm-input-modal'),
        btnCancel: document.getElementById('btn-cancel-input-modal')
    };
}

export function showInputModal(opts = {}) {
    const e = getInputModalEls();
    e.title.textContent = opts.title || t('输入');
    e.label.textContent = opts.label || '';
    e.label.style.display = opts.label ? '' : 'none';
    e.input.placeholder = opts.placeholder || '';
    e.input.value = opts.defaultValue || '';
    e.btnConfirm.textContent = opts.confirmText || t('确定');
    return new Promise((resolve) => {
        inputModalResolve = resolve;
        e.modal.classList.remove('hidden');
        e.input.focus();
        e.input.select();
    });
}

function closeInputModal(value) {
    const e = getInputModalEls();
    e.modal.classList.add('hidden');
    const resolve = inputModalResolve;
    inputModalResolve = null;
    if (resolve) resolve(value);
}

// ============================================================
// 确认弹窗：showConfirmModal({ title, message, confirmText, danger })
// resolve: 确认 → true；取消/Esc/遮罩 → false
// ============================================================
let confirmModalResolve = null;

function getConfirmModalEls() {
    return {
        modal: document.getElementById('confirm-modal'),
        title: document.getElementById('confirm-modal-title'),
        message: document.getElementById('confirm-modal-message'),
        btnConfirm: document.getElementById('btn-confirm-confirm-modal'),
        btnCancel: document.getElementById('btn-cancel-confirm-modal')
    };
}

export function showConfirmModal(opts = {}) {
    const e = getConfirmModalEls();
    e.title.textContent = opts.title || t('确认操作');
    e.message.textContent = opts.message || '';
    e.btnConfirm.textContent = opts.confirmText || t('确定');
    e.btnConfirm.classList.toggle('btn-danger', !!opts.danger);
    return new Promise((resolve) => {
        confirmModalResolve = resolve;
        e.modal.classList.remove('hidden');
        e.btnConfirm.focus();
    });
}

function closeConfirmModal(result) {
    const e = getConfirmModalEls();
    e.modal.classList.add('hidden');
    const resolve = confirmModalResolve;
    confirmModalResolve = null;
    if (resolve) resolve(result);
}

// ============================================================
// 事件绑定（app.mjs 启动时调用一次）
// ============================================================
export function bindModalEvents() {
    const im = getInputModalEls();
    im.btnConfirm.addEventListener('click', () => closeInputModal(im.input.value));
    im.btnCancel.addEventListener('click', () => closeInputModal(null));
    im.modal.querySelector('.modal-backdrop').addEventListener('click', () => closeInputModal(null));
    im.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeInputModal(im.input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeInputModal(null); }
    });

    const cm = getConfirmModalEls();
    cm.btnConfirm.addEventListener('click', () => closeConfirmModal(true));
    cm.btnCancel.addEventListener('click', () => closeConfirmModal(false));
    cm.modal.querySelector('.modal-backdrop').addEventListener('click', () => closeConfirmModal(false));
    cm.modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeConfirmModal(false); }
    });
}
