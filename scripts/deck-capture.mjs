// scripts/deck-capture.mjs — puppeteer 逐页截图公共逻辑（export-pdf / export-video 共用）
// 视口与基座设计基准一致（ai-ppt-base/css/ppt.css：1280×800）
import fs from 'node:fs';
import path from 'node:path';
import { findChrome } from './export-pptx.mjs';
import { getProjectDir } from './config.mjs';
import { writeFileAtomic } from './fs-utils.mjs';

export const PAGE_WIDTH = 1280;
export const PAGE_HEIGHT = 800;
export const COVER_WIDTH = 480;
export const COVER_HEIGHT = 300;

// 逐页截取 index.html 的幻灯片，返回 PNG Buffer 数组（每页一张 1280×800）。
// indexHtml 为绝对路径；onProgress(step, message) 与各导出脚本一致。
export async function captureSlideFrames(indexHtml, onProgress) {
  let puppeteer;
  try {
    puppeteer = await import('puppeteer-core');
  } catch {
    throw new Error('未安装 puppeteer-core，无法截图');
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
        #help, #progress, #hud, #toast, #overview,
        .sidebar, .theme-switcher, .theme-hint, .fullscreen-btn, .marker-toolbar { display: none !important; }
        #stage.sidebar-open { margin-left: 0 !important; }
        /* 入场动画的基态是 opacity:0，动画禁用后需强制可见 */
        #stage > .slide.active * { opacity: 1 !important; transform: none !important; filter: none !important; }
      `;
      document.head.appendChild(style);
    });

    const slideCount = await page.evaluate(() => document.querySelectorAll('#stage > .slide').length);
    if (slideCount === 0) throw new Error('未找到幻灯片');

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
    return images;
  } finally {
    await browser.close();
  }
}

// 截第 1 页生成项目封面 projects/<name>/cover.png（480×300，deviceScaleFactor 缩放）。
// 全程不抛错：无 Chrome / 无幻灯片 / 未装 puppeteer 时静默返回 null，不阻断生成或导出。
export async function captureCover(name) {
  try {
    const indexHtml = path.join(getProjectDir(name), 'index.html');
    if (!fs.existsSync(indexHtml)) return null;

    let puppeteer;
    try {
      puppeteer = await import('puppeteer-core');
    } catch {
      return null;
    }
    let executablePath;
    try {
      executablePath = await findChrome();
    } catch {
      return null;
    }
    if (!executablePath) return null;

    const browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      // 1280×800 视口 × 0.375 缩放 = 480×300 像素输出
      await page.setViewport({
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        deviceScaleFactor: COVER_WIDTH / PAGE_WIDTH,
      });
      await page.goto('file://' + indexHtml, { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.fonts.ready);

      // 与 captureSlideFrames 相同：停掉动画、隐藏 UI 铬件，只显示第 1 页
      const slideCount = await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = `
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
            animation-play-state: paused !important;
          }
          #help, #progress, #hud, #toast, #overview,
          .sidebar, .theme-switcher, .theme-hint, .fullscreen-btn, .marker-toolbar { display: none !important; }
          #stage.sidebar-open { margin-left: 0 !important; }
          /* 入场动画的基态是 opacity:0（anim-slide/fade/bounce 等），动画禁用后需强制可见 */
          #stage > .slide.active * { opacity: 1 !important; transform: none !important; filter: none !important; }
        `;
        document.head.appendChild(style);
        const slides = document.querySelectorAll('#stage > .slide');
        slides.forEach((s, j) => {
          s.style.position = 'absolute';
          s.style.inset = '0';
          s.style.opacity = j === 0 ? '1' : '0';
          s.style.pointerEvents = 'none';
          s.style.zIndex = j === 0 ? '10' : '0';
          s.style.transform = 'none';
          s.style.animation = 'none';
          s.classList.toggle('active', j === 0);
        });
        return slides.length;
      });
      if (slideCount === 0) return null;

      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const png = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT },
      });
      const coverPath = path.join(getProjectDir(name), 'cover.png');
      writeFileAtomic(coverPath, Buffer.from(png));
      return coverPath;
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}
