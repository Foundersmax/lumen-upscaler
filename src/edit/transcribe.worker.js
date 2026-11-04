// Speech-to-text worker: runs Whisper on-device (WebGPU when available, else WebAssembly)
// and streams word-level timestamps back as each ~30 s window finishes.
//
// in:  { type: "run", audio: Float32Array (16 kHz mono), size: "tiny"|"base"|"small", language: string|null }
// out: { type: "status", text } | { type: "download", loaded, total } | { type: "words", words, progress }
//      | { type: "done", device, model } | { type: "error", message }
import { pipeline, env } from "../../vendor/transformers.min.js";

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("../../vendor/ort/", import.meta.url).href;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

const RATE = 16000;
const post = (m) => self.postMessage(m);

async function hasWebGPU() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

/** Model/dtype candidates in order of preference. The "_timestamped" exports carry the attention
 *  outputs needed for word-level timestamps; plain exports are the fallback. */
function candidates(size, device) {
  return device === "webgpu"
    ? [
        { id: `onnx-community/whisper-${size}_timestamped`, dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } },
        { id: `onnx-community/whisper-${size}_timestamped`, dtype: "fp32" },
        { id: `Xenova/whisper-${size}`, dtype: "fp32" },
      ]
    : [
        { id: `onnx-community/whisper-${size}_timestamped`, dtype: "q8" },
        { id: `Xenova/whisper-${size}`, dtype: "q8" },
      ];
}

let cached = null; // { key, asr, device, model }

async function load(size) {
  const devices = (await hasWebGPU()) ? ["webgpu", "wasm"] : ["wasm"];
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === "progress" && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0; for (const [l, t] of files.values()) { loaded += l; total += t; }
      post({ type: "download", loaded, total });
    } else if (p.status === "ready") post({ type: "status", text: "Model ready" });
  };
  let lastErr;
  for (const device of devices) {
    for (const c of candidates(size, device)) {
      const key = `${c.id}|${device}|${JSON.stringify(c.dtype)}`;
      if (cached?.key === key) return cached;
      try {
        post({ type: "status", text: `Loading speech model (${device === "webgpu" ? "GPU" : "CPU"})…` });
        const asr = await pipeline("automatic-speech-recognition", c.id, { device, dtype: c.dtype, progress_callback });
        try { await cached?.asr?.dispose?.(); } catch {}
        cached = { key, asr, device, model: c.id };
        return cached;
      } catch (e) { lastErr = e; console.warn("model load failed", key, e); }
    }
  }
  throw new Error(`Couldn't load the speech model. Check your connection and try again. (${lastErr?.message || lastErr})`);
}

/** Splits audio into ≤30 s windows, cutting at the quietest 100 ms between 22 and 29.5 s. */
function windows(audio) {
  const out = [], hop = RATE / 10;
  let start = 0;
  while (start < audio.length) {
    if (audio.length - start <= 30 * RATE) { out.push([start, audio.length]); break; }
    let best = start + 29.5 * RATE, bestE = Infinity;
    for (let p = start + 22 * RATE; p + hop <= start + 29.5 * RATE; p += hop) {
      let e = 0; for (let i = p; i < p + hop; i += 2) e += audio[i] * audio[i];
      if (e < bestE) { bestE = e; best = p + hop / 2; }
    }
    best = Math.floor(best);
    out.push([start, best]); start = best;
  }
  return out;
}

const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length / 4)); };

/** Even word timings inside a segment, used when word-level alignment isn't available. */
function spreadWords(text, s, e) {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  const total = toks.reduce((n, t) => n + t.length + 1, 0) || 1;
  let t = s; const out = [];
  for (const tok of toks) { const d = (e - s) * (tok.length + 1) / total; out.push({ t: tok, s: t, e: t + d }); t += d; }
  return out;
}

async function transcribeWindow(model, chunk, offset, language) {
  const opts = { language: language || null, task: "transcribe" };
  try {
    const r = await model.asr(chunk, { ...opts, return_timestamps: "word" });
    return (r.chunks || []).map((c) => ({ t: c.text, s: (c.timestamp?.[0] ?? 0) + offset, e: (c.timestamp?.[1] ?? (c.timestamp?.[0] ?? 0) + 0.3) + offset }));
  } catch (e) {
    console.warn("word timestamps failed, using segment timestamps", e);
    const r = await model.asr(chunk, { ...opts, return_timestamps: true });
    const len = chunk.length / RATE;
    return (r.chunks || [{ text: r.text, timestamp: [0, len] }])
      .flatMap((c) => spreadWords(c.text, (c.timestamp?.[0] ?? 0) + offset, (c.timestamp?.[1] ?? len) + offset));
  }
}

self.onmessage = async ({ data }) => {
  if (data?.type !== "run") return;
  try {
    const { audio, size, language } = data;
    let model = await load(size);
    const wins = windows(audio);
    post({ type: "status", text: "Transcribing…" });
    for (let i = 0; i < wins.length; i++) {
      const [a, b] = wins[i];
      const chunk = audio.subarray(a, b);
      let words = [];
      if (rms(chunk) > 0.003) { // skip near-silent windows; Whisper invents text on silence
        try { words = await transcribeWindow(model, chunk, a / RATE, language); }
        catch (e) {
          if (model.device !== "webgpu") throw e;
          console.warn("GPU inference failed, retrying on CPU", e);
          cached = null; model = await loadOn("wasm", size);
          words = await transcribeWindow(model, chunk, a / RATE, language);
        }
      }
      post({ type: "words", words, progress: b / audio.length });
    }
    post({ type: "done", device: model.device, model: model.model });
  } catch (e) {
    post({ type: "error", message: e?.message || String(e) });
  }
};

async function loadOn(device, size) {
  for (const c of candidates(size, device)) {
    try {
      const asr = await pipeline("automatic-speech-recognition", c.id, { device, dtype: c.dtype });
      cached = { key: `${c.id}|${device}|${JSON.stringify(c.dtype)}`, asr, device, model: c.id };
      return cached;
    } catch (e) { console.warn(e); }
  }
  throw new Error("Couldn't load the speech model on the CPU either.");
}
