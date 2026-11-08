/*
 * ボイスチェンジャー キャラの絵を動かす（共通）
 * 拡張機能（extension/avatar-render.js）からの写し。キャラ会議では次を足した:
 *   loadArt の第2引数（部品のファイル名）、animator.update（描かずに口・瞬き・向きだけ進める）、drawPose（決まった位置と大きさに描く）
 * 絵の部品: base.png（必須）、mouth_open.png、mouth_half.png、eyes_closed.png（無くてもよい）
 * 口はマイクの音量、瞬きは顔の読み取り（読み取れないときは自動）、顔の向きで絵を少し回す・ずらす。
 */
(function (root) {
  'use strict';
  if (root.VoiceChangerAvatar) return;

  var W = 1280, H = 720;
  var FILES = { base: 'base.png', mouthOpen: 'mouth_open.png', mouthHalf: 'mouth_half.png', eyesClosed: 'eyes_closed.png' };

  function loadBitmap(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (b) { return createImageBitmap(b); });
  }

  // 背景の色（左上の色）を取る
  function cornerColor(bm) {
    try {
      var c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
      c.width = 8; c.height = 8;
      var g = c.getContext('2d');
      g.drawImage(bm, 0, 0, 8, 8, 0, 0, 8, 8);
      var d = g.getImageData(2, 2, 1, 1).data;
      return 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')';
    } catch (e) { return '#000'; }
  }

  // dirUrl の下の部品を読む。base.png が無ければ失敗。ほかは無ければ null。
  function loadArt(dirUrl, files) {
    if (dirUrl.slice(-1) !== '/') dirUrl += '/';
    var names = files || FILES;
    var keys = Object.keys(FILES);
    return Promise.all(keys.map(function (k) {
      if (!names[k]) return null;
      return loadBitmap(dirUrl + names[k]).catch(function () { return null; });
    })).then(function (bms) {
      var art = {};
      keys.forEach(function (k, i) { art[k] = bms[i]; });
      if (!art.base) {
        keys.forEach(function (k) { if (art[k]) art[k].close(); });
        throw new Error('base.png がありません');
      }
      art.bg = cornerColor(art.base);
      return art;
    });
  }

  // 受け渡しで転送できる ImageBitmap の一覧
  function artTransfer(art) {
    return Object.keys(FILES).map(function (k) { return art[k]; }).filter(Boolean);
  }

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function clampN(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // 映像を枠いっぱいに（はみ出しは切る）描く
  function drawCover(g, src, sw, sh) {
    if (!sw || !sh) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); return; }
    var s = Math.max(W / sw, H / sh);
    var dw = sw * s, dh = sh * s;
    g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  function createAnimator() {
    var art = null;
    var mouth = 0, mouthSince = 0, openSince = 0;
    var floorDb = -60;
    var eyesShut = false, nextBlink = 0, blinkEnd = 0;
    var face = null, faceAt = 0;
    var pose = { roll: 0, yaw: 0, pitch: 0 };
    var center = { yaw: 0, pitch: 0, roll: 0 };
    var lastT = 0;

    var HOLD = 80;        // 口の形を保つ最短の時間（ms）
    var MAX_OPEN = 260;   // 開きっぱなしにしない（ぱたぱた感）
    var FACE_STALE = 700; // 顔の読み取りが途切れたとみなす時間

    function updateMouth(now, rms) {
      var db = 20 * Math.log10(rms + 1e-9);
      // 周りの雑音の大きさを覚えておく（下がるのは速く、上がるのはゆっくり）
      if (db < floorDb) floorDb = db; else floorDb += (db - floorDb) * 0.004;
      floorDb = clampN(floorDb, -80, -42);
      var thrHalf = Math.max(-50, floorDb + 12);
      var thrOpen = thrHalf + 8;
      var hasHalf = !!(art && art.mouthHalf);
      var target;
      if (hasHalf) target = db > thrOpen ? 2 : db > thrHalf ? 1 : 0;
      else target = db > thrHalf + 3 ? 2 : 0;

      if (target !== mouth && now - mouthSince >= HOLD) {
        if (target === 2) openSince = now;
        mouth = target; mouthSince = now;
      } else if (mouth === 2 && now - openSince > MAX_OPEN) {
        // 開きっぱなしにせず、いったん閉じぎみにする
        mouth = hasHalf ? 1 : 0; mouthSince = now;
      }
    }

    function updateEyes(now) {
      if (!art || !art.eyesClosed) { eyesShut = false; return; }
      var fresh = face && face.found && now - faceAt < FACE_STALE && typeof face.blink === 'number';
      if (fresh) {
        if (!eyesShut && face.blink > 0.5) eyesShut = true;
        else if (eyesShut && face.blink < 0.35) eyesShut = false;
        nextBlink = now + rand(2500, 5500);
        return;
      }
      if (!nextBlink) nextBlink = now + rand(1500, 4000);
      if (now >= nextBlink) { blinkEnd = now + 130; nextBlink = now + rand(2500, 5500); }
      eyesShut = now < blinkEnd;
    }

    function updatePose(now) {
      var dt = lastT ? Math.min(200, now - lastT) : 33;
      lastT = now;
      var t = { roll: 0, yaw: 0, pitch: 0 };
      if (face && face.found && now - faceAt < FACE_STALE && isFinite(face.roll)) {
        // ふだんの向きをゆっくり覚え、そこからの差だけ動かす
        var k = 1 - Math.exp(-dt / 8000);
        center.yaw += (face.yaw - center.yaw) * k;
        center.pitch += (face.pitch - center.pitch) * k;
        center.roll += (face.roll - center.roll) * k;
        t.roll = face.roll - center.roll * 0.5;
        t.yaw = face.yaw - center.yaw;
        t.pitch = face.pitch - center.pitch;
      }
      var a = 1 - Math.exp(-dt / 140); // 揺れ止め
      pose.roll += (t.roll - pose.roll) * a;
      pose.yaw += (t.yaw - pose.yaw) * a;
      pose.pitch += (t.pitch - pose.pitch) * a;
    }

    return {
      // 描かずに状態だけ進める（送る側が、口・瞬き・向きの数値を作るのに使う）
      update: function (now, rms) {
        updateMouth(now, rms || 0);
        updateEyes(now);
        updatePose(now);
        return { mouth: mouth, eyesShut: eyesShut, roll: pose.roll, yaw: pose.yaw, pitch: pose.pitch };
      },
      setArt: function (a) { art = a || null; },
      // f = { found, blink(0〜1), yaw, pitch, roll（ラジアン） }
      setFace: function (f) { face = f; faceAt = performance.now(); },
      state: function () { return { mouth: mouth, eyesShut: eyesShut, pose: pose, floorDb: floorDb, faceFresh: !!(face && face.found && performance.now() - faceAt < FACE_STALE) }; },
      draw: function (g, now, rms) {
        if (!art) { g.fillStyle = '#2c3038'; g.fillRect(0, 0, W, H); return; }
        updateMouth(now, rms || 0);
        updateEyes(now);
        updatePose(now);
        var rot = clampN(-pose.roll * 0.6, -0.14, 0.14);           // 最大 8 度ほど
        var dx = clampN(pose.yaw * 110, -40, 40);
        var dy = clampN(pose.pitch * 90, -28, 28);
        g.fillStyle = art.bg;
        g.fillRect(0, 0, W, H);
        g.save();
        g.translate(W / 2 + dx, H / 2 + dy);
        g.rotate(rot);
        g.translate(-W / 2, -H / 2);
        g.drawImage(art.base, 0, 0, W, H);
        if (mouth === 2 && art.mouthOpen) g.drawImage(art.mouthOpen, 0, 0, W, H);
        else if (mouth === 1 && art.mouthHalf) g.drawImage(art.mouthHalf, 0, 0, W, H);
        if (eyesShut && art.eyesClosed) g.drawImage(art.eyesClosed, 0, 0, W, H);
        g.restore();
      }
    };
  }

  // 背景を抜いた絵を、枠（x, y, w, h。w:h = 16:9）に描く。st = { mouth, eyesShut, roll, yaw, pitch }
  function drawPose(g, art, st, x, y, w, h) {
    if (!art || !art.base) return;
    var k = w / W;
    st = st || {};
    var rot = clampN(-(st.roll || 0) * 0.6, -0.14, 0.14);
    var dx = clampN((st.yaw || 0) * 110, -40, 40) * k;
    var dy = clampN((st.pitch || 0) * 90, -28, 28) * k;
    g.save();
    g.translate(x + w / 2 + dx, y + h / 2 + dy);
    g.rotate(rot);
    g.translate(-w / 2, -h / 2);
    g.drawImage(art.base, 0, 0, w, h);
    if (st.mouth === 2 && art.mouthOpen) g.drawImage(art.mouthOpen, 0, 0, w, h);
    else if (st.mouth === 1 && art.mouthHalf) g.drawImage(art.mouthHalf, 0, 0, w, h);
    else if (st.mouth === 1 && art.mouthOpen) g.drawImage(art.mouthOpen, 0, 0, w, h);
    if (st.eyesShut && art.eyesClosed) g.drawImage(art.eyesClosed, 0, 0, w, h);
    g.restore();
  }

  root.VoiceChangerAvatar = {
    W: W, H: H,
    drawPose: drawPose,
    loadArt: loadArt,
    artTransfer: artTransfer,
    createAnimator: createAnimator,
    drawCover: drawCover
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
