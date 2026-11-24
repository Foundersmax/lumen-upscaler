// Voice fingerprints: runs a speaker-embedding model (WeSpeaker ResNet34, 8-bit, ~7 MB) on-device.
//
// in:  { type: "run", audio: Float32Array (16 kHz mono), windows: Float64Array [a0, b0, a1, b1, …] in seconds }
//      { type: "cluster", id, data: Float32Array (n × dim), dim, durs: number[], count: "auto"|number } → { type: "clustered", id, labels }
// out: { type: "status", text } | { type: "download", loaded, total } | { type: "progress", done, total }
//      | { type: "done", dim, data: Float32Array (windows × dim, unit vectors), device } | { type: "error", message }
import { AutoProcessor, AutoModel, env } from "../../vendor/transformers.min.js";
import { clusterSpeakers } from "./speakers.js";

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("../../vendor/ort/", import.meta.url).href;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

const MODEL = "onnx-community/wespeaker-voxceleb-resnet34-LM";
const RATE = 16000;
const post = (m, t) => self.postMessage(m, t || []);
let cached = null;
let cancel = false;

async function hasWebGPU() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

async function load() {
  if (cached) return cached;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === "progress" && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0; for (const [l, t] of files.values()) { loaded += l; total += t; }
      post({ type: "download", loaded, total });
    }
  };
  post({ type: "status", text: "Loading voice model…" });
  const processor = await AutoProcessor.from_pretrained(MODEL, { progress_callback });
  let lastErr;
  for (const [device, dtype] of [...((await hasWebGPU()) ? [["webgpu", "fp32"]] : []), ["wasm", "q8"]]) {
    try {
      const model = await AutoModel.from_pretrained(MODEL, { device, dtype, progress_callback });
      // a GPU backend that loads but computes garbage is worse than a slow CPU: check one window
      const probe = await embed(processor, model, new Float32Array(RATE).map((_, i) => Math.sin(i / 7) * 0.1));
      if (!probe.every(Number.isFinite)) throw new Error("voice model returned invalid numbers");
      cached = { processor, model, device };
      return cached;
    } catch (e) { lastErr = e; console.warn("voice model failed on", device, e); }
  }
  throw lastErr || new Error("Couldn't load the voice model.");
}

async function embed(processor, model, audio) {
  const inputs = await processor(audio);
  const out = await model(inputs);
  const t = out.last_hidden_state ?? out[Object.keys(out)[0]];
  const v = Float32Array.from(t.data);
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "cancel") { cancel = true; return; }
  if (m.type === "cluster") {
    try {
      const embs = []; for (let k = 0; k < m.durs.length; k++) embs.push(m.data.subarray(k * m.dim, (k + 1) * m.dim));
      post({ type: "clustered", id: m.id, labels: clusterSpeakers(embs, m.durs, m.count) });
    } catch (err) { post({ type: "error", id: m.id, message: String(err?.message || err) }); }
    return;
  }
  if (m.type !== "run") return;
  cancel = false;
  try {
    const { processor, model, device } = await load();
    const { audio, windows } = m, count = windows.length / 2;
    let data = null, dim = 0;
    post({ type: "status", text: "Listening for voices…" });
    for (let k = 0; k < count; k++) {
      if (cancel) { post({ type: "error", message: "cancelled", cancelled: true }); return; }
      const a = Math.max(0, Math.floor(windows[2 * k] * RATE)), b = Math.min(audio.length, Math.ceil(windows[2 * k + 1] * RATE));
      const v = await embed(processor, model, audio.subarray(a, Math.max(b, a + RATE / 4)));
      if (!data) { dim = v.length; data = new Float32Array(count * dim); }
      data.set(v, k * dim);
      if (k % 4 === 3 || k === count - 1) post({ type: "progress", done: k + 1, total: count });
    }
    post({ type: "done", dim, data: data || new Float32Array(0), device }, data ? [data.buffer] : []);
  } catch (err) {
    post({ type: "error", message: String(err?.message || err) });
  }
};
