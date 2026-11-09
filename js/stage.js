// 録画範囲（1920×1080）を canvas に描く。画面に見せるものと録画するものは同じ絵（操作の手がかりは見せる側だけ）。
import { A, ICONS, inkOn } from './common.js';

export const W = 1920, H = 1080;
// キャラの絵の大きさ（大中小）。CHAR_SCALE を掛けた幅が、並び・空き場所さがし・触れた判定のすべてに使われる
export const CHAR_SCALE = 0.7;
export const SIZE_W = { L: 960 * CHAR_SCALE, M: 700 * CHAR_SCALE, S: 480 * CHAR_SCALE };
export const SIZE_LABEL = { L: '大', M: '中', S: '小' };
export const SPEAK_SCALE = 1.2;   // 話している人を大きくする倍率
const GROW = SPEAK_SCALE;
const VIS = 0.46;            // 絵の幅のうち、キャラが写っている幅
const SAFE_L = 100, SAFE_R = 1820;
const AC = '#86a8ff';
const FONT = '"M PLUS Rounded 1c", "Yu Gothic UI", "Meiryo", sans-serif';

// ---------- アイコン（SVG の形を canvas 用に） ----------
const pathCache = new Map();
function iconPath(name) {
  if (pathCache.has(name)) return pathCache.get(name);
  const p = new Path2D();
  const src = ICONS[name];
  const attr = (s, k) => { const m = s.match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? parseFloat(m[1]) : 0; };
  (src.match(/<(path|rect|circle)[^>]*>/g) || []).forEach((tag) => {
    if (tag.startsWith('<path')) p.addPath(new Path2D(tag.match(/\bd="([^"]*)"/)[1]));
    else if (tag.startsWith('<rect')) {
      const q = new Path2D();
      q.roundRect(attr(tag, 'x'), attr(tag, 'y'), attr(tag, 'width'), attr(tag, 'height'), attr(tag, 'rx'));
      p.addPath(q);
    } else {
      const q = new Path2D();
      q.arc(attr(tag, 'cx'), attr(tag, 'cy'), attr(tag, 'r'), 0, Math.PI * 2);
      p.addPath(q);
    }
  });
  pathCache.set(name, p);
  return p;
}
function drawIcon(g, name, x, y, size, color, lw = 1.6) {
  g.save();
  g.translate(x, y);
  g.scale(size / 24, size / 24);
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.stroke(iconPath(name));
  g.restore();
}

// ---------- 背景（一度だけ描いておく） ----------
let bgCanvas = null;
function background() {
  if (bgCanvas) return bgCanvas;
  const c = bgCanvas = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const lin = g.createLinearGradient(0, 0, 0, H);
  lin.addColorStop(0, '#1a2240'); lin.addColorStop(0.55, '#131a30'); lin.addColorStop(1, '#0f1426');
  g.fillStyle = lin; g.fillRect(0, 0, W, H);
  // 楕円の淡い光（CSS の radial-gradient と同じ置き方。後ろから順に）
  [[1400, 600, 0.5, 1.2, 'rgba(134,168,255,.16)'], [800, 600, 0.88, 0.3, 'rgba(190,160,255,.14)'], [900, 520, 0.18, 0.12, 'rgba(134,168,255,.20)']]
    .forEach(([rx, ry, px, py, col]) => {
      g.save();
      g.setTransform(rx, 0, 0, ry, px * W, py * H);
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      rg.addColorStop(0, col); rg.addColorStop(0.7, 'rgba(134,168,255,0)');
      g.fillStyle = rg;
      g.fillRect(-px * W / rx, -py * H / ry, W / rx, H / ry);
      g.restore();
    });
  g.fillStyle = 'rgba(255,255,255,.035)';
  for (let y = 14; y < H; y += 28) for (let x = 14; x < W; x += 28) { g.beginPath(); g.arc(x, y, 1, 0, Math.PI * 2); g.fill(); }
  return c;
}

// ---------- 自由な置き場所 ----------
// pos: id → { x, y }（舞台 1920×1080 に対する割合。x は絵の真ん中、y は絵の下の端）
export const POS_X = [0.02, 0.98], POS_Y = [0.35, 1.3];
export function cleanPos(p) {
  if (!p || typeof p !== 'object') return null;
  const x = Number(p.x), y = Number(p.y);
  if (!isFinite(x) || !isFinite(y)) return null;
  return { x: Math.min(POS_X[1], Math.max(POS_X[0], x)), y: Math.min(POS_Y[1], Math.max(POS_Y[0], y)) };
}
// 置き場所の決まっていない人を、空いているところへ（決まった手順なので、だれの画面でも同じ場所になる）
export function freeSpot(placed, w) {
  let best = 960, bestD = -Infinity;
  // 写っている幅が舞台の内側に収まる範囲で探す
  for (let x = SAFE_L + w * VIS / 2; x <= SAFE_R - w * VIS / 2; x += 40) {
    let d = Infinity;
    placed.forEach((q) => { d = Math.min(d, Math.abs(x - q.x) - (q.w + w) * VIS / 2); });
    if (!placed.length) d = -Math.abs(x - 960);
    if (d > bestD + 0.5) { bestD = d; best = x; }
  }
  return best;
}

// ---------- 並び ----------
// people: 並び順の [{ id, size }]。返り値: id → { x（中心）, w（絵の幅）, bottom（下からの位置） }
// pos があるとき（だれかが自由に動かしたあと）は pos の場所に置く。pos の無い人は空いているところへ（画面共有のあいだも同じ）
export function computeLayout(people, pos) {
  const out = new Map();
  const n = people.length;
  if (!n) return out;
  if (pos && Object.keys(pos).length) {
    const placed = [];
    people.forEach((p) => {
      const q = cleanPos(pos[p.id]);
      if (q) { const L = { x: q.x * W, w: SIZE_W[p.size] || SIZE_W.L, bottom: H - q.y * H }; out.set(p.id, L); placed.push(L); }
    });
    people.forEach((p) => {
      if (out.has(p.id)) return;
      const w = SIZE_W[p.size] || SIZE_W.L;
      const L = { x: freeSpot(placed, w), w, bottom: 0, auto: true };
      out.set(p.id, L); placed.push(L);
    });
    return out;
  }
  let ws = people.map((p) => SIZE_W[p.size] || SIZE_W.L);
  const avail = SAFE_R - SAFE_L;
  let xs = [];
  for (let iter = 0; iter < 3; iter++) {
    const vis = ws.map((w) => w * VIS);
    const sum = vis.reduce((a, b) => a + b, 0);
    const avg = sum / n;
    const gap = n > 1 ? Math.max(-0.12 * avg, Math.min(140, (avail - sum) / (n - 1))) : 0;
    // 右端のキャラのマイクオフの印が、右の余白にはみ出さないように
    const lastW = ws[n - 1];
    const markOver = Math.max(0, (0.16 * lastW + 40) - lastW * VIS / 2);
    const total = sum + gap * (n - 1) + markOver;
    if (total > avail + 1 && iter < 2) { const k = avail / total; ws = ws.map((w) => w * k); continue; }
    let cur = 960 - total / 2;
    xs = vis.map((v) => { const x = cur + v / 2; cur += v + gap; return x; });
    break;
  }
  people.forEach((p, i) => out.set(p.id, { x: xs[i], w: ws[i], bottom: 0 }));
  return out;
}

// ---------- 描く ----------
export function createStage() {
  const anim = new Map(); // id → なめらかに動かす値
  const pool = new Map(); // 1人ずつの下書き用 canvas
  let lastNow = 0;
  let badges = [];

  function off(key, w, h) {
    let c = pool.get(key);
    if (!c) { c = document.createElement('canvas'); pool.set(key, c); }
    const cw = Math.ceil(w), ch = Math.ceil(h);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    return c;
  }

  // 毎コマ1回: 並びの目標に向けて動かす
  function update(model, now) {
    const dt = lastNow ? Math.min(100, now - lastNow) : 16;
    lastNow = now;
    const lay = computeLayout(model.people, model.pos);
    const k = 1 - Math.exp(-dt / 120);
    const kt = 1 - Math.exp(-dt / 90);
    const seen = new Set();
    const live = model.live || {};
    const kl = 1 - Math.exp(-dt / 60);   // ほかの人がドラッグしている絵は、届いた場所へ少し速めに寄せる（20〜30回/秒の知らせのあいだを埋める）
    model.people.forEach((p) => {
      let L = lay.get(p.id);
      seen.add(p.id);
      // ドラッグ中（だれかが動かしている途中）は、その場所を目標に
      const lv = live[p.id];
      if (lv) L = Object.assign({}, L, { x: lv.x * W, bottom: H - lv.y * H });
      let a = anim.get(p.id);
      if (!a) { a = { x: L.x, w: L.w, bottom: L.bottom, talk: 0, hop: 0, grow: 0, lift: 0 }; anim.set(p.id, a); }
      if (lv && lv.local) { a.x = L.x; a.bottom = L.bottom; }   // 自分で動かしている絵は、指（マウス）にぴったり
      else {
        const kk = lv ? kl : k;   // 置き場所・大きさ・画面共有の並びは、なめらかに動かす
        a.x += (L.x - a.x) * kk; a.bottom += (L.bottom - a.bottom) * kk;
      }
      a.w += (L.w - a.w) * k;
      // つかんでいるあいだは、少し持ち上げて見せる
      a.lift = (a.lift || 0) + (((lv && lv.on) ? 1 : 0) - (a.lift || 0)) * (1 - Math.exp(-dt / 90));
      a.talk += ((p.talking ? 1 : 0) - a.talk) * kt;
      // 話す人を大きく: いま話している人を、足もとを動かさずに少しずつ大きく（戻すときはゆっくり）
      const growT = p.talking && p.id === model.speakerId ? 1 : 0;
      a.grow += (growT - a.grow) * (1 - Math.exp(-dt / (growT ? 180 : 450)));
      const hopT = p.talking && p.st && p.st.mouth === 2 ? 1 : 0;
      a.hop += (hopT - a.hop) * (1 - Math.exp(-dt / (hopT ? 60 : 160)));
      a.target = L;
    });
    Array.from(anim.keys()).forEach((id) => { if (!seen.has(id)) anim.delete(id); });
    model.anyTalk = model.people.some((p) => p.talking);
  }

  function drawPerson(g, key, p, a, o = {}) {
    if (!p.art) return;
    const w = (o.w || a.w) * (1 + (GROW - 1) * (a.grow || 0)), h = w * 0.5625;
    const x = o.x != null ? o.x : a.x;
    const lift = o.top != null ? 0 : (10 * a.talk + 6 * a.hop);
    const top = o.top != null ? o.top : H - a.bottom - h - lift;
    // 後ろの淡い光
    if (a.talk > 0.02 && !o.ghost) {
      g.save();
      g.globalAlpha = a.talk * (o.alpha || 1);
      const cy = top + h * 0.4, r = w * 0.31;
      const rg = g.createRadialGradient(x, cy, 0, x, cy, r);
      rg.addColorStop(0, 'rgba(134,168,255,.55)'); rg.addColorStop(0.64, 'rgba(134,168,255,.18)'); rg.addColorStop(1, 'rgba(134,168,255,0)');
      g.fillStyle = rg;
      g.fillRect(x - r, cy - r, r * 2, r * 2);
      g.restore();
    }
    const c = off(key, w, h);
    const og = c.getContext('2d');
    og.clearRect(0, 0, c.width, c.height);
    A.drawPose(og, p.art, p.st, 0, 0, w, h);
    // 下のほうを透かす
    og.globalCompositeOperation = 'destination-in';
    const mg = og.createLinearGradient(0, 0, 0, h);
    mg.addColorStop(0, '#000'); mg.addColorStop(0.82, '#000'); mg.addColorStop(1, 'rgba(0,0,0,0)');
    og.fillStyle = mg;
    og.fillRect(0, 0, c.width, c.height);
    og.globalCompositeOperation = 'source-over';
    g.save();
    if (o.alpha != null) g.globalAlpha = o.alpha;
    const dim = o.ghost ? 0 : (g.__anyTalk ? 1 - a.talk : 0);
    if (dim > 0.01) g.filter = `brightness(${1 - 0.28 * dim}) saturate(${1 - 0.15 * dim})`;
    if (o.ghost) {
      g.translate(x, top + h / 2);
      g.rotate(-3 * Math.PI / 180);
      g.scale(1.04, 1.04);
      g.translate(-x, -(top + h / 2));
      g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 40; g.shadowOffsetY = 40;
    }
    // つかまれている絵: 足もとを中心に 1.05 倍、少し上へ、やわらかい影（録画にも映る）
    const lf = o.ghost ? 0 : (a.lift || 0);
    if (lf > 0.01) {
      g.translate(x, top + h);
      g.scale(1 + 0.05 * lf, 1 + 0.05 * lf);
      g.translate(-x, -(top + h) - 10 * lf);
      g.shadowColor = `rgba(0,0,0,${(0.4 * lf).toFixed(3)})`; g.shadowBlur = 36 * lf; g.shadowOffsetY = 18 * lf;
    }
    g.drawImage(c, x - w / 2, top);
    g.restore();
    // マイクオフの印は、全員を描いたあとに重ねる（となりの絵に隠れないように）
    if (p.mic === false && !o.ghost) badges.push({ x: x + w * 0.16, y: top + h * 0.22, r: o.small ? 16 : 20, alpha: o.alpha });
  }

  function drawBadge(g, b) {
    const r = b.r, mx = b.x + r, my = b.y + r;
    g.save();
    if (b.alpha != null) g.globalAlpha = b.alpha;
    g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
    g.beginPath(); g.arc(mx, my, r, 0, Math.PI * 2);
    g.fillStyle = '#f0656a'; g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.85)'; g.stroke();
    const sz = r * 1.1;
    drawIcon(g, 'micoff', mx - sz / 2, my - sz / 2, sz, '#fff', 1.8);
    g.restore();
  }

  function pill(g, x, y, w, h, r, fill, stroke) {
    g.beginPath(); g.roundRect(x, y, w, h, r);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = 1; g.strokeStyle = stroke; g.stroke(); }
  }

  function drawShow(g, model) {
    const show = model.show || 'キャラ会議';
    g.save();
    g.font = `800 ${model.share ? 24 : 30}px ${FONT}`;
    g.letterSpacing = model.share ? '1.4px' : '1.8px';
    g.textBaseline = 'middle';
    if (model.share) {
      const tw = g.measureText(show).width;
      pill(g, 100, 92, 8 + 38 + 14 + tw + 18, 54, 18, 'rgba(255,255,255,.75)');
      pill(g, 108, 100, 38, 38, 11, AC);
      drawIcon(g, 'bubble', 108 + 8, 100 + 8, 22, '#0f1422', 2);
      g.fillStyle = '#1d2438';
      g.fillText(show, 108 + 38 + 14, 119);
    } else {
      pill(g, 100, 96, 46, 46, 14, AC);
      drawIcon(g, 'bubble', 100 + 9, 96 + 9, 28, '#0f1422', 2);
      g.fillStyle = '#eef1f7';
      g.fillText(show, 100 + 46 + 14, 119);
    }
    g.restore();
  }

  function drawTopic(g, model) {
    if (model.share || !model.topic) return;
    g.save();
    g.font = `800 30px ${FONT}`;
    g.textBaseline = 'middle';
    const a = 'お題', b = '：', c = model.topic;
    const wa = g.measureText(a).width, wb = g.measureText(b).width, wc = g.measureText(c).width;
    const w = 34 + wa + wb + wc + 34;
    const x = 960 - w / 2, y = 92;
    pill(g, x, y, w, 60, 30, 'rgba(15,20,38,.55)', 'rgba(255,255,255,.12)');
    g.fillStyle = '#eef1f7'; g.fillText(a, x + 34, y + 31);
    g.fillStyle = AC; g.fillText(b, x + 34 + wa, y + 31);
    g.fillStyle = '#eef1f7'; g.fillText(c, x + 34 + wa + wb, y + 31);
    g.restore();
    model.__topicBox = { x, y, w, h: 60 };
  }

  function wrap(g, text, maxW) {
    const lines = [];
    let cur = '';
    for (const ch of Array.from(text)) {
      if (g.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; } else cur += ch;
    }
    if (cur) lines.push(cur);
    return lines.slice(-2);
  }

  function drawCaption(g, model) {
    const cap = model.caption;
    if (!cap || !cap.text || model.captionsOn === false) return;
    const share = !!model.share;
    const size = share ? 46 : 50;
    const bottom = share ? 132 : 500;
    g.save();
    g.globalAlpha = cap.alpha == null ? 1 : cap.alpha;
    g.font = `800 ${size}px ${FONT}`;
    g.letterSpacing = '1.5px';
    const lines = wrap(g, cap.text, share ? 1100 : 1640);
    const lh = Math.round(size * 1.3);
    const tw = Math.max(...lines.map((l) => g.measureText(l).width));
    const left = share ? 235 : 960 - tw / 2;
    const baseY = H - bottom;
    // 名前の札
    g.font = `800 24px ${FONT}`;
    g.letterSpacing = '2px';
    const nw = g.measureText(cap.name).width + 32;
    const tagY = baseY - lh * lines.length - 10 - 40 + 6;
    g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 14; g.shadowOffsetY = 4;
    pill(g, left + 4, tagY, nw, 40, 10, cap.color);
    g.shadowColor = 'transparent';
    g.fillStyle = inkOn(cap.color);
    g.textBaseline = 'middle';
    g.fillText(cap.name, left + 4 + 16, tagY + 21);
    // セリフ（黒い縁取りの白い字）
    g.font = `800 ${size}px ${FONT}`;
    g.letterSpacing = '1.5px';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    lines.forEach((l, i) => {
      const y = baseY - lh * (lines.length - 1 - i) - 8;
      g.save();
      g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 14; g.shadowOffsetY = 4;
      g.lineWidth = 6; g.strokeStyle = '#000';
      g.strokeText(l, left, y);
      g.restore();
      g.fillStyle = '#fff';
      g.fillText(l, left, y);
    });
    g.restore();
  }

  function drawShare(g, model) {
    g.fillStyle = '#e4e7ee';
    g.fillRect(0, 0, W, H);
    const v = model.share.video;
    if (v && v.videoWidth) {
      const s = Math.min(W / v.videoWidth, H / v.videoHeight);
      const dw = v.videoWidth * s, dh = v.videoHeight * s;
      g.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    const fl = g.createLinearGradient(0, H - 260, 0, H);
    fl.addColorStop(0, 'rgba(15,20,38,0)'); fl.addColorStop(1, 'rgba(15,20,38,.55)');
    g.fillStyle = fl; g.fillRect(0, H - 260, W, 260);
    // だれの画面か
    g.save();
    g.font = `700 19px ${FONT}`;
    g.textBaseline = 'middle';
    const t = `${model.share.ownerName}さんの画面`;
    const tw = g.measureText(t).width;
    const w = 20 + 20 + 10 + tw + 20, x = W - 100 - w;
    pill(g, x, 100, w, 46, 23, 'rgba(12,16,30,.82)');
    drawIcon(g, 'share', x + 20, 113, 20, AC);
    g.fillStyle = '#e6ebf7';
    g.fillText(t, x + 50, 124);
    g.restore();
  }

  function slot(g, x, from) {
    g.save();
    g.beginPath();
    g.roundRect(x - 170, H - 20 - 430, 340, 430, [40, 40, 18, 18]);
    g.setLineDash([12, 9]);
    g.lineWidth = 2.5;
    if (from) {
      g.fillStyle = 'rgba(255,255,255,.02)'; g.fill();
      g.strokeStyle = 'rgba(255,255,255,.18)'; g.stroke();
    } else {
      g.shadowColor = 'rgba(134,168,255,.35)'; g.shadowBlur = 40;
      g.fillStyle = 'rgba(134,168,255,.08)'; g.fill();
      g.strokeStyle = AC; g.stroke();
    }
    g.restore();
  }

  // ui: 見せる側だけの手がかり（{ drag: { id, px, py, targetId } }）
  function render(g, model, ui) {
    g.save();
    // 録画を小さい大きさ（1280×720 など）で撮るときは、canvas の幅に合わせて縮めて描く（画面の canvas は幅 1920 なのでそのまま）
    const k = g.canvas.width / W;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.filter = 'none';
    g.globalAlpha = 1;
    if (model.share) drawShare(g, model);
    else g.drawImage(background(), 0, 0);
    drawShow(g, model);
    drawTopic(g, model);
    g.__anyTalk = model.people.some((p) => p.talking);
    badges = [];
    const drag = ui && ui.drag;
    const z = model.z || {};
    const live = model.live || {};
    const zs = (p) => ((drag && drag.id === p.id) || (live[p.id] && live[p.id].on) ? Infinity : Number(z[p.id]) || 0);
    // 重なったときは、最後に触れた人（z が大きい人）を前に
    const order = model.people.map((p, i) => [p, i]).sort((a, b) => zs(a[0]) - zs(b[0]) || a[1] - b[1]).map((x) => x[0]);
    order.forEach((p) => {
      const a = anim.get(p.id);
      if (!a) return;
      drawPerson(g, `${model.key}-${p.id}`, p, a, { small: !!model.share });
    });
    badges.forEach((b) => drawBadge(g, b));
    drawCaption(g, model);
    g.restore();
  }

  return { update, render, anim, computeLayout };
}
