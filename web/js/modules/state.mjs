// web/js/modules/state.mjs — 共享状态、常量与工具函数
// 所有模块通过 import { S } from './state.mjs' 访问共享可变状态

// ============================================================
// 共享可变状态（所有模块通过 S.xxx 访问/修改）
// ============================================================
export const S = {
    currentProject: null,
    projects: [],
    currentConfig: null,

    // 知识库
    currentNote: null,
    notes: [],
    currentSidebarTab: 'vault',
    selectedNotes: new Set(),
    vaultAssets: null,

    // 笔记编辑器
    notePreviewMode: false,
    noteDirty: false,
    outlineItems: [],
    wikiSuggest: { open: false, startPos: 0, items: [], activeIndex: 0 },
    imeComposing: false,

    // 侧边栏搜索
    vaultSearchTimer: null,
    vaultSearchQuery: '',

    // 标签浏览
    vaultTags: null,
    currentTag: null,

    // 快速跳转
    quickOpen: { items: [], activeIndex: 0 },

    // 碎片
    fragments: [],
    fragmentFilter: 'all',

    // 星图
    currentGraph: null,
    graphNodes: [],
    graphEdges: [],
    graphAllNodes: [],
    graphAllEdges: [],
    graphHighFreqOnly: false,
    selectedNode: null,
    selectedGraphNodes: new Set(),
    graphZoom: 1,
    graphPan: { x: 0, y: 0 },
    isDragging: false,
    isNodeDragging: false,
    dragStart: { x: 0, y: 0 },
    dragNode: null,

    // 知识卡片
    cards: [],
    currentCard: null,
    cardEditMode: false,
    cardDueOnly: false,
    trainingSession: null,

    // 测验/错题
    exams: [],
    currentExam: null,
    mistakes: [],
    currentMistake: null,
    // 学习面板当前子 tab（exams | mistakes | training）
    studySubtab: 'exams',

    // 模型/配置
    models: [],
    globalConfig: null,

    // 主题
    themes: [
        { id: 'web-ui', name: 'Web UI', desc: '专业克制的默认主题', color: '#439288' },
        { id: 'business-blue', name: '商务蓝', desc: '稳重专业的商务风', color: '#2563EB' },
        { id: 'elegant-purple', name: '优雅紫', desc: '高端创意的艺术风', color: '#7C3AED' },
        { id: 'warm-orange', name: '温暖橙', desc: '活力亲切的生活风', color: '#EA580C' },
        { id: 'sunset-red', name: '日落红', desc: '热情有冲击力', color: '#E11D48' },
        { id: 'tech-green', name: '科技绿', desc: '环保可持续', color: '#65A30D' },
        { id: 'minimal-gray', name: '极简灰', desc: '克制高级', color: '#171717' },
        { id: 'dark-mode', name: '暗黑模式', desc: '沉浸护眼', color: '#22D3EE' }
    ],

    // 选材数据缓存
    vaultSourceData: null,

    // DOM 元素缓存（init 时填充）
    els: {},
};

// ============================================================
// 常量
// ============================================================
export const animations = [
    { id: 'none', name: '无动画', desc: '元素直接显示', icon: '➡️' },
    { id: 'fade', name: '渐入', desc: '柔和优雅的淡入', icon: '✨' },
    { id: 'slide', name: '滑入', desc: '从下方滑入的层次感', icon: '⬆️' },
    { id: 'bounce', name: '弹性弹出', desc: '活泼有活力的弹出', icon: '🚀' },
    { id: 'zoom', name: '缩放', desc: '放大淡入', icon: '🔍' },
    { id: 'blur', name: '模糊淡入', desc: '从模糊到清晰', icon: '💨' },
    { id: 'flip', name: '翻转', desc: '3D 翻转切换', icon: '🔄' }
];

export const THEME_VAR_DEFAULTS = {
    '--teal': '#439288',
    '--ink': '#151A19',
    '--cream': '#FAFAF7'
};

export const steps = [
    { key: 'start', label: '启动' },
    { key: 'extract', label: '提取内容' },
    { key: 'prompt', label: '构建提示' },
    { key: 'llm', label: 'LLM 生成' },
    { key: 'fallback', label: '模板兜底' },
    { key: 'build', label: '写入文件' },
    { key: 'ready', label: '完成' }
];

export const ERROR_DIAGNOSES = [
    { pattern: /\b401\b|Unauthorized|invalid.*api.*key|apikey.*invalid/i, hint: 'API Key 无效或过期，请到「设置」面板检查' },
    { pattern: /\b403\b|Forbidden/i, hint: '访问被拒绝，请检查 API Key 权限或套餐状态' },
    { pattern: /\b429\b|rate.*limit|too.*many.*request/i, hint: '请求频率超限，请稍后重试或升级套餐' },
    { pattern: /\b500\b|\b502\b|\b503\b|\b504\b/i, hint: '服务端内部错误，请稍后重试' },
    { pattern: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch.*failed|network.*error|socket.*hang.*up/i, hint: '无法连接 API 服务，请检查网络或 Base URL 配置' },
    { pattern: /timeout|aborted/i, hint: '请求超时，可能是网络不稳定或模型响应过慢，请重试' },
    { pattern: /未配置.{0,6}LLM|无可用模型|缺少.*apiKey/i, hint: '请到「设置」面板配置文本模型与 API Key' },
];

// ============================================================
// 工具函数
// ============================================================
export async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = new Error(data.error || `${method} ${path} failed`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return res.status === 204 ? null : res.json();
}

// 文件上传（FormData → multipart；不手动设 Content-Type，boundary 由浏览器生成）
export async function apiUpload(path, formData) {
    const res = await fetch(path, { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `POST ${path} failed`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

export function showToast(message, type) {
    const toast = S.els.toast;
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('error', type === 'error');
    toast.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

export function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function withLlmSettingsHint(message) {
    const text = String(message || '未知错误');
    if (text.includes('\uD83D\uDCA1')) return text;
    for (const { pattern, hint } of ERROR_DIAGNOSES) {
        if (pattern.test(text)) return `${text}\n💡 ${hint}`;
    }
    return text;
}

export function statusLabel(status) {
    const map = { draft: '草稿', generating: '生成中', ready: '就绪', error: '错误' };
    return map[status] || status;
}

export function escapeHtmlAttr(str) {
    return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// 初始化：加载主题 + 缓存 DOM 元素
// ============================================================
export async function loadThemes() {
    try {
        const res = await fetch('/api/themes');
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) S.themes = data;
        }
    } catch { /* keep fallback */ }
}

/** 填充 DOM 元素缓存；调用方传入 {id -> element} 映射 */
export function initEls(elementMap) {
    Object.assign(S.els, elementMap);
}
