#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectDir, ROOT_DIR } from './config.mjs';
import { findChrome } from './export-pptx.mjs';
import { emit, emitDone, emitError } from './generation-common.mjs';

const __filename = fileURLToPath(import.meta.url);

// 与基座设计基准一致（ai-ppt-base/css/ppt.css：1280×800）
const PAGE_WIDTH = 1280;
const PAGE_HEIGHT = 800;

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

  let puppeteer;
  try {
    puppeteer = await import('puppeteer-core');
  } catch {
    return { fallback: true, message: '未安装 puppeteer-core，请在浏览器预览页使用 Ctrl+P 导出 PDF。' };
  }

  const executablePath = await findChrome();
  onProgress?.('launch', '正在启动浏览器');
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
    await page.goto('file://' + indexHtml, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);

    // Disable all animations/transitions and hide UI chrome so screenshots
    // capture the final state of each slide.
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
          animation-play-state: paused !important;
        }
        #help, #progress, #hud, #toast, #overview { display: none !important; }
      `;
      document.head.appendChild(style);
    });

    const slideCount = await page.evaluate(() => document.querySelectorAll('#stage > .slide').length);
    if (slideCount === 0) throw new Error('未找到幻灯片');

    const exportDir = path.join(projectDir, 'export');
    fs.mkdirSync(exportDir, { recursive: true });

    const images = [];
    for (let i = 0; i < slideCount; i++) {
      onProgress?.('capture', `正在截取第 ${i + 1}/${slideCount} 页`);
      await page.evaluate((idx) => {
        document.querySelectorAll('#stage > .slide').forEach((s, j) => {
          s.style.position = 'absolute';
          s.style.inset = '0';
          s.style.opacity = j === idx ? '1' : '0';
          s.style.pointerEvents = 'none';
          s.style.zIndex = j === idx ? '10' : '0';
          s.style.transform = 'none';
          s.style.animation = 'none';
          s.classList.toggle('active', j === idx);
        });
      }, i);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      const png = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT },
        encoding: 'base64',
      });
      images.push(Buffer.from(png, 'base64'));
    }

    onProgress?.('build', '正在合并 PDF');
    const outFile = path.join(exportDir, 'deck.pdf');
    await buildPdfFromImages(images, outFile);

    return { fallback: false, file: outFile };
  } finally {
    await browser.close();
  }
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
