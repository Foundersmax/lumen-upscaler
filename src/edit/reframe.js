// Reframe: crop to vertical/square and keep the speaker in frame.
// Faces are found on-device with MediaPipe's BlazeFace model, then turned into a smooth
// "camera operator" path: steady when the subject is still, easing when they move, cutting
// instantly on scene changes.
import { CanvasSink } from "../../vendor/mediabunny.min.mjs";
import { FaceDetector, FilesetResolver } from "../../vendor/mediapipe/vision_bundle.mjs";
import { even } from "../engine/media.js";

export const ASPECTS = { orig: null, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };
export const DEFAULT_REFRAME = { aspect: "orig", follow: "face", offset: 0.5 };
const STEP = 0.2; // seconds between face samples

/** Crop size as fractions of the source frame, and which axis is free to pan. */
export function cropGeometry(srcW, srcH, aspectKey) {
  const a = ASPECTS[aspectKey];
  if (!a) return { w: 1, h: 1, axis: null };
  if (srcW / srcH > a) return { w: (srcH * a) / srcW, h: 1, axis: "x" };
  return { w: 1, h: srcW / a / srcH, axis: "y" };
}

/** Output pixel size for an aspect and size preset ("orig" | "1080" | "1440" | "2160"). */
export function reframeSize(srcW, srcH, aspectKey, res) {
  const g = cropGeometry(srcW, srcH, aspectKey), a = ASPECTS[aspectKey];
  const cw = g.w * srcW, ch = g.h * srcH;
  if (res === "orig") return [even(cw), even(ch)];
  const short = +res;
  return cw <= ch ? [even(short), even(short / a)] : [even(short * a), even(short)];
}
/** Short side of the crop in source pixels (to stop presets that would shrink the video). */
export function cropShortSide(srcW, srcH, aspectKey) { const g = cropGeometry(srcW, srcH, aspectKey); return Math.min(g.w * srcW, g.h * srcH); }

/* ------------------------------------------------------------ detection */
let detectorP = null;
function getDetector() {
  detectorP ||= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(new URL("../../vendor/mediapipe/wasm", import.meta.url).href);
    const modelAssetPath = new URL("../../vendor/mediapipe/blaze_face_full_range.tflite", import.meta.url).href;
    let lastErr;
    // CPU (XNNPACK) first: the model is tiny, and it proved more reliable than the GPU delegate
    for (const delegate of ["CPU", "GPU"]) {
      try { return await FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath, delegate }, runningMode: "IMAGE", minDetectionConfidence: 0.4 }); }
      catch (e) { lastErr = e; console.warn(`face detector (${delegate}) unavailable`, e); }
    }
    throw new Error("Face detection isn't available in this browser. " + (lastErr?.message || ""));
  })();
  detectorP.catch(() => { detectorP = null; });
  return detectorP;
}

const boxes = (r, ox, oy, sw, sh, W, H) => (r.detections || []).filter((d) => d.boundingBox).map((d) => {
  const b = d.boundingBox;
  return { x: (ox + ((b.originX + b.width / 2) / sw) * sw) / W, y: (oy + ((b.originY + b.height / 2) / sh) * sh) / H, w: b.width / W, h: b.height / H, s: d.categories?.[0]?.score ?? 1 };
});
let tile = null;
/**
 * Normalised face boxes (centre x/y, width/height as fractions) for one frame canvas. If the whole
 * frame finds nothing, three overlapping square tiles are tried: small faces in wide shots are
 * easier to see when the model's input covers less of the frame.
 */
function detect(det, canvas) {
  const W = canvas.width, H = canvas.height;
  let out = boxes(det.detect(canvas), 0, 0, W, H, W, H);
  if (out.length || W <= H * 1.2) return out;
  const side = H; tile ||= new OffscreenCanvas(side, side);
  if (tile.width !== side) { tile.width = side; tile.height = side; }
  const g = tile.getContext("2d");
  for (const ox of [0, (W - side) / 2, W - side]) {
    g.drawImage(canvas, ox, 0, side, side, 0, 0, side, side);
    out = out.concat(boxes(det.detect(tile), ox, 0, side, side, W, H));
  }
  // merge duplicates found in overlapping tiles
  const merged = [];
  for (const f of out.sort((a, b) => b.s - a.s)) if (!merged.some((m) => Math.hypot(m.x - f.x, m.y - f.y) < Math.max(m.w, f.w))) merged.push(f);
  return merged;
}

/**
 * Samples the video every 0.2 s and finds faces. Scene cuts are then refined to 50 ms.
 * @returns {Promise<{t:number, faces:{x,y,w,h,s}[]}[]>}
 */
export async function trackFaces(track, duration, onProgress, signal) {
  const det = await getDetector();
  const sink = new CanvasSink(track, { width: 640, poolSize: 2 });
  const times = []; for (let t = 0; t < duration; t += STEP) times.push(+t.toFixed(3));
  const samples = [];
  let i = 0, last = performance.now();
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const t = times[i++];
    samples.push({ t, faces: wc ? detect(det, wc.canvas) : [] });
    if (performance.now() - last > 60) { onProgress?.(i / times.length); await new Promise((r) => setTimeout(r)); last = performance.now(); }
  }
  // refine scene cuts: where the main subject jumps, look at 50 ms steps in between
  const extra = [];
  for (let k = 1; k < samples.length; k++) {
    const a = mainFace(samples[k - 1].faces), b = mainFace(samples[k].faces);
    if (a && b && Math.hypot(a.x - b.x, a.y - b.y) > 0.25) {
      const between = [0.05, 0.1, 0.15].map((d) => +(samples[k - 1].t + d).toFixed(3));
      let j = 0;
      for await (const wc of sink.canvasesAtTimestamps(between)) extra.push({ t: between[j++], faces: wc ? detect(det, wc.canvas) : [] });
    }
  }
  onProgress?.(1);
  return samples.concat(extra).sort((p, q) => p.t - q.t);
}

const mainFace = (faces, prev) => {
  if (!faces.length) return null;
  let best = faces[0], score = -1;
  for (const f of faces) {
    let v = f.w * f.h * f.s; // the largest, most confident face is usually the speaker
    if (prev && Math.hypot(f.x - prev.x, f.y - prev.y) < 0.12) v *= 1.6; // prefer staying on the same person
    if (v > score) { score = v; best = f; }
  }
  return best;
};

/* ---------------------------------------------------------------- path */
/**
 * Turns face samples into a crop path along the free axis.
 * @returns {{axis, frac, keys:{t:number,c:number,cut?:boolean}[], coverage:number}}
 */
export function buildPath(samples, srcW, srcH, aspectKey) {
  const g = cropGeometry(srcW, srcH, aspectKey);
  if (!g.axis) return { axis: null, frac: 1, keys: [], coverage: 0 };
  const frac = g.axis === "x" ? g.w : g.h, half = frac / 2;
  const clamp = (c) => Math.min(1 - half, Math.max(half, c));
  // 1. pick the subject in each sample
  let prev = null, found = 0;
  const raw = samples.map((s) => {
    const f = mainFace(s.faces, prev);
    if (f) { prev = f; found++; return { t: s.t, c: g.axis === "x" ? f.x : f.y + f.h * 0.15 }; } // a little headroom when panning vertically
    return { t: s.t, c: null };
  });
  if (!found) return { axis: g.axis, frac, keys: [{ t: 0, c: 0.5 }], coverage: 0 };
  // 2. fill gaps by holding the last position (or the first one at the start)
  let lastC = raw.find((r) => r.c !== null).c;
  for (const r of raw) { if (r.c === null) r.c = lastC; else lastC = r.c; }
  // 3. split into shots at jumps, smooth each shot with a zero-phase filter, then a small dead zone
  const keys = [];
  let start = 0;
  const flushShot = (a, b) => {
    const seg = raw.slice(a, b), n = seg.length;
    const k = 1 - Math.exp(-STEP / 0.35); // ~0.35 s time constant
    const fwd = new Float64Array(n), out = new Float64Array(n);
    fwd[0] = seg[0].c; for (let i = 1; i < n; i++) fwd[i] = fwd[i - 1] + k * (seg[i].c - fwd[i - 1]);
    out[n - 1] = fwd[n - 1]; for (let i = n - 2; i >= 0; i--) out[i] = out[i + 1] + k * (fwd[i] - out[i + 1]);
    // Camera operator: hold perfectly still until the subject leaves a dead zone, then follow the
    // smoothed path until it has caught up with the subject, then lock off again.
    const dz = frac * 0.05;
    let cam = out[0], moving = false;
    for (let i = 0; i < n; i++) {
      if (!moving && Math.abs(out[i] - cam) > dz) moving = true;
      if (moving) {
        cam = out[i];
        const settled = Math.abs(out[i] - seg[i].c) < dz * 0.25 && (i === 0 || Math.abs(out[i] - out[i - 1]) < dz * 0.05);
        if (settled) moving = false;
      }
      keys.push({ t: seg[i].t, c: clamp(cam), cut: i === 0 && a > 0 });
    }
  };
  for (let i = 1; i < raw.length; i++) if (Math.abs(raw[i].c - raw[i - 1].c) > 0.25) { flushShot(start, i); start = i; }
  flushShot(start, raw.length);
  return { axis: g.axis, frac, keys, coverage: found / samples.length };
}

/** Crop centre at time t (holds across cuts instead of panning through them). */
export function centerAt(path, t) {
  const k = path.keys;
  if (!k.length) return 0.5;
  if (t <= k[0].t) return k[0].c;
  let lo = 0, hi = k.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (k[m].t <= t) lo = m; else hi = m - 1; }
  const a = k[lo], b = k[lo + 1];
  if (!b) return a.c;
  if (b.cut) return a.c;
  return a.c + ((t - a.t) / (b.t - a.t)) * (b.c - a.c);
}

/** Normalised crop rectangle [x, y, w, h] at source time t. */
export function cropAt(settings, path, srcW, srcH, t) {
  const g = cropGeometry(srcW, srcH, settings.aspect);
  if (!g.axis) return [0, 0, 1, 1];
  const frac = g.axis === "x" ? g.w : g.h, half = frac / 2;
  const c = Math.min(1 - half, Math.max(half, settings.follow === "face" && path?.keys.length ? centerAt(path, t) : settings.offset));
  return g.axis === "x" ? [c - half, 0, g.w, 1] : [0, c - half, 1, g.h];
}
