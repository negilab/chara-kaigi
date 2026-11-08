// つなぎ役（本番）: Firebase Realtime Database。db-local.js と同じ形の関数を出す。
// 部品は Google 公式の配布（gstatic）から読む。設定値が入っているときだけ読み込む。
const V = '13.2.0';
const BASE = `https://www.gstatic.com/firebasejs/${V}`;

export async function createFirebaseDb(config) {
  const [{ initializeApp }, fdb] = await Promise.all([
    import(`${BASE}/firebase-app.js`),
    import(`${BASE}/firebase-database.js`)
  ]);
  const app = initializeApp(config);
  const db = fdb.getDatabase(app);
  const r = (p) => fdb.ref(db, p);
  const leaving = new Map();

  return {
    mode: 'firebase',
    async get(path) { const s = await fdb.get(r(path)); return s.exists() ? s.val() : null; },
    set(path, val) { return fdb.set(r(path), val); },
    update(path, obj) { return fdb.update(r(path), obj); },
    remove(path) { return fdb.remove(r(path)); },
    async push(path, val) { const n = fdb.push(r(path)); await fdb.set(n, val); return n.key; },
    onValue(path, cb) { return fdb.onValue(r(path), (s) => cb(s.exists() ? s.val() : null)); },
    onChildAdded(path, cb) { return fdb.onChildAdded(r(path), (s) => cb(s.key, s.val())); },
    onDisconnectRemove(path) {
      const od = fdb.onDisconnect(r(path));
      od.remove();
      leaving.set(path, od);
    },
    cancelDisconnect(path) {
      const od = leaving.get(path);
      if (od) { od.cancel(); leaving.delete(path); }
    },
    async olderThan(path, ts, limit) {
      const q = fdb.query(r(path), fdb.orderByValue(), fdb.endAt(ts), fdb.limitToFirst(limit));
      const s = await fdb.get(q);
      const out = [];
      s.forEach((c) => { out.push({ key: c.key, val: c.val() }); });
      return out;
    },
    async transaction(path, fn) {
      const res = await fdb.runTransaction(r(path), (cur) => fn(cur));
      return { committed: res.committed, value: res.snapshot.val() };
    }
  };
}
