#!/usr/bin/env node
// 多模态媒体生成：图片 / 视频
// provider 路由顺序：arkcli → bailian(bl) → openai（仅生图）；指定 provider 失败依次降级。
// 实测语法（2026-07）：
//   arkcli +gen "<prompt>" --modality image|video [--model X] --save-to <dir> --no-open --format json
//   arkcli gen get <task-id> --save-to <dir> --no-open   # 视频任务轮询，成功后自动下载
//   arkcli +gen ... --dry-run                            # 探测可用性，不产生费用
//   bl image generate --prompt X --out-dir <dir> [--model X] --output json
//   bl video generate --prompt X --no-wait --output json # 返回任务 ID
//   bl video task get --task-id <id> --output json       # 查状态
//   bl video download --task-id <id> --out <path>        # 下载
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readGlobalConfig } from './global-config.mjs';
import { writeFileAtomic } from './fs-utils.mjs';

const PROVIDER_ORDER = ['arkcli', 'bailian', 'openai'];
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return resolve({ code: -1, stdout: '', stderr: `命令不存在: ${cmd}` });
      if (err && err.killed) return resolve({ code: -2, stdout: String(stdout || ''), stderr: '命令执行超时' });
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function whichCmd(cmd) {
  const { code } = await run('which', [cmd], 10000);
  return code === 0;
}

function parseJsonLoose(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// arkcli/bl 的错误 JSON 可能走 stderr，两处都尝试解析
function parseOutput(stdout, stderr) {
  return parseJsonLoose(stdout) || parseJsonLoose(stderr);
}

// 在返回 JSON 中递归查找首个匹配键（如 task_id / id / status）
function deepFind(obj, keyRe) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keyRe.test(k) && (typeof v === 'string' || typeof v === 'number')) return v;
    const found = deepFind(v, keyRe);
    if (found !== undefined) return found;
  }
  return undefined;
}

function errorMessage(parsed, stderr, stdout) {
  return parsed?.error?.message || parsed?.message || String(stderr || stdout || '').trim().slice(0, 300) || '未知错误';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  } catch {
    return [];
  }
}

function moveToOut(srcDir, fileName, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const src = path.join(srcDir, fileName);
  fs.copyFileSync(src, outPath);
  fs.rmSync(srcDir, { recursive: true, force: true });
  return outPath;
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------- arkcli ----------

async function arkcliImage(prompt, opts) {
  if (!(await whichCmd('arkcli'))) return { error: '未安装 arkcli' };
  const tmpDir = makeTmpDir('ai-ppt-img-');
  const args = ['+gen', prompt, '--modality', 'image', '--save-to', tmpDir, '--no-open', '--format', 'json'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.apiKey) args.push('--api-key', opts.apiKey);
  const { stdout, stderr } = await run('arkcli', args, 180000);
  const file = listFiles(tmpDir)[0];
  if (file) return { filePath: moveToOut(tmpDir, file, opts.outPath) };
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { error: errorMessage(parseOutput(stdout, stderr), stderr, stdout) };
}

async function arkcliVideo(prompt, opts, onProgress) {
  if (!(await whichCmd('arkcli'))) return { error: '未安装 arkcli' };
  const tmpDir = makeTmpDir('ai-ppt-vid-');
  const args = ['+gen', prompt, '--modality', 'video', '--save-to', tmpDir, '--no-open', '--format', 'json'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.apiKey) args.push('--api-key', opts.apiKey);
  const submit = await run('arkcli', args, 120000);
  const submitParsed = parseOutput(submit.stdout, submit.stderr);
  const directFile = listFiles(tmpDir)[0];
  if (directFile) return { filePath: moveToOut(tmpDir, directFile, opts.outPath) };
  const taskId = deepFind(submitParsed, /^(task_?id|id)$/i);
  if (!taskId) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { error: errorMessage(submitParsed, submit.stderr, submit.stdout) };
  }
  onProgress?.(`视频任务已提交: ${taskId}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await run('arkcli', ['gen', 'get', String(taskId), '--save-to', tmpDir, '--no-open', '--format', 'json'], 120000);
    const file = listFiles(tmpDir)[0];
    if (file) return { filePath: moveToOut(tmpDir, file, opts.outPath) };
    const parsed = parseOutput(poll.stdout, poll.stderr);
    const status = String(deepFind(parsed, /status/i) || '').toLowerCase();
    if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { error: `视频任务失败(${status}): ${errorMessage(parsed, poll.stderr, '')}` };
    }
    onProgress?.(`视频生成中${status ? ` (${status})` : ''}...`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { error: '视频生成超时（5 分钟）' };
}

// ---------- bailian (bl) ----------

async function blImage(prompt, opts) {
  if (!(await whichCmd('bl'))) return { error: '未安装 bl (Bailian CLI)' };
  const tmpDir = makeTmpDir('ai-ppt-img-');
  const args = ['image', 'generate', '--prompt', prompt, '--size', '1024*1024', '--out-dir', tmpDir, '--out-prefix', 'image', '--output', 'json'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.apiKey) args.push('--api-key', opts.apiKey);
  const { stdout, stderr } = await run('bl', args, 180000);
  const file = listFiles(tmpDir)[0];
  if (file) return { filePath: moveToOut(tmpDir, file, opts.outPath) };
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { error: errorMessage(parseOutput(stdout, stderr), stderr, stdout) };
}

async function blVideo(prompt, opts, onProgress) {
  if (!(await whichCmd('bl'))) return { error: '未安装 bl (Bailian CLI)' };
  const submitArgs = ['video', 'generate', '--prompt', prompt, '--no-wait', '--output', 'json'];
  if (opts.model) submitArgs.push('--model', opts.model);
  if (opts.apiKey) submitArgs.push('--api-key', opts.apiKey);
  const submit = await run('bl', submitArgs, 120000);
  const submitParsed = parseOutput(submit.stdout, submit.stderr);
  const taskId = deepFind(submitParsed, /task_?id/i);
  if (!taskId) return { error: errorMessage(submitParsed, submit.stderr, submit.stdout) };
  onProgress?.(`视频任务已提交: ${taskId}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await run('bl', ['video', 'task', 'get', '--task-id', String(taskId), '--output', 'json'], 60000);
    const parsed = parseOutput(poll.stdout, poll.stderr);
    const status = String(deepFind(parsed, /status/i) || '').toUpperCase();
    if (status === 'SUCCEEDED') {
      fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
      const dl = await run('bl', ['video', 'download', '--task-id', String(taskId), '--out', opts.outPath], 300000);
      if (dl.code === 0 && fs.existsSync(opts.outPath)) return { filePath: opts.outPath };
      return { error: `视频下载失败: ${String(dl.stderr || dl.stdout).trim().slice(0, 300)}` };
    }
    if (['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(status)) {
      return { error: `视频任务失败(${status})` };
    }
    onProgress?.(`视频生成中${status ? ` (${status})` : ''}...`);
  }
  return { error: '视频生成超时（5 分钟）' };
}

// ---------- OpenAI 兼容接口（仅生图） ----------

async function openaiImage(prompt, opts) {
  const baseUrl = (opts.baseUrl || process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
  // apiKey 优先级：请求临时透传 > 配置文件（persistApiKey 落盘的）> 环境变量
  const cfg = readGlobalConfig().imageModelConfig || {};
  const apiKey = opts.apiKey || cfg.apiKey || process.env.OPENAI_API_KEY;
  if (!baseUrl || !apiKey) return { error: 'openai 兼容接口未配置 baseUrl / apiKey' };
  try {
    const body = { prompt, size: '1024x1024', response_format: 'b64_json' };
    if (opts.model) body.model = opts.model;
    const resp = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { error: `生图接口 HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}` };
    const data = await resp.json();
    const item = data?.data?.[0];
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
    if (item?.b64_json) {
      writeFileAtomic(opts.outPath, Buffer.from(item.b64_json, 'base64'));
      return { filePath: opts.outPath };
    }
    if (item?.url) {
      const img = await fetch(item.url);
      if (!img.ok) return { error: `图片下载失败 HTTP ${img.status}` };
      writeFileAtomic(opts.outPath, Buffer.from(await img.arrayBuffer()));
      return { filePath: opts.outPath };
    }
    return { error: '生图接口返回为空' };
  } catch (e) {
    return { error: `生图接口异常: ${e.message}` };
  }
}

// ---------- 导出：生成入口 ----------

const IMAGE_PROVIDERS = { arkcli: arkcliImage, bailian: blImage, openai: openaiImage };
const VIDEO_PROVIDERS = { arkcli: arkcliVideo, bailian: blVideo };

async function generate(prompt, opts, providers, onProgress) {
  const start = Math.max(0, PROVIDER_ORDER.indexOf(opts.provider));
  const chain = PROVIDER_ORDER.slice(start).filter((p) => providers[p]);
  for (const p of chain) {
    onProgress?.(`尝试 provider: ${p}`);
    const result = await providers[p](prompt, opts, onProgress);
    if (result.filePath) return { filePath: result.filePath, provider: p };
    onProgress?.(`${p} 失败: ${result.error}`);
  }
  return null;
}

export async function generateImage(prompt, opts = {}) {
  return generate(prompt, opts, IMAGE_PROVIDERS, opts.onProgress);
}

export async function generateVideo(prompt, opts = {}) {
  return generate(prompt, opts, VIDEO_PROVIDERS, opts.onProgress);
}

// ---------- 导出：provider 探测 ----------

export async function probeMediaProvider(kind, cfg = {}) {
  const provider = cfg.provider || 'arkcli';
  if (provider === 'arkcli') {
    if (!(await whichCmd('arkcli'))) return { ok: false, message: '未安装 arkcli' };
    const args = ['+gen', '探针', '--modality', kind, '--dry-run', '--format', 'json'];
    if (cfg.model) args.push('--model', cfg.model);
    const { stdout, stderr } = await run('arkcli', args, 60000);
    const parsed = parseOutput(stdout, stderr);
    if (parsed?.validated === true || parsed?.dry_run === true) {
      return { ok: true, message: `arkcli 可用（${kind}，模型: ${cfg.model || 'CLI 默认'}）` };
    }
    return { ok: false, message: errorMessage(parsed, stderr, stdout) };
  }
  if (provider === 'bailian') {
    if (!(await whichCmd('bl'))) return { ok: false, message: '未安装 bl (Bailian CLI)' };
    const { stdout, stderr } = await run('bl', ['auth', 'status', '--output', 'json'], 30000);
    const parsed = parseOutput(stdout, stderr);
    if (parsed?.authenticated === true || parsed?.api_key?.configured === true) {
      return { ok: true, message: 'bl 已登录，可用' };
    }
    return { ok: false, message: 'bl 未登录，请先运行 bl auth login' };
  }
  if (provider === 'openai') {
    if (kind === 'video') return { ok: false, message: 'openai 兼容接口仅支持生图，不支持视频' };
    const baseUrl = cfg.baseUrl || process.env.OPENAI_BASE_URL;
    // cfg.apiKey 来自持久化配置（server /api/media/test 会合并 readGlobalConfig 结果）
    const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY;
    if (baseUrl && apiKey) return { ok: true, message: 'openai 兼容接口已配置' };
    return { ok: false, message: `openai 兼容接口缺少${!baseUrl ? ' baseUrl' : ''}${!apiKey ? ' apiKey（可在设置面板持久化或配置环境变量 OPENAI_API_KEY）' : ''}` };
  }
  return { ok: false, message: `未知 provider: ${provider}` };
}

// ---------- CLI ----------

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const emit = (obj) => console.log(JSON.stringify(obj));
  const cmd = process.argv[2];

  if (cmd === 'probe') {
    const kind = process.argv[3];
    if (kind !== 'image' && kind !== 'video') {
      emit({ ok: false, message: '用法: node scripts/media-gen.mjs probe <image|video>' });
      process.exit(1);
    }
    const cfg = readGlobalConfig()[kind === 'image' ? 'imageModelConfig' : 'videoModelConfig'];
    const result = await probeMediaProvider(kind, cfg);
    emit(result);
    process.exit(result.ok ? 0 : 1);
  } else if (cmd === 'image' || cmd === 'video') {
    const prompt = process.argv[3];
    let outPath = process.argv[4];
    if (!prompt || !outPath) {
      emit({ type: 'done', error: `用法: node scripts/media-gen.mjs ${cmd} "<prompt>" <outPath>` });
      process.exit(1);
    }
    // outPath 为目录时按约定补默认产物名：img-<时间戳>.png / vid-<时间戳>.mp4
    if (outPath.endsWith('/') || (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory())) {
      const prefix = cmd === 'image' ? 'img' : 'vid';
      const ext = cmd === 'image' ? 'png' : 'mp4';
      outPath = path.join(outPath, `${prefix}-${Date.now()}.${ext}`);
    }
    const cfg = readGlobalConfig()[cmd === 'image' ? 'imageModelConfig' : 'videoModelConfig'];
    const onProgress = (message) => emit({ type: 'progress', message });
    const fn = cmd === 'image' ? generateImage : generateVideo;
    const result = await fn(prompt, { ...cfg, outPath, onProgress });
    if (result) {
      emit({ type: 'done', filePath: result.filePath, provider: result.provider });
    } else {
      emit({ type: 'done', error: '所有 provider 均失败' });
      process.exit(1);
    }
  } else {
    console.log('Usage: node scripts/media-gen.mjs <image|video> "<prompt>" <outPath> | probe <image|video>');
  }
}
