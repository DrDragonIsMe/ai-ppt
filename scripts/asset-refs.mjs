// scripts/asset-refs.mjs — vault 资产引用扫描：正文中的 ![[name]] 和 ![[name|N]] 嵌入 token
// 供 routes/vault-assets.mjs 的删除保护（409）与资产库引用状态（GET ?refs=1）使用

// 简单的正则表达式转义实现
function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 判断一段正文是否引用了指定资产（与笔记渲染管线的 ![[name]]/![[name|N]] 语法一致）
export function contentReferencesAsset(content, assetName) {
    const re = new RegExp(`!\\[\\[${escapeRegExp(assetName)}(\\|\\d+)?\\]\\]`, 'g');
    return re.test(String(content || ''));
}

// 在笔记/碎片集合中查找引用方。
// notes: [{ name, content }]，fragments: [{ id, content }]（content 可为 null，按未引用处理）
// 返回 { notes: [name...], fragments: [id...] }
export function findAssetReferences(assetName, { notes = [], fragments = [] } = {}) {
    return {
        notes: notes.filter((n) => contentReferencesAsset(n.content, assetName)).map((n) => n.name),
        fragments: fragments.filter((f) => contentReferencesAsset(f.content, assetName)).map((f) => f.id),
    };
}
