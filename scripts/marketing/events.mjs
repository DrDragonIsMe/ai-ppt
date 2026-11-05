// scripts/marketing/events.mjs — 营销模块 NDJSON 事件出口 + 心跳。
// 事件型：progress | step | outline | slide | deck | lint | error | done（每行一个 JSON）。
// 两条硬约定（跨 mission 契约）：
//  (1) 终态事件型必须是 done / error，且载荷绝不覆盖 type —— 故所有载荷字段都先经 stripType。
//  (2) 长时间 LLM 调用期间必须周期性发 step 心跳：前端 SSE 看门狗是 idle（事件重置）型、阈值 240s，
//      真实 LLM 单份 deck 常超 60s，只靠 deck 级事件扛不住长静默。默认 20s 一条，留足余量。
import { diagnoseError } from '../generation-common.mjs';

export const HEARTBEAT_MS = 20000;

const stripType = (obj) => {
  if (!obj || typeof obj !== 'object') return {};
  const { type, ...rest } = obj;
  return rest;
};

/** 写一行 NDJSON 到 stdout。write 可注入（测试捕获事件流）。 */
export function makeEmitter(write = (line) => process.stdout.write(line)) {
  const send = (event) => {
    write(JSON.stringify(event) + '\n');
    return event;
  };
  return {
    /** 通用事件：type 由第一参数固定，载荷里的 type 一律丢弃 */
    emit: (type, payload = {}) => send({ type, ...stripType(payload), time: new Date().toISOString() }),
    /** 进度事件（带 step 名，兼容 generation-common 的 emit 形状） */
    progress: (step, message, detail = null) =>
      send({ type: 'progress', step, message, detail, time: new Date().toISOString() }),
    /** 心跳事件 */
    step: (message, payload = {}) =>
      send({ type: 'step', message, ...stripType(payload), time: new Date().toISOString() }),
    /** 错误终态 */
    error: (message, payload = {}) => {
      const hint = diagnoseError(message);
      return send({
        type: 'error',
        message: hint ? `${message}\n💡 ${hint}` : String(message || ''),
        ...stripType(payload),
        time: new Date().toISOString(),
      });
    },
    /** 成功终态 */
    done: (payload = {}) => send({ type: 'done', ...stripType(payload), time: new Date().toISOString() }),
  };
}

/**
 * 在 fn 执行期间按 everyMs 周期发 step 心跳；fn 结束（含抛错）立即停止计时器。
 * 心跳载荷带 fn 内部随时可更新的进度（通过返回的 setProgress）。
 * @returns {Promise<{result:any, setProgress:(obj)=>void}>}
 */
export async function withHeartbeat(emitter, fn, { message = '处理中', everyMs = HEARTBEAT_MS, ...initial } = {}) {
  let progress = { ...initial };
  let tick = 0;
  const setProgress = (obj) => { progress = { ...progress, ...obj }; };
  const timer = setInterval(() => {
    tick++;
    emitter.step(`${message}（已等待 ${Math.round((tick * everyMs) / 1000)}s）`, progress);
  }, everyMs);
  if (typeof timer.unref === 'function') timer.unref();
  // 立刻发一条，保证「首事件后」的静默窗口从一开始就有界
  emitter.step(message, progress);
  try {
    const result = await fn(setProgress);
    return { result, setProgress };
  } finally {
    clearInterval(timer);
  }
}
