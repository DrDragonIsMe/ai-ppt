// web/js/modules/i18n.mjs — 轻量 i18n：中文原文即 key，语言包只做「中文 → 目标语言」映射
// - t(key, vars?)：查当前语言包；缺 key 回退中文原文（key 本身），并按 key 去重后 console.warn 一次
// - 插值：t('已删除 {count} 项', { count: 3 })，占位符为 {name} 形式
// - 语言存 localStorage（ai-ppt-lang，zh|en）；未设置时按 navigator.language 探测，非中文默认 en
// - setLang() 持久化后 location.reload()：状态均在 localStorage / 服务端，刷新安全
// - applyStaticI18n()：批量替换静态 DOM——[data-i18n]→textContent、[data-i18n-placeholder]、
//   [data-i18n-title]、[data-i18n-aria]→aria-label；zh 模式下为恒等映射（属性值即原文）
// 约定：新增 UI 文案一律走 t() / data-i18n*，并同步维护 web/js/i18n/en.mjs
import zhPack from '../i18n/zh.mjs';
import enPack from '../i18n/en.mjs';

const LANG_KEY = 'ai-ppt-lang';
const packs = { zh: zhPack, en: enPack };

function detectLang() {
    try {
        const saved = localStorage.getItem(LANG_KEY);
        if (saved === 'zh' || saved === 'en') return saved;
    } catch { /* 隐私模式下忽略，按浏览器语言探测 */ }
    const nav = (navigator.language || '').toLowerCase();
    return nav.startsWith('zh') ? 'zh' : 'en';
}

let currentLang = detectLang();
const warnedKeys = new Set();

export function getLang() {
    return currentLang;
}

export function t(key, vars) {
    if (key == null) return '';
    const pack = packs[currentLang] || {};
    let text = pack[key];
    if (text == null) {
        // 缺 key 回退中文原文；每个 key 只警告一次，避免刷屏
        if (currentLang !== 'zh' && !warnedKeys.has(key)) {
            warnedKeys.add(key);
            console.warn(`[i18n] missing ${currentLang} translation:`, key);
        }
        text = key;
    }
    if (vars) {
        text = String(text).replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m));
    }
    return text;
}

export function setLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return;
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* 隐私模式下仍可当次生效 */ }
    if (lang === currentLang) return;
    location.reload();
}

// 批量替换静态文案；zh 模式下 t() 恒等，属性值必须与原中文文本逐字一致
export function applyStaticI18n(root = document) {
    document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
        el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
}
