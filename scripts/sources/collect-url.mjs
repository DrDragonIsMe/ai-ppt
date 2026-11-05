// scripts/sources/collect-url.mjs — url 类型采集器：抓取单个 URL 正文。
// 生产与测试统一走 net.fetchPage：它带 maxBytes 截断、绝对 deadline（header+body+重定向链）、
// 且 SSRF 守卫默认开启（allowPrivateNetwork 未设即拒绝私有/回环），与旧 content-extractor 同口径但不再
// 1MB 硬失败、不再 body 无截止期（P2-D：上一轮 P2-1/P2-3 的修复此前只覆盖注入分支，url 生产路径全走
// content-extractor 的 :47 默认分支而未生效）。content-extractor 仅留作 net 不可用时的兜底，生产不触发。
import { extractFromUrl } from '../content-extractor.mjs';
import { fetchPage, extractFromHtml, guessTitle } from './net.mjs';

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
 * @param {{fetchPage?:(url:string)=>Promise<{html:string,finalUrl:string}>,allowPrivateNetwork?:boolean,maxBytes?:number,timeoutMs?:number,onProgress?:Function}} [ctx]
 */
export async function* collectUrl(source, ctx = {}) {
  const url = source.target;
  const tags = source.tags || [];
  ctx.onProgress?.(`抓取 ${url}`);

  try {
    // 统一走 net.fetchPage（生产分支也带上 maxBytes/deadline/SSRF 守卫）；ctx.fetchPage 仅测试注入替身。
    const fetchFn = ctx.fetchPage || fetchPage;
    const netOpts = {
      allowPrivateNetwork: ctx.allowPrivateNetwork,
      maxBytes: ctx.maxBytes,
      ...(ctx.timeoutMs != null ? { timeoutMs: ctx.timeoutMs } : {}),
    };
    const { html, finalUrl, truncated } = await fetchFn(url, netOpts);
    const text = extractFromHtml(html);
    yield {
      kind: 'text',
      origin: finalUrl || url,
      originKey: url, // 以配置的原始 URL 为稳定 key，重定向不改变 id
      title: titleFromUrl(finalUrl || url, html),
      body: text,
      bodyTruncated: truncated === true, // P2-3：响应体被 maxBytes 截断 → 向上传播，供 manifest/事件可见
      tags: [...tags],
    };
  } catch (err) {
    yield { kind: 'error', origin: url, error: err.message };
  }
}

// 兜底：若将来需要在无法使用 net 的环境复用旧抽取器，可显式调用；生产 collectUrl 不再走这里（P2-D）。
export async function* collectUrlViaExtractor(source, ctx = {}) {
  const url = source.target;
  const tags = source.tags || [];
  ctx.onProgress?.(`抓取(兜底) ${url}`);
  try {
    const text = await extractFromUrl(url);
    yield { kind: 'text', origin: url, originKey: url, title: titleFromUrl(url, null), body: text, tags: [...tags] };
  } catch (err) {
    yield { kind: 'error', origin: url, error: err.message };
  }
}
