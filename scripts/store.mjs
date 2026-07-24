// scripts/store.mjs — 轻量数据访问层：统一文件读写接口，原子写入，变更通知。
// 底层仍基于文件系统，后续可无缝替换为 SQLite。
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontMatter, stringifyFrontMatter } from './front-matter.mjs';
import { writeFileAtomic } from './fs-utils.mjs';

/**
 * FileStore：基于文件的 KV 存储。
 * - JSON 模式（默认）：每个条目是一个 .json 文件
 * - Markdown 模式（ext='.md'）：Front Matter + body
 *
 * 写入采用原子策略（先写 .tmp 再 rename），避免进程崩溃导致数据损坏。
 * 变更通过 listeners 通知（用于搜索索引增量更新等场景）。
 */
export class FileStore {
    /**
     * @param {string} baseDir - 存储目录的绝对路径
     * @param {{ ext?: string }} [opts]
     */
    constructor(baseDir, opts = {}) {
        this.baseDir = path.resolve(baseDir);
        this.ext = opts.ext || '.json';
        this._listeners = new Set();
        this._ensureDir();
    }

    // ============================================================
    // 事件系统
    // ============================================================
    on(event, fn) {
        if (event === 'change') this._listeners.add(fn);
        return this;
    }

    off(event, fn) {
        if (event === 'change') this._listeners.delete(fn);
        return this;
    }

    _emit(type, id) {
        for (const fn of this._listeners) {
            try { fn(type, id); } catch { /* ignore listener errors */ }
        }
    }

    // ============================================================
    // 目录级操作
    // ============================================================
    _ensureDir() {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    /** 列出所有条目 ID（不含扩展名） */
    list() {
        if (!fs.existsSync(this.baseDir)) return [];
        return fs.readdirSync(this.baseDir, { withFileTypes: true })
            .filter(e => e.isFile() && e.name.endsWith(this.ext))
            .map(e => e.name.slice(0, -this.ext.length));
    }

    /** 条目是否存在 */
    exists(id) {
        return fs.existsSync(this._filePath(id));
    }

    /** 条目最后修改时间 */
    mtime(id) {
        const p = this._filePath(id);
        if (!fs.existsSync(p)) return null;
        return fs.statSync(p).mtime;
    }

    // ============================================================
    // JSON 模式读写
    // ============================================================
    /** 读取 JSON 对象 */
    get(id) {
        const p = this._filePath(id);
        if (!fs.existsSync(p)) return null;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            return null;
        }
    }

    /** 写入 JSON 对象（原子写入） */
    set(id, data) {
        const p = this._filePath(id);
        this._atomicWrite(p, JSON.stringify(data, null, 2));
        this._emit('set', id);
    }

    /** 删除条目 */
    delete(id) {
        const p = this._filePath(id);
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            this._emit('delete', id);
            return true;
        }
        return false;
    }

    // ============================================================
    // Markdown 模式读写（Front Matter + body）
    // ============================================================
    /** 读取 Markdown 文件，返回 { meta, body } */
    getMarkdown(id) {
        const p = this._filePath(id);
        if (!fs.existsSync(p)) return null;
        try {
            const raw = fs.readFileSync(p, 'utf8');
            return parseMarkdownFrontMatter(raw);
        } catch {
            return null;
        }
    }

    /** 写入 Markdown 文件（Front Matter + body） */
    setMarkdown(id, meta, body) {
        const p = this._filePath(id);
        const metaStr = stringifyFrontMatter(meta);
        const content = metaStr ? `${metaStr}\n${body}\n` : `---\n\n---\n\n${body}\n`;
        this._atomicWrite(p, content);
        this._emit('set', id);
    }

    /** 读取原始文本 */
    getRaw(id) {
        const p = this._filePath(id);
        if (!fs.existsSync(p)) return null;
        try {
            return fs.readFileSync(p, 'utf8');
        } catch {
            return null;
        }
    }

    /** 写入原始文本 */
    setRaw(id, content) {
        const p = this._filePath(id);
        this._atomicWrite(p, content);
        this._emit('set', id);
    }

    // ============================================================
    // 内部方法
    // ============================================================
    _filePath(id) {
        // 安全校验：防止路径遍历
        if (typeof id !== 'string' || !id || /[/\\]/.test(id) || id.includes('..') || /[\x00-\x1f]/.test(id)) {
            throw new Error(`非法条目 ID：${id}`);
        }
        return path.join(this.baseDir, `${id}${this.ext}`);
    }

    _atomicWrite(filePath, content) {
        this._ensureDir();
        writeFileAtomic(filePath, content);
    }
}

// ============================================================
// Front Matter 解析：委托 scripts/front-matter.mjs（唯一实现）
// ============================================================
function parseMarkdownFrontMatter(raw) {
    const { frontMatter, content } = parseFrontMatter(raw);
    return { meta: frontMatter, body: content.trim() };
}

// ============================================================
// 便捷工厂函数
// ============================================================
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

/** 创建指向 vault/<subdir> 的 FileStore */
export function vaultStore(subdir, opts = {}) {
    return new FileStore(path.join(ROOT, 'vault', subdir), opts);
}
