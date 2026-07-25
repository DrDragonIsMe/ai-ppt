#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectDir, ROOT_DIR } from './config.mjs';
import { captureSlideFrames, PAGE_WIDTH, PAGE_HEIGHT } from './deck-capture.mjs';
import { emit, emitDone, emitError } from './generation-common.mjs';

const __filename = fileURLToPath(import.meta.url);

// 产物相对路径与下载 URL（done 事件携带，前端直接触发下载）
function downloadInfo(file) {
  const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
  return { file: rel, downloadUrl: '/' + rel };
}

export async function exportPdf(name, onProgress) {
  const projectDir = getProjectDir(name);
  const indexHtml = path.join(projectDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`项目 ${name} 的 index.html 不存在`);
  }

  let hasPuppeteer = true;
  try {
    await import('puppeteer-core');
  } catch {
    hasPuppeteer = false;
  }
  if (!hasPuppeteer) {
    return { fallback: true, message: '未安装 puppeteer-core，请在浏览器预览页使用 Ctrl+P 导出 PDF。' };
  }

  const images = await captureSlideFrames(indexHtml, onProgress);

  onProgress?.('build', '正在合并 PDF');
  const exportDir = path.join(projectDir, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const outFile = path.join(exportDir, 'deck.pdf');
  await buildPdfFromImages(images, outFile);

  return { fallback: false, file: outFile };
}

async function buildPdfFromImages(images, outputFile) {
  let lib;
  try {
    lib = await import('pdf-lib');
  } catch {
    // Fallback: write only the first slide as a PNG so the user has something.
    fs.writeFileSync(outputFile.replace(/\.pdf$/, '.png'), images[0]);
    throw new Error('未安装 pdf-lib，无法合并 PDF，已保存首张图片。');
  }

  const pdfDoc = await lib.PDFDocument.create();
  const pageWidth = PAGE_WIDTH;
  const pageHeight = PAGE_HEIGHT;

  for (const imageBytes of images) {
    const img = await pdfDoc.embedPng(imageBytes);
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    page.drawImage(img, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
    });
  }

  const buf = await pdfDoc.save();
  fs.writeFileSync(outputFile, buf);
}

// CLI：NDJSON 协议输出到 stdout（progress/done/error，与 generate-deck.mjs 一致），
// 服务端 spawnNdjsonTask 逐行解析；stderr 仅用于非协议日志。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts/export-pdf.mjs <project>');
    process.exit(1);
  }
  exportPdf(name, (step, message) => emit(step, message))
    .then((result) => {
      if (result.fallback) {
        emitError(result.message);
        process.exit(1);
      } else {
        emitDone(downloadInfo(result.file));
      }
    })
    .catch((err) => {
      emitError(err.stack || err.message);
      process.exit(1);
    });
}
