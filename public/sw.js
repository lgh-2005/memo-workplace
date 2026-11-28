/* 英语单词学习工作台 · Service Worker（v4.7.0）
 * 目标：把「应用外壳」缓存到本地，断网也能打开界面（数据仍走 /api 联网）。
 * 注意：Service Worker 只在安全上下文（HTTPS / localhost）生效；
 *       本项目默认入口为 http://IP，此时浏览器不会注册本文件（app.js 侧已做守卫），
 *       一旦日后启用 HTTPS 域名，无需改动即自动启用离线能力。
 */
'use strict';

const SHELL_CACHE = 'wb-shell-v4.8.0';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/mist.css',
  '/mist/hero-dawn.webp',
  '/mist/hero-night.webp',
  '/mist/paper.webp',
  '/mist/cover-lesson.webp',
  '/mist/cover-ridge.webp',
  '/mist/band-report.webp',
  '/mist/cover-quiz.webp',
  '/mist/cover-library.webp',
  '/mist/cover-notes.webp',
  '/mist/cover-settings.webp',
  '/mist/empty-ink.webp',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon.ico',
  '/icons/favicon.svg',
  '/icons/ink/arrow-left.png',
  '/icons/ink/arrow-right.png',
  '/icons/ink/arrows.png',
  '/icons/ink/audio.png',
  '/icons/ink/ban.png',
  '/icons/ink/book.png',
  '/icons/ink/book-closed.png',
  '/icons/ink/brain.png',
  '/icons/ink/broom.png',
  '/icons/ink/bug.png',
  '/icons/ink/bulb.png',
  '/icons/ink/calendar.png',
  '/icons/ink/camera.png',
  '/icons/ink/cap.png',
  '/icons/ink/card.png',
  '/icons/ink/chart.png',
  '/icons/ink/chat.png',
  '/icons/ink/check.png',
  '/icons/ink/clap.png',
  '/icons/ink/clipboard.png',
  '/icons/ink/clock.png',
  '/icons/ink/close.png',
  '/icons/ink/compass.png',
  '/icons/ink/cross.png',
  '/icons/ink/cycle.png',
  '/icons/ink/dashboard.png',
  '/icons/ink/dice.png',
  '/icons/ink/door.png',
  '/icons/ink/download.png',
  '/icons/ink/eye.png',
  '/icons/ink/face-calm.png',
  '/icons/ink/face-cool.png',
  '/icons/ink/face-dazed.png',
  '/icons/ink/face-think.png',
  '/icons/ink/face-uneasy.png',
  '/icons/ink/festive.png',
  '/icons/ink/flame.png',
  '/icons/ink/frame.png',
  '/icons/ink/globe.png',
  '/icons/ink/hook.png',
  '/icons/ink/hourglass.png',
  '/icons/ink/kb.png',
  '/icons/ink/key.png',
  '/icons/ink/keyboard.png',
  '/icons/ink/letter-a.png',
  '/icons/ink/lock.png',
  '/icons/ink/logs.png',
  '/icons/ink/memory.png',
  '/icons/ink/moon.png',
  '/icons/ink/more.png',
  '/icons/ink/muscle.png',
  '/icons/ink/news.png',
  '/icons/ink/notes.png',
  '/icons/ink/package.png',
  '/icons/ink/palette.png',
  '/icons/ink/pause.png',
  '/icons/ink/person.png',
  '/icons/ink/pin.png',
  '/icons/ink/play.png',
  '/icons/ink/plug.png',
  '/icons/ink/plus.png',
  '/icons/ink/puzzle.png',
  '/icons/ink/quill.png',
  '/icons/ink/quiz.png',
  '/icons/ink/refresh.png',
  '/icons/ink/reports.png',
  '/icons/ink/robot.png',
  '/icons/ink/ruler.png',
  '/icons/ink/satellite.png',
  '/icons/ink/save.png',
  '/icons/ink/scale.png',
  '/icons/ink/scroll.png',
  '/icons/ink/search.png',
  '/icons/ink/settings.png',
  '/icons/ink/shield.png',
  '/icons/ink/spark.png',
  '/icons/ink/star.png',
  '/icons/ink/study.png',
  '/icons/ink/sun.png',
  '/icons/ink/target.png',
  '/icons/ink/tile.png',
  '/icons/ink/trash.png',
  '/icons/ink/tree.png',
  '/icons/ink/trend.png',
  '/icons/ink/undo.png',
  '/icons/ink/unlock.png',
  '/icons/ink/usage.png',
  '/icons/ink/warn.png',
  '/icons/ink/zen.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 逐个添加，单个 404 不影响整体安装
    await Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('wb-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  // 跨域、API、动态图片一律直连网络，不走缓存
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/images/')) return;

  // 页面导航：网络优先，失败回退到缓存的应用外壳
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('/index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  // 同源静态资源：缓存优先 + 后台更新（stale-while-revalidate）
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
