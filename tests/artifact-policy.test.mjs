// tests/artifact-policy.test.mjs
// 「生成物与视频不入库」入库策略回归护栏（人类硬约束：不要把生成物加入 git，视频不要加入 git）。
// 只读本地 git 索引与文件系统，离线运行、无网络依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, cwd = repoRoot) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function trackedFiles() {
  return git(['ls-files']).split('\n').filter(Boolean);
}

// (a) 任何视频文件不得被 git 跟踪（含 .gitignore 声明的全部媒体扩展名）
test('artifact policy: no video files are tracked by git', () => {
  const videos = trackedFiles().filter((f) => /\.(mp4|mov|m4v|webm|avi)$/i.test(f));
  assert.deepEqual(videos, [], `以下视频文件被 git 跟踪，违反「视频不入库」约束：\n${videos.join('\n')}`);
});

// (b) 生成物/素材目录下的文件不得被 git 跟踪。
// 唯一豁免：projects/.gitkeep —— .gitignore 用 !projects/.gitkeep 刻意保留的占位文件，
// 用于维持 projects/ 目录存在（见 AGENTS.md 目录结构约定），不是生成物。
test('artifact policy: generated-artifact directories are not tracked', () => {
  const ALLOWED = new Set(['projects/.gitkeep']);
  const artifactDirs = /^(projects|published|test-output|references|marketing|export)\//;
  const violations = trackedFiles().filter((f) => artifactDirs.test(f) && !ALLOWED.has(f));
  assert.deepEqual(violations, [], `以下生成物目录下的文件被 git 跟踪：\n${violations.join('\n')}`);
});

// (c) 仓库根截图杂物不得被 git 跟踪（已 git rm --cached + .gitignore 兜底）
test('artifact policy: root screenshot-main.png is not tracked', () => {
  assert.ok(
    !trackedFiles().includes('screenshot-main.png'),
    'screenshot-main.png 仍在 git 索引中，应从索引移除（保留磁盘文件）并确认 .gitignore 覆盖',
  );
});

// (d) demo/ 封面是 GitHub Pages 部署源（.github/workflows/pages.yml 直接上传 demo/），
// web/icons/ 是 PWA 源资源 —— 两者必须保持跟踪，防止入库策略收紧时误伤线上演示。
test('artifact policy: Pages demo covers and PWA icons stay tracked', () => {
  const tracked = new Set(trackedFiles());
  for (const must of [
    'demo/cover-ai-ppt-intro.png',
    'web/icons/icon-192.png',
    'web/icons/icon-512.png',
  ]) {
    assert.ok(tracked.has(must), `${must} 失去跟踪：Pages 演示封面/PWA 图标将 404，请检查 .gitignore 收紧是否越界`);
  }
});

// (e) 本仓库工作区内不得出现 node_modules 待提交项（目录或符号链接形式均须被忽略）
test('artifact policy: node_modules never shows up as committable in this repo', () => {
  const status = git(['status', '--porcelain']);
  const hits = status.split('\n').filter((line) => /(^|[/\s])node_modules(\/|$)/.test(line));
  assert.deepEqual(hits, [], `node_modules 出现在待提交状态中（.gitignore 需为不带尾斜杠形式以匹配软链）：\n${hits.join('\n')}`);
});

// (f) 独立临时 repo 冒烟：验证 .gitignore 对「名为 node_modules 的符号链接」确实生效，
// 且对照组（普通未跟踪文件）会被 status 列出 —— 排除测试本身静默通过的可能。
test('artifact policy: .gitignore ignores a node_modules symlink (isolated repo)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ai-ppt-policy-'));
  try {
    copyFileSync(join(repoRoot, '.gitignore'), join(tmp, '.gitignore'));
    git(['init', '--quiet'], tmp);
    symlinkSync(join(repoRoot, 'package.json'), join(tmp, 'node_modules'));
    writeFileSync(join(tmp, 'control-untracked.txt'), 'probe\n');
    const code = (() => {
      try {
        git(['check-ignore', '-q', 'node_modules'], tmp);
        return 0;
      } catch (err) {
        return err.status;
      }
    })();
    assert.equal(code, 0, 'check-ignore 未命中：node_modules 软链形式未被 .gitignore 忽略');
    const status = git(['status', '--porcelain'], tmp);
    assert.match(status, /\?\? control-untracked\.txt/, '对照组未被 status 列出，status 断言无效');
    assert.doesNotMatch(status, /node_modules/, 'status 把 node_modules 软链列为待提交项');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
