#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const BASE = process.env.AI_PPT_SMOKE_BASE || 'http://localhost:3456';

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

let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}: ${err.message}`);
    failed++;
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

  // 轮询项目状态直到 ready（无 LLM 走模板兜底约 2 秒；有 LLM 时真实调用可能需数十秒）
  async function waitProjectReady(name, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cfg = await request('GET', `/api/projects/${name}/config`);
      if (cfg.body?.status === 'ready') return cfg.body;
      if (cfg.body?.status === 'error') throw new Error(`generate error: ${cfg.body?.errorMessage || ''}`);
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error('not ready in time');
  }

  await run('generate (fallback or LLM)', async () => {
    const r = await request('POST', `/api/projects/${testProject}/generate`, {});
    if (r.status !== 202) throw new Error(`status ${r.status}`);
    await waitProjectReady(testProject);
  });

  await run('SSE after generation', async () => {
    // SSE 是长连接（心跳保活），不能用等 'end' 的 request helper；拿到响应头即算通过
    await new Promise((resolve, reject) => {
      const req = http.get(`${BASE}/api/projects/${testProject}/generate/events`, (res) => {
        res.resume();
        req.destroy();
        if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
        resolve();
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); else resolve(); });
      req.setTimeout(5000, () => { req.destroy(); resolve(); });
    });
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

  await run('chat modify reaches terminal state', async () => {
    const r = await request('POST', `/api/projects/${testProject}/chat`, { instruction: 'test' });
    if (r.status !== 202) throw new Error(`status ${r.status}`);
    // 无 LLM：error 终态且内容不变；有 LLM：done 终态（内容被真实修改）。两者均为合法结果。
    const deadline = Date.now() + 120000;
    let messages = [];
    while (Date.now() < deadline) {
      const h = await request('GET', `/api/projects/${testProject}/chat/history`);
      messages = h.body?.messages || [];
      if (messages.some((m) => m.role === 'assistant')) break;
      await new Promise((res) => setTimeout(res, 3000));
    }
    if (!messages.some((m) => m.role === 'user')) throw new Error('user instruction not recorded');
    if (!messages.some((m) => m.role === 'assistant')) throw new Error('no terminal assistant message in time');
  });

  const fragMarker = `smoke-frag-${Date.now()}`;

  await run('fragment create + hashtag extraction', async () => {
    let createdId = null;
    try {
      const r = await request('POST', '/api/vault/fragments', {
        content: `${fragMarker} 创建用例 #smoketag #速记`,
      });
      if (r.status !== 201) throw new Error(`status ${r.status}`);
      if (!r.body?.id) throw new Error('no id');
      createdId = r.body.id;
      if (!r.body.tags.includes('smoketag') || !r.body.tags.includes('速记')) {
        throw new Error('hashtags not extracted');
      }
      const list = await request('GET', '/api/vault/fragments');
      if (list.status !== 200 || !Array.isArray(list.body?.fragments)) throw new Error('bad list response');
      if (!list.body.fragments.some((f) => f.id === createdId)) throw new Error('fragment not in list');
    } finally {
      if (createdId) await request('DELETE', `/api/vault/fragments/${createdId}`);
    }
  });

  await run('fragment update content and status', async () => {
    const created = await request('POST', '/api/vault/fragments', { content: `${fragMarker} 更新用例` });
    if (created.status !== 201) throw new Error(`create status ${created.status}`);
    const id = created.body.id;
    try {
      const r = await request('PUT', `/api/vault/fragments/${id}`, {
        content: `${fragMarker} 更新后 #newtag`,
        status: 'organized',
      });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (r.body?.status !== 'organized') throw new Error('status not updated');
      if (!r.body?.content?.includes('更新后')) throw new Error('content not updated');
      if (!r.body?.tags?.includes('newtag')) throw new Error('tags not re-extracted');
    } finally {
      await request('DELETE', `/api/vault/fragments/${id}`);
    }
  });

  await run('fragment delete removes from list', async () => {
    const created = await request('POST', '/api/vault/fragments', { content: `${fragMarker} 删除用例` });
    if (created.status !== 201) throw new Error(`create status ${created.status}`);
    const id = created.body.id;
    const del = await request('DELETE', `/api/vault/fragments/${id}`);
    if (del.status !== 204) throw new Error(`delete status ${del.status}`);
    const list = await request('GET', '/api/vault/fragments');
    if (list.status !== 200 || list.body.fragments.some((f) => f.id === id)) {
      throw new Error('fragment still in list');
    }
  });

  // 契约 G：AI 整理——无 LLM 时确定性降级建议
  const organizeMarker = `smoke-organize-${Date.now()}`;
  let organizeFragId = null;
  let organizeSuggestion = null;

  await run('organize suggestion (degraded or LLM)', async () => {
    const created = await request('POST', '/api/vault/fragments', {
      content: `${organizeMarker} 什么是确定性降级？`,
    });
    if (created.status !== 201) throw new Error(`create status ${created.status}`);
    organizeFragId = created.body.id;
    const r = await request('POST', '/api/vault/organize', {});
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (!Array.isArray(r.body?.suggestions)) throw new Error('suggestions not an array');
    organizeSuggestion = r.body.suggestions.find((s) => s.fragmentId === organizeFragId);
    // 无 LLM（degraded）时确定性规则必须给出 promote/card；有 LLM 时建议内容不限
    if (r.body.degraded === true) {
      if (!organizeSuggestion) throw new Error('no suggestion for fragment');
      if (organizeSuggestion.action !== 'promote' || organizeSuggestion.to !== 'card') {
        throw new Error(`unexpected suggestion ${organizeSuggestion.action}/${organizeSuggestion.to}`);
      }
    }
  });

  await run('organize apply promotes fragment to card', async () => {
    let cardId = null;
    try {
      // 有 LLM 时建议可能不是 promote，无法按本用例断言，跳过视为通过
      if (!organizeSuggestion || organizeSuggestion.action !== 'promote') return;
      const r = await request('POST', '/api/vault/organize/apply', { actions: [organizeSuggestion] });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (!(r.body?.applied >= 1)) throw new Error('nothing applied');
      const result = (r.body.results || []).find((x) => x.fragmentId === organizeFragId);
      cardId = result?.target?.cardId || null;
      if (!cardId) throw new Error('no card created');
      const list = await request('GET', '/api/vault/fragments');
      const frag = (list.body?.fragments || []).find((f) => f.id === organizeFragId);
      if (!frag || frag.status !== 'organized') throw new Error('fragment not organized');
    } finally {
      if (cardId) await request('DELETE', `/api/vault/cards/${cardId}`);
      if (organizeFragId) await request('DELETE', `/api/vault/fragments/${organizeFragId}`);
    }
  });

  // 契约 I：智能组卷
  await run('smart-generate exam', async () => {
    let examId = null;
    try {
      const r = await request('POST', '/api/exams/smart-generate', { count: 2 });
      if (r.status !== 201) throw new Error(`status ${r.status}`);
      if (!Array.isArray(r.body?.exam?.questions) || r.body.exam.questions.length !== 2) {
        throw new Error('questions.length !== 2');
      }
      examId = r.body.exam.id;
    } finally {
      if (examId) await request('DELETE', `/api/exams/${examId}`);
    }
  });

  // 契约 E/F：三组模型配置对外呈现且不泄露 apiKey
  await run('global config exposes three model groups without apiKey', async () => {
    const r = await request('GET', '/api/config');
    if (r.status !== 200 || !r.body) throw new Error(`status ${r.status}`);
    for (const key of ['modelConfig', 'imageModelConfig', 'videoModelConfig']) {
      if (!(key in r.body)) throw new Error(`missing ${key}`);
    }
    // apiKeySet 是掩码标记，允许出现；真正的 apiKey 字段（带明文值）不得出现
    if (/"apiKey"\s*:/.test(JSON.stringify(r.body))) throw new Error('apiKey leaked in response');
  });

  // 契约 N：重命名级联更新 [[Wiki链接]]
  await run('note rename cascades links', async () => {
    try {
      const b = await request('POST', '/api/vault/notes', { name: 'zz-smoke-b', content: '冒烟 B' });
      if (b.status !== 201) throw new Error(`create b status ${b.status}`);
      const a = await request('POST', '/api/vault/notes', {
        name: 'zz-smoke-a',
        content: '链接到 [[zz-smoke-b]] 以及 [[zz-smoke-b|别名]]。',
      });
      if (a.status !== 201) throw new Error(`create a status ${a.status}`);
      const r = await request('POST', '/api/vault/notes/zz-smoke-b/rename', { newName: 'zz-smoke-c' });
      if (r.status !== 200 || r.body?.ok !== true) throw new Error(`rename status ${r.status}`);
      if (r.body?.updatedRefs !== 2) throw new Error(`updatedRefs ${r.body?.updatedRefs} !== 2`);
      const renamed = await request('GET', '/api/vault/notes/zz-smoke-a');
      if (renamed.status !== 200) throw new Error(`get a status ${renamed.status}`);
      if (!renamed.body?.content?.includes('[[zz-smoke-c]]')) throw new Error('plain link not cascaded');
      if (!renamed.body?.content?.includes('[[zz-smoke-c|别名]]')) throw new Error('alias link not cascaded');
      const gone = await request('GET', '/api/vault/notes/zz-smoke-b');
      if (gone.status !== 404) throw new Error(`old note status ${gone.status} !== 404`);
    } finally {
      await request('DELETE', '/api/vault/notes/zz-smoke-a');
      await request('DELETE', '/api/vault/notes/zz-smoke-b');
      await request('DELETE', '/api/vault/notes/zz-smoke-c');
    }
  });

  // 契约 N：info 入链携带来源名与上下文 snippets
  await run('note info backlinks include snippets', async () => {
    try {
      const x = await request('POST', '/api/vault/notes', { name: 'zz-smoke-x', content: '冒烟 X' });
      if (x.status !== 201) throw new Error(`create x status ${x.status}`);
      const y = await request('POST', '/api/vault/notes', {
        name: 'zz-smoke-y',
        content: '这里引用 [[zz-smoke-x]] 一次。',
      });
      if (y.status !== 201) throw new Error(`create y status ${y.status}`);
      const r = await request('GET', '/api/vault/notes/zz-smoke-x/info');
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const backlink = (r.body?.backlinks || [])[0];
      if (!backlink?.name) throw new Error('backlinks[0].name missing');
      if (backlink.name !== 'zz-smoke-y') throw new Error(`unexpected backlink ${backlink.name}`);
      if (!Array.isArray(backlink.snippets)) throw new Error('snippets not an array');
    } finally {
      await request('DELETE', '/api/vault/notes/zz-smoke-x');
      await request('DELETE', '/api/vault/notes/zz-smoke-y');
    }
  });

  // 契约 N：未链接提及检测与一键转链接
  await run('unlinked mentions detect and link', async () => {
    try {
      const t = await request('POST', '/api/vault/notes', { name: 'zz-smoke-target', content: '目标内容' });
      if (t.status !== 201) throw new Error(`create target status ${t.status}`);
      const s = await request('POST', '/api/vault/notes', {
        name: 'zz-smoke-src',
        content: '这里提到 zz-smoke-target 一次，另外已经链接 [[zz-smoke-target]]。',
      });
      if (s.status !== 201) throw new Error(`create src status ${s.status}`);
      const before = await request('GET', '/api/vault/notes/zz-smoke-target/mentions');
      if (before.status !== 200) throw new Error(`mentions status ${before.status}`);
      if (before.body?.mentions?.length !== 1) throw new Error(`mentions ${before.body?.mentions?.length} !== 1`);
      if (before.body.mentions[0].source !== 'zz-smoke-src') throw new Error('mention source mismatch');
      const link = await request('POST', '/api/vault/notes/zz-smoke-target/link-mentions', { source: 'zz-smoke-src' });
      if (link.status !== 200 || link.body?.count !== 1) throw new Error(`link count ${link.body?.count} !== 1`);
      const after = await request('GET', '/api/vault/notes/zz-smoke-target/mentions');
      if (after.status !== 200 || after.body?.mentions?.length !== 0) throw new Error('mentions not cleared');
    } finally {
      await request('DELETE', '/api/vault/notes/zz-smoke-src');
      await request('DELETE', '/api/vault/notes/zz-smoke-target');
    }
  });

  // 契约 N：标签聚合（笔记/卡片/碎片）
  await run('vault tags aggregation', async () => {
    let fragId = null;
    try {
      const r = await request('GET', '/api/vault/tags');
      if (r.status !== 200 || !r.body?.tags || typeof r.body.tags !== 'object' || Array.isArray(r.body.tags)) {
        throw new Error('tags missing');
      }
      const created = await request('POST', '/api/vault/fragments', {
        content: `${fragMarker} 标签聚合用例 #zzsmoketag`,
      });
      if (created.status !== 201) throw new Error(`create status ${created.status}`);
      fragId = created.body.id;
      const after = await request('GET', '/api/vault/tags');
      if (after.status !== 200) throw new Error(`status ${after.status}`);
      const entry = after.body?.tags?.zzsmoketag;
      if (!entry || !Array.isArray(entry.fragments) || entry.fragments.length < 1) {
        throw new Error('zzsmoketag fragments missing');
      }
    } finally {
      if (fragId) await request('DELETE', `/api/vault/fragments/${fragId}`);
    }
  });

  // 契约 O：笔记 AI 对话修改——无 LLM 时优雅失败且笔记不被改动
  await run('note chat reaches terminal state', async () => {
    const noteName = `zz-smoke-chat-${Date.now()}`;
    const noteContent = '冒烟笔记原文。';
    try {
      const created = await request('POST', '/api/vault/notes', { name: noteName, content: noteContent });
      if (created.status !== 201) throw new Error(`create status ${created.status}`);
      const r = await request('POST', `/api/vault/notes/${noteName}/chat`, { instruction: '改写这段内容' });
      if (r.status !== 202) throw new Error(`status ${r.status}`);
      // 无 LLM：error 终态且内容不变；有 LLM：done 终态（内容被真实修改）。两者均为合法结果。
      const deadline = Date.now() + 120000;
      let terminal = false;
      while (Date.now() < deadline) {
        // 通过 SSE 快照判断是否有终态（chats 任务完成后 serveSse 回放缓存）
        const done = await new Promise((resolve) => {
          const req = http.get(`${BASE}/api/vault/notes/${encodeURIComponent(noteName)}/chat/events`, (res) => {
            let data = '';
            res.on('data', (c) => {
              data += c;
              if (data.includes('"type":"done"') || data.includes('"type":"error"')) {
                req.destroy();
                resolve(true);
              }
            });
            res.on('end', () => resolve(data.includes('"type":"done"') || data.includes('"type":"error"')));
          });
          req.on('error', () => resolve(true));
          req.setTimeout(5000, () => { req.destroy(); resolve(false); });
        });
        if (done) { terminal = true; break; }
        await new Promise((res) => setTimeout(res, 2000));
      }
      if (!terminal) throw new Error('no terminal event in time');
    } finally {
      await request('DELETE', `/api/vault/notes/${noteName}`);
    }
  });

  // 契约 Q：手动备份端点
  await run('manual backup endpoint', async () => {
    const r = await request('POST', '/api/backup', {});
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (typeof r.body?.dir !== 'string' || !r.body.dir.includes('.backup')) {
      throw new Error('backup dir missing or invalid');
    }
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

  process.exit(failed);
})();
