// scripts/sources/paths.mjs — 素材源模块的路径基准与共享守卫。
// sources.json 与抓取缓存目录均可用环境变量覆盖（测试用临时目录注入），
// 函数式读取（非模块加载常量），使运行期改 env 立即生效。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/sources/ -> scripts/ -> repo ROOT
export const ROOT = path.resolve(__dirname, '..', '..');

/** 源注册表文件路径（默认仓库根 sources.json，已 gitignore） */
export function sourcesFile() {
  return process.env.AI_PPT_SOURCES_FILE || path.join(ROOT, 'sources.json');
}

/** 抓取缓存根目录（默认 vault/.meta/source-cache，已 gitignore） */
export function cacheRoot() {
  return process.env.AI_PPT_SOURCE_CACHE_ROOT || path.join(ROOT, 'vault', '.meta', 'source-cache');
}

/** 某个源的缓存目录：cacheRoot/<sourceId> */
export function sourceCacheDir(sourceId) {
  return path.join(cacheRoot(), sourceId);
}

/** 某个源的条目目录：cacheRoot/<sourceId>/items */
export function sourceItemsDir(sourceId) {
  return path.join(sourceCacheDir(sourceId), 'items');
}

/** 某个源的 manifest 路径 */
export function sourceManifestPath(sourceId) {
  return path.join(sourceCacheDir(sourceId), 'manifest.json');
}

// 抓取递归时绝不进入的目录名（即使被包含在源 target 之内）
export const FORBIDDEN_DIR_SEGMENTS = new Set([
  '.git', '.backup', '.snapshots', 'node_modules',
]);

/**
 * 判断某个绝对路径是否落在禁入目录内（任意路径段命中 FORBIDDEN_DIR_SEGMENTS）。
 * @param {string} absPath
 * @param {string} [rootForRelative] 相对基准；提供时只检查相对部分，避免把 root 自身路径段误判
 */
export function isForbiddenPath(absPath, rootForRelative) {
  let rel = String(absPath);
  if (rootForRelative) {
    const root = path.resolve(rootForRelative);
    const target = path.resolve(absPath);
    if (target === root) return false;
    if (target.startsWith(root + path.sep)) rel = path.relative(root, target);
  }
  const segments = rel.split(path.sep);
  return segments.some((seg) => FORBIDDEN_DIR_SEGMENTS.has(seg));
}

/** 解析后的 target 是否仍限定在 root 之内（防 ../ 越界）。 */
export function isWithinRoot(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}
