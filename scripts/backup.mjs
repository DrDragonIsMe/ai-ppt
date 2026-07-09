#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.backup') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function backupFile(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  }
}

export function runBackup(label = 'manual') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(ROOT, '.backup', `${label}-${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  copyDir(path.join(ROOT, 'projects'), path.join(backupDir, 'projects'));
  copyDir(path.join(ROOT, 'skills'), path.join(backupDir, 'skills'));
  copyDir(path.join(ROOT, 'web'), path.join(backupDir, 'web'));

  backupFile(path.join(ROOT, 'AGENTS.md'), backupDir);
  backupFile(path.join(ROOT, 'README.md'), backupDir);
  backupFile(path.join(ROOT, 'MEMORY.md'), backupDir);
  backupFile(path.join(ROOT, 'package.json'), backupDir);
  backupFile(path.join(ROOT, 'server.mjs'), backupDir);

  return backupDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = runBackup('manual');
  console.log(dir);
}
