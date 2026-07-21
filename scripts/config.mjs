#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlobalConfig } from './global-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const BASE_DIR = path.join(ROOT, 'ai-ppt-base');
const BASE_CSS = path.join(BASE_DIR, 'css', 'ppt.css');
const BASE_JS = path.join(BASE_DIR, 'js', 'ppt.js');
const BASE_README = path.join(BASE_DIR, 'README.md');
const BASE_THEMES_DIR = path.join(BASE_DIR, 'css', 'themes');

export const ROOT_DIR = ROOT;
export const PROJECTS_ROOT = PROJECTS_DIR;

function getThemeFiles() {
  if (!fs.existsSync(BASE_THEMES_DIR)) {
    return [];
  }
  const entries = fs.readdirSync(BASE_THEMES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.css'))
    .map((e) => path.join(BASE_THEMES_DIR, e.name));
}

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
  const themeFiles = getThemeFiles();

  fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.copyFileSync(BASE_CSS, path.join(dir, 'css', 'ppt.css'));
  fs.copyFileSync(BASE_JS, path.join(dir, 'js', 'ppt.js'));

  if (themeFiles.length > 0) {
    const themesDest = path.join(dir, 'css', 'themes');
    fs.mkdirSync(themesDest, { recursive: true });
    for (const themeFile of themeFiles) {
      fs.copyFileSync(themeFile, path.join(themesDest, path.basename(themeFile)));
    }
  }
}

export function createStarterHtml(name, title, theme = 'web-ui', animation = 'slide') {
  const subtitle = '由 ai-ppt 自动生成';
  const themeClass = theme !== 'web-ui' ? ` theme-${theme}` : '';
  const animClass = animation !== 'none' ? ` anim-${animation}` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
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
</head>
<body class="${themeClass}${animClass}">
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
      <div class="help-header">
        <div class="help-title">快捷键</div>
        <div class="help-hint">按 <kbd>?</kbd> 隐藏/显示</div>
      </div>
      <div class="help-content">
        <div class="help-group">
          <div class="help-group-title">导航</div>
          <div class="help-row"><kbd>←</kbd><span>上一页</span></div>
          <div class="help-row"><kbd>→</kbd><span>下一页</span></div>
          <div class="help-row"><kbd>Cmd</kbd>+<kbd>←</kbd><span>首页</span></div>
          <div class="help-row"><kbd>Cmd</kbd>+<kbd>→</kbd><span>尾页</span></div>
        </div>
        <div class="help-group">
          <div class="help-group-title">视图</div>
          <div class="help-row"><kbd>↑</kbd><span>幻灯片预览</span></div>
          <div class="help-row"><kbd>F</kbd><span>全屏模式</span></div>
          <div class="help-row"><kbd>T</kbd><span>切换主题</span></div>
        </div>
        <div class="help-group">
          <div class="help-group-title">导出</div>
          <div class="help-row"><kbd>↓</kbd><span>导出 PDF</span></div>
          <div class="help-row"><kbd>Ctrl</kbd>+<kbd>P</kbd><span>打印/导出面板</span></div>
        </div>
      </div>
      <div class="help-footer">
        <span>全屏时：点击左侧/右侧翻页</span>
      </div>
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
  const config = defaultConfig(name, title);
  fs.writeFileSync(path.join(dir, 'index.html'), createStarterHtml(name, title || name, config.theme, config.animation), 'utf8');
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
    id: 'volc-ark-doubao-seed-2.0-lite',
    name: '火山方舟 · doubao-seed-2.0-lite',
    provider: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    model: 'doubao-seed-2.0-lite',
    note: 'OpenAI 兼容格式',
  },
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
    id: 'lmstudio',
    name: 'LM Studio (本地)',
    provider: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    note: '需要先启动 LM Studio Local Server',
  },
  {
    id: 'custom',
    name: '自定义 (远程云端)',
    provider: 'openai',
    baseUrl: '',
    model: '',
  },
];

export function defaultModelConfig() {
  return readGlobalConfig().modelConfig;
}

function defaultModel() {
  const cfg = readGlobalConfig().modelConfig;
  return cfg.model || 'qwen-max';
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
    theme: 'web-ui',
    animation: 'slide',
    status: 'draft',
    lastGeneratedAt: null,
    errorMessage: null,
  };
}

export function migrateModelConfig(cfg) {
  // Model config is now system-level. Per-project modelConfig is kept for
  // backwards compatibility but no longer used as the source of truth.
  delete cfg.modelConfig;
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
  // Sanitize: API keys must never be persisted; params.model is superseded by modelConfig.model.
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.modelConfig) delete safe.modelConfig.apiKey;
  if (safe.params) delete safe.params.model;
  fs.writeFileSync(file, JSON.stringify(safe, null, 2), 'utf8');
}

export function updateStatus(name, status, errorMessage = null) {
  const cfg = readConfig(name);
  cfg.status = status;
  if (errorMessage !== undefined) cfg.errorMessage = errorMessage;
  if (status === 'ready') cfg.lastGeneratedAt = new Date().toISOString();
  writeConfig(name, cfg);
}

export function applyThemeAndAnimation(name, theme, animation) {
  const dir = getProjectDir(name);
  const htmlPath = path.join(dir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return false;
  }

  let html = fs.readFileSync(htmlPath, 'utf8');

  // Build classes array
  const classes = [];
  if (theme && theme !== 'web-ui') {
    classes.push(`theme-${theme}`);
  }
  if (animation && animation !== 'none') {
    classes.push(`anim-${animation}`);
  }

  // Build the class string
  const classStr = classes.join(' ');

  // First, remove any existing body class
  html = html.replace(/<body\s+class="[^"]*"\s*>/g, '<body>');

  // Then add the new class if we have one
  if (classStr) {
    html = html.replace('<body>', `<body class="${classStr}">`);
  }

  fs.writeFileSync(htmlPath, html, 'utf8');
  return true;
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
