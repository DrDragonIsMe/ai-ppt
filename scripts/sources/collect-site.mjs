// scripts/sources/collect-site.mjs — site 类型采集器（知识中心/帮助中心首页场景）。
// 从入口页 BFS：抓首页 → 提取同域链接 → 按 options.depth / maxPages 逐页抓取。
// 去重、跳过下载/媒体后缀与跨域链接（net.isCrawlableLink 内做）；每抓一页发一条进度事件；
// 单页失败产出 error 条目、不中断整批。默认走 net.fetchPage（含 SSRF 守卫），
// 测试/离线经 ctx.fetchPage / ctx.allowPrivateNetwork 注入。
import { requireFiniteOption } from './registry.mjs';
import { fetchPage, extractFromHtml, extractLinks, guessTitle } from './net.mjs';

// ---------------------------------------------------------------------------
// 低相关页过滤（B080800 / B091200）
// 目标：在入库前丢掉登录墙、法务页、404/访问受限、以及通用页脚营销页。
// 原则：优先用标题匹配，正文仅在“整页基本只剩登录表单”这种极强信号时才用；
// 用知识库/文档常见关键词做白名单，宁可漏杀也不误伤合法知识中心页面。
// 优先级：登录墙/法务/404 强信号（词干整标题全等 + 错误码前缀规则）命中先于白名单
// （见 STRONG_SIGNAL_TITLES / isErrorCodeTitleSubject），其余顺序不变——白名单短路 →
// 标题/URL 黑名单 → 品牌口号 → 登录墙正文。
// 「· 分隔」的剥段边界（B091200 r1）：强信号判定前会把标题尾部的「· 站点名」段剥掉，
// 但只剥**看起来像站点名**的尾段——尾段含文档/栏名词（指南/文档/docs/guide/reference 等，
// 判据即 hasWhitelist 词表）时一律不剥，改用整标题查表。否则 `登录 · 接入指南`、
// `Sign in · Developer Docs` 这类合法文档页会被剥成词干 `登录`/`sign in` 而误杀。
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

// ---------------------------------------------------------------------------
// 强信号整标题优先判定（B091200 / B091200 r1）
// 登录墙 / 法务 / 404-受限 三类强信号必须先于 hasWhitelist 短路：WHITELIST_CN 里的
// 通用词（知识/中心/学院/资料/知识库）会把「标题主体本身就是登录墙或 404」的页面
// 误救成 KEEP（实测例证：`登录中心`、`404 资料中心`）。这类页面入库正是低相关过滤
// 要拦的东西，所以强信号判定优先级高于白名单，命中即 DROP，白名单无权保护。
// 硬约束：词干表只允许整标题命中（归一化后的主体 == 词干），不许子串命中。归一化 =
// trim + 小写 + 去标点；「· 站点名」尾段仅在它看起来是站点名时才剥（见 strongTitleSubject）。
// 为何必须整标题命中：`Login API Reference`、`Sign in with SSO — Admin Guide` 等
// 合法文档页标题里含 login/sign in 字样，但主体不是登录墙；一旦改成子串命中
// （includes）就会把这类文档页误杀成 DROP。词干只收录「整个标题就是该强信号」的
// 惯用形态（如 `登录中心`/`登录入口`），语义歧义的词（如「认证中心」可指证书认证中心）
// 一律不收。
// 例外——错误码开放集（B091200 r1）：`404 + 任意栏目名` 是开放模板而非封闭命名，
// 光靠词干表只能拦住逐个枚举的实例（`404 帮助中心`/`404 产品资料` 会被 WHITELIST_CN
// 在到达标题黑名单前救走）。故对「主体以 HTTP 错误码开头」加前缀规则，并配三道负保护
// （文档名词 / 数量单位 / 非独立词元）把 `404 Error Handling Guide`、`404 万条数据` 这类
// 合法标题放回去。
// ---------------------------------------------------------------------------
const STRONG_LOGIN_TITLES = [
  // 中文门户/电商登录页惯用整标题（与「登录」相关的独立页面）
  '登录', '登陆', '登入', '登录中心', '登录入口', '登陆中心', '登陆入口', '登录页', '登录页面',
  '账号登录', '用户登录', '会员登录', '注册',
  // 英文登录页整标题
  'login', 'log in', 'sign in', 'signin', 'sign up', 'signup', 'register', 'logon', 'log on', 'sign on',
];

const STRONG_LEGAL_TITLES = [
  'terms of service', 'terms of use', 'privacy policy', 'privacy notice', 'privacy statement',
  'cookie policy', 'cookie notice', 'cookie settings', 'cookie consent', 'legal notice', 'legal terms',
  'gdpr', '服务条款', '隐私政策', '用户协议', '使用条款', 'cookie政策', '法律声明', '免责声明', '合规',
];

const STRONG_RESTRICTED_TITLES = [
  // 整标题就是错误码/受限提示的封闭惯用形态。「404 + 任意栏目名」这类开放模板不在这里
  // 枚举（逐条硬编码换个栏目名就漏），由下面 isErrorCodeTitleSubject 的前缀规则泛化。
  '404', 'page not found', 'not found', 'access denied', 'access forbidden',
  'forbidden', 'unauthorized', 'unauthorised', '403 forbidden', '503 service unavailable', 'error page',
  '页面不存在', '找不到页面', '访问被拒绝', '无权访问', '未授权', '禁止访问', '无法访问',
];

const STRONG_SIGNAL_TITLES = new Set([
  ...STRONG_LOGIN_TITLES,
  ...STRONG_LEGAL_TITLES,
  ...STRONG_RESTRICTED_TITLES,
]);

// 错误码前缀规则（B091200 r1）：`404 帮助中心`/`404 产品资料` 的主体恰好由白名单词
// （帮助/中心/资料）组成，会被 hasWhitelist 在到达标题黑名单 \b404\b 之前救走，而
// 「404 + 栏目名」又是真实 404 页的通用模板，逐条枚举字面量必然漏。故在强信号层加
// 前缀规则：归一化主体以 HTTP 错误码**独立词元**开头（后面紧跟空格或到此结束）即命中。
// 三道负保护，防止把合法内容打成错误页：
//   1. 主体除错误码外含文档名词（指南/文档/手册/docs/guide/reference…）→ 是讲错误码的
//      文档页（`404 Error Handling Guide`），不算强信号。注意：资料/中心/知识/学院/帮助
//      这类通用栏目名**不在**此列，否则本规则形同虚设。
//   2. 错误码后紧跟数量/量词（万/亿/强/条…）→ 是「500 强」「404 万用户」这类数量表述，
//      不是错误码页。
//   3. 错误码必须是独立词元（`^404\b` 之外还要求后接空白或结尾）→ `4040 端口` 不命中。
const ERROR_CODE_TOKEN_RE = /^(400|401|403|404|405|408|429|500|502|503|504)(?:\s+([\s\S]*))?$/;
const ERROR_CODE_DOC_GUARD_CN = ['指南', '文档', '手册', '教程', '说明', '参考', '接口', '规范', '排查', '解决', '错误码', '状态码'];
const ERROR_CODE_DOC_GUARD_EN = [
  'guide', 'guides', 'reference', 'references', 'manual', 'manuals', 'handbook', 'documentation', 'doc',
  'docs', 'tutorial', 'tutorials', 'faq', 'spec', 'specs', 'specification', 'troubleshooting', 'api', 'sdk',
];
const ERROR_CODE_DOC_GUARD_EN_RE = new RegExp(`\\b(${ERROR_CODE_DOC_GUARD_EN.join('|')})\\b`, 'i');
const ERROR_CODE_QUANTITY_UNITS = ['万', '亿', '千', '百', '余', '多', '强', '个', '条', '次', '人', '元', '家', '款', '位', '倍'];

function isErrorCodeTitleSubject(subject) {
  const m = ERROR_CODE_TOKEN_RE.exec(subject);
  if (!m) return false;
  const rest = String(m[2] || '').trim();
  if (!rest) return true; // 整标题就是 `404` / `503`
  if (ERROR_CODE_QUANTITY_UNITS.some((u) => rest.startsWith(u))) return false;
  if (ERROR_CODE_DOC_GUARD_CN.some((w) => rest.includes(w))) return false;
  if (ERROR_CODE_DOC_GUARD_EN_RE.test(rest)) return false;
  return true;
}

function normalizeStrongTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, '') // 去标点，保留字母/数字/下划线/空白（含 CJK）
    .replace(/\s+/g, ' ')
    .trim();
}

// 强信号查表的候选主体（B091200 r1）：整标题永远是一个候选；「· 站点名」尾段**仅当它
// 看起来是站点名时**才额外剥掉当作主体——尾段命中白名单词表（指南/文档/docs/guide/
// reference/知识/中心…）说明它是栏目名而不是站点名，剥掉会把 `登录 · 接入指南`、
// `Sign in · Developer Docs`、`隐私政策 · 数据安全说明` 这类合法页的主体削成强信号词干
// 而误杀（实测 main→r0 的三例 KEEP→DROP 回归）。
function strongTitleSubjects(title) {
  const raw = String(title || '').trim();
  const subjects = [normalizeStrongTitle(raw)];
  const idx = raw.indexOf('·');
  if (idx > 0 && !hasWhitelist(raw.slice(idx + 1))) {
    subjects.push(normalizeStrongTitle(raw.slice(0, idx)));
  }
  return subjects;
}

function isStrongSignalTitle(title) {
  return strongTitleSubjects(title).some(
    (subject) => STRONG_SIGNAL_TITLES.has(subject) || isErrorCodeTitleSubject(subject),
  );
}

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

/**
 * 判定一页是否属于低相关页（登录墙、法务、404/受限、通用营销页）。
 * 优先级设计（B091200 / B091200 r1）：
 *   1. 登录墙 / 法务 / 404-受限 强信号命中 → 直接 DROP（先于白名单，白名单无权保护
 *      ——`登录中心`/`404 帮助中心` 正是被 WHITELIST_CN 误救的登录墙与 404 页）。
 *      两种命中方式，都不允许普通子串命中：
 *        a. 归一化主体（整标题，或尾段看起来是站点名时剥掉尾段后的主体）与词干表
 *           **全等**——`Login API Reference`、`Sign in with SSO — Admin Guide` 只含
 *           登录字样作子串，必须仍 KEEP。
 *        b. 主体以 HTTP 错误码独立词元开头的前缀规则（泛化「404 + 任意栏目名」开放集），
 *           带文档名词/数量单位/非独立词元三道负保护，详见 isErrorCodeTitleSubject。
 *   2. 知识库/文档白名单命中 → KEEP（白名单保护下的页面不会被黑名单误杀）。
 *   3. 标题黑名单 / URL 路径黑名单 → DROP。
 *   4. 品牌口号型标题（多段式 · 标题 + 浅层营销路径/薄正文）→ DROP。
 *   5. 登录墙正文（整页基本只剩登录表单）→ DROP。
 */
export function isLowRelevancePage(entry) {
  const title = String(entry.title || '');
  if (isStrongSignalTitle(title)) return true;
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
