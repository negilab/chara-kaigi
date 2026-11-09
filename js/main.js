// キャラ会議（会議の画面）: 入口 → キャラ選び → 会議 → 退室
import {
  A, CHARS, charOf, cleanDefaults, cleanVoice, loadArt, loadAllArts, icon, GRIP_SVG, esc, $, $$,
  hhmm, ymd, pad2, mmss, download, voiceEditor
} from './common.js';
import { getDb, isLocalMode } from './db.js';
import { Room, createRoom, roomInfo, cleanupOldRooms, newMemberId, validRoomId, MAX_MEMBERS } from './room.js';
import { Mesh } from './mesh.js';
import { LocalMedia } from './audio.js';
import { createStage, W, H, SIZE_LABEL, computeLayout, cleanPos, POS_X, POS_Y } from './stage.js';
import { initFace, detectFace } from './face.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const app = $('#app');
const layer = $('#layer');

const S = {
  db: null,
  roomId: params.get('room') || '',
  myId: newMemberId(),
  name: '',
  char: 'sennin',
  voice: null,
  defaults: null,
  hostName: '',
  screen: '',
  media: null,
  anim: A.createAnimator(),
  myArt: null,
  myState: { mouth: 0, eyesShut: false, roll: 0, yaw: 0, pitch: 0 },
  myTalkAt: 0,
  lastRms: 0,
  room: null,
  mesh: null,
  members: {},
  state: {},
  remote: new Map(),     // id → { st, char, mic, lv, at, talkAt, audio, shareVideo }
  arts: {},
  stage: createStage(),
  mouth: 80,             // 口の反応（boot で savedMouth から読み直す）
  speakerId: '',
  caption: null,
  captionsOn: true,
  transcript: [],
  rec: null,
  share: null,           // 自分の画面共有 { stream, track, video }
  meetStart: 0
};

const NAME_MAX = 20;
// 携帯の画面（縦の狭い幅・横の低い高さ）か、指で触る端末か
const phoneMQ = matchMedia('(max-width:700px), (max-height:500px) and (orientation:landscape)');
const coarseMQ = matchMedia('(pointer:coarse)');
const touchUi = () => phoneMQ.matches || coarseMQ.matches;
// 画面共有は iPhone・iPad では使えない（getDisplayMedia がない）
const CAN_SHARE = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

// ---------- 小さな道具 ----------
let toastTimer = 0;
function toast(msg, ms = 3200) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.innerHTML = `${icon('info')}<span>${esc(msg)}</span>`;
  t.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = '0'; }, ms);
}

function topBar(mid = '') {
  return `<div class="top"><div class="brand"><div class="logo">${icon('bubble')}</div>キャラ会議</div>
    <div class="mid">${mid}</div>
    <div class="right">${isLocalMode() ? '<span class="modetag" title="firebase-config.js に設定値が入るまでは、同じ PC の同じ Chrome のタブどうしだけがつながります">試験モード</span>' : ''}</div></div>`;
}

// 口の反応（0〜100。右ほど敏感）。この端末の、この人だけの設定。MOUTH_DEFAULT が今までどおり
const MOUTH_DEFAULT = 80;
function savedMouth() {
  try { const r = localStorage.getItem('ck-mouth'); const v = Number(r); return r != null && r !== '' && isFinite(v) ? Math.min(100, Math.max(0, v)) : MOUTH_DEFAULT; } catch (e) { return MOUTH_DEFAULT; }
}
// 0（鈍い）で +24dB、80 で 0dB、100（敏感）で -6dB
function setMouth(v, keep) {
  S.mouth = v;
  S.anim.setMouthGate((MOUTH_DEFAULT - v) * 0.3);
  if (keep) { try { localStorage.setItem('ck-mouth', String(v)); } catch (e) { /* なし */ } }
}

function rememberName(n) { try { localStorage.setItem('ck-name', n); } catch (e) { /* なし */ } }
function savedName() { try { return localStorage.getItem('ck-name') || ''; } catch (e) { return ''; } }
function roomUrl(id) { const u = new URL(location.href); u.search = `?room=${id}`; u.hash = ''; return u.href; }

// ---------- 1 入口 ----------
function showCreate(done) {
  S.screen = 'entry';
  app.innerHTML = topBar() + `
  <div class="entry"><div class="col"><div class="tag"><i></i>部屋を作る人</div>
    <form class="card" id="f-create" autocomplete="off">
      <h1>会議をはじめる</h1>
      <div class="lead">名前を入れて部屋を作ると、招待用の URL ができます。<br>URL を送れば、最大${MAX_MEMBERS}人まで入れます。</div>
      <label class="lbl" for="in-name">あなたの名前</label>
      <input class="input" id="in-name" maxlength="${NAME_MAX}" value="${esc(S.name || savedName())}" ${done ? 'disabled' : ''}>
      <div style="margin-top:14px">${done
        ? `<div class="btn done full">${icon('check')}部屋を作りました</div>`
        : `<button class="btn full" type="submit" id="b-create">部屋を作る</button>`}</div>
      <div class="err" id="err" hidden></div>
      ${done ? `
      <div class="step"><span class="n">${icon('check')}</span>この URL を参加する人に送ってください</div>
      <div class="url"><div class="input">${icon('link')}<span>${esc(roomUrl(S.roomId).replace(/^https?:\/\//, ''))}</span></div>
        <button type="button" class="btn" id="b-copy">${icon('copy')}URL をコピー</button></div>
      <div class="copied" id="copied" hidden>${icon('check')}コピーしました</div>
      <div class="spacer"></div>
      <button type="button" class="btn pri full" id="b-go" style="margin-top:28px">入る${icon('arrow')}</button>` : ''}
    </form></div></div>`;
  if (!done) {
    $('#in-name').focus();
    $('#f-create').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = $('#in-name').value.trim();
      if (!name) return showErr('名前を入れてください');
      $('#b-create').disabled = true;
      try {
        S.name = name; rememberName(name);
        S.roomId = await createRoom(S.db, name);
        S.hostName = name;
        history.replaceState(null, '', roomUrl(S.roomId));
        showCreate(true);
      } catch (e) {
        console.warn(e);
        $('#b-create').disabled = false;
        showErr('部屋を作れませんでした。通信の具合を確かめて、もう一度押してください。');
      }
    });
  } else {
    $('#b-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(roomUrl(S.roomId)); $('#copied').hidden = false; } catch (e) { toast('コピーできませんでした。URL を選んでコピーしてください。'); }
    });
    $('#b-go').addEventListener('click', () => goPrep());
  }
}

function showErr(msg) { const e = $('#err'); if (e) { e.textContent = msg; e.hidden = false; } }

async function showInvite() {
  S.screen = 'entry';
  app.innerHTML = topBar();
  let info;
  try { info = await roomInfo(S.db, S.roomId); } catch (e) { info = { exists: false, error: true }; }
  if (!info.exists || info.full) {
    const title = info.error ? '部屋の様子を読めませんでした' : info.full ? 'この部屋は満員です' : 'この部屋は見つかりません';
    const lead = info.error ? '通信の具合を確かめて、ページを読み込み直してください。'
      : info.full ? `1つの部屋に入れるのは${MAX_MEMBERS}人までです。だれかが出るのを待つか、新しい部屋を作ってください。`
        : 'URL がまちがっているか、会議が終わって部屋が消えています。';
    app.innerHTML = topBar() + `<div class="entry"><div class="col"><div class="card" style="min-height:0">
      <h1>${title}</h1><div class="lead">${lead}</div>
      <a class="btn pri full" href="${esc(location.pathname)}">新しい部屋を作る${icon('arrow')}</a></div></div></div>`;
    return;
  }
  S.hostName = info.hostName;
  const host = esc(info.hostName || '');
  app.innerHTML = topBar() + `
  <div class="entry"><div class="col"><div class="tag"><i></i>URL を開いて来た人</div>
    <form class="card" id="f-join" autocomplete="off">
      <h1>${host}さんの部屋に入る</h1>
      <div class="lead">招待されています。名前を入れて、入る準備をしましょう。</div>
      <div class="host"><div class="av">${icon('user')}</div><div><div class="t1">部屋をつくった人</div><div class="t2">${host}</div></div><div class="ppl">いま ${info.count}人</div></div>
      <label class="lbl" for="in-name">あなたの名前</label>
      <input class="input" id="in-name" maxlength="${NAME_MAX}" value="${esc(savedName())}">
      <div class="err" id="err" hidden></div>
      <div class="spacer"></div>
      <button class="btn pri full" type="submit" style="margin-top:28px">${host}さんの部屋に入る${icon('arrow')}</button>
      <div class="hint">次の画面で、会議で使うキャラを選びます</div>
    </form></div></div>`;
  $('#in-name').focus();
  $('#f-join').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = $('#in-name').value.trim();
    if (!name) return showErr('名前を入れてください');
    S.name = name; rememberName(name);
    goPrep();
  });
}

// ---------- 2 キャラ選び ----------
const METER_H = [5, 8, 12, 16, 20, 24, 26, 22, 18, 14, 10, 7, 5, 4, 3, 3, 2, 2, 2, 2];
let preview = null;
let heardAt = 0;

function charCard(c, sel) {
  return `<button type="button" class="ch ${sel ? 'sel' : ''}" data-ch="${c.id}" aria-pressed="${sel}">
    <div class="pic"><img src="characters/${c.id}/card.jpg" alt="${esc(c.name)}"></div>
    <div class="nm">${esc(c.name)}<span class="ck">${icon('check')}</span></div></button>`;
}

async function setChar(id) {
  S.char = id;
  S.voice = cleanVoice(S.defaults[id]);
  if (S.media) S.media.applyVoice(S.voice);
  S.myArt = null;
  try { const art = await loadArt(id); if (S.char === id) { S.myArt = art; S.anim.setArt(art); } } catch (e) { console.warn(e); }
  if (S.room) S.room.updateMe({ char: id });
}

async function goPrep() {
  S.screen = 'prep';
  const host = esc(S.hostName || S.name);
  app.innerHTML = topBar(`${host}さんの部屋<span class="dot"></span><span class="s">入る準備</span>`) + `
  <div class="prep">
    <div class="left">
      <h1>会議で使うキャラを選ぶ</h1>
      <div class="lead">選んだキャラの絵と声で参加します。会議の途中でも替えられます。</div>
      <div class="grid" id="grid">${CHARS.map((c) => charCard(c, c.id === S.char)).join('')}</div>
    </div>
    <div class="card right">
      <div class="stagepv"><canvas id="pv" width="1280" height="720"></canvas></div>
      <div class="who"><b id="pv-name">${esc(charOf(S.char).name)}</b></div>
      <div class="desc" id="pv-desc">マイクに向かって話すと、この絵の口が動きます。</div>
      <button type="button" class="btn" id="b-voice" style="margin-bottom:24px">${icon('sliders')}声を調整</button>
      <div class="row">${icon('mic')}<span>マイクの入力レベル</span><span class="r no" id="heard">準備しています</span></div>
      <div class="meter" id="meter">${METER_H.map((h) => `<i style="height:${30 + h * 2.6}%"></i>`).join('')}</div>
      <div class="note">字幕を作るため、話した声（加工する前の声）は Chrome の音声認識で Google に送られます。</div>
      <div class="spacer"></div>
      <div class="err" id="err" hidden></div>
      <button type="button" class="btn pri full" id="b-join" disabled>この声で入る${icon('arrow')}</button>
    </div>
  </div>`;
  preview = $('#pv').getContext('2d');
  await setChar(S.char);
  $('#grid').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ch]');
    if (!b) return;
    $$('#grid .ch').forEach((x) => { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', x === b); });
    $('#pv-name').textContent = charOf(b.dataset.ch).name;
    setChar(b.dataset.ch);
  });
  $('#b-voice').addEventListener('click', () => openVoiceDialog(false));
  $('#b-join').addEventListener('click', () => joinMeeting());

  if (!S.media) {
    const m = new LocalMedia();
    try {
      await m.open();
      S.media = m;
      m.applyVoice(S.voice);
    } catch (e) {
      console.warn(e);
      showErr('マイクを使えません。アドレスバーの左の印から、このページにマイクを許可して、読み込み直してください。');
      return;
    }
    if (m.hasCamera) initFace();
  }
  $('#pv-desc').textContent = S.media.hasCamera
    ? 'マイクに向かって話すと、この絵の口が動きます。カメラで顔の向きと瞬きを読み取ります（カメラの映像はどこにも送りません）。'
    : 'マイクに向かって話すと、この絵の口が動きます。カメラが使えないため、瞬きは自動、顔の向きは正面になります。';
  $('#b-join').disabled = false;
}

function drawPrep(now) {
  if (!preview) return;
  const g = preview;
  g.clearRect(0, 0, 1280, 720);
  if (S.myArt) A.drawPose(g, S.myArt, S.myState, 0, 0, 1280, 720);
  const db = 20 * Math.log10(S.lastRms + 1e-9);
  const lit = Math.max(0, Math.min(20, Math.round((db + 60) / 2.5)));
  const bars = $$('#meter i');
  bars.forEach((b, i) => b.classList.toggle('on', i < lit));
  if (db > -45) heardAt = now;
  const heard = $('#heard');
  if (heard && S.media) {
    const ok = now - heardAt < 2500;
    heard.textContent = ok ? '声が届いています' : '声が届いていません';
    heard.classList.toggle('no', !ok);
  }
}

// ---------- 声の調整・キャラを替える（ダイアログ） ----------
let dlgClose = null;
function openDialog(html, onClose, wide) {
  closeDialog();
  layer.innerHTML = `<div class="scrim" id="scrim"><div class="dlg ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  const scrim = $('#scrim');
  const close = () => { closeDialog(); };
  scrim.addEventListener('mousedown', (ev) => { if (ev.target === scrim) close(); });
  const x = $('.dlg .x', layer);
  if (x) x.addEventListener('click', close);
  dlgClose = onClose || null;
  return scrim;
}
function closeDialog() {
  if (!layer.innerHTML) return;
  layer.innerHTML = '';
  const f = dlgClose; dlgClose = null;
  if (f) f();
}
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && layer.innerHTML) closeDialog(); });

function openVoiceDialog(withGrid) {
  let monitor = false;
  const scrim = openDialog(`
    <button type="button" class="x" aria-label="閉じる">${icon('close')}</button>
    <h2>${withGrid ? 'キャラを替える' : '声を調整'}</h2>
    <div class="lead">${withGrid ? '選んだキャラの絵と声に替わります。' : ''}声の調整は保存されません。次の会議では初めの声に戻ります。</div>
    ${withGrid ? `<div class="swapgrid" id="swapgrid">${CHARS.map((c) => charCard(c, c.id === S.char)).join('')}</div>` : ''}
    <div id="ve"></div>
    <div class="box mg"><label class="ve-sl"><div class="t"><span>口の反応</span></div>
      <input type="range" id="in-mouth" min="0" max="100" step="1">
      <div class="ends"><span>鈍い</span><span>敏感</span></div></label>
      <div class="mg-n">キーボードの音などで口が動くときは、鈍いほうへ動かしてください。</div></div>
    <div class="acts" style="margin-top:22px">
      <div class="l">試しに聞くときは、ヘッドホンをつけてください。<br>スピーカーだと音が回って、ピーッと鳴ることがあります。</div>
      <button type="button" class="btn ghost" id="b-reset">初めの声に戻す</button>
      <button type="button" class="btn" id="b-mon">${icon('play')}試しに聞く</button>
      <button type="button" class="btn pri" id="b-ok" style="width:120px">閉じる</button>
    </div>`, () => { if (S.media) S.media.setMonitor(false); }, true);
  const ed = voiceEditor($('#ve', scrim), S.voice, (v) => { S.voice = v; if (S.media) S.media.applyVoice(v); });
  const mi = $('#in-mouth', scrim);
  const paintMouth = () => { mi.value = S.mouth; mi.style.setProperty('--p', `${S.mouth}%`); };
  paintMouth();
  mi.addEventListener('input', () => { setMouth(Number(mi.value), true); paintMouth(); });
  $('#b-ok', scrim).addEventListener('click', () => closeDialog());
  $('#b-reset', scrim).addEventListener('click', () => {
    S.voice = cleanVoice(S.defaults[S.char]);
    ed.set(S.voice);
    if (S.media) S.media.applyVoice(S.voice);
  });
  $('#b-mon', scrim).addEventListener('click', (ev) => {
    if (!S.media) return;
    monitor = !monitor;
    S.media.setMonitor(monitor);
    ev.currentTarget.innerHTML = monitor ? `${icon('stop')}止める` : `${icon('play')}試しに聞く`;
  });
  if (withGrid) {
    $('#swapgrid', scrim).addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-ch]');
      if (!b) return;
      $$('#swapgrid .ch').forEach((x) => { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', x === b); });
      await setChar(b.dataset.ch);
      ed.set(S.voice);
    });
  }
}

// ---------- 3 会議 ----------
async function joinMeeting() {
  const btn = $('#b-join');
  if (btn) btn.disabled = true;
  const room = new Room(S.db, S.roomId, S.myId);
  let res;
  try {
    res = await room.join({ name: S.name, char: S.char, joinedAt: Date.now() });
  } catch (e) {
    console.warn(e);
    res = 'error';
  }
  if (res !== 'ok') {
    if (btn) btn.disabled = false;
    showErr(res === 'full' ? `この部屋は満員です（${MAX_MEMBERS}人まで）。` : res === 'missing' ? 'この部屋は見つかりません。会議が終わって部屋が消えたかもしれません。' : '部屋に入れませんでした。通信の具合を確かめて、もう一度押してください。');
    return;
  }
  S.room = room;
  S.meetStart = Date.now();
  S.mesh = new Mesh(S.myId, (to, msg) => room.sendSignal(to, msg), {
    onData: onPeerData,
    onTrack: onPeerTrack,
    onOpen: (id) => { S.mesh.sendTo(id, { t: 'hi' }, true); },
    onState: (id, st) => { const r = S.remote.get(id); if (r) r.conn = st; }
  });
  S.mesh.setAudio(S.media.outTrack);
  room.onSignal((from, msg) => S.mesh.handleSignal(from, msg));
  room.onMembers(onMembers);
  room.onState((st) => { S.state = st; onStateChange(); });
  S.arts = {};
  loadAllArts().then((arr) => arr.forEach((a, i) => { if (a) S.arts[CHARS[i].id] = a; }));
  try { await document.fonts.load('800 50px "M PLUS Rounded 1c"'); await document.fonts.load('700 18px "M PLUS Rounded 1c"'); } catch (e) { /* なし */ }
  showMeeting();
  placeMeIfNeeded();
  startCaptions();
  window.addEventListener('pagehide', () => { if (S.room) S.room.leave(); });
}

function onMembers(m) {
  S.members = m;
  const ids = Object.keys(m);
  if (S.mesh) S.mesh.sync(ids);
  ids.forEach((id) => {
    if (id === S.myId) return;
    if (!S.remote.has(id)) S.remote.set(id, { st: { mouth: 0, eyesShut: false, roll: 0, yaw: 0, pitch: 0 }, mic: true, lv: 0, at: 0, talkAt: 0 });
  });
  Array.from(S.remote.keys()).forEach((id) => {
    if (m[id]) return;
    const r = S.remote.get(id);
    if (r.audio) { r.audio.srcObject = null; r.audio.remove(); }
    if (r.recSrc) { try { r.recSrc.disconnect(); } catch (e) { /* なし */ } }
    S.remote.delete(id);
  });
  const starts = ids.map((id) => m[id] && m[id].joinedAt).filter(Boolean);
  if (starts.length) S.meetStart = Math.min(...starts);
  // 画面共有していた人がいなくなったら、共有の印を消す
  if (S.state.sharer && !m[S.state.sharer]) S.room.setState({ sharer: null });
  // BGM を流していた人がいなくなったら、BGM を終える
  if (S.state.bgm && !m[S.state.bgm.owner]) S.room.setState({ bgm: null });
  paintBgm();
  paintBarInfo();
  paintPeople();
  placeMeIfNeeded();
}

function onStateChange() {
  const st = S.state;
  if (S.share && st.sharer && st.sharer !== S.myId) stopShare(true);
  syncBgm();
  paintBar();
  paintEditHits();
  paintPeople();
  paintPersonSheet();
  if (!freeOn()) autoPlaced = false;
  placeMeIfNeeded();
}

function onPeerData(id, m) {
  const r = S.remote.get(id);
  if (!r) return;
  const now = performance.now();
  if (m.t === 'f') {
    r.st = { mouth: m.m | 0, eyesShut: !!m.e, roll: +m.r || 0, yaw: +m.y || 0, pitch: +m.p || 0 };
    if (typeof m.c === 'string' && charOf(m.c).id === m.c) r.char = m.c;
    r.mic = m.mic !== false;
    r.lv = +m.lv || 0;
    r.at = now;
    if (r.st.mouth > 0 && r.mic) r.talkAt = now;
  } else if (m.t === 'cap') {
    onCaption(id, String(m.id || ''), String(m.text || '').slice(0, 400), !!m.final);
  }
}

function onPeerTrack(id, track, stream) {
  const r = S.remote.get(id) || {};
  if (!S.remote.has(id)) S.remote.set(id, Object.assign(r, { st: { mouth: 0 }, mic: true, lv: 0, at: 0, talkAt: 0 }));
  if (track.kind === 'audio') {
    if (!r.audio) {
      r.audio = document.createElement('audio');
      r.audio.autoplay = true;
      r.audio.hidden = true;
      document.body.appendChild(r.audio);
    }
    r.audio.srcObject = new MediaStream([track]);
    r.audio.play().catch(() => toast('音を出すには、画面をクリックしてください'));
    if (r.recSrc) { try { r.recSrc.disconnect(); } catch (e) { /* なし */ } }
    r.recSrc = S.media.addRemote(new MediaStream([track]));
  } else if (track.kind === 'video') {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.autoplay = true;
    v.srcObject = new MediaStream([track]);
    v.play().catch(() => {});
    r.shareVideo = v;
    track.addEventListener('ended', () => { if (r.shareVideo === v) r.shareVideo = null; });
  }
}

// 並び順（部屋の状態の order に、まだ入っていない人を入った順に足す）
function orderedIds() {
  const ids = Object.keys(S.members);
  if (!ids.includes(S.myId)) ids.push(S.myId);
  let ord = S.state.order;
  if (ord && !Array.isArray(ord)) ord = Object.keys(ord).sort((a, b) => a - b).map((k) => ord[k]);
  const out = (ord || []).filter((id) => ids.includes(id));
  ids.filter((id) => !out.includes(id))
    .sort((a, b) => ((S.members[a] && S.members[a].joinedAt) || 0) - ((S.members[b] && S.members[b].joinedAt) || 0))
    .forEach((id) => out.push(id));
  return out;
}

function personName(id) {
  if (id === S.myId) return S.name;
  return (S.members[id] && S.members[id].name) || '';
}

function buildModel(now, key) {
  const sizes = S.state.sizes || {};
  const people = orderedIds().map((id) => {
    if (id === S.myId) {
      return {
        id, name: S.name, char: S.char, art: S.myArt || S.arts[S.char], st: S.myState,
        mic: S.media.micOn, talking: S.media.micOn && now - S.myTalkAt < 350, lv: S.lastRms, size: sizes[id] || 'L'
      };
    }
    const r = S.remote.get(id) || { st: {}, mic: true };
    const ch = r.char || (S.members[id] && S.members[id].char) || 'sennin';
    const fresh = now - (r.at || 0) < 2000;
    return {
      id, name: personName(id), char: ch, art: S.arts[ch], st: fresh ? r.st : Object.assign({}, r.st, { mouth: 0 }),
      mic: r.mic !== false, talking: fresh && r.mic !== false && now - (r.talkAt || 0) < 350, lv: r.lv || 0, size: sizes[id] || 'L'
    };
  });
  // 話す人を大きく: いま話している人に、少し間をおいて切り替える
  const talking = people.filter((p) => p.talking);
  const cur = people.find((p) => p.id === S.speakerId);
  if (!cur) S.speakerId = (talking[0] || people[0] || {}).id || '';
  else if (!cur.talking && talking.length) {
    if (!S.speakerQuietAt) S.speakerQuietAt = now;
    if (now - S.speakerQuietAt > 900) { S.speakerId = talking.sort((a, b) => b.lv - a.lv)[0].id; S.speakerQuietAt = 0; }
  } else S.speakerQuietAt = 0;

  let share = null;
  const sharer = S.state.sharer;
  if (sharer) {
    const video = sharer === S.myId ? (S.share && S.share.video) : (S.remote.get(sharer) || {}).shareVideo;
    if (video) share = { video, ownerName: personName(sharer) };
  }
  let caption = null;
  if (S.caption) {
    const age = now - S.caption.at;
    const life = S.caption.final ? 4000 : 9000;
    if (age < life) caption = { name: S.caption.name, color: S.caption.color, text: S.caption.text, alpha: Math.min(1, (life - age) / 500) };
  }
  return {
    key, people, share, speakerId: S.speakerId,
    topic: S.state.topic || '', show: S.state.show || 'キャラ会議', caption, captionsOn: S.captionsOn,
    pos: posMap(), z: S.state.z || {}
  };
}

// ---- 会議の画面 ----
let stageCtx = null, fitK = 1, hover = null, drag = null, dragStart = null, tapId = null;

function ctl(id, ic, label, cls = '') {
  return `<button type="button" class="ctl ${cls}" id="${id}"><span class="b">${ic}</span><span>${label}</span></button>`;
}

function showMeeting() {
  S.screen = 'meet';
  document.body.classList.add('meeting');
  app.innerHTML = `<div class="meet">
    <div class="stagebox" id="stagebox"><div class="stagewrap" id="stagewrap">
      <canvas id="stage" width="${W}" height="${H}"></canvas>
      <div class="overlay" id="overlay">
        <div id="edits"></div>
        <div class="hov" id="hov" hidden><span class="gp" id="grip" title="ドラッグして動かす">${GRIP_SVG}</span>
          <div class="seg" id="seg">${['L', 'M', 'S'].map((z) => `<button type="button" data-size="${z}">${SIZE_LABEL[z]}</button>`).join('')}</div>
          <button type="button" class="rs" id="b-reset-pos" data-reset hidden>並べ直す</button></div>
        <div class="toast2" id="dragtoast" hidden>${icon('info')}置き場所は全員に反映されます</div>
        <div class="frame"></div>
      </div>
    </div></div>
    <div class="people" id="people"></div>
    <div class="bar" id="bar">
      <div class="outnote"><div class="k"><i></i>ここより上が録画される範囲（1920×1080）</div><div>この操作バーは録画に映りません</div></div>
      ${ctl('c-mic', icon('mic'), 'マイク オン', 'on')}
      ${ctl('c-swap', icon('swap'), 'キャラを替える')}
      ${CAN_SHARE ? ctl('c-share', icon('share'), '画面共有') : ''}
      ${ctl('c-cc', icon('cc'), '字幕 オン', 'on')}
      ${ctl('c-save', icon('save'), '文字起こし<wbr>を保存')}
      ${ctl('c-rec', '<span class="recdot"></span>', '録画')}
      ${ctl('c-echo', icon('echo'), 'エコー')}
      ${ctl('c-bgm', MUSIC_SVG, 'BGM')}
      <div class="sep"></div>
      ${ctl('c-leave', icon('leave'), '退室', 'leave')}
      <div class="bgmpill" id="bgmpill" hidden></div>
      <div class="outright"><span class="recpill" id="recpill" hidden><i></i><span id="reclbl">録画中</span> <b id="rectime">0:00</b></span>
        <span>${icon('clock')}<b id="elapsed" style="font-weight:500">0:00</b></span><span>${icon('user')}<b id="count" style="font-weight:500">1人</b></span></div>
    </div>
  </div>`;
  stageCtx = $('#stage').getContext('2d');
  fitStage();
  window.addEventListener('resize', fitStage);
  $('#c-mic').addEventListener('click', toggleMic);
  $('#c-swap').addEventListener('click', () => openVoiceDialog(true));
  if (CAN_SHARE) $('#c-share').addEventListener('click', () => (S.share ? stopShare() : startShare()));
  $('#c-cc').addEventListener('click', () => { S.captionsOn = !S.captionsOn; paintBar(); });
  $('#c-save').addEventListener('click', () => { if (!saveTranscript()) toast('まだ発言がありません'); });
  $('#c-rec').addEventListener('click', () => (S.rec ? stopRec() : openRecDialog()));
  $('#c-bgm').addEventListener('click', openBgmDialog);
  $('#c-leave').addEventListener('click', askLeave);
  setupEchoButton();
  setupStagePointer();
  setupPeople();
  dbg('sr', recog ? '動作中' : '-');
  paintBar();
  paintBarInfo();
  paintEditHits();
  paintPeople();
}

// 「エコー」ボタン: 押しているあいだだけ、声にディレイ＋リバーブを重ねる（響きは管理画面で決める）
function setupEchoButton() {
  const b = $('#c-echo');
  let held = false;
  const on = (ev) => {
    if (ev.cancelable) ev.preventDefault();   // 長押しで文字が選ばれたり、メニューが出たりしないように
    if (held || !S.media) return;
    held = true;
    S.media.setHoldEcho(true, S.defaults && S.defaults._echoButton);
    b.classList.add('on');
  };
  const off = () => {
    if (!held) return;
    held = false;
    if (S.media) S.media.setHoldEcho(false);
    b.classList.remove('on');
  };
  b.addEventListener('touchstart', on, { passive: false });
  b.addEventListener('touchend', (ev) => { if (ev.cancelable) ev.preventDefault(); off(); }, { passive: false });
  b.addEventListener('touchcancel', off);
  b.addEventListener('mousedown', (ev) => { if (ev.button === 0) on(ev); });
  window.addEventListener('mouseup', off);
  b.addEventListener('mouseleave', off);
  b.addEventListener('contextmenu', (ev) => ev.preventDefault());
  window.addEventListener('blur', off);
}

function fitStage() {
  const box = $('#stagebox');
  if (!box) return;
  const bw = box.clientWidth, bh = box.clientHeight;
  fitK = Math.min(bw / W, bh / H);
  $('#stagewrap').style.transform = `translate(${(bw - W * fitK) / 2}px, ${(bh - H * fitK) / 2}px) scale(${fitK})`;
}

function setCtl(id, label, cls, ic) {
  const b = $(`#${id}`);
  if (!b) return;
  b.className = `ctl ${cls || ''}`;
  b.lastElementChild.textContent = label;
  if (ic) b.firstElementChild.innerHTML = ic;
}
function paintBar() {
  if (S.screen !== 'meet') return;
  const on = S.media.micOn;
  setCtl('c-mic', on ? 'マイク オン' : 'マイク オフ', on ? 'on' : 'off', icon(on ? 'mic' : 'micoff'));
  setCtl('c-share', S.share ? '共有を止める' : '画面共有', S.share ? 'on' : '');
  setCtl('c-cc', S.captionsOn ? '字幕 オン' : '字幕 オフ', S.captionsOn ? 'on' : '');
  const recWord = S.rec && S.rec.kind === 'audio' ? '録音中' : '録画中';
  setCtl('c-rec', S.rec ? recWord : '録画', S.rec ? 'recon' : '');
  $('#recpill').hidden = !S.rec;
  $('#reclbl').textContent = recWord;
  paintBgm();
}
function paintBarInfo() {
  const c = $('#count');
  if (c) c.textContent = `${Math.max(1, Object.keys(S.members).length)}人`;
}

function toggleMic() {
  S.media.setMic(!S.media.micOn);
  if (S.media.micOn) startCaptions(); else stopCaptions();
  paintBar();
}

// ---- お題・番組名をその場で書き換える ----
const measureCtx = document.createElement('canvas').getContext('2d');
function paintEditHits() {
  const box = $('#edits');
  if (!box) return;
  const st = S.state;
  const show = st.show || 'キャラ会議';
  measureCtx.font = '800 30px "M PLUS Rounded 1c"';
  measureCtx.letterSpacing = '1.8px';
  const sw = 46 + 14 + measureCtx.measureText(show).width;
  let html = `<div class="edit-hit" data-edit="show" title="クリックして番組名を書き換える" style="left:96px;top:90px;width:${sw + 8}px;height:58px;border-radius:14px"></div>`;
  if (!st.sharer) {
    if (st.topic) {
      measureCtx.letterSpacing = '0px';
      const tw = 68 + measureCtx.measureText(`お題：${st.topic}`).width;
      html += `<div class="edit-hit" data-edit="topic" title="クリックしてお題を書き換える" style="left:${960 - tw / 2}px;top:92px;width:${tw}px;height:60px"></div>`;
    } else {
      html += '<div class="topic-empty" data-edit="topic" title="お題は録画にも映ります">＋ お題を入れる</div>';
    }
  }
  box.innerHTML = html;
}

function startInlineEdit(kind) {
  if (touchUi()) { editDialog(kind); return; }
  const ov = $('#overlay');
  const cur = kind === 'topic' ? (S.state.topic || '') : (S.state.show || 'キャラ会議');
  const inp = document.createElement('input');
  inp.className = 'inline-edit';
  inp.maxLength = kind === 'topic' ? 30 : 20;
  inp.value = cur;
  inp.setAttribute('aria-label', kind === 'topic' ? 'お題' : '番組名');
  inp.placeholder = kind === 'topic' ? 'お題（空にすると消えます）' : '番組名';
  if (kind === 'topic') { inp.style.left = '560px'; inp.style.top = '92px'; inp.style.width = '800px'; inp.style.textAlign = 'center'; }
  else { inp.style.left = '96px'; inp.style.top = '90px'; inp.style.width = '560px'; }
  ov.appendChild(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    inp.remove();
    if (!save) return;
    if (kind === 'topic') S.room.setState({ topic: v });
    else S.room.setState({ show: v || 'キャラ会議' });
  };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') finish(true);
    else if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
}

// ---- 並べ替え・大きさ ----
function toStage(ev) {
  const r = $('#stagewrap').getBoundingClientRect();
  return { x: (ev.clientX - r.left) / fitK, y: (ev.clientY - r.top) / fitK };
}
function personAt(pt, exceptId) {
  // 重なっているときは、前に描かれている人（z が大きい人）を選ぶ
  const z = S.state.z || {};
  let best = null, bestZ = -Infinity, bestD = Infinity;
  S.stage.anim.forEach((a, id) => {
    if (id === exceptId || !a.target) return;
    const L = a.target, h = L.w * 0.5625, top = H - L.bottom - h;
    if (Math.abs(pt.x - L.x) < L.w * 0.25 && pt.y > top + h * 0.07 && pt.y < H - L.bottom) {
      const d = Math.abs(pt.x - L.x), zz = Number(z[id]) || 0;
      if (zz > bestZ || (zz === bestZ && d < bestD)) { bestZ = zz; bestD = d; best = id; }
    }
  });
  return best;
}

// ---- 自由な置き場所 ----
function posMap() {
  const p = S.state.pos;
  const out = {};
  if (p && typeof p === 'object') Object.keys(p).forEach((id) => { const q = cleanPos(p[id]); if (q) out[id] = q; });
  return out;
}
function freeOn() { return Object.keys(posMap()).length > 0; }
// 動かした場所を、全員に。初めて動かしたときは、ほかの人も今の場所のまま残す
function commitDrag(d) {
  const patch = {};
  const pos = posMap();
  if (!Object.keys(pos).length) {
    S.stage.anim.forEach((a, id) => { if (a.target) patch[`pos/${id}`] = { x: a.target.x / W, y: (H - a.target.bottom) / H }; });
  }
  const q = cleanPos({ x: d.ax / W, y: d.ay / H });
  patch[`pos/${d.id}`] = q;
  patch[`z/${d.id}`] = Date.now();
  // 自分の画面には、すぐ出す（返事を待つと、一瞬もとの場所へ戻って見える）
  const np = Object.assign({}, S.state.pos || {});
  Object.keys(patch).forEach((k) => { if (k.startsWith('pos/')) np[k.slice(4)] = patch[k]; });
  S.state = Object.assign({}, S.state, { pos: np, z: Object.assign({}, S.state.z || {}, { [d.id]: patch[`z/${d.id}`] }) });
  const a = S.stage.anim.get(d.id);
  if (a) { a.x = q.x * W; a.bottom = H - q.y * H; }
  S.room.setState(patch);
}
function bringFront(id) {
  const t = Date.now();
  S.state = Object.assign({}, S.state, { z: Object.assign({}, S.state.z || {}, { [id]: t }) });
  S.room.setState({ [`z/${id}`]: t });
}
function resetLayout() {
  S.state = Object.assign({}, S.state, { pos: null, z: null });
  S.room.setState({ pos: null, z: null });
  paintPersonSheet();
  paintPeople();
}
// 自由な置き場所のときに後から入った人は、空いているところに自分で置く（全員の画面で同じ場所になる手順）
let autoPlaced = false;
function placeMeIfNeeded() {
  if (!S.room || S.screen !== 'meet' || autoPlaced) return;
  const pos = posMap();
  if (!freeOn() || pos[S.myId]) return;
  const sizes = S.state.sizes || {};
  const people = orderedIds().map((id) => ({ id, size: sizes[id] || 'L' }));
  const L = computeLayout(people, pos).get(S.myId);
  if (!L) return;
  autoPlaced = true;
  S.room.setState({ [`pos/${S.myId}`]: { x: L.x / W, y: (H - L.bottom) / H } });
}
function nearestSlot(pt, exceptId) {
  let best = null, bestD = Infinity;
  S.stage.anim.forEach((a, id) => {
    if (id === exceptId || !a.target) return;
    const d = Math.abs(pt.x - a.target.x);
    if (d < a.target.w * 0.3 && d < bestD) { bestD = d; best = id; }
  });
  return best;
}
function showHover(id) {
  const hov = $('#hov');
  hover = id;
  if (!id) { hov.hidden = true; hover = null; return; }
  const a = S.stage.anim.get(id);
  if (!a) { hov.hidden = true; return; }
  const L = a.target, h = L.w * 0.5625;
  hov.style.left = `${L.x}px`;
  hov.style.top = `${H - L.bottom - h + h * 0.06}px`;
  const size = (S.state.sizes || {})[id] || 'L';
  $$('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.size === size));
  $('#b-reset-pos').hidden = !freeOn();
  hov.hidden = false;
}

function setupStagePointer() {
  const ov = $('#overlay');
  ov.addEventListener('click', (ev) => {
    // 指で人に触れたら、その人の大きさ・並びの窓を開く（click のあとに開くと、同じタップで窓の中を押さない）
    if (tapId) { const id = tapId; tapId = null; openPersonSheet(id); return; }
    const e = ev.target.closest('[data-edit]');
    if (e) { startInlineEdit(e.dataset.edit); return; }
    if (ev.target.closest('[data-reset]')) { resetLayout(); showHover(null); return; }
    const sz = ev.target.closest('[data-size]');
    if (sz && hover) {
      S.room.setState({ [`sizes/${hover}`]: sz.dataset.size });
      $$('#seg button').forEach((b) => b.classList.toggle('on', b === sz));
    }
  });
  // ドラッグの動き（マウスと指で同じものを使う）。動かしていれば true
  const moveDrag = (cx, cy) => {
    const pt = toStage({ clientX: cx, clientY: cy });
    if (dragStart && !drag) {
      if (Math.hypot(cx - dragStart.cx, cy - dragStart.cy) > 6) {
        // つかんだ場所と、絵の基準（真ん中の下の端）との差を覚えておく（絵が指に飛びつかないように）
        const a = S.stage.anim.get(dragStart.id), L = a && a.target;
        const p0 = toStage({ clientX: dragStart.cx, clientY: dragStart.cy });
        drag = { id: dragStart.id, px: pt.x, py: pt.y, gx: L ? p0.x - L.x : 0, gy: L ? p0.y - (H - L.bottom) : 0, ax: 0, ay: 0 };
        $('#hov').hidden = true;
        document.body.classList.add('dragging');
        dbg('drag', `開始 ${personName(drag.id)}`);
      }
    }
    if (!drag) return false;
    drag.px = pt.x; drag.py = pt.y;
    drag.ax = Math.min(POS_X[1] * W, Math.max(POS_X[0] * W, pt.x - drag.gx));
    drag.ay = Math.min(POS_Y[1] * H, Math.max(POS_Y[0] * H, pt.y - drag.gy));
    const t = $('#dragtoast');
    t.hidden = false;
    t.style.left = `${Math.max(20, Math.min(W - 420, pt.x - 560))}px`;
    t.style.top = `${Math.max(20, pt.y - 360 * 0.25 + 20)}px`;
    return true;
  };
  ov.addEventListener('pointermove', (ev) => {
    if (ev.pointerType === 'touch') return;   // 指はタッチイベントで扱う
    const pt = toStage(ev);
    if (moveDrag(ev.clientX, ev.clientY)) return;
    if (ev.pointerType && ev.pointerType !== 'mouse') return;
    if (ev.target.closest('#hov')) return;
    showHover(personAt(pt));
  });
  ov.addEventListener('pointerleave', () => { if (!drag && !dragStart) showHover(null); });
  ov.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'touch') return;   // 指はタッチイベントで扱う
    tapId = null;
    if (ev.button !== 0) return;
    if (ev.target.closest('[data-size]') || ev.target.closest('[data-edit]') || ev.target.closest('[data-reset]') || ev.target.closest('.inline-edit')) return;
    const pt = toStage(ev);
    const id = ev.target.closest('#grip') ? hover : personAt(pt);
    if (!id) return;
    dragStart = { id, cx: ev.clientX, cy: ev.clientY, touch: !!ev.pointerType && ev.pointerType !== 'mouse' };
    ov.setPointerCapture(ev.pointerId);
  });
  const end = (ev) => {
    if (ev && ev.pointerType === 'touch') return;   // 指はタッチイベントで扱う
    const tapped = ev && ev.type === 'pointerup' && dragStart && dragStart.touch && !drag ? dragStart.id : null;
    if (drag && ev && ev.type === 'pointerup') commitDrag(drag);
    else if (dragStart && !drag && ev && ev.type === 'pointerup') bringFront(dragStart.id);
    drag = null; dragStart = null;
    $('#dragtoast').hidden = true;
    document.body.classList.remove('dragging');
    if (tapped) tapId = tapped;
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);

  // ---- 指: タッチイベントで動かす。人に触れたときは既定の動き（スクロール・拡大・長押しの選択・click）を止める ----
  let touchId = null;
  const finger = (ev) => Array.from(ev.changedTouches).find((t) => t.identifier === touchId);
  ov.addEventListener('touchstart', (ev) => {
    const t = ev.changedTouches[0];
    dbg('touch', `${ev.type} 指${ev.touches.length}`);
    if (dragStart || ev.touches.length !== 1) return;
    if (ev.target.closest('[data-size]') || ev.target.closest('[data-edit]') || ev.target.closest('.inline-edit')) return;
    const id = personAt(toStage(t));
    dbg('drag', id ? `触れた ${personName(id)}` : '人の外');
    if (!id) return;
    ev.preventDefault();
    touchId = t.identifier;
    dragStart = { id, cx: t.clientX, cy: t.clientY, touch: true };
  }, { passive: false });
  ov.addEventListener('touchmove', (ev) => {
    if (!dragStart || touchId === null) return;
    ev.preventDefault();
    const t = finger(ev);
    if (!t) return;
    dbg('touch', 'touchmove');
    moveDrag(t.clientX, t.clientY);
  }, { passive: false });
  const touchEnd = (ev) => {
    if (!dragStart || touchId === null || !finger(ev)) return;
    if (ev.cancelable) ev.preventDefault();
    dbg('touch', ev.type);
    const tapped = ev.type === 'touchend' && !drag ? dragStart.id : null;
    const moved = drag ? `${personName(drag.id)} → (${Math.round(drag.ax)}, ${Math.round(drag.ay)})` : '';
    if (ev.type === 'touchend' && drag) commitDrag(drag);
    if (tapped) bringFront(tapped);
    if (moved) dbg('drag', `${ev.type === 'touchend' ? '終わり' : '取り消し'} ${moved}`);
    touchId = null; drag = null; dragStart = null;
    $('#dragtoast').hidden = true;
    document.body.classList.remove('dragging');
    if (tapped) openPersonSheet(tapped);   // click は止めたので、ここで開く
  };
  ov.addEventListener('touchend', touchEnd, { passive: false });
  ov.addEventListener('touchcancel', touchEnd, { passive: false });
}

// ---- 指で触る端末の操作: 参加者ごとの大きさ・並び（縦向きは画面の下の欄、横向きは人に触れると窓で出る） ----
function setSize(id, z) { S.room.setState({ [`sizes/${id}`]: z }); }
function movePerson(id, dir) {
  const ord = orderedIds();
  const i = ord.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ord.length) return;
  [ord[i], ord[j]] = [ord[j], ord[i]];
  S.room.setState({ order: ord });
}
function personCtl(id, i, n) {
  const size = (S.state.sizes || {})[id] || 'L';
  return `<div class="pc-seg" role="group" aria-label="大きさ">${['L', 'M', 'S'].map((z) => `<button type="button" data-id="${esc(id)}" data-size="${z}" class="${z === size ? 'on' : ''}" aria-pressed="${z === size}">${SIZE_LABEL[z]}</button>`).join('')}</div>
    <div class="pc-mv"><button type="button" data-id="${esc(id)}" data-move="-1" aria-label="左へ" ${i === 0 ? 'disabled' : ''}>${icon('arrow')}</button><button type="button" data-id="${esc(id)}" data-move="1" aria-label="右へ" ${i === n - 1 ? 'disabled' : ''}>${icon('arrow')}</button></div>`;
}
function onPersonCtl(ev) {
  const b = ev.target.closest('button[data-id]');
  if (!b || b.disabled) return;
  if (b.dataset.size) setSize(b.dataset.id, b.dataset.size);
  else if (b.dataset.move) movePerson(b.dataset.id, Number(b.dataset.move));
  else if (b.dataset.edit) editDialog(b.dataset.edit);
  else if (b.hasAttribute('data-reset')) resetLayout();
}
function setupPeople() { $('#people').addEventListener('click', onPersonCtl); }
function paintPeople() {
  const box = $('#people');
  if (!box || S.screen !== 'meet') return;
  const ids = orderedIds();
  const note = freeOn() ? '舞台の上のキャラは、ドラッグで好きな場所に置けます。「並べ直す」で横一列に戻ります' : '並びと大きさは全員に反映されます。舞台の上のキャラは、ドラッグで好きな場所に置けます';
  box.innerHTML = `<div class="pp-h"><span>参加者 ${ids.length}人</span>
      <span class="pp-ed">${freeOn() ? '<button type="button" data-id="-" data-reset>並べ直す</button>' : ''}<button type="button" data-id="-" data-edit="show">番組名</button><button type="button" data-id="-" data-edit="topic">お題</button></span></div>
    ${ids.map((id, i) => `<div class="pp-r"><span class="pp-n">${esc(personName(id))}${id === S.myId ? '<i>あなた</i>' : ''}</span>${personCtl(id, i, ids.length)}</div>`).join('')}
    <div class="pp-note">${note}</div>`;
}
let sheetId = null;
function openPersonSheet(id) {
  if (!S.stage.anim.has(id)) return;
  const scrim = openDialog('<div id="psheet"></div>', () => { sheetId = null; });
  sheetId = id;
  scrim.querySelector('.dlg').classList.add('sheet');
  $('#psheet', scrim).addEventListener('click', (ev) => {
    if (ev.target.closest('#b-pok') || ev.target.closest('#b-px')) { closeDialog(); return; }
    onPersonCtl(ev);
  });
  paintPersonSheet();
}
function paintPersonSheet() {
  const box = $('#psheet');
  if (!box || !sheetId) return;
  const ids = orderedIds();
  const i = ids.indexOf(sheetId);
  if (i < 0) { closeDialog(); return; }
  box.innerHTML = `<button type="button" class="x" aria-label="閉じる" id="b-px">${icon('close')}</button>
    <h2>${esc(personName(sheetId))}</h2>
    <div class="lead">並びと大きさは全員に反映されます</div>
    <div class="pp-r">${personCtl(sheetId, i, ids.length)}</div>
    <div class="acts" style="margin-top:20px">${freeOn() ? '<button type="button" class="btn" data-id="-" data-reset>並べ直す</button>' : ''}<button type="button" class="btn pri" id="b-pok">閉じる</button></div>`;
}
function editDialog(kind) {
  const topic = kind === 'topic';
  const cur = topic ? (S.state.topic || '') : (S.state.show || 'キャラ会議');
  const scrim = openDialog(`
    <button type="button" class="x" aria-label="閉じる">${icon('close')}</button>
    <h2>${topic ? 'お題' : '番組名'}</h2>
    <div class="lead">${topic ? 'お題は録画にも映ります。空にすると消えます。' : '番組名は録画にも映ります。'}</div>
    <form id="f-edit" autocomplete="off">
      <input class="input" id="in-edit" maxlength="${topic ? 30 : 20}" value="${esc(cur)}" aria-label="${topic ? 'お題' : '番組名'}" placeholder="${topic ? 'お題' : '番組名'}">
      <div class="acts" style="margin-top:20px"><button type="button" class="btn ghost" id="b-ecancel">やめる</button><button type="submit" class="btn pri">保存</button></div>
    </form>`);
  const inp = $('#in-edit', scrim);
  inp.focus();
  $('#b-ecancel', scrim).addEventListener('click', () => closeDialog());
  $('#f-edit', scrim).addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = inp.value.trim();
    closeDialog();
    if (topic) S.room.setState({ topic: v });
    else S.room.setState({ show: v || 'キャラ会議' });
  });
}

// ---- 診断の札（?debug=1 のときだけ。携帯で写しを撮ってもらうため） ----
const dbgVals = { sr: '', touch: '', drag: '' };
function dbg(k, v) {
  if (!DEBUG) return;
  dbgVals[k] = `${v} ${new Date().toTimeString().slice(0, 8)}`;
  let el = document.getElementById('ckdbg');
  if (!el) { el = document.createElement('div'); el.id = 'ckdbg'; el.className = 'ckdbg'; document.body.appendChild(el); }
  el.textContent = `音声認識: ${SR ? 'あり' : 'なし'}${IOS ? '（iOS）' : ''}\n最後の音声認識: ${dbgVals.sr || '-'}\n最後の指: ${dbgVals.touch || '-'}\nドラッグ: ${dbgVals.drag || '-'}`;
}

// ---------- 字幕・文字起こし ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
// iPhone・iPad（Safari 以外のブラウザは音声認識を使えないことが多い）
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let recog = null, srWant = false, srBlocked = false, srSession = 0, srWarned = false;
let srQuick = 0;              // 何も聞き取らないまま、すぐ終わった回数
const srShown = new Set();    // 一度出したお知らせ（同じものは出さない）
function srStop(msg) {
  srBlocked = true;
  if (!srShown.has(msg)) { srShown.add(msg); toast(msg, 6000); }
}

function startCaptions() {
  if (!SR) {
    dbg('sr', 'なし');
    if (!srWarned) { srWarned = true; toast(IOS ? 'この端末では字幕を作れません（ほかの人の字幕は出ます）' : 'この Chrome では音声認識を使えないため、字幕は出ません'); }
    return;
  }
  if (srBlocked || !S.media || !S.media.micOn) return;
  srWant = true;
  if (recog) return;
  const r = recog = new SR();
  r.lang = 'ja-JP';
  r.continuous = true;
  r.interimResults = true;
  const sess = ++srSession;
  const startedAt = performance.now();
  let heard = false, lastErr = '';
  r.onstart = () => dbg('sr', 'start');
  r.onaudiostart = () => dbg('sr', 'audiostart');
  r.onresult = (ev) => {
    if (!heard) { heard = true; srQuick = 0; dbg('sr', 'result'); }
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      const text = res[0].transcript.trim();
      if (!text) continue;
      const id = `${S.myId}-${sess}-${i}`;
      onCaption(S.myId, id, text, res.isFinal);
      if (S.mesh) S.mesh.broadcast({ t: 'cap', id, text, final: res.isFinal }, true);
    }
  };
  r.onerror = (ev) => {
    lastErr = ev.error || 'error';
    dbg('sr', `error: ${lastErr}`);
    if (lastErr === 'not-allowed' || lastErr === 'service-not-allowed') {
      srStop(IOS ? `この端末では字幕を作れません（ほかの人の字幕は出ます）［${lastErr}］`
        : `音声認識を使えないため、字幕は出ません（マイクの許可を確かめてください）［${lastErr}］`);
    } else if (lastErr !== 'no-speech' && lastErr !== 'aborted' && !srShown.has(lastErr)) {
      srShown.add(lastErr);
      toast(`字幕を作れませんでした［${lastErr}］`, 5000);
    }
  };
  r.onend = () => {
    recog = null;
    dbg('sr', `end${lastErr ? ` (${lastErr})` : ''}`);
    // 何も聞き取らずに 1.5 秒以内で終わるのが 5 回続いたら、繰り返すのをやめる
    if (!heard && performance.now() - startedAt < 1500) srQuick++;
    if (srQuick >= 5 && !srBlocked) srStop(`字幕を止めました。この端末では音声認識がすぐに終わってしまいます［${lastErr || 'end'}］`);
    if (srWant && !srBlocked && S.screen === 'meet') setTimeout(startCaptions, 300 + srQuick * 700);
  };
  try { r.start(); } catch (e) {
    recog = null;
    dbg('sr', `start失敗: ${e && e.name}`);
    srStop(`字幕を作れませんでした［${(e && e.name) || 'start'}］`);
  }
}
function stopCaptions() {
  srWant = false;
  if (recog) { try { recog.stop(); } catch (e) { /* なし */ } }
}

const seenFinal = new Set();
function onCaption(who, id, text, final) {
  const name = personName(who);
  const ch = who === S.myId ? S.char : ((S.remote.get(who) || {}).char || (S.members[who] && S.members[who].char) || 'sennin');
  S.caption = { id, who, name, color: charOf(ch).bg, text, final, at: performance.now() };
  if (final && !seenFinal.has(id)) {
    seenFinal.add(id);
    S.transcript.push({ t: Date.now(), name, text });
  }
}

function transcriptName() { return `キャラ会議_${ymd(Date.now())}.txt`; }
function transcriptText() {
  const head = [`キャラ会議 文字起こし（${ymd(Date.now())}）`, S.state.topic ? `お題：${S.state.topic}` : '', ''].filter((x, i) => x || i === 2);
  return head.concat(S.transcript.map((l) => `${hhmm(l.t)}  ${l.name}：${l.text}`)).join('\r\n') + '\r\n';
}
function saveTranscript() {
  if (!S.transcript.length) return false;
  download(new Blob(['﻿' + transcriptText()], { type: 'text/plain;charset=utf-8' }), transcriptName());
  return true;
}

// ---------- 画面共有 ----------
async function startShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') toast('画面共有を始められませんでした');
    return;
  }
  const track = stream.getVideoTracks()[0];
  try { track.contentHint = 'detail'; } catch (e) { /* なし */ }  // 字の読みやすさを優先（動きより解像度）
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  video.play().catch(() => {});
  S.share = { stream, track, video };
  track.addEventListener('ended', () => stopShare());
  S.mesh.startShare(track, stream);
  S.room.setState({ sharer: S.myId });
  paintBar();
}
function stopShare(byOther) {
  if (!S.share) return;
  const s = S.share;
  S.share = null;
  S.mesh.stopShare();
  s.stream.getTracks().forEach((t) => t.stop());
  if (!byOther && S.state.sharer === S.myId) S.room.setState({ sharer: null });
  paintBar();
}

// ---------- 録画 ----------
let recCanvas = null, recCtx = null, recDrawAt = 0;
// 録画の大きさ（16:9 のまま解像度だけ替える）と、決めて渡す音質の上限。1時間あたりの目安:
// gb は 3人の会議を 20 秒ずつ撮って測った値（VP9/VP8/MP4 で 1080: 0.22〜0.33、720: 0.18〜0.26、480: 0.12〜0.17 GB）、
// max は上限の音質（映像 vbps＋音声 128kbps）で埋まったときの値（動きの多い画面共有など）
const REC_SIZES = [
  { h: 1080, w: 1920, vbps: 6000000, gb: '0.3', max: '2.7' },
  { h: 720, w: 1280, vbps: 3000000, gb: '0.25', max: '1.4' },
  { h: 480, w: 854, vbps: 1500000, gb: '0.15', max: '0.7' }
];
const REC_ABPS = 128000;
const REC_AUDIO_MB = '60';
// ファイルの種類。この端末の MediaRecorder が撮れると答えたものだけを出す（iPhone は MP4 だけのことが多い）
const REC_TYPES = {
  video: [
    { id: 'vp9', label: 'WebM（VP9）', ext: 'webm', mimes: ['video/webm;codecs=vp9,opus'] },
    { id: 'vp8', label: 'WebM（VP8）', ext: 'webm', mimes: ['video/webm;codecs=vp8,opus', 'video/webm'] },
    { id: 'mp4', label: 'MP4（H.264）', ext: 'mp4', mimes: ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'] }
  ],
  audio: [
    { id: 'opus', label: 'WebM（Opus）', ext: 'webm', mimes: ['audio/webm;codecs=opus', 'audio/webm'] },
    { id: 'm4a', label: 'M4A（AAC）', ext: 'm4a', mimes: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'] }
  ]
};
function recTypes(kind) {
  const ok = (m) => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } };
  return REC_TYPES[kind].map((t) => Object.assign({}, t, { mime: t.mimes.find(ok) })).filter((t) => t.mime);
}
function recSaved() { try { return JSON.parse(localStorage.getItem('ck-rec') || '{}') || {}; } catch (e) { return {}; } }
function recRemember(o) { try { localStorage.setItem('ck-rec', JSON.stringify(o)); } catch (e) { /* なし */ } }
// 前回の選び方（撮れない組み合わせなら、撮れるものに直す）
function recChoice(saved) {
  const types = { video: recTypes('video'), audio: recTypes('audio') };
  let kind = saved.kind === 'audio' ? 'audio' : 'video';
  if (!types[kind].length) kind = kind === 'video' ? 'audio' : 'video';
  const fmt = {};
  ['video', 'audio'].forEach((k) => { fmt[k] = (types[k].find((t) => t.id === saved[k]) || types[k][0] || {}).id; });
  const h = REC_SIZES.some((z) => z.h === saved.h) ? saved.h : 1080;
  return { types, kind, fmt, h };
}

function openRecDialog() {
  if (typeof MediaRecorder === 'undefined') { toast('この Chrome では録画できません'); return; }
  const c = recChoice(recSaved());
  if (!c.types.video.length && !c.types.audio.length) { toast('この Chrome では録画できません'); return; }
  const scrim = openDialog('<div id="recdlg"></div>');
  const box = $('#recdlg', scrim);
  const opt = (attr, val, on, main, sub = '') => `<button type="button" class="ropt ${on ? 'on' : ''}" ${attr}="${val}" aria-pressed="${on}"><span class="rm">${main}</span>${sub ? `<span class="rs">${sub}</span>` : ''}</button>`;
  const paint = () => {
    const video = c.kind === 'video';
    const list = c.types[c.kind];
    const hasMp4 = c.types.video.some((t) => t.id === 'mp4');
    box.innerHTML = `<button type="button" class="x" aria-label="閉じる">${icon('close')}</button>
      <h2>${video ? '録画' : '録音'}</h2>
      <div class="lead">止めると、この端末にファイルで保存します。</div>
      <div class="lbl">内容</div>
      <div class="ropts">${c.types.video.length ? opt('data-kind', 'video', video, '映像と音声') : ''}${c.types.audio.length ? opt('data-kind', 'audio', !video, '音声だけ') : ''}</div>
      <div class="lbl">ファイルの種類</div>
      <div class="ropts">${list.map((t) => opt('data-fmt', t.id, t.id === c.fmt[c.kind], t.label, `.${t.ext}`)).join('')}</div>
      ${video && hasMp4 ? '<div class="rnote">YouTube に載せるなら、MP4 が扱いやすいです（WebM も載せられます）。</div>' : ''}
      ${video ? `<div class="lbl">大きさ</div>
      <div class="ropts rows">${REC_SIZES.map((z) => opt('data-h', z.h, z.h === c.h, `${z.w}×${z.h}`, `1時間で約 ${z.gb} GB・最大 ${z.max} GB（目安）`)).join('')}</div>
      <div class="rnote">動きの多い画面共有をすると、ファイルは大きくなります。</div>`
    : `<div class="rnote">ファイルの大きさは、1時間で約 ${REC_AUDIO_MB} MB です（目安）。</div>`}
      <div class="acts" style="margin-top:22px"><button type="button" class="btn ghost" id="b-rno">やめる</button>
        <button type="button" class="btn pri" id="b-rgo">${video ? '録画を始める' : '録音を始める'}</button></div>`;
  };
  paint();
  box.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.classList.contains('x') || b.id === 'b-rno') { closeDialog(); return; }
    if (b.dataset.kind) c.kind = b.dataset.kind;
    else if (b.dataset.fmt) c.fmt[c.kind] = b.dataset.fmt;
    else if (b.dataset.h) c.h = Number(b.dataset.h);
    else if (b.id === 'b-rgo') {
      recRemember({ kind: c.kind, video: c.fmt.video, audio: c.fmt.audio, h: c.h });
      const t = c.types[c.kind].find((x) => x.id === c.fmt[c.kind]);
      const z = REC_SIZES.find((x) => x.h === c.h);
      closeDialog();
      startRec({ kind: c.kind, mime: t.mime, ext: t.ext, w: z.w, h: z.h, vbps: z.vbps });
      return;
    } else return;
    paint();
  });
}

// opt: { kind: 'video' | 'audio', mime, ext, w, h, vbps }（省くと、前回の選び方で撮る）
function startRec(opt) {
  if (typeof MediaRecorder === 'undefined') { toast('この Chrome では録画できません'); return; }
  if (!opt) {
    const c = recChoice(recSaved());
    const t = c.types[c.kind].find((x) => x.id === c.fmt[c.kind]);
    const z = REC_SIZES.find((x) => x.h === c.h);
    if (!t) { toast('この Chrome では録画できません'); return; }
    opt = { kind: c.kind, mime: t.mime, ext: t.ext, w: z.w, h: z.h, vbps: z.vbps };
  }
  const video = opt.kind === 'video';
  const tracks = [S.media.recDest.stream.getAudioTracks()[0]];
  if (video) {
    recCanvas = document.createElement('canvas');
    recCanvas.width = opt.w; recCanvas.height = opt.h;
    recCtx = recCanvas.getContext('2d');
    renderRec(performance.now(), true);
    tracks.unshift(recCanvas.captureStream(30).getVideoTracks()[0]);
  }
  const ro = { mimeType: opt.mime, audioBitsPerSecond: REC_ABPS };
  if (video) ro.videoBitsPerSecond = opt.vbps;
  let mr;
  try { mr = new MediaRecorder(new MediaStream(tracks), ro); } catch (e) {
    recCanvas = null; recCtx = null;
    toast(video ? '録画を始められませんでした' : '録音を始められませんでした');
    return;
  }
  const chunks = [];
  mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  S.rec = { mr, chunks, start: Date.now(), mimeType: mr.mimeType || opt.mime, ext: opt.ext, kind: opt.kind, w: opt.w, h: opt.h };
  mr.start(1000);
  paintBar();
  toast(video ? '録画を始めました。止めると、録画のファイルを保存します' : '録音を始めました。止めると、録音のファイルを保存します');
}
function stopRec() {
  const rec = S.rec;
  if (!rec) return Promise.resolve();
  S.rec = null;
  paintBar();
  return new Promise((resolve) => {
    rec.mr.onstop = () => {
      const blob = new Blob(rec.chunks, { type: rec.mimeType.split(';')[0] });
      const d = new Date(rec.start);
      download(blob, `キャラ会議_${ymd(rec.start)}_${pad2(d.getHours())}${pad2(d.getMinutes())}.${rec.ext}`);
      if (DEBUG) window.__lastRecording = { size: blob.size, type: rec.mimeType, ms: Date.now() - rec.start, kind: rec.kind, w: rec.w, h: rec.h, blob };
      recCanvas = null; recCtx = null;
      resolve();
    };
    try { rec.mr.stop(); } catch (e) { resolve(); }
  });
}
function renderRec(now, force) {
  if (!recCtx || (!force && now - recDrawAt < 30)) return;
  recDrawAt = now;
  S.stage.render(recCtx, buildModel(now, 'rec'), null);
}

// ---------- BGM ----------
// 部屋に1曲だけ。だれが流しているかは部屋の状態 bgm: { owner, title, startedAt } で全員が見る。
// 曲のファイルは送らない。流している人の端末で鳴らした音を、声と同じ音の通り道で届ける（声の加工・口の動き・字幕は通らない）
const MUSIC_SVG = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/></svg>';
const BGM = { file: null, vol: 20, loop: true };   // この端末で選んだ曲・音量（%）・くり返す
function bgmTitle(name) { return String(name || '').replace(/\.[^.]+$/, '').slice(0, 40) || '曲'; }

function playBgm() {
  if (!BGM.file || !S.media || !S.room) return;
  stopBgmLocal();
  const el = new Audio();
  el.setAttribute('playsinline', '');
  el.preload = 'auto';
  el.loop = BGM.loop;
  const url = URL.createObjectURL(BGM.file);
  el.src = url;
  const startedAt = Date.now();
  const mine = S.bgm = { el, url, startedAt, seen: false };
  el.addEventListener('ended', () => { if (S.bgm === mine) stopBgmAll(); });
  try { S.media.playBgm(el, BGM.vol / 100); } catch (e) { console.warn(e); }
  // play() は押した手の中で呼ぶ（iPhone では、押した直後でないと鳴らない）
  el.play().then(() => {
    if (S.bgm !== mine) return;
    S.room.setState({ bgm: { owner: S.myId, title: bgmTitle(BGM.file.name), startedAt } });
  }).catch((e) => {
    console.warn(e);
    if (S.bgm === mine) stopBgmLocal();
    toast('この曲のファイルは流せません。別のファイルを選んでください');
  });
  paintBgm();
}
// この端末で鳴らしている曲を止める（部屋の状態は触らない）
function stopBgmLocal() {
  const b = S.bgm;
  if (!b) return;
  S.bgm = null;
  if (S.media) S.media.stopBgm();
  try { b.el.pause(); b.el.removeAttribute('src'); b.el.load(); } catch (e) { /* なし */ }
  URL.revokeObjectURL(b.url);
  paintBgm();
}
// 全員の BGM を止める（だれが押してもよい）
function stopBgmAll() {
  stopBgmLocal();
  if (S.state.bgm && S.room) S.room.setState({ bgm: null });
}
// 部屋の状態が変わったとき: ほかの人が新しい曲を流した・だれかが止めたら、自分の曲を止める
function syncBgm() {
  const b = S.bgm;
  if (!b) return;
  const cur = S.state.bgm;
  const same = cur && cur.owner === S.myId && cur.startedAt === b.startedAt;
  if (!b.seen) { if (same) b.seen = true; return; }   // 書いた曲がまだ届いていないあいだは待つ
  if (!same) stopBgmLocal();
}
function bgmLabel() {
  const cur = S.state.bgm;
  if (!cur) return '';
  return `♪ ${cur.title || '曲'}（${personName(cur.owner) || '?'}）`;
}
function paintBgm() {
  if (S.screen !== 'meet') return;
  const on = !!S.state.bgm;
  const b = $('#c-bgm');
  if (b) b.classList.toggle('on', on);
  const pill = $('#bgmpill');
  if (pill) { pill.hidden = !on; pill.textContent = bgmLabel(); pill.title = bgmLabel(); }
  paintBgmDialog();
}

function openBgmDialog() {
  const scrim = openDialog(`
    <button type="button" class="x" aria-label="閉じる">${icon('close')}</button>
    <h2>BGM</h2>
    <div class="lead">選んだ曲を、参加している全員に流します。録画にも入ります。曲のファイルは送らず、この端末で鳴らした音だけが届きます。</div>
    <div class="bgm-now" id="bgm-now"></div>
    <div class="lbl">曲</div>
    <div class="bgm-file"><label class="btn" for="bgm-in">${MUSIC_SVG}曲を選ぶ</label><span id="bgm-fn"></span>
      <input type="file" id="bgm-in" class="vh" accept="audio/*"></div>
    <label class="lbl" for="bgm-vol" style="margin-top:18px">音量 <b id="bgm-vv"></b></label>
    <input type="range" id="bgm-vol" min="0" max="100" step="1" value="${BGM.vol}" style="--p:${BGM.vol}%">
    <div class="bgm-loop"><span id="bgm-loop-l">くり返す</span><button type="button" class="sw ${BGM.loop ? 'on' : ''}" id="bgm-loop" role="switch" aria-checked="${BGM.loop}" aria-labelledby="bgm-loop-l"></button></div>
    <div class="rnote">YouTube に載せるなら、使ってよい曲（著作権フリーなど）を選んでください</div>
    <div class="acts" style="margin-top:22px">
      <button type="button" class="btn ghost" id="b-bstop">${icon('stop')}止める</button>
      <button type="button" class="btn" id="b-bclose">閉じる</button>
      <button type="button" class="btn pri" id="b-bplay">${icon('play')}流す</button>
    </div>`);
  $('#bgm-in', scrim).addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) BGM.file = f;
    paintBgmDialog();
  });
  const vol = $('#bgm-vol', scrim);
  vol.addEventListener('input', () => {
    BGM.vol = Number(vol.value);
    vol.style.setProperty('--p', `${BGM.vol}%`);
    if (S.bgm && S.media) S.media.setBgmVolume(BGM.vol / 100);
    paintBgmDialog();
  });
  $('#bgm-loop', scrim).addEventListener('click', (ev) => {
    BGM.loop = !BGM.loop;
    ev.currentTarget.classList.toggle('on', BGM.loop);
    ev.currentTarget.setAttribute('aria-checked', BGM.loop);
    if (S.bgm) S.bgm.el.loop = BGM.loop;
  });
  $('#b-bplay', scrim).addEventListener('click', playBgm);
  $('#b-bstop', scrim).addEventListener('click', stopBgmAll);
  $('#b-bclose', scrim).addEventListener('click', () => closeDialog());
  paintBgmDialog();
}
function paintBgmDialog() {
  const now = $('#bgm-now');
  if (!now) return;
  now.textContent = S.state.bgm ? `いま流れている曲：${bgmLabel()}` : 'いま流れている曲はありません';
  now.classList.toggle('on', !!S.state.bgm);
  $('#bgm-fn').textContent = BGM.file ? BGM.file.name : '曲を選んでいません';
  $('#bgm-vv').textContent = `${BGM.vol}%`;
  $('#b-bplay').disabled = !BGM.file;
  $('#b-bstop').disabled = !S.state.bgm && !S.bgm;
}

// ---------- 5 退室 ----------
function askLeave() {
  if (!S.transcript.length) { leaveNow(false); return; }
  const lines = S.transcript.slice(0, 6);
  const mins = Math.max(1, Math.round((Date.now() - S.meetStart) / 60000));
  const scrim = openDialog(`
    <button type="button" class="x" aria-label="会議にもどる">${icon('close')}</button>
    <h2>文字起こしを保存しますか</h2>
    <div class="lead">退室する前に、この会議の発言をファイルに保存できます。</div>
    <div class="lbl">保存の形式</div>
    <div class="fmt"><div class="ic">${icon('file')}</div><div class="t">テキスト（.txt）</div><div class="fn">${esc(transcriptName())}</div></div>
    <div class="lbl">内容の見本</div>
    <div class="prev ${S.transcript.length > 6 ? 'more' : ''}">${lines.map((l) => `<div class="r"><span class="tm">${hhmm(l.t)}</span><span class="nm">${esc(l.name)}</span><span>${esc(l.text)}</span></div>`).join('')}</div>
    <div class="meta">全 ${S.transcript.length} 件の発言・${mins} 分</div>
    <div class="acts">${S.rec ? `<div class="l">${S.rec.kind === 'audio' ? '録音' : '録画'}は止めて、ファイルに保存します</div>` : ''}
      <button type="button" class="btn ghost" id="b-nosave">保存しないで出る</button>
      <button type="button" class="btn pri" id="b-save">${icon('save')}保存する</button></div>`);
  $('#b-nosave', scrim).addEventListener('click', () => leaveNow(false));
  $('#b-save', scrim).addEventListener('click', () => leaveNow(true));
}

async function leaveNow(save) {
  closeDialog();
  if (save) saveTranscript();
  if (S.rec) await stopRec();
  if (S.share) stopShare();
  if (S.bgm) stopBgmAll();
  stopCaptions();
  if (S.mesh) S.mesh.closeAll();
  S.remote.forEach((r) => { if (r.audio) { r.audio.srcObject = null; r.audio.remove(); } });
  S.remote.clear();
  if (S.room) { const r = S.room; S.room = null; await r.leave(); }
  if (S.media) { S.media.close(); S.media = null; }
  document.body.classList.remove('meeting');
  S.screen = 'left';
  app.innerHTML = topBar() + `<div class="entry"><div class="col"><div class="card" style="min-height:0">
    <h1>退室しました</h1><div class="lead">おつかれさまでした。</div>
    <div style="display:flex;gap:12px"><a class="btn" href="${esc(roomUrl(S.roomId))}">もう一度入る</a>
    <a class="btn pri" style="flex:1" href="${esc(location.pathname)}">新しい部屋を作る${icon('arrow')}</a></div></div></div></div>`;
}

// ---------- 毎コマの仕事 ----------
const faceCanvas = document.createElement('canvas');
faceCanvas.width = 320; faceCanvas.height = 180;
const faceCtx = faceCanvas.getContext('2d', { willReadFrequently: true });
let faceAt = 0, sendAt = 0, lastFrame = 0;

function tick() {
  const now = performance.now();
  if (now - lastFrame < 12) return;
  lastFrame = now;
  const m = S.media;
  if (m) {
    const rms = m.micOn ? m.rms() : 0;
    S.lastRms = rms;
    if (m.hasCamera && m.video && m.video.readyState >= 2 && now - faceAt > 70) {
      faceAt = now;
      faceCtx.drawImage(m.video, 0, 0, 320, 180);
      const r = detectFace(faceCanvas);
      if (r) S.anim.setFace(r);
    }
    const st = S.anim.update(now, rms);
    S.myState = st;
    if (st.mouth > 0 && m.micOn) S.myTalkAt = now;
  }
  if (S.screen === 'prep') drawPrep(now);
  if (S.screen === 'meet' && m) {
    if (now - sendAt >= 50 && S.mesh) {
      sendAt = now;
      const st = S.myState, f3 = (x) => Math.round(x * 1000) / 1000;
      S.mesh.broadcast({ t: 'f', m: st.mouth, e: st.eyesShut ? 1 : 0, r: f3(st.roll), y: f3(st.yaw), p: f3(st.pitch), c: S.char, mic: m.micOn, lv: f3(S.lastRms) });
    }
    const model = buildModel(now, 'view');
    S.stage.update(model, now);
    if (!document.hidden) S.stage.render(stageCtx, model, { drag });
    renderRec(now);
    const el = $('#elapsed');
    if (el) el.textContent = mmss(Date.now() - S.meetStart);
    if (S.rec) { const rt = $('#rectime'); if (rt) rt.textContent = mmss(Date.now() - S.rec.start); }
  }
}
function rafLoop() { if (!document.hidden) tick(); requestAnimationFrame(rafLoop); }
requestAnimationFrame(rafLoop);
try {
  const w = new Worker(new URL('./tick-worker.js', import.meta.url));
  w.onmessage = () => { if (document.hidden) tick(); };
} catch (e) { /* 裏に回ると動きが遅くなるだけ */ }

// ---------- 始まり ----------
async function boot() {
  setMouth(savedMouth(), false);
  try {
    S.db = await getDb();
  } catch (e) {
    console.warn(e);
    app.innerHTML = topBar() + '<div class="entry"><div class="col"><div class="card" style="min-height:0"><h1>つなぎ役に接続できません</h1><div class="lead">通信の具合を確かめて、ページを読み込み直してください。</div></div></div></div>';
    return;
  }
  cleanupOldRooms(S.db);
  let v = null;
  try { v = await S.db.get('defaults/v'); } catch (e) { console.warn('[キャラ会議] 声の初期値を読めないため、既定の声を使います', e); }
  S.defaults = cleanDefaults(v);
  S.voice = cleanVoice(S.defaults[S.char]);
  if (S.roomId && validRoomId(S.roomId)) showInvite();
  else { S.roomId = ''; showCreate(false); }
}

if (DEBUG) {
  window.ckDebug = {
    S,
    caption: (text, final = true) => {
      const id = `${S.myId}-dbg-${Date.now()}`;
      onCaption(S.myId, id, text, final);
      if (S.mesh) S.mesh.broadcast({ t: 'cap', id, text, final }, true);
    },
    peers: () => Array.from(S.mesh ? S.mesh.peers.values() : []).map((p) => ({ id: p.id, conn: p.pc.connectionState, dc: p.dc.readyState })),
    remote: () => Array.from(S.remote.entries()).map(([id, r]) => ({ id, name: personName(id), char: r.char, mouth: r.st && r.st.mouth, mic: r.mic, ageMs: Math.round(performance.now() - r.at), hasAudio: !!r.audio, hasShare: !!r.shareVideo })),
    order: () => orderedIds().map(personName),
    startRec, stopRec, startShare, stopShare, openRecDialog, recTypes,
    BGM, playBgm, stopBgmAll, openBgmDialog,
    layout: () => Array.from(S.stage.anim.entries()).map(([id, a]) => ({ name: personName(id), x: Math.round(a.target.x), w: Math.round(a.target.w), bottom: a.target.bottom }))
  };
}

boot();
