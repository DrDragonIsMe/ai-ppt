#!/usr/bin/env node
// 资产内容解析：vault/assets 下的文档/图片/音视频 → 文本摘要。
// 分派：pdf/docx → 本地提取 + LLM 规整；图片 → openai 视觉 → bl omni；音视频 → bl omni → arkcli +chat。
// 所有外部调用均 try/catch 降级，绝不向路由层抛错。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { generateSlides } from './llm-adapter.mjs';
import { buildModelOptions } from './generation-common.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'vault', 'assets');

const DOC_EXTS = ['.pdf', '.docx'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov'];
// bl 音频类接口（speech recognize / omni --audio）支持的扩展名
const BL_AUDIO_EXTS = ['.wav', '.mp3', '.amr', '.aac', '.m4a', '.ogg', '.3gp', '.3gpp'];

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const CLI_TIMEOUT_MS = 120000;

function run(cmd, args, timeoutMs = CLI_TIMEOUT_MS) {
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

// ---------- 文档：本地提取 ----------

async function extractDocText(ext, buf) {
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      return String(result?.text || '');
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer: buf });
  return String(result?.value || '');
}

// LLM 把提取文本规整为「干货笔记」；不可用返回 null
async function organizeWithLlm(rawText, apiKey) {
  try {
    const options = buildModelOptions();
    if (apiKey) options.apiKey = apiKey; // 临时透传，不落盘
    const prompt = [
      '请把以下原始文本（文档提取或语音转写）规整为一份中文「干货笔记」，要求：',
      '1. 以要点列表呈现核心信息，去除页眉页脚、乱码与重复内容；',
      '2. 文末提炼 3-6 个 #标签；',
      '3. 如内容与常见知识库主题（工作、学习、产品、技术等）相关，可给出 1-3 个 [[笔记名]] 建议；',
      '4. 只输出纯文本笔记本身，不要额外说明。',
      '',
      rawText.slice(0, 12000),
    ].join('\n');
    const result = await generateSlides(prompt, options);
    const text = result && result.content ? result.content.trim() : '';
    return text || null;
  } catch {
    return null;
  }
}

// ---------- 图片：openai 兼容视觉 → bl omni ----------

const IMAGE_PROMPT = '请描述这张图片的内容，提取其中所有可见文字（OCR），并总结为中文要点列表。只输出纯文本。';

async function describeImageViaOpenAI(buf, ext, apiKey) {
  const options = buildModelOptions();
  if (apiKey) options.apiKey = apiKey; // 临时透传，不落盘
  if (!options.apiKey && !process.env.OPENAI_API_KEY) return null;
  const baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = options.model || 'gpt-4o-mini';
  const dataUrl = `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}`;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey || process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: IMAGE_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 2048,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  return text && text.trim() ? text.trim() : null;
}

// bl omni 多模态理解（图片/音频/视频共用），失败返回 null
async function blOmni(flag, filePath, prompt) {
  if (!(await whichCmd('bl'))) return null;
  const { code, stdout } = await run('bl', [
    'omni', '--message', prompt, flag, filePath, '--text-only',
  ]);
  if (code !== 0) return null;
  let text = stdout.trim();
  // bl omni 部分版本输出 JSON 包装（{"content": "..."}），需解包；content 为空视为无结果继续降级
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      const inner = data.content ?? data.text ?? data.response;
      if (typeof inner === 'string') text = inner.trim();
    } catch {
      // 非 JSON，按原文返回
    }
  }
  return text || null;
}

// arkcli +chat 多模态理解（音视频兜底），失败返回 null
async function arkcliChat(filePath, prompt) {
  if (!(await whichCmd('arkcli'))) return null;
  const { code, stdout } = await run('arkcli', ['+chat', '--input', `@${filePath}`, prompt]);
  if (code !== 0) return null;
  const text = stdout.trim();
  return text || null;
}

// ffmpeg 抽取音轨转 m4a（webm 等 bl 不支持的容器），返回临时文件路径或 null
async function transcodeToM4a(filePath) {
  if (!(await whichCmd('ffmpeg'))) return null;
  const tmp = path.join(os.tmpdir(), `ai-ppt-asr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`);
  const { code } = await run('ffmpeg', ['-y', '-i', filePath, '-vn', '-c:a', 'aac', '-b:a', '96k', tmp], 180000);
  if (code !== 0 || !fs.existsSync(tmp) || !fs.statSync(tmp).size) return null;
  return tmp;
}

// bl speech recognize（FunAudio-ASR）转写，返回纯文本或 null
async function blSpeechRecognize(filePath) {
  if (!(await whichCmd('bl'))) return null;
  const { code, stdout } = await run('bl', [
    'speech', 'recognize', '--url', filePath, '--language', 'zh',
  ], 300000);
  if (code !== 0) return null;
  const text = stdout.trim();
  if (!text || text.startsWith('{')) return null; // JSON 错误输出
  // 去掉首行横幅（[Model: fun-asr] [Mode: async] [Files: 1]）
  const lines = text.split('\n');
  const body = (lines[0] && lines[0].startsWith('[Model:') ? lines.slice(1) : lines).join('\n').trim();
  return body || null;
}

// ---------- 导出：解析入口 ----------

// parseAsset(name, { apiKey }) → { text, degraded, provider }
// provider ∈ 'openai-vision' | 'pdf-parse+llm' | 'mammoth+llm' | 'bl' | 'arkcli' | 'local-extract' | 'none'
export async function parseAsset(name, { apiKey } = {}) {
  try {
    const base = String(name || '').trim();
    if (!base || /[/\\]/.test(base) || base.includes('..')) {
      return { text: '', degraded: true, provider: 'none' };
    }
    const filePath = path.join(ASSETS_DIR, base);
    if (!fs.existsSync(filePath)) {
      return { text: '', degraded: true, provider: 'none' };
    }
    const ext = path.extname(base).toLowerCase();
    const buf = fs.readFileSync(filePath);

    // 文档：本地提取 + LLM 规整
    if (DOC_EXTS.includes(ext)) {
      let raw = '';
      try {
        raw = (await extractDocText(ext, buf)).trim();
      } catch {
        return { text: '', degraded: true, provider: 'local-extract' };
      }
      if (!raw) return { text: '', degraded: true, provider: 'local-extract' };
      const organized = await organizeWithLlm(raw, apiKey);
      if (organized) {
        return { text: organized, degraded: false, provider: ext === '.pdf' ? 'pdf-parse+llm' : 'mammoth+llm' };
      }
      return { text: raw.slice(0, 2000), degraded: true, provider: 'local-extract' };
    }

    // 图片：openai 兼容视觉 → bl omni
    if (IMAGE_EXTS.includes(ext)) {
      try {
        const text = await describeImageViaOpenAI(buf, ext, apiKey);
        if (text) return { text, degraded: false, provider: 'openai-vision' };
      } catch {
        // 继续降级
      }
      const text = await blOmni('--image', filePath, IMAGE_PROMPT);
      if (text) return { text, degraded: false, provider: 'bl' };
      return { text: '', degraded: true, provider: 'none' };
    }

    // 音频/视频：语音类优先 bl speech recognize（webm 等容器先 ffmpeg 抽轨转 m4a）→ LLM 规整；视频走 bl omni → arkcli
    if (AUDIO_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) {
      const isAudio = AUDIO_EXTS.includes(ext);
      const isVoiceMemo = !isAudio && base.startsWith('voice-');
      if (isAudio || isVoiceMemo) {
        let procPath = filePath;
        let tmpPath = null;
        if (!BL_AUDIO_EXTS.includes(ext)) {
          tmpPath = await transcodeToM4a(filePath);
          if (tmpPath) procPath = tmpPath;
        }
        try {
          const transcript = await blSpeechRecognize(procPath);
          if (transcript) {
            const organized = await organizeWithLlm(transcript, apiKey);
            if (organized) return { text: organized, degraded: false, provider: 'bl-asr+llm' };
            return { text: transcript, degraded: true, provider: 'bl-asr' };
          }
          // ASR 不可用：支持音频后缀的再走 bl omni / arkcli 兜底
          const asrPrompt = '请转写这段录音的内容，并总结为中文要点列表。只输出纯文本。';
          if (BL_AUDIO_EXTS.includes(ext)) {
            const blText = await blOmni('--audio', procPath, asrPrompt);
            if (blText) return { text: blText, degraded: false, provider: 'bl' };
          }
          const arkText = await arkcliChat(procPath, asrPrompt);
          if (arkText) return { text: arkText, degraded: false, provider: 'arkcli' };
          return { text: '', degraded: true, provider: 'none' };
        } finally {
          if (tmpPath) fs.unlink(tmpPath, () => {});
        }
      }
      const videoPrompt = '请描述这段视频的内容（画面与语音），并总结为中文要点列表。只输出纯文本。';
      const blText = await blOmni('--video', filePath, videoPrompt);
      if (blText) return { text: blText, degraded: false, provider: 'bl' };
      const arkText = await arkcliChat(filePath, videoPrompt);
      if (arkText) return { text: arkText, degraded: false, provider: 'arkcli' };
      return { text: '', degraded: true, provider: 'none' };
    }

    return { text: '', degraded: true, provider: 'none' };
  } catch {
    return { text: '', degraded: true, provider: 'none' };
  }
}

// ---------- CLI：node scripts/parse-asset.mjs <name> ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    console.log('Usage: node scripts/parse-asset.mjs <vault/assets 下的文件名>');
    process.exit(1);
  }
  const result = await parseAsset(name);
  console.log(JSON.stringify({ degraded: result.degraded, provider: result.provider }));
  console.log(result.text || '(无内容)');
}
