/* Where exercises come from: a linked folder (re-read every time, so a new .mid from
 * the generator just appears), or files added by hand (kept in this browser).
 */
(function (root) {
  'use strict';
  const SF = root.SF;
  const MID_RE = /\.(mid|midi|kar|rmi)$/i;

  class Library extends SF.Emitter {
    constructor() {
      super();
      this.items = [];
      this.folder = null; // { handle, name, state: 'granted' | 'prompt' | 'denied' }
      this.session = []; // files picked without folder support
      this.metaCache = new Map();
    }
    get canLink() {
      return typeof root.showDirectoryPicker === 'function';
    }
    async init() {
      try {
        const handle = await SF.idb.get('kv', 'folder');
        if (handle) {
          this.folder = { handle, name: handle.name, state: 'prompt' };
          try {
            this.folder.state = await handle.queryPermission({ mode: 'read' });
          } catch (e) {
            this.folder.state = 'prompt';
          }
        }
      } catch (e) {
        /* no IndexedDB here */
      }
      await this.refresh();
    }
    async linkFolder() {
      const handle = await root.showDirectoryPicker({ id: 'scales-feedback', mode: 'read' });
      this.folder = { handle, name: handle.name, state: 'granted' };
      try {
        await SF.idb.put('kv', 'folder', handle);
      } catch (e) {
        /* remembered for this visit only */
      }
      await this.refresh();
    }
    async reconnect() {
      if (!this.folder) return;
      try {
        this.folder.state = await this.folder.handle.requestPermission({ mode: 'read' });
      } catch (e) {
        this.folder.state = 'denied';
      }
      await this.refresh();
    }
    async unlink() {
      this.folder = null;
      try {
        await SF.idb.del('kv', 'folder');
      } catch (e) {
        /* fine */
      }
      await this.refresh();
    }
    async addFiles(files) {
      const list = [...files].filter((f) => MID_RE.test(f.name));
      for (const f of list) {
        const data = await f.arrayBuffer();
        const rec = { name: f.name, data, lastModified: f.lastModified || Date.now(), size: f.size, added: Date.now() };
        try {
          await SF.idb.put('files', f.name, rec);
        } catch (e) {
          this.session = this.session.filter((s) => s.name !== f.name).concat([rec]);
        }
      }
      await this.refresh();
      return list.map((f) => 'saved:' + f.name);
    }
    async remove(id) {
      const [src, name] = splitId(id);
      if (src === 'saved') {
        try {
          await SF.idb.del('files', name);
        } catch (e) {
          /* fine */
        }
        this.session = this.session.filter((s) => s.name !== name);
      }
      await this.refresh();
    }
    async refresh() {
      const items = [];
      if (this.folder && this.folder.state === 'granted') {
        try {
          for await (const item of walk(this.folder.handle, '', 0)) items.push(item);
        } catch (e) {
          this.folder.state = 'prompt';
        }
      }
      let saved = [];
      try {
        saved = await SF.idb.all('files');
      } catch (e) {
        saved = [];
      }
      for (const rec of saved.concat(this.session)) {
        items.push({
          id: 'saved:' + rec.name,
          name: rec.name,
          source: 'saved',
          lastModified: rec.lastModified,
          size: rec.size || (rec.data ? rec.data.byteLength : 0),
          load: async () => rec.data,
        });
      }
      // the same file name in the folder wins over a saved copy
      const seen = new Set();
      this.items = items
        .filter((it) => {
          const k = it.name.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      this.emit('change', this.items);
      return this.items;
    }
    get(id) {
      return this.items.find((it) => it.id === id) || null;
    }
    /** Parse + analyse, cached by name, size and date (so an edited file is re-read). */
    async open(id) {
      const it = this.get(id);
      if (!it) throw new Error('That exercise is no longer there');
      const data = await it.load();
      const key = it.id + '|' + it.size + '|' + it.lastModified;
      let ex = this.metaCache.get(key);
      if (!ex) {
        const midi = SF.parseMidi(data);
        ex = SF.analyze(midi);
        this.metaCache.set(key, ex);
      }
      ex.id = it.name;
      ex.name = SF.prettyName(it.name);
      return ex;
    }
    /** Quick facts for the list, computed in the background. */
    async info(id) {
      try {
        const ex = await this.open(id);
        return { summary: ex.summary, bpm: ex.bpm, duration: ex.duration, keys: ex.rounds.length, voices: ex.voices };
      } catch (e) {
        return { error: e.message };
      }
    }
  }

  async function* walk(dir, prefix, depth) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'file' && MID_RE.test(name)) {
        const f = await h.getFile();
        yield {
          id: 'folder:' + prefix + name,
          name: prefix + name,
          source: 'folder',
          lastModified: f.lastModified,
          size: f.size,
          load: async () => (await h.getFile()).arrayBuffer(),
        };
      } else if (h.kind === 'directory' && depth < 1 && !name.startsWith('.')) {
        yield* walk(h, prefix + name + '/', depth + 1);
      }
    }
  }
  function splitId(id) {
    const i = id.indexOf(':');
    return [id.slice(0, i), id.slice(i + 1)];
  }

  SF.Library = Library;
})(typeof window !== 'undefined' ? window : globalThis);
