// scripts/sources/collect-url.mjs — url 类型采集器：抓取单个 URL 正文。
// 默认复用 scripts/content-extractor.mjs 的 extractFromUrl（含其 SSRF 守卫/重定向/上限）；
// 当注入 ctx.fetchPage 或 ctx.allowPrivateNetwork（本地测试/离线预览）时，改走 net.fetchText。
// 抓取失败不抛断整批，而是产出 {kind:'error'} 条目，由编排器记入 manifest.errors。
import { extractFromUrl } from '../content-extractor.mjs';
import { fetchText, fetchPage, extractFromHtml, guessTitle } from './net.mjs';

function titleFromUrl(url, html) {
  if (html) {
    const t = guessTitle(html, '');
    if (t) return t;
  }
  try {
    const u = new URL(url);
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    return seg.slice(0, 200);
  } catch {
    return String(url).slice(0, 200);
  }
}

/**
 * @param {object} source
 * @param {{fetchPage?:(url:string)=>Promise<{html:string,finalUrl:string}>,allowPrivateNetwork?:boolean,maxBytes?:number,onProgress?:Function}} [ctx]
 */
export async function* collectUrl(source, ctx = {}) {
  const url = source.target;
  const tags = source.tags || [];
  const injected = typeof ctx.fetchPage === 'function' || ctx.allowPrivateNetwork;
  ctx.onProgress?.(`抓取 ${url}`);

  try {
    if (injected) {
      const fetchFn = ctx.fetchPage || fetchPage;
      const { html, finalUrl } = await fetchFn(url, { allowPrivateNetwork: ctx.allowPrivateNetwork, maxBytes: ctx.maxBytes });
      const text = extractFromHtml(html);
      yield {
        kind: 'text',
        origin: finalUrl || url,
        originKey: url, // 以配置的原始 URL 为稳定 key，重定向不改变 id
        title: titleFromUrl(finalUrl || url, html),
        body: text,
        tags: [...tags],
      };
    } else {
      const text = await extractFromUrl(url);
      yield {
        kind: 'text',
        origin: url,
        originKey: url,
        title: titleFromUrl(url, null),
        body: text,
        tags: [...tags],
      };
    }
  } catch (err) {
    yield { kind: 'error', origin: url, error: err.message };
  }
}
