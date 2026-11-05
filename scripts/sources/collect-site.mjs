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
// 优先级：登录墙/法务/404 强信号（词干整标题全等 + 错误码+纯栏目名的封闭准入前缀规则）
// 命中先于白名单（见 STRONG_SIGNAL_TITLES / isErrorCodeTitleSubject），其余顺序不变——
// 白名单短路 → 标题/URL 黑名单 → 品牌口号 → 登录墙正文。
// 「· 分隔」的剥段边界（B091200 r1）：强信号判定前会把标题尾部的「· 站点名」段剥掉，
// 但只剥**看起来像站点名**的尾段——尾段含文档/栏名词（指南/文档/docs/guide/reference 等，
// 判据即 hasWhitelist 词表）时一律不剥，改用整标题查表。否则 `登录 · 接入指南`、
// `Sign in · Developer Docs` 这类合法文档页会被剥成词干 `登录`/`sign in` 而误杀。
// 其它分隔符（– / — / |）的口径（B091200 r2 收口，此前只是标点删除的副作用）：本层
// **不**把它们当分段符，只在归一化时与普通标点一并删除、空白折叠，于是
//   `404 – 帮助中心` / `404 | 帮助中心` → 归一化成 `404 帮助中心` → 走错误码准入规则 → DROP；
//   `404 帮助中心 — 中文站` → 归一化成 `404 帮助中心 中文站`，码后剩余部分既超长（>8 字符）
//     又含表外词 `文站` → 准入表不放行 → KEEP（与 main 一致，属已知召回边界，不为它加分段逻辑）。
// 即：标点删除只影响「主体长什么样」，不改变「必须整标题/纯栏目名命中」这一口径；
// 想让某分隔符参与分段是新一轮设计决策，本层刻意不做。
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
// trim + 小写 + 去标点；「· 站点名」尾段仅在它看起来是站点名时才剥（见 strongTitleSubjects）。
// 为何必须整标题命中：`Login API Reference`、`Sign in with SSO — Admin Guide` 等
// 合法文档页标题里含 login/sign in 字样，但主体不是登录墙；一旦改成子串命中
// （includes）就会把这类文档页误杀成 DROP。词干只收录「整个标题就是该强信号」的
// 惯用形态（如 `登录中心`/`登录入口`），语义歧义的词（如「认证中心」可指证书认证中心）
// 一律不收。
// 例外——错误码开放集（B091200 r1 引入，r2 改判据方向）：`404 + 任意栏目名` 是开放模板
// 而非封闭命名，光靠词干表只能拦住逐个枚举的实例（`404 帮助中心`/`404 产品资料` 会被
// WHITELIST_CN 在到达标题黑名单前救走）。故对「主体以 HTTP 错误码开头」加前缀规则，但
// r2 把它从**封闭否决表**改成**封闭准入表**：码后剩余部分必须全部由已知栏目名构成才算
// 强信号。原因见 isErrorCodeTitleSubject 上方注释——否决表方向反了，成批误杀合法内容。
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
  // 整标题就是错误码/受限提示的封闭惯用形态。「404 + 栏目名」这类开放模板不在这里
  // 枚举（逐条硬编码换个栏目名就漏），由下面 isErrorCodeTitleSubject 的准入前缀规则泛化。
  '404', 'page not found', 'not found', 'access denied', 'access forbidden',
  'forbidden', 'unauthorized', 'unauthorised', '403 forbidden', '503 service unavailable', 'error page',
  '页面不存在', '找不到页面', '访问被拒绝', '无权访问', '未授权', '禁止访问', '无法访问',
];

const STRONG_SIGNAL_TITLES = new Set([
  ...STRONG_LOGIN_TITLES,
  ...STRONG_LEGAL_TITLES,
  ...STRONG_RESTRICTED_TITLES,
]);

// 错误码前缀规则（B091200 r1 引入 / r2 反转判据方向）。
// 为什么需要它：`404 帮助中心`/`404 产品资料` 的主体恰好由白名单词（帮助/中心/资料）组成，
// 会被 hasWhitelist 在到达标题黑名单 \b404\b 之前救走，而「404 + 栏目名」又是真实 404 页的
// 通用模板，逐条枚举字面量必然漏。
// r2 的关键修正——**封闭准入表替代封闭否决表**。r1 的判据是「码后剩余部分不含某个已知文档
// 名词 ⇒ 判为强信号」：主题词是开放集、文档名词是封闭集，用 12 词否决表去框开放语言空间
// 永远补不全（评审实测 22 个高频主题词里 21 个不设防，`502 故障复盘`/`429 限流算法选型`/
// `404 页面优化`/`500 系列服务器选型` 这类工程知识库核心标题被成批打成 DROP，相对 main
// 净新增删除面 401 条；而被低相关判定打掉的页在 refresh 里既不产 error 也不入库，正好落进
// prunedUnconfirmed 的 rmSync 分支，等于物理删除用户已入库素材）。
// 现在方向反过来：码后剩余部分**必须全部由 ERROR_CODE_SECTION_WORDS 构成**才算强信号。
// 表外一律放行给白名单/黑名单处理——语言空间是开放集，本层不跟它对赌。代价是 `404 视频学院`
// 这类栏目别名回到 KEEP，落在「宁可漏杀也不误伤」原则一侧。
// 码表只保留 404 / 403（r1 开到 11 个码是本轮误杀面的主要放大器）：main 的标题黑名单里
// 唯一有裸码概念的就是 404（另有 `403 forbidden`/`503 service unavailable` 这类**带词**的
// 词组），400/401/405/408/429/500/502/503/504 在 main 上根本没有「裸码即拦」，扩码属自行
// 扩权；429 常见于文号（`429 号文政策解读`）、401 与正文词同形（`401 未授权`）、500 常见于
// 产品系列号（`500 系列服务器选型`）。保留 403 的理由：既有必拦用例 `403 知识库`，且
// 语料实测 `403 + 全部主题词` 误杀数为 0（准入表下主题词天然不放行）。
// 负保护（改为准入方向后不再需要 r1 的三张否决表，以下三条各自钉住一个拼接陷阱）：
//   1. 码必须是独立数字词元——主体前导数字串**整体**等于表内码，故 `4040 端口性能调优`
//      （前导 4040）、`10.403 资料`（归一化后前导 10403）都不命中。
//      注意：归一化先删标点，所以小数 `40.4 …` 的前导数字已是 404，本条挡不住它；
//      它靠准入表挡住（`40.4 增长率测算` → 表外词 → KEEP）。仅当小数前缀恰好拼成 404/403
//      **且**后面全是表内栏目名（`40.4 帮助中心`）才会误拦，实测记为已知边界、不为此加特判。
//   2. 剩余部分限长 ERROR_CODE_SUBJECT_MAX_CHARS：真实 404 页的「码 + 栏目名」主体极短，
//      长度上限把拼接巧合与带后缀的长标题挡在外面（`404 万条数据的治理实践` 既超长又含
//      表外词，双重不命中）。
//   3. 表内只收「栏目/导航名」（一个导航目的地），不收「主题词」（页面讲什么）：故
//      优化/设计/配置/架构/复盘/选型/策略/校验 等开放主题词、指南/手册/教程/说明/参考/
//      接口/规范 等文档名词、以及单独成题更像选题的 首页/页面/错误 一律不收（`404 页面`
//      不误伤的前提就是「页面」不在准入表内）。数量/量词（万/亿/强/条/号/系列）也无需
//      专门否决——表外即 KEEP。文档类栏目名 `文档` 例外地**收**进来（`404 文档`/`404 文档中心`
//      实测更像文档站里的 404 页而非讲 404 的文档，后者由 `说明/手册/参考` 等表外词放行）。
const ERROR_CODE_TOKENS = ['404', '403'];
const ERROR_CODE_SECTION_WORDS = [
  '知识库', '资料库', '中心', '资料', '知识', '学院', '帮助', '下载', '会员', '产品',
  '支持', '资源', '文档', '专题', '上传',
];
// 长词优先剥离：否则 `知识库` 会先被 `知识` 剥成残留 `库` 而漏放（准入判定要求剥完为空）。
const ERROR_CODE_SECTION_WORDS_BY_LEN = [...ERROR_CODE_SECTION_WORDS].sort((a, b) => b.length - a.length);
const ERROR_CODE_SUBJECT_MAX_CHARS = 8;
const LEADING_DIGITS_RE = /^(\d+)([\s\S]*)$/;

function isErrorCodeTitleSubject(subject) {
  const m = LEADING_DIGITS_RE.exec(subject);
  if (!m || !ERROR_CODE_TOKENS.includes(m[1])) return false; // 负保护 1：前导数字整体须恰为表内错误码
  const rest = String(m[2] || '').trim();
  // 本规则只管「错误码 + 栏目名」，不管裸码：裸 `404` 由词干表负责（STRONG_RESTRICTED_TITLES），
  // 裸 `403` 则刻意不跟着扩成「裸码即拦」——main 上 403 只以 `403 forbidden` 词组出现。
  if (!rest) return false;
  if (rest.length > ERROR_CODE_SUBJECT_MAX_CHARS) return false; // 负保护 2：限长
  if (/^[a-z0-9]/.test(rest)) return false; // 码后紧跟 ASCII 字母数字（`404base`）不是栏目名
  let leftover = rest;
  for (const w of ERROR_CODE_SECTION_WORDS_BY_LEN) leftover = leftover.split(w).join('');
  return leftover.trim().length === 0; // 封闭准入表：剩余部分必须全部由栏目名构成
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
 * 优先级设计（B091200 / B091200 r1 / B091200 r2）：
 *   1. 登录墙 / 法务 / 404-受限 强信号命中 → 直接 DROP（先于白名单，白名单无权保护
 *      ——`登录中心`/`404 帮助中心` 正是被 WHITELIST_CN 误救的登录墙与 404 页）。
 *      两种命中方式，都不允许普通子串命中：
 *        a. 归一化主体（整标题，或尾段看起来是站点名时剥掉尾段后的主体）与词干表
 *           **全等**——`Login API Reference`、`Sign in with SSO — Admin Guide` 只含
 *           登录字样作子串，必须仍 KEEP。
 *        b. 「HTTP 错误码 + **纯栏目名**」前缀规则：把「404 + 栏目名」这一模板泛化，
 *           换栏目名不必再改代码（r1 之前逐条枚举字面量，`404 帮助中心` 一换就漏）。
 *           码后剩余部分必须全部由 ERROR_CODE_SECTION_WORDS 构成才命中（封闭准入表），
 *           外加独立数字词元 / 限长 / 码后不接 ASCII 字母数字三条负保护——详见
 *           isErrorCodeTitleSubject 上方注释。r1 用的是封闭否决表，实测成批误杀
 *           `502 故障复盘` 这类合法标题，r2 已反转方向；表外栏目别名（如 `404 视频学院`）
 *           因此仍放行，属有意保留的召回边界。
 *      本层结构上只会**增加** DROP、绝不放松（命中即 return true，未命中才往下走），
 *      所以任何相对基线的误杀风险都集中在这一层的命中率上，收紧判据永远比放宽安全。
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
