// tests/ndjson-task.test.mjs — scripts/ndjson-task.mjs 的任务状态守卫回归测试。
// 不需要 HTTP 服务：内存 store + 假 taskRegistry + 临时 ROOT 下的小 NDJSON 子进程。
// 定时器用 node:test mock timers 驱动（60s 清理延迟不落真实等待）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNdjsonTaskContext } from '../scripts/ndjson-task.mjs';

const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

// 假注册表：与 scripts/task-registry.mjs 同款「终态不被覆盖」语义，记录全部调用
function fakeRegistry() {
  const tasks = new Map();
  return {
    tasks,
    create(id, data = {}) { const t = { status: 'pending', ...data, id }; tasks.set(id, t); return t; },
    get(id) { return tasks.get(id); },
    list() { return [...tasks.values()]; },
    complete(id) {
      const t = tasks.get(id);
      if (!t || TERMINAL.has(t.status)) return t || null;
      t.status = 'done';
      return t;
    },
    fail(id, error) {
      const t = tasks.get(id);
      if (!t || TERMINAL.has(t.status)) return t || null;
      t.status = 'error';
      t.error = String(error || '任务失败');
      return t;
    },
  };
}

// 临时 ROOT：scripts/ 下两个子进程脚本
function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-task-test-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'quick-done.mjs'),
    'console.log(JSON.stringify({ type: "done" }));\n');
  fs.writeFileSync(path.join(root, 'scripts', 'stay-alive.mjs'),
    'console.log(JSON.stringify({ type: "progress", value: 1 }));\nsetInterval(() => {}, 1000);\n');
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

// 回归（M16 根因，塔端到端实测）：同一 key 上第二个任务进行中时，
// 旧任务的 60s 清理器不得删掉新任务的 state；旧任务（被覆盖路径 kill 的）close 不得
// 把新任务占有的 registry 条目提前判死。
test('同 key 覆盖：旧任务的清理器与 registry 终态写入不影响第二个任务', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = makeTempRoot(t);
  const registry = fakeRegistry();
  const ctx = createNdjsonTaskContext({ root, taskRegistry: registry });
  const store = ctx.marketingBatches;
  const key = 'current';
  const metaId = 'ndjson:marketing-batch:current';

  // A 先跑（常驻），B 在 A 结束前启动并占据同一 key → 覆盖路径 kill 掉 A
  const a = ctx.spawnNdjsonTask(store, key, 'stay-alive.mjs', []);
  const b = ctx.spawnNdjsonTask(store, key, 'stay-alive.mjs', []);
  t.after(() => { try { b.process.kill(); } catch { /* 已退出 */ } });
  assert.equal(store.get(key), b);

  // A 的 close 晚于 B 的 create：有守卫时不得写 registry（条目仍归 B，保持 running）
  await once(a.process, 'close');
  assert.equal(registry.get(metaId).status, 'running');

  // A 的 60s 清理器触发：有守卫时保留 B 的 state（未修复的旧代码在此盲删 'current'，
  // 导致 /batch/events 404、/batch/current {running:false}、批次被误标 interrupted）
  t.mock.timers.tick(60000);
  assert.equal(store.get(key), b);

  // B 结束后（这里手动 kill）：本 state 仍是持有者，registry 终态写入生效
  b.process.kill();
  await once(b.process, 'close');
  assert.equal(registry.get(metaId).status, 'error'); // 被 kill → error 终态
  // B 自己的清理器命中身份守卫，正常删除
  t.mock.timers.tick(60000);
  assert.equal(store.get(key), undefined);
});

// 正常单任务路径：结束后 60s 内可查；守卫命中时确实删除；不命中（key 已被新 state 占据）时保留。
test('正常单任务：60s 内可查，守卫命中删除、不命中保留新 state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = makeTempRoot(t);
  const registry = fakeRegistry();
  const ctx = createNdjsonTaskContext({ root, taskRegistry: registry });
  const store = ctx.generators;
  const metaId = 'ndjson:generate:proj-a';

  const state = ctx.spawnNdjsonTask(store, 'proj-a', 'quick-done.mjs', []);
  await once(state.process, 'close');
  assert.equal(state.done, true);
  assert.equal(registry.get(metaId).status, 'done');

  // 结束后 60s 内仍可查（SSE 回放/轮询窗口）
  t.mock.timers.tick(59999);
  assert.equal(store.get('proj-a'), state);
  // 守卫命中（仍是同一 state）→ 到期删除
  t.mock.timers.tick(1);
  assert.equal(store.get('proj-a'), undefined);

  // 不命中：任务结束后 key 被新 state 占据，旧清理器不得删除新 state
  const c = ctx.spawnNdjsonTask(store, 'proj-b', 'quick-done.mjs', []);
  await once(c.process, 'close');
  const successor = { name: 'proj-b', process: null, buffer: [], listeners: new Set(), done: false, error: null };
  store.set('proj-b', successor);
  t.mock.timers.tick(60000);
  assert.equal(store.get('proj-b'), successor);
});

// 重启恢复：interrupted 任务回填合成 state，到期由守卫清理
test('restoreInterruptedNdjsonTasks 回填 interrupted 任务并按时清理', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = makeTempRoot(t);
  const registry = fakeRegistry();
  registry.create('ndjson:generate:proj-x', {
    kind: 'generate', name: 'proj-x', status: 'interrupted', error: '服务已重启，任务中断，请重试',
  });
  // 非 interrupted / 缺 name 的条目不应回填
  registry.create('ndjson:chat:proj-y', { kind: 'chat', name: 'proj-y', status: 'done' });
  const ctx = createNdjsonTaskContext({ root, taskRegistry: registry });

  ctx.restoreInterruptedNdjsonTasks();
  const restored = ctx.generators.get('proj-x');
  assert.ok(restored);
  assert.equal(restored.done, true);
  assert.equal(restored.buffer[0].type, 'error');
  assert.equal(ctx.chats.has('proj-y'), false);

  t.mock.timers.tick(60000);
  assert.equal(ctx.generators.get('proj-x'), undefined);
});
