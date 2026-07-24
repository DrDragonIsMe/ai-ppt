// scripts/task-registry.mjs — 统一任务注册表：内存 Map + 节流落盘持久化 + 重启恢复 + 取消。
// 供媒体任务（media）、资产解析任务（parse）与 NDJSON 任务元信息（generate/chat/export）共用。
// 落盘用 fs-utils.mjs 的 writeJsonAtomic；写盘按 flushMs 节流，避免每个进度都写。
import fs from 'node:fs';
import { writeJsonAtomic } from './fs-utils.mjs';

// 终态任务保留时长（与旧 mediaTasks/parseTasks 的 TTL 一致）
export const TASK_TTL_MS = 60 * 60 * 1000;
// SSE 事件 buffer 上限：超出丢最旧，防止 stderr 洪峰撑爆内存
export const NDJSON_BUFFER_CAP = 500;

const ACTIVE_STATUSES = new Set(['pending', 'running']);
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted']);

export function isActiveStatus(status) { return ACTIVE_STATUSES.has(status); }
export function isTerminalStatus(status) { return TERMINAL_STATUSES.has(status); }

// 向有上限的 buffer 追加事件：超出 cap 时丢最旧
export function pushBounded(buffer, item, cap = NDJSON_BUFFER_CAP) {
  buffer.push(item);
  if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
}

// 任务对外视图：剥离 `_` 前缀的运行时字段（子进程等）与不可序列化值
export function publicTask(task) {
  if (!task || typeof task !== 'object') return task;
  const out = {};
  for (const [k, v] of Object.entries(task)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'function') continue;
    if (v && typeof v === 'object') continue;
    out[k] = v;
  }
  return out;
}

/**
 * 创建任务注册表。
 * 持久化格式：{ version: 1, tasks: { [id]: { id, kind?, status, error?, createdAt, updatedAt, finishedAt?, ... } } }
 * status 生命周期：pending/running → done | error | cancelled | interrupted（重启恢复时由活跃态转入）
 */
export function createTaskRegistry({ filePath, ttlMs = TASK_TTL_MS, flushMs = 500, maxTasks = 500 } = {}) {
  if (!filePath) throw new Error('createTaskRegistry: filePath 必填');
  const tasks = new Map();
  let dirty = false;
  let flushTimer = null;

  const now = () => new Date().toISOString();

  function persistSoon() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, flushMs);
    flushTimer.unref?.();
  }

  // 清理过期终态任务；总量超限时从最旧终态开始删
  function prune() {
    const cutoff = Date.now() - ttlMs;
    for (const [id, t] of tasks) {
      const ts = Date.parse(t.finishedAt || t.updatedAt || t.createdAt || 0);
      if (isTerminalStatus(t.status) && ts && ts < cutoff) tasks.delete(id);
    }
    if (tasks.size > maxTasks) {
      const terminal = [...tasks.values()]
        .filter((t) => isTerminalStatus(t.status))
        .sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')));
      for (const t of terminal) {
        if (tasks.size <= maxTasks) break;
        tasks.delete(t.id);
      }
    }
  }

  /** 立即写盘（节流外的强制 flush，供测试与进程退出前调用） */
  function flush() {
    if (!dirty) return;
    dirty = false;
    prune();
    try {
      const obj = { version: 1, tasks: Object.fromEntries([...tasks.entries()].map(([id, t]) => [id, publicTask(t)])) };
      writeJsonAtomic(filePath, obj);
    } catch (err) {
      console.error('任务注册表写盘失败:', err.message);
    }
  }

  function create(id, data = {}) {
    const task = { status: 'pending', ...data, id, createdAt: now(), updatedAt: now() };
    tasks.set(id, task);
    persistSoon();
    return task;
  }

  function get(id) { return tasks.get(id); }

  function update(id, patch = {}) {
    const task = tasks.get(id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: now() });
    persistSoon();
    return task;
  }

  // 终态写入不覆盖已有终态（取消后迟到的结果必须被忽略）
  function complete(id, patch = {}) {
    const task = tasks.get(id);
    if (!task || isTerminalStatus(task.status)) return task || null;
    return update(id, { ...patch, status: 'done', finishedAt: now() });
  }

  function fail(id, error, patch = {}) {
    const task = tasks.get(id);
    if (!task || isTerminalStatus(task.status)) return task || null;
    return update(id, { ...patch, status: 'error', error: String(error || '任务失败'), finishedAt: now() });
  }

  // 取消：仅活跃态有效，返回当前任务（不存在返回 null）；子进程类任务能 kill 则 kill
  function cancel(id) {
    const task = tasks.get(id);
    if (!task) return null;
    if (isActiveStatus(task.status)) {
      update(id, { status: 'cancelled', error: '任务已取消', finishedAt: now() });
      try { task._child?.kill?.(); } catch { /* 进程可能已退出 */ }
    }
    return task;
  }

  function remove(id) {
    const existed = tasks.delete(id);
    if (existed) persistSoon();
    return existed;
  }

  function list() { return [...tasks.values()]; }

  // 启动恢复：读盘；所有活跃态任务标记 interrupted（进程已死，任务不可能继续）
  function load() {
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const obj = data && typeof data === 'object' ? data.tasks : null;
    if (!obj || typeof obj !== 'object') return;
    let changed = false;
    for (const [id, t] of Object.entries(obj)) {
      if (!t || typeof t !== 'object') continue;
      const task = { ...t, id };
      if (isActiveStatus(task.status)) {
        task.status = 'interrupted';
        task.error = '服务已重启，任务中断，请重试';
        task.finishedAt = task.finishedAt || now();
        changed = true;
      }
      tasks.set(id, task);
    }
    if (changed) persistSoon();
  }

  return { create, get, update, complete, fail, cancel, remove, list, load, flush, _map: tasks };
}
