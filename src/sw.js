// Outside 35 service worker: the app shell works offline after the first visit.
// The model weights are cached by Transformers.js itself (Cache Storage
// "transformers-cache"); this worker never touches cross-origin requests.
const VERSION = '__VERSION__';
const SHELL_CACHE = `outside35-shell-${VERSION}`;
const VENDOR_CACHE = 'outside35-vendor-__VENDOR_VERSION__';
const SHELL = __PRECACHE__;

// GitHub Pages cannot send the two headers that make a page cross-origin
// isolated, and without them ONNX Runtime runs on one CPU thread. This worker
// adds them to every page and file it serves (model weights and weather are
// CORS requests, which isolation allows). The very first visit is served
// before this worker runs, so the app reloads once before loading the model.
function isolated(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('outside35-') && k !== SHELL_CACHE && k !== VENDOR_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // ONNX Runtime WASM (tens of MB): cached on first use, not at install.
  if (url.pathname.includes('/vendor/')) {
    event.respondWith(
      caches.open(VENDOR_CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return isolated(hit);
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return isolated(res);
      }),
    );
    return;
  }

  // Pages: network first so updates land, cached copy when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true })).then(isolated),
    );
    return;
  }

  // Shell files: cache first.
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)).then(isolated));
});
