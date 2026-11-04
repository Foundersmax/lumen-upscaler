// Audio enhancement: whole-file analysis (noise profile + loudness) and the gains the chain needs.
//   pass 1 ("base", independent of settings): noise profile and original loudness
//   pass 2 (per noise/tone setting): loudness after the chain, so export hits the target exactly
import { AudioBufferSink } from "../../vendor/mediabunny.min.mjs";
import { NoiseProfiler, LoudnessMeter, VoiceChain, preGainFor, postGainFor, LOUDNESS_TARGETS } from "../audio/dsp.js";

/** Copies an AudioBuffer into ≤2 planar channels (surround is folded down to stereo). */
export function toPlanar(buffer, from = 0, to = buffer.length) {
  const n = to - from, ch = buffer.numberOfChannels;
  if (ch <= 2) return Array.from({ length: ch }, (_, c) => buffer.getChannelData(c).slice(from, to));
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c), dst = c % 2 ? R : L; for (let i = 0; i < n; i++) dst[i] += d[from + i] * (2 / ch); }
  return [L, R];
}

async function scan(track, duration, onBlock, onProgress, signal) {
  const sink = new AudioBufferSink(track);
  let last = performance.now();
  for await (const { buffer, timestamp } of sink.buffers(0, duration)) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    onBlock(buffer);
    if (performance.now() - last > 40) { onProgress?.(Math.min(1, (timestamp + buffer.duration) / duration)); await new Promise((r) => setTimeout(r)); last = performance.now(); }
  }
  onProgress?.(1);
}

/** Pass 1. @returns {{profile, rawLufs:number, sr:number, channels:number, peaks:Float32Array}} */
export async function analyzeBase(track, duration, onProgress, signal) {
  let prof = null, meter = null, sr = 0, channels = 0;
  const BINS = 1200, pk = new Float32Array(BINS);
  let t = 0;
  await scan(track, duration, (buffer) => {
    if (!prof) { sr = buffer.sampleRate; channels = Math.min(2, buffer.numberOfChannels); prof = new NoiseProfiler(sr, channels); meter = new LoudnessMeter(sr, channels); }
    const chans = toPlanar(buffer);
    for (let i = 0; i < buffer.length; i += 8) { // waveform envelope for the timeline
      const b = Math.min(BINS - 1, Math.floor(((t + i / sr) / duration) * BINS));
      for (const x of chans) { const v = Math.abs(x[i]); if (v > pk[b]) pk[b] = v; }
    }
    t += buffer.length / sr;
    prof.process(chans, buffer.length); meter.process(chans, buffer.length);
  }, onProgress, signal);
  if (!prof) throw new Error("This video's audio track is empty.");
  let max = 1e-4; for (const v of pk) if (v > max) max = v;
  for (let b = 0; b < BINS; b++) pk[b] = Math.sqrt(pk[b] / max);
  return { profile: prof.result(), rawLufs: meter.lufs(), sr, channels, peaks: pk };
}

/** Pass 2: loudness of the chain output (before the final gain and limiter). */
export async function analyzeChain(track, duration, base, settings, onProgress, signal) {
  const pre = preGainFor(base.rawLufs);
  let chain = null, meter = null;
  await scan(track, duration, (buffer) => {
    const chans = toPlanar(buffer);
    if (!chain) { chain = new VoiceChain({ sr: buffer.sampleRate, channels: chans.length, settings, profile: base.profile, preGainDb: pre, postGainDb: 0, limit: false }); meter = new LoudnessMeter(buffer.sampleRate, chans.length); }
    chain.process(chans, buffer.length); meter.process(chans, buffer.length);
  }, onProgress, signal);
  return meter ? meter.lufs() : -Infinity;
}

export const chainKey = (s) => `${s.noise}|${s.tone}`;

/** Final gains for a setting, given both analyses. */
export function gainsFor(base, chainLufs, settings) {
  const pre = preGainFor(base.rawLufs);
  const target = LOUDNESS_TARGETS[settings.loudness] ?? null;
  return { pre, post: postGainFor(target, base.rawLufs, chainLufs), target };
}
