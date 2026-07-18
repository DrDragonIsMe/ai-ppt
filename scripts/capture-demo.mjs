import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
await page.goto('http://localhost:3457/projects/test-deck/', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 800));

const slides = [0, 1, 3, 7, 9];
const files = [];
for (let i = 0; i < slides.length; i++) {
  const idx = slides[i];
  await page.evaluate((n) => window.goTo && window.goTo(n), idx);
  await new Promise(r => setTimeout(r, 600));
  const file = path.resolve(__dirname, `../test-deck-slide-${idx + 1}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  files.push(file);
  console.log('Captured:', file);
}
await browser.close();
console.log('Done:', files);
