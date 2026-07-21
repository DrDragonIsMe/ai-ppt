#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const BASE = 'http://localhost:3456';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = new URL(BASE + path);
    const req = http.request({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.pathname + opts.search,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}: ${err.message}`);
  }
}

(async () => {
  const testProject = `smoke-${Date.now()}`;

  await run('create project', async () => {
    const r = await request('POST', '/api/projects', { name: testProject, title: 'Smoke Test' });
    if (r.status !== 201) throw new Error(`status ${r.status}`);
  });

  await run('get config', async () => {
    const r = await request('GET', `/api/projects/${testProject}/config`);
    if (r.status !== 200 || !r.body) throw new Error('no config');
  });

  await run('search finds new project', async () => {
    const r = await request('GET', `/api/search?q=${encodeURIComponent('Smoke')}`);
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('bad response');
    if (!r.body.some((p) => p.name === testProject)) throw new Error('project not found');
  });

  await run('generate with fallback', async () => {
    const r = await request('POST', `/api/projects/${testProject}/generate`, {});
    if (r.status !== 202) throw new Error(`status ${r.status}`);
    await new Promise((res) => setTimeout(res, 2000));
    const cfg = await request('GET', `/api/projects/${testProject}/config`);
    if (cfg.body?.status !== 'ready') throw new Error('not ready');
  });

  await run('SSE after generation', async () => {
    const r = await request('GET', `/api/projects/${testProject}/generate/events`);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
  });

  await run('create snapshot', async () => {
    const r = await request('POST', `/api/projects/${testProject}/snapshots`, { description: 'smoke' });
    if (r.status !== 201) throw new Error(`status ${r.status}`);
  });

  await run('list snapshots', async () => {
    const r = await request('GET', `/api/projects/${testProject}/snapshots`);
    if (r.status !== 200 || r.body.length !== 1) throw new Error('snapshot missing');
  });

  await run('export single html', async () => {
    const r = await request('POST', `/api/projects/${testProject}/export/html`, {});
    if (r.status !== 200 || !r.body?.downloadUrl) throw new Error('no download url');
    const file = path.join(ROOT, r.body.downloadUrl);
    if (!fs.existsSync(file)) throw new Error('file not created');
  });

  await run('component insert', async () => {
    const r = await request('POST', `/api/projects/${testProject}/component`, {
      html: '<section class="slide"><div class="slide-content"><h2>Inserted Component</h2></div></section>',
    });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const htmlPath = path.join(ROOT, 'projects', testProject, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    if (!html.includes('Inserted Component')) throw new Error('component not inserted');
  });

  await run('theme overrides', async () => {
    const r = await request('POST', `/api/projects/${testProject}/theme-overrides`, {
      overrides: { '--teal': '#FF5500' },
    });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const htmlPath = path.join(ROOT, 'projects', testProject, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    if (!html.includes('theme-overrides')) throw new Error('theme overrides not injected');
  });

  await run('save user edits', async () => {
    const htmlPath = path.join(ROOT, 'projects', testProject, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const edited = html.replace(/<h1>/, '<h1>Edited by User ');
    const r = await request('POST', `/api/projects/${testProject}/save-edits`, { html: edited });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const saved = fs.readFileSync(htmlPath, 'utf8');
    if (!saved.includes('Edited by User')) throw new Error('user edit not persisted');
    const cfg = await request('GET', `/api/projects/${testProject}/config`);
    if (!cfg.body?.userEdits?.htmlSnapshot) throw new Error('userEdits not recorded');
  });

  await run('chat modify fails gracefully without LLM', async () => {
    const r = await request('POST', `/api/projects/${testProject}/chat`, { instruction: 'test' });
    if (r.status === 200) throw new Error('unexpected success');
  });

  await run('server still alive', async () => {
    const r = await request('GET', `/api/projects/${testProject}/config`);
    if (r.status !== 200) throw new Error('server dead');
  });

  // cleanup
  try {
    await request('DELETE', `/api/projects/${testProject}`);
    console.log('🧹 cleaned up');
  } catch {}
})();
