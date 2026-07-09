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
} from './scripts/config.mjs';
import { exportPptx, exportPptxImage } from './scripts/export-pptx.mjs';
import { exportPdf } from './scripts/export-pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname);
const WEB_DIR = path.join(ROOT, 'web');
const PROJECTS_DIR = path.join(ROOT, 'projects');
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

function spawnGenerator(name) {
  if (generators.has(name)) {
    const g = generators.get(name);
    if (!g.done) return g;
  }

  const child = spawn(process.execPath, [
    path.join(ROOT, 'scripts', 'generate-deck.mjs'),
    name,
  ], { cwd: ROOT });

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

  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done' || event.type === 'error') {
      res.end();
    }
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

const routes = [
  { method: 'GET', pattern: /^\/api\/projects$/, handler: async (_req, res) => {
    send(res, 200, listProjects());
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
    writeConfig(name, cfg);
    send(res, 200, cfg);
  }},
  { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/generate$/, handler: async (req, res, matches) => {
    const name = matches[1];
    if (!projectExists(name)) return send(res, 404, { error: '项目不存在' });
    spawnGenerator(name);
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
];

function projectExists(name) {
  return fs.existsSync(getProjectDir(name));
}

function serveStatic(req, res, root, urlPath) {
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
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
      const dir = getProjectDir(name);
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

server.listen(PORT, () => {
  console.log(`ai-ppt web server running at http://localhost:${PORT}`);
});
