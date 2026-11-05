// scripts/marketing/paths.mjs — 营销模块路径基准（与 scripts/sources/paths.mjs 同风格：
// 函数式读取 + 环境变量覆盖，便于测试注入临时目录，也便于整体搬家）。
// marketing/ 在仓库根，已被 .gitignore 锚定忽略（/marketing/），属生成物不入库。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/marketing/ -> scripts/ -> repo ROOT
export const ROOT = path.resolve(__dirname, '..', '..');

/** 营销生成物根目录（默认仓库根 marketing/） */
export function marketingRoot() {
  return process.env.AI_PPT_MARKETING_ROOT || path.join(ROOT, 'marketing');
}

/** 营销大纲目录：marketing/outlines */
export function outlinesDir() {
  return path.join(marketingRoot(), 'outlines');
}

/** 单份大纲文件路径 */
export function outlinePath(outlineId) {
  return path.join(outlinesDir(), `${outlineId}.json`);
}
