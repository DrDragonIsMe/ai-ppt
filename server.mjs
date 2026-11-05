#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  listProjects,
  findProjectsBySource,
  createProject,
  deleteProject,
  readConfig,
  writeConfig,
  getProjectDir,
  PRESET_MODELS,
  applyThemeAndAnimation,
  defaultModelConfig,
  isSafeName,
  isSafeNoteName,
  isSafeProjectName,
} from './scripts/config.mjs';
import { readGlobalConfig, writeGlobalConfig } from './scripts/global-config.mjs';
import { listModels, generateSlides } from './scripts/llm-adapter.mjs';
import { search, buildSearchIndex, invalidateSearchIndex } from './scripts/search.mjs';
import { createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot } from './scripts/snapshot.mjs';
import { exportSingleHtml } from './scripts/export-single-html.mjs';
import { load as loadHtml } from 'cheerio';
import { injectThemeOverrides } from './scripts/theme-overrides.mjs';
import { saveEditedHtml } from './scripts/save-edits.mjs';
import { buildGraph, readGraph } from './scripts/knowledge-graph.mjs';
import { getCards, loadCard, saveCard, deleteCard, recordReview, getDueCards, loadMastery, saveMastery } from './scripts/knowledge-cards.mjs';
import { getExamPapers, getExamPaper, saveExamPaper, deleteExamPaper, getExamStats, getMistakes, getMistake, saveMistake, deleteMistake, recordMistakeReview, getMistakeStats, addMistakeFromExam, buildSmartExam } from './scripts/exam-papers.mjs';
import { listFragments, getFragment, createFragment, updateFragment, deleteFragment } from './scripts/fragments.mjs';
import { buildOrganizeSuggestions, applyOrganizeActions } from './scripts/organize.mjs';
import { generateImage, generateVideo, probeMediaProvider } from './scripts/media-gen.mjs';
import { runBackup } from './scripts/backup.mjs';
import { pruneVaultBackups } from './scripts/vault.mjs';
import { createTaskRegistry, pushBounded, NDJSON_BUFFER_CAP } from './scripts/task-registry.mjs';
import { cleanupOrphanTmpParts } from './scripts/multipart.mjs';
import { randomUUID } from 'node:crypto';
import configRoutes from './routes/config.mjs';
import mediaRoutes from './routes/media.mjs';
import vaultRoutes from './routes/vault.mjs';
import projectRoutes from './routes/projects.mjs';
import agentRoutes from './routes/agent.mjs';
import sourcesRoutes from './routes/sources.mjs';
import marketingRoutes from './routes/marketing.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname);
const WEB_DIR = path.join(ROOT, 'web');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const PUBLISHED_DIR = path.join(ROOT, 'published');
const BASE_DIR = path.join(ROOT, 'ai-ppt-base');
const PORT = process.env.AI_PPT_PORT || 3456;
// 默认只绑定回环地址，避免本机服务直接暴露到局域网；如需局域网访问设 AI_PPT_HOST=0.0.0.0
const HOST = process.env.AI_PPT_HOST || '127.0.0.1';

const generators = new Map();
// 对话式修改（chat）任务状态，结构与 generators 相同，相互独立
const chats = new Map();
// 笔记 AI 对话修改任务状态（契约 O），与项目 chats 相互独立
const noteChats = new Map();
// 导出任务状态（键 `${name}:${type}`），路由实现见 routes/projects.mjs
const exportTasks = new Map();
// 素材源刷新任务状态（键 sourceId），NDJSON 子进程，路由实现见 routes/sources.mjs
const sourceRefreshes = new Map();
// 营销大纲生成 / 批量 deck 生成任务状态（键固定 'current'：全局各允许一个在跑任务），
// NDJSON 子进程，路由实现见 routes/marketing.mjs
const marketingOutlines = new Map();
const marketingBatches = new Map();
// 统一任务注册表：媒体/解析任务状态 + NDJSON 任务元信息，内存 Map + 落盘持久化。
// 服务重启后所有活跃任务被标记 interrupted，轮询/SSE 端点据此返回明确错误。
const taskRegistry = createTaskRegistry({ filePath: path.join(ROOT, '.ai-ppt-tasks.json') });
taskRegistry.load();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// Load .env.kimi (gitignored) at startup so LLM keys are available to the
// generator child process via env inheritance. Never overrides existing env.
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env.kimi');
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // ignore env file read errors
  }
}
loadEnvFile();

function send(res, status, data, type = 'application/json') {
  // 204 No Content must not carry a body
  if (status === 204) {
    res.writeHead(204);
    return res.end();
  }
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(data);
  });
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 默认请求体上限 10MB

// maxBytes 可按路由放宽（如音视频资产上传），超限行为不变
async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (d) => {
      if (tooLarge) return;
      size += d.length;
      if (size > maxBytes) {
        tooLarge = true;
        const err = new Error(`请求体超过大小限制（${Math.round(maxBytes / 1024 / 1024)}MB）`);
        err.statusCode = 413;
        reject(err);
        req.resume(); // 丢弃剩余数据，避免连接挂起
        return;
      }
      body += d;
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        e.statusCode = 400;
        e.message = '请求体不是合法 JSON';
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// NDJSON 任务 store → 任务注册表 kind（元信息持久化，重启后可识别 interrupted 任务）
const NDJSON_STORE_KINDS = new Map([
  [generators, 'generate'],
  [chats, 'chat'],
  [noteChats, 'note-chat'],
  [exportTasks, 'export'],
  [sourceRefreshes, 'source-refresh'],
  [marketingOutlines, 'marketing-outline'],
  [marketingBatches, 'marketing-batch'],
]);

// 通用 NDJSON 子进程任务：逐行解析 stdout 事件存入 buffer 并推送给 SSE 监听者。
// store 为任务状态 Map（generators / chats），name 为状态键（通常是项目名）。
// Pass a session-only API key (if provided by the Web UI) to the child via
// env. It is never written to disk; child scripts prefer it over the
// ambient OPENAI_API_KEY.
function spawnNdjsonTask(store, name, script, args, apiKey) {
  // 同名任务覆盖旧 state 前：向旧 SSE 连接推错误事件并关闭，避免旧连接静默失效
  const prev = store.get(name);
  if (prev) {
    const ev = { type: 'error', message: '任务已被新任务取代' };
    prev.listeners.forEach((fn) => { try { fn(ev); } catch { /* 连接可能已断开 */ } });
    prev.listeners.clear();
    prev.done = true;
    try { prev.process?.kill?.(); } catch { /* 进程可能已退出 */ }
  }

  const env = { ...process.env };
  if (apiKey) env.AI_PPT_API_KEY = apiKey;

  const child = spawn(process.execPath, [
    path.join(ROOT, 'scripts', script),
    ...args,
  ], { cwd: ROOT, env });

  const state = {
    name,
    process: child,
    buffer: [],
    listeners: new Set(),
    done: false,
    error: null,
  };

  // 元信息写入任务注册表（kind/name/status/起止时间），供重启恢复识别
  const kind = NDJSON_STORE_KINDS.get(store) || 'ndjson';
  const metaId = `ndjson:${kind}:${name}`;
  taskRegistry.create(metaId, { kind, name, status: 'running', startedAt: new Date().toISOString() });

  const pushEvent = (event) => {
    pushBounded(state.buffer, event, NDJSON_BUFFER_CAP);
    state.listeners.forEach((fn) => fn(event));
  };

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      event = { type: 'log', message: line };
    }
    pushEvent(event);
  });

  child.stderr.on('data', (d) => {
    pushEvent({ type: 'stderr', message: d.toString() });
  });

  child.on('error', (err) => {
    state.error = err.message;
    pushEvent({ type: 'error', message: err.message });
    state.done = true;
  });

  child.on('close', (code) => {
    // 脚本自己输出过 done/error 终态事件时不再重复补发
    const last = state.buffer[state.buffer.length - 1];
    const alreadyFinal = last && (last.type === 'done' || last.type === 'error');
    if (!alreadyFinal) {
      pushEvent(code === 0
        ? { type: 'done' }
        : { type: 'error', message: `进程退出码 ${code}` });
    }
    state.done = true;
    const finalEvent = state.buffer[state.buffer.length - 1];
    if (finalEvent && finalEvent.type === 'error') {
      taskRegistry.fail(metaId, finalEvent.message || '任务失败');
    } else {
      taskRegistry.complete(metaId);
    }
    setTimeout(() => store.delete(name), 60000);
  });

  store.set(name, state);
  return state;
}

// 重启恢复：注册表里 interrupted 的 NDJSON 任务回填为已完成（错误事件）的合成 state，
// 使 GET .../events 回放一条明确错误后收尾，而不是 404/挂起。
function restoreInterruptedNdjsonTasks() {
  for (const t of taskRegistry.list()) {
    if (t.status !== 'interrupted' || !t.name) continue;
    const store = [...NDJSON_STORE_KINDS.entries()].find(([, k]) => k === t.kind)?.[0];
    if (!store || store.has(t.name)) continue;
    const state = {
      name: t.name,
      process: null,
      buffer: [{ type: 'error', message: t.error || '服务已重启，任务中断，请重试' }],
      listeners: new Set(),
      done: true,
      error: t.error || 'interrupted',
    };
    store.set(t.name, state);
    setTimeout(() => { if (store.get(t.name) === state) store.delete(t.name); }, 60000).unref();
  }
}
restoreInterruptedNdjsonTasks();

// 是否有进行中（未完成）的任务，用于并发防护
function hasActiveTask(store, name) {
  const state = store.get(name);
  return !!(state && !state.done);
}

function spawnGenerator(name, apiKey) {
  if (hasActiveTask(generators, name)) return generators.get(name);
  return spawnNdjsonTask(generators, name, 'generate-deck.mjs', [name], apiKey);
}

function serveSse(res, state) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // 已结束的任务只需回放完整 buffer 后收尾
  if (state.done) {
    for (const event of state.buffer) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
    return;
  }

  // sentCount 记录已推送的 buffer 事件数，用于回放与实时推送之间去重
  let sentCount = 0;
  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    sentCount++;
  };

  // 先注册 listener 再回放 buffer，避免注册前到达的事件丢失；
  // listener 触发时已计入 sentCount，回放时自动跳过不重复推送
  state.listeners.add(sendEvent);
  while (sentCount < state.buffer.length) {
    sendEvent(state.buffer[sentCount]);
  }

  // 25 秒心跳（SSE 注释行），防止中间代理因长时间无数据断连
  const heartbeat = setInterval(() => {
    res.write(':hb\n\n');
  }, 25000);

  reqOnClose(res, () => {
    state.listeners.delete(sendEvent);
    clearInterval(heartbeat);
  });
}

function reqOnClose(reqOrRes, fn) {
  reqOrRes.on('close', fn);
  reqOrRes.on('error', fn);
}

// PPT chat 历史（契约 P）：持久化到 projects/<name>/chat-history.json，最多保留 50 条。
// 读取/写入失败均降级（返回空数组 / 静默忽略），不影响 chat 主流程。
function readChatHistory(name) {
  try {
    const messages = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, name, 'chat-history.json'), 'utf8'));
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

function appendChatHistory(name, role, content) {
  try {
    const messages = readChatHistory(name);
    messages.push({ role, content, time: new Date().toISOString() });
    const trimmed = messages.slice(-50);
    fs.writeFileSync(path.join(PROJECTS_DIR, name, 'chat-history.json'), JSON.stringify(trimmed, null, 2));
  } catch (err) {
    console.error('chat 历史写入失败:', err);
  }
}

// Confine a resolved path under its root to prevent path traversal (../).
function isWithinRoot(rootPath, relPath) {
  const root = path.resolve(rootPath);
  // Strip leading slashes: path.resolve(root, '/x') treats '/x' as filesystem-absolute,
  // which would both break legit assets like /css/x and bypass '..' confinement.
  const rel = String(relPath).replace(/^\/+/, '');
  const target = path.resolve(root, rel);
  return target === root || target.startsWith(root + path.sep);
}

// PROJECT_NAME_RE 已迁移到 config.mjs 的 isSafeProjectName()

// isSafeName 现在从 config.mjs 导入（统一数据源）

// Validate a route/body name; sends 400 and returns false when invalid.
function validName(name, res, error = '非法名称') {
  if (!isSafeName(name)) {
    send(res, 400, { error });
    return false;
  }
  return true;
}

// Validate a note name (supports topic paths like "topic/note")
function validNoteName(name, res, error = '非法笔记名称') {
  if (!isSafeNoteName(name)) {
    send(res, 400, { error });
    return false;
  }
  return true;
}

// 多模态模型配置默认值（契约 E）：空 model 表示使用 CLI 默认模型
const DEFAULT_MEDIA_MODEL_CONFIG = { provider: 'arkcli', model: '' };

// presentGlobalConfig → routes/config.mjs

// resolveMediaTarget → routes/media.mjs

// Vault helpers (dynamic import to keep server.mjs light)
let vaultApi = null;
async function ensureVaultApi() {
  if (vaultApi) return vaultApi;
  const vaultMod = await import(path.join(ROOT, 'scripts', 'vault.mjs'));
  const linkResolverMod = await import(path.join(ROOT, 'scripts', 'link-resolver.mjs'));
  const generateFromNoteMod = await import(path.join(ROOT, 'scripts', 'generate-from-note.mjs'));
  const generateReportMod = await import(path.join(ROOT, 'scripts', 'generate-report.mjs'));
  vaultApi = {
    listNotes: vaultMod.listNotes,
    listTopics: vaultMod.listTopics,
    readNote: vaultMod.readNote,
    writeNote: vaultMod.writeNote,
    createNote: vaultMod.createNote,
    deleteNote: vaultMod.deleteNote,
    renameNote: vaultMod.renameNote,
    createTopic: vaultMod.createTopic,
    deleteTopic: vaultMod.deleteTopic,
    renameTopic: vaultMod.renameTopic,
    readTopicMeta: vaultMod.readTopicMeta,
    writeTopicMeta: vaultMod.writeTopicMeta,
    syncNoteTopicField: vaultMod.syncNoteTopicField,
    parseFrontMatter: vaultMod.parseFrontMatter,
    stringifyFrontMatter: vaultMod.stringifyFrontMatter,
    normalizeNoteName: vaultMod.normalizeNoteName,
    getNotePath: vaultMod.getNotePath,
    ensureVaultDirs: vaultMod.ensureVaultDirs,
    rebuildIndex: linkResolverMod.rebuildIndex,
    getNoteInfo: linkResolverMod.getNoteInfo,
    searchNotes: linkResolverMod.searchNotes,
    findUnlinkedMentions: linkResolverMod.findUnlinkedMentions,
    linkMentions: linkResolverMod.linkMentions,
    getAllTags: linkResolverMod.getAllTags,
    runQuery: linkResolverMod.runQuery,
    generateFromNote: generateFromNoteMod.generateFromNote,
    generateReport: generateReportMod.generateReport,
  };
  return vaultApi;
}

// 删除/覆盖笔记前自动备份原文件到 .snapshots/_vault/<时间戳>/，失败只告警不阻断
function backupVaultNote(api, name) {
  try {
    const src = api.getNotePath(name);
    if (!fs.existsSync(src)) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(ROOT, '.snapshots', '_vault', ts);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, path.basename(src)));
    pruneVaultBackups();
  } catch (err) {
    console.error('笔记自动备份失败:', err);
  }
}

// 三组模型配置对外呈现（供 configRoutes 使用）
function presentGlobalConfigFn(cfg) {
  const strip = (group, fallback) => {
    const { apiKey, ...rest } = group || fallback;
    if (apiKey) rest.apiKeySet = true;
    return rest;
  };
  return {
    appConfig: {
      brandName: cfg.appConfig?.brandName || '小龙哥@薪灵AI',
    },
    agentConfig: {
      assistantName: cfg.agentConfig?.assistantName || '薪小灵',
      responseStyle: cfg.agentConfig?.responseStyle === 'detailed' ? 'detailed' : 'concise',
      allowSettingsMutation: cfg.agentConfig?.allowSettingsMutation !== false,
      allowKnowledgeMutation: cfg.agentConfig?.allowKnowledgeMutation !== false,
    },
    modelConfig: strip(cfg.modelConfig, {}),
    imageModelConfig: strip(cfg.imageModelConfig, DEFAULT_MEDIA_MODEL_CONFIG),
    videoModelConfig: strip(cfg.videoModelConfig, DEFAULT_MEDIA_MODEL_CONFIG),
    pdfConfig: cfg.pdfConfig || { defaultEngine: 'puppeteer' },
  };
}

// ---- 路由模块依赖装配（DI）----
// 每个路由工厂一个命名 deps 对象（禁止位置传参），启动时用 assertDeps 校验必需键，
// 缺依赖直接报清晰错误，而不是运行期 undefined。
function assertDeps(moduleName, deps, required) {
  const missing = required.filter((k) => deps[k] === undefined);
  if (missing.length) {
    throw new Error(`[server] 路由模块 ${moduleName} 缺少依赖: ${missing.join(', ')}`);
  }
}

// vault（知识库：笔记/碎片/资产/学习/星图，按域拆分于 routes/vault-*.mjs）
const vaultDeps = {
  // 基础工具
  send, readBody, validName, validNoteName, sendFile, ROOT,
  ensureVaultApi, backupVaultNote,
  listProjects, findProjectsBySource,
  // NDJSON 任务
  hasActiveTask, spawnNdjsonTask, serveSse,
  generators, noteChats,
  // 学习域（卡片/测验/错题）
  getCards, loadCard, saveCard, deleteCard, recordReview, getDueCards,
  getExamPapers, getExamPaper, saveExamPaper, deleteExamPaper, getExamStats,
  getMistakes, getMistake, saveMistake, deleteMistake, recordMistakeReview,
  getMistakeStats, addMistakeFromExam, buildSmartExam,
  // 碎片域
  listFragments, getFragment, createFragment, updateFragment, deleteFragment,
  buildOrganizeSuggestions, applyOrganizeActions,
  // 星图/搜索/多笔记生成
  buildGraph, readGraph, generateSlides,
  readGlobalConfig, DEFAULT_MEDIA_MODEL_CONFIG, ensureDir, randomUUID,
  generateVideo, taskRegistry,
};
assertDeps('vault', vaultDeps, [
  'send', 'readBody', 'validName', 'validNoteName', 'sendFile', 'ROOT',
  'ensureVaultApi', 'backupVaultNote',
  'listProjects', 'findProjectsBySource',
  'hasActiveTask', 'spawnNdjsonTask', 'serveSse',
  'generators', 'noteChats',
  'getCards', 'loadCard', 'saveCard', 'deleteCard', 'recordReview', 'getDueCards',
  'getExamPapers', 'getExamPaper', 'saveExamPaper', 'deleteExamPaper', 'getExamStats',
  'getMistakes', 'getMistake', 'saveMistake', 'deleteMistake', 'recordMistakeReview',
  'getMistakeStats', 'addMistakeFromExam', 'buildSmartExam',
  'listFragments', 'getFragment', 'createFragment', 'updateFragment', 'deleteFragment',
  'buildOrganizeSuggestions', 'applyOrganizeActions',
  'buildGraph', 'readGraph', 'generateSlides',
  'readGlobalConfig', 'DEFAULT_MEDIA_MODEL_CONFIG', 'ensureDir', 'randomUUID',
  'generateVideo', 'taskRegistry',
]);

// config（模型配置）
const configDeps = {
  send, readBody, presentGlobalConfig: presentGlobalConfigFn,
  readGlobalConfig, writeGlobalConfig, PRESET_MODELS, listModels,
};
assertDeps('config', configDeps, [
  'send', 'readBody', 'presentGlobalConfig',
  'readGlobalConfig', 'writeGlobalConfig', 'PRESET_MODELS', 'listModels',
]);

// media（图片/视频生成与任务轮询 + 统一生成矩阵）
const mediaDeps = {
  send, readBody, validName, isSafeNoteName, ensureVaultApi, DEFAULT_MEDIA_MODEL_CONFIG,
  ensureDir, randomUUID, generateImage, generateVideo, probeMediaProvider,
  taskRegistry, ROOT, projectExists, getProjectDir,
};
assertDeps('media', mediaDeps, [
  'send', 'readBody', 'validName', 'isSafeNoteName', 'ensureVaultApi', 'DEFAULT_MEDIA_MODEL_CONFIG',
  'ensureDir', 'randomUUID', 'generateImage', 'generateVideo', 'probeMediaProvider',
  'taskRegistry', 'ROOT', 'projectExists', 'getProjectDir',
]);

// projects（项目 CRUD/生成/chat/导出/快照/发布）
const projectDeps = {
  send, readBody, validName, ROOT, PROJECTS_DIR, PUBLISHED_DIR,
  listProjects, createProject, deleteProject,
  readConfig, writeConfig, getProjectDir, projectExists, applyThemeAndAnimation,
  generators, chats, spawnGenerator, spawnNdjsonTask, hasActiveTask, serveSse,
  exportTasks,
  readChatHistory, appendChatHistory,
  exportSingleHtml,
  loadHtml, injectThemeOverrides, saveEditedHtml, search, invalidateSearchIndex,
  createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot,
};
assertDeps('projects', projectDeps, [
  'send', 'readBody', 'validName', 'ROOT', 'PROJECTS_DIR', 'PUBLISHED_DIR',
  'listProjects', 'createProject', 'deleteProject',
  'readConfig', 'writeConfig', 'getProjectDir', 'projectExists', 'applyThemeAndAnimation',
  'generators', 'chats', 'spawnGenerator', 'spawnNdjsonTask', 'hasActiveTask', 'serveSse',
  'exportTasks',
  'readChatHistory', 'appendChatHistory',
  'exportSingleHtml',
  'loadHtml', 'injectThemeOverrides', 'saveEditedHtml', 'search', 'invalidateSearchIndex',
  'createSnapshot', 'listSnapshots', 'restoreSnapshot', 'deleteSnapshot',
]);

// agent（薪小灵：知识检索 / 设置 / 知识库管理）
const agentDeps = {
  send, readBody, validName, validNoteName, ROOT,
  ensureVaultApi, backupVaultNote,
  readGlobalConfig, writeGlobalConfig, buildSearchIndex,
};
assertDeps('agent', agentDeps, [
  'send', 'readBody', 'validName', 'validNoteName', 'ROOT',
  'ensureVaultApi', 'backupVaultNote',
  'readGlobalConfig', 'writeGlobalConfig', 'buildSearchIndex',
]);

// sources（素材源注册表 + 抓取刷新）
const sourcesDeps = {
  send, readBody, validName, ROOT,
  spawnNdjsonTask, serveSse, hasActiveTask,
  sourceRefreshes, taskRegistry,
};
assertDeps('sources', sourcesDeps, [
  'send', 'readBody', 'validName', 'ROOT',
  'spawnNdjsonTask', 'serveSse', 'hasActiveTask',
  'sourceRefreshes', 'taskRegistry',
]);

// marketing（营销大纲 + 批量 deck 生成）
const marketingDeps = {
  send, readBody, validName, ROOT,
  spawnNdjsonTask, serveSse, hasActiveTask,
  marketingOutlines, marketingBatches, taskRegistry,
};
assertDeps('marketing', marketingDeps, [
  'send', 'readBody', 'validName', 'ROOT',
  'spawnNdjsonTask', 'serveSse', 'hasActiveTask',
  'marketingOutlines', 'marketingBatches', 'taskRegistry',
]);

// 路由表：系统路由（主题/Dashboard/备份）+ 4 个路由模块
// 约定：按数组顺序首条匹配即返回，字面量路由必须排在通配符路由之前。
const routes = [
  // 主题列表：从 themes.json 唯一数据源读取
  {
    method: 'GET', pattern: /^\/api\/themes$/, handler: async (_req, res) => {
      try {
        const themesPath = path.join(ROOT, 'ai-ppt-base', 'themes.json');
        const themes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
        send(res, 200, themes);
      } catch {
        send(res, 200, []);
      }
    }
  },
  // Dashboard（契约 K）
  {
    method: 'GET', pattern: /^\/api\/dashboard$/, handler: async (_req, res) => {
      const result = {
        todayFragments: 0, inboxFragments: 0, dueCards: 0, lowMasteryMistakes: 0,
        recentFragments: [], counts: { notes: 0, cards: 0, exams: 0, mistakes: 0, projects: 0 },
      };
      try {
        const fragments = listFragments();
        const today = new Date().toLocaleDateString('sv');
        result.todayFragments = fragments.filter((f) => {
          if (!f.created) return false;
          const d = new Date(f.created);
          return !Number.isNaN(d.getTime()) && d.toLocaleDateString('sv') === today;
        }).length;
        result.inboxFragments = fragments.filter((f) => f.status === 'inbox').length;
        result.recentFragments = fragments.slice(0, 10);
      } catch { /* 碎片数据降级 */ }
      try { result.dueCards = getDueCards().length; } catch { /* 卡片数据降级 */ }
      try {
        const mistakes = getMistakes();
        result.lowMasteryMistakes = mistakes.filter((m) => (m.mastery || 0) <= 2).length;
        result.counts.mistakes = mistakes.length;
      } catch { /* 错题数据降级 */ }
      try { result.counts.cards = getCards().length; } catch { /* 卡片计数降级 */ }
      try { result.counts.exams = getExamPapers().length; } catch { /* 测验计数降级 */ }
      try { const api = await ensureVaultApi(); result.counts.notes = api.listNotes().length; } catch { /* 笔记计数降级 */ }
      try { result.counts.projects = listProjects().length; } catch { /* 项目计数降级 */ }
      send(res, 200, result);
    }
  },
  // 手动备份（契约 Q）
  {
    method: 'POST', pattern: /^\/api\/backup$/, handler: async (_req, res) => {
      try { send(res, 200, { dir: runBackup('manual') }); }
      catch (err) { send(res, err.statusCode || 500, { error: err.message }); }
    }
  },
  // 路由模块：vault（知识库）、config（配置）、media（媒体）、projects（项目）
  ...vaultRoutes(vaultDeps),
  ...configRoutes(configDeps),
  ...mediaRoutes(mediaDeps),
  ...agentRoutes(agentDeps),
  ...projectRoutes(projectDeps),
  ...sourcesRoutes(sourcesDeps),
  ...marketingRoutes(marketingDeps),
];


function projectExists(name) {
  return fs.existsSync(getProjectDir(name));
}

// insertComponent / applyThemeOverrides → routes/projects.mjs

function serveStatic(req, res, root, urlPath) {
  // Prevent path traversal: resolved target must stay under root.
  if (!isWithinRoot(root, urlPath)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  let filePath = path.join(root, urlPath);
  const stat = fs.existsSync(filePath) && fs.statSync(filePath);
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    // SPA fallback for web routes
    if (root === WEB_DIR && !path.extname(urlPath)) {
      filePath = path.join(WEB_DIR, 'index.html');
    } else {
      res.writeHead(404);
      return res.end('Not found');
    }
  }
  sendFile(res, filePath);
}

const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    // CORS: local tool only - reflect origin for localhost browsers, deny others.
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN_RE.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const matches = pathname.match(route.pattern);
      if (matches) {
        return route.handler(req, res, matches).catch((err) => {
          console.error(err);
          send(res, err.statusCode || 500, { error: err.message });
        });
      }
    }

    // Static files under /projects/<name>/
    const projectMatch = pathname.match(/^\/projects\/([^/]+)\/(.*)$/);
    if (projectMatch) {
      const [, name, sub] = projectMatch;
      if (!isSafeProjectName(name)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const dir = getProjectDir(name);
      if (fs.existsSync(dir)) {
        return serveStatic(req, res, dir, sub || 'index.html');
      }
    }

    // Static files under /published/<name>/<version>/
    const publishedMatch = pathname.match(/^\/published\/([^/]+)\/([^/]+)\/(.*)$/);
    if (publishedMatch) {
      const [, name, version, sub] = publishedMatch;
      if (!isSafeProjectName(name)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const dir = path.join(PUBLISHED_DIR, name, version);
      if (fs.existsSync(dir)) {
        return serveStatic(req, res, dir, sub || 'index.html');
      }
    }

    // Static base engine files（主题画廊 theme-showcase.html、themes.json 等）
    const baseMatch = pathname.match(/^\/base\/(.*)$/);
    if (baseMatch) {
      return serveStatic(req, res, BASE_DIR, baseMatch[1] || 'index.html');
    }

    // Static web assets
    return serveStatic(req, res, WEB_DIR, pathname === '/' ? 'index.html' : pathname);
  } catch (err) {
    console.error(err);
    send(res, err.statusCode || 500, { error: err.message });
  }
});

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

server.listen(PORT, HOST, () => {
  console.log(`ai-ppt web server running at http://${HOST}:${PORT}`);
  if (HOST === '127.0.0.1' || HOST === 'localhost') {
    console.log('当前仅监听本机回环地址；如需局域网访问，请设置 AI_PPT_HOST=0.0.0.0 后重启');
  }
  // 启动后异步构建搜索索引
  try { buildSearchIndex(); console.log('搜索索引已构建完成'); } catch (e) { console.error('搜索索引构建失败:', e.message); }
  // 清理 vault/assets/.tmp 下上传中断遗留的孤儿 .part 文件
  try {
    const removed = cleanupOrphanTmpParts(path.join(ROOT, 'vault', 'assets', '.tmp'));
    if (removed > 0) console.log(`已清理 ${removed} 个上传临时文件`);
  } catch (e) { console.error('清理上传临时文件失败:', e.message); }
});
