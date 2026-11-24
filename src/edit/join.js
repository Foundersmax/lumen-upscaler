// Join several videos into one, in order, so the editor can treat them as a single source.
//   copy:   clips recorded with the same settings are stitched packet by packet (no quality loss, seconds)
//   encode: otherwise every clip is decoded and re-encoded to the first clip's size, letterboxed if its shape differs
import {
  Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, StreamTarget,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource,
  CanvasSink, AudioBufferSink, VideoSampleSource, AudioSampleSource, VideoSample, AudioSample,
  getFirstEncodableAudioCodec, QUALITY_HIGH,
} from "../../vendor/mediabunny.min.mjs";
import { BlobSink } from "../engine/blobsink.js";
import { encodableCodecs, videoBitrate, ensureAacEncoder, even, friendly } from "../engine/media.js";
import { ExportCancelled } from "./export.js";
import { toPlanar } from "./enhance.js";

const MP4_VIDEO = new Set(["avc", "hevc", "vp9", "av1"]);
const MP4_AUDIO = new Set(["aac", "opus", "mp3", "flac"]);
const bytes = (d) => (d ? new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d) : null);
const sameBytes = (a, b) => { a = bytes(a); b = bytes(b); if (!a || !b) return a === b; if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/** Reads what joining needs to know about one file. Throws a readable error for files that can't be used. */
export async function probeClip(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    let vt;
    try { vt = await input.getPrimaryVideoTrack(); } catch { throw new Error(`"${file.name}" isn't a video format Wetnix can read.`); }
    if (!vt) throw new Error(`"${file.name}" has no video track.`);
    if (!(await vt.canDecode())) throw new Error(`This browser can't decode "${file.name}". Try Chrome or Edge, or convert it to H.264.`);
    const at = await input.getPrimaryAudioTrack();
    const audioOk = !!at && (await at.canDecode());
    const [end, first, vconf, aconf, stats] = await Promise.all([
      input.computeDuration(), input.getFirstTimestamp().catch(() => 0), vt.getDecoderConfig(),
      audioOk ? at.getDecoderConfig() : null, vt.computePacketStats(120).catch(() => null),
    ]);
    const start = Math.max(0, first || 0);
    if (!(end - start > 0)) throw new Error(`"${file.name}" appears to be empty.`);
    return {
      file, name: file.name, start, end, duration: end - start,
      w: vt.displayWidth, h: vt.displayHeight, rotation: vt.rotation || 0, fps: stats?.averagePacketRate || 0,
      vcodec: vt.codec, vconf, acodec: audioOk ? at.codec : null, aconf, channels: audioOk ? at.numberOfChannels : 0, sampleRate: audioOk ? at.sampleRate : 0,
    };
  } finally { try { input.dispose(); } catch {} }
}

/** True when every clip can be stitched without re-encoding. */
export function canCopy(clips) {
  const [a] = clips;
  if (!MP4_VIDEO.has(a.vcodec)) return false;
  const audio = clips.every((c) => c.acodec) ? "all" : clips.every((c) => !c.acodec) ? "none" : "mixed";
  if (audio === "mixed" || (audio === "all" && !MP4_AUDIO.has(a.acodec))) return false;
  return clips.every((c) =>
    c.vcodec === a.vcodec && c.rotation === a.rotation &&
    c.vconf?.codec === a.vconf?.codec && c.vconf?.codedWidth === a.vconf?.codedWidth && c.vconf?.codedHeight === a.vconf?.codedHeight &&
    sameBytes(c.vconf?.description, a.vconf?.description) &&
    (audio === "none" || (c.acodec === a.acodec && c.aconf?.codec === a.aconf?.codec && c.sampleRate === a.sampleRate &&
      c.channels === a.channels && sameBytes(c.aconf?.description, a.aconf?.description))));
}

/** Output size for re-encoding: the first clip's shape, at most 4K on its long side. */
export function joinSize(clips) {
  const { w, h } = clips[0], k = Math.min(1, 3840 / Math.max(w, h));
  return [even(w * k), even(h * k)];
}

/**
 * @param {{clips: object[], signal: AbortSignal, onProgress?: (p:number)=>void}} o clips from probeClip, in order
 * @returns {Promise<{file: File, offsets: number[], mode: "copy"|"encode"}>}
 *   offsets[k] is where clip k starts in the joined video (subtract clips[k].start from its own times first)
 */
export async function joinClips(o) {
  const name = o.clips[0].name.replace(/\.[^.]+$/, "").slice(0, 100) + "_joined.mp4";
  let mode = canCopy(o.clips) ? "copy" : "encode", r;
  try { r = await (mode === "copy" ? copyJoin(o) : encodeJoin(o)); }
  catch (e) {
    if (e instanceof ExportCancelled || o.signal.aborted) throw new ExportCancelled();
    if (mode !== "copy") throw new Error(friendly(e));
    console.warn("lossless join failed, re-encoding", e);
    mode = "encode"; r = await encodeJoin(o).catch((e2) => { throw o.signal.aborted ? new ExportCancelled() : new Error(friendly(e2)); });
  }
  return { file: new File([r.blob], name, { type: "video/mp4", lastModified: Date.now() }), offsets: r.offsets, mode };
}

const offsetsOf = (clips) => { let t = 0; return clips.map((c) => { const o = t; t += c.duration; return o; }); };

function newOutput() {
  const sink = new BlobSink();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(sink.writable(), { chunked: true, chunkSize: 8 * 1024 * 1024 }) });
  return { sink, output };
}

async function copyJoin({ clips, signal, onProgress }) {
  const offsets = offsetsOf(clips), total = offsets.at(-1) + clips.at(-1).duration;
  const { sink, output } = newOutput();
  const vsrc = new EncodedVideoPacketSource(clips[0].vcodec);
  output.addVideoTrack(vsrc, { rotation: clips[0].rotation });
  const asrc = clips[0].acodec ? new EncodedAudioPacketSource(clips[0].acodec) : null;
  if (asrc) output.addAudioTrack(asrc);
  const inputs = clips.map((c) => new Input({ source: new BlobSource(c.file), formats: ALL_FORMATS }));
  let started = false;
  const check = () => { if (signal.aborted) throw new ExportCancelled(); };
  try {
    await output.start(); started = true;
    const video = async () => {
      let seq = 0, meta = { decoderConfig: clips[0].vconf };
      for (let k = 0; k < clips.length; k++) {
        const shift = offsets[k] - clips[k].start;
        const track = await inputs[k].getPrimaryVideoTrack();
        for await (const p of new EncodedPacketSink(track).packets()) {
          check();
          const ts = p.timestamp + shift; // a clip's slot runs to its last frame or sample, so frames never overlap the next clip
          await vsrc.add(p.clone({ timestamp: ts, sequenceNumber: seq++ }), meta); meta = undefined;
          onProgress?.(Math.min(1, Math.max(0, ts) / total));
        }
      }
      vsrc.close();
    };
    const audio = async () => {
      if (!asrc) return;
      let seq = 0, last = -Infinity, meta = { decoderConfig: clips[0].aconf };
      for (let k = 0; k < clips.length; k++) {
        const shift = offsets[k] - clips[k].start, end = offsets[k] + clips[k].duration;
        const track = await inputs[k].getPrimaryAudioTrack();
        for await (const p of new EncodedPacketSink(track).packets()) {
          check();
          const ts = p.timestamp + shift;
          if (ts < offsets[k] - 1e-3 || ts >= end || ts < last + 1e-4) continue; // keep each clip's audio inside its slot
          await asrc.add(p.clone({ timestamp: ts, sequenceNumber: seq++ }), meta); meta = undefined;
          last = ts;
        }
      }
      asrc.close();
    };
    await Promise.all([video(), audio()]);
    await output.finalize();
    return { blob: sink.blob("video/mp4"), offsets };
  } catch (e) {
    if (started) { try { await output.cancel(); } catch {} }
    throw e;
  } finally { for (const i of inputs) { try { i.dispose(); } catch {} } }
}

async function encodeJoin({ clips, signal, onProgress }) {
  const offsets = offsetsOf(clips), total = offsets.at(-1) + clips.at(-1).duration;
  const [W, H] = joinSize(clips);
  const fps = Math.max(...clips.map((c) => c.fps || 30));
  const codecs = await encodableCodecs("mp4", W, H, QUALITY_HIGH);
  if (!codecs.length) throw new Error(`Your browser can't encode ${W}×${H} video.`);
  const plan = codecs.flatMap((codec) => [{ codec, hw: "no-preference" }, { codec, hw: "prefer-software" }]);
  let lastErr;
  for (const step of plan) {
    if (signal.aborted) throw new ExportCancelled();
    try { return await encodeAttempt({ clips, signal, onProgress, offsets, total, W, H, fps, ...step }); }
    catch (e) { if (e instanceof ExportCancelled || signal.aborted) throw new ExportCancelled(); console.warn(`join ${step.codec}/${step.hw} failed`, e); lastErr = e; }
  }
  throw lastErr;
}

async function encodeAttempt({ clips, signal, onProgress, offsets, total, W, H, fps, codec, hw }) {
  const { sink, output } = newOutput();
  // the joined file is an intermediate that gets edited and exported again, so give it generous bits
  const vsrc = new VideoSampleSource({ codec, bitrate: videoBitrate(codec, W, H, fps, "veryhigh"), hardwareAcceleration: hw, keyFrameInterval: 1 });
  output.addVideoTrack(vsrc);
  let asrc = null, nch = 0, sr = 0;
  const withAudio = clips.filter((c) => c.acodec);
  if (withAudio.length) {
    nch = Math.min(2, Math.max(...withAudio.map((c) => c.channels)));
    sr = withAudio[0].sampleRate || 48000;
    await ensureAacEncoder();
    for (const rate of [sr, 48000, 44100]) {
      const ac = await getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: nch, sampleRate: rate });
      if (ac) { sr = rate; asrc = new AudioSampleSource({ codec: ac, quality: QUALITY_HIGH, transform: { numberOfChannels: nch, sampleRate: sr } }); output.addAudioTrack(asrc); break; }
    }
  }
  const inputs = clips.map((c) => new Input({ source: new BlobSource(c.file), formats: ALL_FORMATS }));
  const comp = new OffscreenCanvas(W, H), ctx = comp.getContext("2d", { alpha: false });
  let started = false;
  const check = () => { if (signal.aborted) throw new ExportCancelled(); };
  try {
    await output.start(); started = true;
    const video = async () => {
      let last = -1;
      for (let k = 0; k < clips.length; k++) {
        const shift = offsets[k] - clips[k].start, end = offsets[k] + clips[k].duration;
        const track = await inputs[k].getPrimaryVideoTrack();
        const cs = new CanvasSink(track, { width: W, height: H, fit: "contain", poolSize: 2 });
        for await (const { canvas, timestamp, duration } of cs.canvases()) {
          check();
          const ts = Math.max(offsets[k], timestamp + shift), stop = Math.min(end, timestamp + shift + duration);
          if (stop <= ts + 1e-4 || ts <= last + 1e-5) continue;
          ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.drawImage(canvas, 0, 0);
          const s = new VideoSample(comp, { timestamp: ts, duration: stop - ts });
          await vsrc.add(s); s.close();
          last = ts; onProgress?.(Math.min(1, stop / total));
        }
      }
      vsrc.close();
    };
    const audio = async () => {
      if (!asrc) return;
      let written = 0; // samples
      const emit = async (chans, n) => {
        const data = new Float32Array(nch * n);
        for (let c = 0; c < nch; c++) data.set(chans[Math.min(c, chans.length - 1)].subarray(0, n), c * n);
        const s = new AudioSample({ data, format: "f32-planar", numberOfChannels: nch, sampleRate: sr, timestamp: written / sr });
        await asrc.add(s); s.close(); written += n;
      };
      const silence = async (until) => {
        while (written < until) { check(); const n = Math.min(sr, until - written); await emit(Array.from({ length: nch }, () => new Float32Array(n)), n); }
      };
      for (let k = 0; k < clips.length; k++) {
        const slot0 = Math.round(offsets[k] * sr), slot1 = Math.round((offsets[k] + clips[k].duration) * sr);
        await silence(slot0);
        if (clips[k].acodec) {
          const track = await inputs[k].getPrimaryAudioTrack();
          const shift = offsets[k] - clips[k].start;
          for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
            check();
            // resample to the output rate by nearest index: clips rarely differ, and the encoder needs one rate
            const rate = buffer.sampleRate, planar = toPlanar(buffer), k2 = rate / sr;
            const at = Math.round((timestamp + shift) * sr), n = Math.floor(buffer.length / k2);
            await silence(Math.min(at, slot1));
            const from = Math.max(written, at), to = Math.min(slot1, at + n);
            if (to <= from) continue;
            const chans = planar.map((x) => { const out = new Float32Array(to - from); for (let i = 0; i < out.length; i++) out[i] = x[Math.min(x.length - 1, Math.floor((from - at + i) * k2))]; return out; });
            await emit(chans, to - from);
          }
        }
        await silence(slot1);
      }
      asrc.close();
    };
    await Promise.all([video(), audio()]);
    await output.finalize();
    return { blob: sink.blob("video/mp4"), offsets };
  } catch (e) {
    if (started) { try { await output.cancel(); } catch {} }
    throw e;
  } finally { for (const i of inputs) { try { i.dispose(); } catch {} } }
}

/**
 * Combines per-clip transcripts into one for the joined video. Only a run of transcribed clips from
 * the start can be used (the editor transcribes from the start onwards); the rest is left for Resume.
 * @param {(object|null)[]} docs Doc JSON per clip (or null)
 */
export function mergeDocs(docs, clips, offsets, duration) {
  const words = [], cutW = [], cutG = [];
  let limit = 0, trailing = 0, all = true;
  for (let k = 0; k < clips.length; k++) {
    const d = docs[k];
    if (!d) { all = false; break; }
    const shift = offsets[k] - clips[k].start, n = d.words.length;
    const lim = Math.min(d.limit ?? d.duration, clips[k].end);
    for (let j = 0; j < n; j++) {
      const w = d.words[j];
      // the pause between two clips stays cut only if it was cut on both sides
      cutG.push(j === 0 && words.length ? (trailing && d.cutG?.[0] ? 1 : 0) : d.cutG?.[j] ? 1 : 0);
      words.push({ ...w, s: w.s + shift, e: w.e + shift });
      cutW.push(d.cutW?.[j] ? 1 : 0);
    }
    if (!n && k === 0) trailing = d.cutG?.[0] ? 1 : 0;
    else if (n) trailing = d.cutG?.[n] ? 1 : 0;
    limit = lim + shift;
    if (lim < clips[k].end - 0.25) { all = false; break; } // partly transcribed: Resume continues from here
  }
  if (!words.length && limit <= 0) return null;
  cutG.push(all ? trailing : 0);
  return { words, duration, limit: all ? duration : limit, cutW, cutG };
}
