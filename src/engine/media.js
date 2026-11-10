// Shared media helpers: presets, codecs, formatting, saving.
import { canEncodeVideo, QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH } from "../../vendor/mediabunny.min.mjs";

export const PRESETS = { 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };
export const RES_NAME = { 1080: "1080p", 1440: "2K", 2160: "4K" };
export const QUALITY = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, veryhigh: QUALITY_VERY_HIGH };
export const CODEC_NAMES = { avc: "H.264", hevc: "H.265", vp9: "VP9", av1: "AV1", vp8: "VP8", aac: "AAC", opus: "Opus", mp3: "MP3", flac: "FLAC", vorbis: "Vorbis" };
export const CODECS = { mp4: ["avc", "hevc", "vp9", "av1"], webm: ["vp9", "av1", "vp8"] };

/**
 * Video bitrate from resolution and frame rate, in line with YouTube's upload recommendations
 * (e.g. H.264 1080p30 ≈ 6 Mbps on High, 4K30 ≈ 37 Mbps on Max). Upscaled video is full of fine
 * detail, and the encoder's automatic bitrates (which shrink with frame rate) were measured to
 * smear it. Newer codecs need fewer bits for the same quality.
 */
const BITS_PER_PIXEL = { medium: 0.06, high: 0.1, veryhigh: 0.15 };
const CODEC_EFFICIENCY = { avc: 1, hevc: 0.65, vp9: 0.7, av1: 0.55, vp8: 1.1 };
export function videoBitrate(codec, w, h, fps, quality = "high") {
  const f = Math.min(60, Math.max(24, fps || 30));
  const bps = (BITS_PER_PIXEL[quality] ?? BITS_PER_PIXEL.high) * (CODEC_EFFICIENCY[codec] ?? 1) * w * h * f;
  return Math.round(Math.min(120e6, Math.max(1e6, bps)));
}
export const fmtTime = (s) => { s = Math.max(0, s || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`; };
export const fmtBytes = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
export const even = (n) => Math.max(2, Math.round(n / 2) * 2);
export const store = { get(k, d) { try { return localStorage.getItem("lumen." + k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem("lumen." + k, v); } catch {} } };

/** Output size that fits `res` (1080/1440/2160) while keeping aspect; snaps to the exact preset within 1%. */
export function targetSize(sw, sh, res) {
  const [L, S] = PRESETS[res];
  const [bw, bh] = sw >= sh ? [L, S] : [S, L];
  const k = Math.min(bw / sw, bh / sh);
  const w = even(sw * k), h = even(sh * k);
  if (Math.abs(w - bw) <= bw * 0.01 && Math.abs(h - bh) <= bh * 0.01) return [bw, bh, k];
  return [w, h, k];
}

/** Video codecs this browser can encode at w×h for a container, best first. */
export async function encodableCodecs(fmt, w, h, quality) {
  const out = [];
  for (const c of CODECS[fmt]) {
    try { if (await canEncodeVideo(c, { width: w, height: h, quality })) out.push(c); } catch {}
  }
  return out;
}

export function friendly(err) {
  const msg = String(err?.message || err || "Unknown error");
  if (/memory|allocation|quota/i.test(msg)) return "The browser ran out of memory. Try a lower resolution or a shorter clip, and close other tabs.";
  if (/context was lost/i.test(msg)) return "The GPU reset during processing. Close other GPU-heavy tabs and try again.";
  if (/unsupported|not supported|NotSupportedError/i.test(msg)) return "Your browser couldn't encode this video with the chosen settings. Try the other format or a lower resolution.";
  return msg;
}

/** Saves a Blob: via the Claude artifact downloads capability when embedded there, else a normal download. */
let downloadsCap = null;
const capReady = (window.claude?.use ? Promise.resolve(window.claude.use("downloads")).catch(() => null) : Promise.resolve(null)).then((d) => (downloadsCap = d));
export async function saveBlob(blob, filename) {
  await Promise.race([capReady, new Promise((r) => setTimeout(r, 1500))]);
  if (downloadsCap) {
    try { await downloadsCap.save({ filename, data: blob }); }
    catch (e) {
      if (e?.code === "declined") return;
      if (e?.code === "rate_limited") throw new Error("A save prompt is already open. Finish it, then try again.");
      throw new Error("Saving isn't available in this view. Open the page in a browser tab to save the file.");
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
