// routes/vault.mjs — 知识库路由聚合入口：按域拆分于 routes/vault-*.mjs，本文件只做合并与兼容再导出
// 共享辅助在 routes/vault-commons.mjs；server.mjs 的 import 与调用签名不变
import vaultNotesRoutes from './vault-notes.mjs';
import vaultFragmentsRoutes from './vault-fragments.mjs';
import vaultAssetsRoutes from './vault-assets.mjs';
import vaultLearnRoutes from './vault-learn.mjs';
import vaultGraphRoutes from './vault-graph.mjs';

// 兼容再导出：tests 等外部消费方仍从 routes/vault.mjs 引用这两个纯函数
export { detectAssetKind, appendAttachmentTokens } from './vault-commons.mjs';

export default function vaultRoutes(ctx) {
    const notes = vaultNotesRoutes(ctx);
    const assets = vaultAssetsRoutes(ctx);
    const graph = vaultGraphRoutes(ctx);
    const learn = vaultLearnRoutes(ctx);
    const fragments = vaultFragmentsRoutes(ctx);
    // 路由顺序敏感（server.mjs 正则数组首条匹配即返回）：以下拼接与拆分前的
    // 路由数组顺序严格一致（64 条）；域内增删路由后必须同步调整 slice 下标，
    // 并用「拆分前 dump vs 聚合后 dump」的 diff 重新验证。
    return [
        ...notes.slice(0, 5), // tags / notes 列表 / tasks / query / blocks
        ...assets.slice(0, 5), // assets 列表 / 上传 / :name/parse / parse-tasks 查询 / 取消
        ...graph.slice(0, 4), // 多笔记 generate-deck / generate-video / generate-report / reports 列表
        ...notes.slice(5), // 笔记 info/rename/mentions/link-mentions/chat/CRUD/generate-ppt
        ...learn.slice(0, 1), // review-deck
        ...fragments.slice(0, 2), // organize / organize/apply
        ...graph.slice(4, 6), // search / index
        ...assets.slice(5), // assets DELETE（引用保护）+ assets/:file 静态服务（通配，排在 parse-tasks 字面量之后）
        ...graph.slice(6), // graph/generate-deck + graph 读/建
        ...learn.slice(1, 8), // cards CRUD/due/review
        ...fragments.slice(2), // fragments CRUD/reparse/promote
        ...learn.slice(8), // expand + exams + mistakes
    ];
}
