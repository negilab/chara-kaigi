// 会議と管理画面で共通に使うもの（キャラの一覧・アイコン・小さな道具）
import './voice-engine.js';
import './avatar-render.js';

export const E = globalThis.VoiceChangerEngine;
export const A = globalThis.VoiceChangerAvatar;

export const CHARS = [
  { id: 'sennin', name: '仙人', bg: '#CFBDF7' },
  { id: 'hyokkori', name: 'ひょっこり', bg: '#B61A01' },
  { id: 'exotic', name: 'エキゾチック', bg: '#C5C5C5' },
  { id: 'interi', name: 'インテリ', bg: '#D7D7D7' },
  { id: 'okan', name: 'オカン', bg: '#4EBF7F' },
  { id: 'gaki', name: 'ガキ', bg: '#8D8D8D' }
];
export const CHAR_IDS = CHARS.map((c) => c.id);
export function charOf(id) { return CHARS.find((c) => c.id === id) || CHARS[0]; }

// 明るい背景なら濃い字、暗い背景なら白い字
export function inkOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#1a1f2e' : '#fff';
}

// 声の初期値（管理画面で何も保存されていないときに使う）
export function builtinDefaults() {
  const out = {};
  E.sampleChars().forEach((c) => {
    out[c.art] = { pitch: c.pitch, tone: c.tone, fx: c.fx };
  });
  return out;
}

// 声の設定を整える（範囲の外の値・欠けた値を直す）
export function cleanVoice(v) {
  const n = E.normalize({ pitch: v && v.pitch, tone: v && v.tone, fx: v && v.fx, eq: v && v.eq });
  return { pitch: n.pitch, tone: n.tone, fx: n.fx, eq: n.eq };
}

// 整えた6人分の初期値（足りない分は既定）
// _echoButton: 会議の「エコー」ボタンの響き（全キャラ共通。無ければ既定の響き）。/defaults/v の中に一緒に保存する
export function cleanDefaults(v) {
  const base = builtinDefaults();
  const out = {};
  CHAR_IDS.forEach((id) => { out[id] = cleanVoice((v && v[id]) || base[id]); });
  out._echoButton = E.normalizeEchoButton(v && v._echoButton);
  return out;
}

// キャラの絵（背景を抜いた版）を読み込む。読み込みは1回だけ
const artCache = new Map();
export function loadArt(id) {
  if (!artCache.has(id)) {
    artCache.set(id, A.loadArt(new URL(`../characters/${id}/`, import.meta.url).href, {
      base: 'base.png', mouthOpen: 'mouth_open.png',
      mouthHalf: id === 'sennin' || id === 'gaki' ? 'mouth_half.png' : null,
      eyesClosed: id === 'okan' || id === 'gaki' ? null : 'eyes_closed.png'
    }).catch((e) => { artCache.delete(id); throw e; }));
  }
  return artCache.get(id);
}
export function loadAllArts() {
  return Promise.all(CHAR_IDS.map((id) => loadArt(id).catch(() => null)));
}

export const ICONS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  micoff: '<path d="M9 9V6a3 3 0 0 1 5.8-1M15 10v1a3 3 0 0 1-4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.5 11c0 .8-.1 1.5-.4 2.2M12 17.5V21M8.5 21h7M4 4l16 16"/>',
  swap: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/><path d="M17.5 3.5l2 2-2 2M19.5 5.5H16"/>',
  share: '<rect x="3" y="4.5" width="18" height="12" rx="2.5"/><path d="M8.5 20h7M12 16.5V20M12 13V8M9.5 10.5L12 8l2.5 2.5"/>',
  cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.2a2.3 2.3 0 1 0 0 3.6M17 10.2a2.3 2.3 0 1 0 0 3.6"/>',
  save: '<path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z"/><path d="M14 3.5V8h4M9 12.5h6M9 16h4"/>',
  leave: '<path d="M3.5 13.5c4.6-4 12.4-4 17 0l-2 2.5-3-1.2v-2.4c-2.3-.7-4.7-.7-7 0v2.4l-3 1.2z"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  bubble: '<path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V16h0a2 2 0 0 1-2-2z"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  file: '<path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z"/><path d="M14 3.5V8h4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h0"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  echo: '<path d="M4 12h2.5M9 8.5v7M13 6v12M17 9v6M20.5 11v2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>'
};
export function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}
export const GRIP_SVG = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13" r="1.5"/><circle cx="7.5" cy="13" r="1.5"/></svg>';

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function pad2(n) { return String(n).padStart(2, '0'); }
export function hhmm(t) { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
export function ymd(t) { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// 声の調整の部品（管理画面と、会議の「声を調整」で同じものを使う）
// root に描き、値が変わるたびに onChange(voice) を呼ぶ
// opts.detail = true のときだけ、各エフェクトに「詳しく」を出す（管理画面）。会議では出さないが、詳しい値はそのまま残る
export function voiceEditor(root, voice, onChange, opts = {}) {
  let v = cleanVoice(voice);
  const detail = !!opts.detail;
  const dec = (step) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  const fmt = (x, d) => `${Number(x.toFixed(dec(d.step)))}${d.unit ? ` ${d.unit}` : ''}`;
  // 詳しい値: 保存されていればそれ、無ければ今までどおりの値（強さから決まる）
  const dval = (e, d) => (d.k === 'amt' ? e.amt : typeof e[d.k] === 'number' ? e[d.k] : d.def(e.amt / 100));
  const pct = (x, lo, hi) => ((x - lo) / (hi - lo)) * 100;
  const sgn = (x) => (x > 0 ? `+${x}` : `${x}`);
  root.innerHTML = `
    <div class="ve-cols">
      <div class="ve-c1"><div class="box">
        <label class="ve-sl"><div class="t"><span>声の高さ</span><b data-o="pitch"></b></div>
          <input type="range" data-k="pitch" min="${E.PITCH_MIN}" max="${E.PITCH_MAX}" step="1">
          <div class="ends"><span>低い</span><span>高い</span></div></label>
        <label class="ve-sl" style="margin-top:16px"><div class="t"><span>音色</span><b data-o="tone"></b></div>
          <input type="range" data-k="tone" min="${E.TONE_MIN}" max="${E.TONE_MAX}" step="1">
          <div class="ends"><span>こもる</span><span>明るい</span></div></label>
      </div>
      <div class="box eqb"><div class="eq-h"><span>イコライザー</span><button type="button" class="eq-r" data-eqreset>元に戻す</button></div>${E.EQ_BANDS.map((b, i) => `
        <label class="fxd-r"><span class="fxd-l">${esc(b.label)}<i class="eq-f">${b.f >= 1000 ? `${b.f / 1000}k` : b.f}Hz</i></span>
          <input type="range" data-eq="${i}" min="${E.EQ_MIN}" max="${E.EQ_MAX}" step="1" aria-label="イコライザーの${esc(b.label)}">
          <b class="fxd-v" data-eqv="${i}"></b></label>`).join('')}
      </div></div>
      <div class="ve-c2"><div class="lbl">エフェクト</div>
        <div class="box fxs">${E.FX_LIST.map((f) => `
          <div class="fx" data-fx="${f.key}">
            <button type="button" class="sw" role="switch" aria-label="${esc(f.label)}"></button>
            <span class="n">${esc(f.label)}</span>
            <input type="range" class="s2" min="0" max="100" step="1" aria-label="${esc(f.label)}の強さ">
            ${detail ? `<button type="button" class="fxd-t" data-fxt="${f.key}" aria-expanded="false" aria-controls="fxd-${f.key}">詳しく</button>` : ''}
          </div>${detail ? `
          <div class="fxd" id="fxd-${f.key}" data-fxd="${f.key}" hidden>${E.FX_DETAIL[f.key].map((d) => `
            <label class="fxd-r"><span class="fxd-l">${esc(d.label)}</span>
              <input type="range" data-dk="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}" aria-label="${esc(f.label)}の${esc(d.label)}">
              <b class="fxd-v" data-dv="${d.k}"></b></label>`).join('')}
          </div>` : ''}`).join('')}</div>
      </div>
    </div>`;
  function paint() {
    E.EQ_BANDS.forEach((b, i) => {
      const inp = root.querySelector(`input[data-eq="${i}"]`);
      inp.value = v.eq[i];
      inp.style.setProperty('--p', pct(v.eq[i], E.EQ_MIN, E.EQ_MAX) + '%');
      root.querySelector(`[data-eqv="${i}"]`).textContent = `${sgn(v.eq[i])} dB`;
    });
    ['pitch', 'tone'].forEach((k) => {
      const inp = root.querySelector(`input[data-k="${k}"]`);
      inp.value = v[k];
      inp.style.setProperty('--p', pct(v[k], +inp.min, +inp.max) + '%');
      root.querySelector(`[data-o="${k}"]`).textContent = sgn(v[k]);
    });
    E.FX_LIST.forEach((f) => {
      const row = root.querySelector(`[data-fx="${f.key}"]`);
      const e = v.fx[f.key];
      row.classList.toggle('off', !e.on);
      const sw = row.querySelector('.sw');
      sw.classList.toggle('on', e.on);
      sw.setAttribute('aria-checked', e.on ? 'true' : 'false');
      const r = row.querySelector('input');
      r.value = e.amt;
      r.style.setProperty('--p', e.amt + '%');
      const box = detail && root.querySelector(`[data-fxd="${f.key}"]`);
      if (!box) return;
      box.classList.toggle('off', !e.on);
      E.FX_DETAIL[f.key].forEach((d) => {
        const x = dval(e, d);
        const inp = box.querySelector(`input[data-dk="${d.k}"]`);
        inp.value = x;
        inp.style.setProperty('--p', pct(x, d.min, d.max) + '%');
        box.querySelector(`[data-dv="${d.k}"]`).textContent = fmt(x, d);
      });
    });
  }
  root.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset.k) v[t.dataset.k] = Number(t.value);
    if (t.dataset.eq != null) v.eq[Number(t.dataset.eq)] = Number(t.value);
    if (t.dataset.dk) {
      const e = v.fx[t.closest('[data-fxd]').dataset.fxd];
      if (t.dataset.dk === 'amt') e.amt = Number(t.value); else e[t.dataset.dk] = Number(t.value);
    }
    const row = t.closest('[data-fx]');
    if (row && t.tagName === 'INPUT') v.fx[row.dataset.fx].amt = Number(t.value);
    paint();
    onChange(cleanVoice(v));
  });
  root.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-eqreset]')) {
      v.eq = E.EQ_BANDS.map(() => 0);
      paint();
      onChange(cleanVoice(v));
      return;
    }
    const tg = ev.target.closest('.fxd-t');
    if (tg) {
      const box = root.querySelector(`[data-fxd="${tg.dataset.fxt}"]`);
      box.hidden = !box.hidden;
      tg.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
      tg.textContent = box.hidden ? '詳しく' : '閉じる';
      return;
    }
    const sw = ev.target.closest('.sw');
    if (!sw) return;
    const key = sw.closest('[data-fx]').dataset.fx;
    v.fx[key].on = !v.fx[key].on;
    paint();
    onChange(cleanVoice(v));
  });
  paint();
  return {
    set(nv) { v = cleanVoice(nv); paint(); },
    get() { return cleanVoice(v); }
  };
}
