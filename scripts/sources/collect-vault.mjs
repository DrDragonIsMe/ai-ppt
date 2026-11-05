// scripts/sources/collect-vault.mjs — vault 类型采集器：把现有 vault 笔记归一成同形状素材条目（只读）。
// target（可选）= vault/ 下的相对子目录，限定采集范围；跳过隐藏目录（.meta 等，避免抓进自己的缓存）；
// options.include 过滤路径（默认 **/*.md）；options.anyOfTags（可选）按笔记 Front Matter tags 过滤。
// 绝不写 vault 任何业务内容——写盘只发生在 source-cache（由编排器负责）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, isForbiddenPath, isSensitivePath } from './paths.mjs';
import { matchesAny } from './glob.mjs';
import { requireFiniteOption } from './registry.mjs';
import { parseFrontMatter } from '../front-matter.mjs';

function vaultBase(ctx) {
  return ctx.vaultRoot || path.join(ROOT, 'vault');
}

function titleOfNote(relPath, fm, content) {
  if (fm && typeof fm.title === 'string' && fm.title.trim()) return fm.title.trim().slice(0, 200);
  const m = String(content || '').match(/^#\s+(.+)$/m);
  if (m && m[1].trim()) return m[1].trim().slice(0, 200);
  return path.basename(relPath).replace(/\.[^.]+$/, '');
}

/**
 * @param {object} source
 * @param {{vaultRoot?:string,onProgress?:(msg:string,detail?:any)=>void}} [ctx]
 */
export async function* collectVault(source, ctx = {}) {
  const vaultRoot = path.resolve(vaultBase(ctx));
  const sub = String(source.target || '').replace(/^\/+|\/+$/g, '');
  const scopeRoot = sub ? path.resolve(vaultRoot, sub) : vaultRoot;

  // 守卫：scope 必须仍在 vault 内（registry 已校验，这里二次防护）
  if (scopeRoot !== vaultRoot && !scopeRoot.startsWith(vaultRoot + path.sep)) {
    const err = new Error(`vault 源 target 越出 vault 目录：${sub}`);
    err.statusCode = 400;
    throw err;
  }
  let stat;
  try {
    stat = fs.statSync(scopeRoot);
  } catch {
    const err = new Error(`vault 目录不存在：${scopeRoot}`);
    err.statusCode = 500;
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`vault target 不是目录：${scopeRoot}`);
    err.statusCode = 400;
    throw err;
  }

  const include = Array.isArray(source.options?.include) && source.options.include.length
    ? source.options.include
    : ['**/*.md'];
  const anyOfTags = Array.isArray(source.options?.anyOfTags) ? source.options.anyOfTags : null;
  const globalTags = source.tags || [];

  const cap = requireFiniteOption(source, 'maxPages');

  const stack = [scopeRoot];
  const visited = new Set();
  let collected = 0;
  let dropped = 0; // 因超过 maxPages 而未入库的合格笔记数

  while (stack.length) {
    const dir = stack.pop();
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      yield { kind: 'error', origin: dir, error: `读取失败 ${dir}: ${err.message}` };
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      // P1-1a / P1-2 纵深：即便 target 已限在 vault 内，条目路径命中禁入/敏感清单也一律跳过。
      if (isForbiddenPath(abs) || isSensitivePath(abs)) continue;
      const rel = path.relative(vaultRoot, abs).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.')) continue; // 跳过 .meta 等隐藏目录
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!/\.(md|markdown)$/i.test(ent.name)) continue;
      if (!matchesAny(rel, include)) continue;

      let raw;
      try {
        raw = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        yield { kind: 'error', origin: rel, error: `读取失败 ${rel}: ${err.message}` };
        continue;
      }
      const { frontMatter, content } = parseFrontMatter(raw);
      if (anyOfTags) {
        const noteTags = Array.isArray(frontMatter.tags)
          ? frontMatter.tags.map((t) => String(t))
          : (frontMatter.tags ? [String(frontMatter.tags)] : []);
        if (!anyOfTags.some((t) => noteTags.includes(t))) continue;
      }
      if (collected >= cap) { dropped++; continue; } // 合格但超上限：如实计数，不入库
      collected++;
      yield {
        kind: 'text',
        origin: rel,
        originKey: rel,
        title: titleOfNote(rel, frontMatter, content),
        body: content.replace(/^\s*\n+/, '').trim(),
        tags: [...globalTags],
      };
      ctx.onProgress?.(`采集笔记 ${rel}`, { index: collected });
    }
  }

  if (dropped > 0) {
    yield { kind: 'summary', collected, dropped, total: collected + dropped, cap };
  }
}
