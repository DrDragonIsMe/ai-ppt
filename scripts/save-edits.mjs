#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'cheerio';
import { readConfig, writeConfig, getProjectDir, createSnapshot } from './config.mjs';
import { injectThemeOverrides } from './theme-overrides.mjs';

// Save user-edited deck HTML back to the project.
// `html` should be the full document HTML as rendered in the editor iframe.
// We validate it contains the stage, then write it back while preserving
// theme overrides and recording the user edit in ai-ppt.json.
export function saveEditedHtml(name, html) {
  const projectDir = getProjectDir(name);
  const htmlPath = path.join(projectDir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error('项目尚未生成幻灯片');
  }

  const $ = load(html);
  const stage = $('#stage');
  if (stage.length === 0) {
    throw new Error('保存的 HTML 中未找到幻灯片主舞台 (#stage)');
  }

  // Snapshot before applying user edits so they can be rolled back.
  createSnapshot(name, '用户手动编辑前');

  // Replace the existing index.html stage with the edited one, keeping the
  // same shell (head scripts/styles, help, overview, etc.).
  const existing = load(fs.readFileSync(htmlPath, 'utf8'));
  const newStage = stage.clone();
  existing('#stage').replaceWith(newStage);

  let finalHtml = existing.html();

  // Re-apply theme overrides so they are not lost by the client-supplied HTML.
  const cfg = readConfig(name);
  if (cfg.themeOverrides && Object.keys(cfg.themeOverrides).length > 0) {
    finalHtml = injectThemeOverrides(finalHtml, cfg.themeOverrides);
  }

  fs.writeFileSync(htmlPath, finalHtml, 'utf8');

  // Record user edit metadata for AI prompts.
  const slideCount = newStage.find('section.slide').length;
  const editRecord = {
    savedAt: new Date().toISOString(),
    slideCount,
    htmlSnapshot: extractSlideTexts(newStage),
  };
  cfg.userEdits = editRecord;
  cfg.status = 'ready';
  cfg.lastGeneratedAt = new Date().toISOString();
  writeConfig(name, cfg);

  return editRecord;
}

function extractSlideTexts($stage) {
  const slides = [];
  const $ = load('');
  $stage.find('section.slide').each((i, el) => {
    const $slide = $(el);
    slides.push({
      index: i,
      heading: $slide.find('h1, h2').first().text().trim().slice(0, 200),
      text: $slide.text().replace(/\s+/g, ' ').trim().slice(0, 800),
    });
  });
  return slides;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [name, htmlPath] = process.argv.slice(2);
  if (!name || !htmlPath) {
    console.error('Usage: node scripts/save-edits.mjs <name> <path-to-edited-html>');
    process.exit(1);
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const record = saveEditedHtml(name, html);
  console.log(JSON.stringify(record, null, 2));
}
