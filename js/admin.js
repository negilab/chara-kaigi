// 管理画面: 6人それぞれの声の初期値を決めて保存する。
// 合言葉はデータベースの /adminSecret にあり、だれも読めない。保存のときに合言葉を添え、合っていれば書き込める（firebase-rules.json）。
import { E, CHARS, charOf, cleanDefaults, cleanVoice, icon, esc, $, $$, voiceEditor } from './common.js';
import { getDb, isLocalMode } from './db.js';

const app = $('#app');
let db = null, key = '', saved = null, work = null, sel = 'sennin', editor = null;
let ac = null, mic = null, engine = null;
// 録音して再生: 録った地声（加工する前）をメモリにだけ持ち、再生のたびに今の設定の声で聞かせる。どこにも送らない・保存しない
const REC_MAX = 10;   // 秒
let rec = null;       // 録音中 { ctx, stream, node, chunks, len, t0, timer }
let recBuf = null;    // 録った地声（AudioBuffer）
let play = null;      // 再生中 { ctx, engine, src, echo }
let echoPlay = false; // 再生に「エコー」ボタンの響きをかける
// 再生をくり返す（この端末に覚える）
let loopPlay = (() => { try { return localStorage.getItem('ck-admin-loop') === '1'; } catch (e) { return false; } })();

function top(right = '') {
  return `<div class="top"><div class="brand"><div class="logo">${icon('bubble')}</div>キャラ会議<span class="badge">管理</span></div>
    <div class="right">${isLocalMode() ? '<span class="modetag">試験モード</span>' : ''}${right}</div></div>`;
}

let toastTimer = 0;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.innerHTML = `${icon('info')}<span>${esc(msg)}</span>`;
  t.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

function showLogin(err) {
  stopListen();
  stopRec(true);
  stopPlay();
  recBuf = null;
  key = '';
  app.innerHTML = top() + `
  <form class="card lg" id="f" autocomplete="off">
    <div class="lk">${icon('lock')}</div>
    <h1>管理画面</h1>
    <label class="lbl" for="pw">合言葉</label>
    <input class="input" id="pw" type="password" autocomplete="current-password">
    <div class="err" id="err" ${err ? '' : 'hidden'}>${esc(err || '')}</div>
    <button class="btn pri full" type="submit" id="b-open">開く</button>
    ${isLocalMode() ? '<div class="note">試験モードの合言葉は「test」です。</div>' : ''}
  </form>`;
  $('#pw').focus();
  $('#f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pw = $('#pw').value;
    if (!pw) return;
    $('#b-open').disabled = true;
    try {
      db = db || await getDb();
      const v = await db.get('defaults/v').catch(() => null);
      const cur = cleanDefaults(v);
      // 今の値をそのまま書き直して、合言葉が合っているかを確かめる
      await db.set('defaults', { v: cur, key: pw });
      key = pw;
      saved = cur;
      work = JSON.parse(JSON.stringify(cur));
      showMain();
    } catch (e) {
      const denied = String((e && (e.code || e.message)) || '').toUpperCase().includes('PERMISSION');
      showLogin(denied ? '合言葉がちがいます' : '開けませんでした。通信の具合を確かめて、もう一度押してください。');
      if (!denied) console.warn(e);
    }
  });
}

function changed(id) { return JSON.stringify(work[id]) !== JSON.stringify(saved[id]); }

function showMain() {
  app.innerHTML = top('<button type="button" class="btn ghost closeb" id="b-close">管理画面を閉じる</button>') + `
  <div class="adm">
    <div class="card list" id="list"><div class="h">キャラ</div>
      ${CHARS.map((c) => `<button type="button" class="it" data-ch="${c.id}"><div class="face"><img src="characters/${c.id}/base.png" alt=""></div>${esc(c.name)}<span class="chg" hidden title="保存していない変更があります"></span></button>`).join('')}
    </div>
    <div class="card main">
      <div id="ve"></div>
      <div class="ebx"><div class="lbl">エコーボタンの響き（会議の「エコー」ボタン。全キャラ共通）</div>
        <div class="box" id="ebx">${E.ECHO_BUTTON.map((d) => `
          <label class="fxd-r"><span class="fxd-l">${esc(d.label)}</span>
            <input type="range" data-ek="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}" aria-label="エコーボタンの${esc(d.label)}">
            <b class="fxd-v" data-ev="${d.k}"></b></label>`).join('')}
          <div class="ebx-t"><button type="button" class="sw" id="b-echoplay" role="switch" aria-checked="false" aria-label="再生にエコーをかける"></button><span>「再生」にエコーをかける</span></div>
        </div></div>
      <div class="foot"><div class="note">${icon('info')}保存すると、次の会議から全員の初めの声になります</div>
        <button type="button" class="btn" id="b-rec">${icon('mic')}録音</button>
        <button type="button" class="btn" id="b-play" ${recBuf ? '' : 'disabled'}>${icon('play')}再生</button>
        <span class="lp"><button type="button" class="sw" id="b-loop" role="switch" aria-checked="false" aria-label="くり返す"></button><span>くり返す</span></span>
        <button type="button" class="btn" id="b-listen">${icon('play')}試しに聞く</button>
        <button type="button" class="btn pri" id="b-save" style="width:140px">保存</button></div>
    </div>
  </div>`;
  editor = voiceEditor($('#ve'), work[sel], (v) => {
    work[sel] = v;
    if (engine) engine.apply(v);
    if (play) play.engine.apply(v);
    paintList();
  }, { detail: true });
  $('#list').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ch]');
    if (!b) return;
    select(b.dataset.ch);
  });
  $('#b-close').addEventListener('click', () => {
    if (Object.keys(work).some(changed) && !confirm('保存していない変更があります。閉じますか？')) return;
    showLogin();
  });
  $('#b-save').addEventListener('click', save);
  $('#b-listen').addEventListener('click', () => (engine ? stopListen() : startListen()));
  $('#b-rec').addEventListener('click', () => (rec ? stopRec() : startRec()));
  $('#b-play').addEventListener('click', () => (play ? stopPlay() : startPlay()));
  $('#b-loop').addEventListener('click', () => {
    loopPlay = !loopPlay;
    try { localStorage.setItem('ck-admin-loop', loopPlay ? '1' : '0'); } catch (e) { /* なし */ }
    if (play) play.src.loop = loopPlay;   // 再生中でも切り替わる
    paintRec();
  });
  $('#ebx').addEventListener('input', (ev) => {
    const k = ev.target.dataset.ek;
    if (!k) return;
    work._echoButton = E.normalizeEchoButton(Object.assign({}, work._echoButton, { [k]: Number(ev.target.value) }));
    if (play && play.echo) play.echo.set(work._echoButton);
    paintEcho();
  });
  $('#b-echoplay').addEventListener('click', () => {
    echoPlay = !echoPlay;
    if (play && play.echo) play.echo.hold(echoPlay);
    paintEcho();
  });
  paintEcho();
  paintRec();
  select(sel);
}

function paintEcho() {
  const v = E.normalizeEchoButton(work._echoButton);
  E.ECHO_BUTTON.forEach((d) => {
    const inp = $(`#ebx input[data-ek="${d.k}"]`);
    if (!inp) return;
    inp.value = v[d.k];
    inp.style.setProperty('--p', ((v[d.k] - d.min) / (d.max - d.min)) * 100 + '%');
    const dec = d.step >= 1 ? 0 : d.step >= 0.1 ? 1 : 2;
    $(`#ebx [data-ev="${d.k}"]`).textContent = `${Number(v[d.k].toFixed(dec))} ${d.unit}`;
  });
  const sw = $('#b-echoplay');
  if (sw) { sw.classList.toggle('on', echoPlay); sw.setAttribute('aria-checked', echoPlay ? 'true' : 'false'); }
}

function select(id) {
  sel = id;
  const c = charOf(id);
  editor.set(work[id]);
  const top = $('.ve-top') || (() => { const d = document.createElement('div'); d.className = 've-top'; $('.ve-c1').prepend(d); return d; })();
  top.innerHTML = `<div class="stagepv"><img src="characters/${id}/base.png" alt="${esc(c.name)}"></div><div class="nm">${esc(c.name)}</div>`;
  if (engine) engine.apply(work[id]);
  if (play) play.engine.apply(work[id]);
  paintList();
}

function paintList() {
  $$('#list [data-ch]').forEach((b) => {
    b.classList.toggle('sel', b.dataset.ch === sel);
    b.querySelector('.chg').hidden = !changed(b.dataset.ch);
  });
}

async function save() {
  const btn = $('#b-save');
  btn.disabled = true;
  try {
    const v = cleanDefaults(work);
    await db.set('defaults', { v, key });
    saved = JSON.parse(JSON.stringify(v));
    work = JSON.parse(JSON.stringify(v));
    paintList();
    toast('保存しました。次の会議から、この声が初めの声になります');
  } catch (e) {
    console.warn(e);
    toast('保存できませんでした。合言葉が変わった場合は、管理画面を閉じて開き直してください');
  } finally {
    btn.disabled = false;
  }
}

async function startListen() {
  stopRec();
  stopPlay();
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    toast('マイクを使えません。このページにマイクを許可してください');
    return;
  }
  ac = new AudioContext();
  engine = E.create(ac);
  ac.createMediaStreamSource(mic).connect(engine.input);
  engine.output.connect(ac.destination);
  engine.apply(cleanVoice(work[sel]));
  $('#b-listen').innerHTML = `${icon('stop')}止める`;
  toast('ヘッドホンで聞いてください。スピーカーだと音が回ります');
}
function stopListen() {
  if (engine) { engine.destroy(); engine = null; }
  if (mic) { mic.getTracks().forEach((t) => t.stop()); mic = null; }
  if (ac) { ac.close().catch(() => {}); ac = null; }
  const b = $('#b-listen');
  if (b) b.innerHTML = `${icon('play')}試しに聞く`;
}

// ---- 録音 → 再生 ----
async function startRec() {
  stopListen();
  stopPlay();
  // 音の場は押した直後に作る（iPhone は、押したときに作らないと音が出ないことがある）
  const ctx = new AudioContext();
  let stream;
  try {
    // 会議と同じ条件でマイクを開く（audio.js と同じ）
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    ctx.close().catch(() => {});
    toast('マイクを使えません。このページにマイクを許可してください');
    return;
  }
  try { await ctx.resume(); } catch (e) { /* なし */ }
  const srcNode = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;   // 録るだけで、スピーカーには出さない
  const r = rec = { ctx, stream, node, chunks: [], len: 0, t0: performance.now(), timer: 0 };
  const maxLen = Math.floor(ctx.sampleRate * REC_MAX);
  node.onaudioprocess = (ev) => {
    if (rec !== r) return;
    const d = ev.inputBuffer.getChannelData(0);
    const n = Math.min(d.length, maxLen - r.len);
    if (n > 0) { r.chunks.push(new Float32Array(d.subarray(0, n))); r.len += n; }
    if (r.len >= maxLen) setTimeout(() => { if (rec === r) stopRec(); }, 0);
  };
  srcNode.connect(node); node.connect(mute); mute.connect(ctx.destination);
  r.timer = setInterval(paintRec, 200);
  paintRec();
}
function paintRec() {
  const b = $('#b-rec');
  if (!b) return;
  if (rec) {
    const sec = Math.min(REC_MAX, Math.floor((performance.now() - rec.t0) / 1000));
    b.innerHTML = `<span class="recdot"></span>止める（${sec}秒／${REC_MAX}秒）`;
    b.classList.add('recon');
  } else {
    b.innerHTML = `${icon('mic')}録音`;
    b.classList.remove('recon');
  }
  const p = $('#b-play');
  if (p) {
    p.disabled = !recBuf || !!rec;
    const lp = $('#b-loop');
    if (lp) { lp.classList.toggle('on', loopPlay); lp.setAttribute('aria-checked', loopPlay ? 'true' : 'false'); }
    p.innerHTML = play ? `${icon('stop')}止める` : `${icon('play')}再生`;
  }
}
// discard = true のときは、録った音を残さない（画面を閉じるとき）
function stopRec(discard) {
  const r = rec;
  if (!r) return;
  rec = null;
  clearInterval(r.timer);
  r.node.onaudioprocess = null;
  try { r.node.disconnect(); } catch (e) { /* なし */ }
  r.stream.getTracks().forEach((t) => t.stop());
  if (!discard && r.len > r.ctx.sampleRate * 0.3) {
    const buf = r.ctx.createBuffer(1, r.len, r.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let o = 0;
    r.chunks.forEach((c) => { d.set(c, o); o += c.length; });
    recBuf = buf;
    toast(`録音しました（${(r.len / r.ctx.sampleRate).toFixed(1)}秒）。「再生」で、いまの設定の声で聞けます`);
  } else if (!discard) {
    toast('録音が短すぎました。もう一度、話しながら録音してください');
  }
  r.ctx.close().catch(() => {});
  paintRec();
}
async function startPlay() {
  if (!recBuf) return;
  stopListen();
  stopRec();
  stopPlay();
  const ctx = new AudioContext();
  try { await ctx.resume(); } catch (e) { /* なし */ }
  const eng = E.create(ctx);
  eng.apply(cleanVoice(work[sel]));
  eng.output.connect(ctx.destination);
  // 「エコー」ボタンの響き（会議と同じ部品）。スイッチが入っているあいだだけ重ねる
  const echo = E.createHoldEcho(ctx);
  echo.set(work._echoButton);
  eng.output.connect(echo.input);
  echo.output.connect(ctx.destination);
  echo.hold(echoPlay);
  const src = ctx.createBufferSource();
  src.buffer = recBuf;
  src.loop = loopPlay;   // くり返すときは、止めるまで鳴らす
  src.connect(eng.input);
  const p = play = { ctx, engine: eng, src, echo };
  // 加工の効果（エコーなど）の余韻が切れないよう、少し待ってから止める
  src.onended = () => setTimeout(() => { if (play === p) stopPlay(); }, 1200);
  src.start(ctx.currentTime + 0.05);
  paintRec();
}
function stopPlay() {
  const p = play;
  if (!p) return;
  play = null;
  p.src.onended = null;
  try { p.src.stop(); } catch (e) { /* なし */ }
  p.engine.destroy();
  p.echo.destroy();
  p.ctx.close().catch(() => {});
  paintRec();
}

showLogin();
