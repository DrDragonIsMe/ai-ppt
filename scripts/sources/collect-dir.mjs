// scripts/sources/collect-dir.mjs — dir 类型采集器：递归采集文本类文件为“原始条目”。
// 受 options.include（glob 列表）与 options.maxPages（条目上限）控制；
// 拒绝越出源根目录（含 symlink 目录不跟随）；禁入段（.git/.backup/.snapshots/node_modules）基于绝对路径判定，
// 敏感位置/basename 拒绝清单（见 paths.mjs，P1-1）在 target 与其下每一条候选上双重生效。
// 每条文本条目在此就地抽正文（md/txt/html/csv/json/docx/pdf），抽正文失败降级为 error 条目、不中断整批。
import fs from 'node:fs';
import path from 'node:path';
import { isWithinRoot, isForbiddenPath, isSensitivePath } from './paths.mjs';
import { matchesAny } from './glob.mjs';
import { requireFiniteOption } from './registry.mjs';
import { extOf, classifyExt, extractFileText } from './text-extract.mjs';

function titleFromHead(absPath, relPath) {
  const base = path.basename(relPath).replace(/\.[^.]+$/, '');
  try {
    const fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString('utf8');
    const m = head.match(/^#\s+(.+)$/m);
    if (m && m[1].trim()) return m[1].trim().slice(0, 200);
  } catch { /* 读不到就用文件名 */ }
  return base;
}

/**
 * 异步生成 dir 源的原始条目：{origin,originKey,title,kind,body,note?} 或 {kind:'error',origin,error}。
 * @param {object} source
 * @param {{onProgress?:(msg:string,detail?:any)=>void}} [ctx]
 */
export async function* collectDir(source, ctx = {}) {
  const root = path.resolve(source.target);
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    const err = new Error(`目录不存在或无法访问：${root}`);
    err.statusCode = 500;
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`target 不是目录：${root}`);
    err.statusCode = 400;
    throw err;
  }

  const include = Array.isArray(source.options?.include) && source.options.include.length
    ? source.options.include
    : null;
  const cap = requireFiniteOption(source, 'maxPages');
  const tags = source.tags || [];

  const stack = [root];
  let collected = 0;
  let eligible = 0; // include 命中的文本/素材文件总数（含因超上限被丢弃的）
  const visited = new Set();

  while (stack.length) {
    const dir = stack.pop();
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      yield { kind: 'error', origin: dir, error: `读取目录失败 ${dir}: ${err.message}` };
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');

      let realAbs = abs;
      if (ent.isSymbolicLink()) {
        try { realAbs = fs.realpathSync(abs); } catch { continue; }
        if (!isWithinRoot(root, realAbs)) continue; // symlink 越界 → 拒绝
      }
      // 禁入目录段（基于绝对路径判定，P1-2）+ 敏感位置/basename 拒绝清单（P1-1a）：
      // 命中即整条跳过——目录不进入、文件不入库。对 symlink 亦以解析后的真实路径判定。
      if (isForbiddenPath(realAbs) || isSensitivePath(realAbs)) continue;

      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        try {
          const st = fs.statSync(realAbs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch { continue; }
      }

      if (isDir) {
        stack.push(ent.isSymbolicLink() ? realAbs : abs);
        continue;
      }
      if (!isFile) continue;

      const ext = extOf(ent.name);
      const kind = classifyExt(ext);
      if (kind === 'unknown') continue;
      const pathOk = include ? matchesAny(rel, include) : kind === 'text'; // 默认只收文本；media 需显式 include 命中
      if (!pathOk) continue;

      eligible++;
      // 超过 maxPages：仍继续遍历以如实统计丢弃数，但不再读取正文/入库
      if (collected >= cap) continue;
      collected++;

      if (kind === 'media') {
        yield {
          kind: 'media',
          origin: abs,
          originKey: abs,
          title: path.basename(rel),
          note: 'binary/media asset — 仅记录存在，未提取正文',
          tags: [...tags],
        };
        ctx.onProgress?.(`记录素材(不抽取) ${rel}`);
        continue;
      }

      // 文本：就地抽取
      const readPath = ent.isSymbolicLink() ? realAbs : abs;
      try {
        const { text } = await extractFileText(readPath);
        yield {
          kind: 'text',
          origin: abs,
          originKey: abs,
          title: titleFromHead(readPath, rel),
          body: text,
          tags: [...tags],
        };
        ctx.onProgress?.(`采集 ${rel}`, { index: collected });
      } catch (err) {
        yield { kind: 'error', origin: abs, error: `抽取失败 ${rel}: ${err.message}` };
      }
    }
  }

  const dropped = eligible - collected;
  if (dropped > 0) {
    yield { kind: 'summary', collected, dropped, total: eligible, cap };
  }
}
