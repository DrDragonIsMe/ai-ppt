#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const BASE_DIR = path.join(ROOT, 'ai-ppt-base');
const BASE_CSS = path.join(BASE_DIR, 'css', 'ppt.css');
const BASE_JS = path.join(BASE_DIR, 'js', 'ppt.js');
const BASE_README = path.join(BASE_DIR, 'README.md');

export const ROOT_DIR = ROOT;
export const PROJECTS_ROOT = PROJECTS_DIR;

export function ensureProjectsDir() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

export function listProjects() {
  ensureProjectsDir();
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const cfg = readConfig(e.name);
      return {
        name: e.name,
        status: cfg.status || 'draft',
        title: cfg.params?.title || e.name,
        lastGeneratedAt: cfg.lastGeneratedAt || null,
      };
    });
}

export function getProjectDir(name) {
  return path.join(PROJECTS_DIR, name);
}

export function projectExists(name) {
  return fs.existsSync(getProjectDir(name));
}

export function ensureBaseEngine(name) {
  const dir = getProjectDir(name);
  fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.copyFileSync(BASE_CSS, path.join(dir, 'css', 'ppt.css'));
  fs.copyFileSync(BASE_JS, path.join(dir, 'js', 'ppt.js'));
}

export function createStarterHtml(name, title) {
  const subtitle = '由 ai-ppt 自动生成';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="css/ppt.css">
</head>
<body>
  <div id="app">
    <main id="stage" class="stage">
      <section class="slide active">
        <div class="slide-content" style="text-align: center;">
          <div class="kicker">AI 生成</div>
          <h1>${escapeHtml(title)}</h1>
          <p class="lead">${escapeHtml(subtitle)}</p>
          <p style="font-size: 16px; opacity: 0.55; margin-top: 40px;">点击“生成幻灯片”开始</p>
        </div>
      </section>
      <section class="slide">
        <div class="slide-content">
          <div class="section-title">About</div>
          <h2>关于本项目</h2>
          <p class="lead">在 Web 管理界面中配置 URL 或文章内容，然后点击生成，即可得到一套完整的 HTML 幻灯片。</p>
        </div>
      </section>
      <section class="slide">
        <div class="slide-content" style="text-align: center;">
          <div class="kicker">Thank You</div>
          <h1>谢谢</h1>
        </div>
      </section>
    </main>

    <div id="overview" class="overview hidden">
      <div class="overview-title">幻灯片预览 · 点击跳转</div>
      <div class="overview-grid"></div>
    </div>

    <div id="help" class="help">
      <div><kbd>←</kbd> 上一页 · <kbd>→</kbd> 下一页</div>
      <div><kbd>Cmd</kbd>+<kbd>←</kbd> 首页 · <kbd>Cmd</kbd>+<kbd>→</kbd> 尾页</div>
      <div><kbd>↑</kbd> 预览 · <kbd>↓</kbd> 导出 PDF</div>
      <div><kbd>F</kbd> 全屏 · <kbd>?</kbd> 帮助</div>
    </div>

    <div id="toast" class="toast"></div>
    <div id="progress" class="progress"></div>
    <div id="hud" class="hud"></div>
  </div>
  <script src="js/ppt.js"></script>
</body>
</html>`;
}

export function createProject(name, title) {
  ensureProjectsDir();
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('项目名称只能包含字母、数字、下划线和中划线');
  }
  const dir = getProjectDir(name);
  if (fs.existsSync(dir)) {
    throw new Error(`项目 ${name} 已存在`);
  }
  fs.mkdirSync(dir, { recursive: true });
  ensureBaseEngine(name);
  fs.copyFileSync(BASE_README, path.join(dir, 'README.md'));
  fs.writeFileSync(path.join(dir, 'index.html'), createStarterHtml(name, title || name), 'utf8');

  const config = defaultConfig(name, title);
  writeConfig(name, config);
  return config;
}

export function deleteProject(name) {
  const dir = getProjectDir(name);
  if (!fs.existsSync(dir)) {
    throw new Error(`项目 ${name} 不存在`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export const PRESET_MODELS = [
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    provider: 'kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'kimi-for-coding',
  },
  {
    id: 'openai-gpt-4o-mini',
    name: 'OpenAI GPT-4o mini',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    id: 'openai-gpt-4o',
    name: 'OpenAI GPT-4o',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
  {
    id: 'custom',
    name: '自定义',
    provider: 'openai',
    baseUrl: '',
    model: '',
  },
];

export function defaultModelConfig() {
  return {
    presetId: 'kimi-code',
    provider: 'kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'kimi-for-coding',
    apiKey: '',
  };
}

function defaultModel() {
  if (process.env.OPENAI_API_KEY?.startsWith('sk-kimi-')) {
    return process.env.OPENAI_MODEL || 'kimi-for-coding';
  }
  return 'qwen-max';
}

export function defaultConfig(name, title) {
  return {
    name,
    sourceType: 'article',
    sourceUrl: '',
    articleText: '',
    params: {
      title: title || name,
      audience: '通用听众',
      style: '商业汇报',
      slideCount: 8,
      language: 'zh-CN',
      model: defaultModel(),
    },
    modelConfig: defaultModelConfig(),
    status: 'draft',
    lastGeneratedAt: null,
    errorMessage: null,
  };
}

export function migrateModelConfig(cfg) {
  if (cfg.modelConfig) return cfg;
  const preset = PRESET_MODELS.find((m) => m.id === (cfg.params?.model || 'kimi-code'));
  cfg.modelConfig = preset
    ? { ...preset, presetId: preset.id, apiKey: '' }
    : defaultModelConfig();
  return cfg;
}

export function readConfig(name) {
  const file = path.join(getProjectDir(name), 'ai-ppt.json');
  if (!fs.existsSync(file)) {
    return defaultConfig(name, name);
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return migrateModelConfig(cfg);
  } catch (err) {
    return defaultConfig(name, name);
  }
}

export function writeConfig(name, config) {
  const file = path.join(getProjectDir(name), 'ai-ppt.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
}

export function updateStatus(name, status, errorMessage = null) {
  const cfg = readConfig(name);
  cfg.status = status;
  if (errorMessage !== undefined) cfg.errorMessage = errorMessage;
  if (status === 'ready') cfg.lastGeneratedAt = new Date().toISOString();
  writeConfig(name, cfg);
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'create') {
    const name = process.argv[3];
    const title = process.argv[4] || name;
    createProject(name, title);
    console.log(`Created project ${name}`);
  } else if (cmd === 'list') {
    console.log(JSON.stringify(listProjects(), null, 2));
  } else {
    console.log('Usage: node scripts/config.mjs [create <name> [title] | list]');
  }
}
