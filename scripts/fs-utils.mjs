// scripts/fs-utils.mjs — 原子写工具：同目录临时文件 + fsync + rename（POSIX rename 原子）。
// 进程崩溃只会留下 .tmp 临时文件，不会出现截断的目标文件。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子写入文件（content 为字符串或 Buffer）。目标目录不存在时自动创建。
 * 失败时清理临时文件并抛出原错误。
 */
export function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** 原子写入 JSON（2 空格缩进，与原 JSON.stringify(obj, null, 2) 写盘格式一致） */
export function writeJsonAtomic(filePath, obj) {
  writeFileAtomic(filePath, JSON.stringify(obj, null, 2));
}
