#!/usr/bin/env node
// scripts/resource-registry.mjs — 资源库注册表：统一管理 vault/assets 下的可复用媒体资产。
// 在执行任何生成任务前，先查询本注册表是否有可用资产（命中 prompt 的语义指纹），避免重复消费 Token / 算量。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, writeJsonAtomic } from './fs-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VAULT_DIR = path.join(ROOT, 'vault');
const ASSETS_DIR = path.join(VAULT_DIR, 'assets');
const META_DIR = path.join(VAULT_DIR, '.meta');

// 注册表文件：vault/.meta/resources.json
// { assets: [{ id, type, promptHash, prompt, fileName, filePath, webPath, tags, size, created, usedBy }], }
const REGISTRY_FILE = path.join(META_DIR, 'resources.json');

// 支持的资源类型
export const RESOURCE_TYPES = ['image', 'video'];

// 语义指纹：对 prompt 做归一化后哈希，避免因空白/标点细微差异导致重复生成。
function normalizePrompt(prompt) {
    return String(prompt || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashPrompt(prompt) {
    const normalized = normalizePrompt(prompt);
    // 取前 16 位 hex 作为语义指纹，足够去重但不过长
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// 读取注册表（不存在时返回空结构）
export function readRegistry() {
    if (!fs.existsSync(REGISTRY_FILE)) {
        return { assets: [] };
    }
    try {
        const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        return Array.isArray(data?.assets) ? data : { assets: [] };
    } catch {
        return { assets: [] };
    }
}

// 写入注册表（原子写盘）
export function writeRegistry(registry) {
    if (!fs.existsSync(META_DIR)) {
        fs.mkdirSync(META_DIR, { recursive: true });
    }
    writeJsonAtomic(REGISTRY_FILE, registry);
}

// 查找匹配的已有资产：按 prompt 语义指纹 + 类型匹配，返回最新一条或 null。
export function findAsset(type, prompt) {
    if (!RESOURCE_TYPES.includes(type)) return null;
    const fp = hashPrompt(prompt);
    const registry = readRegistry();
    // 按 created 倒序，取最新的命中
    const matches = registry.assets.filter((a) => a.type === type && a.promptHash === fp);
    if (!matches.length) return null;
    matches.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    return matches[0];
}

// 查找多个 prompt 的匹配资产，返回 Map<prompt -> asset|null>
export async function findAssetsBulk(type, prompts) {
    const results = new Map();
    for (const p of prompts) {
        // eslint-disable-next-line no-await-in-loop
        results.set(p, await findAsset(type, p));
    }
    return results;
}

// 注册一项新生成的资产：写入文件元信息到注册表。
export function registerAsset({ type, prompt, fileName, filePath, webPath, tags = [] }) {
    if (!RESOURCE_TYPES.includes(type)) throw new Error(`不支持的资源类型: ${type}`);
    const registry = readRegistry();

    // 检查是否已存在完全相同的 entry（filePath 相同）
    const existingIdx = registry.assets.findIndex((a) => a.filePath === filePath);

    const now = new Date().toISOString();
    let statSize = 0;
    try {
        if (fs.existsSync(filePath)) {
            statSize = fs.statSync(filePath).size;
        }
    } catch { /* ignore */ }

    const entry = {
        id: existingIdx >= 0 ? registry.assets[existingIdx].id : `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        promptHash: hashPrompt(prompt),
        prompt: String(prompt || '').trim(),
        fileName,
        filePath,
        webPath,
        tags: Array.from(new Set([...tags])),
        size: statSize,
        created: existingIdx >= 0 ? registry.assets[existingIdx].created : now,
        updated: now,
    };

    if (existingIdx >= 0) {
        registry.assets[existingIdx] = entry;
    } else {
        registry.assets.push(entry);
    }

    writeRegistry(registry);
    return entry;
}

// 记录资产被哪个生成任务使用（usedBy 数组）
export function markAssetUsed(assetId, generator) {
    const registry = readRegistry();
    const idx = registry.assets.findIndex((a) => a.id === assetId);
    if (idx < 0) return null;
    const used = registry.assets[idx];
    const record = { by: String(generator || 'unknown'), at: new Date().toISOString() };
    if (!Array.isArray(used.usedBy)) used.usedBy = [];
    used.usedBy.push(record);
    // 去重：同一 generator 最多保留一条记录
    const seen = new Set();
    used.usedBy = used.usedBy.filter((r) => {
        if (seen.has(r.by)) return false;
        seen.add(r.by);
        return true;
    });
    registry.assets[idx] = used;
    writeRegistry(registry);
    return used;
}

// 列出所有资产（可按类型过滤）
export function listAssets(type) {
    const registry = readRegistry();
    let assets = registry.assets;
    if (type && RESOURCE_TYPES.includes(type)) {
        assets = assets.filter((a) => a.type === type);
    }
    return assets.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

// 删除注册表条目（并可选删除物理文件）
export function removeAsset(assetId, { deleteFile = false } = {}) {
    const registry = readRegistry();
    const idx = registry.assets.findIndex((a) => a.id === assetId);
    if (idx < 0) return false;
    const entry = registry.assets[idx];
    if (deleteFile && fs.existsSync(entry.filePath)) {
        try {
            fs.unlinkSync(entry.filePath);
        } catch { /* ignore */ }
    }
    registry.assets.splice(idx, 1);
    writeRegistry(registry);
    return true;
}

// 清理注册表中指向已不存在文件的条目
export function pruneOrphanedAssets() {
    const registry = readRegistry();
    const before = registry.assets.length;
    registry.assets = registry.assets.filter((a) => fs.existsSync(a.filePath));
    if (registry.assets.length !== before) writeRegistry(registry);
    return before - registry.assets.length;
}

// 确保注册表目录存在（服务启动时调用）
export function ensureResourceDir() {
    if (!fs.existsSync(META_DIR)) fs.mkdirSync(META_DIR, { recursive: true });
    if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

// ---- CLI ----
if (process.argv[1] === new URL(import.meta.url).pathname) {
    const cmd = process.argv[2];
    switch (cmd) {
        case 'list': {
            ensureResourceDir();
            const type = process.argv[3];
            const assets = listAssets(type);
            console.log(`资源库 ${type ? `(${type}) ` : ''}共 ${assets.length} 条：`);
            for (const a of assets) {
                console.log(`- [${a.type}] ${a.fileName} | prompt: ${(a.prompt || '').slice(0, 60)}... | used: ${(a.usedBy || []).length}`);
            }
            break;
        }
        case 'find': {
            const type = process.argv[3];
            const prompt = process.argv[4];
            if (!type || !prompt) {
                console.error('Usage: node scripts/resource-registry.mjs find <image|video> "<prompt>"');
                process.exit(1);
            }
            ensureResourceDir();
            const asset = findAsset(type, prompt);
            console.log(asset ? JSON.stringify({ found: true, ...asset }) : JSON.stringify({ found: false }));
            break;
        }
        case 'prune': {
            ensureResourceDir();
            const removed = pruneOrphanedAssets();
            console.log(`清理孤儿注册条目：${removed} 条`);
            break;
        }
        default:
            console.log('Usage: node scripts/resource-registry.mjs <list [type] | find <image|video> "<prompt>" | prune>');
    }
}
