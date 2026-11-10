// Renders the edit: concatenates the kept time ranges into a new file, re-timing video and audio,
// with short audio fades at each cut and optional GPU upscaling.
import {
  Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, WebMOutputFormat, StreamTarget,
  VideoSampleSink, AudioBufferSink, VideoSampleSource, AudioSampleSource, VideoSample, AudioSample,
  getFirstEncodableAudioCodec,
} from "../../vendor/mediabunny.min.mjs";
import { Upscaler, IDENTITY, FIX_601 } from "../engine/upscaler.js";
import { BlobSink } from "../engine/blobsink.js";
import { encodableCodecs, friendly, videoBitrate } from "../engine/media.js";
import { VoiceChain } from "../audio/dsp.js";
import { toPlanar } from "./enhance.js";

const FADE = 0.006; // seconds of fade at each cut edge, removes clicks

/** Rounds range edges to whole frames and drops ranges that become empty. */
export function snapRanges(ranges, fps) {
  const out = [];
  for (const [a, b] of ranges) {
    const a2 = Math.round(a * fps) / fps, b2 = Math.round(b * fps) / fps;
    if (b2 - a2 < 0.5 / fps) continue;
    if (out.length && a2 <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b2);
    else out.push([a2, b2]);
  }
  return out;
}

export class ExportCancelled extends Error { constructor() { super("Export cancelled"); this.name = "ExportCancelled"; } }

/**
 * @param {object} o
 * @param {File} o.file
 * @param {[number, number][]} o.ranges kept source ranges, sorted, non-overlapping
 * @param {"mp4"|"webm"} o.fmt
 * @param {number} o.ow output width  @param {number} o.oh output height
 * @param {any} o.quality mediabunny Quality
 * @param {number} o.sharp 0..1 sharpening
 * @param {boolean} o.colorFix apply BT.601 fix for untagged SD sources
 * @param {(p:number, info:{frames:number})=>void} o.onProgress
 * @param {AbortSignal} o.signal
 * @param {(t:number) => number[]} [o.cropAt] source crop [x,y,w,h] (normalised) for the frame at source time t
 * @param {{settings, profile, pre:number, post:number}} [o.audioFx] voice enhancement (see enhance.js)
 * @param {(ranges:[number,number][]) => ((ctx, t:number, w:number, h:number) => void) | null} [o.overlay]
 *   called with the final (frame-snapped) ranges; returns a function that draws on each output frame
 * @returns {Promise<{blob: Blob, codec: string, audio: string|null, audioNote: string}>}
 */
export async function exportEdit(o) {
  const codecs = await encodableCodecs(o.fmt, o.ow, o.oh, o.quality);
  if (!codecs.length) throw new Error(`Your browser can't encode ${o.ow}×${o.oh} video as ${o.fmt.toUpperCase()}. Try the other format or a smaller size.`);
  const plan = codecs.flatMap((codec) => [{ codec, hw: "no-preference" }, { codec, hw: "prefer-software" }]);
  let lastErr;
  for (const step of plan) {
    if (o.signal.aborted) throw new ExportCancelled();
    try { return await attempt(o, step); }
    catch (e) {
      if (e instanceof ExportCancelled || o.signal.aborted) throw new ExportCancelled();
      if (e.fatal) throw e;
      console.warn(`export attempt ${step.codec}/${step.hw} failed`, e);
      lastErr = e;
    }
  }
  throw new Error(friendly(lastErr));
}

async function attempt(o, { codec, hw }) {
  const input = new Input({ source: new BlobSource(o.file), formats: ALL_FORMATS });
  const gpu = new Upscaler(new OffscreenCanvas(o.ow, o.oh));
  gpu.cm = o.colorFix ? FIX_601 : IDENTITY;
  const sink = new BlobSink();
  const format = o.fmt === "mp4" ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat();
  const output = new Output({ format, target: new StreamTarget(sink.writable(), { chunked: true, chunkSize: 8 * 1024 * 1024 }) });
  let started = false;
  try {
    const vtrack = await input.getPrimaryVideoTrack();
    if (!vtrack) throw Object.assign(new Error("This file has no video track."), { fatal: true });
    const atrack = await input.getPrimaryAudioTrack();

    const fps = (await vtrack.computePacketStats(120).catch(() => null))?.averagePacketRate || 0;
    const vsrc = new VideoSampleSource({ codec, bitrate: videoBitrate(codec, o.ow, o.oh, fps, o.qualityKey || "high"), hardwareAcceleration: hw, keyFrameInterval: 2 });
    output.addVideoTrack(vsrc);

    let asrc = null, audioCodec = null, audioNote = "";
    if (atrack && (await atrack.canDecode())) {
      const nch = Math.min(2, atrack.numberOfChannels);
      for (const sampleRate of [atrack.sampleRate, 48000, 44100]) {
        audioCodec = await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), { numberOfChannels: nch, sampleRate });
        if (audioCodec) {
          asrc = new AudioSampleSource({ codec: audioCodec, quality: o.quality, transform: { numberOfChannels: nch, sampleRate } });
          output.addAudioTrack(asrc);
          break;
        }
      }
      if (!asrc) audioNote = `This browser can't encode audio for ${o.fmt.toUpperCase()}, so the export is silent. Try the other format.`;
    } else if (atrack) audioNote = "This browser can't decode the audio track, so the export is silent.";

    await output.start(); started = true;

    // Snap cut points to the source frame grid so the output keeps a constant frame rate.
    const ranges = fps >= 10 && fps <= 121 ? snapRanges(o.ranges, fps) : o.ranges;
    if (!ranges.length) throw Object.assign(new Error("Nothing to export: every part of the video is cut."), { fatal: true });
    const total = ranges.reduce((s, [a, b]) => s + (b - a), 0);
    const drawOverlay = o.overlay?.(ranges) || null;
    const comp = drawOverlay ? new OffscreenCanvas(o.ow, o.oh) : null;
    const compCtx = comp?.getContext("2d", { alpha: false });
    let frames = 0, videoDone = 0;
    const check = () => { if (o.signal.aborted) throw new ExportCancelled(); };

    const videoLoop = async () => {
      const vsink = new VideoSampleSink(vtrack);
      let rot = null, offset = 0, last = -1;
      for (const [a, b] of ranges) {
        for await (const s of vsink.samples(a, b)) {
          try {
            check();
            const start = Math.max(s.timestamp, a), end = Math.min(s.timestamp + s.duration, b);
            if (end <= start + 1e-4) continue;
            const ts = offset + (start - a);
            if (ts <= last + 1e-5) continue;
            let src = s.toCanvasImageSource(), sw = src.displayWidth ?? src.width, sh = src.displayHeight ?? src.height;
            if (s.rotation) {
              const dw = s.displayWidth, dh = s.displayHeight;
              if (!rot || rot.width !== dw || rot.height !== dh) rot = new OffscreenCanvas(dw, dh);
              const ctx = rot.getContext("2d"); ctx.clearRect(0, 0, dw, dh);
              s.drawWithFit(ctx, { fit: "fill" }); src = rot; sw = dw; sh = dh;
            }
            gpu.render(src, sw, sh, o.ow, o.oh, o.sharp, o.cropAt ? o.cropAt(start) : undefined);
            let frame = gpu.canvas;
            if (drawOverlay) { compCtx.drawImage(gpu.canvas, 0, 0); drawOverlay(compCtx, ts, o.ow, o.oh); frame = comp; }
            const out = new VideoSample(frame, { timestamp: ts, duration: end - start });
            await vsrc.add(out); out.close();
            last = ts; frames++;
            videoDone = offset + (end - a);
            o.onProgress?.(Math.min(1, videoDone / total), { frames });
          } finally { s.close(); }
        }
        offset += b - a;
      }
      vsrc.close();
    };

    const audioLoop = async () => {
      if (!asrc) return;
      const asink = new AudioBufferSink(atrack);
      const fx = o.audioFx || null;
      let offset = 0, written = 0;
      for (const [a, b] of ranges) {
        const segLen = b - a;
        /** Writes planar audio that starts at source time `startT` (already clipped to [a, b]). */
        const emit = async (chans, sr, startT) => {
          const n = chans[0].length, ch = chans.length;
          if (!n) return;
          const data = new Float32Array(ch * n);
          const segPos0 = (startT - a) * sr, segEnd = segLen * sr, F = FADE * sr;
          for (let c = 0; c < ch; c++) {
            const dst = data.subarray(c * n, (c + 1) * n);
            dst.set(chans[c]);
            const inEnd = Math.min(n, Math.ceil(F - segPos0));                 // fade-in at segment start
            for (let j = 0; j < inEnd; j++) dst[j] *= Math.max(0, (segPos0 + j) / F);
            const outStart = Math.max(0, Math.floor(segEnd - F - segPos0));    // fade-out at segment end
            for (let j = outStart; j < n; j++) dst[j] *= Math.max(0, Math.min(1, (segEnd - (segPos0 + j)) / F));
          }
          // keep audio locked to video at every cut: never earlier than the segment's output start
          written = Math.max(written, Math.round(offset * sr));
          const sample = new AudioSample({ data, format: "f32-planar", numberOfChannels: ch, sampleRate: sr, timestamp: written / sr });
          await asrc.add(sample); sample.close();
          written += n;
        };

        if (!fx) {
          for await (const { buffer, timestamp } of asink.buffers(a, b)) {
            check();
            const sr = buffer.sampleRate;
            const i0 = Math.max(0, Math.round((a - timestamp) * sr)), i1 = Math.min(buffer.length, Math.round((b - timestamp) * sr));
            if (i1 > i0) await emit(toPlanar(buffer, i0, i1), sr, timestamp + i0 / sr);
          }
        } else {
          // Voice chain: start 0.5 s early so dynamics settle, and shift by the chain's latency.
          let chain = null, sr = 0, aIdx = 0, bIdx = 0, outEnd = -Infinity, chCount = 1;
          const feed = async (chans, n, inStart) => {
            chain.process(chans, n);
            const oStart = inStart - chain.latency; // chans now hold output for source samples oStart…
            const j0 = Math.max(0, aIdx - oStart), j1 = Math.min(n, bIdx - oStart);
            if (j1 > j0) await emit(chans.map((x) => x.subarray(j0, j1)), sr, (oStart + j0) / sr);
            outEnd = oStart + n;
          };
          let nextIn = 0;
          for await (const { buffer, timestamp } of asink.buffers(Math.max(0, a - 0.5), b + 0.25)) {
            check();
            const chans = toPlanar(buffer);
            if (!chain) {
              sr = buffer.sampleRate; chCount = chans.length; aIdx = Math.round(a * sr); bIdx = Math.round(b * sr);
              chain = new VoiceChain({ sr, channels: chCount, settings: fx.settings, profile: fx.profile, preGainDb: fx.pre, postGainDb: fx.post, limit: true });
            }
            const inStart = Math.round(timestamp * sr);
            await feed(chans, buffer.length, inStart);
            nextIn = inStart + buffer.length;
            if (outEnd >= bIdx) break;
          }
          if (chain && outEnd < bIdx) { // end of file: flush the chain's delay line with silence
            const n = chain.latency + 1;
            await feed(Array.from({ length: chCount }, () => new Float32Array(n)), n, nextIn);
          }
        }
        offset += segLen;
      }
      asrc.close();
    };

    await Promise.all([videoLoop(), audioLoop()]);
    if (!frames) throw Object.assign(new Error("Nothing to export: every part of the video is cut."), { fatal: true });
    await output.finalize();
    return { blob: sink.blob(o.fmt === "mp4" ? "video/mp4" : "video/webm"), codec, audio: asrc ? audioCodec : null, audioNote };
  } catch (e) {
    if (started) { try { await output.cancel(); } catch {} }
    if (o.signal.aborted) throw new ExportCancelled();
    throw e;
  } finally {
    gpu.destroy();
    try { input.dispose(); } catch {}
  }
}
