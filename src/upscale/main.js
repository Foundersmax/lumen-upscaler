// Upscale page.
import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, WebMOutputFormat, StreamTarget, Conversion,
} from "../../vendor/mediabunny.min.mjs";
import { Upscaler, IDENTITY, FIX_601 } from "../engine/upscaler.js";
import { BlobSink } from "../engine/blobsink.js";
import { AIUpscaler, aiUpscaleFrame } from "../engine/ai-upscaler.js";
import { RES_NAME, QUALITY, CODEC_NAMES, fmtTime, fmtBytes, store, targetSize, encodableCodecs as encodableCodecsFor, friendly, saveBlob, videoBitrate, AUDIO_CODEC, ensureAacEncoder } from "../engine/media.js";

const $ = (id) => document.getElementById(id);
const val = (name) => document.querySelector(`input[name="${name}"]:checked`).value;

/* =====================================================================
   State
   ===================================================================== */
const state = {
  file: null, input: null, track: null, sink: null, srcW: 640, srcH: 360, duration: 0, fps: 0,
  previewSrc: null, colorFix: false, hdr: false, conversion: null, cancelled: false, outBlob: null, outUrl: null, outName: "", loadId: 0,
};
let preview = null, original = null;

/* ---------- capability check ---------- */
function checkSupport() {
  const missing = [];
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") missing.push("WebCodecs video encoding");
  if (typeof OffscreenCanvas === "undefined") missing.push("OffscreenCanvas");
  try { preview = new Upscaler($("enhCanvas")); original = new Upscaler($("origCanvas")); } catch { missing.push("WebGL2"); }
  if (missing.length) {
    $("support").hidden = false;
    $("support").textContent = `This browser is missing ${missing.join(", ")}, which the upscaler needs. Use a current version of Chrome, Edge or another Chromium browser.`;
    for (const el of document.querySelectorAll("button, input")) el.disabled = true;
    return false;
  }
  return true;
}

for (const id of ["enhCanvas", "origCanvas"]) {
  $(id).addEventListener("webglcontextlost", (e) => e.preventDefault());
  $(id).addEventListener("webglcontextrestored", () => {
    try { if (id === "enhCanvas") preview = new Upscaler($(id)); else original = new Upscaler($(id)); renderPreview(); } catch {}
  });
}

function sampleFrame() {
  const c = document.createElement("canvas"); c.width = 640; c.height = 360; const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, 360); sky.addColorStop(0, "#22324f"); sky.addColorStop(.6, "#d98a5b"); sky.addColorStop(1, "#3a2a2a");
  g.fillStyle = sky; g.fillRect(0, 0, 640, 360);
  g.fillStyle = "#f6d18a"; g.beginPath(); g.arc(470, 205, 42, 0, 7); g.fill();
  for (let i = 0; i < 26; i++) { const x = i * 26, h = 40 + ((i * 53) % 90);
    g.fillStyle = "#1a1d26"; g.fillRect(x, 300 - h, 22, h + 60);
    g.fillStyle = "#f3c97a"; for (let y = 300 - h + 6; y < 290; y += 10) for (let wx = x + 4; wx < x + 20; wx += 6) if ((wx * 7 + y * 3) % 5 < 2) g.fillRect(wx, y, 2, 3); }
  g.fillStyle = "#fff"; g.font = "600 22px system-ui, sans-serif"; g.fillText("Harbour Lights · 360p", 24, 40);
  g.font = "12px ui-monospace, monospace"; g.fillStyle = "rgba(255,255,255,.8)"; g.fillText("fine text and edges show the difference", 24, 60);
  for (let i = 0; i < 40; i++) { g.strokeStyle = `rgba(255,255,255,${.15 + (i % 3) * .1})`; g.beginPath(); g.moveTo(0, 330 + i * .7); g.lineTo(640, 322 + i * 1.1); g.stroke(); }
  return c;
}

/* =====================================================================
   Preview
   ===================================================================== */
function layoutFrame() {
  const vp = $("viewport"), fr = $("frame");
  const W = Math.max(1, vp.clientWidth - 24), H = Math.max(1, vp.clientHeight - 24);
  const ar = state.srcW / state.srcH;
  let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
  fr.style.width = w + "px"; fr.style.height = h + "px";
  if (zoomed) unzoom();
}
new ResizeObserver(layoutFrame).observe($("viewport"));

let renderQueued = false;
function renderPreview() {
  if (engine() !== "fast") { scheduleAIPreview(); return; }
  aiTicket++; showBusy(false);
  if (renderQueued) return; renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const src = state.previewSrc; if (!src || !preview || !original) return;
    const [ow, oh] = targetSize(state.srcW, state.srcH, val("res"));
    preview.cm = original.cm = state.colorFix ? FIX_601 : IDENTITY;
    try { if (!preview.lost) preview.render(src, src.width, src.height, ow, oh, $("detail").value / 100); } catch (e) { console.warn(e); }
    try { if (!original.lost) original.render(src, src.width, src.height, src.width, src.height, 0); } catch (e) { console.warn(e); }
  });
}

function updateOutputInfo() {
  // Disable presets that would shrink the video; move selection up if needed.
  const radios = [...document.querySelectorAll('input[name="res"]')];
  for (const r of radios) r.disabled = !!state.conversion || targetSize(state.srcW, state.srcH, r.value)[2] < 0.999;
  const checked = radios.find((r) => r.checked);
  if (checked.disabled) { const next = radios.find((r) => !r.disabled); if (next) next.checked = true; }
  const allBlocked = radios.every((r) => targetSize(state.srcW, state.srcH, r.value)[2] < 0.999);

  const res = val("res");
  const [ow, oh, k] = targetSize(state.srcW, state.srcH, res);
  $("oDims").textContent = `${ow}×${oh}`;
  $("oScale").textContent = `${k.toFixed(2)}×`;
  $("tagR").textContent = `Upscaled · ${RES_NAME[res]}`;
  const w = $("warn");
  if (allBlocked) { w.hidden = false; w.textContent = `This video (${state.srcW}×${state.srcH}) is already larger than 4K.`; }
  else if (radios.some((r) => r.disabled) && state.file) { w.hidden = false; w.textContent = "Smaller presets are off because they would shrink this video."; }
  else w.hidden = true;
  $("goBtn").disabled = !state.file || allBlocked;
  refreshCodec();
}

let codecTicket = 0;
async function refreshCodec() {
  const t = ++codecTicket;
  const [ow, oh] = targetSize(state.srcW, state.srcH, val("res"));
  const list = await encodableCodecs(ow, oh);
  if (t === codecTicket) $("oCodec").textContent = list.length ? CODEC_NAMES[list[0]] : "Not supported";
}
const encodableCodecs = (w, h) => encodableCodecsFor(val("fmt"), w, h, QUALITY[val("q")]);

/* ---------- compare slider + zoom ---------- */
const frame = $("frame");
let split = 50, dragging = false, dragMoved = false, zoomed = false;
function setSplit(v) { split = Math.min(100, Math.max(0, v)); frame.style.setProperty("--split", split + "%"); $("knob").setAttribute("aria-valuenow", Math.round(split)); }
$("knob").addEventListener("pointerdown", (e) => { dragging = true; dragMoved = false; e.preventDefault(); e.stopPropagation(); });
window.addEventListener("pointermove", (e) => { if (!dragging) return; dragMoved = true; const r = frame.getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width * 100); });
window.addEventListener("pointerup", () => { dragging = false; });
window.addEventListener("pointercancel", () => { dragging = false; });
$("knob").addEventListener("click", (e) => e.stopPropagation());
$("knob").addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { setSplit(split - 4); e.preventDefault(); }
  if (e.key === "ArrowRight") { setSplit(split + 4); e.preventDefault(); }
  if (e.key === "Home") setSplit(0); if (e.key === "End") setSplit(100);
});
function unzoom() { zoomed = false; frame.style.transform = ""; $("viewport").classList.remove("zoomed"); }
$("viewport").addEventListener("click", (e) => {
  if (dragMoved) { dragMoved = false; return; }
  if (zoomed) return unzoom();
  const r = frame.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top, Z = 3;
  if (x < 0 || y < 0 || x > r.width || y > r.height) return;
  frame.style.transform = `translate(${x - x * Z}px, ${y - y * Z}px) scale(${Z})`;
  zoomed = true; $("viewport").classList.add("zoomed");
});
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && zoomed) unzoom(); });

/* ---------- controls + persisted settings ---------- */
const paintRange = (el) => el.style.setProperty("--p", (el.value - el.min) / (el.max - el.min) * 100 + "%");
for (const name of ["res", "q", "fmt"]) {
  const saved = store.get(name); const el = saved && document.querySelector(`input[name="${name}"][value="${saved}"]`);
  if (el) el.checked = true;
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.addEventListener("change", () => {
    store.set(name, r.value);
    if (name === "res") { updateOutputInfo(); renderPreview(); } else refreshCodec();
  });
}
$("detail").value = store.get("detail", "60"); $("detailVal").textContent = $("detail").value;
for (const r of document.querySelectorAll('input[type="range"]')) { paintRange(r); r.addEventListener("input", () => paintRange(r)); }
$("detail").addEventListener("input", () => { $("detailVal").textContent = $("detail").value; store.set("detail", $("detail").value); renderPreview(); });

/* =====================================================================
   AI engine (Real-ESRGAN via WebGPU)
   ===================================================================== */
const engine = () => val("eng");
const sharpness = () => ($("detail").value / 100) * (engine() === "fast" ? 1 : 0.35); // AI output is already crisp
let aiLoad = null;
function getAI(variant) {
  if (state.ai?.variant === variant) return Promise.resolve(state.ai);
  if (aiLoad?.variant === variant) return aiLoad.promise;
  const promise = AIUpscaler.create(variant).then((ai) => { state.ai?.release(); state.ai = ai; aiLoad = null; return ai; }, (e) => { aiLoad = null; throw e; });
  aiLoad = { variant, promise };
  return promise;
}
function showBusy(on, text) { if (on) $("loadingText").textContent = text; $("loading").hidden = !on; }
let aiTicket = 0, aiTimer = 0;
const aiScratch = new OffscreenCanvas(1, 1);
function scheduleAIPreview() { clearTimeout(aiTimer); aiTimer = setTimeout(renderAIPreview, 250); }
async function renderAIPreview() {
  const ticket = ++aiTicket, src = state.previewSrc;
  if (!src || !preview || state.conversion) return;
  const [ow, oh] = targetSize(state.srcW, state.srcH, val("res"));
  try {
    showBusy(true, state.ai?.variant === engine() ? "AI is enhancing this frame…" : "Loading the AI model…");
    const ai = await getAI(engine());
    if (ticket !== aiTicket) return;
    showBusy(true, "AI is enhancing this frame…");
    const cw = src.width, ch = src.height, k = Math.min(ow / cw, oh / ch);
    const dw = k > 4 ? cw * 4 : ow, dh = k > 4 ? ch * 4 : oh;
    if (aiScratch.width !== dw || aiScratch.height !== dh) { aiScratch.width = dw; aiScratch.height = dh; }
    await ai.render(src, cw, ch, aiScratch);
    if (ticket !== aiTicket || src !== state.previewSrc) return; // a newer request replaced this one
    preview.cm = original.cm = state.colorFix ? FIX_601 : IDENTITY;
    preview.render(aiScratch, dw, dh, ow, oh, sharpness());
    original.render(src, cw, ch, cw, ch, 0);
    updateAIInfo();
  } catch (e) {
    console.error(e);
    if (ticket !== aiTicket) return;
    showError(`${friendly(e)} Switched back to the Fast engine.`);
    $("eFast").checked = true; store.set("eng", "fast"); syncEngineUI(); renderPreview();
  } finally {
    if (ticket === aiTicket) showBusy(false);
  }
}
function updateAIInfo() {
  const el = $("aiInfo"), ai = state.ai;
  if (engine() === "fast" || !ai || ai.variant !== engine()) { el.hidden = true; return; }
  const est = ai.estimate(state.srcW, state.srcH), frames = state.file && state.fps ? Math.round(state.fps * state.duration) : 0;
  const where = ai.backend === "webgpu" ? "Runs on your GPU" : "WebGPU isn't available, so the AI runs on the CPU and is very slow";
  el.hidden = false;
  el.textContent = est == null ? `${where}.` : `${where}: about ${est < 10 ? est.toFixed(1) : Math.round(est)} s per frame` + (frames ? `, roughly ${fmtTime(est * frames)} for this video.` : ".");
}
function syncEngineUI() {
  const e = engine();
  $("detailLabel").textContent = e === "fast" ? "Detail" : "Extra sharpening";
  $("foot").textContent = e === "fast" ? "Bicubic reconstruction with anti-ringing, then contrast-adaptive sharpening. Audio is kept as is."
    : `Real-ESRGAN (compact video model) restores detail and ${e === "clean" ? "strongly removes noise and compression blocks" : "cleans compression while keeping texture"}. Audio is kept as is.`;
  updateAIInfo();
}
{
  const saved = store.get("eng"); const el = saved && document.querySelector(`input[name="eng"][value="${saved}"]`); if (el) el.checked = true;
  for (const r of document.querySelectorAll('input[name="eng"]')) r.addEventListener("change", () => { store.set("eng", r.value); syncEngineUI(); renderPreview(); });
}

/* =====================================================================
   Loading files
   ===================================================================== */
function showError(msg) { const el = $("err"); el.hidden = !msg; el.textContent = msg || ""; }
function showNote(msg) { const el = $("note"); el.hidden = !msg; el.textContent = msg || ""; }

$("openBtn").onclick = $("openBtn2").onclick = () => { if (!state.conversion) $("file").click(); };
$("file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ""; });
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; if (!state.conversion) $("drop").classList.add("on"); });
window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("drop").classList.remove("on"); } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $("drop").classList.remove("on");
  const f = [...e.dataTransfer.files].find((f) => /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv|ts|mts|m2ts|avi|ogv|3gp)$/i.test(f.name)) || e.dataTransfer.files[0];
  if (f) loadFile(f);
});

async function loadFile(file) {
  if (state.conversion) { showError("Finish or cancel the current export before opening another video."); return; }
  const id = ++state.loadId;
  showError(""); showNote("");
  $("loadingText").textContent = "Reading video…"; $("loading").hidden = false;
  let input;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    let track;
    try { track = await input.getPrimaryVideoTrack(); }
    catch { throw new Error(`"${file.name}" isn't a video format this app can read. MP4, MOV, WebM, MKV and MPEG-TS are supported.`); }
    if (!track) throw new Error(`"${file.name}" has no video track.`);
    if (!(await track.canDecode())) throw new Error(`This browser can't decode ${CODEC_NAMES[track.codec] || track.codec || "this video's codec"}. Try Chrome or Edge, or convert the file to H.264 first.`);
    const [duration, stats, cs, hdr] = await Promise.all([input.computeDuration(), track.computePacketStats(90).catch(() => null),
      track.getColorSpace().catch(() => ({})), track.hasHighDynamicRange().catch(() => false)]);
    if (!(duration > 0)) throw new Error("This video appears to be empty.");
    const sink = new CanvasSink(track, { poolSize: 2 });
    const first = await sink.getCanvas(Math.min(duration * 0.1, Math.max(0, duration - 0.05))) || await sink.getCanvas(0);
    if (!first) throw new Error("Couldn't read any frames from this video.");
    if (id !== state.loadId) { input.dispose(); return; }

    try { state.input?.dispose(); } catch {}
    Object.assign(state, { file, input, track, sink, srcW: first.canvas.width, srcH: first.canvas.height, duration,
      fps: stats?.averagePacketRate || 0, previewSrc: first.canvas,
      colorFix: !cs?.matrix && Math.min(track.codedWidth, track.codedHeight) < 720, hdr });
    clearResult();
    $("sampleNote").hidden = true; $("scrubWrap").hidden = false;
    const meta = $("meta"); meta.textContent = "";
    const name = document.createElement("b"); name.textContent = file.name.length > 28 ? file.name.slice(0, 25) + "…" : file.name; name.title = file.name;
    meta.append(name, ` · ${state.srcW}×${state.srcH}` + (state.fps ? ` · ${(+state.fps.toFixed(2))} fps` : "") + ` · ${fmtTime(duration)} · ${CODEC_NAMES[track.codec] || track.codec || "?"} · ${fmtBytes(file.size)}`);
    $("scrub").value = 100; paintRange($("scrub")); $("timeLbl").textContent = fmtTime(first.timestamp);
    unzoom(); layoutFrame(); updateOutputInfo(); renderPreview();
    if (hdr) showNote("This is an HDR video. The upscaled copy will be SDR (standard range).");
  } catch (err) {
    console.error(err);
    try { input?.dispose(); } catch {}
    if (id === state.loadId) showError(err.message || String(err));
  } finally {
    if (id === state.loadId) $("loading").hidden = true;
  }
}

let seekBusy = false, seekNext = null;
async function seek(t) {
  if (!state.sink) return;
  if (seekBusy) { seekNext = t; return; }
  seekBusy = true;
  const sink = state.sink;
  try {
    const wc = await sink.getCanvas(Math.min(Math.max(0, t), Math.max(0, state.duration - 0.05)));
    if (wc && sink === state.sink) { state.previewSrc = wc.canvas; renderPreview(); $("timeLbl").textContent = fmtTime(wc.timestamp); }
  } catch (e) { console.warn(e); }
  seekBusy = false;
  if (seekNext !== null) { const n = seekNext; seekNext = null; seek(n); }
}
$("scrub").addEventListener("input", () => seek($("scrub").value / 1000 * state.duration));

/* =====================================================================
   Export
   ===================================================================== */
$("goBtn").addEventListener("click", () => {
  if (state.conversion) { state.cancelled = true; $("goBtn").textContent = "Cancelling…"; $("goBtn").disabled = true; state.conversion.cancel().catch(() => {}); }
  else run();
});

function clearResult() {
  $("result").hidden = true;
  if (state.outUrl) URL.revokeObjectURL(state.outUrl);
  $("resultVideo").removeAttribute("src"); $("resultVideo").load();
  state.outBlob = null; state.outUrl = null;
}

/** One conversion attempt with a given codec + acceleration mode. */
async function attempt({ codec, hw, fmt, quality, sharp, ow, oh, onFrame, onInit, ai }) {
  const work = new Upscaler(new OffscreenCanvas(ow, oh));
  const scratch = ai ? new OffscreenCanvas(1, 1) : null;
  work.cm = state.colorFix ? FIX_601 : IDENTITY;
  let rot = null; // 2D canvas used only when frames carry rotation
  const input = new Input({ source: new BlobSource(state.file), formats: ALL_FORMATS });
  const sink = new BlobSink();
  const output = new Output({
    format: fmt === "mp4" ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
    target: new StreamTarget(sink.writable(), { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  });
  try {
    if (fmt === "mp4") await ensureAacEncoder();
    const conversion = await Conversion.init({
      input, output, showWarnings: false,
      audio: { codec: AUDIO_CODEC[fmt] }, // copied as is when the source already uses it, converted otherwise
      video: {
        codec, bitrate: videoBitrate(codec, ow, oh, state.fps, val("q")), hardwareAcceleration: hw, forceTranscode: true, allowTransformationMetadata: false,
        processedWidth: ow, processedHeight: oh,
        process: async (sample) => {
          let src = sample.toCanvasImageSource(), sw = src.displayWidth ?? src.width, sh = src.displayHeight ?? src.height;
          if (sample.rotation) { // bake rotation so the upscaler sees an upright frame
            const dw = sample.displayWidth, dh = sample.displayHeight;
            if (!rot || rot.width !== dw || rot.height !== dh) rot = new OffscreenCanvas(dw, dh);
            const ctx = rot.getContext("2d"); ctx.clearRect(0, 0, dw, dh);
            sample.drawWithFit(ctx, { fit: "fill" }); src = rot; sw = dw; sh = dh;
          }
          if (ai) {
            try { await aiUpscaleFrame(ai, work, src, sw, sh, ow, oh, sharp, scratch); }
            catch (e) { // not an encoder problem: retrying with other encoders would fail the same way
              throw Object.assign(new Error(`The AI upscaler stopped (${e?.message || e}). Try again, or use the Fast engine.`), { fatal: true });
            }
          }
          else work.render(src, sw, sh, ow, oh, sharp);
          onFrame();
          return work.canvas;
        },
      },
    });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((d) => `${d.track.type} track: ${d.reason.replace(/_/g, " ")}`).join("; ");
      throw Object.assign(new Error(`This file can't be converted (${reasons}).`), { fatal: true });
    }
    onInit(conversion);
    if (state.cancelled) throw Object.assign(new Error("Cancelled"), { name: "ConversionCanceledError" });
    await conversion.execute();
    return sink.blob(fmt === "mp4" ? "video/mp4" : "video/webm");
  } finally {
    work.destroy();
    try { input.dispose(); } catch {}
  }
}

async function run() {
  if (!state.file || state.conversion) return;
  showError(""); showNote(""); clearResult();
  const res = val("res"), fmt = val("fmt"), quality = QUALITY[val("q")], sharp = sharpness();
  let ai = null;
  if (engine() !== "fast") {
    try { showBusy(true, "Loading the AI model…"); aiTicket++; ai = await getAI(engine()); }
    catch (e) { showError(`${friendly(e)} Use the Fast engine instead.`); return; }
    finally { showBusy(false); }
  }
  const [ow, oh] = targetSize(state.srcW, state.srcH, res);
  const codecs = await encodableCodecs(ow, oh);
  if (!codecs.length) { showError(`Your browser can't encode ${ow}×${oh} video as ${fmt.toUpperCase()}. Try the other format or a lower resolution.`); return; }

  // Try each encodable codec, first with the default (usually hardware) encoder, then in software.
  const plan = codecs.flatMap((codec) => [{ codec, hw: "no-preference" }, { codec, hw: "prefer-software" }]);
  state.cancelled = false; state.conversion = { cancel: async () => {} }; setBusy(true);
  const wake = await navigator.wakeLock?.request("screen").catch(() => null);
  const t0 = performance.now();
  let frames = 0, lastErr = null, blob = null, used = null, conversion = null;
  const totalFrames = state.fps ? Math.round(state.fps * state.duration) : 0;

  for (const step of plan) {
    if (state.cancelled) break;
    frames = 0; const tStart = performance.now();
    try {
      blob = await attempt({
        ...step, fmt, quality, sharp, ow, oh, ai,
        onFrame: () => { frames++; },
        onInit: (c) => {
          conversion = c; state.conversion = c;
          if (state.cancelled) c.cancel();
          const audio = c.utilizedTracks.find((t) => t.type === "audio");
          const dropped = c.discardedTracks.find((d) => d.track.type === "audio");
          showNote(dropped && !audio ? `The audio track can't be kept in ${fmt.toUpperCase()} on this browser, so the result will be silent. Try the other format to keep it.` : "");
          c.onProgress = (p) => {
            const el = (performance.now() - tStart) / 1000;
            $("fill").style.width = (p * 100).toFixed(1) + "%";
            $("pct").textContent = Math.floor(p * 100) + "%";
            $("fps").textContent = (frames / Math.max(el, .001)).toFixed(1);
            $("eta").textContent = p > 0.02 ? `${fmtTime(el / p - el)} left` : (totalFrames ? `${frames} / ${totalFrames} frames` : "starting…");
          };
        },
      });
      used = step; break;
    } catch (err) {
      if (state.cancelled || err?.name === "ConversionCanceledError") break;
      console.warn(`Attempt ${step.codec}/${step.hw} failed`, err);
      lastErr = err;
      if (err.fatal) break;
      $("eta").textContent = "retrying with another encoder…";
    }
  }

  wake?.release?.().catch(() => {});
  state.conversion = null; setBusy(false);

  if (state.cancelled) { showNote("Export cancelled."); return; }
  if (!blob) { showError(friendly(lastErr)); return; }
  if (!frames || blob.size < 1024) { showError("The export produced no video frames. Try the other format."); return; }

  const secs = (performance.now() - t0) / 1000;
  const base = state.file.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) || "video";
  state.outBlob = blob; state.outName = `${base}_${RES_NAME[res]}.${fmt}`;
  state.outUrl = URL.createObjectURL(blob);
  $("resultVideo").src = state.outUrl;
  $("resultTitle").textContent = `${ow}×${oh} · ${CODEC_NAMES[used.codec]}` + (ai ? ` · AI ${ai.variant === "clean" ? "Clean" : "Detail"}` : "");
  $("resultSize").textContent = fmtBytes(blob.size);
  $("resultTime").textContent = `${fmtTime(secs)} · ${(frames / Math.max(secs, .001)).toFixed(1)} fps`;
  $("result").hidden = false;
  $("saveBtn").focus({ preventScroll: true });
}

function setBusy(b) {
  $("progress").hidden = !b;
  $("goBtn").textContent = b ? "Cancel" : "Upscale video";
  $("goBtn").disabled = false;
  $("goBtn").classList.toggle("primary", !b); $("goBtn").classList.toggle("ghost", b);
  for (const el of document.querySelectorAll('.panel input, #openBtn, #openBtn2')) el.disabled = b;
  if (b) { $("fill").style.width = "0"; $("pct").textContent = "0%"; $("fps").textContent = "0"; $("eta").textContent = "starting…"; }
  else updateOutputInfo();
}

window.addEventListener("beforeunload", (e) => { if (state.conversion) { e.preventDefault(); e.returnValue = ""; } });

/* =====================================================================
   Saving
   ===================================================================== */
$("saveBtn").addEventListener("click", async () => {
  if (!state.outBlob) return;
  showError("");
  try { await saveBlob(state.outBlob, state.outName); } catch (e) { showError(e.message); }
});

/* =====================================================================
   Boot
   ===================================================================== */
if (checkSupport()) {
  state.previewSrc = sampleFrame();
  syncEngineUI(); layoutFrame(); updateOutputInfo(); renderPreview();
}
window.__app = { state, loadFile, run, BlobSink };
