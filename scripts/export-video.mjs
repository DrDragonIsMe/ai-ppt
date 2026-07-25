#!/usr/bin/env node
// scripts/export-video.mjs — Deck → 视频导出（CLI + 库，NDJSON 协议同 export-pdf）
// 管线：puppeteer 逐页截 1280×800 PNG → ffmpeg concat 静帧合成 mp4。
// 说明：scripts/media-gen.mjs 当前只有图片/视频生成 provider，没有 TTS 能力，
// 因此本版本为「无旁白静帧版」（每页固定时长，--duration 可调，默认 4s）；
// extractSlideTexts 已实现旁白文本提取（.speaker-note 优先），供将来接入 TTS 使用。
// 降级：ffmpeg 缺失或合成失败时，仅输出逐帧 PNG 到 export/frames/ 并在 done 事件说明。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { load } from 'cheerio';
import { getProjectDir, ROOT_DIR } from './config.mjs';
import { captureSlideFrames, PAGE_WIDTH, PAGE_HEIGHT } from './deck-capture.mjs';
import { emit, emitDone, emitError } from './generation-common.mjs';

export const DEFAULT_SLIDE_DURATION = 4;
export const DEFAULT_FPS = 30;

// 产物相对路径与下载 URL（done 事件携带，前端直接触发下载）
function downloadInfo(file) {
  const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
  return { file: rel, downloadUrl: '/' + rel };
}

// ---------- 纯函数（可单测） ----------

// 每页旁白文本：优先 .speaker-note 内容，否则页面标题（h1/h2）+ 要点（li）。
// 输入 deck 的 index.html 内容，返回与页数等长的字符串数组（可为空串）。
export function extractSlideTexts(html) {
  const $ = load(html);
  const texts = [];
  $('main.stage section.slide').each((_, el) => {
    const $slide = $(el);
    const note = $slide.find('.speaker-note').first().text().trim();
    if (note) { texts.push(note); return; }
    const parts = [];
    const title = $slide.find('h1, h2').first().text().trim();
    if (title) parts.push(title);
    $slide.find('li').each((_, li) => {
      const t = $(li).text().trim();
      if (t) parts.push(t);
    });
    texts.push(parts.join('。'));
  });
  return texts;
}

// 每页时长数组：perSlide 为标量时填充 count 项；为数组时按 count 截断/以末值补齐。
export function computeDurations(count, perSlide = DEFAULT_SLIDE_DURATION) {
  if (count <= 0) return [];
  if (Array.isArray(perSlide)) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const v = perSlide[Math.min(i, perSlide.length - 1)];
      out.push(normalizeDuration(v));
    }
    return out;
  }
  return Array.from({ length: count }, () => normalizeDuration(perSlide));
}

function normalizeDuration(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SLIDE_DURATION;
}

// ffmpeg concat demuxer 输入清单：每条 file + duration，末帧需再写一次无 duration 的 file
// （concat demuxer 对最后一条 duration 不生效的已知行为）。
export function buildConcatList(frameFiles, durations) {
  const lines = [];
  frameFiles.forEach((f, i) => {
    lines.push(`file '${String(f).replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${durations[i]}`);
  });
  if (frameFiles.length > 0) {
    lines.push(`file '${String(frameFiles[frameFiles.length - 1]).replace(/'/g, "'\\''")}'`);
  }
  return lines.join('\n') + '\n';
}

// ffmpeg 参数：concat 静帧 → H.264 mp4（yuv420p 保证播放器兼容，faststart 便于网络播放）
// seconds 为总时长上限：concat 清单的末帧重复条目会多贡献一个末页时长
// （concat demuxer 已知行为），用 -t 精确裁到 Σ每页时长。
export function buildFfmpegArgs({ concatFile, fps = DEFAULT_FPS, outFile, seconds }) {
  const args = [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-vf', `fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-movflags', '+faststart',
  ];
  if (Number.isFinite(seconds) && seconds > 0) args.push('-t', String(seconds));
  args.push(outFile);
  return args;
}

// ---------- ffmpeg 定位与执行 ----------

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const r = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* PATH 查找失败 */ }
  return null;
}

function runFfmpeg(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

// ---------- 主导出流程 ----------

// opts: { duration?: number|number[], fps?: number }
// 返回 { file } 或 { framesDir, fallback: true }
export async function exportVideo(name, opts = {}, onProgress) {
  const projectDir = getProjectDir(name);
  const indexHtml = path.join(projectDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`项目 ${name} 的 index.html 不存在`);
  }

  // 旁白文本提取（当前无 TTS，仅用于进度提示；将来接 TTS 时按页驱动）
  const slideTexts = extractSlideTexts(fs.readFileSync(indexHtml, 'utf8'));
  const withNotes = slideTexts.filter(Boolean).length;
  onProgress?.('prepare', `共 ${slideTexts.length} 页（${withNotes} 页可提取旁白文本，当前版本不合成语音）`);

  const images = await captureSlideFrames(indexHtml, onProgress);

  const exportDir = path.join(projectDir, 'export');
  const framesDir = path.join(exportDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  onProgress?.('frames', `正在写入 ${images.length} 帧 PNG`);
  const frameFiles = [];
  images.forEach((buf, i) => {
    const f = path.join(framesDir, `frame-${String(i + 1).padStart(3, '0')}.png`);
    fs.writeFileSync(f, buf);
    frameFiles.push(f);
  });

  const durations = computeDurations(images.length, opts.duration ?? DEFAULT_SLIDE_DURATION);
  const fps = Number.isFinite(Number(opts.fps)) && Number(opts.fps) > 0 ? Number(opts.fps) : DEFAULT_FPS;
  const totalSeconds = durations.reduce((a, b) => a + b, 0);

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    return { fallback: true, framesDir, message: '未找到 ffmpeg，已输出逐帧 PNG 到 export/frames/' };
  }

  onProgress?.('encode', `正在用 ffmpeg 合成 mp4（${images.length} 页 × ${durations[0]}s @ ${fps}fps）`);
  const concatFile = path.join(framesDir, 'concat.txt');
  fs.writeFileSync(concatFile, buildConcatList(frameFiles, durations), 'utf8');
  const outFile = path.join(exportDir, 'deck.mp4');
  const { code, stderr } = await runFfmpeg(ffmpeg, buildFfmpegArgs({ concatFile, fps, outFile, seconds: totalSeconds }));
  if (code !== 0 || !fs.existsSync(outFile)) {
    try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
    return {
      fallback: true,
      framesDir,
      message: `ffmpeg 合成失败（退出码 ${code}），已输出逐帧 PNG 到 export/frames/：${String(stderr).trim().slice(-300)}`,
    };
  }

  return { fallback: false, file: outFile, width: PAGE_WIDTH, height: PAGE_HEIGHT, seconds: totalSeconds };
}

// CLI：NDJSON 协议输出到 stdout（progress/done/error，与 generate-deck.mjs 一致）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const name = args[0];
  if (!name) {
    console.error('Usage: node scripts/export-video.mjs <project> [--duration <秒>] [--fps <帧率>]');
    process.exit(1);
  }
  const opts = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--duration') opts.duration = Number(args[++i]);
    else if (args[i] === '--fps') opts.fps = Number(args[++i]);
  }
  exportVideo(name, opts, (step, message) => emit(step, message))
    .then((result) => {
      if (result.fallback) {
        const rel = path.relative(ROOT_DIR, result.framesDir).replace(/\\/g, '/');
        emitDone({ frames: rel, note: result.message });
      } else {
        emitDone({ ...downloadInfo(result.file), seconds: result.seconds });
      }
    })
    .catch((err) => {
      emitError(err.stack || err.message);
      process.exit(1);
    });
}
