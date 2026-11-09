/* Installing as an app, and keeping it up to date.
 *
 * Registers the service worker (sw.js: works offline, always loads the newest files when
 * online). And since an installed app's window can stay open for days, it checks now and then
 * (when you come back to it, and every quarter of an hour) whether the files it runs on changed
 * on the server, and if so offers to reload.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {
      /* works without it, just not offline */
    });
  }
  if (!/^https?:$/.test(location.protocol) || !root.fetch) return;

  /** This page and the scripts and styles it loaded from this site. */
  function files() {
    const out = [location.href.split('#')[0]];
    for (const el of doc.querySelectorAll('script[src], link[rel="stylesheet"][href]')) {
      const u = new URL(el.src || el.href, location.href);
      if (u.origin === location.origin) out.push(u.href);
    }
    return out;
  }
  // (a compressed copy can carry the same tag marked weak)
  const stampOf = (r) => (r && r.ok ? (r.headers.get('etag') || r.headers.get('last-modified') || '').replace(/^W\//, '') || null : null);
  /** What the server says the file is now: its ETag (or its date). */
  const stamp = (u) => fetch(u, { method: 'HEAD', cache: 'no-store' }).then(stampOf);
  /** What this page is running: the copy the service worker kept of what it served (also when
   *  it was opened offline), else what the server has. */
  async function loaded(u) {
    const hit = root.caches ? await root.caches.match(u).catch(() => null) : null;
    return hit ? stampOf(hit) : stamp(u);
  }
  async function snapshot(how) {
    const m = {};
    await Promise.all(files().map(async (u) => (m[u] = await how(u).catch(() => null))));
    return m;
  }

  let base = null;
  let last = 0;
  let busy = false;
  async function check(force) {
    if (busy || (!force && Date.now() - last < 60000) || navigator.onLine === false) return;
    busy = true;
    last = Date.now();
    try {
      if (!base) base = await snapshot(loaded);
      const now = await snapshot(stamp);
      if (Object.keys(now).some((u) => now[u] && base[u] && now[u] !== base[u])) offer(now);
    } catch (e) {
      /* try again later */
    }
    busy = false;
  }

  let bar = null;
  function offer(now) {
    if (bar) return;
    bar = doc.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText =
      'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;display:flex;gap:12px;align-items:center;' +
      'background:#152238;color:#e6ebf3;border:1px solid #8bd3f7;border-radius:10px;padding:10px 14px;font-size:14px;line-height:1.4;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.45);max-width:calc(100vw - 32px)';
    const msg = doc.createElement('span');
    msg.textContent = 'A new version of the app is ready.';
    const go = doc.createElement('button');
    go.textContent = 'Reload';
    go.style.cssText = 'font:inherit;font-weight:600;color:#0f1a2b;background:#8bd3f7;border:0;border-radius:7px;padding:6px 12px;cursor:pointer';
    go.onclick = () => location.reload();
    const later = doc.createElement('button');
    later.textContent = 'Later';
    later.style.cssText = 'font:inherit;color:#93a1b8;background:none;border:0;padding:6px 4px;cursor:pointer';
    later.onclick = () => {
      base = now; // ask again only when it changes once more
      bar.remove();
      bar = null;
    };
    bar.append(msg, go, later);
    doc.body.appendChild(bar);
  }

  root.addEventListener('load', () => setTimeout(() => check(true), 3000));
  root.addEventListener('online', () => check(true));
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') check();
  });
  root.addEventListener('focus', () => check());
  setInterval(() => {
    if (doc.visibilityState === 'visible') check(true);
  }, 15 * 60000);
  root.SF = root.SF || {};
  root.SF.checkForUpdate = () => check(true);
})(window);
