// tests/artifact-policy.test.mjs
// 「生成物与视频不入库」入库策略回归护栏（人类硬约束：不要把生成物加入 git，视频不要加入 git）。
// 只读本地 git 索引与文件系统 + 系统临时目录，离线运行、无网络依赖、不改动本仓库索引。
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

// 仓库根零引用杂物：screenshot-main.png（文档截图残留）、lark-auth-qr.png（塔的 worktree
// 快照机制扫入的飞书授权二维码，凭证类残留物）。均已 git rm --cached + .gitignore 防回填。
const ROOT_JUNK_FILES = ['screenshot-main.png', 'lark-auth-qr.png'];

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

// (c) 仓库根杂物不得被 git 跟踪（见 ROOT_JUNK_FILES 注释）
test('artifact policy: root junk files are not tracked', () => {
  const tracked = new Set(trackedFiles());
  for (const junk of ROOT_JUNK_FILES) {
    assert.ok(
      !tracked.has(junk),
      `${junk} 仍在 git 索引中：应 git rm --cached（保留磁盘文件）并确认 .gitignore 覆盖`,
    );
  }
});

// (d) demo/ 封面是 GitHub Pages 部署源（.github/workflows/pages.yml 直接上传 demo/），
// web/icons/ 是 PWA 源资源 —— 两者必须保持跟踪。注意本断言查的是索引（git ls-files），
// 守的是「被误删/误 untrack」；「ignore 规则误伤已跟踪内容」由 (g) 类级断言负责。
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

// (f) 独立临时 repo 冒烟：验证 .gitignore 对「名为 node_modules 的符号链接」确实生效。
// 用 GIT_CONFIG_GLOBAL/SYSTEM=/dev/null 隔离全局与系统 git 配置，并断言 check-ignore -v
// 的命中来源是 .gitignore 本身——否则 core.excludesFile / info/exclude 可能补位命中，
// 把「.gitignore 规则写坏」的真阴性掩盖成假通过。对照组（普通未跟踪文件）保证 status 断言不空转。
test('artifact policy: .gitignore ignores a node_modules symlink (isolated repo)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ai-ppt-policy-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const probe = (args) => {
    try {
      return { code: 0, out: execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8', env }) };
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };
  try {
    copyFileSync(join(repoRoot, '.gitignore'), join(tmp, '.gitignore'));
    assert.equal(probe(['init', '--quiet']).code, 0, '临时 repo git init 失败');
    symlinkSync(join(repoRoot, 'package.json'), join(tmp, 'node_modules'));
    writeFileSync(join(tmp, 'control-untracked.txt'), 'probe\n');

    const ign = probe(['check-ignore', '-v', 'node_modules']);
    assert.equal(ign.code, 0, `node_modules 软链未被 .gitignore 忽略（输出：${ign.out.trim()}）`);
    assert.match(
      ign.out,
      /^\.gitignore:\d+:/m,
      `check-ignore 命中来源必须是本仓库复制的 .gitignore，实际：${ign.out.trim()}`,
    );

    const status = probe(['status', '--porcelain']).out;
    assert.match(status, /\?\? control-untracked\.txt/, '对照组未被 status 列出，status 断言无效');
    assert.doesNotMatch(status, /node_modules/, 'status 把 node_modules 软链列为待提交项');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// (g) 类级护栏：任何当前被跟踪的路径都不得命中 ignore 规则。
// 一次性照出「收紧规则静默命中已跟踪内容」这一整类 bug（如未锚定的 marketing/ 误伤 docs/marketing/）。
// --no-index 必须带：否则 check-ignore 会因「文件在索引中」直接跳过，永不报忽略。
// check-ignore -v 对「最后命中 negation（!pattern）」的路径也会打印，但那些路径并未被忽略，需滤掉。
test('artifact policy: no tracked path matches an ignore rule', () => {
  let out = '';
  try {
    out = execFileSync(
      'git',
      ['-C', repoRoot, 'check-ignore', '--no-index', '-v', '--stdin'],
      { encoding: 'utf8', input: `${trackedFiles().join('\n')}\n` },
    );
  } catch (err) {
    if (err.status === 1) return; // 没有任何路径命中 ignore 规则——正是期望状态
    throw err;
  }
  const violations = out.split('\n').filter(Boolean).filter((line) => {
    const rule = line.split('\t')[0].split(':').slice(2).join(':');
    return !rule.startsWith('!');
  });
  assert.deepEqual(
    violations,
    [],
    [
      '以下已跟踪路径命中了 .gitignore 规则（gitignore 虽不影响已跟踪文件的行为，',
      '但说明规则过度收紧，新增同路径文件会被静默漏掉）：',
      ...violations,
    ].join('\n'),
  );
});
