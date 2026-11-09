/* Scales Feedback service worker: lets the app (and the filter lab) open without a connection.
 *
 * Network first, always checking with the server (no-cache: a cheap "not modified" when nothing
 * changed), so a new version shows up on the next load after a push, not up to ten minutes later
 * as GitHub Pages' caching would have it. The copy kept here is only used when the network fails.
 *
 * Nothing in this file needs changing when the app changes: what to keep for offline is read
 * from the pages themselves when it installs, and every file fetched is kept as it goes by (only
 * its newest ?v= copy).
 *
 * Other apps on the same github.io site have their own caches: this only ever touches caches
 * whose names start with its own prefix. The piano samples and the recordings never pass through
 * here (they stay in the browser's own storage).
 */
const PREFIX = 'scalesfeedback-';
const CACHE = PREFIX + 'v1';
const PAGES = ['./', 'index.html', 'lab.html'];
const EXTRA = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

const here = (u) => new URL(u, self.registration ? self.registration.scope : self.location.href).href;
const fresh = (url) => fetch(new Request(url, { cache: 'no-cache', credentials: 'same-origin' }));

/** The same-site files a page loads (its scripts, styles and icons), read from its HTML. */
function assetsOf(html, base) {
  const out = [];
  const re = /<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1], base);
      if (u.origin === self.location.origin) out.push(u.href);
    } catch (e) {
      /* not a URL */
    }
  }
  return out;
}

/** Keep a response, and drop older ?v= copies of the same file. */
async function keep(url, res) {
  const c = await caches.open(CACHE);
  await c.put(url, res);
  const u = new URL(url);
  for (const k of await c.keys()) {
    const ku = new URL(k.url);
    if (ku.pathname === u.pathname && ku.search !== u.search) await c.delete(k);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const urls = new Set(EXTRA.map(here));
      for (const p of PAGES) {
        try {
          const res = await fresh(here(p));
          if (!res.ok) continue;
          await keep(here(p), res.clone());
          for (const u of assetsOf(await res.text(), here(p))) urls.add(u);
        } catch (e) {
          /* offline while installing: kept as they are used instead */
        }
      }
      await Promise.all(
        [...urls].map((u) =>
          fresh(u)
            .then((r) => (r.ok ? keep(u, r) : null))
            .catch(() => null)
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonts and the like: the browser's business
  event.respondWith(
    fresh(req.url)
      .then((res) => {
        if (res.ok && !res.redirected) event.waitUntil(keep(req.url, res.clone()).catch(() => {}));
        return res;
      })
      .catch(async () => {
        const c = await caches.open(CACHE);
        const hit = (await c.match(req.url)) || (await c.match(req.url, { ignoreSearch: true }));
        if (hit) return hit;
        // a page not kept yet: the one it most likely is
        if (req.mode === 'navigate') return (await c.match(here(/lab/.test(url.pathname) ? 'lab.html' : 'index.html'))) || (await c.match(here('./'))) || Response.error();
        return Response.error();
      })
  );
});
