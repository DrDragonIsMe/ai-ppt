// scripts/sources/net.mjs — 采集器共享的网络层：带大小上限/超时/重定向复核的抓取，
// 默认拒绝私有/回环地址（SSRF 守卫）；allowPrivateNetwork 仅用于本地测试与离线预览，
// 生产路径（路由/CLI）不传该标志。HTML→正文复用 content-extractor.extractFromHtml。
import dns from 'node:dns/promises';
import { load } from 'cheerio';
import { extractFromHtml } from '../content-extractor.mjs';

export const DEFAULT_MAX_BYTES = 1024 * 1024; // 单页响应体上限 1MB
export const DEFAULT_TIMEOUT_MS = 12000;
export const MAX_REDIRECTS = 5;

// 与 content-extractor 同口径的私有/回环地址判定
function isPrivateAddress(ip, family = 4) {
  const v = String(ip).toLowerCase();
  if (family === 6 || v.includes(':')) {
    return v === '::1' || v === '::'
      || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
  }
  return /^127\./.test(v) || /^10\./.test(v) || /^192\.168\./.test(v)
    || /^169\.254\./.test(v) || /^0\./.test(v)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(v)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v);
}

async function isPublicHost(hostname) {
  if (hostname === 'localhost') return false;
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    return false;
  }
  if (!addrs.length) return false;
  return addrs.every((a) => !isPrivateAddress(a.address, a.family));
}

// 在字节边界安全截断 UTF-8（丢弃可能被切断的多字节序列尾部），避免替换字符。
function trimUtf8(buf, maxBytes) {
  if (buf.length <= maxBytes) return { text: buf.toString('utf8'), truncated: false };
  let end = maxBytes;
  // 回退到不落在多字节序列中间的位置：buf[end] 若是续字节(10xxxxxx)则继续前移
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * 读取响应体，受字节上限与绝对截止时间双重约束（P2-1：body 读取也有 deadline，不再只保护 header）。
 * 超限不再整页丢弃，而是**截断**并返回 truncated 标记（P2-3，供上层在 manifest/事件里显式可见）。
 * @returns {Promise<{text:string,truncated:boolean}>}
 */
async function readCapped(res, maxBytes, { deadlineAt = Infinity, timeoutMs = null } = {}) {
  const overDeadline = () => Number.isFinite(deadlineAt) && Date.now() > deadlineAt;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (overDeadline()) throw new Error(`Fetch timed out after ${timeoutMs}ms during body read`);
    const buf = Buffer.from(text, 'utf8');
    return trimUtf8(buf, maxBytes);
  }
  let received = 0;
  const chunks = [];
  for (;;) {
    if (overDeadline()) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`Fetch timed out after ${timeoutMs}ms during body read`);
    }
    const { done, value } = await reader.read(); // res.body 绑定 fetch 的 AbortSignal：超时 abort 会在此 reject
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      // 保留已到的这一片（可能略超），随后统一截断到 maxBytes；停止继续下载。
      chunks.push(value);
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    chunks.push(value);
  }
  return trimUtf8(Buffer.concat(chunks), maxBytes);
}

/**
 * 抓取一个 URL 的原始响应体（默认当作 HTML）。
 * @returns {Promise<{html:string, finalUrl:string, status:number, contentType:string}>}
 */
export async function fetchPage(url, opts = {}) {
  const {
    allowPrivateNetwork = false,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    redirectsLeft = MAX_REDIRECTS,
    deadlineAt = null,
  } = opts;

  // 绝对截止时间：覆盖 header + body + 整条重定向链（P2-1，body 读取不再是无截止期的空白区）。
  const deadline = deadlineAt ?? (Date.now() + timeoutMs);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Fetch timed out after ${timeoutMs}ms: ${url}`);

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  if (!allowPrivateNetwork) {
    const ok = await isPublicHost(parsed.hostname);
    if (!ok) throw new Error(`Refused to fetch internal/private host: ${parsed.hostname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  let res;
  try {
    res = await fetchImpl(parsed.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ai-ppt-bot/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Fetch timed out after ${timeoutMs}ms: ${url}`);
    throw new Error(`Fetch failed: ${err.message}`);
  }

  try {
    if (res.status >= 300 && res.status < 400) {
      if (redirectsLeft <= 0) throw new Error('Too many redirects');
      const location = res.headers.get('location');
      if (!location) throw new Error('Redirect without Location header');
      const next = new URL(location, parsed.href).href;
      return fetchPage(next, { allowPrivateNetwork, maxBytes, timeoutMs, fetchImpl, redirectsLeft: redirectsLeft - 1, deadlineAt: deadline });
    }
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

    const { text: html, truncated } = await readCapped(res, maxBytes, { deadlineAt: deadline, timeoutMs });
    return { html, truncated, finalUrl: parsed.href, status: res.status, contentType: res.headers.get('content-type') || '' };
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Fetch timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 抓 HTML 并抽正文文本。 */
export async function fetchText(url, opts = {}) {
  const { html } = await fetchPage(url, opts);
  return extractFromHtml(html);
}

// 媒体/下载类后缀：站点抓取跳过（既拉不到正文，也不是“页面”）
const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|m4v|avi|mkv|mp3|wav|m4a|ogg|flac|zip|rar|7z|tar|gz|tgz|bz2|pdf|docx?|xlsx?|pptx?|exe|dmg|iso|apk)(\?|#|$)/i;

/** 是否值得作为“子页面”继续抓（同域、http(s)、非锚点-only、非媒体/下载）。 */
export function isCrawlableLink(href, baseHref, originUrl) {
  if (!href) return null;
  let u;
  try {
    u = new URL(href, baseHref);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let base;
  try {
    base = new URL(originUrl);
  } catch {
    return null;
  }
  if (u.host !== base.host) return null; // 只走同域
  if (u.hash) u.hash = ''; // 去锚点
  const clean = u.href;
  if (MEDIA_EXT_RE.test(u.pathname)) return null;
  return clean;
}

/** 从 HTML 中抽取同域可继续抓取的链接（绝对、去重、保序）。 */
export function extractLinks(html, pageUrl, originUrl) {
  const $ = load(html);
  const found = [];
  const seen = new Set();
  $('a[href]').each((_i, el) => {
    const raw = $(el).attr('href');
    const link = isCrawlableLink(raw, pageUrl, originUrl);
    if (link && !seen.has(link)) {
      seen.add(link);
      found.push(link);
    }
  });
  return found;
}

/** 从页面 HTML 猜测标题（<title> 或首个 h1），供条目 title 使用。 */
export function guessTitle(html, fallback) {
  const $ = load(html);
  const t = ($('title').first().text() || '').trim();
  if (t) return t.slice(0, 200);
  const h1 = ($('h1').first().text() || '').trim();
  if (h1) return h1.slice(0, 200);
  return String(fallback || '').slice(0, 200);
}

export { extractFromHtml };
