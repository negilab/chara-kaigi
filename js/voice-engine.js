/*
 * ボイスチェンジャー 音の加工（共通）
 * サイドパネルの試聴・Meet への差し込み・テスト用ページで同じものを使う。
 * Web Audio の標準ノードだけで組む（AudioWorklet は使わない）。
 */
(function (root) {
  'use strict';
  if (root.VoiceChangerEngine) return;

  var FX_LIST = [
    { key: 'echo', label: 'ディレイ' },   // 保存の名前は echo のまま（前に保存した値がそのまま使える）
    { key: 'reverb', label: 'リバーブ' },
    { key: 'distortion', label: 'ディストーション' },
    { key: 'mellow', label: 'まろやか' },
    { key: 'phaser', label: 'フェイザー' },
    { key: 'flanger', label: 'フランジャー' },
    { key: 'chorus', label: 'コーラス' },
    { key: 'tremolo', label: 'トレモロ' },
    { key: 'robot', label: 'ロボット' },
    { key: 'radio', label: '無線・電話' }
  ];
  // 各エフェクトの詳しい設定（管理画面の「詳しく」）。
  // k: 保存する名前（'amt' は、行のつまみと同じ「強さ」）。def(a): 値が無いときの今までどおりの値（a = amt/100）。
  // 値が保存されていなければ、音は今までとまったく同じになる。
  function r1(v) { return Math.round(v * 10) / 10; }
  var AMT = { k: 'amt', label: '強さ', min: 0, max: 100, step: 1, unit: '' };
  var FX_DETAIL = {
    echo: [
      { k: 'time', label: '間隔', min: 60, max: 1000, step: 10, unit: 'ms', def: function (a) { return Math.round((0.12 + 0.33 * a) * 1000); } },
      { k: 'repeats', label: '返りの回数', min: 1, max: 12, step: 0.5, unit: '回', def: function (a) { return r1(-2 / Math.log10(0.25 + 0.4 * a)); } },
      AMT
    ],
    reverb: [
      { k: 'size', label: '響く広さ', min: 0.5, max: 5, step: 0.1, unit: '秒', def: function () { return 2.2; } },
      AMT
    ],
    mellow: [
      { k: 'round', label: '丸さ', min: 1500, max: 8000, step: 50, unit: 'Hz', def: function (a) { return Math.round((6000 - 4000 * a) / 50) * 50; } },
      { k: 'smooth', label: 'なめらかさ', min: 0, max: 100, step: 1, unit: '', def: function (a) { return Math.round(20 + 60 * a); } }
    ],
    distortion: [
      { k: 'drive', label: '歪み', min: 1, max: 40, step: 0.5, unit: '倍', def: function (a) { return r1(1 + 30 * a); } },
      { k: 'vol', label: '音量', min: 5, max: 150, step: 1, unit: '%', def: function (a) { return Math.round(80 / (1 + 1.5 * a)); } }
    ],
    phaser: [
      { k: 'speed', label: '速さ', min: 0.05, max: 6, step: 0.05, unit: 'Hz', def: function (a) { return Math.round((0.2 + 0.8 * a) * 100) / 100; } },
      { k: 'depth', label: '深さ', min: 100, max: 1500, step: 10, unit: 'Hz', def: function (a) { return Math.round(300 + 600 * a); } }
    ],
    flanger: [
      { k: 'speed', label: '速さ', min: 0.05, max: 6, step: 0.05, unit: 'Hz', def: function (a) { return Math.round((0.15 + 0.5 * a) * 100) / 100; } },
      { k: 'depth', label: '深さ', min: 0.2, max: 5, step: 0.1, unit: 'ms', def: function (a) { return r1((0.001 + 0.0025 * a) * 1000); } },
      { k: 'fb', label: '強さ', min: 0, max: 95, step: 1, unit: '%', def: function (a) { return Math.round((0.3 + 0.5 * a) * 100); } }
    ],
    chorus: [
      { k: 'speed', label: '速さ', min: 0.2, max: 8, step: 0.1, unit: 'Hz', def: function () { return 0.8; } },
      { k: 'depth', label: '深さ', min: 0.5, max: 8, step: 0.1, unit: 'ms', def: function (a) { return r1((0.001 + 0.004 * a) * 1000); } },
      AMT
    ],
    tremolo: [
      { k: 'speed', label: '速さ', min: 1, max: 30, step: 0.5, unit: 'Hz', def: function (a) { return r1(3 + 6 * a); } },
      { k: 'depth', label: '深さ', min: 0, max: 100, step: 1, unit: '%', def: function (a) { return Math.round((0.3 + 0.7 * a) * 100); } }
    ],
    robot: [
      { k: 'pitch', label: '声の高さ', min: 60, max: 300, step: 5, unit: 'Hz', def: function () { return 110; } },
      AMT
    ],
    radio: [
      { k: 'narrow', label: '音の細さ', min: 0, max: 100, step: 1, unit: '', def: function (a) { return Math.round(a * 100); } },
      { k: 'grit', label: 'ざらつき', min: 1, max: 10, step: 0.1, unit: '倍', def: function (a) { return r1(1 + 4 * a); } },
      { k: 'mix', label: '強さ', min: 0, max: 100, step: 1, unit: '%', def: function () { return 100; } }
    ]
  };
  // 会議の「エコー」ボタン（押しているあいだだけ、ディレイ＋リバーブを重ねる）の響き。全キャラ共通
  var ECHO_BUTTON = [
    { k: 'time', label: 'ディレイの間隔', min: 60, max: 1000, step: 10, unit: 'ms', def: 280 },
    { k: 'repeats', label: '返りの回数', min: 1, max: 12, step: 0.5, unit: '回', def: 5 },
    { k: 'size', label: 'リバーブの広さ', min: 0.5, max: 5, step: 0.1, unit: '秒', def: 2.6 },
    { k: 'mix', label: '強さ', min: 0, max: 100, step: 1, unit: '%', def: 60 }
  ];
  // 範囲に収める。無い値（前のデータ）は既定の値
  function normalizeEchoButton(o) {
    o = o && typeof o === 'object' ? o : {};
    var out = {};
    ECHO_BUTTON.forEach(function (d) {
      var v = Number(o[d.k]);
      if (o[d.k] == null || o[d.k] === '' || !isFinite(v)) v = d.def;
      v = Math.min(d.max, Math.max(d.min, v));
      out[d.k] = Math.round(Math.round(v / d.step) * d.step * 1000) / 1000;
    });
    return out;
  }

  // 保存されている詳しい値を範囲に収める（知らない名前は捨てる）
  function cleanDetail(key, e) {
    var out = {};
    (FX_DETAIL[key] || []).forEach(function (d) {
      if (d.k === 'amt' || e[d.k] == null || e[d.k] === '') return;
      var v = Number(e[d.k]);
      if (!isFinite(v)) return;
      v = Math.min(d.max, Math.max(d.min, v));
      out[d.k] = Math.round(v / d.step) * d.step;
      out[d.k] = Math.round(out[d.k] * 1000) / 1000;
    });
    return out;
  }
  // 詳しい値があればそれ、無ければ今までどおりの式
  function dv(e, k, fallback) { return e && typeof e[k] === 'number' && isFinite(e[k]) ? e[k] : fallback; }

  // キャラの絵（extension/characters/<id>/ に部品がある）
  var ART_LIST = [
    { id: 'sennin', label: '仙人' },
    { id: 'hyokkori', label: 'ひょっこり' },
    { id: 'exotic', label: 'エキゾチック' },
    { id: 'interi', label: 'インテリ' },
    { id: 'okan', label: 'オカン' },
    { id: 'gaki', label: 'ガキ' }
  ];
  function isArtId(v) { return typeof v === 'string' && ART_LIST.some(function (a) { return a.id === v; }); }

  var PITCH_MIN = -12, PITCH_MAX = 24, TONE_MIN = -10, TONE_MAX = 10;
  var NAME_MAX = 20;

  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) v = 0;
    return Math.min(hi, Math.max(lo, v));
  }

  function makeId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function defaultFx() {
    var fx = {};
    FX_LIST.forEach(function (f) { fx[f.key] = { on: false, amt: 50 }; });
    return fx;
  }

  function newChar(name) {
    return { id: makeId(), name: name || '新しいキャラ', pitch: 0, tone: 0, fx: defaultFx(), art: '' };
  }

  // イコライザー（5つの帯域。それぞれ ±12dB、既定 0）
  var EQ_BANDS = [
    { f: 100, label: '低音' },
    { f: 300, label: '中低音' },
    { f: 1000, label: '中音' },
    { f: 3000, label: '中高音' },
    { f: 8000, label: '高音' }
  ];
  var EQ_MIN = -12, EQ_MAX = 12;
  function cleanEq(a) {
    a = Array.isArray(a) ? a : [];
    return EQ_BANDS.map(function (b, i) { return Math.round(clamp(a[i] == null ? 0 : a[i], EQ_MIN, EQ_MAX)); });
  }

  // 値を決まった範囲に収めた写しを返す
  function normalize(c) {
    c = c || {};
    var out = {
      id: typeof c.id === 'string' && c.id ? c.id : makeId(),
      name: String(c.name == null ? '' : c.name).slice(0, NAME_MAX),
      pitch: Math.round(clamp(c.pitch, PITCH_MIN, PITCH_MAX)),
      tone: Math.round(clamp(c.tone, TONE_MIN, TONE_MAX)),
      fx: defaultFx(),
      eq: cleanEq(c.eq),
      art: isArtId(c.art) ? c.art : ''
    };
    var src = c.fx || {};
    FX_LIST.forEach(function (f) {
      var e = src[f.key];
      if (e && typeof e === 'object') {
        out.fx[f.key] = Object.assign({ on: e.on === true, amt: Math.round(clamp(e.amt == null ? 50 : e.amt, 0, 100)) }, cleanDetail(f.key, e));
      }
    });
    return out;
  }

  // 初めの見本のキャラ（声は仮の値）
  // since: その見本を足した版（seedVersion）。版が上がったときは、新しく増えた見本だけ足す
  var SEED_VERSION = 3;
  var SAMPLE_SINCE = { '仙人': 2, 'ひょっこり': 2, 'エキゾチック': 2, 'インテリ': 2, 'オカン': 2, 'ガキ': 3 };
  function sampleChars() {
    function ch(name, art, pitch, tone, fx) {
      var c = newChar(name);
      c.art = art;
      c.pitch = pitch; c.tone = tone;
      Object.keys(fx || {}).forEach(function (k) { c.fx[k] = { on: true, amt: fx[k] }; });
      return c;
    }
    return [
      ch('仙人', 'sennin', -5, -1, { reverb: 40 }),
      ch('ひょっこり', 'hyokkori', 6, 3),
      ch('エキゾチック', 'exotic', -2, 0, { chorus: 45 }),
      ch('インテリ', 'interi', 0, 1, { radio: 25 }),
      ch('オカン', 'okan', 3, 1, { reverb: 20 }),
      ch('ガキ', 'gaki', 5, 1, { distortion: 25 })
    ];
  }

  // 保存済みの一覧に、fromVersion より後に増えた見本のキャラを足す
  // （同じ名前があれば足さない。今のキャラは消さない。前に足して消されたものは足し直さない）
  function mergeSamples(chars, max, fromVersion) {
    var from = typeof fromVersion === 'number' ? fromVersion : 0;
    var list = Array.isArray(chars) ? chars.slice() : [];
    var names = new Set(list.map(function (c) { return c && c.name; }));
    sampleChars().forEach(function (c) {
      if ((SAMPLE_SINCE[c.name] || 0) <= from) return;
      if (names.has(c.name) || (max && list.length >= max)) return;
      list.push(c);
      names.add(c.name);
    });
    return list;
  }

  // ---------- ここから音のグラフ ----------

  var TC = 0.03; // 値を変えるときのなめらかさ（秒）

  function setP(ctx, param, v) {
    var t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setTargetAtTime(v, t, TC);
  }

  // 素通し（dry）と加工（wet）を混ぜる入れ物
  function makeStage(ctx) {
    var st = {
      input: ctx.createGain(),
      dry: ctx.createGain(),
      wet: ctx.createGain(),
      output: ctx.createGain()
    };
    st.wet.gain.value = 0;
    st.input.connect(st.dry);
    st.dry.connect(st.output);
    st.wet.connect(st.output);
    st.mix = function (d, w) { setP(ctx, st.dry.gain, d); setP(ctx, st.wet.gain, w); };
    return st;
  }

  function makeLfo(ctx, freq, depth, starters) {
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    starters.push(osc);
    return { osc: osc, gain: g };
  }

  function softCurve(drive) {
    var n = 2048, curve = new Float32Array(n), norm = Math.tanh(drive);
    for (var i = 0; i < n; i++) {
      var x = i / (n - 1) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / norm;
    }
    return curve;
  }

  function makeImpulse(ctx, seconds, decay) {
    var rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // 声の高さ: 2本のディレイの遅れを鋸歯状に動かし、継ぎ目を交互に消す（"Jungle" 方式）
  function buildPitch(ctx, st, starters) {
    var MIN_D = 0.005, MAX_D = 0.06;
    var len = ctx.sampleRate; // 1 秒ぶんの表
    function table(fn) {
      var b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = fn(i / len);
      return b;
    }
    function win(p) { var s = Math.sin(Math.PI * p); return s * s; }
    var defs = [
      [table(function (p) { return p; }), table(function (p) { return win(p); })],
      [table(function (p) { return (p + 0.5) % 1; }), table(function (p) { return win((p + 0.5) % 1); })]
    ];
    var lines = [], sources = [];
    defs.forEach(function (d) {
      var delay = ctx.createDelay(0.2);
      var mod = ctx.createGain();
      var rs = ctx.createBufferSource(); rs.buffer = d[0]; rs.loop = true;
      rs.connect(mod); mod.connect(delay.delayTime);
      var fade = ctx.createGain(); fade.gain.value = 0;
      var ws = ctx.createBufferSource(); ws.buffer = d[1]; ws.loop = true;
      ws.connect(fade.gain);
      st.input.connect(delay); delay.connect(fade); fade.connect(st.wet);
      lines.push({ delay: delay, mod: mod });
      sources.push(rs, ws);
    });
    sources.forEach(function (s) { s.playbackRate.value = 0; starters.push(s); });

    return function (semi) {
      if (!semi) { st.mix(1, 0); return; }
      var r = Math.pow(2, semi / 12);
      var rate = Math.abs(r - 1) / MAX_D; // 表（1 秒）を何倍速で回すか
      sources.forEach(function (s) { s.playbackRate.value = rate; });
      lines.forEach(function (l) {
        if (r < 1) { l.delay.delayTime.value = MIN_D; l.mod.gain.value = MAX_D; }
        else { l.delay.delayTime.value = MIN_D + MAX_D; l.mod.gain.value = -MAX_D; }
      });
      st.mix(0, 1);
    };
  }

  function buildEffects(ctx, starters) {
    var fx = {};

    // エコー
    (function () {
      var st = makeStage(ctx);
      var d = ctx.createDelay(1.5), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3000;
      st.input.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); d.connect(st.wet);
      fb.gain.value = 0;
      st.set = function (on, k, e) {
        if (!on) { setP(ctx, fb.gain, 0); st.mix(1, 0); return; }
        setP(ctx, d.delayTime, dv(e, 'time', null) != null ? e.time / 1000 : 0.12 + 0.33 * k);
        // 返りの回数 N: N 回返ったところで 1/100（-40dB）まで小さくなる戻りの量
        setP(ctx, fb.gain, dv(e, 'repeats', null) != null ? Math.min(0.9, Math.pow(10, -2 / e.repeats)) : 0.25 + 0.4 * k);
        st.mix(1, 0.35 + 0.45 * k);
      };
      st.nodes = { delayTime: d.delayTime, feedback: fb.gain, wet: st.wet.gain };
      fx.echo = st;
    })();

    // リバーブ
    (function () {
      var st = makeStage(ctx);
      var cv = ctx.createConvolver();
      cv.normalize = true;
      cv.buffer = makeImpulse(ctx, 2.2, 3);
      st.input.connect(cv); cv.connect(st.wet);
      var size = 2.2;
      st.set = function (on, k, e) {
        if (!on) { st.mix(1, 0); return; }
        var want = dv(e, 'size', 2.2);
        if (want !== size) { size = want; cv.buffer = makeImpulse(ctx, size, 3); }
        st.mix(1, 0.15 + 0.85 * k);
      };
      st.nodes = { wet: st.wet.gain, impulseSeconds: { get value() { return cv.buffer ? cv.buffer.duration : 0; } } };
      fx.reverb = st;
    })();

    // ディストーション
    (function () {
      var st = makeStage(ctx);
      var pre = ctx.createGain(), sh = ctx.createWaveShaper(), post = ctx.createGain();
      sh.curve = softCurve(2.5); sh.oversample = '4x';
      st.input.connect(pre); pre.connect(sh); sh.connect(post); post.connect(st.wet);
      st.set = function (on, k, e) {
        if (!on) { st.mix(1, 0); return; }
        setP(ctx, pre.gain, dv(e, 'drive', 1 + 30 * k));
        setP(ctx, post.gain, dv(e, 'vol', null) != null ? e.vol / 100 : 0.8 / (1 + 1.5 * k));
        st.mix(0, 1);
      };
      st.nodes = { drive: pre.gain, volume: post.gain };
      fx.distortion = st;
    })();

    // まろやか: 高い音をやわらかく削り（ローパス）、大きさの差をゆるくならす（コンプレッサー）
    (function () {
      var st = makeStage(ctx);
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = 6000;
      var comp = ctx.createDynamicsCompressor();
      comp.knee.value = 12; comp.attack.value = 0.01; comp.release.value = 0.25; comp.threshold.value = -16; comp.ratio.value = 2;
      var mk = ctx.createGain();   // ならしたぶん小さくなる音を少し戻す
      st.input.connect(lp); lp.connect(comp); comp.connect(mk); mk.connect(st.wet);
      st.set = function (on, k, e) {
        if (!on) { st.mix(1, 0); return; }   // 切っているときは素通し
        var cut = dv(e, 'round', (6000 - 4000 * k));    // 強さが上がるほど低く（丸く）
        var sm = dv(e, 'smooth', 20 + 60 * k) / 100;     // 強さが上がるほど強くならす
        setP(ctx, lp.frequency, cut);
        setP(ctx, comp.threshold, -10 - 30 * sm);        // -10〜-40dB
        setP(ctx, comp.ratio, 1.5 + 4.5 * sm);           // 1.5〜6
        setP(ctx, mk.gain, 1 + 0.6 * sm);
        st.mix(0, 1);
      };
      st.nodes = { cutoff: lp.frequency, threshold: comp.threshold, ratio: comp.ratio, makeup: mk.gain };
      fx.mellow = st;
    })();

    // フェイザー
    (function () {
      var st = makeStage(ctx);
      var lfo = makeLfo(ctx, 0.5, 600, starters);
      var prev = st.input;
      for (var i = 0; i < 4; i++) {
        var ap = ctx.createBiquadFilter();
        ap.type = 'allpass'; ap.frequency.value = 1200; ap.Q.value = 0.7;
        lfo.gain.connect(ap.frequency);
        prev.connect(ap); prev = ap;
      }
      prev.connect(st.wet);
      st.set = function (on, k, e) {
        if (!on) { st.mix(1, 0); return; }
        setP(ctx, lfo.osc.frequency, dv(e, 'speed', 0.2 + 0.8 * k));
        setP(ctx, lfo.gain.gain, dv(e, 'depth', 300 + 600 * k));
        st.mix(0.7, 0.7);
      };
      st.nodes = { speed: lfo.osc.frequency, depth: lfo.gain.gain };
      fx.phaser = st;
    })();

    // フランジャー
    (function () {
      var st = makeStage(ctx);
      var d = ctx.createDelay(0.05), fb = ctx.createGain();
      d.delayTime.value = 0.004;
      var lfo = makeLfo(ctx, 0.25, 0.002, starters);
      lfo.gain.connect(d.delayTime);
      st.input.connect(d); d.connect(fb); fb.connect(d); d.connect(st.wet);
      fb.gain.value = 0;
      st.set = function (on, k, e) {
        if (!on) { setP(ctx, fb.gain, 0); st.mix(1, 0); return; }
        setP(ctx, fb.gain, dv(e, 'fb', null) != null ? e.fb / 100 : 0.3 + 0.5 * k);
        setP(ctx, lfo.gain.gain, dv(e, 'depth', null) != null ? e.depth / 1000 : 0.001 + 0.0025 * k);
        setP(ctx, lfo.osc.frequency, dv(e, 'speed', 0.15 + 0.5 * k));
        st.mix(0.7, 0.7);
      };
      st.nodes = { feedback: fb.gain, depth: lfo.gain.gain, speed: lfo.osc.frequency };
      fx.flanger = st;
    })();

    // コーラス
    (function () {
      var st = makeStage(ctx);
      var sum = ctx.createGain(); sum.gain.value = 0.4;
      var lfos = [];
      [[0.02, 0.8], [0.025, 1.1], [0.03, 1.4]].forEach(function (p) {
        var d = ctx.createDelay(0.1);
        d.delayTime.value = p[0];
        var lfo = makeLfo(ctx, p[1], 0.003, starters);
        lfo.gain.connect(d.delayTime);
        st.input.connect(d); d.connect(sum);
        lfos.push(lfo);
      });
      sum.connect(st.wet);
      var BASE_HZ = [0.8, 1.1, 1.4];
      st.set = function (on, k, e) {
        if (!on) { st.mix(1, 0); return; }
        var depth = dv(e, 'depth', null) != null ? e.depth / 1000 : 0.001 + 0.004 * k;
        var sp = dv(e, 'speed', 0.8) / 0.8;   // 3つの揺れの速さを、同じ割合で変える
        lfos.forEach(function (l, i) { setP(ctx, l.gain.gain, depth); setP(ctx, l.osc.frequency, BASE_HZ[i] * sp); });
        st.mix(0.8, 0.4 + 0.5 * k);
      };
      st.nodes = { depth: lfos[0].gain.gain, speed: lfos[0].osc.frequency, wet: st.wet.gain };
      fx.chorus = st;
    })();

    // トレモロ
    (function () {
      var st = makeStage(ctx);
      var amp = ctx.createGain(); amp.gain.value = 1;
      var lfo = makeLfo(ctx, 5, 0, starters);
      lfo.gain.connect(amp.gain);
      st.input.connect(amp); amp.connect(st.wet);
      st.set = function (on, k, e) {
        if (!on) { setP(ctx, lfo.gain.gain, 0); st.mix(1, 0); return; }
        var depth = dv(e, 'depth', null) != null ? e.depth / 100 : 0.3 + 0.7 * k;
        setP(ctx, amp.gain, 1 - depth / 2);
        setP(ctx, lfo.gain.gain, depth / 2);
        setP(ctx, lfo.osc.frequency, dv(e, 'speed', 3 + 6 * k));
        st.mix(0, 1);
      };
      st.nodes = { depth: lfo.gain.gain, speed: lfo.osc.frequency };
      fx.tremolo = st;
    })();

    // ロボット: 短い遅れの繰り返し（金属っぽさ）＋ 低い音で揺らす（リング変調）
    (function () {
      var st = makeStage(ctx);
      var combIn = ctx.createGain(), d = ctx.createDelay(0.05), fb = ctx.createGain();
      d.delayTime.value = 1 / 110;
      fb.gain.value = 0;
      st.input.connect(combIn); combIn.connect(d); d.connect(fb); fb.connect(d);
      var ring = ctx.createGain(); ring.gain.value = 1;
      combIn.connect(ring); d.connect(ring);
      var lfo = makeLfo(ctx, 50, 0, starters);
      lfo.gain.connect(ring.gain);
      var post = ctx.createGain(); post.gain.value = 0.6;
      ring.connect(post); post.connect(st.wet);
      st.set = function (on, k, e) {
        if (!on) { setP(ctx, fb.gain, 0); st.mix(1, 0); return; }
        setP(ctx, d.delayTime, 1 / dv(e, 'pitch', 110));   // 金属っぽい音の高さ（今までは 110Hz で決まり）
        var m = 0.5 + 0.5 * k;
        setP(ctx, fb.gain, 0.3 + 0.5 * k);
        setP(ctx, ring.gain, 1 - m);
        setP(ctx, lfo.gain.gain, m);
        setP(ctx, lfo.osc.frequency, 30 + 40 * k);
        st.mix(0, 1);
      };
      st.nodes = { combDelay: d.delayTime, feedback: fb.gain, ringFreq: lfo.osc.frequency };
      fx.robot = st;
    })();

    // 無線・電話: 帯域を狭め、少し歪ませる
    (function () {
      var st = makeStage(ctx);
      var hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), pk = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.Q.value = 0.7;
      lp.type = 'lowpass'; lp.Q.value = 1;
      pk.type = 'peaking'; pk.frequency.value = 1500; pk.Q.value = 1; pk.gain.value = 6;
      var pre = ctx.createGain(), sh = ctx.createWaveShaper(), post = ctx.createGain();
      sh.curve = softCurve(2); sh.oversample = '2x';
      st.input.connect(hp); hp.connect(lp); lp.connect(pk); pk.connect(pre); pre.connect(sh); sh.connect(post); post.connect(st.wet);
      st.set = function (on, k, e) {
        if (!on) { st.mix(1, 0); return; }
        var n = dv(e, 'narrow', null) != null ? e.narrow / 100 : k;   // 音の細さ（今までは強さと同じ）
        setP(ctx, hp.frequency, 300 + 500 * n);
        setP(ctx, lp.frequency, 3400 - 1400 * n);
        setP(ctx, pre.gain, dv(e, 'grit', 1 + 4 * k));
        setP(ctx, post.gain, 0.9);
        var mx = dv(e, 'mix', 100) / 100;
        st.mix(1 - mx, mx);
      };
      st.nodes = { highpass: hp.frequency, lowpass: lp.frequency, grit: pre.gain, dry: st.dry.gain, wet: st.wet.gain };
      fx.radio = st;
    })();

    return fx;
  }

  // 「エコー」ボタンの響き。input に加工後の声を入れ、output の音（響きだけ）を声に足す。
  // hold(true) のあいだだけ響きに声を流す。離したあとは、流すのをやめるだけなので、余韻は自然に消える。
  function createHoldEcho(ctx) {
    var input = ctx.createGain(), gate = ctx.createGain(), output = ctx.createGain();
    gate.gain.value = 0;
    var d = ctx.createDelay(1.5), fb = ctx.createGain(), lp = ctx.createBiquadFilter(), dWet = ctx.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 3500;
    var cv = ctx.createConvolver(), rWet = ctx.createGain();
    cv.normalize = true;
    var size = 0;
    input.connect(gate);
    gate.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); d.connect(dWet); dWet.connect(output);
    gate.connect(cv); dWet.connect(cv); cv.connect(rWet); rWet.connect(output);
    var api = {
      input: input,
      output: output,
      set: function (s) {
        s = normalizeEchoButton(s);
        if (s.size !== size) { size = s.size; cv.buffer = makeImpulse(ctx, size, 3); }
        setP(ctx, d.delayTime, s.time / 1000);
        setP(ctx, fb.gain, Math.min(0.9, Math.pow(10, -2 / s.repeats)));
        var m = s.mix / 100;
        setP(ctx, dWet.gain, 0.9 * m);
        setP(ctx, rWet.gain, 0.8 * m);
      },
      hold: function (on) {
        var t = ctx.currentTime;
        gate.gain.cancelScheduledValues(t);
        gate.gain.setTargetAtTime(on ? 1 : 0, t, on ? 0.01 : 0.04);
      },
      // 確かめ用
      nodes: { gate: gate.gain, delayTime: d.delayTime, feedback: fb.gain, delayWet: dWet.gain, reverbWet: rWet.gain },
      destroy: function () { try { input.disconnect(); output.disconnect(); } catch (e) { /* なし */ } }
    };
    api.set(null);
    return api;
  }

  // 加工のグラフを1つ作る。input に音を入れ、output から加工後の音を取る。
  function create(ctx) {
    var starters = [];
    var input = ctx.createGain();
    var output = ctx.createGain();

    var pitchSt = makeStage(ctx);
    var setPitch = buildPitch(ctx, pitchSt, starters);

    var low = ctx.createBiquadFilter(), high = ctx.createBiquadFilter(), muffle = ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 250;
    high.type = 'highshelf'; high.frequency.value = 3000;
    muffle.type = 'lowpass'; muffle.Q.value = 0.5; muffle.frequency.value = ctx.sampleRate / 2;

    var fx = buildEffects(ctx, starters);

    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.1;

    // 最後の歯止め: 0.8 を超えた分だけやわらかく丸め、1 を超えないようにする
    var clip = ctx.createWaveShaper();
    clip.curve = (function () {
      var n = 4096, c = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var x = i / (n - 1) * 2 - 1, a = Math.abs(x);
        var y = a < 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
        c[i] = x < 0 ? -y : y;
      }
      return c;
    })();

    // つなぐ順: 高さ → 音色 → 各エフェクト → 音割れ止め
    input.connect(pitchSt.input);
    pitchSt.output.connect(low); low.connect(high); high.connect(muffle);
    // イコライザー（音色のあと、エフェクトの前）。0dB のときは素通しと同じ
    var eqs = EQ_BANDS.map(function (b) {
      var q = ctx.createBiquadFilter();
      q.type = 'peaking'; q.frequency.value = b.f; q.Q.value = 1; q.gain.value = 0;
      return q;
    });
    var prev = muffle;
    eqs.forEach(function (q) { prev.connect(q); prev = q; });
    var order = ['distortion', 'mellow', 'robot', 'radio', 'phaser', 'flanger', 'chorus', 'tremolo', 'echo', 'reverb'];
    order.forEach(function (k) { prev.connect(fx[k].input); prev = fx[k].output; });
    prev.connect(limiter);
    limiter.connect(clip);
    clip.connect(output);

    var t0 = ctx.currentTime + 0.02;
    starters.forEach(function (s) { s.start(t0); });

    var api = {
      input: input,
      output: output,
      // settings = キャラ（null なら地声）
      apply: function (settings) {
        var s = settings ? normalize(settings) : null;
        setPitch(s ? s.pitch : 0);
        var t = s ? s.tone : 0;
        setP(ctx, high.gain, t * 1.2);
        setP(ctx, low.gain, -t * 0.5);
        var nyq = ctx.sampleRate / 2;
        setP(ctx, muffle.frequency, t < 0 ? Math.min(nyq, 20000 * Math.pow(2, t * 0.55)) : nyq);
        var eqv = s ? s.eq : cleanEq(null);
        eqs.forEach(function (q, i) { setP(ctx, q.gain, eqv[i]); });
        FX_LIST.forEach(function (f) {
          var e = s ? s.fx[f.key] : null;
          fx[f.key].set(!!(e && e.on), e ? e.amt / 100 : 0.5, e || null);
        });
      },
      // 確かめ用: 各エフェクトの主な値（AudioParam）
      fxNodes: function () { var o = {}; FX_LIST.forEach(function (f) { o[f.key] = fx[f.key].nodes || {}; }); return o; },
      destroy: function () {
        starters.forEach(function (s) { try { s.stop(); } catch (e) { /* もう止まっている */ } });
        try { input.disconnect(); } catch (e) { /* なし */ }
        try { output.disconnect(); } catch (e) { /* なし */ }
      }
    };
    api.apply(null);
    return api;
  }

  root.VoiceChangerEngine = {
    FX_LIST: FX_LIST,
    FX_DETAIL: FX_DETAIL,
    EQ_BANDS: EQ_BANDS, EQ_MIN: EQ_MIN, EQ_MAX: EQ_MAX,
    ECHO_BUTTON: ECHO_BUTTON,
    normalizeEchoButton: normalizeEchoButton,
    createHoldEcho: createHoldEcho,
    PITCH_MIN: PITCH_MIN, PITCH_MAX: PITCH_MAX,
    TONE_MIN: TONE_MIN, TONE_MAX: TONE_MAX,
    NAME_MAX: NAME_MAX,
    ART_LIST: ART_LIST,
    isArtId: isArtId,
    SEED_VERSION: SEED_VERSION,
    mergeSamples: mergeSamples,
    clamp: clamp,
    makeId: makeId,
    defaultFx: defaultFx,
    newChar: newChar,
    normalize: normalize,
    sampleChars: sampleChars,
    create: create
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
