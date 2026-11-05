// scripts/sources/collect-site.mjs — site 类型采集器（知识中心/帮助中心首页场景）。
// 从入口页 BFS：抓首页 → 提取同域链接 → 按 options.depth / maxPages 逐页抓取。
// 去重、跳过下载/媒体后缀与跨域链接（net.isCrawlableLink 内做）；每抓一页发一条进度事件；
// 单页失败产出 error 条目、不中断整批。默认走 net.fetchPage（含 SSRF 守卫），
// 测试/离线经 ctx.fetchPage / ctx.allowPrivateNetwork 注入。
import { requireFiniteOption } from './registry.mjs';
import { fetchPage, extractFromHtml, extractLinks, guessTitle } from './net.mjs';

// ---------------------------------------------------------------------------
// 低相关页过滤（B080800）
// 目标：在入库前丢掉登录墙、法务页、404/访问受限、以及通用页脚营销页。
// 原则：优先用标题匹配，正文仅在“整页基本只剩登录表单”这种极强信号时才用；
// 用知识库/文档常见关键词做白名单，宁可漏杀也不误伤合法知识中心页面。
// ---------------------------------------------------------------------------

const WHITELIST_ASC = [
  'help', 'support', 'doc', 'docs', 'documentation', 'knowledge', 'kb', 'wiki', 'guide', 'guides',
  'tutorial', 'tutorials', 'faq', 'faqs', 'manual', 'handbook', 'reference', 'references', 'api', 'sdk',
  'library', 'libraries', 'tool', 'tools', 'config', 'configuration', 'configure', 'installation', 'install',
  'setup', 'deploy', 'deployment', 'usage', 'admin', 'administrator', 'getting started', 'quick start',
  'introduction', 'intro', 'overview', 'concept', 'concepts', 'explanation', 'how-to', 'howto', 'example',
  'examples', 'recipe', 'patterns', 'best practices', 'troubleshooting', 'error', 'errors', 'logs', 'logging',
  'monitoring', 'metrics', 'home', 'index', 'welcome', 'start', 'started', 'changelog', 'release notes',
  'version', 'update', 'upgrade', 'migration', 'integration', 'integrations', 'plugin', 'plugins', 'module',
  'modules', 'extension', 'extensions', 'feature', 'features', 'command', 'commands', 'cli', 'options',
  'parameters', 'arguments', 'rest', 'graphql', 'http', 'protocol', 'format', 'schema', 'schemas',
  'specification', 'specifications', 'standard', 'standards', 'security', 'authentication', 'authorization',
  'permissions', 'roles', 'caching', 'cache', 'performance', 'optimization', 'scaling', 'storage', 'database',
  'query', 'queries', 'data', 'model', 'models', 'architecture', 'design', 'workflow', 'workflows', 'process',
  'processes',
];

const WHITELIST_CN = [
  '文档', '帮助', '指南', '支持', '手册', '教程', '简介', '入门', '首页', '参考', '示例', '用法', '安装',
  '配置', '部署', '管理', '使用', '快速开始', '入门指南', '概念', '故障排除', '日志', '监控', '指标',
  '版本', '更新', '升级', '迁移', '集成', '插件', '模块', '扩展', '功能', '命令', '参数', '协议',
  '格式', '规范', '安全', '认证', '授权', '权限', '角色', '缓存', '性能', '优化', '数据库', '查询',
  '数据', '模型', '架构', '设计', '工作流', '流程',
  // B091100：配合 isBrandSloganPage 放宽到「多段式 · 标题」，补全知识中心类高频词，避免误杀。
  '知识', '中心', '学院', '资料', '知识库',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WHITELIST_ASC_RE = new RegExp(`\\b(${WHITELIST_ASC.map(escapeRegExp).join('|')})\\b`, 'i');

const TITLE_BLACKLIST = [
  // 登录 / 注册
  /\b(sign\s*in|log\s*in|login|signup|sign\s*up|register|registration|create\s+an?\s+account|join\s+now|忘记密码|找回密码|重置密码|密码重置)\b/i,
  /(?:登录|登陆|注册|登入|账号登录|用户登录|会员登录|登录入口)/u,
  // 法务 / Cookie
  /\b(terms\s+of\s+(service|use)|privacy\s+(policy|notice|statement)|cookie\s+(policy|notice|settings|consent)|legal\s+(notice|terms)|gdpr|compliance|服务条款|隐私政策|用户协议|使用条款|Cookie政策|法律声明|合规)\b/i,
  // 404 / 访问受限
  /\b(404|page\s+not\s+found|not\s+found|access\s+denied|access\s+forbidden|forbidden|unauthorized|unauthorised|403\s+forbidden|503\s+service\s+unavailable|error\s+page|页面不存在|找不到页面|访问被拒绝|无权访问|未授权|禁止访问|无法访问)\b/i,
  // 通用企业营销 / 页脚页（about us / careers / contact / press 等）
  /\b(about\s+us|careers?|jobs?|contact(\s+us)?|press|newsroom|our\s+(story|mission|values|team)|why\s+us|what\s+we\s+do|trust\s+center|status\s+page|联系我们|关于我们|加入我们|招贤纳士|新闻中心|公司介绍|状态页)\b/i,
];

const URL_PATH_BLACKLIST = [
  /^\/(login|signin|signup|register|auth|logout|sign-out|signoff|forgot-password|reset-password|password-reset)\/?$/i,
  /^\/(terms|privacy|cookies|cookie-policy|legal|gdpr|compliance|security-notice)\/?$/i,
  /^\/(404|403|401|not-found|access-denied|access-forbidden|error)\/?$/i,
];

// 站点根、/about 等“浅层营销/页脚页”常见路径。单独命中不丢，只作为 brand-slogan 标题的辅助信号。
const SHALLOW_MARKETING_PATHS = [
  // 注意：不列 '/'。根路径可能是合法知识库/博客首页，应交给「正文厚度」判断，避免误杀。
  /^\/about\/?$/i,
  /^\/company\/?$/i,
  /^\/careers?\/?$/i,
  /^\/jobs?\/?$/i,
  /^\/contact(-us)?\/?$/i,
  /^\/press\/?$/i,
  /^\/newsroom\/?$/i,
  /^\/our-(story|mission|values)\/?$/i,
];

function hasWhitelist(title) {
  const t = String(title || '').toLowerCase();
  if (WHITELIST_ASC_RE.test(t)) return true;
  return WHITELIST_CN.some((w) => t.includes(w));
}

function isBlacklistedTitle(title) {
  return TITLE_BLACKLIST.some((re) => re.test(String(title || '')));
}

function isBlacklistedUrlPath(origin) {
  let pathname;
  try {
    pathname = new URL(origin).pathname;
  } catch {
    return false;
  }
  const p = String(pathname || '').toLowerCase();
  return URL_PATH_BLACKLIST.some((re) => re.test(p));
}

function isShallowMarketingPath(origin) {
  let pathname;
  try {
    pathname = new URL(origin).pathname;
  } catch {
    return false;
  }
  const p = String(pathname || '').toLowerCase();
  return SHALLOW_MARKETING_PATHS.some((re) => re.test(p));
}

function effectiveBodyLength(body) {
  return String(body || '').replace(/\s/g, '').length;
}

function isLoginOnlyBody(body) {
  const b = String(body || '').toLowerCase();
  const wordCount = b.trim().split(/\s+/).filter(Boolean).length;
  const hasSignIn = /\b(sign\s*in|log\s*in|login|登录|登陆|登入)\b/u.test(b);
  const hasPassword = /\b(password|密码)\b/u.test(b);
  return wordCount < 80 && hasSignIn && hasPassword;
}

/**
 * 判定一页是否属于低相关页（登录墙、法务、404/受限、通用营销页）。
 * 先过知识库/文档白名单；白名单保护下的页面不会被黑名单误杀。
 */
function isBrandSloganPage(entry) {
  // 品牌口号型标题：真实页面普遍是 "页面 · 栏目 · 站点名" 的多段式（如 GitHub 首页）。
  // 只要标题里存在至少一个间隔号且首尾段非空即为弱信号，
  // 必须与「about/company/careers 等浅层营销路径」或「正文几乎无实质内容」联合作用，
  // 不得单独成立，避免误杀 "Team · Our people" / "博客 · 产品团队" 这类有实质内容的知识库/博客页。
  // 设计边界：站点根首页（/）且正文厚实的不在本过滤器目标范围内，禁止为追一条首页噪声把 / 加回浅层清单。
  const title = String(entry.title || '');
  if (!/^[^·]+(?:·[^·]+)+$/.test(title)) return false;
  return isShallowMarketingPath(entry.origin) || effectiveBodyLength(entry.body) < 200;
}

export function isLowRelevancePage(entry) {
  const title = String(entry.title || '');
  if (hasWhitelist(title)) return false;
  if (isBlacklistedTitle(title) || isBlacklistedUrlPath(entry.origin)) return true;
  if (isBrandSloganPage(entry)) return true;
  if (isLoginOnlyBody(entry.body)) return true;
  return false;
}

/**
 * @param {object} source
 * @param {{fetchPage?:Function,allowPrivateNetwork?:boolean,maxBytes?:number,onProgress?:Function}} [ctx]
 */
export async function* collectSite(source, ctx = {}) {
  const entry = source.target;
  const tags = source.tags || [];
  const maxPages = requireFiniteOption(source, 'maxPages');
  const maxDepth = requireFiniteOption(source, 'depth');
  const fetchFn = ctx.fetchPage || fetchPage;
  const netOpts = { allowPrivateNetwork: ctx.allowPrivateNetwork, maxBytes: ctx.maxBytes };

  let origin;
  try {
    origin = new URL(entry).href;
  } catch {
    const err = new Error(`site 源入口不是合法 URL：${entry}`);
    err.statusCode = 400;
    throw err;
  }

  const queue = [{ url: origin, depth: 0 }];
  const seen = new Set([origin]);
  const skipLowRelevance = source?.options?.skipLowRelevanceCheck === true;
  let fetched = 0;
  let yielded = 0;
  let lowRelevanceSkipped = 0;
  const lowRelevanceSamples = [];

  while (queue.length && fetched < maxPages) {
    const { url, depth } = queue.shift();
    if (fetched >= maxPages) break;
    fetched++;
    ctx.onProgress?.(`抓取 [${fetched}/${maxPages}] ${url}`, { url, depth, index: fetched });

    let page;
    try {
      page = await fetchFn(url, netOpts);
    } catch (err) {
      yield { kind: 'error', origin: url, error: err.message, httpStatus: err.httpStatus, code: err.code };
      continue;
    }

    const html = page.html;
    const body = extractFromHtml(html);
    const title = guessTitle(html, url);

    if (!skipLowRelevance && isLowRelevancePage({ title, body, origin: url })) {
      lowRelevanceSkipped++;
      if (lowRelevanceSamples.length < 10) {
        lowRelevanceSamples.push({ title: title.slice(0, 120), origin: url });
      }
      ctx.onProgress?.(`跳过低相关页：${title || url}`, { url, title, reason: 'low-relevance' });
      continue;
    }

    yielded++;
    yield {
      kind: 'text',
      origin: url,
      originKey: url,
      title,
      body,
      bodyTruncated: page.truncated === true, // P2-3：单页响应体截断向上传播
      tags: [...tags],
    };

    if (depth < maxDepth) {
      const links = extractLinks(html, page.finalUrl || url, origin);
      for (const link of links) {
        if (!seen.has(link)) {
          seen.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }

  // 因 maxPages 截断 / 低相关过滤：显式上报丢弃数，确保不静默丢页
  if (queue.length > 0 || lowRelevanceSkipped > 0) {
    yield {
      kind: 'summary',
      collected: yielded,
      dropped: queue.length,
      total: yielded + lowRelevanceSkipped + queue.length,
      cap: maxPages,
      lowRelevanceSkipped,
      lowRelevanceSamples,
    };
  }
}
