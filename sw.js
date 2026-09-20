/* 夫婦家計簿 — オフライン用 Service Worker
   ------------------------------------------------------------
   ・同じサイト（GitHub Pages）のファイルだけを対象にする。GAS（Google）への通信は素通しで、
     ここでは一切保存しない（家計簿のデータも合言葉も、ここには残らない）。
   ・常に「まずネットワークで最新を取得 → 取れたら控えを更新」し、圏外のときだけ控えを使う。
     そのため、アプリを更新しても古い画面が残り続けることはない。 */
const CACHE = 'kakeibo-shell-v1';
const SHELL = ['./', 'index.html', 'manifest.json', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
