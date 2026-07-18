#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const BASE_CSS = path.join(ROOT, 'ai-ppt-base', 'css', 'ppt.css');
const BASE_JS = path.join(ROOT, 'ai-ppt-base', 'js', 'ppt.js');
const BASE_THEMES_DIR = path.join(ROOT, 'ai-ppt-base', 'css', 'themes');
const PROJECTS_DIR = path.join(ROOT, 'projects');

function usage() {
  console.log(`Usage: node scripts/upgrade-decks.mjs [options]

Options:
  --dry-run          Print what would be copied, but do not copy.
  --project <name>   Upgrade only the specified project.
  --help             Show this help.
`);
}

function parseArgs(argv) {
  const options = { dryRun: false, project: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--project') {
      const next = argv[++i];
      if (!next) {
        console.error('Error: --project requires a project name.');
        process.exit(1);
      }
      options.project = next;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      console.error(`Unknown option: ${arg}`);
      usage();
      process.exit(1);
    }
  }
  return options;
}

function ensureBaseFiles() {
  if (!fs.existsSync(BASE_CSS)) {
    console.error(`Base CSS not found: ${BASE_CSS}`);
    process.exit(1);
  }
  if (!fs.existsSync(BASE_JS)) {
    console.error(`Base JS not found: ${BASE_JS}`);
    process.exit(1);
  }
}

function getThemeFiles() {
  if (!fs.existsSync(BASE_THEMES_DIR)) {
    return [];
  }
  const entries = fs.readdirSync(BASE_THEMES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.css'))
    .map((e) => path.join(BASE_THEMES_DIR, e.name));
}

function listProjects(filterName = null) {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return [];
  }
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  const projects = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (filterName) {
    if (!projects.includes(filterName)) {
      console.error(`Project not found in ${PROJECTS_DIR}: ${filterName}`);
      process.exit(1);
    }
    return [filterName];
  }
  return projects;
}

function upgradeProject(name, dryRun) {
  const projectDir = path.join(PROJECTS_DIR, name);
  const cssDir = path.join(projectDir, 'css');
  const jsDir = path.join(projectDir, 'js');
  const themesDir = path.join(cssDir, 'themes');
  const cssDest = path.join(cssDir, 'ppt.css');
  const jsDest = path.join(jsDir, 'ppt.js');
  const themeFiles = getThemeFiles();

  const hasCssDir = fs.existsSync(cssDir) && fs.statSync(cssDir).isDirectory();
  const hasJsDir = fs.existsSync(jsDir) && fs.statSync(jsDir).isDirectory();

  if (!hasCssDir && !hasJsDir) {
    console.log(`  ${name}: skipped (no css/js directories)`);
    return;
  }

  if (dryRun) {
    console.log(`  ${name}:`);
    if (hasCssDir) console.log(`    would copy -> ${path.relative(ROOT, cssDest)}`);
    if (hasJsDir) console.log(`    would copy -> ${path.relative(ROOT, jsDest)}`);
    if (hasCssDir && themeFiles.length > 0) {
      console.log(`    would copy ${themeFiles.length} theme(s) -> ${path.relative(ROOT, themesDir)}/`);
    }
    return;
  }

  console.log(`  ${name}:`);
  if (hasCssDir) {
    fs.mkdirSync(cssDir, { recursive: true });
    fs.copyFileSync(BASE_CSS, cssDest);
    console.log(`    copied -> ${path.relative(ROOT, cssDest)}`);

    if (themeFiles.length > 0) {
      fs.mkdirSync(themesDir, { recursive: true });
      for (const themeFile of themeFiles) {
        const destFile = path.join(themesDir, path.basename(themeFile));
        fs.copyFileSync(themeFile, destFile);
      }
      console.log(`    copied ${themeFiles.length} theme(s) -> ${path.relative(ROOT, themesDir)}/`);
    }
  }
  if (hasJsDir) {
    fs.mkdirSync(jsDir, { recursive: true });
    fs.copyFileSync(BASE_JS, jsDest);
    console.log(`    copied -> ${path.relative(ROOT, jsDest)}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }

  ensureBaseFiles();

  const projects = listProjects(options.project);
  if (projects.length === 0) {
    console.log(`No projects found in ${PROJECTS_DIR}.`);
    process.exit(0);
  }

  console.log(`${options.dryRun ? '[DRY RUN] ' : ''}Upgrading ${projects.length} project(s) from ai-ppt-base...\n`);
  for (const name of projects) {
    upgradeProject(name, options.dryRun);
  }
  console.log('\nDone.');
}

main();
