// 部屋（参加者・部屋の状態・つなぎ役の伝言）。データベースの形:
//   /roomTimes/<部屋>            = 作った時刻（古い部屋の掃除に使う）
//   /rooms/<部屋>/createdAt, hostName
//   /rooms/<部屋>/members/<人>   = { name, char, joinedAt }
//   /rooms/<部屋>/state          = { order, sizes, pos, z, topic, show, sharer }（並び・大きさなど。全員で同じものを見る）
//   /rooms/<部屋>/signals/<宛先>/<連番> = { from, desc | cand }（WebRTC の申し込み・返事・経路の候補）
export const MAX_MEMBERS = 4;
const DAY = 24 * 60 * 60 * 1000;

export function newRoomId() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const s = Array.from(b, (x) => abc[x % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export function newMemberId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return 'm' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
export function validRoomId(id) { return typeof id === 'string' && /^[a-z0-9-]{6,24}$/.test(id); }

// 24時間より前に作られた部屋を消す
export async function cleanupOldRooms(db) {
  try {
    const old = await db.olderThan('roomTimes', Date.now() - DAY, 20);
    for (const { key } of old) {
      if (!validRoomId(key)) continue;
      await db.remove(`rooms/${key}`).catch(() => {});
      await db.remove(`roomTimes/${key}`).catch(() => {});
    }
  } catch (e) {
    console.warn('[キャラ会議] 古い部屋を掃除できませんでした', e);
  }
}

export async function createRoom(db, hostName, show) {
  const id = newRoomId();
  const now = Date.now();
  await db.set(`rooms/${id}`, { createdAt: now, hostName, state: { show: show || "meet'", topic: '' } });
  await db.set(`roomTimes/${id}`, now);
  return id;
}

export async function roomInfo(db, id) {
  if (!validRoomId(id)) return { exists: false };
  const r = await db.get(`rooms/${id}`);
  if (!r || !r.createdAt) return { exists: false };
  const count = r.members ? Object.keys(r.members).length : 0;
  return { exists: true, hostName: r.hostName || '', createdAt: r.createdAt, count, full: count >= MAX_MEMBERS };
}

export class Room {
  constructor(db, id, myId) {
    this.db = db; this.id = id; this.myId = myId;
    this.base = `rooms/${id}`;
    this.offs = [];
    this.joined = false;
  }

  // 入る。満員なら 'full'、部屋が無ければ 'missing'
  async join(me) {
    const info = await roomInfo(this.db, this.id);
    if (!info.exists) return 'missing';
    let full = false;
    const res = await this.db.transaction(`${this.base}/members`, (cur) => {
      const m = cur || {};
      if (Object.keys(m).length >= MAX_MEMBERS && !m[this.myId]) { full = true; return undefined; }
      full = false;
      m[this.myId] = me;
      return m;
    });
    if (!res.committed) return full ? 'full' : 'missing';
    this.joined = true;
    this.db.onDisconnectRemove(`${this.base}/members/${this.myId}`);
    this.db.onDisconnectRemove(`${this.base}/signals/${this.myId}`);
    return 'ok';
  }

  onMembers(cb) { this.offs.push(this.db.onValue(`${this.base}/members`, (v) => cb(v || {}))); }
  onState(cb) { this.offs.push(this.db.onValue(`${this.base}/state`, (v) => cb(v || {}))); }
  onRoomGone(cb) {
    this.offs.push(this.db.onValue(`${this.base}/createdAt`, (v) => { if (v == null && this.joined) cb(); }));
  }
  setState(patch) {
    const p = {};
    Object.keys(patch).forEach((k) => { p[`state/${k}`] = patch[k] === undefined ? null : patch[k]; });
    return this.db.update(this.base, p).catch((e) => console.warn('[キャラ会議] 部屋の状態を書けませんでした', e));
  }
  updateMe(patch) {
    const p = {};
    Object.keys(patch).forEach((k) => { p[`members/${this.myId}/${k}`] = patch[k]; });
    return this.db.update(this.base, p).catch(() => {});
  }

  sendSignal(to, msg) {
    return this.db.push(`${this.base}/signals/${to}`, Object.assign({ from: this.myId }, msg))
      .catch((e) => console.warn('[キャラ会議] 伝言を送れませんでした', e));
  }
  onSignal(cb) {
    const path = `${this.base}/signals/${this.myId}`;
    this.offs.push(this.db.onChildAdded(path, (key, val) => {
      this.db.remove(`${path}/${key}`).catch(() => {});
      if (val && val.from) cb(val.from, val);
    }));
  }

  // 出る。最後の1人なら部屋ごと消す
  async leave() {
    this.offs.forEach((off) => { try { off(); } catch (e) { /* なし */ } });
    this.offs = [];
    if (!this.joined) return;
    this.joined = false;
    const db = this.db;
    db.cancelDisconnect(`${this.base}/members/${this.myId}`);
    db.cancelDisconnect(`${this.base}/signals/${this.myId}`);
    await db.remove(`${this.base}/members/${this.myId}`).catch(() => {});
    await db.remove(`${this.base}/signals/${this.myId}`).catch(() => {});
    const rest = await db.get(`${this.base}/members`).catch(() => null);
    if (!rest || !Object.keys(rest).length) {
      await db.remove(this.base).catch(() => {});
      await db.remove(`roomTimes/${this.id}`).catch(() => {});
    }
  }
}
