/*
 * ボイスチェンジャー キャラの絵を動かす（共通）
 * 拡張機能（extension/avatar-render.js）からの写し。キャラ会議では次を足した:
 *   loadArt の第2引数（部品のファイル名）、animator.update（描かずに口・瞬き・向きだけ進める）、drawPose（決まった位置と大きさに描く）
 * 絵の部品: base.png（必須）、mouth_open.png、mouth_half.png、eyes_closed.png（無くてもよい）
 * 口はマイクの音量、瞬きは顔の読み取り（読み取れないときは自動）、顔の向きで絵を少し回す・ずらす・台形にゆがめる。
 */
(function (root) {
  'use strict';
  if (root.VoiceChangerAvatar) return;

  var W = 1280, H = 720;

  // ---- 顔を左右に向けたときの見え方（台形にゆがめる）。強さはここで調整する ----
  var YAW_FULL = 0.36;       // この向き（ラジアン）で効きが最大。今の横ずらしが上限（40px）に届く向き
  var TURN_SCALE = 0.08;     // 縦の倍率の差。向いた側の反対の端を大きく、向いた側の端を小さく（最大 ±8%）
  var TURN_SQUEEZE = 0.06;   // 横幅の縮み（最大 6%）
  var TURN_PARALLAX = 0.025; // 顔の中ほど（目・口）を、外側より多く向きの方へずらす（幅に対して最大 2.5%）
  var STRIP_PX = 10;         // 細切りの幅（px）。小さいほどなめらかで、重くなる
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
    var gateDb = 0;       // 口が開くしきい値の上乗せ（dB）。+ で鈍く、- で敏感。0 は今までどおり
    // 瞬き: その人のふだんの値（目を開けているときの blink）をゆっくり覚え、そこからの上がりで閉じたと見る
    var blinkBase = 0.2;      // ふだんの値（覚えていく）
    var blinkMargin = 0.33;   // ふだんの値から、これだけ上がったら閉じた（瞬きの反応で変わる）
    var shutSince = 0;        // 閉じた時刻
    var forcedOpen = false;   // 長く閉じたままなので、読み違いとみなして開けている
    var lastEyeT = 0;
    var BLINK_MAX = 600;      // これより長く閉じたままなら、読み違いとして開ける（ふつうの瞬きは 0.1〜0.4 秒）

    var HOLD = 80;        // 口の形を保つ最短の時間（ms）
    var MAX_OPEN = 260;   // 開きっぱなしにしない（ぱたぱた感）
    var FACE_STALE = 700; // 顔の読み取りが途切れたとみなす時間

    function updateMouth(now, rms) {
      var db = 20 * Math.log10(rms + 1e-9);
      // 周りの雑音の大きさを覚えておく（下がるのは速く、上がるのはゆっくり）
      if (db < floorDb) floorDb = db; else floorDb += (db - floorDb) * 0.004;
      floorDb = clampN(floorDb, -80, -42);
      var thrHalf = Math.max(-50, floorDb + 12) + gateDb;
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
        var dt = lastEyeT ? Math.min(200, now - lastEyeT) : 33;
        lastEyeT = now;
        var b = face.blink;
        var shutTh = Math.max(0.4, blinkBase + blinkMargin);   // 閉じたと見るしきい値
        var openTh = shutTh - 0.15;                             // 開いたと見るしきい値
        if (forcedOpen) {
          // 読み違いで開けている: 値が下がるまで待って、また閉じられるように戻す
          if (b < shutTh) forcedOpen = false;
        } else if (!eyesShut && b > shutTh) { eyesShut = true; shutSince = now; }
        else if (eyesShut && b < openTh) eyesShut = false;
        if (eyesShut && now - shutSince > BLINK_MAX) { eyesShut = false; forcedOpen = true; }
        // 開いているあいだに、ふだんの値をゆっくり覚える（読み違いで開けているあいだは少し速く）。上がりすぎないように 0.55 まで
        if (!eyesShut) {
          var k = 1 - Math.exp(-dt / (forcedOpen ? 1500 : 4000));
          blinkBase = Math.min(0.55, Math.max(0, blinkBase + (b - blinkBase) * k));
        }
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
      // 口の反応: しきい値を db だけ上げる（+ で鈍く）
      setMouthGate: function (db) { gateDb = isFinite(db) ? db : 0; },
      // 瞬きの反応（0〜100。右ほど敏感）。0 で +0.45、100 で +0.15（ふだんの値からの上がり）
      setBlinkSens: function (v) { v = isFinite(v) ? Math.min(100, Math.max(0, v)) : 40; blinkMargin = 0.45 - 0.3 * (v / 100); },
      blinkState: function () { return { base: blinkBase, margin: blinkMargin, forcedOpen: forcedOpen, eyesShut: eyesShut }; },
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

  // 今の口・目で重ねる部品（地の絵・口・閉じた目）。部品はどれも地の絵と同じ大きさの重ね絵
  function layersOf(art, st) {
    var a = [art.base];
    if (st.mouth === 2 && art.mouthOpen) a.push(art.mouthOpen);
    else if (st.mouth === 1 && art.mouthHalf) a.push(art.mouthHalf);
    else if (st.mouth === 1 && art.mouthOpen) a.push(art.mouthOpen);
    if (st.eyesShut && art.eyesClosed) a.push(art.eyesClosed);
    return a;
  }

  // 地の絵で、何か描いてある横の範囲（0〜1）。透明な左右の余白は細切りにしない。絵ごとに1回だけ調べる
  function colRange(art) {
    if (art._cols) return art._cols;
    var r = [0, 1];
    try {
      var cw = 160, ch = 90;
      var c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : document.createElement('canvas');
      c.width = cw; c.height = ch;
      var g = c.getContext('2d');
      g.drawImage(art.base, 0, 0, cw, ch);
      var d = g.getImageData(0, 0, cw, ch).data, lo = cw, hi = -1;
      for (var x = 0; x < cw; x++) for (var y = 0; y < ch; y++) if (d[(y * cw + x) * 4 + 3] > 4) { if (x < lo) lo = x; hi = x; break; }
      if (hi >= lo) r = [Math.max(0, (lo - 2) / cw), Math.min(1, (hi + 3) / cw)];
    } catch (e) { /* 全部を細切りにする */ }
    art._cols = r;
    return r;
  }

  // 背景を抜いた絵を、枠（x, y, w, h。w:h = 16:9）に描く。st = { mouth, eyesShut, roll, yaw, pitch }
  // 顔を左右に向けると、絵を縦の細切りにして台形にゆがめる（向きと反対の端を大きく、幅を少し縮め、顔の中ほどを多めにずらす）
  function drawPose(g, art, st, x, y, w, h) {
    if (!art || !art.base) return;
    var k = w / W;
    st = st || {};
    var rot = clampN(-(st.roll || 0) * 0.6, -0.14, 0.14);
    var dx = clampN((st.yaw || 0) * 110, -40, 40) * k;
    var dy = clampN((st.pitch || 0) * 90, -28, 28) * k;
    var t = clampN((st.yaw || 0) / YAW_FULL, -1, 1);   // + は絵が右へずれる向き（dx と同じ）
    g.save();
    g.translate(x + w / 2 + dx, y + h / 2 + dy);
    g.rotate(rot);
    g.translate(-w / 2, -h / 2);
    var layers = layersOf(art, st), j;
    if (Math.abs(t) < 0.02) {
      for (j = 0; j < layers.length; j++) g.drawImage(layers[j], 0, 0, w, h);
      g.restore();
      return;
    }
    var n = Math.max(24, Math.min(128, Math.round(w / STRIP_PX)));
    var cr = colRange(art), i0 = Math.floor(cr[0] * n), i1 = Math.ceil(cr[1] * n);
    var squeeze = 1 - TURN_SQUEEZE * Math.abs(t);
    var par = TURN_PARALLAX * t * w;
    // 横の位置 u（0〜1）が、描く先のどこに来るか（中ほどほど多くずらす）
    var X = function (u) { return w / 2 + (u - 0.5) * w * squeeze + par * Math.sin(Math.PI * u); };
    // 部品ごとに、同じ細切りで描く（下書きの絵を作らず、部品の絵から直に描く）
    for (j = 0; j < layers.length; j++) {
      var img = layers[j], iw = img.width, ih = img.height;
      var ss = iw / n, ov = iw / w;   // 1本の幅と、描く先 1px ぶん（絵の画素で）
      for (var i = i0; i < i1; i++) {
        var u0 = i / n, u1 = (i + 1) / n;
        var x0 = X(u0), x1 = X(u1);
        var dh = h * (1 + TURN_SCALE * t * (1 - (u0 + u1)));   // 左端で 1+S·t 倍、右端で 1−S·t 倍
        // 継ぎ目が出ないよう 1px 重ねる（最後の1本は端まで）
        var srcW = Math.min(ss + ov, iw - i * ss);
        g.drawImage(img, i * ss, 0, srcW, ih, x0, h - dh, (x1 - x0) * srcW / ss, dh);   // 足もとをそろえ、上へ伸び縮みさせる
      }
    }
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
