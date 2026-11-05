// scripts/sources/text-extract.mjs — 按扩展名把文件/响应体统一抽成纯文本/Markdown。
// 只处理文本类（md/txt/html/csv/json/docx/pdf）；图片/视频/二进制归类为 media（仅记录存在，不拉正文）。
// docx→mammoth、pdf→pdf-parse v2(PDFParse)、html→content-extractor.extractFromHtml，均为已在 package.json 的依赖。
import fs from 'node:fs';
import path from 'node:path';
import { extractFromHtml } from './net.mjs';

// 单个文件原始读取硬上限（超过则视为二进制/过大，只记录不抽取）
export const HARD_READ_CAP = 50 * 1024 * 1024;

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.html', '.htm', '.csv', '.json', '.docx', '.pdf']);
const MEDIA_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp', '.tiff',
  '.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv',
  '.mp3', '.wav', '.m4a', '.ogg', '.flac',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2',
  '.exe', '.dmg', '.iso', '.apk',
]);

export function extOf(p) {
  return path.extname(String(p)).toLowerCase();
}

/** 'text' | 'media' | 'unknown' */
export function classifyExt(ext) {
  const e = String(ext).toLowerCase();
  if (TEXT_EXT.has(e)) return 'text';
  if (MEDIA_EXT.has(e)) return 'media';
  return 'unknown';
}

export function isTextExt(ext) {
  return classifyExt(ext) === 'text';
}

// csv → 简单的按行 "| " 连接文本表格（保留换行；不做引号内换行的复杂解析）
function csvToText(raw) {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.split(',').map((c) => c.trim()).filter(Boolean).join(' | '))
    .join('\n')
    .trim();
}

function jsonToText(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw.trim();
  }
}

// 从 buffer 抽取（url/site 的 .pdf/.docx 之类下载不走这里；主要供 dir/vault 用）
async function extractFromBuffer(ext, buf) {
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return buf.toString('utf8');
  if (ext === '.html' || ext === '.htm') return extractFromHtml(buf.toString('utf8'));
  if (ext === '.csv') return csvToText(buf.toString('utf8'));
  if (ext === '.json') return jsonToText(buf.toString('utf8'));
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    return String(r?.value || '');
  }
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buf });
    try {
      const r = await parser.getText();
      return String(r?.text || '');
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  return '';
}

/**
 * 抽取文件正文（不截断；截断由采集器按 maxBytesPerItem 统一处理）。
 * @returns {Promise<{text:string, kind:'text'|'media'|'unknown', skipped?:string}>}
 */
export async function extractFileText(absPath) {
  const ext = extOf(absPath);
  const kind = classifyExt(ext);
  if (kind === 'media') return { text: '', kind: 'media', skipped: 'binary/media' };
  if (kind !== 'text') return { text: '', kind: 'unknown', skipped: 'non-text' };
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    throw new Error(`无法读取文件：${err.message}`);
  }
  if (stat.size > HARD_READ_CAP) return { text: '', kind: 'media', skipped: `too large (${stat.size} bytes)` };
  const buf = fs.readFileSync(absPath);
  const text = await extractFromBuffer(ext, buf);
  return { text, kind: 'text' };
}

/** 从 HTML 字符串直接抽正文（url/site 用）。 */
export function htmlToText(html) {
  return extractFromHtml(html);
}

/**
 * 按字节上限截断正文（UTF-8 安全：先按 Buffer 切再回字符串），返回 {text,truncated,bytes}。
 */
export function capByBytes(text, maxBytes) {
  const s = String(text ?? '');
  const full = Buffer.from(s, 'utf8');
  if (!Number.isFinite(maxBytes) || full.byteLength <= maxBytes) {
    return { text: s, truncated: false, bytes: full.byteLength };
  }
  // 在 maxBytes 处可能切断多字节字符：回退到最近的合法 UTF-8 边界
  let end = maxBytes;
  while (end > 0 && (full[end] & 0xc0) === 0x80) end--; // 跳过 continuation byte
  const slice = full.subarray(0, end).toString('utf8');
  return { text: slice, truncated: true, bytes: end };
}
