// scripts/marketing/llm.mjs — LLM 可达性判定（营销大纲/批量生成共用）。
// 为什么单独写：buildModelOptions() 在用户没配 key 时也会返回全局默认的
// baseUrl + provider（实测 {baseUrl:'https://ark…',model:'doubao…',provider:'openai'}），
// 所以 `apiKey || baseUrl || provider` 恒为真，用它当开关等于没有开关——
// 未配置的用户要为每个角度/每份 deck 各等一次远程超时。
// 真实信号只有两条：远程端点必须带 key；本地端点（LM Studio）不需要 key。
const LOCAL_HOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;

/**
 * @param {{apiKey?:string, baseUrl?:string, provider?:string}} modelOptions
 * @param {{explicitSkip?:boolean}} [opts] 调用方显式要求跳过（测试走确定性兜底）
 */
export function llmReachable(modelOptions, opts = {}) {
  if (opts.explicitSkip) return false;
  const o = modelOptions || {};
  const base = String(o.baseUrl || '');
  if (o.provider === 'lmstudio' || LOCAL_HOST_RE.test(base)) return true;
  return !!o.apiKey;
}

export { LOCAL_HOST_RE };
