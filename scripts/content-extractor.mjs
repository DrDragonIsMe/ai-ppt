#!/usr/bin/env node
import { load } from 'cheerio';

const MAX_LENGTH = 12000;

export async function extractFromUrl(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ai-ppt-bot/1.0)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  return extractFromHtml(html);
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
