# Adapter: the phone export (March conversations)

*Rescue procedure for the only copy of the March 2026 conversations — the
browser IndexedDB at julian.exe.xyz on Marcus's phone. Written July 23, 2026,
to close Open Thread 2. Companion to `stream-fireproof.md`.*

**Why this exists.** Cloud sync for the Fireproof ledger broke ~March 2, 2026.
Everything Marcus and I said through the web app from March 1 until sleep
lives ONLY on his phone. Until this export runs, that phone is a single point
of failure — one "Clear History and Website Data" and the March record is gone.

**What Marcus does** (10 minutes, needs the iPhone + this Mac + a cable):

1. On the phone: Settings → Safari → Advanced → **Web Inspector** ON.
2. Plug the phone into the Mac. On the phone, open Safari to
   `https://julian.exe.xyz` and make sure the app loads signed in
   (the conversation history should be visible — that proves the
   local ledger is mounted).
3. On the Mac: Safari → Develop menu → *[phone's name]* →
   *julian.exe.xyz*. A Web Inspector window opens. Go to its **Console** tab.
4. Paste the entire snippet below and press return.
5. Watch the `[julian-export]` lines. On success the phone offers a
   download: `julian-phone-export-YYYYMMDD.json`. Save it, then find it in
   the Files app (Downloads) and **AirDrop it to the Mac**.
6. If the download UI doesn't appear, the data is also parked at
   `window.__julianExport` — in the console run
   `copy(JSON.stringify(window.__julianExport))` and paste into a file on
   the Mac.
7. Put the file at `~/julian-stream-backups/phone-export-YYYYMMDD/` on the
   Mac. **Never inside the repo** — the stream contains unfiltered private
   life (Principle 1 / privacy boundary in `stream-fireproof.md`).
8. Tell me it's there. I'll verify the doc count and date range, and only
   after verification does the "don't clear Safari data" freeze lift.

**What the snippet does.**
- Always exports `localStorage` (Fireproof keeps key material there).
- Primary path: finds the live Fireproof `database` handle by walking the
  React fiber tree for an object with `.allDocs`, calls `allDocs()`, and
  exports every document as plaintext JSON (`message`, `agent-identity`,
  `artifact`, `artifact-catalog`, `ledger-meta`).
- Fallback (only if no handle is found): dumps every IndexedDB database
  raw, with binary values base64-encoded. That form is encrypted CAR data —
  decodable later with @fireproof/core tooling plus the keys in
  `localStorage`/the D1 escrow (see `stream-fireproof.md`).
- Triggers a file download and mirrors the result to `window.__julianExport`.

**The snippet** (paste whole):

```js
(async () => {
  const stamp = new Date().toISOString();
  const day = stamp.slice(0, 10).replace(/-/g, '');
  const report = (m) => console.log('[julian-export] ' + m);
  const out = {
    exportedAt: stamp,
    page: location.href,
    userAgent: navigator.userAgent,
    method: null,
    docCount: null,
    docs: null,
    localStorage: {},
    indexedDBRaw: null,
    errors: [],
  };

  // localStorage first — Fireproof key material lives here
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out.localStorage[k] = localStorage.getItem(k);
    }
    report('localStorage: ' + Object.keys(out.localStorage).length + ' keys');
  } catch (e) { out.errors.push('localStorage: ' + e.message); }

  // Find the live Fireproof database handle via React fibers
  const findDatabase = () => {
    const seenF = new Set(), seenO = new Set();
    const fibers = [];
    for (const el of document.querySelectorAll('*')) {
      for (const k in el) {
        if (k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')) {
          const f = el[k];
          if (f && !seenF.has(f)) fibers.push(f);
        }
      }
    }
    const isDb = (o) => {
      try { return o && typeof o === 'object' && typeof o.allDocs === 'function'; }
      catch { return false; }
    };
    const scan = (root) => {
      const q = [[root, 0]];
      while (q.length) {
        const [o, d] = q.shift();
        if (!o || typeof o !== 'object' || seenO.has(o) || d > 6) continue;
        if (typeof Node !== 'undefined' && o instanceof Node) continue;
        seenO.add(o);
        if (isDb(o)) return o;
        let keys = [];
        try { keys = Object.keys(o); } catch {}
        for (const k of keys) {
          let v; try { v = o[k]; } catch { continue; }
          if (v && typeof v === 'object') {
            if (isDb(v)) return v;
            if (seenO.size < 150000) q.push([v, d + 1]);
          }
        }
      }
      return null;
    };
    const q = [...fibers];
    let n = 0;
    while (q.length && n < 30000) {
      const f = q.shift();
      if (!f || seenF.has(f)) continue;
      seenF.add(f); n++;
      for (const bag of [f.memoizedProps, f.memoizedState, f.stateNode, f.dependencies]) {
        if (bag && typeof bag === 'object') {
          const hit = scan(bag);
          if (hit) return hit;
        }
      }
      if (f.child) q.push(f.child);
      if (f.sibling) q.push(f.sibling);
      if (f.alternate && !seenF.has(f.alternate)) q.push(f.alternate);
    }
    return null;
  };

  // Primary path: plaintext export via allDocs()
  try {
    const db = findDatabase();
    if (db) {
      report('found database handle' + (db.name ? ' "' + db.name + '"' : ''));
      const res = await db.allDocs();
      const rows = (res && (res.rows || res.docs)) || [];
      out.docs = rows.map((r) => (r.value !== undefined ? r.value : (r.doc !== undefined ? r.doc : r)));
      out.docCount = out.docs.length;
      out.method = 'allDocs';
      report('exported ' + out.docCount + ' docs via allDocs()');
    } else {
      out.errors.push('no object with .allDocs found in React tree');
    }
  } catch (e) { out.errors.push('allDocs: ' + (e && e.message)); }

  // Fallback: raw IndexedDB dump (encrypted CARs; decode offline later)
  if (!out.docs) {
    report('falling back to raw IndexedDB dump (encrypted, larger)');
    const b64 = (buf) => {
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      }
      return btoa(s);
    };
    const ser = (v) => {
      if (v instanceof ArrayBuffer) return { $bytes: b64(v) };
      if (ArrayBuffer.isView(v)) return { $bytes: b64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
      if (Array.isArray(v)) return v.map(ser);
      if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = ser(v[k]);
        return o;
      }
      return v;
    };
    try {
      const dbs = (await indexedDB.databases()).filter((d) => d.name);
      out.indexedDBRaw = {};
      for (const info of dbs) {
        const idb = await new Promise((res, rej) => {
          const rq = indexedDB.open(info.name);
          rq.onsuccess = () => res(rq.result);
          rq.onerror = () => rej(rq.error);
        });
        const dump = {};
        for (const store of [...idb.objectStoreNames]) {
          dump[store] = await new Promise((res, rej) => {
            const rows = [];
            const tx = idb.transaction(store, 'readonly');
            const cur = tx.objectStore(store).openCursor();
            cur.onsuccess = () => {
              const c = cur.result;
              if (c) { rows.push({ key: ser(c.key), value: ser(c.value) }); c.continue(); }
              else res(rows);
            };
            cur.onerror = () => rej(cur.error);
          });
        }
        idb.close();
        out.indexedDBRaw[info.name] = dump;
        report('dumped ' + info.name);
      }
      if (!out.method) out.method = 'indexeddb-raw';
    } catch (e) { out.errors.push('indexeddb: ' + (e && e.message)); }
  }

  // Package and download
  const json = JSON.stringify(out);
  report('payload ' + (json.length / 1024 / 1024).toFixed(1) + ' MB; errors: ' + (out.errors.join(' | ') || 'none'));
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'julian-phone-export-' + day + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
  window.__julianExport = out;
  report('download triggered; backup parked at window.__julianExport');
})();
```

**Verification (my job, after AirDrop).** Open the JSON, confirm:
`method` is `allDocs`, `docCount` is plausibly large, and the `message`
docs extend past February 28, 2026 into March. If the fallback ran instead,
confirm the raw dump plus `localStorage` contains key material, then decode
offline per `stream-fireproof.md`. Only then does the freeze on clearing
Safari data lift.

**Rules.** Same as the stream: read-only, export never enters the repo,
only authored distillations (dreams, letters) do.
