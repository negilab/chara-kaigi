// 顔の読み取り（自分の PC の中だけで動く。カメラの映像はどこにも送らない）
// 拡張機能の face-frame.js をもとに、ページの中で直接動かす形にしたもの。
import { FilesetResolver, FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const absUrl = (p) => new URL(p, import.meta.url).href;
let landmarker = null;
let initing = null;
let lastTs = 0;

async function create(delegate) {
  const fileset = await FilesetResolver.forVisionTasks(absUrl('../vendor/mediapipe/wasm'));
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: absUrl('../vendor/mediapipe/face_landmarker.task'), delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true
  });
}

export function initFace() {
  if (!initing) {
    initing = create('GPU').catch((e) => {
      console.warn('[キャラ会議] GPU で顔の読み取りを始められないため、CPU で始めます', e);
      return create('CPU');
    }).then((lm) => { landmarker = lm; return true; })
      .catch((e) => { console.warn('[キャラ会議] 顔の読み取りを始められませんでした', e); return false; });
  }
  return initing;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// 4×4 の行列から頭の向き（ラジアン）
function poseFromMatrix(data) {
  if (!data || data.length < 16) return null;
  const colMajor = Math.abs(data[14]) >= Math.abs(data[11]);
  const m = (r, c) => (colMajor ? data[c * 4 + r] : data[r * 4 + c]);
  const sx = Math.hypot(m(0, 0), m(1, 0), m(2, 0)) || 1;
  const sy = Math.hypot(m(0, 1), m(1, 1), m(2, 1)) || 1;
  const sz = Math.hypot(m(0, 2), m(1, 2), m(2, 2)) || 1;
  return {
    yaw: Math.asin(clamp(-m(2, 0) / sx, -1, 1)),
    pitch: Math.atan2(m(2, 1) / sy, m(2, 2) / sz),
    roll: Math.atan2(m(1, 0) / sx, m(0, 0) / sx)
  };
}

// 縮めた1コマ（canvas）から、瞬き・頭の向きを読む
export function detectFace(source) {
  if (!landmarker) return null;
  const t0 = performance.now();
  const ts = Math.max(lastTs + 1, Math.round(t0));
  lastTs = ts;
  const out = { found: false };
  try {
    const r = landmarker.detectForVideo(source, ts);
    if (r && r.faceLandmarks && r.faceLandmarks.length) {
      out.found = true;
      const bs = r.faceBlendshapes && r.faceBlendshapes[0] && r.faceBlendshapes[0].categories;
      if (bs) {
        let l = 0, rr = 0;
        for (const c of bs) {
          if (c.categoryName === 'eyeBlinkLeft') l = c.score;
          else if (c.categoryName === 'eyeBlinkRight') rr = c.score;
        }
        out.blink = (l + rr) / 2;
      }
      const mx = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
      const p = mx && poseFromMatrix(mx.data);
      if (p) Object.assign(out, p);
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}
