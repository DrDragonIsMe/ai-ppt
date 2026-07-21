#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'cheerio';
import { getProjectDir } from './config.mjs';

// Bundle a project deck into a single self-contained HTML file:
// all local CSS (<link rel="stylesheet">) and JS (<script src>) are inlined.
export async function exportSingleHtml(name) {
  const dir = getProjectDir(name);
  const htmlPath = path.join(dir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`项目 ${name} 不存在或尚未生成幻灯片`);
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const $ = load(html);

  // Inline stylesheets
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || /^https?:/i.test(href)) return;
    const cssPath = path.join(dir, href);
    if (fs.existsSync(cssPath)) {
      const css = fs.readFileSync(cssPath, 'utf8');
      $(el).replaceWith(`<style data-inlined-from="${href}">\n${css}\n</style>`);
    }
  });

  // Inline scripts
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (!src || /^https?:/i.test(src)) return;
    const jsPath = path.join(dir, src);
    if (fs.existsSync(jsPath)) {
      const js = fs.readFileSync(jsPath, 'utf8');
      $(el).replaceWith(`<script data-inlined-from="${src}">\n${js}\n</script>`);
    }
  });

  const outDir = path.join(dir, 'export');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'deck-single.html');
  fs.writeFileSync(outPath, $.html(), 'utf8');
  return outPath;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts/export-single-html.mjs <project>');
    process.exit(1);
  }
  exportSingleHtml(name)
    .then((file) => console.log(`已导出单文件 HTML: ${file}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
