#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const BASE_INDEX = path.join(ROOT, 'ai-ppt-base', 'index.html');
const FONTS_DIR = path.join(ROOT, 'ai-ppt-base', 'fonts');
const GOOGLE_CSS_URL = 'https://fonts.googleapis.com/css2';
const WEIGHTS = [400, 600, 700];

function collectChars(indexPath, chars) {
  if (!fs.existsSync(indexPath)) return;
  const html = fs.readFileSync(indexPath, 'utf8');
  const text = html.replace(/<[^>]+>/g, '').replace(/[\s\n\r]+/g, '');
  for (const ch of text) chars.add(ch);
}

function extractUniqueChars() {
  const chars = new Set();

  // Include the base demo deck so its characters are covered too.
  collectChars(BASE_INDEX, chars);

  const projects = fs.existsSync(PROJECTS_DIR)
    ? fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];

  for (const name of projects) {
    collectChars(path.join(PROJECTS_DIR, name, 'index.html'), chars);
  }

  return Array.from(chars).sort().join('');
}

async function fetchFontUrl(text, weight) {
  const params = new URLSearchParams({
    family: `Noto Sans SC:wght@${weight}`,
    text,
    display: 'swap',
  });
  const url = `${GOOGLE_CSS_URL}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch CSS for ${weight}: ${res.status}`);
  const css = await res.text();
  const match = css.match(/src:\s*url\(([^)]+)\)/);
  if (!match) throw new Error(`No font URL found for ${weight}`);
  return match[1];
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
}

async function main() {
  const text = extractUniqueChars();
  if (!text.length) {
    console.log('No characters found in any deck; nothing to subset.');
    process.exit(0);
  }
  console.log(`Extracted ${text.length} unique characters from decks.`);

  fs.mkdirSync(FONTS_DIR, { recursive: true });

  for (const weight of WEIGHTS) {
    const fontUrl = await fetchFontUrl(text, weight);
    const ext = fontUrl.endsWith('.woff2') ? 'woff2' : 'ttf';
    const dest = path.join(FONTS_DIR, `noto-sans-sc-${weight}.${ext}`);
    console.log(`Downloading weight ${weight} from ${fontUrl} ...`);
    await downloadFile(fontUrl, dest);
    const size = fs.statSync(dest).size;
    console.log(`  saved ${path.relative(ROOT, dest)} (${(size / 1024).toFixed(1)} KB)`);
  }

  console.log('Done. Remember to run npm run upgrade-decks to copy fonts to projects.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
