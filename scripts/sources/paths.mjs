// scripts/sources/paths.mjs — 素材源模块的路径基准与共享守卫。
// sources.json 与抓取缓存目录均可用环境变量覆盖（测试用临时目录注入），
// 函数式读取（非模块加载常量），使运行期改 env 立即生效。
import fs from 'node:fs';
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

/**
 * 解析符号链接得到真实路径（P2-B：词法路径可被仓库内软链同时越过 ROOT 归属与敏感清单）。
 * 失败（路径不存在/无权限）返回 null，由调用方决定拒绝还是降级——绝不静默当作安全。
 */
export function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// 抓取递归时绝不进入的目录名（mission 红线：即便被包在源 target 之内也不碰）
export const FORBIDDEN_DIR_SEGMENTS = new Set([
  '.git', '.backup', '.snapshots', 'node_modules',
]);

// 敏感位置拒绝清单（P1-1a）：这些目录段/绝对前缀既不能作为源 target，
// 也不能作为其中任一待收条目出现。fail-closed——命中即拒。
export const SENSITIVE_DIR_SEGMENTS = new Set([
  '.ssh', '.aws', '.docker', '.config', '.gnupg', 'keychain', 'keychains',
]);
// 绝对路径前缀：这些目录整体禁止作为源（评审点名 /etc、/private/etc、/var/root）。
export const SENSITIVE_PATH_PREFIXES = ['/etc', '/private/etc', '/var/root'];
// 敏感文件名 basename 模式（作用于每个待收条目文件名；扩展名白名单挡不住的也要靠它）。
// 收窄原则（P2-E）：只拦真正的密钥/凭据命名，不误伤产品文档里常见的 id_mapping.md /
// ID_list.csv / id_index.md / credentials-api.md。SSH 私钥文件是无扩展名的 id_rsa/id_ed25519…，
// 故 id_ 模式要求整段精确匹配（不含扩展名），而非 ^id_.+ 前缀（后者会吃掉一切 id_* 文档）。
const SENSITIVE_BASENAME_RES = [
  /^\.env(\..*)?$/i,   // .env, .env.local, .env.kimi
  /\.pem$/i,
  /\.key$/i,
  /^id_(rsa|dsa|ecdsa|ed25519|ed448|openid-tokendb)$/i, // SSH/Kerberos 私钥本体（无扩展名）
  /^credentials(\..*)?$/i, // credentials, credentials.json（不含 credentials-api.md）
  /\.p12$/i,
  /\.pfx$/i,
  // 本仓运行态配置：AGENTS.md 条目 4 声明 apiKey 不落盘，泄的是配置形态；清单已建无理由不漏（P2-E 反向漏放）。
  /^\.ai-ppt-config\.json$/i,
  /^\.ai-ppt-tasks\.json$/i,
];

function pathSegments(absResolved) {
  return String(absResolved).split(path.sep).filter(Boolean);
}

// 大小写不敏感文件系统（darwin 默认卷、win32）上 ~/.SSH 与 ~/.ssh 是同一目录，
// 精确段匹配会漏放（P2-B 第 3 条）。仅对这两类平台把参与比较的段/前缀折叠为小写；
// Linux 上二者是真实不同目录，保持大小写敏感以免误伤。
// 注意：折叠大小写不影响 `/config`(段=config) 与 `.config`(段=.config) 的区分——它们差在前导点，不在大小写。
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const foldCase = (s) => (CASE_INSENSITIVE_FS ? String(s).toLowerCase() : String(s));

/** 是否命中禁入目录段（.git/.backup/.snapshots/node_modules）——基于绝对路径本身，绝不从不可信 target 求相对。 */
export function hasForbiddenSegment(absPath) {
  return pathSegments(path.resolve(absPath)).some((seg) => FORBIDDEN_DIR_SEGMENTS.has(foldCase(seg)));
}

/** 是否命中敏感目录段/前缀（.ssh/.aws/... 或 /etc 等前缀）——基于绝对路径本身。 */
export function hasSensitiveSegment(absPath) {
  const resolved = path.resolve(absPath);
  const cmp = CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
  if (SENSITIVE_PATH_PREFIXES.some((p) => { const c = CASE_INSENSITIVE_FS ? p.toLowerCase() : p; return cmp === c || cmp.startsWith(c + '/'); })) return true;
  return pathSegments(resolved).some((seg) => SENSITIVE_DIR_SEGMENTS.has(foldCase(seg)));
}

/** 文件名是否命中敏感 basename 模式。 */
export function hasSensitiveBasename(absPath) {
  const base = path.basename(String(absPath));
  return SENSITIVE_BASENAME_RES.some((re) => re.test(base));
}

/** 综合敏感判定：目录段/前缀 或 basename 命中。用于 target 与每一条待收条目。 */
export function isSensitivePath(absPath) {
  return hasSensitiveSegment(absPath) || hasSensitiveBasename(absPath);
}

/**
 * 判断某个绝对路径是否落在禁入目录内。
 * 关键修正（P1-2）：只依据**绝对路径自身的路径段**判断，绝不接受"以不可信 target 为基准求相对"——
 * 否则当 target 本身就是 .git/.backup/... 时，禁入段会被从基准里减掉而整体失效。
 * 第二个参数保留以兼容旧调用，但被忽略。
 */
export function isForbiddenPath(absPath, _rootForRelative) {
  return hasForbiddenSegment(absPath);
}

/** 解析后的 target 是否仍限定在 root 之内（防 ../ 越界）。 */
export function isWithinRoot(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}
