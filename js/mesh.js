// WebRTC のメッシュ（全員と1本ずつつなぐ）。つなぎ役との伝言は sendSignal / handleSignal で受け渡す。
// 申し込みのぶつかりは「perfect negotiation」の手順でさばく（id の大きいほうが譲る）。
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

class Peer {
  constructor(mesh, peerId) {
    this.mesh = mesh;
    this.id = peerId;
    this.polite = mesh.myId > peerId;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.pendingCands = [];
    const pc = this.pc = new RTCPeerConnection({ iceServers: ICE });
    // 両側で同じ番号の通り道を作る（申し込みの順番に関係なくつながる）
    this.dc = pc.createDataChannel('ck', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    this.cc = pc.createDataChannel('ck-r', { negotiated: true, id: 1, ordered: true });
    [this.dc, this.cc].forEach((ch) => {
      ch.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } mesh.h.onData(peerId, m); };
      ch.onopen = () => { if (ch === this.cc) mesh.h.onOpen(peerId); };
    });
    if (mesh.audioTrack) this.audioSender = pc.addTrack(mesh.audioTrack, mesh.audioStream);
    if (mesh.shareTrack) this.shareSender = pc.addTrack(mesh.shareTrack, mesh.shareStream);
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        mesh.sendSignal(peerId, { desc: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      } catch (e) {
        console.warn('[キャラ会議] 申し込みを作れませんでした', e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) mesh.sendSignal(peerId, { cand: candidate.toJSON() });
    };
    pc.ontrack = (ev) => mesh.h.onTrack(peerId, ev.track, ev.streams[0] || new MediaStream([ev.track]));
    pc.onconnectionstatechange = () => {
      mesh.h.onState(peerId, pc.connectionState);
      if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch (e) { /* なし */ } }
    };
  }

  async handle(msg) {
    const pc = this.pc;
    try {
      if (msg.desc) {
        const desc = msg.desc;
        const collision = desc.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        const cands = this.pendingCands.splice(0);
        for (const c of cands) await pc.addIceCandidate(c).catch(() => {});
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          this.mesh.sendSignal(this.id, { desc: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        }
      } else if (msg.cand) {
        if (!pc.remoteDescription) { this.pendingCands.push(msg.cand); return; }
        try { await pc.addIceCandidate(msg.cand); } catch (e) { if (!this.ignoreOffer) throw e; }
      }
    } catch (e) {
      console.warn('[キャラ会議] つなぐ手続きでつまずきました', e);
    }
  }

  send(obj, reliable) {
    const ch = reliable ? this.cc : this.dc;
    if (ch.readyState === 'open') { try { ch.send(JSON.stringify(obj)); } catch (e) { /* なし */ } }
  }

  close() { try { this.pc.close(); } catch (e) { /* なし */ } }
}

export class Mesh {
  // handlers: { onData(id, msg), onTrack(id, track, stream), onOpen(id), onState(id, state) }
  constructor(myId, sendSignal, handlers) {
    this.myId = myId;
    this.sendSignal = sendSignal;
    this.h = handlers;
    this.peers = new Map();
    this.audioTrack = null; this.audioStream = null;
    this.shareTrack = null; this.shareStream = null;
  }
  setAudio(track) { this.audioTrack = track; this.audioStream = new MediaStream([track]); }

  // 今いる人の一覧に合わせて、つなぐ・切る
  sync(ids) {
    const want = new Set(ids.filter((id) => id !== this.myId));
    want.forEach((id) => { if (!this.peers.has(id)) this.peers.set(id, new Peer(this, id)); });
    Array.from(this.peers.keys()).forEach((id) => { if (!want.has(id)) this.drop(id); });
  }
  drop(id) {
    const p = this.peers.get(id);
    if (p) { p.close(); this.peers.delete(id); }
  }
  handleSignal(from, msg) {
    let p = this.peers.get(from);
    if (!p) { p = new Peer(this, from); this.peers.set(from, p); }
    p.handle(msg);
  }
  broadcast(obj, reliable) { this.peers.forEach((p) => p.send(obj, reliable)); }
  sendTo(id, obj, reliable) { const p = this.peers.get(id); if (p) p.send(obj, reliable); }

  startShare(track, stream) {
    this.shareTrack = track; this.shareStream = stream;
    this.peers.forEach((p) => { if (!p.shareSender) p.shareSender = p.pc.addTrack(track, stream); });
  }
  stopShare() {
    this.shareTrack = null; this.shareStream = null;
    this.peers.forEach((p) => {
      if (p.shareSender) { try { p.pc.removeTrack(p.shareSender); } catch (e) { /* なし */ } p.shareSender = null; }
    });
  }
  closeAll() { this.peers.forEach((p) => p.close()); this.peers.clear(); }
}
