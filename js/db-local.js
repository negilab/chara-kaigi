// つなぎ役（試験モード）: 同じ PC の同じ Chrome のタブどうしを、IndexedDB と BroadcastChannel でつなぐ。
// Firebase Realtime Database の代わりに、同じ形の関数を出す（db-firebase.js と差し替えられる）。
// データは IndexedDB の1か所に木の形で置き、書き換えは読み書き一組の取引で行う（タブどうしで書き込みがぶつからない）。
// 合言葉の決まり（/defaults に書くときは key が /adminSecret と同じであること）もまねる。試験モードの合言葉は「test」。

const NAME = 'ck-local-db';
const LOCAL_SECRET = 'test';

function split(path) { return String(path).split('/').filter(Boolean); }
function getAt(t, parts) {
  let n = t;
  for (const p of parts) { if (n == null || typeof n !== 'object') return null; n = n[p]; }
  return n === undefined ? null : n;
}
function clone(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }
// 空の入れ物を消す（Firebase と同じく、中身の無い枝は残さない）
function prune(n) {
  if (n == null || typeof n !== 'object') return n;
  for (const k of Object.keys(n)) {
    n[k] = prune(n[k]);
    if (n[k] == null || (typeof n[k] === 'object' && !Object.keys(n[k]).length)) delete n[k];
  }
  return n;
}
function setAt(t, parts, val) {
  if (!parts.length) return val == null ? {} : clone(val);
  let n = t;
  for (let i = 0; i < parts.length - 1; i++) {
    if (n[parts[i]] == null || typeof n[parts[i]] !== 'object') n[parts[i]] = {};
    n = n[parts[i]];
  }
  if (val == null) delete n[parts[parts.length - 1]];
  else n[parts[parts.length - 1]] = clone(val);
  return t;
}

let pushSeq = 0;
function pushKey() {
  pushSeq = (pushSeq + 1) % 1000;
  return Date.now().toString(36) + String(pushSeq).padStart(3, '0') + Math.random().toString(36).slice(2, 6);
}

function openIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function createLocalDb() {
  const idb = await openIdb();
  const ch = new BroadcastChannel(NAME);
  const listeners = new Set();
  const onLeave = new Set();

  function readTree() {
    return new Promise((res, rej) => {
      const tx = idb.transaction('kv', 'readonly');
      const g = tx.objectStore('kv').get('tree');
      g.onsuccess = () => res(g.result || {});
      g.onerror = () => rej(g.error);
    });
  }
  // fn(tree) が undefined を返したら書かない。返すのは { tree, value }
  function mutate(fn) {
    return new Promise((res, rej) => {
      const tx = idb.transaction('kv', 'readwrite');
      const st = tx.objectStore('kv');
      let out;
      const g = st.get('tree');
      g.onsuccess = () => {
        const t = g.result || {};
        if (t.adminSecret == null) t.adminSecret = LOCAL_SECRET;
        out = fn(t);
        if (out === undefined) { tx.abort(); return; }
        st.put(prune(out.tree), 'tree');
      };
      tx.oncomplete = () => { ch.postMessage({ changed: 1 }); notify(); res(out); };
      tx.onabort = () => (out === undefined ? res(undefined) : rej(tx.error));
    });
  }
  function notify() { listeners.forEach((l) => l.kick()); }
  ch.onmessage = (ev) => {
    const d = ev.data || {};
    // 閉じたタブの代わりに、そのタブの後始末をする
    if (d.leave) mutate((t) => { d.leave.forEach((p) => setAt(t, split(p), null)); return { tree: t }; }).catch(() => {});
    else notify();
  };

  // 変わったら読み直して run に渡す（同じ聞き手の中では順番に）
  function listener(run) {
    let busy = false, again = false;
    const l = {
      async kick() {
        if (busy) { again = true; return; }
        busy = true;
        try { do { again = false; await run(await readTree()); } while (again); } finally { busy = false; }
      }
    };
    listeners.add(l);
    l.kick();
    return () => listeners.delete(l);
  }

  function denied() {
    const e = new Error('PERMISSION_DENIED');
    e.code = 'PERMISSION_DENIED';
    return e;
  }

  window.addEventListener('pagehide', () => {
    if (!onLeave.size) return;
    const paths = Array.from(onLeave);
    ch.postMessage({ leave: paths });
    mutate((t) => { paths.forEach((p) => setAt(t, split(p), null)); return { tree: t }; }).catch(() => {});
  });

  return {
    mode: 'local',
    async get(path) {
      const parts = split(path);
      if (parts[0] === 'adminSecret' || (parts[0] === 'defaults' && parts[1] !== 'v')) throw denied();
      return clone(getAt(await readTree(), parts));
    },
    async set(path, val) {
      const parts = split(path);
      if (parts[0] === 'adminSecret') throw denied();
      let bad = false;
      await mutate((t) => {
        if (parts[0] === 'defaults' && (parts.length !== 1 || !val || val.key !== t.adminSecret)) { bad = true; return undefined; }
        return { tree: setAt(t, parts, val) };
      });
      if (bad) throw denied();
    },
    async update(path, obj) {
      const parts = split(path);
      if (parts[0] === 'adminSecret' || parts[0] === 'defaults') throw denied();
      await mutate((t) => {
        let tree = t;
        Object.keys(obj).forEach((k) => { tree = setAt(tree, parts.concat(split(k)), obj[k]); });
        return { tree };
      });
    },
    async remove(path) {
      const parts = split(path);
      if (parts[0] === 'adminSecret' || parts[0] === 'defaults') throw denied();
      await mutate((t) => ({ tree: setAt(t, parts, null) }));
    },
    async push(path, val) {
      const k = pushKey();
      await mutate((t) => ({ tree: setAt(t, split(path).concat(k), val) }));
      return k;
    },
    onValue(path, cb) {
      const parts = split(path);
      let last;
      return listener((tree) => {
        const v = getAt(tree, parts);
        const s = JSON.stringify(v);
        if (s !== last) { last = s; cb(clone(v)); }
      });
    },
    onChildAdded(path, cb) {
      const parts = split(path);
      const seen = new Set(); // 連番の名前は使い回さないので、一度渡したものは覚えたままにする
      return listener((tree) => {
        const v = getAt(tree, parts) || {};
        const keys = typeof v === 'object' ? Object.keys(v).sort() : [];
        keys.forEach((k) => { if (!seen.has(k)) { seen.add(k); cb(k, clone(v[k])); } });
      });
    },
    onDisconnectRemove(path) { onLeave.add(path); },
    cancelDisconnect(path) { onLeave.delete(path); },
    // path の下で、値（数）が ts より小さいものを古い順に limit 件
    async olderThan(path, ts, limit) {
      const v = getAt(await readTree(), split(path)) || {};
      return Object.keys(v).filter((k) => typeof v[k] === 'number' && v[k] < ts)
        .sort((a, b) => v[a] - v[b]).slice(0, limit).map((k) => ({ key: k, val: v[k] }));
    },
    async transaction(path, fn) {
      const parts = split(path);
      const r = await mutate((t) => {
        const next = fn(clone(getAt(t, parts)));
        if (next === undefined) return undefined;
        return { tree: setAt(t, parts, next), value: next };
      });
      return r ? { committed: true, value: r.value } : { committed: false, value: null };
    }
  };
}
