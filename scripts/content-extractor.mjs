#!/usr/bin/env node
import { load } from 'cheerio';
import dns from 'node:dns/promises';

const MAX_LENGTH = 12000;
const MAX_BYTES = 1024 * 1024; // 1MB response cap
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;

// True for loopback / private / link-local / cloud-metadata addresses.
function isPrivateAddress(ip, family = 4) {
  const v = String(ip).toLowerCase();
  if (family === 6 || v.includes(':')) {
    return v === '::1'
      || v === '::'
      || v.startsWith('fc')
      || v.startsWith('fd')
      || v.startsWith('fe80')
      || v.startsWith('::ffff:'); // v4-mapped
  }
  return (
    /^127\./.test(v)
    || /^10\./.test(v)
    || /^192\.168\./.test(v)
    || /^169\.254\./.test(v) // link-local + cloud metadata (169.254.169.254)
    || /^0\./.test(v)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(v)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v) // CGNAT 100.64/10
  );
}

// Resolve hostname and ensure every resolved IP is public.
async function isPublicHost(hostname) {
  if (hostname === 'localhost') return false;
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    return false;
  }
  if (addrs.length === 0) return false;
  return addrs.every((a) => !isPrivateAddress(a.address, a.family));
}

export async function extractFromUrl(url) {
  return fetchWithSsrfGuard(url, MAX_REDIRECTS);
}

async function fetchWithSsrfGuard(url, redirectsLeft) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  // Reject if hostname is/resolve to a private or loopback address.
  // Note: defends against direct-IP and most rebinding; a fast DNS-rebinding
  // attacker could still race, but this is a local tool and the guard is a
  // large improvement over the prior no-check fetch.
  const ok = await isPublicHost(parsed.hostname);
  if (!ok) throw new Error(`Refused to fetch internal/private host: ${parsed.hostname}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(parsed.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ai-ppt-bot/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    throw new Error(`Fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // Manually follow redirects, re-validating each target.
  if (res.status >= 300 && res.status < 400) {
    if (redirectsLeft <= 0) throw new Error('Too many redirects');
    const location = res.headers.get('location');
    if (!location) throw new Error('Redirect without Location header');
    const next = new URL(location, parsed.href).href;
    return fetchWithSsrfGuard(next, redirectsLeft - 1);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  const html = await readCapped(res, MAX_BYTES);
  return extractFromHtml(html);
}

async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) {
    // Fallback for non-streamable bodies; still cap via text then slice.
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
    return text;
  }
  let received = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function extractFromHtml(html) {
  const $ = load(html);

  // Remove non-content elements
  $('script, style, nav, header, footer, aside, iframe, form, button, input, textarea, select, noscript, svg, canvas').remove();

  // Try common article containers
  const selectors = [
    'article',
    '[role="main"]',
    'main',
    '.post-content',
    '.entry-content',
    '.article-content',
    '.content',
    '#content',
    '.markdown-body',
    '.prose',
  ];

  let best = '';
  for (const sel of selectors) {
    const text = cleanText($(sel).text());
    if (text.length > best.length) best = text;
  }

  // Fallback to body if no container has substantial text
  if (best.length < 200) {
    best = cleanText($('body').text());
  }

  return best.slice(0, MAX_LENGTH).trim();
}

function cleanText(raw) {
  return raw
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .replace(/\n /g, '\n')
    .replace(/ \n/g, '\n')
    .trim();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node scripts/content-extractor.mjs <url>');
    process.exit(1);
  }
  extractFromUrl(url).then((text) => {
    console.log(text);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
