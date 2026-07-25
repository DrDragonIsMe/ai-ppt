#!/usr/bin/env node
// scripts/export-site.mjs — 静态站点包导出：把 deck 目录打成 zip，
// 解压后丢到任何静态托管（或本地双击 index.html）即可放映。
import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { getProjectDir } from './config.mjs';

// 打包内容：index.html + css/js/assets/themes 等 deck 全部运行所需文件；
// 排除 export/（避免 zip 套 zip）与隐藏文件（.DS_Store 等）。
export async function exportSiteZip(name) {
  const dir = getProjectDir(name);
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    throw new Error(`项目 ${name} 不存在或尚未生成幻灯片`);
  }

  const outDir = path.join(dir, 'export');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'site.zip');

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(dir, false, (entry) => {
      const rel = entry.name;
      if (rel === 'export' || rel.startsWith('export/')) return false;
      if (rel === 'chat-history.json' || rel === 'ai-ppt.json') return false;
      if (rel.split('/').some((seg) => seg.startsWith('.'))) return false;
      return entry;
    });
    archive.finalize();
  });

  return outPath;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts/export-site.mjs <project>');
    process.exit(1);
  }
  exportSiteZip(name)
    .then((file) => console.log(`已导出静态站点包: ${file}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
