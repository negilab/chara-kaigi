// 管理画面: 6人それぞれの声の初期値を決めて保存する。
// 合言葉はデータベースの /adminSecret にあり、だれも読めない。保存のときに合言葉を添え、合っていれば書き込める（firebase-rules.json）。
import { E, CHARS, charOf, cleanDefaults, cleanVoice, icon, esc, $, $$, voiceEditor } from './common.js';
import { getDb, isLocalMode } from './db.js';

const app = $('#app');
let db = null, key = '', saved = null, work = null, sel = 'sennin', editor = null;
let ac = null, mic = null, engine = null;

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
      <div class="foot"><div class="note">${icon('info')}保存すると、次の会議から全員の初めの声になります</div>
        <button type="button" class="btn" id="b-listen">${icon('play')}試しに聞く</button>
        <button type="button" class="btn pri" id="b-save" style="width:140px">保存</button></div>
    </div>
  </div>`;
  editor = voiceEditor($('#ve'), work[sel], (v) => {
    work[sel] = v;
    if (engine) engine.apply(v);
    paintList();
  });
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
  select(sel);
}

function select(id) {
  sel = id;
  const c = charOf(id);
  editor.set(work[id]);
  const top = $('.ve-top') || (() => { const d = document.createElement('div'); d.className = 've-top'; $('.ve-c1').prepend(d); return d; })();
  top.innerHTML = `<div class="stagepv"><img src="characters/${id}/base.png" alt="${esc(c.name)}"></div><div class="nm">${esc(c.name)}</div>`;
  if (engine) engine.apply(work[id]);
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

showLogin();
