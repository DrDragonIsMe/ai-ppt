// scripts/sources/glob.mjs — 零依赖的最小 glob 匹配（dir 源 include 过滤用）。
// 支持 **（跨目录）、*（段内）、?（单字符）；路径以 / 分隔。足够覆盖 **/*.md 这类模式。
function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRe(glob) {
  let out = '';
  let i = 0;
  const g = String(glob);
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // ** : 贪婪跨目录；**/ 允许匹配 0 个目录
        if (g[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += escapeRe(c);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

const cache = new Map();
function toRe(glob) {
  let re = cache.get(glob);
  if (!re) {
    re = globToRe(glob);
    cache.set(glob, re);
  }
  return re;
}

/** 单个 glob 是否匹配（relPath 用 / 分隔、不以 / 开头）。 */
export function globMatch(glob, relPath) {
  const rel = String(relPath).replace(/^\/+/, '');
  return toRe(glob).test(rel);
}

/** 任一 glob 匹配即真；patterns 为空视为不限制（返回 true）。 */
export function matchesAny(relPath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  return patterns.some((g) => globMatch(g, relPath));
}
