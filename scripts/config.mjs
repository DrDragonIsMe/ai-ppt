#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlobalConfig } from './global-config.mjs';
import { wrapSlides, buildBodyClass, escapeHtml } from './generation-common.mjs';
import { injectThemeOverrides } from './theme-overrides.mjs';
import { writeFileAtomic, writeJsonAtomic } from './fs-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const BASE_DIR = path.join(ROOT, 'ai-ppt-base');
const BASE_CSS = path.join(BASE_DIR, 'css', 'ppt.css');
const BASE_JS = path.join(BASE_DIR, 'js', 'ppt.js');
const BASE_README = path.join(BASE_DIR, 'README.md');
const BASE_THEMES_DIR = path.join(BASE_DIR, 'css', 'themes');
const TEMPLATES_DIR = path.join(ROOT, 'templates');

export const ROOT_DIR = ROOT;
export const PROJECTS_ROOT = PROJECTS_DIR;

// ---- 名称校验（统一数据源） ----

// 通用安全名称：拒绝路径穿越和控制字符，允许中文、空格、点等
export function isSafeName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (/[/\\]/.test(name) || name.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  if ((/[\x00-\x1f\x7f]/.test(name))) return false;
  return true;
}

// 笔记名称：允许专题路径（如 "产品方法论/需求分析"），但拒绝路径穿越和非法字符
export function isSafeNoteName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.includes('..') || /[\\:*?"<>|]/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if ((/[\x00-\x1f\x7f]/.test(name))) return false;
  // 不允许空段、不允许以 / 开头或结尾
  const segments = name.split('/');
  if (segments.some((s) => !s.trim())) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  return true;
}

// 项目名称：仅允许字母、数字、中文、下划线、中划线
const PROJECT_NAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/;
export function isSafeProjectName(name) {
  return typeof name === 'string' && name.length > 0 && PROJECT_NAME_RE.test(name);
}

// 项目名校验：拒绝路径穿越
export function assertSafeProjectName(name) {
  if (!isSafeName(name)) {
    throw new Error(`非法项目名：${name}`);
  }
}

// 项目名清洗：非法字符替换为 -
export function sanitizeProjectName(name) {
  return name.replace(/[^\w\u4e00-\u9fa5-]/g, '-');
}

export function getThemeFiles() {
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
        sourceType: cfg.sourceType || null,
        sourceSelection: cfg.sourceSelection || null,
      };
    });
}

// 查找与指定笔记/专题绑定的项目（PPT-笔记双向同步）
// sourceKind: 'note' | 'topic' | 'selection'
export function findProjectsBySource(sourceKind, sourceKey) {
  ensureProjectsDir();
  const results = [];
  for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfg = readConfig(entry.name);
    const ss = cfg.sourceSelection;
    let matched = false;
    if (sourceKind === 'note' && ss?.kind === 'note') {
      matched = ss.noteName === sourceKey;
    } else if (sourceKind === 'topic' && ss?.kind === 'topic') {
      matched = ss.topicPath === sourceKey;
    }
    if (matched) results.push({ name: entry.name, ...cfg });
  }
  return results;
}

export function getProjectDir(name) {
  return path.join(PROJECTS_DIR, name);
}

export function projectExists(name) {
  return fs.existsSync(getProjectDir(name));
}

// 递归复制目录（cp -r 风格），用于复制 css/components/ 等子目录。
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

// 把基座引擎（ppt.css + css/components/* + css/themes/* + ppt.js）复制到目标目录。
// 唯一实现：config.mjs 的 ensureBaseEngine 与 upgrade-decks.mjs 都走这里。
// 返回 { themeCount, componentCount } 供调用方打印日志。
export function copyBaseEngine(dir) {
  const themeFiles = getThemeFiles();

  fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.copyFileSync(BASE_CSS, path.join(dir, 'css', 'ppt.css'));
  fs.copyFileSync(BASE_JS, path.join(dir, 'js', 'ppt.js'));

  // 复制 components/ 目录（模块化 CSS 组件）
  const baseComponentsDir = path.join(BASE_DIR, 'css', 'components');
  let componentCount = 0;
  if (fs.existsSync(baseComponentsDir)) {
    componentCount = copyDirRecursive(
      baseComponentsDir,
      path.join(dir, 'css', 'components'),
    );
  }

  if (themeFiles.length > 0) {
    const themesDest = path.join(dir, 'css', 'themes');
    fs.mkdirSync(themesDest, { recursive: true });
    for (const themeFile of themeFiles) {
      fs.copyFileSync(themeFile, path.join(themesDest, path.basename(themeFile)));
    }
  }
  return { themeCount: themeFiles.length, componentCount };
}

export function ensureBaseEngine(name) {
  copyBaseEngine(getProjectDir(name));
}

// 生成管线的落盘步骤：建目录 → 复制基座引擎 → wrapSlides → （可选）主题覆盖 → 原子写入 index.html
export function writeDeckIndex(name, slidesHtml, { title, bodyClass, themeOverrides = null }) {
  const dir = getProjectDir(name);
  fs.mkdirSync(dir, { recursive: true });
  ensureBaseEngine(name);
  let html = wrapSlides(slidesHtml, title, bodyClass);
  if (themeOverrides && Object.keys(themeOverrides).length > 0) {
    html = injectThemeOverrides(html, themeOverrides);
  }
  writeFileAtomic(path.join(dir, 'index.html'), html);
  return html;
}

export function createStarterHtml(name, title, theme = 'web-ui', animation = 'slide') {
  const brandName = readGlobalConfig().appConfig?.brandName || '小龙哥@薪灵AI';
  const subtitle = `由 ${brandName} 自动生成`;
  const bodyClass = buildBodyClass({ theme, animation });
  const slidesHtml = `      <section class="slide active">
        <div class="slide-content" style="text-align: center;">
          <div class="kicker">AI 生成</div>
          <h1>${escapeHtml(title)}</h1>
          <p class="lead">${escapeHtml(subtitle)}</p>
          <p style="font-size: 16px; opacity: 0.55; margin-top: 40px;">点击"生成幻灯片"开始</p>
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
`;
  return wrapSlides(slidesHtml, title || name || brandName, bodyClass);
}

export function createProject(name, title, template = null) {
  ensureProjectsDir();
  if (!isSafeProjectName(name)) {
    throw new Error('项目名称只能包含字母、数字、中文、下划线和中划线');
  }
  const dir = getProjectDir(name);
  if (fs.existsSync(dir)) {
    throw new Error(`项目 ${name} 已存在`);
  }
  // 模板先校验再落盘，非法/不存在的模板不残留项目目录
  const tplDir = template ? resolveTemplateDir(template) : null;
  fs.mkdirSync(dir, { recursive: true });
  ensureBaseEngine(name);
  fs.copyFileSync(BASE_README, path.join(dir, 'README.md'));
  if (tplDir) {
    fs.copyFileSync(path.join(tplDir, 'index.html'), path.join(dir, 'index.html'));
    let config;
    const tplCfgPath = path.join(tplDir, 'ai-ppt.json');
    if (fs.existsSync(tplCfgPath)) {
      try {
        config = JSON.parse(fs.readFileSync(tplCfgPath, 'utf8'));
      } catch {
        config = defaultConfig(name, title);
      }
    } else {
      config = defaultConfig(name, title);
    }
    config.name = name;
    if (title) config.params = { ...(config.params || {}), title };
    writeConfig(name, config);
    return config;
  }
  const config = defaultConfig(name, title);
  writeFileAtomic(path.join(dir, 'index.html'), createStarterHtml(name, title || name, config.theme, config.animation));
  writeConfig(name, config);
  return config;
}

// 场景模板：templates/<id>/（index.html 必备，ai-ppt.json 可选）
export function listTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(TEMPLATES_DIR, e.name, 'index.html')))
    .map((e) => e.name)
    .sort();
}

function resolveTemplateDir(id) {
  if (!isSafeName(id)) {
    throw new Error(`非法模板标识：${id}`);
  }
  const dir = path.join(TEMPLATES_DIR, id);
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    throw new Error(`模板 ${id} 不存在`);
  }
  return dir;
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
  writeJsonAtomic(file, safe);
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

  // Build classes array — theme class is always written (including the default
  // web-ui) so ppt.js initThemes can tell "configured as web-ui" apart from
  // "no theme info" and not fall back to a stale localStorage theme.
  const classes = [];
  classes.push(`theme-${theme || 'web-ui'}`);
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

  writeFileAtomic(htmlPath, html);
  return true;
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
