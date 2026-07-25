// scripts/insert-image.mjs — 把媒体资产（图片/视频）插入 deck index.html 的纯函数实现
// 供 routes/projects.mjs 的 POST /api/projects/:name/insert-image 使用；
// DOM 合并模式与 routes/projects.mjs 的 insertComponent 一致（cheerio + 末页前插入 + 单 active）。
import { load as loadHtml } from 'cheerio';

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov']);

// 按扩展名判断资产是否为视频（决定生成 <video> 还是 <img>）
export function isVideoAsset(name) {
    const m = String(name || '').toLowerCase().match(/\.[a-z0-9]+$/);
    return !!m && VIDEO_EXTS.has(m[0]);
}

// 标题/alt 属性转义（src 由服务端校验后拼接，不在此处理）
function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function mediaTag(src, title) {
    const alt = escapeHtml(title);
    if (isVideoAsset(src)) {
        return `<video controls src="${src}" title="${alt}" style="width:100%;border-radius:12px;display:block;"></video>`;
    }
    return `<img src="${src}" alt="${alt}" style="width:100%;border-radius:12px;display:block;">`;
}

// 在 deck HTML 中插入媒体：
// - 默认（不传 slide）：在最后一页前新建一页图片页（.two-col + .visual-card 版式），标题取 title
// - 传 slide（1-based）：把媒体追加进该页 .slide-content
// 返回 { html, slide, mode }；结构非法时抛错（路由层转 400/500）
export function insertImageIntoDeck(html, { src, title, slide } = {}) {
    if (!src) throw new Error('缺少媒体地址');
    const $ = loadHtml(html);
    const slides = $('main.stage section.slide');
    if (slides.length === 0) throw new Error('未找到幻灯片结构');
    const safeTitle = (title || '').trim() || 'AI 配图';
    const media = mediaTag(src, safeTitle);

    if (slide !== undefined && slide !== null) {
        const idx = Number(slide);
        if (!Number.isInteger(idx) || idx < 1 || idx > slides.length) {
            throw new Error(`页码超出范围（共 ${slides.length} 页）`);
        }
        const content = $(slides[idx - 1]).find('.slide-content');
        if (!content.length) throw new Error(`第 ${idx} 页缺少 .slide-content 容器`);
        content.append(`\n<div class="visual-card" style="max-width:720px;margin:16px auto 0;padding:16px;">${media}</div>\n`);
        return { html: $.html(), slide: idx, mode: 'append' };
    }

    const section = `<section class="slide">
        <div class="slide-content">
          <div class="section-title">AI 配图</div>
          <h2>${escapeHtml(safeTitle)}</h2>
          <div class="two-col" style="align-items:center;">
            <div class="visual-card" style="flex:1 1 100%;max-width:860px;padding:16px;">${media}</div>
          </div>
        </div>
      </section>`;
    // 与 insertComponent 一致：多页时插在末页（通常为结尾页）之前
    if (slides.length > 1) {
        $(slides[slides.length - 1]).before('\n' + section + '\n');
    } else {
        $('main.stage').append('\n' + section + '\n');
    }
    $('main.stage section.slide').removeClass('active');
    $('main.stage section.slide').first().addClass('active');
    return { html: $.html(), slide: slides.length, mode: 'new-slide' };
}
