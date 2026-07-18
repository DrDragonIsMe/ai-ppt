
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const PROJECTS_DIR = path.join(ROOT, 'projects');
const BASE_INDEX = path.join(ROOT, 'ai-ppt-base', 'index.html');

const NEW_HEAD = `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>薪人薪事 — 新一代智能人事薪酬平台</title>
  <link rel="stylesheet" href="css/ppt.css">
  <link rel="stylesheet" href="css/themes/theme-switcher.css">
  <link rel="stylesheet" href="css/themes/web-ui.css">
  <link rel="stylesheet" href="css/themes/business-blue.css">
  <link rel="stylesheet" href="css/themes/elegant-purple.css">
  <link rel="stylesheet" href="css/themes/warm-orange.css">
  <link rel="stylesheet" href="css/themes/sunset-red.css">
  <link rel="stylesheet" href="css/themes/tech-green.css">
  <link rel="stylesheet" href="css/themes/minimal-gray.css">
  <link rel="stylesheet" href="css/themes/dark-mode.css">
</head>`;

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return [];
  }
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function updateProjectIndex(name) {
  const projectDir = path.join(PROJECTS_DIR, name);
  const indexPath = path.join(projectDir, 'index.html');

  if (!fs.existsSync(indexPath)) {
    console.log(`  ${name}: no index.html, skipped`);
    return;
  }

  let content = fs.readFileSync(indexPath, 'utf8');

  // Replace the <head> section
  const headRegex = /<head>[\s\S]*?<\/head>/;
  if (headRegex.test(content)) {
    content = content.replace(headRegex, NEW_HEAD);
    fs.writeFileSync(indexPath, content, 'utf8');
    console.log(`  ${name}: updated index.html`);
  } else {
    console.log(`  ${name}: could not find <head> section, skipped`);
  }
}

function main() {
  const projects = listProjects();
  if (projects.length === 0) {
    console.log('No projects found in projects/ directory.');
    process.exit(0);
  }

  console.log(`Updating ${projects.length} project(s) index.html...\n`);
  for (const name of projects) {
    updateProjectIndex(name);
  }
  console.log('\nDone.');
}

main();
