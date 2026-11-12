// Edit page: transcript-based video editing.
import { Input, ALL_FORMATS, BlobSource } from "../../vendor/mediabunny.min.mjs";
import { Doc, sanitizeWords, normWord, mapTime, cutAt, captionCues, toSRT, toText } from "./transcript.js";
import { analyzeBase, analyzeChain, chainKey, gainsFor } from "./enhance.js";
import { ASPECTS, DEFAULT_REFRAME, cropGeometry, reframeSize, cropShortSide, trackFaces, buildPath, centerAt, cropAt } from "./reframe.js";
import { DEFAULT_AUDIO, NOISE_LEVELS, VOICE_TONES } from "../audio/dsp.js";
import { CAPTION_STYLES, CAPTION_COLORS, DEFAULT_CAPTIONS, buildCues, mapCues, rangeMapper, drawCaptions, loadCaptionFonts } from "./captions.js";
import { extractAudio16k, peaks as computePeaks, ASR_RATE } from "./audio.js";
import { exportEdit, ExportCancelled } from "./export.js";
import { getProject, putProject, projectKey } from "./store.js";
import { QUALITY, CODEC_NAMES, RES_NAME, fmtTime, fmtBytes, even, store, targetSize, friendly, saveBlob } from "../engine/media.js";

const $ = (id) => document.getElementById(id);
const val = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const video = $("video"), script = $("script"), strip = $("strip"), dlg = $("exportDlg");

const state = {
  file: null, key: null, url: null, duration: 0, srcW: 0, srcH: 0, colorFix: false, atrack: null, input: null,
  doc: null, cuts: [], kept: [], peaks: null, audio: null, undo: [], redo: [],
  wordEls: [], gapEls: new Map(), nowIdx: -1, followUntil: 0,
  find: { hits: [], len: 0, cur: -1 },
  captions: loadCaptionPrefs(), capCues: [],
  audioFx: loadAudioPrefs(), audioBase: null, chainLufs: {}, audioJob: null,
  reframe: { ...DEFAULT_REFRAME }, faceSamples: null, rfPath: null, rfJob: null,
  transcribing: null, exporting: null, out: null, loadId: 0,
};
const busy = () => !!(state.transcribing || state.exporting);
const show = (id, msg) => { const el = $(id); el.hidden = !msg; el.textContent = msg || ""; };

/* =====================================================================
   Support check
   ===================================================================== */
function checkSupport() {
  const missing = [];
  if (typeof VideoEncoder === "undefined" || typeof AudioDecoder === "undefined") missing.push("WebCodecs");
  if (typeof OffscreenCanvas === "undefined") missing.push("OffscreenCanvas");
  else { try { if (!new OffscreenCanvas(2, 2).getContext("webgl2")) missing.push("WebGL2"); } catch { missing.push("WebGL2"); } }
  if (typeof Worker === "undefined") missing.push("Web Workers");
  if (!missing.length) return true;
  $("support").hidden = false;
  $("support").textContent = `This browser is missing ${missing.join(", ")}, which the editor needs. Use a current version of Chrome, Edge or another Chromium browser.`;
  for (const el of document.querySelectorAll("button, input, select")) el.disabled = true;
  return false;
}

/* =====================================================================
   Example transcript (before a file is opened)
   ===================================================================== */
function renderExample() {
  const ex = [
    ["Okay,", 0], ["so", 0], ["um,", 1], ["today", 0], ["I", 0], ["want", 0], ["to", 0], ["show", 0], ["you", 0], ["how", 0], ["we", 0],
    ["cut", 0], ["our", 0], ["editing", 0], ["time", 0], ["in", 0], ["half.", 0], ["|1.8", 1], ["The", 0], ["trick", 0], ["is", 0],
    ["uh,", 1], ["really", 1], ["really", 0], ["simple:", 0], ["you", 0], ["edit", 0], ["the", 0], ["words,", 0], ["and", 0], ["the", 0],
    ["video", 0], ["follows.", 0],
  ];
  script.hidden = false; script.textContent = "";
  const tag = document.createElement("div"); tag.className = "example-tag"; tag.textContent = "Example";
  const p = document.createElement("p");
  for (const [t, cut] of ex) {
    if (t.startsWith("|")) { const g = document.createElement("span"); g.className = "gap" + (cut ? " cut" : ""); g.textContent = t.slice(1) + "s"; p.append(g, " "); continue; }
    const s = document.createElement("span"); s.className = "w" + (cut ? " cut" : ""); s.textContent = t; p.append(s, " ");
  }
  const help = document.createElement("p"); help.className = "help";
  help.innerHTML = 'Your transcript appears here. Struck-through words and pauses are cut from the video.<br>Select text and press <span class="kbd">Delete</span> to cut it, double-click a word to fix its spelling, <span class="kbd">Space</span> to play.';
  script.append(tag, p, help);
}
function scriptMessage(msg) {
  script.hidden = !msg; script.textContent = "";
  if (msg) { const p = document.createElement("p"); p.className = "help"; p.textContent = msg; script.append(p); }
}

/* =====================================================================
   Opening a file
   ===================================================================== */
$("empty").onclick = () => pickFile();
$("empty").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickFile(); } };
$("changeBtn").onclick = () => pickFile();
function pickFile() { if (!busy()) $("file").click(); }
$("file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ""; });

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; if (!busy()) $("drop").classList.add("on"); });
window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("drop").classList.remove("on"); } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $("drop").classList.remove("on");
  const f = [...e.dataTransfer.files].find((f) => /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv|ts|mts)$/i.test(f.name)) || e.dataTransfer.files[0];
  if (f) loadFile(f);
});

async function loadFile(file) {
  if (busy()) { show("err", "Finish or cancel the current task before opening another video."); return; }
  const id = ++state.loadId;
  show("err", ""); show("note", ""); show("tErr", "");
  $("loading").hidden = false; $("loadingText").textContent = "Reading video…";
  let input;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    let vt;
    try { vt = await input.getPrimaryVideoTrack(); }
    catch { throw new Error(`"${file.name}" isn't a video format Wetnix can read. MP4, MOV, WebM, MKV and MPEG-TS work.`); }
    if (!vt) throw new Error(`"${file.name}" has no video track.`);
    if (!(await vt.canDecode())) throw new Error("This browser can't decode this video's codec. Try Chrome or Edge, or convert it to H.264.");
    const at = await input.getPrimaryAudioTrack();
    const audioOk = !!at && (await at.canDecode());
    const [duration, cs] = await Promise.all([input.computeDuration(), vt.getColorSpace().catch(() => ({}))]);
    if (!(duration > 0)) throw new Error("This video appears to be empty.");
    if (id !== state.loadId) { input.dispose(); return; }

    try { state.input?.dispose(); } catch {}
    if (state.url) URL.revokeObjectURL(state.url);
    clearResult(); closeFind();
    Object.assign(state, {
      file, key: projectKey(file), input, atrack: audioOk ? at : null, duration,
      srcW: vt.displayWidth, srcH: vt.displayHeight,
      colorFix: !cs?.matrix && Math.min(vt.codedWidth, vt.codedHeight) < 720,
      doc: null, cuts: [], kept: [[0, duration]], peaks: null, audio: null, undo: [], redo: [], nowIdx: -1, captions: loadCaptionPrefs(), capCues: [], audioFx: loadAudioPrefs(), audioBase: null, chainLufs: {}, reframe: { ...DEFAULT_REFRAME }, faceSamples: null, rfPath: null,
      url: URL.createObjectURL(file),
    });
    $("player").style.aspectRatio = `${state.srcW} / ${state.srcH}`;
    video.src = state.url; show("videoMsg", "");
    $("empty").hidden = true; $("playBtn").disabled = false;
    $("filebar").hidden = false;
    const fname = $("fileName"); fname.textContent = ""; fname.title = file.name;
    const b = document.createElement("b"); b.textContent = file.name;
    fname.append(b, ` · ${state.srcW}×${state.srcH} · ${fmtTime(duration)}`);
    $("exportOpen").disabled = false;
    updateResOptions();

    state.audioJob?.abort(); state.audioJob = null; state.rfJob?.abort(); state.rfJob = null;
    const saved = await getProject(state.key);
    if (saved?.audioFx) state.audioFx = { ...DEFAULT_AUDIO, ...saved.audioFx };
    if (saved?.audioBase?.profile?.power) { state.audioBase = saved.audioBase; state.chainLufs = saved.chainLufs || {}; }
    syncAudioUI(); configurePreview();
    if (state.audioFx.on) ensureAudio().catch(() => {});
    if (saved?.reframe) state.reframe = { ...DEFAULT_REFRAME, ...saved.reframe };
    if (saved?.faceSamples) state.faceSamples = saved.faceSamples;
    rebuildPath(); syncReframeUI(); applyFrame();
    if (needsTracking()) ensureTracking().catch(() => {});
    if (saved?.doc?.words?.length && Math.abs(saved.doc.duration - duration) < 0.5) {
      state.doc = Doc.fromJSON(saved.doc);
      state.peaks = saved.peaks || null;
      if (saved.captions) { state.captions = { ...DEFAULT_CAPTIONS, ...saved.captions }; syncCaptionUI(); }
      $("setup").hidden = true;
      renderScript(); afterEdit(false);
      show("note", "Restored your transcript and edits for this file.");
    } else {
      $("setup").hidden = !audioOk;
      scriptMessage(audioOk ? "" : "This video has no audio Wetnix can read, so it can't be transcribed. You can still export or upscale it.");
      afterEdit(false);
    }
  } catch (err) {
    console.error(err);
    try { input?.dispose(); } catch {}
    if (id === state.loadId) show("err", err.message || String(err));
  } finally {
    if (id === state.loadId) $("loading").hidden = true;
  }
}

video.addEventListener("error", () => { if (state.file) show("videoMsg", "Your browser can't preview this format. Editing and export still work."); });
video.addEventListener("loadedmetadata", () => drawStrip());

/* =====================================================================
   Transcription (with pause/resume)
   ===================================================================== */
{
  const saved = store.get("model"); const el = saved && document.querySelector(`input[name="model"][value="${saved}"]`); if (el) el.checked = true;
  for (const r of document.querySelectorAll('input[name="model"]')) r.addEventListener("change", () => store.set("model", r.value));
  $("lang").value = store.get("lang", "");
  $("lang").addEventListener("change", () => store.set("lang", $("lang").value));
}
$("transcribeBtn").addEventListener("click", () => state.transcribing ? state.transcribing.cancel() : transcribe());
$("resumeBtn").addEventListener("click", () => state.transcribing ? state.transcribing.cancel() : transcribe({ resume: true }));

function setT(p, status, right = "") {
  $("tProgress").hidden = false;
  $("tFill").style.width = (Math.max(0, Math.min(1, p)) * 100).toFixed(1) + "%";
  $("tStatus").textContent = status; $("tPct").textContent = right;
}

async function transcribe({ resume = false } = {}) {
  if (!state.atrack || busy()) return;
  const prev = resume ? state.doc : null;
  const start = prev ? prev.limit : 0;
  show("tErr", ""); show("note", "");
  const ac = new AbortController();
  let worker = null;
  state.transcribing = { cancel: () => { ac.abort(); worker?.terminate(); } };
  $("setup").hidden = false; $("resume").hidden = true;
  $("transcribeBtn").textContent = resume ? "Pause" : "Pause transcription";
  $("transcribeBtn").classList.replace("primary", "ghost");
  setToolsEnabled();
  const wake = await navigator.wakeLock?.request("screen").catch(() => null);
  const words = [];
  let upTo = start;
  const live = document.createElement("p"); live.className = "livewords";
  if (!prev) { script.hidden = false; script.textContent = ""; }
  script.append(live);
  try {
    if (!state.audio) {
      setT(0, "Reading audio…");
      state.audio = await extractAudio16k(state.atrack, state.duration, (p) => setT(p, "Reading audio…", Math.round(p * 100) + "%"), ac.signal);
      state.peaks = computePeaks(state.audio); drawStrip();
    }
    const audio = state.audio.slice(Math.floor(start * ASR_RATE));
    const size = val("model"), language = $("lang").value || null;
    const span = state.duration - start;
    const onWords = (ws, progress, at) => {
      words.push(...ws);
      upTo = at ?? start + progress * span;
      live.append(ws.map((w) => w.t.trim()).join(" ") + " ");
      setT((upTo) / state.duration, "Transcribing…", `${fmtTime(upTo)} / ${fmtTime(state.duration)}`);
    };
    setT(start / state.duration, "Starting speech engine…");
    if (window.__lumenMockTranscribe) {
      await window.__lumenMockTranscribe(audio, { offset: start, onWords, onStatus: (s) => setT(0, s), signal: ac.signal });
    } else {
      await new Promise((resolve, reject) => {
        worker = new Worker(new URL("./transcribe.worker.js", import.meta.url), { type: "module" });
        ac.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
        worker.onerror = (e) => reject(new Error("The speech engine failed to start" + (e.message ? `: ${e.message}` : ".")));
        worker.onmessage = ({ data: m }) => {
          if (m.type === "status") setT(start / state.duration, m.text);
          else if (m.type === "download") setT(m.loaded / m.total, "Downloading speech model (first time only)…", `${fmtBytes(m.loaded)} / ${fmtBytes(m.total)}`);
          else if (m.type === "words") onWords(m.words, m.progress, m.upTo);
          else if (m.type === "done") resolve(m);
          else if (m.type === "error") reject(new Error(m.message));
        };
        worker.postMessage({ type: "run", audio, offset: start, size, language }, [audio.buffer]);
      });
    }
    if (ac.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    finishTranscript(prev, words, state.duration);
    if (!state.doc?.n) throw Object.assign(new Error("No speech was found in this video. If it has speech, try the Accurate model or set the language."), { noSpeech: true });
    $("setup").hidden = true;
    show("note", `Transcribed ${state.doc.n.toLocaleString()} words.`);
  } catch (e) {
    const cancelled = e?.name === "AbortError" || ac.signal.aborted;
    if (!e?.noSpeech && (words.length || prev)) {
      // keep what was transcribed so far; the rest can be continued later
      finishTranscript(prev, words, Math.max(start, upTo));
      $("setup").hidden = true;
      if (!cancelled) show("err", friendly(e));
    } else {
      if (!cancelled) show("tErr", friendly(e));
      scriptMessage("");
      state.doc = null; $("setup").hidden = false;
    }
  } finally {
    worker?.terminate();
    wake?.release?.().catch(() => {});
    state.transcribing = null;
    $("tProgress").hidden = true;
    $("transcribeBtn").textContent = "Transcribe";
    $("transcribeBtn").classList.replace("ghost", "primary");
    updateResume(); setToolsEnabled();
  }
}

/** Builds/extends the document from newly transcribed words. */
function finishTranscript(prev, words, limit) {
  const prevEnd = prev?.n ? prev.words[prev.n - 1].e : 0;
  const clean = sanitizeWords(words, state.duration, prevEnd);
  if (prev) state.doc = prev.extend(clean, limit);
  else if (clean.length || limit < state.duration - 0.25) state.doc = new Doc(clean, state.duration, limit);
  else state.doc = null;
  if (!state.doc) return;
  if (!prev) { state.undo = []; state.redo = []; }
  renderScript(); afterEdit();
}

function updateResume() {
  const d = state.doc, el = $("resume");
  if (!d || d.complete || state.transcribing) { el.hidden = true; return; }
  el.hidden = false;
  $("resumeText").textContent = `Transcribed up to ${fmtTime(d.limit)} of ${fmtTime(d.duration)}.`;
}

/* =====================================================================
   Transcript rendering
   ===================================================================== */
const SHOW_GAP = 0.6;
function renderScript() {
  const doc = state.doc; if (!doc) return;
  script.hidden = false; script.textContent = "";
  state.wordEls = new Array(doc.n); state.gapEls = new Map(); state.nowIdx = -1;
  const frag = document.createDocumentFragment();
  let p = null, inPara = 0;
  const newPara = (k) => {
    if (p) frag.append(p);
    p = document.createElement("p"); inPara = 0;
    if (k < doc.n) { const st = document.createElement("span"); st.className = "stamp"; st.dataset.t = doc.words[k].s; st.textContent = fmtTime(doc.words[k].s); p.append(st); }
  };
  const gapEl = (k) => {
    const g = document.createElement("span"); g.className = "gap"; g.dataset.g = k;
    g.textContent = doc.gapDur(k).toFixed(1) + "s"; g.title = "Pause. Click to cut or restore it.";
    state.gapEls.set(k, g); return g;
  };
  newPara(0);
  for (let k = 0; k <= doc.n; k++) {
    const gd = doc.gapDur(k);
    const prev = k > 0 ? doc.words[k - 1].t : "";
    if (k > 0 && k < doc.n && inPara > 0 && (gd >= 1.5 || (/[.?!]$/.test(prev) && (gd >= 0.6 || inPara > 70)))) newPara(k);
    if (gd >= SHOW_GAP && (k < doc.n || doc.complete)) p.append(gapEl(k), " ");
    if (k === doc.n) break;
    const s = document.createElement("span"); s.className = "w"; s.dataset.i = k; s.textContent = doc.words[k].t;
    state.wordEls[k] = s; p.append(s, " "); inPara++;
  }
  frag.append(p);
  script.append(frag);
  if (state.find.q) runFind($("findInput").value, false);
}

function updateClasses() {
  const doc = state.doc; if (!doc) return;
  for (let i = 0; i < doc.n; i++) {
    const el = state.wordEls[i]; if (!el) continue;
    el.classList.toggle("cut", !!doc.cutW[i]);
    if (el.contentEditable !== "true" && el.textContent !== doc.words[i].t) el.textContent = doc.words[i].t; // undo of a text fix
  }
  for (const [k, el] of state.gapEls) el.classList.toggle("cut", doc.gapCut(k));
}

/* =====================================================================
   Edits, undo, autosave
   ===================================================================== */
function edit(fn) {
  const doc = state.doc; if (!doc || state.exporting) return;
  const before = doc.snapshot();
  if (fn(doc) === false) return;
  state.undo.push(before); if (state.undo.length > 300) state.undo.shift();
  state.redo = [];
  afterEdit();
}
function undo() { const d = state.doc; if (!d || !state.undo.length || state.exporting) return; state.redo.push(d.snapshot()); d.restore(state.undo.pop()); afterEdit(); }
function redo() { const d = state.doc; if (!d || !state.redo.length || state.exporting) return; state.undo.push(d.snapshot()); d.restore(state.redo.pop()); afterEdit(); }

let persistTimer = 0;
function afterEdit(persist = true) {
  const doc = state.doc;
  state.cuts = doc ? doc.cutIntervals() : [];
  state.kept = doc ? doc.keptRanges(state.cuts) : (state.duration ? [[0, state.duration]] : []);
  state.capCues = doc ? buildCues(doc, state.captions, (t) => mapTime(t, state.cuts)) : [];
  updateClasses(); drawStrip(); updateStats(); updateExportInfo(); updateClock(); updateResume(); setToolsEnabled(); drawCapOverlay(); syncCaptionUI();
  if (persist && state.key) {
    clearTimeout(persistTimer);
    $("saved").textContent = "Saving…";
    const key = state.key, snapshot = { doc: doc ? doc.toJSON() : null, peaks: state.peaks, captions: state.captions, audioFx: state.audioFx, audioBase: state.audioBase, chainLufs: state.chainLufs, reframe: state.reframe, faceSamples: state.faceSamples };
    persistTimer = setTimeout(async () => {
      const ok = await putProject(key, snapshot);
      $("saved").textContent = ok === null ? "Not saved in this browser" : "Saved";
    }, 400);
  }
}

function updateStats() {
  const doc = state.doc;
  if (!doc) { $("cutChip").hidden = true; return; }
  const removed = doc.removedSeconds(state.cuts);
  $("cutChip").hidden = removed < 0.05;
  $("cutChip").textContent = `−${fmtTime(removed)} · ${state.cuts.length} cut${state.cuts.length === 1 ? "" : "s"}`;
}

function setToolsEnabled() {
  const has = !!state.doc && !busy();
  for (const id of ["trimBtn", "pauseLen", "fillerBtn", "restoreBtn", "findBtn"]) $(id).disabled = !has;
  $("undoBtn").disabled = !has || !state.undo.length;
  $("redoBtn").disabled = !has || !state.redo.length;
  $("srtBtn").disabled = $("txtBtn").disabled = !state.doc?.n;
  $("exportOpen").disabled = !state.file || !!state.transcribing;
  $("changeBtn").disabled = busy();
  $("resumeBtn").disabled = !!state.exporting;
}

$("trimBtn").onclick = () => edit((d) => {
  const n = d.trimPauses(+$("pauseLen").value);
  show("note", n ? `Cut ${n} pause${n === 1 ? "" : "s"}.` : "No pauses that long are left to cut.");
  return n > 0;
});
$("fillerBtn").onclick = () => edit((d) => {
  const n = d.removeFillers();
  show("note", n ? `Cut ${n} filler word${n === 1 ? "" : "s"}.` : "No filler words found. Speech models often leave them out of the transcript; Trim pauses removes the gaps they leave.");
  return n > 0;
});
$("restoreBtn").onclick = () => edit((d) => { const had = d.cutW.some(Boolean) || d.cutG.some(Boolean); d.restoreAll(); if (had) show("note", "Restored everything. Undo brings the cuts back."); return had; });
$("undoBtn").onclick = undo; $("redoBtn").onclick = redo;

/* =====================================================================
   Selection → cut / restore
   ===================================================================== */
/** Word indices [lo, hi] intersecting range r, found by binary search on document order. */
function wordSpan(r) {
  const els = state.wordEls, n = els.length;
  let lo = 0, hi = n - 1, first = n;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (r.comparePoint(els[m], els[m].childNodes.length) >= 0) { first = m; hi = m - 1; } else lo = m + 1; }
  lo = 0; hi = n - 1; let last = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (r.comparePoint(els[m], 0) <= 0) { last = m; lo = m + 1; } else hi = m - 1; }
  return first <= last ? [first, last] : null;
}
function selectedTokens() {
  const sel = getSelection();
  if (!state.doc || !sel.rangeCount || sel.isCollapsed || !state.wordEls.length) return null;
  const r = sel.getRangeAt(0);
  if (!script.contains(r.commonAncestorContainer)) return null;
  const span = wordSpan(r), words = [];
  if (span) for (let i = span[0]; i <= span[1]; i++) words.push(i);
  const gaps = [];
  for (const [k, el] of state.gapEls) if (r.intersectsNode(el)) gaps.push(k);
  if (!words.length && !gaps.length) return null;
  return { words, gaps, rect: r.getBoundingClientRect() };
}
function applySelection(mode) {
  const t = selectedTokens(); if (!t) return false;
  edit((d) => {
    const allCut = t.words.every((i) => d.cutW[i]) && t.gaps.every((k) => d.gapCut(k));
    const cut = mode === "cut" || (mode === "toggle" && !allCut);
    for (const i of t.words) d.cutW[i] = cut ? 1 : 0;
    for (const k of t.gaps) d.cutG[k] = cut ? 1 : 0;
    if (!cut) for (let j = 1; j < t.words.length; j++) d.cutG[t.words[j]] = 0; // pauses inside a restored selection
  });
  getSelection().removeAllRanges(); $("seltool").hidden = true;
  return true;
}
$("selCut").onclick = () => applySelection("cut");
$("selRestore").onclick = () => applySelection("restore");
$("selPlay").onclick = () => {
  const t = selectedTokens(); if (!t?.words.length) return;
  seek(state.doc.words[t.words[0]].s); play();
  getSelection().removeAllRanges(); $("seltool").hidden = true;
};
let selRaf = 0;
document.addEventListener("selectionchange", () => {
  cancelAnimationFrame(selRaf);
  selRaf = requestAnimationFrame(() => {
    const t = selectedTokens(), tool = $("seltool");
    if (!t || state.exporting || editing) { tool.hidden = true; return; }
    const r = t.rect;
    tool.hidden = false;
    tool.style.left = Math.min(Math.max(r.left + r.width / 2, 100), innerWidth - 100) + "px";
    tool.style.top = Math.max(r.top, 64) + "px";
  });
});
script.addEventListener("scroll", () => { $("seltool").hidden = true; state.followUntil = performance.now() + 3000; }, { passive: true });

script.addEventListener("click", (e) => {
  if (!getSelection().isCollapsed || editing) return;
  const st = e.target.closest(".stamp");
  if (st) { seek(+st.dataset.t); state.followUntil = 0; return; }
  const g = e.target.closest(".gap");
  if (g && state.doc && g.dataset.g !== undefined) {
    const k = +g.dataset.g;
    edit((d) => {
      if ((k > 0 && d.cutW[k - 1]) || (k < d.n && d.cutW[k])) return false; // removed together with a cut word
      d.cutG[k] = d.cutG[k] ? 0 : 1;
    });
    return;
  }
  const w = e.target.closest(".w");
  if (w && state.doc && w.dataset.i !== undefined) { seek(state.doc.words[+w.dataset.i].s); state.followUntil = 0; }
});

/* ---------- fix a word's text (double-click) ---------- */
let editing = null;
script.addEventListener("dblclick", (e) => {
  const w = e.target.closest(".w");
  if (!w || !state.doc || w.dataset.i === undefined || state.exporting || state.transcribing) return;
  startWordEdit(+w.dataset.i);
});
function startWordEdit(i) {
  const el = state.wordEls[i]; if (!el) return;
  editing = { i, el, old: state.doc.words[i].t };
  $("seltool").hidden = true;
  el.contentEditable = "true"; el.spellcheck = true; el.focus();
  const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function endWordEdit(commit) {
  const ed = editing; if (!ed) return;
  editing = null;
  ed.el.contentEditable = "false"; ed.el.removeAttribute("contenteditable");
  const text = ed.el.textContent.replace(/\s+/g, " ").trim();
  if (commit && text && text !== ed.old) edit((d) => { d.words[ed.i].t = text; });
  else ed.el.textContent = ed.old;
  getSelection().removeAllRanges();
}
script.addEventListener("keydown", (e) => {
  if (!editing) return;
  if (e.key === "Enter") { e.preventDefault(); endWordEdit(true); }
  else if (e.key === "Escape") { e.preventDefault(); endWordEdit(false); }
  e.stopPropagation();
});
script.addEventListener("focusout", (e) => { if (editing && e.target === editing.el) endWordEdit(true); });
script.addEventListener("paste", (e) => { if (!editing) return; e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s+/g, " ")); });

/* =====================================================================
   Find
   ===================================================================== */
$("findBtn").onclick = () => ($("findbar").hidden ? openFind() : closeFind());
function openFind() { if (!state.doc) return; $("findbar").hidden = false; $("findBtn").setAttribute("aria-pressed", "true"); $("findInput").focus(); $("findInput").select(); }
function closeFind() { $("findbar").hidden = true; $("findBtn").setAttribute("aria-pressed", "false"); clearFind(); state.find.q = ""; }
function clearFind() { for (const el of script.querySelectorAll(".w.find")) el.classList.remove("find", "cur"); }
function runFind(q, jump = true) {
  clearFind();
  const toks = q.split(/\s+/).map(normWord).filter(Boolean);
  const f = state.find; f.q = q; f.hits = []; f.len = toks.length; f.cur = -1;
  const doc = state.doc;
  if (doc && toks.length) {
    const norm = doc.words.map((w) => normWord(w.t));
    outer: for (let i = 0; i + toks.length <= norm.length; i++) {
      for (let j = 0; j < toks.length; j++) {
        const last = j === toks.length - 1;
        if (last ? !norm[i + j].startsWith(toks[j]) : norm[i + j] !== toks[j]) continue outer;
      }
      f.hits.push(i);
    }
    for (const i of f.hits) for (let j = 0; j < f.len; j++) state.wordEls[i + j]?.classList.add("find");
  }
  if (jump && f.hits.length) gotoHit(0); else updateFindCount();
}
function gotoHit(k) {
  const f = state.find; if (!f.hits.length) return;
  for (const el of script.querySelectorAll(".w.cur")) el.classList.remove("cur");
  f.cur = (k + f.hits.length) % f.hits.length;
  const i = f.hits[f.cur];
  for (let j = 0; j < f.len; j++) state.wordEls[i + j]?.classList.add("cur");
  state.wordEls[i]?.scrollIntoView({ block: "center", behavior: "smooth" });
  seek(state.doc.words[i].s); state.followUntil = performance.now() + 2000;
  updateFindCount();
}
function updateFindCount() { const f = state.find; $("findCount").textContent = f.q.trim() ? (f.hits.length ? `${f.cur + 1 || 0} of ${f.hits.length}` : "0") : ""; }
let findTimer = 0;
$("findInput").addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind($("findInput").value), 120); });
$("findInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); gotoHit(state.find.cur + (e.shiftKey ? -1 : 1)); }
  if (e.key === "Escape") { e.preventDefault(); closeFind(); script.focus(); }
});
$("findNext").onclick = () => gotoHit(state.find.cur + 1);
$("findPrev").onclick = () => gotoHit(state.find.cur - 1);
$("findCut").onclick = () => {
  const f = state.find; if (!f.hits.length) return;
  edit((d) => { for (const i of f.hits) for (let j = 0; j < f.len; j++) d.cutW[i + j] = 1; });
  show("note", `Cut ${f.hits.length} match${f.hits.length === 1 ? "" : "es"}.`);
};

/* =====================================================================
   Playback that skips cuts
   ===================================================================== */
const PLAY = '<path d="M3 1.5v11l9-5.5z"/>', PAUSE = '<path d="M2.5 1.5h3v11h-3zM8.5 1.5h3v11h-3z"/>';
function play() {
  if (!state.file) return;
  if (state.audioFx.on && !previewGraph) ensurePreviewGraph(); // needs a user gesture, which play is
  const c = cutAt(video.currentTime, state.cuts, 0);
  if (c) video.currentTime = c[1] >= state.duration - 0.05 ? 0 : c[1];
  if (state.kept.length && video.currentTime >= state.kept[state.kept.length - 1][1] - 0.05) video.currentTime = state.kept[0][0];
  video.play().catch(() => {});
}
function pause() { video.pause(); }
function seek(t) { if (!state.file) return; video.currentTime = Math.max(0, Math.min(state.duration, t)); updateClock(); highlightNow(); drawStrip(); updateVideoCrop(); drawCapOverlay(); }
$("playBtn").onclick = () => (video.paused ? play() : pause());
video.addEventListener("play", () => { $("playIcon").innerHTML = PAUSE; $("playBtn").setAttribute("aria-label", "Pause"); loop(); });
video.addEventListener("pause", () => { $("playIcon").innerHTML = PLAY; $("playBtn").setAttribute("aria-label", "Play"); });
video.addEventListener("seeked", () => { updateClock(); highlightNow(); drawStrip(); updateVideoCrop(); drawCapOverlay(); });

function loop() {
  if (video.paused) return;
  const c = cutAt(video.currentTime, state.cuts, 0.03);
  if (c) {
    if (c[1] >= state.duration - 0.05) { video.pause(); video.currentTime = Math.max(0, c[0] - 0.01); }
    else video.currentTime = c[1];
  }
  updateClock(); highlightNow(); drawStrip(); updateVideoCrop(); drawCapOverlay();
  requestAnimationFrame(loop);
}

function updateClock() {
  const el = $("clock");
  if (!state.file) return;
  const removed = state.doc ? state.doc.removedSeconds(state.cuts) : 0;
  el.textContent = fmtTime(mapTime(video.currentTime || 0, state.cuts)) + " ";
  const s = document.createElement("span"); s.textContent = `/ ${fmtTime(state.duration - removed)}`; el.append(s);
}

function highlightNow() {
  const doc = state.doc; if (!doc) return;
  const i = doc.wordAt(video.currentTime);
  if (i === state.nowIdx) return;
  state.wordEls[state.nowIdx]?.classList.remove("now");
  state.nowIdx = i;
  const el = state.wordEls[i]; if (!el) return;
  el.classList.add("now");
  if (!video.paused && performance.now() > state.followUntil) {
    const r = el.getBoundingClientRect(), sr = script.getBoundingClientRect();
    if (r.top < sr.top + 20 || r.bottom > sr.bottom - 40) script.scrollTo({ top: script.scrollTop + r.top - sr.top - sr.height / 3, behavior: "smooth" });
  }
}

/* ---------- timeline strip ---------- */
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let stripColors = null;
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { stripColors = null; drawStrip(); });
function drawStrip() {
  const dpr = devicePixelRatio || 1, w = strip.clientWidth, h = strip.clientHeight;
  if (!w) return;
  if (strip.width !== Math.round(w * dpr) || strip.height !== Math.round(h * dpr)) { strip.width = Math.round(w * dpr); strip.height = Math.round(h * dpr); }
  stripColors ||= { bg: cssVar("--raise"), keep: cssVar("--accent"), cut: cssVar("--danger"), head: cssVar("--fg"), muted: cssVar("--muted") };
  const g = strip.getContext("2d"), C = stripColors;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = C.bg; g.beginPath(); g.roundRect ? g.roundRect(0, 0, w, h, 6) : g.rect(0, 0, w, h); g.fill();
  const D = state.duration; if (!D) return;
  const x = (t) => (t / D) * w;
  const pk = state.peaks;
  g.fillStyle = C.keep; g.globalAlpha = 0.8;
  if (pk) {
    const n = Math.floor(w / 2);
    for (let i = 0; i < n; i++) {
      const v = pk[Math.min(pk.length - 1, Math.floor((i / n) * pk.length))];
      const bh = Math.max(1, v * (h - 10)); g.fillRect(i * 2, (h - bh) / 2, 1.2, bh);
    }
  } else g.fillRect(0, h / 2 - 1, w, 2);
  g.globalAlpha = 1;
  // untranscribed part of a paused transcription
  if (state.doc && !state.doc.complete) { g.fillStyle = C.bg; g.globalAlpha = 0.6; g.fillRect(x(state.doc.limit), 0, w - x(state.doc.limit), h); g.globalAlpha = 1; }
  for (const [a, b] of state.cuts) {
    const x0 = x(a), x1 = Math.max(x0 + 1, x(b));
    g.fillStyle = C.bg; g.globalAlpha = 0.75; g.fillRect(x0, 0, x1 - x0, h);
    g.globalAlpha = 1; g.save(); g.beginPath(); g.rect(x0, 0, x1 - x0, h); g.clip();
    g.strokeStyle = C.cut; g.globalAlpha = 0.55; g.lineWidth = 1.2;
    for (let s = x0 - h; s < x1; s += 6) { g.beginPath(); g.moveTo(s, h); g.lineTo(s + h, 0); g.stroke(); }
    g.restore(); g.globalAlpha = 1;
  }
  if (state.file) { g.fillStyle = C.head; g.fillRect(Math.round(x(video.currentTime || 0)) - 1, 0, 2, h); }
}
new ResizeObserver(() => drawStrip()).observe(strip);
let scrubbing = false;
const stripSeek = (e) => { const r = strip.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * state.duration); };
strip.addEventListener("pointerdown", (e) => { if (!state.file) return; scrubbing = true; strip.setPointerCapture(e.pointerId); stripSeek(e); });
strip.addEventListener("pointermove", (e) => { if (scrubbing) stripSeek(e); });
strip.addEventListener("pointerup", () => { scrubbing = false; });
strip.addEventListener("pointercancel", () => { scrubbing = false; });

/* =====================================================================
   Captions
   ===================================================================== */
function loadCaptionPrefs() {
  try { return { ...DEFAULT_CAPTIONS, ...JSON.parse(store.get("captions", "{}")), on: false }; } catch { return { ...DEFAULT_CAPTIONS }; }
}
const SAMPLE = { s: 0, e: 2, words: [{ t: "Cut", s: 0, e: 0.3 }, { t: "the", s: 0.3, e: 0.5 }, { t: "boring", s: 0.5, e: 1.1 }, { t: "parts", s: 1.1, e: 2 }] };
function buildCaptionUI() {
  const wrap = $("capStyles");
  for (const [id, st] of Object.entries(CAPTION_STYLES)) {
    const input = document.createElement("input"); input.type = "radio"; input.name = "capStyle"; input.id = "cs-" + id; input.value = id;
    const label = document.createElement("label"); label.htmlFor = input.id;
    const c = document.createElement("canvas"); c.width = 320; c.height = 180; c.dataset.style = id;
    const name = document.createElement("span"); name.className = "cs-name"; name.textContent = st.name;
    label.append(c, name); wrap.append(input, label);
    input.addEventListener("change", () => setCaption({ style: id }));
  }
  const sw = $("capColors");
  CAPTION_COLORS.forEach((hex, i) => {
    const input = document.createElement("input"); input.type = "radio"; input.name = "capColor"; input.id = "cc" + i; input.value = hex;
    const label = document.createElement("label"); label.htmlFor = input.id; label.style.background = hex; label.title = hex;
    const sr = document.createElement("span"); sr.className = "sr"; sr.textContent = `Colour ${hex}`; label.append(sr);
    sw.append(input, label);
    input.addEventListener("change", () => setCaption({ color: hex }));
  });
  for (const [name, key] of [["capPos", "pos"], ["capSize", "size"], ["capLen", "length"]])
    for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.addEventListener("change", () => setCaption({ [key]: r.value }));
  $("capOn").addEventListener("change", () => setCaption({ on: $("capOn").checked }));
  $("capLead").addEventListener("input", () => { paintLead(); setCaption({ lead: +$("capLead").value }); });
  setupCaptionDrag();
  $("xCap").addEventListener("change", () => setCaption({ on: $("xCap").checked }));
}
function drawStyleTiles() {
  for (const c of $("capStyles").querySelectorAll("canvas")) {
    const g = c.getContext("2d"), grd = g.createLinearGradient(0, 0, 0, c.height);
    grd.addColorStop(0, "#3a4458"); grd.addColorStop(1, "#151820");
    g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
    drawCaptions(g, c.width, c.height, 0.6, [SAMPLE], { ...state.captions, style: c.dataset.style, pos: "middle", size: "l", length: "long", scale: 1.7 });
  }
}
function syncCaptionUI() {
  const c = state.captions;
  $("capOn").checked = c.on; $("xCap").checked = c.on; $("capBody").hidden = !c.on;
  const set = (name, v) => { const el = document.querySelector(`input[name="${name}"][value="${v}"]`); if (el) el.checked = true; };
  set("capStyle", c.style); set("capSize", c.size); set("capLen", c.length); set("capColor", c.color);
  for (const r of document.querySelectorAll('input[name="capPos"]')) r.checked = r.value === c.pos; // none checked when dragged ("custom")
  const lead = $("capLead"); lead.value = c.lead ?? 0.15; paintLead();
  $("xCapStyle").textContent = `· ${CAPTION_STYLES[c.style]?.name || ""}`;
  $("capSub").textContent = !state.doc ? "Transcribe the video to add animated captions." : c.on ? `${CAPTION_STYLES[c.style].name} style, ${state.capCues.length} caption${state.capCues.length === 1 ? "" : "s"}.` : "Animated word by word and burned into the export.";
  const enabled = !!state.doc?.n;
  $("capOn").disabled = !enabled || !!state.exporting; $("xCap").disabled = !enabled;
}
function setCaption(patch, force = false) {
  const before = JSON.stringify(state.captions);
  Object.assign(state.captions, patch);
  if (!force && JSON.stringify(state.captions) === before) return;
  store.set("captions", JSON.stringify({ ...state.captions, on: undefined }));
  if ("color" in patch) drawStyleTiles();
  afterEdit();
}
let capW = 0, capH = 0;
function drawCapOverlay() {
  const cv = $("capCanvas"), dpr = devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (!w || !h) return;
  if (w !== capW || h !== capH) { cv.width = capW = w; cv.height = capH = h; }
  const g = cv.getContext("2d");
  g.clearRect(0, 0, w, h);
  capBox = state.captions.on && state.capCues.length && state.file ? drawCaptions(g, w, h, video.currentTime || 0, state.capCues, state.captions) : null;
  placeHandle();
}
function paintLead() {
  const el = $("capLead"), v = +el.value;
  el.style.setProperty("--p", ((v - el.min) / (el.max - el.min)) * 100 + "%");
  $("capLeadVal").textContent = Math.abs(v) < 0.001 ? "as transcribed" : `${Math.abs(v).toFixed(2)} s ${v > 0 ? "earlier" : "later"}`;
}

/* ---------- drag the caption to position it ---------- */
let capBox = null, capDrag = null;
function placeHandle() {
  const hd = $("capHandle"), cv = $("capCanvas");
  if (!capBox) { if (!capDrag) hd.hidden = true; return; }
  const k = cv.clientWidth / cv.width;
  hd.hidden = false;
  Object.assign(hd.style, { left: capBox.x * k + "px", top: capBox.y * k + "px", width: capBox.w * k + "px", height: capBox.h * k + "px" });
  hd.setAttribute("aria-valuetext", `${Math.round(state.captions.pos === "custom" ? state.captions.x * 100 : 50)}% across, ${state.captions.pos === "custom" ? Math.round(state.captions.y * 100) + "% down" : state.captions.pos}`);
}
function currentCenter() {
  const cv = $("capCanvas");
  if (state.captions.pos === "custom") return [state.captions.x, state.captions.y];
  return capBox ? [(capBox.x + capBox.w / 2) / cv.width, (capBox.y + capBox.h / 2) / cv.height] : [0.5, 0.82];
}
function moveCaption(x, y, live) {
  const snap = Math.abs(x - 0.5) < 0.025;
  if (snap) x = 0.5;
  $("capGuide").hidden = !(live && snap);
  x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
  if (live) { Object.assign(state.captions, { pos: "custom", x, y }); drawCapOverlay(); for (const r of document.querySelectorAll('input[name="capPos"]')) r.checked = false; }
  else setCaption({ pos: "custom", x, y }, true);
}
function setupCaptionDrag() {
  const hd = $("capHandle"), player = $("player");
  hd.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || state.exporting) return;
    e.preventDefault(); hd.setPointerCapture(e.pointerId);
    const r = player.getBoundingClientRect(), [cx, cy] = currentCenter();
    capDrag = { dx: (e.clientX - r.left) / r.width - cx, dy: (e.clientY - r.top) / r.height - cy, moved: false };
    hd.classList.add("dragging");
  });
  hd.addEventListener("pointermove", (e) => {
    if (!capDrag) return;
    const r = player.getBoundingClientRect();
    capDrag.moved = true;
    moveCaption((e.clientX - r.left) / r.width - capDrag.dx, (e.clientY - r.top) / r.height - capDrag.dy, true);
  });
  const end = () => {
    if (!capDrag) return;
    const moved = capDrag.moved; capDrag = null;
    hd.classList.remove("dragging"); $("capGuide").hidden = true;
    if (moved) moveCaption(state.captions.x, state.captions.y, false); // save
  };
  hd.addEventListener("pointerup", end); hd.addEventListener("pointercancel", end);
  hd.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.05 : 0.01, [x, y] = currentCenter();
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    moveCaption(x + d[0], y + d[1], false);
  });
}
new ResizeObserver(() => drawCapOverlay()).observe($("capCanvas"));
/** For the exporter: maps cues through the final ranges and returns the per-frame draw function. */
function captionOverlay() {
  if (!state.captions.on || !state.capCues.length) return null;
  const opts = { ...state.captions }, cues = state.capCues;
  return (ranges) => {
    const timed = mapCues(cues, rangeMapper(ranges));
    return (ctx, t, w, h) => drawCaptions(ctx, w, h, t, timed, opts);
  };
}

/* =====================================================================
   Reframe (vertical / square, follows the face)
   ===================================================================== */
const needsTracking = () => !!state.file && state.reframe.aspect !== "orig" && state.reframe.follow === "face" && !state.faceSamples;
function rebuildPath() {
  state.rfPath = state.faceSamples && state.reframe.aspect !== "orig" ? buildPath(state.faceSamples, state.srcW, state.srcH, state.reframe.aspect) : null;
}
function setReframe(patch) {
  Object.assign(state.reframe, patch);
  rebuildPath(); syncReframeUI(); applyFrame(); updateResOptions(); updateExportInfo(); afterEdit();
  if (needsTracking()) ensureTracking().catch(() => {});
}
for (const r of document.querySelectorAll('input[name="rfAspect"]')) r.addEventListener("change", () => setReframe({ aspect: r.value }));
for (const r of document.querySelectorAll('input[name="rfFollow"]')) r.addEventListener("change", () => setReframe({ follow: r.value }));
$("rfPos").addEventListener("input", () => { state.reframe.offset = +$("rfPos").value; paintPos(); updateVideoCrop(); drawCapOverlay(); });
$("rfPos").addEventListener("change", () => setReframe({ offset: +$("rfPos").value }));
function paintPos() {
  const el = $("rfPos"), v = +el.value; el.style.setProperty("--p", v * 100 + "%");
  const ax = cropGeometry(state.srcW || 16, state.srcH || 9, state.reframe.aspect).axis;
  $("rfPosVal").textContent = Math.abs(v - 0.5) < 0.02 ? "Centre" : ax === "y" ? (v < 0.5 ? "Higher" : "Lower") : (v < 0.5 ? "Left" : "Right");
}
function syncReframeUI() {
  const r = state.reframe;
  for (const el of document.querySelectorAll('input[name="rfAspect"]')) { el.checked = el.value === r.aspect; el.disabled = !state.file || !!state.exporting; }
  for (const el of document.querySelectorAll('input[name="rfFollow"]')) { el.checked = el.value === r.follow; el.disabled = !!state.exporting; }
  $("rfBody").hidden = r.aspect === "orig";
  $("rfPosGroup").hidden = r.follow !== "fixed";
  $("rfPos").value = r.offset; paintPos();
  const note = $("rfNote");
  if (r.aspect !== "orig" && r.follow === "face" && state.rfPath) {
    const cov = state.rfPath.coverage;
    note.hidden = false;
    note.textContent = cov >= 0.3 ? `Face found in ${Math.round(cov * 100)}% of the video. The frame follows it smoothly and cuts with the shots.`
      : "Few faces were found, so the frame stays centred. Switch to Fixed to choose the framing yourself.";
  } else note.hidden = true;
  if (!state.file) $("rfSub").textContent = "Make vertical or square versions for Shorts, Reels and TikTok.";
  else if (r.aspect === "orig") $("rfSub").textContent = "Make vertical or square versions for Shorts, Reels and TikTok.";
  else { const [w, h] = reframeSize(state.srcW, state.srcH, r.aspect, "orig"); $("rfSub").textContent = `${r.aspect} crop of ${w}×${h} px from the ${state.srcW}×${state.srcH} source.`; }
}
/** Sizes the player to the chosen shape. */
function applyFrame() {
  const pl = $("player"), a = ASPECTS[state.reframe.aspect];
  if (!state.file) return;
  if (!a) { pl.classList.remove("reframed"); pl.style.aspectRatio = `${state.srcW} / ${state.srcH}`; pl.style.width = ""; video.style.objectPosition = ""; }
  else { pl.classList.add("reframed"); pl.style.aspectRatio = String(a); pl.style.width = `min(100%, calc(62vh * ${a}))`; }
  updateVideoCrop(); drawCapOverlay();
}
/** Pans the preview: with object-fit: cover, object-position selects the crop window. */
function updateVideoCrop() {
  if (!state.file || state.reframe.aspect === "orig") return;
  const [x, y, w, h] = cropAt(state.reframe, state.rfPath, state.srcW, state.srcH, video.currentTime || 0);
  const px = w < 1 ? (x / (1 - w)) * 100 : 50, py = h < 1 ? (y / (1 - h)) * 100 : 50;
  video.style.objectPosition = `${px.toFixed(3)}% ${py.toFixed(3)}%`;
}
async function ensureTracking() {
  if (!needsTracking()) return;
  if (!state.rfJob) {
    const ac = new AbortController(), key = state.key;
    const job = { abort: () => ac.abort() };
    job.promise = (async () => {
      $("rfProgress").hidden = false;
      try {
        const samples = await trackFaces(state.inputTrack || (await state.input.getPrimaryVideoTrack()), state.duration, (p) => {
          $("rfFill").style.width = (p * 100).toFixed(1) + "%"; $("rfStatus").textContent = "Finding faces…"; $("rfPct").textContent = Math.round(p * 100) + "%";
        }, ac.signal);
        if (state.key !== key) return;
        state.faceSamples = samples; rebuildPath(); afterEdit();
      } catch (e) {
        if (e?.name !== "AbortError") { console.error(e); show("err", friendly(e)); setReframe({ follow: "fixed" }); }
        throw e;
      } finally {
        if (state.rfJob === job) state.rfJob = null;
        $("rfProgress").hidden = true; syncReframeUI(); updateVideoCrop(); drawCapOverlay();
      }
    })();
    state.rfJob = job;
  }
  return state.rfJob.promise;
}

/* =====================================================================
   Studio voice (audio enhancement)
   ===================================================================== */
function loadAudioPrefs() {
  try { return { ...DEFAULT_AUDIO, ...JSON.parse(store.get("audio", "{}")), on: false }; } catch { return { ...DEFAULT_AUDIO }; }
}
function setAudio(patch) {
  const before = JSON.stringify(state.audioFx);
  Object.assign(state.audioFx, patch);
  if (JSON.stringify(state.audioFx) === before) return;
  store.set("audio", JSON.stringify({ ...state.audioFx, on: undefined }));
  syncAudioUI(); configurePreview(); afterEdit();
  if (state.audioFx.on) { ensurePreviewGraph(); ensureAudio().catch(() => {}); }
}
for (const [name, key] of [["audTone", "tone"], ["audNoise", "noise"], ["audLoud", "loudness"]])
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.addEventListener("change", () => setAudio({ [key]: r.value }));
$("audOn").addEventListener("change", () => setAudio({ on: $("audOn").checked }));
$("xAud").addEventListener("change", () => setAudio({ on: $("xAud").checked }));

function noiseFloorDb(profile) {
  const P = profile.power, N = profile.n; let sum = 0;
  for (let k = 1; k < P.length - 1; k++) sum += 2 * P[k];
  return 10 * Math.log10(Math.max(1e-12, sum / N / (0.375 * N)));
}
function syncAudioUI() {
  const a = state.audioFx, ok = !!state.atrack;
  $("audOn").disabled = !ok || !!state.exporting; $("audOn").checked = a.on; $("xAud").checked = a.on; $("xAud").disabled = !ok;
  $("audBody").hidden = !a.on;
  const set = (name, v) => { const el = document.querySelector(`input[name="${name}"][value="${v}"]`); if (el) el.checked = true; };
  set("audTone", a.tone); set("audNoise", a.noise); set("audLoud", a.loudness);
  $("xAudStyle").textContent = `· ${VOICE_TONES[a.tone]?.name}${a.loudness !== "off" ? `, ${a.loudness.replace("-", "−")} LUFS` : ""}`;
  if (!state.file) $("audSub").textContent = "Remove background noise and get a close-mic podcast sound.";
  else if (!ok) $("audSub").textContent = "This video has no audio Wetnix can read.";
  else $("audSub").textContent = a.on ? "Playback and export use the enhanced sound." : "Remove background noise and get a close-mic podcast sound.";
  const ready = audioReady();
  $("audCompare").disabled = !ready || !previewGraph;
  const st = $("audStats");
  if (a.on && state.audioBase) {
    const b = state.audioBase, g = ready ? gainsFor(b, state.chainLufs[chainKey(a)], a) : null;
    const out = g ? (g.target ?? b.rawLufs) : null;
    const nr = NOISE_LEVELS[a.noise];
    st.hidden = false;
    st.innerHTML = "";
    for (const [k, v] of [["Loudness", `${fmtDb(b.rawLufs)} → ${out != null ? fmtDb(out) : "…"}`], ["Room noise", `${fmtDb(noiseFloorDb(b.profile))} dB`], ["Noise cut", nr ? `up to ${nr.floorDb} dB` : "off"]]) {
      const d = document.createElement("div"), sp = document.createElement("span"), bb = document.createElement("b");
      sp.textContent = k; bb.textContent = v; d.append(sp, bb); st.append(d);
    }
  } else st.hidden = true;
}
const fmtDb = (v) => (Number.isFinite(v) ? v.toFixed(1).replace("-", "−") : "—");
const audioReady = () => !!(state.audioBase && Number.isFinite(state.chainLufs[chainKey(state.audioFx)]));

/** Runs whatever analysis the current settings still need; resolves to the gains. */
async function ensureAudio(signal) {
  if (!state.atrack) throw new Error("No audio track.");
  const want = chainKey(state.audioFx), key = state.key;
  if (state.audioJob && state.audioJob.want !== want) { state.audioJob.abort(); state.audioJob = null; }
  if (!audioReady()) {
    if (!state.audioJob) {
      const ac = new AbortController();
      const job = { want, abort: () => ac.abort(), promise: null };
      const prog = (label) => (p) => { $("audProgress").hidden = false; $("audFill").style.width = (p * 100).toFixed(1) + "%"; $("audStatus").textContent = label; $("audPct").textContent = Math.round(p * 100) + "%"; };
      job.promise = (async () => {
        try {
          if (!state.audioBase) {
            const base = await analyzeBase(state.atrack, state.duration, prog("Listening to the room noise…"), ac.signal);
            if (state.key !== key) return;
            state.audioBase = base; state.chainLufs = {};
            if (!state.peaks && base.peaks) { state.peaks = base.peaks; drawStrip(); }
          }
          const settings = { ...state.audioFx };
          const lufs = await analyzeChain(state.atrack, state.duration, state.audioBase, settings, prog("Measuring loudness…"), ac.signal);
          if (state.key !== key) return;
          state.chainLufs[chainKey(settings)] = lufs;
          afterEdit(); // saves the analysis with the project
        } finally {
          if (state.audioJob === job) state.audioJob = null;
          $("audProgress").hidden = true;
          syncAudioUI(); configurePreview();
        }
      })();
      state.audioJob = job;
    }
    const job = state.audioJob;
    if (signal) signal.addEventListener("abort", () => {}, { once: true });
    await job.promise;
    if (!audioReady()) return ensureAudio(signal); // settings changed while analysing
  }
  return gainsFor(state.audioBase, state.chainLufs[want], state.audioFx);
}

/* ---------- live preview through an AudioWorklet ---------- */
let audioCtx = null, previewGraph = null, previewNode = null;
async function ensurePreviewGraph() {
  if (previewGraph || audioCtx === false) return previewGraph;
  try {
    audioCtx = new AudioContext();
    await audioCtx.audioWorklet.addModule(new URL("../audio/voice-worklet.js", import.meta.url));
    const src = audioCtx.createMediaElementSource(video);
    previewNode = new AudioWorkletNode(audioCtx, "lumen-voice", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    src.connect(previewNode).connect(audioCtx.destination);
    previewGraph = true;
    configurePreview(); syncAudioUI();
  } catch (e) { console.warn("Live audio preview unavailable", e); audioCtx = false; }
  return previewGraph;
}
function configurePreview() {
  if (!previewNode) return;
  const a = state.audioFx, ready = a.on && audioReady();
  const g = ready ? gainsFor(state.audioBase, state.chainLufs[chainKey(a)], a) : null;
  previewNode.port.postMessage({ type: "config", on: ready, settings: { ...a }, profile: ready ? state.audioBase.profile : null, pre: g?.pre ?? 0, post: g?.post ?? 0 });
}
video.addEventListener("play", () => { if (audioCtx && audioCtx.state === "suspended") audioCtx.resume(); });
{
  const cmp = $("audCompare");
  const hold = (v) => { previewNode?.port.postMessage({ type: "bypass", value: v }); cmp.classList.toggle("held", v); cmp.textContent = v ? "Playing the original" : "Hold to hear the original"; };
  cmp.addEventListener("pointerdown", (e) => { e.preventDefault(); cmp.setPointerCapture(e.pointerId); hold(true); if (video.paused) play(); });
  for (const ev of ["pointerup", "pointercancel"]) cmp.addEventListener(ev, () => hold(false));
  cmp.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); hold(true); if (video.paused) play(); } });
  cmp.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") hold(false); });
}

/* =====================================================================
   Keyboard
   ===================================================================== */
window.addEventListener("keydown", (e) => {
  if (editing) return;
  const tag = e.target.tagName;
  // text entry blocks editing shortcuts; checkboxes, radios and buttons don't
  const typing = e.target.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" ||
    (tag === "INPUT" && !/^(checkbox|radio|range|button|submit|file|color)$/.test(e.target.type));
  const control = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag); // Space activates these natively
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (dlg.open) return;
  if (mod && k === "f" && state.doc) { e.preventDefault(); openFind(); return; }
  if (mod && k === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === "y" && !typing) { e.preventDefault(); redo(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && !typing) { if (applySelection("toggle")) e.preventDefault(); return; }
  if (e.key === " " && !typing && !control && state.file) { e.preventDefault(); video.paused ? play() : pause(); return; }
  if (e.key === "Escape") { getSelection().removeAllRanges(); $("seltool").hidden = true; }
});

/* =====================================================================
   Export dialog
   ===================================================================== */
for (const name of ["res", "fmt"]) {
  const saved = store.get("edit." + name); const el = saved && document.querySelector(`input[name="${name}"][value="${saved}"]`); if (el) el.checked = true;
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.addEventListener("change", () => { store.set("edit." + name, r.value); updateExportInfo(); });
}
$("exportOpen").onclick = () => { if (!state.file) return; pause(); updateResOptions(); updateExportInfo(); syncCaptionUI(); syncAudioUI(); dlg.showModal(); };
$("exportClose").onclick = () => dlg.close();
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click on backdrop

function outDims() {
  const res = val("res");
  if (state.reframe.aspect !== "orig" && state.srcW) return reframeSize(state.srcW, state.srcH, state.reframe.aspect, res);
  if (res === "orig" || !state.srcW) return [even(state.srcW), even(state.srcH)];
  return targetSize(state.srcW, state.srcH, res).slice(0, 2);
}
function updateResOptions() {
  for (const r of document.querySelectorAll('input[name="res"]')) {
    const shrinks = r.value !== "orig" && !!state.srcW && (state.reframe.aspect !== "orig"
      ? +r.value < cropShortSide(state.srcW, state.srcH, state.reframe.aspect) - 1
      : targetSize(state.srcW, state.srcH, r.value)[2] < 0.999);
    r.disabled = !!state.exporting || shrinks;
    if (shrinks && r.checked) $("rOrig").checked = true;
  }
}
function updateExportInfo() {
  if (!state.file) { $("oDims").textContent = "—"; $("oLen").textContent = "—"; return; }
  const [w, h] = outDims();
  const shape = state.reframe.aspect !== "orig" ? ` · ${state.reframe.aspect}` : "";
  $("oDims").textContent = `${w}×${h}${shape}` + (val("res") === "orig" ? "" : ` · upscaled`);
  const len = state.kept.reduce((s, [a, b]) => s + b - a, 0);
  $("oLen").textContent = fmtTime(len) + (len < state.duration - 0.05 ? ` (from ${fmtTime(state.duration)})` : "");
}
function clearResult() {
  $("result").hidden = true;
  $("exportBtn").textContent = "Export video"; $("exportBtn").classList.add("primary"); $("exportBtn").classList.remove("ghost");
  if (state.out?.url) URL.revokeObjectURL(state.out.url);
  $("resultVideo").removeAttribute("src"); $("resultVideo").load();
  state.out = null;
  $("exportOpen").textContent = "Export"; $("exportOpen").classList.remove("exporting");
}

$("exportBtn").addEventListener("click", () => state.exporting ? state.exporting.abort() : doExport());

async function doExport() {
  if (!state.file || busy()) return;
  const ranges = state.kept;
  if (!ranges.length) { show("xErr", "Everything is cut. Restore some words to export."); return; }
  show("xErr", ""); show("xNote", ""); clearResult(); pause();
  const ac = new AbortController(); state.exporting = ac;
  const [ow, oh] = outDims(), fmt = val("fmt"), res = val("res"), upscale = res !== "orig";
  setExporting(true);
  const wake = await navigator.wakeLock?.request("screen").catch(() => null);
  const t0 = performance.now(), total = ranges.reduce((s, [a, b]) => s + b - a, 0);
  try {
    if (state.captions.on && state.capCues.length) await loadCaptionFonts();
    if (needsTracking()) { $("xEta").textContent = "finding faces…"; await ensureTracking(); }
    const rf = { ...state.reframe }, rfPath = state.rfPath, srcW = state.srcW, srcH = state.srcH;
    const cropFn = rf.aspect !== "orig" ? (t) => cropAt(rf, rfPath, srcW, srcH, t) : null;
    let audioFx = null;
    if (state.audioFx.on && state.atrack) {
      $("xEta").textContent = "analyzing audio…";
      const g = await ensureAudio(ac.signal);
      audioFx = { settings: { ...state.audioFx }, profile: state.audioBase.profile, pre: g.pre, post: g.post };
    }
    const { blob, codec, audio, audioNote } = await exportEdit({
      file: state.file, ranges, fmt, ow, oh, quality: QUALITY.high, sharp: upscale ? 0.5 : 0, colorFix: state.colorFix, signal: ac.signal, overlay: captionOverlay(), audioFx, cropAt: cropFn,
      onProgress: (p, { frames }) => {
        const el = (performance.now() - t0) / 1000;
        $("xFill").style.width = (p * 100).toFixed(1) + "%"; $("xPct").textContent = Math.floor(p * 100) + "%";
        $("xFps").textContent = (frames / Math.max(el, 0.001)).toFixed(1);
        $("xEta").textContent = p > 0.02 ? `${fmtTime(el / p - el)} left` : "starting…";
        $("exportOpen").textContent = `Exporting ${Math.floor(p * 100)}%`;
      },
    });
    const secs = (performance.now() - t0) / 1000;
    const base = state.file.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) || "video";
    const url = URL.createObjectURL(blob);
    state.out = { blob, url, name: `${base}_edited${upscale ? "_" + RES_NAME[res] : ""}.${fmt}` };
    $("resultVideo").src = url;
    $("resultTitle").textContent = `${ow}×${oh} · ${CODEC_NAMES[codec] || codec}${audio ? " + " + (CODEC_NAMES[audio] || audio) : ""} · ${fmtTime(total)}`;
    $("resultSize").textContent = fmtBytes(blob.size);
    $("resultTime").textContent = `made in ${fmtTime(secs)}`;
    $("result").hidden = false;
    if (audioNote) show("xNote", audioNote);
    if (!dlg.open) dlg.showModal();
    $("exportOpen").textContent = "Export ready";
  } catch (e) {
    if (e instanceof ExportCancelled) show("xNote", "Export cancelled.");
    else { console.error(e); show("xErr", friendly(e)); if (!dlg.open) dlg.showModal(); }
    $("exportOpen").textContent = "Export";
  } finally {
    wake?.release?.().catch(() => {});
    state.exporting = null; setExporting(false);
  }
}
function setExporting(b) {
  $("xProgress").hidden = !b;
  $("exportBtn").textContent = b ? "Cancel export" : (state.out ? "Export again" : "Export video");
  const primary = !b && !state.out; // once a result exists, "Save video" is the primary action
  $("exportBtn").classList.toggle("primary", primary); $("exportBtn").classList.toggle("ghost", !primary);
  $("exportOpen").classList.toggle("exporting", b);
  for (const el of document.querySelectorAll('input[name="fmt"]')) el.disabled = b;
  if (b) { $("xFill").style.width = "0"; $("xPct").textContent = "0%"; $("xFps").textContent = "0"; $("xEta").textContent = "starting…"; }
  updateResOptions(); setToolsEnabled(); syncAudioUI(); syncCaptionUI(); syncReframeUI();
}

$("saveBtn").onclick = async () => { if (!state.out) return; try { await saveBlob(state.out.blob, state.out.name); } catch (e) { show("xErr", e.message); } };
const baseName = () => state.file?.name.replace(/\.[^.]+$/, "") || "transcript";
$("srtBtn").onclick = async () => { if (!state.doc) return; try { await saveBlob(new Blob([toSRT(captionCues(state.doc, state.cuts))], { type: "text/plain" }), `${baseName()}_edited.srt`); } catch (e) { show("xErr", e.message); } };
$("txtBtn").onclick = async () => { if (!state.doc) return; try { await saveBlob(new Blob([toText(state.doc) + "\n"], { type: "text/plain" }), `${baseName()}_edited.txt`); } catch (e) { show("xErr", e.message); } };

window.addEventListener("beforeunload", (e) => { if (busy()) { e.preventDefault(); e.returnValue = ""; } });

/* =====================================================================
   Boot
   ===================================================================== */
if (checkSupport()) {
  renderExample(); drawStrip(); setToolsEnabled();
  buildCaptionUI(); syncCaptionUI(); drawStyleTiles(); syncReframeUI();
  loadCaptionFonts().then(() => { drawStyleTiles(); drawCapOverlay(); });
}
window.__edit = { state, loadFile, transcribe, doExport, undo, redo, applySelection, edit, runFind };
