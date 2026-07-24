// scripts/multipart.mjs — 零依赖流式 multipart/form-data 解析器
// 边界切分流式处理：文件部分直接管道写入临时文件（不整体驻留内存），
// 仅文本字段值入内存（单字段 ≤ maxFieldBytes）。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MB = 1024 * 1024;
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 16 * 1024; // 单个 part 头部上限

// 从 Content-Type 头解析 boundary（参数顺序不限）；非 multipart 或缺 boundary 返回 null
export function parseMultipartBoundary(contentType) {
    const ct = String(contentType || '');
    if (!/^\s*multipart\/form-data\s*;/i.test(ct)) return null;
    const m = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
    return m ? (m[1] || m[2]) : null;
}

function httpError(message, statusCode = 400) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

// 浏览器以 UTF-8 发送文件名；header 先按 latin1 取出再还原 UTF-8 字节
function decodeHeaderValue(v) {
    return Buffer.from(String(v || ''), 'latin1').toString('utf8');
}

function parsePartHeaders(raw) {
    const headers = {};
    for (const line of raw.split('\r\n')) {
        const c = line.indexOf(':');
        if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    const disp = headers['content-disposition'] || '';
    const pick = (key) => {
        const m = new RegExp(`(?:^|;\\s*)${key}="((?:[^"\\\\]|\\\\.)*)"`).exec(disp)
            || new RegExp(`(?:^|;\\s*)${key}=([^;\\s]+)`).exec(disp);
        return m ? decodeHeaderValue(m[1].replace(/\\(.)/g, '$1')) : null;
    };
    const name = pick('name');
    let filename = pick('filename');
    if (filename) filename = filename.split(/[\\/]/).pop(); // 剥离客户端路径
    return { name, filename, mimeType: headers['content-type'] || '' };
}

// 流式解析 multipart 请求体。
// options:
//   boundary     — 必填，取自 parseMultipartBoundary
//   tmpDir       — 必填，文件部分临时写入目录（自动 mkdir；调用方负责成功后 rename / 失败后清理）
//   maxFileBytes — 单文件上限，number 或 (filename) => number；回调可抛错（中止解析并清理临时文件）
//   maxFieldBytes— 单文本字段上限（默认 64KB）
//   hardMaxBytes — 请求体绝对上限（默认 128MB），超限直接销毁连接
// 返回 { fields: {name: value}, files: [{ fieldName, filename, mimeType, tmpPath, size }] }
// 解析失败时抛带 statusCode 的错误，且已创建的临时文件会被自动清理。
export async function parseMultipartForm(req, {
    boundary,
    tmpDir,
    maxFileBytes = Infinity,
    maxFieldBytes = 64 * 1024,
    hardMaxBytes = 128 * MB,
} = {}) {
    if (!boundary) throw httpError('无效的 multipart 请求（缺少 boundary）');
    if (!tmpDir) throw httpError('缺少 tmpDir 配置', 500);
    fs.mkdirSync(tmpDir, { recursive: true });

    const dash = Buffer.from(`--${boundary}`);
    const delimiter = Buffer.concat([CRLF, dash]);
    const keep = delimiter.length + 4; // 边界可能跨块，写盘/入字段前保留的尾部字节数

    const fields = {};
    const files = [];
    let state = 'preamble'; // preamble | afterDelimiter | headers | file | field | done
    let pending = Buffer.alloc(0);
    let part = null;
    let out = null;
    let outPath = '';
    let outSize = 0;
    let fieldChunks = [];
    let fieldSize = 0;

    return new Promise((resolve, reject) => {
        let settled = false;
        let totalReceived = 0;

        const cleanup = async () => {
            if (out) {
                const o = out;
                out = null;
                o.destroy();
                await new Promise((r) => o.once('close', r));
            }
            if (outPath) { fs.rmSync(outPath, { force: true }); outPath = ''; }
            for (const f of files) fs.rmSync(f.tmpPath, { force: true });
        };

        const fail = (err, destroyReq = false) => {
            const wasSettled = settled;
            settled = true;
            if (destroyReq) req.destroy();
            else req.resume(); // 排空剩余数据，保证响应能被客户端完整读取
            if (wasSettled) return;
            cleanup().finally(() => reject(err));
        };

        const succeed = () => {
            if (settled) return;
            settled = true;
            resolve({ fields, files });
        };

        const drain = async () => {
            for (;;) {
                if (state === 'done') return;
                if (state === 'preamble') {
                    const i = pending.indexOf(dash);
                    if (i < 0) {
                        if (pending.length > keep) pending = pending.subarray(pending.length - keep);
                        return;
                    }
                    pending = pending.subarray(i + dash.length);
                    state = 'afterDelimiter';
                    continue;
                }
                if (state === 'afterDelimiter') {
                    if (pending.length < 2) return;
                    if (pending[0] === 0x2d && pending[1] === 0x2d) { state = 'done'; return; } // 结束边界 --
                    if (pending[0] === 0x0d && pending[1] === 0x0a) {
                        pending = pending.subarray(2);
                        state = 'headers';
                        continue;
                    }
                    throw httpError('multipart 格式错误（分隔符后存在非法字节）');
                }
                if (state === 'headers') {
                    const i = pending.indexOf(HEADER_END);
                    if (i < 0) {
                        if (pending.length > MAX_HEADER_BYTES) throw httpError('multipart 头部过大');
                        return;
                    }
                    part = parsePartHeaders(pending.subarray(0, i).toString('latin1'));
                    pending = pending.subarray(i + HEADER_END.length);
                    if (part.filename) {
                        let limit;
                        try {
                            limit = typeof maxFileBytes === 'function' ? maxFileBytes(part.filename) : maxFileBytes;
                        } catch (e) {
                            throw e.statusCode ? e : httpError(e.message || '文件类型不被接受');
                        }
                        outPath = path.join(tmpDir, `upload-${Date.now().toString(36)}-${randomUUID()}.part`);
                        out = fs.createWriteStream(outPath);
                        outSize = 0;
                        part.limit = limit;
                        state = 'file';
                    } else {
                        fieldChunks = [];
                        fieldSize = 0;
                        state = 'field';
                    }
                    continue;
                }
                // file / field：数据直到下一个 \r\n--boundary 为止
                const i = pending.indexOf(delimiter);
                const done = i >= 0;
                const data = done
                    ? pending.subarray(0, i)
                    : (pending.length > keep ? pending.subarray(0, pending.length - keep) : null);
                if (data) {
                    pending = pending.subarray(data.length);
                    if (state === 'file') {
                        outSize += data.length;
                        if (outSize > part.limit) {
                            throw httpError(`文件超过大小上限（${Math.max(1, Math.round(part.limit / MB))}MB）`, 413);
                        }
                        if (data.length) {
                            await new Promise((res, rej) => out.write(data, (e) => (e ? rej(e) : res())));
                        }
                    } else {
                        fieldSize += data.length;
                        if (fieldSize > maxFieldBytes) throw httpError('表单字段超过大小限制', 413);
                        fieldChunks.push(data);
                    }
                }
                if (!done) return;
                pending = pending.subarray(delimiter.length);
                if (state === 'file') {
                    const f = {
                        fieldName: part.name, filename: part.filename,
                        mimeType: part.mimeType, tmpPath: outPath, size: outSize,
                    };
                    const o = out;
                    out = null;
                    outPath = '';
                    await new Promise((res, rej) => o.end((e) => (e ? rej(e) : res())));
                    files.push(f);
                } else if (part.name) {
                    fields[part.name] = Buffer.concat(fieldChunks).toString('utf8');
                }
                part = null;
                state = 'afterDelimiter';
            }
        };

        let draining = null; // 在途的 drain() 链（含错误处理），onEnd 须等其结算后再判定
        const onData = (chunk) => {
            totalReceived += chunk.length;
            if (totalReceived > hardMaxBytes) {
                fail(httpError(`请求体超过大小限制（${Math.round(hardMaxBytes / MB)}MB）`, 413), true);
                return;
            }
            if (settled) return;
            req.pause();
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            draining = drain().then(() => {
                if (settled) return;
                if (state === 'done') return succeed();
                req.resume();
            }).catch((err) => fail(err));
        };
        const onEnd = () => {
            // 'end' 可能先于 drain 的 promise 续体触发，须链接到在途 drain 之后判定，
            // 否则同步完成的解析错误/成功会被误报为「数据不完整」
            const finish = () => {
                if (settled) return;
                if (state === 'done') return succeed();
                fail(httpError('multipart 数据不完整（缺少结束边界）'));
            };
            if (draining) draining.then(finish, finish);
            else finish();
        };
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', (err) => fail(err));
    });
}
