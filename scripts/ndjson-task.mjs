// scripts/ndjson-task.mjs — 通用 NDJSON 子进程任务：store 管理 + 子进程 spawn + 重启恢复。
// 从 server.mjs 提取（M16），使任务状态管理可独立单测（无需起 HTTP 服务）。
// server.mjs 通过 createNdjsonTaskContext 创建唯一实例，再把 store/spawn 函数按原名注入各 routes 的 deps。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pushBounded, NDJSON_BUFFER_CAP } from './task-registry.mjs';

/**
 * 创建一套 NDJSON 任务状态上下文：7 个 store Map、kind 映射、spawn 与重启恢复。
 * root 为仓库根（子进程脚本固定位于 <root>/scripts/），taskRegistry 为统一任务注册表。
 */
export function createNdjsonTaskContext({ root, taskRegistry }) {
  if (!root) throw new Error('createNdjsonTaskContext: root 必填');
  if (!taskRegistry) throw new Error('createNdjsonTaskContext: taskRegistry 必填');

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
      path.join(root, 'scripts', script),
      ...args,
    ], { cwd: root, env });

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
      // 身份守卫：仅当本 state 仍是该 key 当前持有者时才写 registry 终态。
      // 覆盖路径（上文 prev 分支）kill 掉的旧任务 close 晚于新任务 create，
      // 不加守卫会把新任务占有的注册表条目提前判死，重启恢复判定随之失效。
      if (store.get(name) === state) {
        const finalEvent = state.buffer[state.buffer.length - 1];
        if (finalEvent && finalEvent.type === 'error') {
          taskRegistry.fail(metaId, finalEvent.message || '任务失败');
        } else {
          taskRegistry.complete(metaId);
        }
      }
      // 身份守卫：仅当本 state 仍是持有者时才删除（与 restoreInterruptedNdjsonTasks 一致）。
      // 盲删会把 60s 内占据同 key 的新任务 state 误删（events 404 / running:false /
      // 批次误标 interrupted，且 hasActiveTask 失效放开并发写盘）。unref 避免拖住退出。
      setTimeout(() => { if (store.get(name) === state) store.delete(name); }, 60000).unref();
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

  return {
    generators,
    chats,
    noteChats,
    exportTasks,
    sourceRefreshes,
    marketingOutlines,
    marketingBatches,
    NDJSON_STORE_KINDS,
    spawnNdjsonTask,
    restoreInterruptedNdjsonTasks,
  };
}
