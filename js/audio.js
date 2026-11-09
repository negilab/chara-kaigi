// 自分のマイクとカメラ。声はここで加工してから送る。口の開きは加工前の声の大きさで決める。
import { E } from './common.js';

// 「音の設定」で選んだもの（この端末に覚える）
export const SND_KEYS = { mic: 'ck-mic', ns: 'ck-ns', gain: 'ck-micgain', spk: 'ck-spk', remote: 'ck-remotevol' };
// BGM・効果音の大きさの基準（つまみの値にこれを掛ける。前は 1 で、大きすぎたため 1/3 に）
export const BGM_BASE = 1 / 3, SE_BASE = 1 / 3;
// 自分の端末で鳴らすときは、送る大きさよりさらに小さく。ブラウザのエコー消し（AEC）は、この端末から出る音を
// 「エコーの元」として聞いており、大きな BGM が出ていると、ヘッドホンでも自分の声を消しにかかることがあるため（推測）。
// 送る音・録画の大きさは変えない
export const LOCAL_LEVEL = 0.4;
export function getPref(k, d) { try { const v = localStorage.getItem(k); return v == null || v === '' ? d : v; } catch (e) { return d; } }
export function setPref(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* なし */ } }

export class LocalMedia {
  constructor() {
    this.ac = null;
    this.stream = null;     // マイク（とカメラ）
    this.video = null;      // カメラの映像（顔の読み取り用。画面には出さない）
    this.hasCamera = false;
    this.micOn = true;
    this.monitorOn = false;
    this.buf = new Float32Array(1024);
    this.micId = getPref(SND_KEYS.mic, '');          // 選んだマイク（無ければ既定のマイク）
    this.ns = getPref(SND_KEYS.ns, '1') !== '0';     // 雑音を抑える（今までどおり オン）
    this.inGainV = Math.min(2, Math.max(0, Number(getPref(SND_KEYS.gain, '100')) / 100 || 0));
  }

  // マイクを開くときの条件（今までと同じ。雑音を抑える・選んだマイクだけ変えられる）
  audioConstraints() {
    const c = { echoCancellation: this.ns, noiseSuppression: this.ns, autoGainControl: true };
    if (this.micId) c.deviceId = { exact: this.micId };
    return c;
  }

  // マイクとカメラを開く。カメラが無い・許可されないときはマイクだけ
  async open() {
    const get = async (audio) => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio, video: { width: 640, height: 360, frameRate: 15 } });
        this.hasCamera = s.getVideoTracks().length > 0;
        return s;
      } catch (e) {
        this.hasCamera = false;
        return navigator.mediaDevices.getUserMedia({ audio });
      }
    };
    try {
      this.stream = await get(this.audioConstraints());
    } catch (e) {
      // 前に選んだマイクが無いときは、既定のマイクで開き直す
      if (!this.micId) throw e;
      this.micId = '';
      this.stream = await get(this.audioConstraints());
    }
    const ac = this.ac = new AudioContext({ latencyHint: 'interactive' });
    const spk = getPref(SND_KEYS.spk, '');
    if (spk && typeof ac.setSinkId === 'function') ac.setSinkId(spk).catch(() => {});
    // マイク → マイクの音量 → （口の動き・加工）。マイクを替えても、この後ろはそのまま（送る音の通り道は変わらない）
    this.src = ac.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks()));
    this.inGain = ac.createGain();
    this.inGain.gain.value = this.inGainV;
    this.src.connect(this.inGain);
    this.analyser = ac.createAnalyser();
    this.analyser.fftSize = 1024;
    this.inGain.connect(this.analyser);
    this.engine = E.create(ac);
    this.inGain.connect(this.engine.input);
    this.muteGain = ac.createGain();
    this.engine.output.connect(this.muteGain);
    this.dest = ac.createMediaStreamDestination();
    this.dest.channelCount = 1;
    this.muteGain.connect(this.dest);
    // 「エコー」ボタン: 加工後の声から響きを作り、同じ出口（送る声・録画）に足す
    this.holdEcho = E.createHoldEcho(ac);
    this.engine.output.connect(this.holdEcho.input);
    this.holdEcho.output.connect(this.muteGain);
    this.outTrack = this.dest.stream.getAudioTracks()[0];
    // 自分の声を自分で聞く（試しに聞くときだけ）
    this.monitor = ac.createGain();
    this.monitor.gain.value = 0;
    this.engine.output.connect(this.monitor);
    this.holdEcho.output.connect(this.monitor);   // 「エコー」ボタンの響きも、ほかの人に届くのと同じように聞く（BGM・効果音は入れない）
    this.monitor.connect(ac.destination);
    // 録画に入れる音（自分の加工後の声＋みんなの声）
    this.recMix = ac.createGain();
    this.muteGain.connect(this.recMix);
    this.recDest = ac.createMediaStreamDestination();
    // 何人かの声が重なっても音が割れないように
    const lim = ac.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 4; lim.ratio.value = 12;
    lim.attack.value = 0.003; lim.release.value = 0.15;
    this.recMix.connect(lim);
    lim.connect(this.recDest);
    if (this.hasCamera) {
      const v = this.video = document.createElement('video');
      v.muted = true; v.playsInline = true;
      v.srcObject = new MediaStream(this.stream.getVideoTracks());
      v.play().catch(() => {});
    }
    const resume = () => { if (ac.state === 'suspended') ac.resume().catch(() => {}); };
    ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, resume, true));
    resume();
  }

  applyVoice(voice) { if (this.engine) this.engine.apply(voice); }

  // 「エコー」ボタン。on のあいだだけ響きを重ねる（声の設定は変えない）
  setHoldEcho(on, settings) {
    if (!this.holdEcho) return;
    if (on) this.holdEcho.set(settings);
    this.holdEcho.hold(on);
  }

  setMic(on) {
    this.micOn = on;
    if (this.muteGain) this.muteGain.gain.setTargetAtTime(on ? 1 : 0, this.ac.currentTime, 0.02);
  }

  setMonitor(on) {
    this.monitorOn = !!on;
    if (this.monitor) this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ac.currentTime, 0.02);
  }

  // ---- 音の設定 ----
  // マイクを替える・雑音を抑えるを切り替える: マイクを開き直して、同じ場所につなぎ直す（送る音のトラックは同じなので、つなぎ直しは要らない）
  async switchMic(opts) {
    if (opts && opts.deviceId !== undefined) this.micId = opts.deviceId;
    if (opts && opts.ns !== undefined) this.ns = !!opts.ns;
    const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
    this.stream.getAudioTracks().forEach((t) => { t.stop(); this.stream.removeTrack(t); });
    s.getAudioTracks().forEach((t) => this.stream.addTrack(t));
    try { this.src.disconnect(); } catch (e) { /* なし */ }
    this.src = this.ac.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
    this.src.connect(this.inGain);
    setPref(SND_KEYS.mic, this.micId);
    setPref(SND_KEYS.ns, this.ns ? '1' : '0');
  }
  // いま使っているマイクの名前（deviceId）
  currentMicId() { const t = this.stream && this.stream.getAudioTracks()[0]; const s = t && t.getSettings ? t.getSettings() : {}; return s.deviceId || this.micId || ''; }
  setInputGain(v) {
    this.inGainV = v;
    if (this.inGain) this.inGain.gain.setTargetAtTime(v, this.ac.currentTime, 0.02);
    setPref(SND_KEYS.gain, Math.round(v * 100));
  }
  // 自分の端末のスピーカー（BGM・効果音・自分の声を聞く）。ほかの人の声の出口は main.js で <audio> ごとに
  async setSpeaker(id) {
    if (this.ac && typeof this.ac.setSinkId === 'function') await this.ac.setSinkId(id || '');
    setPref(SND_KEYS.spk, id || '');
  }

  // 加工前の声の大きさ（RMS）。マイクを切っているときは 0
  rms() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    return Math.sqrt(s / this.buf.length);
  }

  // ほかの人の声を録画の音に混ぜる
  addRemote(stream) {
    if (!this.ac) return null;
    try {
      const s = this.ac.createMediaStreamSource(stream);
      s.connect(this.recMix);
      return s;
    } catch (e) { return null; }
  }

  // BGM: 声の加工・口の動き（rms）・字幕を通らずに、送る音・録画の音・自分のスピーカーへ直接まぜる。
  // マイクを切っても流れる（muteGain の後ろにつなぐため）。el は曲を読み込んだ <audio>（1つの曲に1つ）
  playBgm(el, vol) {
    this.stopBgm();
    const ac = this.ac;
    const src = ac.createMediaElementSource(el);
    const g = ac.createGain();
    g.gain.value = vol * BGM_BASE;
    src.connect(g);
    g.connect(this.dest);
    g.connect(this.recMix);
    const local = ac.createGain();
    local.gain.value = LOCAL_LEVEL;
    g.connect(local);
    local.connect(ac.destination);
    this.bgm = { src, g, local };
  }
  // 効果音: BGM と同じ通り道（声の加工・口の動き・字幕を通らずに、送る音・録画の音・自分のスピーカーへ）。重ねて鳴らせる
  playSe(buffer, vol) {
    const ac = this.ac;
    if (!ac || !buffer) return;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const g = ac.createGain();
    g.gain.value = vol * SE_BASE;
    src.connect(g);
    g.connect(this.dest);
    g.connect(this.recMix);
    const local = ac.createGain();
    local.gain.value = LOCAL_LEVEL;
    g.connect(local);
    local.connect(ac.destination);
    src.onended = () => { try { g.disconnect(); local.disconnect(); } catch (e) { /* なし */ } };
    src.start();
  }
  setBgmVolume(vol) { if (this.bgm) this.bgm.g.gain.setTargetAtTime(vol * BGM_BASE, this.ac.currentTime, 0.03); }
  stopBgm() {
    if (!this.bgm) return;
    try { this.bgm.src.disconnect(); this.bgm.g.disconnect(); this.bgm.local.disconnect(); } catch (e) { /* なし */ }
    this.bgm = null;
  }

  close() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.engine) this.engine.destroy();
    if (this.ac) this.ac.close().catch(() => {});
  }
}
