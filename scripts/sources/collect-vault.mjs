// scripts/sources/collect-vault.mjs — vault 类型采集器：把现有 vault 笔记归一成同形状素材条目（只读）。
// target（可选）= vault/ 下的相对子目录，限定采集范围；跳过隐藏目录（.meta 等，避免抓进自己的缓存）；
// options.include 过滤路径（默认 **/*.md）；options.anyOfTags（可选）按笔记 Front Matter tags 过滤。
// 绝不写 vault 任何业务内容——写盘只发生在 source-cache（由编排器负责）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, isForbiddenPath, isSensitivePath, safeRealpath, hasForbiddenSegment, hasSensitiveSegment } from './paths.mjs';
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
  // P2-B：vaultRoot/target 若本身是软链，解析后仍不得落在禁入/敏感位置（词法归属挡不住仓库外软链）。
  const scopeReal = safeRealpath(scopeRoot) ?? scopeRoot;
  if (hasForbiddenSegment(scopeReal) || hasSensitiveSegment(scopeReal)) {
    const err = new Error(`vault 源 target 解析符号链接后命中禁入/敏感清单：${scopeReal}`);
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
  let policySkipped = 0; // P2-E：命中禁入/敏感清单而跳过的条目数（可观测，不再静默）
  const policySamples = [];
  const bumpPolicy = (rel) => { policySkipped++; if (policySamples.length < 10) policySamples.push(rel); };

  while (stack.length) {
    const dir = stack.pop();
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // P2-B：整个 vault 根（scopeRoot）读不到 = 配置坏了或挂载没就绪 → 响亮失败（reject），
      // 与 collect-dir 根不存在/不可访问时 reject、manifest 不动的既有语义对齐。绝不 yield 一条
      // origin 为空串的目录级错误——空串 falsy 会被 refresh 的 `if (entry.origin)` 整体丢弃、零记账，
      // 今天全靠"单根 DFS 根失败必然 0 入库"这一巧合被闸门接住；一旦将来多根/BFS 让根失败与部分成功共存，
      // 整个 vault 缓存会被 prune 兜底分支静默清空。根级失败改为 reject 后彻底摆脱该巧合。
      if (dir === scopeRoot) {
        const e = new Error(`vault 源根目录不可读：${scopeRoot}: ${err.message}`);
        e.statusCode = 500;
        throw e;
      }
      // isDirectoryLevel：读子目录失败 ≠ 目录下笔记已删除——P2-② 据此判为未确认失败、子树 stale 保命。
      // P2-③：origin 用与条目同源（path.relative(vaultRoot, dir)）的相对形式——原先是绝对 dir，
      // 而 refresh 侧条目 origin 是 rel（形如 sub/s0.md），erroredPrefixes 前缀（dir + sep）永不命中相对 origin，
      // 导致 vault 源目录级失败退回 r3 判 P2-F 的原始缺陷（实测 removed=3/stale=0）。改相对后前缀语义自然成立。
      // P2-B：非根目录级错误 origin 不得为空串（relDir 非空恒成立因 dir!==scopeRoot，仍加 `|| '.'` 兜底辨识标签）。
      const relDir = path.relative(vaultRoot, dir) || '.';
      yield { kind: 'error', origin: relDir, error: `读取失败 ${dir}: ${err.message}`, code: err.code, isDirectoryLevel: true };
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(vaultRoot, abs).split(path.sep).join('/');
      // P1-1a / P1-2 纵深：即便 target 已限在 vault 内，条目路径命中禁入/敏感清单也一律跳过——
      // 命中数计入 policySkipped 并上报（P2-E，不再静默丢弃）。
      if (isForbiddenPath(abs) || isSensitivePath(abs)) { bumpPolicy(rel); continue; }
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
        yield { kind: 'error', origin: rel, error: `读取失败 ${rel}: ${err.message}`, code: err.code };
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
  // P2-E：命中禁入/敏感清单而跳过的条目单独上报（可观测，不再静默丢弃）。
  if (policySkipped > 0) {
    yield { kind: 'policy', skipped: policySkipped, samples: policySamples };
  }
}
