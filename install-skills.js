#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const skillsDir = path.resolve(__dirname, 'skills');
const agentsSkillsDir = path.resolve(os.homedir(), '.agents', 'skills');
const kimiSkillsDir = path.resolve(os.homedir(), '.kimi-code', 'skills');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created ${dir}`);
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

function installSkill(name) {
  const src = path.join(skillsDir, name);
  const agentsDest = path.join(agentsSkillsDir, name);
  const kimiLink = path.join(kimiSkillsDir, name);
  const relativeToAgents = path.relative(path.dirname(kimiLink), agentsDest);

  if (!fs.existsSync(src)) {
    console.error(`Skill not found: ${src}`);
    return false;
  }

  // Copy to ~/.agents/skills/<name>
  if (fs.existsSync(agentsDest)) {
    console.log(`Updating ${name} in ${agentsDest}`);
    fs.rmSync(agentsDest, { recursive: true, force: true });
  } else {
    console.log(`Installing ${name} to ${agentsDest}`);
  }
  copyDir(src, agentsDest);

  // Create symlink in ~/.kimi-code/skills/<name>
  if (fs.existsSync(kimiLink)) {
    const stat = fs.lstatSync(kimiLink);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(kimiLink);
    } else {
      fs.rmSync(kimiLink, { recursive: true, force: true });
    }
  }
  fs.symlinkSync(relativeToAgents, kimiLink);
  console.log(`Linked ${kimiLink} -> ${relativeToAgents}`);

  return true;
}

function main() {
  const args = process.argv.slice(2);
  const requestedSkills = args.length > 0 ? args : fs.readdirSync(skillsDir);

  ensureDir(agentsSkillsDir);
  ensureDir(kimiSkillsDir);

  let ok = true;
  for (const name of requestedSkills) {
    const skillPath = path.join(skillsDir, name);
    if (!fs.existsSync(skillPath)) {
      console.error(`Unknown skill: ${name}`);
      ok = false;
      continue;
    }
    ok = installSkill(name) && ok;
  }

  if (ok) {
    console.log('\nDone. Restart your CLI session if skills are not immediately available.');
  } else {
    console.error('\nSome skills failed to install.');
    process.exit(1);
  }
}

main();
