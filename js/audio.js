// 自分のマイクとカメラ。声はここで加工してから送る。口の開きは加工前の声の大きさで決める。
import { E } from './common.js';

export class LocalMedia {
  constructor() {
    this.ac = null;
    this.stream = null;     // マイク（とカメラ）
    this.video = null;      // カメラの映像（顔の読み取り用。画面には出さない）
    this.hasCamera = false;
    this.micOn = true;
    this.buf = new Float32Array(1024);
  }

  // マイクとカメラを開く。カメラが無い・許可されないときはマイクだけ
  async open() {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: { width: 640, height: 360, frameRate: 15 } });
      this.hasCamera = this.stream.getVideoTracks().length > 0;
    } catch (e) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
      this.hasCamera = false;
    }
    const ac = this.ac = new AudioContext({ latencyHint: 'interactive' });
    const src = ac.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks()));
    this.analyser = ac.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.engine = E.create(ac);
    src.connect(this.engine.input);
    this.muteGain = ac.createGain();
    this.engine.output.connect(this.muteGain);
    this.dest = ac.createMediaStreamDestination();
    this.dest.channelCount = 1;
    this.muteGain.connect(this.dest);
    this.outTrack = this.dest.stream.getAudioTracks()[0];
    // 自分の声を自分で聞く（試しに聞くときだけ）
    this.monitor = ac.createGain();
    this.monitor.gain.value = 0;
    this.engine.output.connect(this.monitor);
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

  setMic(on) {
    this.micOn = on;
    if (this.muteGain) this.muteGain.gain.setTargetAtTime(on ? 1 : 0, this.ac.currentTime, 0.02);
  }

  setMonitor(on) {
    if (this.monitor) this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ac.currentTime, 0.02);
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
    g.gain.value = vol;
    src.connect(g);
    g.connect(this.dest);
    g.connect(this.recMix);
    g.connect(ac.destination);
    this.bgm = { src, g };
  }
  setBgmVolume(vol) { if (this.bgm) this.bgm.g.gain.setTargetAtTime(vol, this.ac.currentTime, 0.03); }
  stopBgm() {
    if (!this.bgm) return;
    try { this.bgm.src.disconnect(); this.bgm.g.disconnect(); } catch (e) { /* なし */ }
    this.bgm = null;
  }

  close() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.engine) this.engine.destroy();
    if (this.ac) this.ac.close().catch(() => {});
  }
}
