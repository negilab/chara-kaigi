/*
 * ボイスチェンジャー 音の加工（共通）
 * サイドパネルの試聴・Meet への差し込み・テスト用ページで同じものを使う。
 * Web Audio の標準ノードだけで組む（AudioWorklet は使わない）。
 */
(function (root) {
  'use strict';
  if (root.VoiceChangerEngine) return;

  var FX_LIST = [
    { key: 'echo', label: 'エコー' },
    { key: 'reverb', label: 'リバーブ' },
    { key: 'distortion', label: 'ディストーション' },
    { key: 'phaser', label: 'フェイザー' },
    { key: 'flanger', label: 'フランジャー' },
    { key: 'chorus', label: 'コーラス' },
    { key: 'tremolo', label: 'トレモロ' },
    { key: 'robot', label: 'ロボット' },
    { key: 'radio', label: '無線・電話' }
  ];
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

  var PITCH_MIN = -12, PITCH_MAX = 12, TONE_MIN = -10, TONE_MAX = 10;
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

  // 値を決まった範囲に収めた写しを返す
  function normalize(c) {
    c = c || {};
    var out = {
      id: typeof c.id === 'string' && c.id ? c.id : makeId(),
      name: String(c.name == null ? '' : c.name).slice(0, NAME_MAX),
      pitch: Math.round(clamp(c.pitch, PITCH_MIN, PITCH_MAX)),
      tone: Math.round(clamp(c.tone, TONE_MIN, TONE_MAX)),
      fx: defaultFx(),
      art: isArtId(c.art) ? c.art : ''
    };
    var src = c.fx || {};
    FX_LIST.forEach(function (f) {
      var e = src[f.key];
      if (e && typeof e === 'object') {
        out.fx[f.key] = { on: e.on === true, amt: Math.round(clamp(e.amt == null ? 50 : e.amt, 0, 100)) };
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
      st.set = function (on, k) {
        if (!on) { setP(ctx, fb.gain, 0); st.mix(1, 0); return; }
        setP(ctx, d.delayTime, 0.12 + 0.33 * k);
        setP(ctx, fb.gain, 0.25 + 0.4 * k);
        st.mix(1, 0.35 + 0.45 * k);
      };
      fx.echo = st;
    })();

    // リバーブ
    (function () {
      var st = makeStage(ctx);
      var cv = ctx.createConvolver();
      cv.normalize = true;
      cv.buffer = makeImpulse(ctx, 2.2, 3);
      st.input.connect(cv); cv.connect(st.wet);
      st.set = function (on, k) {
        if (!on) { st.mix(1, 0); return; }
        st.mix(1, 0.15 + 0.85 * k);
      };
      fx.reverb = st;
    })();

    // ディストーション
    (function () {
      var st = makeStage(ctx);
      var pre = ctx.createGain(), sh = ctx.createWaveShaper(), post = ctx.createGain();
      sh.curve = softCurve(2.5); sh.oversample = '4x';
      st.input.connect(pre); pre.connect(sh); sh.connect(post); post.connect(st.wet);
      st.set = function (on, k) {
        if (!on) { st.mix(1, 0); return; }
        setP(ctx, pre.gain, 1 + 30 * k);
        setP(ctx, post.gain, 0.8 / (1 + 1.5 * k));
        st.mix(0, 1);
      };
      fx.distortion = st;
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
      st.set = function (on, k) {
        if (!on) { st.mix(1, 0); return; }
        setP(ctx, lfo.osc.frequency, 0.2 + 0.8 * k);
        setP(ctx, lfo.gain.gain, 300 + 600 * k);
        st.mix(0.7, 0.7);
      };
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
      st.set = function (on, k) {
        if (!on) { setP(ctx, fb.gain, 0); st.mix(1, 0); return; }
        setP(ctx, fb.gain, 0.3 + 0.5 * k);
        setP(ctx, lfo.gain.gain, 0.001 + 0.0025 * k);
        setP(ctx, lfo.osc.frequency, 0.15 + 0.5 * k);
        st.mix(0.7, 0.7);
      };
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
      st.set = function (on, k) {
        if (!on) { st.mix(1, 0); return; }
        lfos.forEach(function (l) { setP(ctx, l.gain.gain, 0.001 + 0.004 * k); });
        st.mix(0.8, 0.4 + 0.5 * k);
      };
      fx.chorus = st;
    })();

    // トレモロ
    (function () {
      var st = makeStage(ctx);
      var amp = ctx.createGain(); amp.gain.value = 1;
      var lfo = makeLfo(ctx, 5, 0, starters);
      lfo.gain.connect(amp.gain);
      st.input.connect(amp); amp.connect(st.wet);
      st.set = function (on, k) {
        if (!on) { setP(ctx, lfo.gain.gain, 0); st.mix(1, 0); return; }
        var depth = 0.3 + 0.7 * k;
        setP(ctx, amp.gain, 1 - depth / 2);
        setP(ctx, lfo.gain.gain, depth / 2);
        setP(ctx, lfo.osc.frequency, 3 + 6 * k);
        st.mix(0, 1);
      };
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
      st.set = function (on, k) {
        if (!on) { setP(ctx, fb.gain, 0); st.mix(1, 0); return; }
        var m = 0.5 + 0.5 * k;
        setP(ctx, fb.gain, 0.3 + 0.5 * k);
        setP(ctx, ring.gain, 1 - m);
        setP(ctx, lfo.gain.gain, m);
        setP(ctx, lfo.osc.frequency, 30 + 40 * k);
        st.mix(0, 1);
      };
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
      st.set = function (on, k) {
        if (!on) { st.mix(1, 0); return; }
        setP(ctx, hp.frequency, 300 + 500 * k);
        setP(ctx, lp.frequency, 3400 - 1400 * k);
        setP(ctx, pre.gain, 1 + 4 * k);
        setP(ctx, post.gain, 0.9);
        st.mix(0, 1);
      };
      fx.radio = st;
    })();

    return fx;
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
    var prev = muffle;
    var order = ['distortion', 'robot', 'radio', 'phaser', 'flanger', 'chorus', 'tremolo', 'echo', 'reverb'];
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
        FX_LIST.forEach(function (f) {
          var e = s ? s.fx[f.key] : null;
          fx[f.key].set(!!(e && e.on), e ? e.amt / 100 : 0.5);
        });
      },
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
