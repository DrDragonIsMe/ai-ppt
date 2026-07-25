#!/usr/bin/env node
/**
 * ai-ppt skills 安装向导（零依赖，幂等）。
 *
 * 用法：
 *   node install-skills.js                安装全部 skills
 *   node install-skills.js ppt-list ...   只安装指定 skills
 *   node install-skills.js --dry-run      只打印会做什么，不改动文件
 *   node install-skills.js --uninstall    卸载已安装的 skills
 *   node install-skills.js --guide        打印快速上手指引
 *
 * 布局：
 *   ~/.agents/skills/<name>     真实文件（canonical，所有 CLI 共享）
 *   ~/.kimi-code/skills/<name>  指向 ~/.agents 的相对软链
 *   ~/.claude/skills/<name>     同上（仅当检测到 ~/.claude）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const skillsDir = path.resolve(__dirname, 'skills');
const agentsSkillsDir = path.resolve(os.homedir(), '.agents', 'skills');

// 软链目标：<CLI 配置目录>/skills/<name> -> ../../.agents/skills/<name>
const LINK_TARGETS = [
  { cli: 'Kimi Code', home: path.resolve(os.homedir(), '.kimi-code'), always: true },
  { cli: 'Claude Code', home: path.resolve(os.homedir(), '.claude'), always: false },
];

function parseArgs(argv) {
  const opts = { dryRun: false, uninstall: false, guide: false, help: false, names: [] };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--guide') opts.guide = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    } else opts.names.push(arg);
  }
  return opts;
}

function detectTargets() {
  // ~/.agents 是 canonical 存放处，始终使用；软链目标按 CLI 检测情况决定。
  return LINK_TARGETS.map((t) => ({
    ...t,
    skillsDir: path.join(t.home, 'skills'),
    detected: t.always || fs.existsSync(t.home),
  }));
}

function ensureDir(dir, dryRun) {
  if (!fs.existsSync(dir)) {
    if (dryRun) {
      console.log(`[dry-run] Would create ${dir}`);
    } else {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created ${dir}`);
    }
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removePath(p, dryRun) {
  if (!fs.existsSync(p) && !fs.lstatSync(p, { throwIfNoEntry: false })) return false;
  if (dryRun) {
    console.log(`[dry-run] Would remove ${p}`);
  } else {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) fs.unlinkSync(p);
    else fs.rmSync(p, { recursive: true, force: true });
    console.log(`Removed ${p}`);
  }
  return true;
}

function installSkill(name, targets, dryRun) {
  const src = path.join(skillsDir, name);
  const agentsDest = path.join(agentsSkillsDir, name);

  if (!fs.existsSync(src)) {
    console.error(`Skill not found: ${src}`);
    return false;
  }

  // 1. 复制真实文件到 ~/.agents/skills/<name>
  const verb = fs.existsSync(agentsDest) ? 'Updating' : 'Installing';
  if (dryRun) {
    console.log(`[dry-run] Would ${verb === 'Updating' ? 'update' : 'install'} ${name} -> ${agentsDest}`);
  } else {
    if (fs.existsSync(agentsDest)) fs.rmSync(agentsDest, { recursive: true, force: true });
    copyDir(src, agentsDest);
    console.log(`${verb} ${name} -> ${agentsDest}`);
  }

  // 2. 在检测到的 CLI skills 目录建相对软链
  for (const t of targets) {
    if (!t.detected) continue;
    const link = path.join(t.skillsDir, name);
    const rel = path.relative(path.dirname(link), agentsDest);
    if (dryRun) {
      console.log(`[dry-run] Would link ${link} -> ${rel} (${t.cli})`);
      continue;
    }
    ensureDir(t.skillsDir, dryRun);
    removePath(link, false);
    fs.symlinkSync(rel, link);
    console.log(`Linked ${link} -> ${rel}`);
  }
  return true;
}

function uninstallSkill(name, targets, dryRun) {
  let removed = false;
  removed = removePath(path.join(agentsSkillsDir, name), dryRun) || removed;
  for (const t of targets) {
    removed = removePath(path.join(t.skillsDir, name), dryRun) || removed;
  }
  if (!removed && !dryRun) console.log(`Not installed: ${name}`);
  return true;
}

function printGuide() {
  const isTTY = process.stdout.isTTY;
  const bold = (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  console.log(`
${bold('快速上手（Quick Start）')}

  1. 启动 Web 控制台（知识库 + PPT 项目管理）：
       npm run web          # 打开 http://localhost:3456

  2. 在 CLI 中新建一份 deck：
       /ppt-structure my-deck

  3. 查看所有 deck：
       /ppt-list

${bold('在线文档')}
  README        https://github.com/DrDragonIsMe/ai-ppt#readme
  设计规范       使用 /ppt-design skill
  项目约定       仓库根目录 AGENTS.md
`);
}

function printHelp() {
  console.log(`Usage: node install-skills.js [options] [skill ...]

Options:
  --dry-run     只打印会做什么，不改动文件
  --uninstall   卸载已安装的 skills（可与 --dry-run 组合）
  --guide       打印快速上手指引
  -h, --help    显示本帮助

不带 skill 名时操作 skills/ 下的全部 skills。`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.guide) {
    printGuide();
    return;
  }

  const targets = detectTargets();

  // CLI 检测报告
  console.log('Detected AI CLIs:');
  console.log(`  ~/.agents (shared)        always used (canonical skill files)`);
  for (const t of targets) {
    const mark = t.detected ? 'detected' : 'not found, skipped';
    console.log(`  ${t.home.replace(os.homedir(), '~')}/skills  ${mark}${t.detected ? ` (${t.cli})` : ''}`);
  }
  console.log('');

  const requested = opts.names.length > 0 ? opts.names : fs.readdirSync(skillsDir);

  // 校验请求的 skill 名都存在
  let ok = true;
  for (const name of requested) {
    if (!fs.existsSync(path.join(skillsDir, name))) {
      console.error(`Unknown skill: ${name}`);
      ok = false;
    }
  }
  if (!ok) process.exit(1);

  const action = opts.uninstall ? 'Uninstalling' : 'Installing';
  console.log(`${opts.dryRun ? '[dry-run] ' : ''}${action} ${requested.length} skill(s)...\n`);

  if (!opts.uninstall) ensureDir(agentsSkillsDir, opts.dryRun);

  for (const name of requested) {
    const fn = opts.uninstall ? uninstallSkill : installSkill;
    ok = fn(name, targets, opts.dryRun) && ok;
  }

  if (!ok) {
    console.error('\nSome skills failed to install.');
    process.exit(1);
  }

  if (opts.dryRun) {
    console.log('\n[dry-run] No changes were made.');
    return;
  }

  if (opts.uninstall) {
    console.log('\nDone. Skills uninstalled.');
    return;
  }

  console.log('\nDone. Restart your CLI session if skills are not immediately available.');
  printGuide();
}

main();
