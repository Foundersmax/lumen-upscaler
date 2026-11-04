// Decodes a track's audio into 16 kHz mono Float32 (what Whisper expects), streaming so memory
// stays at the output size, plus a peak summary for drawing the waveform.
import { AudioBufferSink } from "../../vendor/mediabunny.min.mjs";

export const ASR_RATE = 16000;

/**
 * @param {import("../../vendor/mediabunny.min.mjs").InputAudioTrack} track
 * @param {number} duration seconds
 * @param {(p:number)=>void} onProgress 0..1
 * @param {AbortSignal} [signal]
 */
export async function extractAudio16k(track, duration, onProgress, signal) {
  const out = new Float32Array(Math.ceil(duration * ASR_RATE) + ASR_RATE);
  let binO = -1, binSum = 0, binN = 0;
  const flush = () => { if (binO >= 0 && binO < out.length && binN) out[binO] = binSum / binN; };
  const sink = new AudioBufferSink(track);
  let lastYield = performance.now();
  for await (const { buffer, timestamp } of sink.buffers(0, duration)) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const sr = buffer.sampleRate, ch = buffer.numberOfChannels, len = buffer.length;
    const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
    const ratio = ASR_RATE / sr, base = Math.round(timestamp * sr);
    for (let i = 0; i < len; i++) {
      let v = 0; for (let c = 0; c < ch; c++) v += chans[c][i];
      v /= ch;
      const o0 = Math.floor((base + i) * ratio);
      if (ratio <= 1) { // downsample: box-average every source sample into its output bin
        if (o0 !== binO) { flush(); binO = o0; binSum = 0; binN = 0; }
        binSum += v; binN++;
      } else { // upsample (rare, e.g. 8 kHz): hold the value across the bins it covers
        const o1 = Math.max(o0 + 1, Math.floor((base + i + 1) * ratio));
        for (let o = Math.max(0, o0); o < o1 && o < out.length; o++) out[o] = v;
      }
    }
    if (performance.now() - lastYield > 40) { onProgress?.(Math.min(1, (timestamp + buffer.duration) / duration)); await new Promise((r) => setTimeout(r)); lastYield = performance.now(); }
  }
  flush();
  onProgress?.(1);
  return out.subarray(0, Math.ceil(duration * ASR_RATE));
}

/** Peak envelope (0..1) in `bins` buckets, for the timeline waveform. */
export function peaks(audio, bins = 1200) {
  const out = new Float32Array(bins), step = audio.length / bins;
  let max = 1e-4;
  for (let b = 0; b < bins; b++) {
    let p = 0; const a = Math.floor(b * step), z = Math.min(audio.length, Math.floor((b + 1) * step));
    for (let i = a; i < z; i += 4) { const v = Math.abs(audio[i]); if (v > p) p = v; }
    out[b] = p; if (p > max) max = p;
  }
  for (let b = 0; b < bins; b++) out[b] = Math.sqrt(out[b] / max); // perceptual-ish scaling
  return out;
}
