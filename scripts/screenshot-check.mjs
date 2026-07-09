import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const deck = process.argv[2] || 'q3-sales-preview';
const outDir = path.resolve(`projects/${deck}/export`);
const indexPath = path.resolve(`projects/${deck}/index.html`);

fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

await page.goto(`file://${indexPath}`, { waitUntil: 'networkidle0' });
await sleep(800);

const slides = await page.$$eval('#stage > .slide', ss => ss.length);
console.log(`slides: ${slides}`);

await page.keyboard.press('?');
await sleep(300);

for (let i = 0; i < Math.min(slides, 9); i++) {
  await page.evaluate(idx => window.goToSlide && window.goToSlide(idx), i);
  await sleep(1500);
  const file = path.join(outDir, `check-${String(i + 1).padStart(2, '0')}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`screenshot -> ${file}`);
}

await browser.close();
