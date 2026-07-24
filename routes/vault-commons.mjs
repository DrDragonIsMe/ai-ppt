// routes/vault-commons.mjs — vault 路由域共享辅助（资产白名单/multipart 上传/附件解析任务/视频提示词浓缩）
// 从原 routes/vault.mjs 顶部抽出，供 vault-notes/fragments/assets/learn/graph 各域复用；禁止各域复制
import fs from 'node:fs';
import path from 'node:path';
import { buildModelOptions } from '../scripts/generation-common.mjs';
import { parseAsset } from '../scripts/parse-asset.mjs';
import { upsertParseBlock } from '../scripts/fragments.mjs';
import { isActiveStatus } from '../scripts/task-registry.mjs';
import { parseMultipartBoundary, parseMultipartForm } from '../scripts/multipart.mjs';

// ---- 资产上传白名单：后缀 + 魔数双重校验（v2.5.0 速记多媒体） ----
export const MB = 1024 * 1024;
const hasBytes = (buf, off, hex) => {
    const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
    return bytes.every((b, i) => buf[off + i] === b);
};
const hasAscii = (buf, off, s) => buf.length >= off + s.length && buf.subarray(off, off + s.length).toString('latin1') === s;

const ASSET_TYPES = [
    // 图片 ≤10MB
    { kind: 'image', exts: ['.png'], maxBytes: 10 * MB, match: (b) => hasBytes(b, 0, '89504E47') },
    { kind: 'image', exts: ['.jpg', '.jpeg'], maxBytes: 10 * MB, match: (b) => hasBytes(b, 0, 'FFD8FF') },
    { kind: 'image', exts: ['.gif'], maxBytes: 10 * MB, match: (b) => hasAscii(b, 0, 'GIF8') },
    { kind: 'image', exts: ['.webp'], maxBytes: 10 * MB, match: (b) => hasAscii(b, 0, 'RIFF') && hasAscii(b, 8, 'WEBP') },
    // 文档 ≤20MB
    { kind: 'doc', exts: ['.pdf'], maxBytes: 20 * MB, match: (b) => hasAscii(b, 0, '%PDF') },
    { kind: 'doc', exts: ['.docx'], maxBytes: 20 * MB, match: (b) => hasBytes(b, 0, '504B0304') },
    // 音频 ≤80MB
    { kind: 'audio', exts: ['.mp3'], maxBytes: 80 * MB, match: (b) => hasAscii(b, 0, 'ID3') || (b[0] === 0xFF && [0xFB, 0xF3, 0xF2].includes(b[1])) },
    { kind: 'audio', exts: ['.wav'], maxBytes: 80 * MB, match: (b) => hasAscii(b, 0, 'RIFF') && hasAscii(b, 8, 'WAVE') },
    { kind: 'audio', exts: ['.m4a'], maxBytes: 80 * MB, match: (b) => hasAscii(b, 4, 'ftyp') },
    { kind: 'audio', exts: ['.ogg'], maxBytes: 80 * MB, match: (b) => hasAscii(b, 0, 'OggS') },
    // 视频 ≤80MB
    { kind: 'video', exts: ['.mp4'], maxBytes: 80 * MB, match: (b) => hasAscii(b, 4, 'ftyp') },
    { kind: 'video', exts: ['.webm'], maxBytes: 80 * MB, match: (b) => hasBytes(b, 0, '1A45DFA3') },
    { kind: 'video', exts: ['.mov'], maxBytes: 80 * MB, match: (b) => hasAscii(b, 4, 'ftyp') || hasAscii(b, 4, 'moov') },
];

// 按扩展名查白名单类型（detectAssetKind 与流式上传的大小上限回调共用）
const UNSUPPORTED_TYPE_MSG = '不支持的文件类型（支持图片 png/jpg/gif/webp、文档 pdf/docx、音频 mp3/wav/m4a/ogg、视频 mp4/webm/mov）';
function findAssetType(name) {
    const ext = path.extname(String(name || '')).toLowerCase();
    return ASSET_TYPES.find((t) => t.exts.includes(ext)) || null;
}

// 按扩展名 + 魔数识别资产类型；返回 { kind, maxBytes } 或 { error }
export function detectAssetKind(name, buf) {
    const type = findAssetType(name);
    if (!type) {
        return { error: UNSUPPORTED_TYPE_MSG };
    }
    if (!buf || !buf.length || !type.match(buf)) {
        return { error: '文件内容与扩展名不符（魔数校验失败）' };
    }
    return { kind: type.kind, maxBytes: type.maxBytes };
}

// 把附件名以 ![[name]] token 追加进碎片正文（v2.5.0）；正文已含同名 token 时跳过（前端提交时可能已拼接）
export function appendAttachmentTokens(content, attachments) {
    let text = String(content || '');
    for (const a of attachments || []) {
        if (!text.includes(`![[${a}]]`)) text += `\n![[${a}]]`;
    }
    return text;
}

// 资产解析任务状态统一存任务注册表（taskRegistry，kind='parse'），内存 + 落盘持久化

// 多笔记 → 视频提示词：文本模型浓缩为一段中文视频 prompt；LLM 不可用则取首段截断 300 字
export async function condenseForVideo({ generateSlides }, source, apiKey) {
    try {
        const options = buildModelOptions();
        if (apiKey) options.apiKey = apiKey; // 临时透传，不落盘
        const prompt = `请把以下笔记内容浓缩为一段 150 字以内的中文视频生成提示词，描述画面主题、风格与关键信息，只输出提示词本身：\n\n${source.slice(0, 6000)}`;
        const result = await generateSlides(prompt, options);
        const text = result && result.content ? result.content.trim() : '';
        if (text) return text.slice(0, 500);
    } catch {
        // LLM 失败，走降级
    }
    const firstPara = source.split(/\n\s*\n/).map((s) => s.trim()).find(Boolean) || source;
    return firstPara.slice(0, 300);
}

// multipart 流式上传：文件部分写入 vault/assets/.tmp/ 临时文件（不整体驻留内存），
// 后缀 + 魔数双重校验通过后 rename 入库（同分区原子）；任何失败路径都清理临时文件
export async function handleMultipartAssetUpload({ send, validName, ensureVaultApi, ROOT }, req, res, contentType) {
    const boundary = parseMultipartBoundary(contentType);
    if (!boundary) return send(res, 400, { error: '无效的 multipart 请求（缺少 boundary）' });
    const api = await ensureVaultApi();
    api.ensureVaultDirs();
    const dir = path.join(ROOT, 'vault', 'assets');
    const tmpDir = path.join(dir, '.tmp');
    let parsed;
    try {
        parsed = await parseMultipartForm(req, {
            boundary,
            tmpDir,
            hardMaxBytes: 110 * MB,
            // 按扩展名查白名单上限：流式计数，超限即中止并删除临时文件（413）
            maxFileBytes: (filename) => {
                const type = findAssetType(filename);
                if (!type) {
                    const err = new Error(UNSUPPORTED_TYPE_MSG);
                    err.statusCode = 400;
                    throw err;
                }
                return type.maxBytes;
            },
        });
    } catch (err) {
        return send(res, err.statusCode || 400, { error: err.message });
    }
    const file = parsed.files[0];
    // 多余的文件部分不入库，直接清理
    for (const extra of parsed.files.slice(1)) fs.rmSync(extra.tmpPath, { force: true });
    if (!file) return send(res, 400, { error: '请提供文件（file 字段）' });
    const cleanup = () => fs.rmSync(file.tmpPath, { force: true });
    const name = String(parsed.fields.name || file.filename || '').trim();
    if (!validName(name, res, '非法文件名')) { cleanup(); return; }
    // 魔数校验从临时文件头部读取（白名单所有魔数匹配均在头 64 字节内）
    let head;
    try {
        const fd = fs.openSync(file.tmpPath, 'r');
        try {
            head = Buffer.alloc(64);
            const n = fs.readSync(fd, head, 0, 64, 0);
            head = head.subarray(0, n);
        } finally {
            fs.closeSync(fd);
        }
    } catch (err) {
        cleanup();
        return send(res, 500, { error: err.message });
    }
    const detected = detectAssetKind(name, head);
    if (detected.error) { cleanup(); return send(res, 400, { error: detected.error }); }
    if (file.size > detected.maxBytes) {
        cleanup();
        return send(res, 413, { error: `文件超过 ${detected.kind} 类型大小上限（${Math.round(detected.maxBytes / MB)}MB）` });
    }
    try {
        let finalName = name;
        // 重名自动改为 名-<base36时间戳>.扩展名（与 JSON 路径一致）
        if (fs.existsSync(path.join(dir, finalName))) {
            const ext = path.extname(name);
            finalName = `${name.slice(0, name.length - ext.length)}-${Date.now().toString(36)}${ext}`;
        }
        fs.renameSync(file.tmpPath, path.join(dir, finalName));
        send(res, 201, { ok: true, name: finalName, webPath: `/api/vault/assets/${encodeURIComponent(finalName)}`, kind: detected.kind });
    } catch (err) {
        cleanup();
        send(res, err.statusCode || 500, { error: err.message });
    }
}

// 碎片附件后台解析（创建碎片与「重新解析」共用）：逐附件建 parseTask，
// 顺序解析并以 upsertParseBlock 写回碎片正文（updateFragment 自动重提取 #标签）
export function startFragmentParseTasks({ taskRegistry, randomUUID, getFragment, updateFragment }, fragmentId, attachments, { apiKey } = {}) {
    const parseTaskIds = [];
    for (const a of attachments) {
        const taskId = `parse-${randomUUID()}`;
        taskRegistry.create(taskId, { kind: 'parse', status: 'running' });
        parseTaskIds.push(taskId);
    }
    (async () => {
        for (let i = 0; i < attachments.length; i++) {
            const a = attachments[i];
            const taskId = parseTaskIds[i];
            // 已取消/已中断的任务忽略迟到结果
            const stillActive = () => isActiveStatus(taskRegistry.get(taskId)?.status);
            try {
                const result = await parseAsset(a, { apiKey });
                if (!stillActive()) continue;
                const parsedText = result.text || '（暂无法解析，已仅保存附件）';
                const current = getFragment(fragmentId);
                if (current) {
                    updateFragment(fragmentId, { content: upsertParseBlock(current.content, a, parsedText, result.provider) });
                }
                taskRegistry.complete(taskId, {
                    text: result.text,
                    degraded: result.degraded,
                    provider: result.provider,
                });
            } catch (err) {
                if (!stillActive()) continue;
                taskRegistry.fail(taskId, err.message || '解析失败');
            }
        }
    })();
    return parseTaskIds;
}

