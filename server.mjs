#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  listProjects,
  createProject,
  deleteProject,
  readConfig,
  writeConfig,
  getProjectDir,
  PRESET_MODELS,
  applyThemeAndAnimation,
  defaultModelConfig,
} from './scripts/config.mjs';
import { readGlobalConfig, writeGlobalConfig } from './scripts/global-config.mjs';
import { listModels } from './scripts/llm-adapter.mjs';
import { search } from './scripts/search.mjs';
import { createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot } from './scripts/snapshot.mjs';
import { exportSingleHtml } from './scripts/export-single-html.mjs';
import { load as loadHtml } from 'cheerio';
import { injectThemeOverrides } from './scripts/theme-overrides.mjs';
import { exportPptx, exportPptxImage } from './scripts/export-pptx.mjs';
import { exportPdf } from './scripts/export-pdf.mjs';
import { saveEditedHtml } from './scripts/save-edits.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname);
const WEB_DIR = path.join(ROOT, 'web');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const PUBLISHED_DIR = path.join(ROOT, 'published');
const PORT = process.env.AI_PPT_PORT || 3456;

const generators = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
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

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function spawnGenerator(name, apiKey) {
  if (generators.has(name)) {
    const g = generators.get(name);
    if (!g.done) return g;
  }

  // Pass a session-only API key (if provided by the Web UI) to the child via
  // env. It is never written to disk; generate-deck.mjs prefers it over the
  // ambient OPENAI_API_KEY.
  const env = { ...process.env };
  if (apiKey) env.AI_PPT_API_KEY = apiKey;

  const child = spawn(process.execPath, [
    path.join(ROOT, 'scripts', 'generate-deck.mjs'),
    name,
  ], { cwd: ROOT, env });

  const state = {
    name,
    process: child,
    buffer: [],
    listeners: new Set(),
    done: false,
    error: null,
  };

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      event = { type: 'log', message: line };
    }
    state.buffer.push(event);
    state.listeners.forEach((fn) => fn(event));
  });

  child.stderr.on('data', (d) => {
    const event = { type: 'stderr', message: d.toString() };
    state.buffer.push(event);
    state.listeners.forEach((fn) => fn(event));
  });

  child.on('error', (err) => {
    state.error = err.message;
    const event = { type: 'error', message: err.message };
    state.buffer.push(event);
    state.listeners.forEach((fn) => fn(event));
    state.done = true;
  });

  child.on('close', (code) => {
    const event = code === 0
      ? { type: 'done' }
      : { type: 'error', message: `生成进程退出码 ${code}` };
    state.buffer.push(event);
    state.listeners.forEach((fn) => fn(event));
    state.done = true;
    setTimeout(() => generators.delete(name), 60000);
  });

  generators.set(name, state);
  return state;
}

function serveSse(res, state) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Avoid double-ending the response: send all buffered events, then end
  // only once at the end when the generator has already finished.
  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  state.buffer.forEach(sendEvent);
  if (state.done) {
    res.end();
    return;
  }

  state.listeners.add(sendEvent);
  reqOnClose(res, () => state.listeners.delete(sendEvent));
}

function reqOnClose(reqOrRes, fn) {
  reqOrRes.on('close', fn);
  reqOrRes.on('error', fn);
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

const PROJECT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// Vault helpers (dynamic import to keep server.mjs light)
let vaultApi = null;
async function ensureVaultApi() {
  if (vaultApi) return vaultApi;
  const vaultMod = await import(path.join(ROOT, 'scripts', 'vault.mjs'));
  const linkResolverMod = await import(path.join(ROOT, 'scripts', 'link-resolver.mjs'));
  const generateFromNoteMod = await import(path.join(ROOT, 'scripts', 'generate-from-note.mjs'));
  vaultApi = {
    listNotes: vaultMod.listNotes,
    readNote: vaultMod.readNote,
    writeNote: vaultMod.writeNote,
    createNote: vaultMod.createNote,
    deleteNote: vaultMod.deleteNote,
    parseFrontMatter: vaultMod.parseFrontMatter,
    stringifyFrontMatter: vaultMod.stringifyFrontMatter,
    normalizeNoteName: vaultMod.normalizeNoteName,
    getNotePath: vaultMod.getNotePath,
    ensureVaultDirs: vaultMod.ensureVaultDirs,
    rebuildIndex: linkResolverMod.rebuildIndex,
    getNoteInfo: linkResolverMod.getNoteInfo,
    searchNotes: linkResolverMod.searchNotes,
    generateFromNote: generateFromNoteMod.generateFromNote,
  };
  return vaultApi;
}

const routes = [
  // Vault endpoints
  { method: 'GET', pattern: /^\/api\/vault\/notes$/, handler: async (_req, res) => {
    const api = await ensureVaultApi();
    api.ensureVaultDirs();
    send(res, 200, api.listNotes());
  }},
  { method: 'GET', pattern: /^\/api\/vault\/notes\/([^/]+)$/, handler: async (req, res, matches) => {
    const api = await ensureVaultApi();
    const name = decodeURIComponent(matches[1]);
    const content = api.readNote(name);
    if (content === null) return send(res, 404, { error: '笔记不存在' });
    const { frontMatter } = api.parseFrontMatter(content);
    send(res, 200, { name, content, frontMatter });
  }},
  { method: 'GET', pattern: /^\/api\/vault\/notes\/([^/]+)\/info$/, handler: async (req, res, matches) => {
    const api = await ensureVaultApi();
    const name = decodeURIComponent(matches[1]);
    try {
      // Rebuild index to get fresh backlinks
      api.rebuildIndex();
      const info = api.getNoteInfo(name);
      send(res, 200, info);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/vault\/notes$/, handler: async (req, res) => {
    const api = await ensureVaultApi();
    const body = await readBody(req);
    try {
      const notePath = api.createNote(body.name, body.content || '');
      // Rebuild index after creating
      api.rebuildIndex();
      send(res, 201, { name: body.name, path: notePath });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }},
  { method: 'PUT', pattern: /^\/api\/vault\/notes\/([^/]+)$/, handler: async (req, res, matches) => {
    const api = await ensureVaultApi();
    const name = decodeURIComponent(matches[1]);
    const body = await readBody(req);
    try {
      const notePath = api.writeNote(name, body.content);
      // Rebuild index after modifying
      api.rebuildIndex();
      send(res, 200, { name, path: notePath });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }},
  { method: 'DELETE', pattern: /^\/api\/vault\/notes\/([^/]+)$/, handler: async (req, res, matches) => {
    const api = await ensureVaultApi();
    const name = decodeURIComponent(matches[1]);
    try {
      api.deleteNote(name);
      api.rebuildIndex();
      send(res, 204, {});
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/vault\/notes\/([^/]+)\/generate-ppt$/, handler: async (req, res, matches) => {
    const api = await ensureVaultApi();
    const name = decodeURIComponent(matches[1]);
    const body = await readBody(req);
    const projectName = body.projectName || name.replace(/[^\w\u4e00-\u9fa5-]/g, '-');
    const includeLinked = body.includeLinked || false;
    
    // Spawn generator in background, similar to existing spawnGenerator
    const env = { ...process.env };
    if (body.apiKey) env.AI_PPT_API_KEY = body.apiKey;
    
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'generate-from-note.mjs'),
      name,
      projectName,
      ...(includeLinked ? ['--include-linked'] : []),
    ], { cwd: ROOT, env });
    
    const state = {
      name: projectName,
      process: child,
      buffer: [],
      listeners: new Set(),
      done: false,
      error: null,
    };
    
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        event = { type: 'log', message: line };
      }
      state.buffer.push(event);
      state.listeners.forEach((fn) => fn(event));
    });
    child.stderr.on('data', (d) => {
      const event = { type: 'stderr', message: d.toString() };
      state.buffer.push(event);
      state.listeners.forEach((fn) => fn(event));
    });
    child.on('error', (err) => {
      state.error = err.message;
      const event = { type: 'error', message: err.message };
      state.buffer.push(event);
      state.listeners.forEach((fn) => fn(event));
      state.done = true;
    });
    child.on('close', (code) => {
      const event = code === 0
        ? { type: 'done', projectName }
        : { type: 'error', message: `生成进程退出码 ${code}` };
      state.buffer.push(event);
      state.listeners.forEach((fn) => fn(event));
      state.done = true;
      setTimeout(() => generators.delete(projectName), 60000);
    });
    
    generators.set(projectName, state);
    send(res, 202, { message: '生成已启动', name: projectName });
  }},
  { method: 'GET', pattern: /^\/api\/vault\/search$/, handler: async (req, res) => {
    const api = await ensureVaultApi();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const query = url.searchParams.get('q') || '';
    try {
      const results = api.searchNotes(query);
      send(res, 200, results);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/vault\/index$/, handler: async (_req, res) => {
    const api = await ensureVaultApi();
    const index = api.rebuildIndex();
    send(res, 200, { notesCount: Object.keys(index.notes).length });
  }},
  
  { method: 'GET', pattern: /^\/api\/config$/, handler: async (_req, res) => {
    send(res, 200, readGlobalConfig());
  }},
  { method: 'POST', pattern: /^\/api\/config$/, handler: async (req, res) => {
    const body = await readBody(req);
    try {
      const cfg = writeGlobalConfig(body);
      send(res, 200, cfg);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'GET', pattern: /^\/api\/models$/, handler: async (_req, res) => {
    send(res, 200, PRESET_MODELS);
  }},
  { method: 'POST', pattern: /^\/api\/models\/list-remote$/, handler: async (req, res) => {
    const body = await readBody(req);
    try {
      const models = await listModels({
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
      });
      send(res, 200, models);
    } catch (err) {
      send(res, 200, []); // silently fail - just return empty list
    }
  }},
  { method: 'GET', pattern: /^\/api\/projects$/, handler: async (_req, res) => {
    send(res, 200, listProjects());
  }},
  { method: 'GET', pattern: /^\/api\/search$/, handler: async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const query = url.searchParams.get('q') || '';
    try {
      send(res, 200, search(query));
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects$/, handler: async (req, res) => {
    const body = await readBody(req);
    try {
      const cfg = createProject(body.name, body.title);
      send(res, 201, cfg);
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }},
  { method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)$/, handler: async (req, res, matches) => {
    try {
      deleteProject(matches[1]);
      send(res, 204, {});
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }},
  { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/config$/, handler: async (_req, res, matches) => {
    if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
    send(res, 200, readConfig(matches[1]));
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/config$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    const body = await readBody(req);
    const cfg = readConfig(name);
    if (body.sourceType !== undefined) cfg.sourceType = body.sourceType;
    if (body.sourceUrl !== undefined) cfg.sourceUrl = body.sourceUrl;
    if (body.articleText !== undefined) cfg.articleText = body.articleText;
    if (body.params) cfg.params = { ...cfg.params, ...body.params };
    if (body.modelConfig) cfg.modelConfig = { ...cfg.modelConfig, ...body.modelConfig };
    if (body.theme !== undefined) cfg.theme = body.theme;
    if (body.animation !== undefined) cfg.animation = body.animation;
    writeConfig(name, cfg); // writeConfig strips apiKey/params.model
    // Apply theme and animation to existing HTML file
    try {
      applyThemeAndAnimation(name, cfg.theme || 'web-ui', cfg.animation || 'slide');
    } catch (err) {
      // Don't fail the request if HTML update fails
      console.error('Failed to apply theme/animation:', err);
    }
    send(res, 200, readConfig(name));
  }},
  { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/snapshots$/, handler: async (_req, res, matches) => {
    if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
    send(res, 200, listSnapshots(matches[1]));
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/snapshots$/, handler: async (req, res, matches) => {
    if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
    const body = await readBody(req);
    try {
      send(res, 201, createSnapshot(matches[1], body.description || ''));
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/snapshots\/([^/]+)\/restore$/, handler: async (_req, res, matches) => {
    if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
    try {
      restoreSnapshot(matches[1], matches[2]);
      send(res, 200, { restored: matches[2] });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }},
  { method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)\/snapshots\/([^/]+)$/, handler: async (_req, res, matches) => {
    if (!projectExists(matches[1])) return send(res, 404, { error: '项目不存在' });
    try {
      deleteSnapshot(matches[1], matches[2]);
      send(res, 204, {});
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/chat$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    const body = await readBody(req);
    const instruction = (body.instruction || '').trim();
    if (!instruction) return send(res, 400, { error: '请提供修改指令' });

    const env = { ...process.env };
    if (body.apiKey) env.AI_PPT_API_KEY = body.apiKey;

    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          path.join(ROOT, 'scripts', 'chat-modify.mjs'),
          name,
          instruction,
        ], { cwd: ROOT, env });
        let lastError = '';
        child.stdout.on('data', (d) => {
          for (const line of d.toString().split('\n').filter(Boolean)) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'error') lastError = event.message;
            } catch { /* ignore */ }
          }
        });
        child.stderr.on('data', () => { /* ignore */ });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(lastError || `修改进程退出码 ${code}`));
        });
      });
      send(res, 200, { ok: true });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/save-edits$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    const body = await readBody(req);
    const html = (body.html || '').trim();
    if (!html) return send(res, 400, { error: '请提供编辑后的 HTML' });
    try {
      const record = saveEditedHtml(name, html);
      send(res, 200, record);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/generate$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    const body = await readBody(req);
    spawnGenerator(name, body.apiKey);
    send(res, 202, { message: '生成已启动', name });
  }},
  { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/generate\/events$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    const state = generators.get(name) || spawnGenerator(name);
    serveSse(res, state);
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/export\/pptx$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    try {
      const file = await exportPptx(name);
      const rel = path.relative(ROOT, file);
      send(res, 200, { file: rel, downloadUrl: '/' + rel.replace(/\\/g, '/') });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/export\/pptx-image$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    try {
      const file = await exportPptxImage(name);
      const rel = path.relative(ROOT, file);
      send(res, 200, { file: rel, downloadUrl: '/' + rel.replace(/\\/g, '/') });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/export\/pdf$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    try {
      const result = await exportPdf(name);
      if (result.fallback) {
        send(res, 200, { fallback: true, message: result.message });
      } else {
        const rel = path.relative(ROOT, result.file);
        send(res, 200, { file: rel, downloadUrl: '/' + rel.replace(/\\/g, '/') });
      }
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/export\/html$/, handler: async (_req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    try {
      const file = await exportSingleHtml(name);
      const rel = path.relative(ROOT, file);
      send(res, 200, { file: rel, downloadUrl: '/' + rel.replace(/\\/g, '/') });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/component$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    const body = await readBody(req);
    const componentHtml = (body.html || '').trim();
    if (!componentHtml) return send(res, 400, { error: '请提供组件 HTML' });
    try {
      insertComponent(name, componentHtml);
      send(res, 200, { ok: true });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/theme-overrides$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    const body = await readBody(req);
    try {
      applyThemeOverrides(name, body.overrides || {});
      send(res, 200, { ok: true });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  // Publish endpoints
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/publish$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    try {
      const result = await publishProject(name);
      send(res, 201, result);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }},
  { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/publish$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    const history = getPublishHistory(name);
    send(res, 200, history);
  }},
  { method: 'GET', pattern: /^\/api\/published$/, handler: async (req, res) => {
    const list = listPublishedProjects();
    send(res, 200, list);
  }},
];

function projectExists(name) {
  return fs.existsSync(getProjectDir(name));
}

// Insert a component slide before the last slide (usually the thank-you page).
function insertComponent(name, componentHtml) {
  const htmlPath = path.join(getProjectDir(name), 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error('项目尚未生成幻灯片');
  }
  const $ = loadHtml(fs.readFileSync(htmlPath, 'utf8'));
  const slides = $('main.stage section.slide');
  if (slides.length === 0) {
    throw new Error('未找到幻灯片结构');
  }

  let section = componentHtml;
  if (!/class="[^"]*slide/.test(section)) {
    section = `<section class="slide">${section}</section>`;
  }

  if (slides.length > 1) {
    $(slides[slides.length - 1]).before('\n' + section + '\n');
  } else {
    $('main.stage').append('\n' + section + '\n');
  }

  // Keep exactly the first slide active
  $('main.stage section.slide').removeClass('active');
  $('main.stage section.slide').first().addClass('active');

  fs.writeFileSync(htmlPath, $.html(), 'utf8');
}

// Inject/replace a <style id="theme-overrides"> block that overrides CSS variables.
function applyThemeOverrides(name, overrides) {
  const htmlPath = path.join(getProjectDir(name), 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error('项目尚未生成幻灯片');
  }
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = injectThemeOverrides(html, overrides);
  fs.writeFileSync(htmlPath, html, 'utf8');

  // Persist overrides in config so they survive regeneration flows
  const cfg = readConfig(name);
  cfg.themeOverrides = overrides;
  writeConfig(name, cfg);
}

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
          send(res, 500, { error: err.message });
        });
      }
    }

    // Static files under /projects/<name>/
    const projectMatch = pathname.match(/^\/projects\/([^/]+)\/(.*)$/);
    if (projectMatch) {
      const [, name, sub] = projectMatch;
      if (!PROJECT_NAME_RE.test(name)) {
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
      if (!PROJECT_NAME_RE.test(name)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const dir = path.join(PUBLISHED_DIR, name, version);
      if (fs.existsSync(dir)) {
        return serveStatic(req, res, dir, sub || 'index.html');
      }
    }

    // Static web assets
    return serveStatic(req, res, WEB_DIR, pathname === '/' ? 'index.html' : pathname);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDirSync(src, dst) {
  ensureDir(dst);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function getPublishHistory(name) {
  const projectPublishDir = path.join(PUBLISHED_DIR, name);
  if (!fs.existsSync(projectPublishDir)) return [];
  const entries = fs.readdirSync(projectPublishDir, { withFileTypes: true });
  const versions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'latest') continue;
    const metaPath = path.join(projectPublishDir, entry.name, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        versions.push(meta);
      } catch {
        // skip invalid meta
      }
    }
  }
  versions.sort((a, b) => {
    const va = parseInt(a.version.replace('v', ''), 10);
    const vb = parseInt(b.version.replace('v', ''), 10);
    return vb - va;
  });
  return versions;
}

function listPublishedProjects() {
  if (!fs.existsSync(PUBLISHED_DIR)) return [];
  const entries = fs.readdirSync(PUBLISHED_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const history = getPublishHistory(entry.name);
    projects.push({
      name: entry.name,
      latest: history[0] || null,
      versions: history.length,
    });
  }
  return projects;
}

async function publishProject(name) {
  const cfg = readConfig(name);
  const projectDir = getProjectDir(name);
  if (!fs.existsSync(path.join(projectDir, 'index.html'))) {
    throw new Error('项目尚未生成幻灯片，请先生成再发布');
  }

  ensureDir(PUBLISHED_DIR);
  const projectPublishDir = path.join(PUBLISHED_DIR, name);
  ensureDir(projectPublishDir);

  const history = getPublishHistory(name);
  const nextVersionNum = history.length > 0
    ? parseInt(history[0].version.replace('v', ''), 10) + 1
    : 1;
  const version = `v${nextVersionNum}`;
  const versionDir = path.join(projectPublishDir, version);
  const latestDir = path.join(projectPublishDir, 'latest');

  // Copy to version dir
  copyDirSync(projectDir, versionDir);

  // Write meta
  const meta = {
    version,
    publishedAt: new Date().toISOString(),
    theme: cfg.theme || 'web-ui',
    animation: cfg.animation || 'slide',
    url: `/published/${name}/${version}/index.html`,
  };
  fs.writeFileSync(path.join(versionDir, 'meta.json'), JSON.stringify(meta, null, 2));

  // Update latest symlink/copy
  if (fs.existsSync(latestDir)) {
    if (fs.lstatSync(latestDir).isSymbolicLink()) {
      fs.unlinkSync(latestDir);
    } else {
      fs.rmSync(latestDir, { recursive: true, force: true });
    }
  }
  try {
    // Try symlink first
    fs.symlinkSync(version, latestDir, 'dir');
  } catch {
    // Fallback to copy on Windows or when symlink fails
    copyDirSync(versionDir, latestDir);
  }

  // Also update latest meta
  fs.writeFileSync(path.join(latestDir, 'meta.json'), JSON.stringify({
    ...meta,
    version: 'latest',
    url: `/published/${name}/latest/index.html`,
  }, null, 2));

  return meta;
}

server.listen(PORT, () => {
  console.log(`ai-ppt web server running at http://localhost:${PORT}`);
});
