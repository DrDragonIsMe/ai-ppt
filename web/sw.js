// AI PPT Service Worker
// 缓存策略：
//   静态壳（html/css/js/vendor/图标/manifest）→ cache-first（预缓存 + 运行时回写）
//   导航请求 → network-first，离线回退缓存的 /index.html（壳可离线打开）
//   /api/ → network-only，离线返回 503 自定义 JSON（不做数据离线化）
//   /projects/、/published/、/base/ → network-first，成功回写缓存，离线读缓存副本
// 版本维护：CACHE_VERSION 必须与 package.json 的 version 保持同步；
// 改动任何静态资源后 bump 版本号，activate 阶段会清理旧版本 cache。
const CACHE_VERSION = '2.8.5';
const CACHE_NAME = `ai-ppt-v${CACHE_VERSION}`;
const CACHE_PREFIX = 'ai-ppt-v';

// 预缓存的静态壳（相对站点根）
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/css/web.css',
  '/js/vendor/marked.umd.js',
  '/js/modules/agent.mjs',
  '/js/modules/app.mjs',
  '/js/modules/cards.mjs',
  '/js/modules/exams.mjs',
  '/js/modules/fragments.mjs',
  '/js/modules/generate.mjs',
  '/js/modules/graph.mjs',
  '/js/modules/i18n.mjs',
  '/js/modules/marketing.mjs',
  '/js/modules/modals.mjs',
  '/js/modules/projects.mjs',
  '/js/modules/sources.mjs',
  '/js/modules/state.mjs',
  '/js/modules/vault.mjs',
  '/js/i18n/zh.mjs',
  '/js/i18n/en.mjs',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

const OFFLINE_API_JSON = JSON.stringify({ error: '当前离线：本地服务不可用，仅可浏览已缓存的界面与内容' });

function offlineApiResponse() {
  return new Response(OFFLINE_API_JSON, {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 静态资源判定：预缓存列表命中或常见静态扩展名
function isStaticAsset(url) {
  if (PRECACHE_URLS.includes(url.pathname)) return true;
  return /\.(css|m?js|svg|png|jpe?g|webp|ico|webmanifest|woff2?)$/.test(url.pathname);
}

// 应用壳的关键脚本/样式优先走网络，避免页面壳与模块版本错位。
function isCriticalShellAsset(url) {
  return url.pathname.startsWith('/js/') || url.pathname === '/css/web.css';
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, { offlineFallback } = {}) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    if (offlineFallback) return offlineFallback();
    throw err;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 数据 API：network-only，离线 503 JSON
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => offlineApiResponse()));
    return;
  }

  // 导航：network-first，离线回退缓存壳（SPA 统一回 /index.html）
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, {
      offlineFallback: () => caches.match('/index.html'),
    }));
    return;
  }

  // 动态内容（deck / 发布站点 / 基座引擎）：network-first + 缓存副本
  if (url.pathname.startsWith('/projects/') || url.pathname.startsWith('/published/') || url.pathname.startsWith('/base/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 关键应用壳资源：network-first，在线时优先拿最新模块；离线再退缓存。
  if (isCriticalShellAsset(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 其余静态资源：cache-first
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});
