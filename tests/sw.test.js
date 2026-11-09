// The service worker (sw.js), run against a pretend network and cache storage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'https://me.github.io/scales-feedback/';
const SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

class FakeCache {
  constructor() {
    this.m = new Map();
  }
  async put(req, res) {
    this.m.set(typeof req === 'string' ? req : req.url, res);
  }
  async match(req, o) {
    const u = typeof req === 'string' ? req : req.url;
    if (this.m.has(u)) return this.m.get(u).clone();
    if (o && o.ignoreSearch) for (const [k, v] of this.m) if (k.split('?')[0] === u.split('?')[0]) return v.clone();
    return undefined;
  }
  async keys() {
    return [...this.m.keys()].map((url) => ({ url }));
  }
  async delete(r) {
    return this.m.delete(typeof r === 'string' ? r : r.url);
  }
}

/** A service worker with the site's files at `files` (path -> body). */
function boot(files, others) {
  const store = new Map((others || []).map((n) => [n, new FakeCache()]));
  const caches = {
    open: async (n) => {
      if (!store.has(n)) store.set(n, new FakeCache());
      return store.get(n);
    },
    keys: async () => [...store.keys()],
    delete: async (n) => store.delete(n),
  };
  const on = {};
  const net = { online: true, files, asked: [] };
  const self = {
    location: new URL(ROOT + 'sw.js'),
    registration: { scope: ROOT },
    addEventListener: (t, f) => (on[t] = f),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const fetch = async (req) => {
    const url = typeof req === 'string' ? req : req.url;
    net.asked.push([url, typeof req === 'string' ? null : req.cache]);
    if (!net.online) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const body = net.files[u.pathname.replace('/scales-feedback/', '') || './'];
    return body == null ? new Response('missing', { status: 404 }) : new Response(body, { status: 200, headers: { etag: '"' + body.length + '"' } });
  };
  const ctx = { self, caches, fetch, Request, Response, URL, Set, Promise };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const run = async (type, extra) => {
    const waits = [];
    let answer = null;
    const ev = Object.assign({ waitUntil: (p) => waits.push(p), respondWith: (p) => (answer = p) }, extra);
    on[type](ev);
    const res = answer ? await answer : null;
    await Promise.all(waits);
    return { res, answered: !!answer };
  };
  const get = (url, mode) => run('fetch', { request: { method: 'GET', url: new URL(url, ROOT).href, mode: mode || 'no-cors' } });
  return { store, net, run, get };
}

const SITE = {
  './': '<link rel="manifest" href="manifest.webmanifest"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?x"><link rel="stylesheet" href="css/app.css?v=12"><script src="js/core.js?v=12"></script><script src="js/app.js?v=12"></script>',
  'index.html': '<link rel="stylesheet" href="css/app.css?v=12"><script src="js/core.js?v=12"></script><script src="js/app.js?v=12"></script>',
  'lab.html': '<script src="js/core.js?v=12"></script><script src="js/lab.js?v=12"></script>',
  'manifest.webmanifest': '{}',
  'css/app.css': 'body{}',
  'js/core.js': 'core',
  'js/app.js': 'app',
  'js/lab.js': 'lab',
  'icons/icon-192.png': 'png',
  'icons/icon-512.png': 'png',
  'icons/icon-maskable-512.png': 'png',
};

test('installing keeps the pages and everything they load from the site, read from the pages', async () => {
  const sw = boot({ ...SITE });
  await sw.run('install');
  const kept = [...sw.store.get('scalesfeedback-v1').m.keys()].map((u) => u.replace(ROOT, ''));
  for (const f of ['', 'index.html', 'lab.html', 'manifest.webmanifest', 'css/app.css?v=12', 'js/core.js?v=12', 'js/app.js?v=12', 'js/lab.js?v=12', 'icons/icon-192.png', 'icons/icon-maskable-512.png']) assert.ok(kept.includes(f), 'keeps ' + f + ': ' + kept.join(' '));
  assert.ok(!kept.some((u) => /fonts/.test(u)), 'nothing from other sites');
  assert.ok(sw.net.asked.every(([, cache]) => cache === 'no-cache'), 'always checks with the server');
});

test('online, the newest file is served and kept; only its newest ?v= copy stays', async () => {
  const sw = boot({ ...SITE });
  await sw.run('install');
  sw.net.files['js/core.js'] = 'core, new';
  const r = await sw.get('js/core.js?v=13');
  assert.strictEqual(await r.res.text(), 'core, new');
  const kept = [...sw.store.get('scalesfeedback-v1').m.keys()].filter((u) => /core\.js/.test(u));
  assert.deepStrictEqual(kept, [ROOT + 'js/core.js?v=13']);
});

test('offline, it opens from what was kept: pages, files, and pages not visited yet', async () => {
  const sw = boot({ ...SITE });
  await sw.run('install');
  sw.net.online = false;
  assert.strictEqual(await (await sw.get('js/app.js?v=12')).res.text(), 'app');
  assert.strictEqual(await (await sw.get('js/app.js?v=11')).res.text(), 'app', 'an older ?v= asks for the same file');
  assert.match(await (await sw.get('./', 'navigate')).res.text(), /app\.js/);
  assert.match(await (await sw.get('lab.html?x=1', 'navigate')).res.text(), /lab\.js/);
  assert.match(await (await sw.get('somewhere.html', 'navigate')).res.text(), /app\.js/);
  const missing = (await sw.get('js/nothing.js')).res;
  assert.strictEqual(missing.type, 'error');
});

test('it leaves other sites, other methods and other apps’ caches alone', async () => {
  const sw = boot({ ...SITE }, ['eartrainer-v23', 'eartrainer-media-v1', 'practicelog-v5', 'scalesfeedback-v0']);
  await sw.run('activate');
  assert.deepStrictEqual([...sw.store.keys()].sort(), ['eartrainer-media-v1', 'eartrainer-v23', 'practicelog-v5']);
  assert.strictEqual((await sw.run('fetch', { request: { method: 'GET', url: 'https://fonts.googleapis.com/css2?x', mode: 'no-cors' } })).answered, false);
  assert.strictEqual((await sw.run('fetch', { request: { method: 'HEAD', url: ROOT + 'index.html', mode: 'cors' } })).answered, false);
});
