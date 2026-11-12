// AI upscaling with Real-ESRGAN's compact video network (×4), run on the GPU through ONNX Runtime
// WebGPU (WebAssembly/CPU fallback). Frames are processed in fixed-size overlapping tiles, so
// memory stays constant at any resolution, and each ×4 tile is resampled straight onto the
// destination at the requested size.
//
// Measured on photos degraded like web video (half size + x264 CRF 28), upscaled back ×2:
//   bicubic SSIM 0.752 · Wetnix fast filter 0.751 · AI Detail 0.764 · AI Clean 0.763 (PSNR +0.16 dB)
// Feeding the model a pre-shrunk frame scored worse than bicubic, so it always sees full resolution.
import * as ort from "../../vendor/ort/ort.webgpu.min.mjs";

ort.env.wasm.wasmPaths = new URL("../../vendor/ort/", import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.logLevel = "error";

export const AI_VARIANTS = { detail: "esrgan-detail.onnx", clean: "esrgan-clean.onnx" };
const X = 4;        // model scale
const T = 384;      // tile: valid input pixels per side
const P = 16;       // overlap on each side (hides tile seams; the network sees context past the edge)
const M = 8;        // extra output pixels kept around each tile so resampling never reads stale data

/** True when a hardware WebGPU adapter exists. Software adapters (SwiftShader, "fallback" adapters)
 *  emulate the GPU on the CPU and run this model ~30× slower than ONNX Runtime's own CPU path. */
async function hasWebGPU() {
  try {
    const a = navigator.gpu && (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }));
    if (!a || a.isFallbackAdapter || a.info?.isFallbackAdapter) return false;
    return !/swiftshader|llvmpipe|software/i.test(`${a.info?.vendor} ${a.info?.architecture} ${a.info?.description}`);
  } catch { return false; }
}

export class AIUpscaler {
  /**
   * Loads a model. `backend` is "webgpu" (fast) or "wasm" (CPU: works everywhere, very slow).
   * @param {"detail"|"clean"} variant
   */
  static async create(variant = "detail") {
    const url = new URL(`../../models/${AI_VARIANTS[variant]}`, import.meta.url).href;
    const forced = globalThis.__lumenAIBackend; // test hook: "webgpu" | "wasm"
    const eps = forced ? [forced] : (await hasWebGPU()) ? ["webgpu", "wasm"] : ["wasm"];
    let lastErr;
    for (const ep of eps) {
      try {
        const session = await ort.InferenceSession.create(url, { executionProviders: [ep], graphOptimizationLevel: "all" });
        return new AIUpscaler(session, ep, variant);
      } catch (e) { lastErr = e; console.warn(`AI upscaler: ${ep} unavailable`, e); }
    }
    throw new Error(`The AI upscaler couldn't start in this browser (${lastErr?.message || lastErr}).`);
  }

  constructor(session, backend, variant) {
    Object.assign(this, { session, backend, variant });
    this.src = new OffscreenCanvas(1, 1);
    this.srcCtx = this.src.getContext("2d", { willReadFrequently: true });
    this.tile = new OffscreenCanvas(X * T + 2 * M, X * T + 2 * M);
    this.tileCtx = this.tile.getContext("2d");
    this.inputs = new Map(); // tile shape → Float32Array
    this.secondsPerMegapixel = null; // measured as it runs
  }

  /** How many input tiles a w×h source needs. */
  static tilesFor(w, h) { return Math.ceil(w / T) * Math.ceil(h / T); }

  /** Estimated seconds per frame for a source of w×h (after the first frame has been measured). */
  estimate(w, h) { return this.secondsPerMegapixel == null ? null : (this.secondsPerMegapixel * (Math.ceil(w / T) * T + 2 * P) * (Math.ceil(h / T) * T + 2 * P)) / 1e6; }

  /**
   * Upscales the `crop` region of `source` (sw×sh) onto `dest` (any size up to 4× the crop).
   * @param {CanvasImageSource} source
   * @param {OffscreenCanvas|HTMLCanvasElement} dest
   * @param {number[]} [crop] [x, y, w, h] normalised
   */
  async render(source, sw, sh, dest, crop = [0, 0, 1, 1]) {
    const t0 = performance.now();
    const cx = Math.round(crop[0] * sw), cy = Math.round(crop[1] * sh);
    const cw = Math.max(1, Math.round(crop[2] * sw)), ch = Math.max(1, Math.round(crop[3] * sh));
    if (this.src.width !== cw || this.src.height !== ch) { this.src.width = cw; this.src.height = ch; }
    this.srcCtx.drawImage(source, cx, cy, cw, ch, 0, 0, cw, ch);
    const px = this.srcCtx.getImageData(0, 0, cw, ch).data;

    const dctx = dest.getContext("2d");
    dctx.imageSmoothingEnabled = true; dctx.imageSmoothingQuality = "high";
    const kx = dest.width / cw, ky = dest.height / ch;
    // Small frames run as one tile of their own size; larger ones use fixed S×S tiles.
    const S_w = cw + 2 * P <= T + 2 * P ? cw + 2 * P : T + 2 * P, S_h = ch + 2 * P <= T + 2 * P ? ch + 2 * P : T + 2 * P;
    const key = `${S_w}x${S_h}`;
    let input = this.inputs.get(key);
    if (!input) { input = new Float32Array(3 * S_w * S_h); this.inputs.set(key, input); }
    const plane = S_w * S_h, OW = S_w * X;

    for (let ty = 0; ty < ch; ty += T) {
      for (let tx = 0; tx < cw; tx += T) {
        const vw = Math.min(T, cw - tx), vh = Math.min(T, ch - ty);
        // input tile with clamped (edge-replicated) borders, CHW, 0..1
        for (let y = 0; y < S_h; y++) {
          const sy = Math.min(ch - 1, Math.max(0, ty - P + y)), row = sy * cw;
          for (let x = 0; x < S_w; x++) {
            const sx = Math.min(cw - 1, Math.max(0, tx - P + x)), i = (row + sx) * 4, o = y * S_w + x;
            input[o] = px[i] / 255; input[plane + o] = px[i + 1] / 255; input[2 * plane + o] = px[i + 2] / 255;
          }
        }
        const feeds = { input: new ort.Tensor("float32", input, [1, 3, S_h, S_w]) };
        const result = await this.session.run(feeds);
        const out = result.output.data, oPlane = OW * S_h * X;
        // keep the valid ×4 region plus an M-pixel margin, as RGBA
        const x0 = Math.max(0, X * P - M), y0 = Math.max(0, X * P - M);
        const x1 = Math.min(OW, X * (P + vw) + M), y1 = Math.min(S_h * X, X * (P + vh) + M);
        const w = x1 - x0, h = y1 - y0, img = this.tileCtx.createImageData(w, h), d = img.data;
        for (let y = 0; y < h; y++) {
          let o = (y0 + y) * OW + x0, i = y * w * 4;
          for (let x = 0; x < w; x++, o++, i += 4) {
            d[i] = out[o] * 255 + 0.5; d[i + 1] = out[oPlane + o] * 255 + 0.5; d[i + 2] = out[2 * oPlane + o] * 255 + 0.5; d[i + 3] = 255; // Uint8Clamped clamps
          }
        }
        result.output.dispose?.();
        this.tileCtx.putImageData(img, 0, 0);
        // place the valid part (without margins) at its exact destination rectangle
        const sx0 = X * P - x0, sy0 = X * P - y0;
        const dx0 = Math.round(tx * kx), dy0 = Math.round(ty * ky), dx1 = Math.round((tx + vw) * kx), dy1 = Math.round((ty + vh) * ky);
        dctx.drawImage(this.tile, sx0, sy0, X * vw, X * vh, dx0, dy0, dx1 - dx0, dy1 - dy0);
      }
    }
    const mp = ((Math.ceil(cw / T) * T + 2 * P) * (Math.ceil(ch / T) * T + 2 * P)) / 1e6;
    const spm = (performance.now() - t0) / 1000 / mp;
    this.secondsPerMegapixel = this.secondsPerMegapixel == null ? spm : 0.8 * this.secondsPerMegapixel + 0.2 * spm;
  }

  release() { try { this.session.release(); } catch {} }
}

/**
 * One output frame: AI ×4 on the crop (onto `scratch`), then the GPU pass for the exact target size,
 * colour correction and optional light sharpening. Returns gpu.canvas.
 * @param {AIUpscaler} ai @param {import("./upscaler.js").Upscaler} gpu @param {OffscreenCanvas} scratch
 */
export async function aiUpscaleFrame(ai, gpu, src, sw, sh, ow, oh, sharp, scratch, crop = [0, 0, 1, 1]) {
  const cw = crop[2] * sw, ch = crop[3] * sh, k = Math.min(ow / cw, oh / ch);
  const dw = k > X ? Math.round(cw * X) : ow, dh = k > X ? Math.round(ch * X) : oh; // beyond ×4 the GPU pass finishes the scaling
  if (scratch.width !== dw || scratch.height !== dh) { scratch.width = dw; scratch.height = dh; }
  await ai.render(src, sw, sh, scratch, crop);
  gpu.render(scratch, dw, dh, ow, oh, sharp);
  return gpu.canvas;
}
