// scripts/sources/collect-site.mjs — site 类型采集器（知识中心/帮助中心首页场景）。
// 从入口页 BFS：抓首页 → 提取同域链接 → 按 options.depth / maxPages 逐页抓取。
// 去重、跳过下载/媒体后缀与跨域链接（net.isCrawlableLink 内做）；每抓一页发一条进度事件；
// 单页失败产出 error 条目、不中断整批。默认走 net.fetchPage（含 SSRF 守卫），
// 测试/离线经 ctx.fetchPage / ctx.allowPrivateNetwork 注入。
import { requireFiniteOption } from './registry.mjs';
import { fetchPage, extractFromHtml, extractLinks, guessTitle } from './net.mjs';

/**
 * @param {object} source
 * @param {{fetchPage?:Function,allowPrivateNetwork?:boolean,maxBytes?:number,onProgress?:Function}} [ctx]
 */
export async function* collectSite(source, ctx = {}) {
  const entry = source.target;
  const tags = source.tags || [];
  const maxPages = requireFiniteOption(source, 'maxPages');
  const maxDepth = requireFiniteOption(source, 'depth');
  const fetchFn = ctx.fetchPage || fetchPage;
  const netOpts = { allowPrivateNetwork: ctx.allowPrivateNetwork, maxBytes: ctx.maxBytes };

  let origin;
  try {
    origin = new URL(entry).href;
  } catch {
    const err = new Error(`site 源入口不是合法 URL：${entry}`);
    err.statusCode = 400;
    throw err;
  }

  const queue = [{ url: origin, depth: 0 }];
  const seen = new Set([origin]);
  let fetched = 0;
  let yielded = 0;

  while (queue.length && fetched < maxPages) {
    const { url, depth } = queue.shift();
    if (fetched >= maxPages) break;
    fetched++;
    ctx.onProgress?.(`抓取 [${fetched}/${maxPages}] ${url}`, { url, depth, index: fetched });

    let page;
    try {
      page = await fetchFn(url, netOpts);
    } catch (err) {
      yield { kind: 'error', origin: url, error: err.message, httpStatus: err.httpStatus, code: err.code };
      continue;
    }

    const html = page.html;
    const body = extractFromHtml(html);
    yielded++;
    yield {
      kind: 'text',
      origin: url,
      originKey: url,
      title: guessTitle(html, url),
      body,
      bodyTruncated: page.truncated === true, // P2-3：单页响应体截断向上传播
      tags: [...tags],
    };

    if (depth < maxDepth) {
      const links = extractLinks(html, page.finalUrl || url, origin);
      for (const link of links) {
        if (!seen.has(link)) {
          seen.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }

  // 因 maxPages 截断：队列里仍有已发现但未抓的同域链接 → 显式上报丢弃数
  if (queue.length > 0) {
    yield { kind: 'summary', collected: yielded, dropped: queue.length, total: yielded + queue.length, cap: maxPages };
  }
}
