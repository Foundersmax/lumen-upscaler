// Edit page: transcript-based video editing.
import { Input, ALL_FORMATS, BlobSource, CanvasSink } from "../../vendor/mediabunny.min.mjs";
import { Doc, sanitizeWords, normWord, mapTime, cutAt, captionCues, toSRT, toText } from "./transcript.js";
import { analyzeBase, analyzeChain, chainKey, gainsFor } from "./enhance.js";
import { ASPECTS, DEFAULT_REFRAME, cropGeometry, reframeSize, cropShortSide, trackFaces, buildPath, centerAt, cropAt } from "./reframe.js";
import { DEFAULT_AUDIO, NOISE_LEVELS, VOICE_TONES } from "../audio/dsp.js";
import { sentences, aiScenes, pauseScenes, buildScenes, sceneRanges, slug } from "./scenes.js";
import { AIError, PROVIDERS } from "./ai.js";
import { aiHighlights, buildHighlights, nudgeClip } from "./highlights.js";
import { CAPTION_STYLES, CAPTION_COLORS, DEFAULT_CAPTIONS, buildCues, mapCues, rangeMapper, drawCaptions, loadCaptionFonts } from "./captions.js";
import { extractAudio16k, peaks as computePeaks, ASR_RATE } from "./audio.js";
import { exportEdit, ExportCancelled } from "./export.js";
import { getProject, putProject, projectKey, findProject, findProjectKey, listProjects, touchMeta, deleteProject, backupBlob, readBackup, restoreBackup, BACKUP_EXT } from "./store.js";
import { probeClip, joinClips, mergeDocs, canCopy, joinSize } from "./join.js";
import { voiceSegments, embedWindow, wordSpeakers, talkTime, defaultName, MAX_SPEAKERS } from "./speakers.js";
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
  scenes: [], highlights: [], sceneJob: null, playUntil: 0,
  joining: null, joinedFile: null,
  speakers: null, spkJob: null, spkSig: "",
  transcribing: null, exporting: null, out: null, loadId: 0,
};
const busy = () => !!(state.transcribing || state.exporting || state.joining);
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
let pendingPick = null;
/** Lets the user choose files. @returns {Promise<File[]|null>} null if cancelled */
function chooseFiles({ multiple = true } = {}) {
  return new Promise((resolve) => {
    pendingPick?.(null); pendingPick = resolve;
    const input = $("file"); input.multiple = multiple;
    input.click();
  });
}
async function pickFile() {
  if (busy()) return;
  const files = await chooseFiles();
  if (files) openFiles(files);
}
$("file").addEventListener("change", (e) => {
  const files = [...e.target.files]; e.target.value = ""; e.target.multiple = true;
  if (pendingPick) { const r = pendingPick; pendingPick = null; r(files); }
  else openFiles(files);
});
$("file").addEventListener("cancel", () => { const r = pendingPick; pendingPick = null; r?.(null); });
/** One file opens directly; several open the Join dialog; project backups are imported. */
function openFiles(files) {
  const backups = files.filter(isBackupFile);
  if (backups.length) { importBackups(backups); return; }
  const vids = files.filter(isVideoFile);
  const list = vids.length ? vids : files.slice(0, 1);
  if (list.length > 1) openJoin(list);
  else if (list.length) loadFile(list[0]);
}
const isBackupFile = (f) => f.name.toLowerCase().endsWith(BACKUP_EXT);
/* =====================================================================
   Recent projects and backups
   ===================================================================== */
let projects = [];
const projDlg = $("projDlg");
$("projectsBtn").onclick = () => { renderProjDlg(); projDlg.showModal(); refreshProjects(); };
$("projClose").onclick = () => projDlg.close();
projDlg.addEventListener("click", (e) => { if (e.target === projDlg) projDlg.close(); });

async function refreshProjects() {
  projects = await listProjects().catch(() => []);
  renderHome();
  if (projDlg.open) renderProjDlg();
}
/** Before a video is open: the recent projects, or the example transcript for first-time visitors. */
function renderHome() {
  if (state.file) return;
  if (!projects.length) { renderExample(); return; }
  script.hidden = false; script.textContent = "";
  const wrap = document.createElement("div"); wrap.className = "proj-home";
  const head = document.createElement("div"); head.className = "proj-head";
  const h = document.createElement("h2"); h.textContent = "Recent projects";
  head.append(h, importButton());
  wrap.append(head, projectList(), projNote());
  script.append(wrap);
}
function renderProjDlg() {
  const body = $("projDlgBody"); body.textContent = "";
  if (!projects.length) { const p = document.createElement("p"); p.className = "help"; p.textContent = "No saved projects yet."; body.append(p); }
  else body.append(projectList());
  const acts = document.createElement("div"); acts.className = "actions"; acts.append(importButton(true));
  body.append(acts, projNote());
}
function projNote() {
  const p = document.createElement("p"); p.className = "help proj-note";
  p.textContent = `Projects are saved in this browser (transcript and edits, not the video). To move one to another computer, download its backup (${BACKUP_EXT}) and drop it on the editor there.`;
  return p;
}
function importButton(big = false) {
  const b = document.createElement("button"); b.type = "button";
  b.className = big ? "btn ghost" : "linkbtn"; b.textContent = "Import backup";
  b.onclick = () => $("backupFile").click();
  return b;
}
$("backupFile").addEventListener("change", (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) importBackups(fs); });

const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) { const d = Math.floor(s / 86400); return d === 1 ? "yesterday" : `${d} days ago`; }
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};
const isOpen = (m) => !!state.file && m.key === state.key;

function projectList() {
  const ul = document.createElement("ul"); ul.className = "proj-list";
  for (const m of projects) {
    const li = document.createElement("li"); li.className = "proj" + (isOpen(m) ? " current" : ""); li.dataset.key = m.key;
    const open = document.createElement("button"); open.type = "button"; open.className = "proj-open";
    open.setAttribute("aria-label", isOpen(m) ? `${m.name} (open now)` : `Open ${m.name}`);
    open.disabled = isOpen(m);
    open.onclick = () => openRecent(m);
    const th = document.createElement("span"); th.className = "proj-thumb";
    if (m.thumb) { const img = document.createElement("img"); img.src = m.thumb; img.alt = ""; th.append(img); }
    else th.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="m8.5 8 4 2-4 2z" fill="currentColor"/></svg>';
    if (m.duration) { const d = document.createElement("span"); d.className = "proj-dur"; d.textContent = fmtTime(m.duration); th.append(d); }
    const tx = document.createElement("span"); tx.className = "proj-text";
    const name = document.createElement("b"); name.className = "proj-name"; name.textContent = m.name;
    const sub = document.createElement("span"); sub.className = "proj-sub";
    const bits = [];
    if (m.words) {
      bits.push(`${m.words.toLocaleString()} words`);
      if (m.transcribed < 0.995) bits.push(`${Math.floor(m.transcribed * 100)}% transcribed`);
      if (m.cutWords >= 0.5) bits.push(`${fmtTime(m.cutWords)} cut`);
    } else bits.push("Not transcribed yet");
    if (m.highlights) bits.push(`${m.highlights} highlight${m.highlights === 1 ? "" : "s"}`);
    if (m.scenes) bits.push(`${m.scenes} scenes`);
    if (m.speakers) bits.push(`${m.speakers} speaker${m.speakers === 1 ? "" : "s"}`);
    sub.textContent = bits.join(" · ");
    const when = document.createElement("span"); when.className = "proj-when";
    const at = Math.max(m.savedAt || 0, m.openedAt || 0);
    when.textContent = isOpen(m) ? "Open now" : at ? `${m.savedAt >= (m.openedAt || 0) ? "Edited" : "Opened"} ${ago(at)}` : "";
    tx.append(name, sub, when);
    open.append(th, tx);
    const acts = document.createElement("span"); acts.className = "proj-acts";
    const dl = document.createElement("button"); dl.type = "button"; dl.className = "tool icon"; dl.title = "Download backup";
    dl.setAttribute("aria-label", `Download backup of ${m.name}`);
    dl.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7"/><path d="M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11"/></svg>';
    dl.disabled = !m.savedAt;
    if (!m.savedAt) dl.title = "Nothing to back up until the video is transcribed or edited";
    dl.onclick = () => downloadBackup(m);
    const del = document.createElement("button"); del.type = "button"; del.className = "tool icon danger"; del.title = "Remove from this browser";
    del.setAttribute("aria-label", `Remove ${m.name} from this browser`);
    const trash = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>';
    del.innerHTML = trash;
    del.disabled = isOpen(m);
    if (isOpen(m)) del.title = "Open another video to remove this one";
    let armed = 0;
    del.onclick = async () => {
      if (!armed) { // ask once: the button turns into "Remove?" for a few seconds
        del.classList.add("armed"); del.textContent = "Remove?"; del.setAttribute("aria-label", `Confirm: remove ${m.name}`);
        armed = setTimeout(() => { armed = 0; del.classList.remove("armed"); del.innerHTML = trash; del.setAttribute("aria-label", `Remove ${m.name} from this browser`); }, 4000);
        return;
      }
      clearTimeout(armed);
      await deleteProject(m.key);
      announce(`Removed ${m.name}.`);
      await refreshProjects();
    };
    acts.append(dl, del);
    li.append(open, acts);
    ul.append(li);
  }
  return ul;
}
/** Messages for the Projects views go to the dialog when it's open, otherwise to the page note. */
function announce(msg, isErr = false) {
  if (projDlg.open) {
    let el = $("projMsg");
    if (!el) { el = document.createElement("div"); el.id = "projMsg"; $("projDlgBody").prepend(el); }
    el.className = isErr ? "err" : "note"; el.setAttribute("role", isErr ? "alert" : "status"); el.hidden = false; el.textContent = msg;
  } else { show(isErr ? "err" : "note", msg); if (isErr) show("note", ""); }
}

/** Reopens a recent project by asking for its video. (Keeping file handles for one-click reopening was left
 *  out: in testing, reading a stored handle back crashed Chrome 153 in private-style profiles.) */
async function openRecent(m) {
  if (busy()) { announce("Finish or cancel the current task before opening another video.", true); return; }
  announce(`Choose "${m.name}" to reopen this project.`);
  const f = (await chooseFiles({ multiple: false }))?.[0];
  if (!f) { announce(""); return; }
  if (f.name !== m.name || f.size !== m.size) {
    announce(`That's "${f.name}". To reopen this project, choose "${m.name}" (${fmtBytes(m.size)}), the video it was made from.`, true);
    return;
  }
  projDlg.close();
  await loadFile(f);
}

/** Records that a video was opened, for the Recent list (with a thumbnail). */
async function noteOpened(file) {
  const key = state.key;
  const meta = await touchMeta(key, { name: file.name, size: file.size, lastModified: file.lastModified, duration: state.duration, w: state.srcW, h: state.srcH, openedAt: Date.now() }).catch(() => null);
  if (meta && !meta.thumb) {
    const thumb = await makeThumb().catch(() => null);
    if (thumb && state.key === key) await touchMeta(key, { thumb }).catch(() => {});
  }
  refreshProjects();
}
/** A small JPEG of a frame near the start, for the Recent list. */
async function makeThumb() {
  const vt = await state.input.getPrimaryVideoTrack();
  const sink = new CanvasSink(vt, { width: 192, height: 108, fit: "cover", poolSize: 1 });
  const r = await sink.getCanvas(Math.min(state.duration * 0.1, 5));
  if (!r) return null;
  const c = r.canvas;
  const blob = c.convertToBlob ? await c.convertToBlob({ type: "image/jpeg", quality: 0.72 }) : await new Promise((res) => c.toBlob(res, "image/jpeg", 0.72));
  return blob && new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
}

async function downloadBackup(m) {
  try {
    if (m.key === state.key) await flushSave();
    const blob = await backupBlob(m.key);
    await saveBlob(blob, m.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) + BACKUP_EXT);
  } catch (e) { console.error(e); announce(e.message || friendly(e), true); }
}

async function importBackups(files) {
  let done = 0, last = null;
  for (const f of files) {
    try {
      const b = await readBackup(f);
      const name = b.meta.name || b.key.split("|")[0];
      if (b.existing && (b.existing.savedAt || 0) > (b.project.savedAt || 0)) {
        const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
        if (!confirm(`This browser has newer edits for "${name}" (${when(b.existing.savedAt)}) than the backup (${when(b.project.savedAt || 0)}).\n\nReplace them with the backup?`)) continue;
      }
      if (b.key === state.key) await flushSave();
      await restoreBackup(b);
      done++; last = { ...b, name };
    } catch (e) { console.error(e); announce(e.message || friendly(e), true); return; }
  }
  if (!done) return;
  await refreshProjects();
  if (last.key === state.key && state.file && !busy()) { await loadFile(state.file); show("note", `Imported the backup of "${last.name}".`); return; }
  if (state.file && !projDlg.open) { renderProjDlg(); projDlg.showModal(); }
  announce(done === 1 ? `Imported "${last.name}". Click it in the list to open it with its video.` : `Imported ${done} projects. Click one to open it with its video.`);
}

const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv|ts|mts)$/i.test(f.name);

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; if (!busy()) $("drop").classList.add("on"); });
window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("drop").classList.remove("on"); } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $("drop").classList.remove("on");
  const files = [...e.dataTransfer.files];
  if ($("joinDlg").open) { addClips(files.filter(isVideoFile)); return; }
  openFiles(files);
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
      doc: null, cuts: [], kept: [[0, duration]], peaks: null, audio: null, undo: [], redo: [], nowIdx: -1, captions: loadCaptionPrefs(), capCues: [], audioFx: loadAudioPrefs(), audioBase: null, chainLufs: {}, reframe: { ...DEFAULT_REFRAME }, faceSamples: null, rfPath: null, scenes: [], highlights: [], speakers: null,
      url: URL.createObjectURL(file),
    });
    $("player").style.aspectRatio = `${state.srcW} / ${state.srcH}`;
    video.src = state.url; show("videoMsg", "");
    $("empty").hidden = true; $("playBtn").disabled = false;
    $("filebar").hidden = false;
    $("saveJoinedBtn").hidden = file !== state.joinedFile;
    const fname = $("fileName"); fname.textContent = ""; fname.title = file.name;
    const b = document.createElement("b"); b.textContent = file.name;
    fname.append(b, ` · ${state.srcW}×${state.srcH} · ${fmtTime(duration)}`);
    $("exportOpen").disabled = false;
    updateResOptions();

    state.audioJob?.abort(); state.audioJob = null; state.rfJob?.abort(); state.rfJob = null;
    // a copy of a file opened before (same name and size) continues that project rather than starting a second one
    const foundKey = await findProjectKey(file);
    if (foundKey) state.key = foundKey;
    const saved = foundKey ? await getProject(foundKey) : null;
    noteOpened(file);
    if (saved?.audioFx) state.audioFx = { ...DEFAULT_AUDIO, ...saved.audioFx };
    if (saved?.audioBase?.profile?.power) { state.audioBase = saved.audioBase; state.chainLufs = saved.chainLufs || {}; }
    syncAudioUI(); configurePreview();
    if (state.audioFx.on) ensureAudio().catch(() => {});
    if (saved?.reframe) state.reframe = { ...DEFAULT_REFRAME, ...saved.reframe };
    if (saved?.faceSamples) state.faceSamples = saved.faceSamples;
    if (Array.isArray(saved?.scenes)) state.scenes = saved.scenes;
    if (Array.isArray(saved?.highlights)) state.highlights = saved.highlights;
    if (Array.isArray(saved?.speakers?.names)) state.speakers = saved.speakers;
    renderScenes(); renderHighlights();
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
  const spk = state.speakers, spOf = (k) => doc.words[k]?.sp ?? -1;
  const newPara = (k) => {
    if (p) frag.append(p);
    p = document.createElement("p"); inPara = 0;
    if (k >= doc.n) return;
    const st = document.createElement("span"); st.className = "stamp"; st.dataset.t = doc.words[k].s; st.textContent = fmtTime(doc.words[k].s);
    if (spk && (k === 0 || spOf(k) !== spOf(k - 1))) {
      const head = document.createElement("span"); head.className = "p-head";
      head.append(speakerChip(spOf(k), k), st); p.append(head);
    } else p.append(st);
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
    if (k > 0 && k < doc.n && inPara > 0 && ((spk && spOf(k) !== spOf(k - 1)) || gd >= 1.5 || (/[.?!]$/.test(prev) && (gd >= 0.6 || inPara > 70)))) newPara(k);
    if (gd >= SHOW_GAP && (k < doc.n || doc.complete)) p.append(gapEl(k), " ");
    if (k === doc.n) break;
    const s = document.createElement("span"); s.className = "w"; s.dataset.i = k; s.textContent = doc.words[k].t;
    state.wordEls[k] = s; p.append(s, " "); inPara++;
  }
  frag.append(p);
  script.append(frag);
  state.spkSig = speakerSig();
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

let pendingSave = null;
/** Saves now if a save is waiting (before a backup is made from the project). */
async function flushSave() { clearTimeout(persistTimer); await pendingSave?.(); }
let persistTimer = 0;
function afterEdit(persist = true) {
  const doc = state.doc;
  state.cuts = doc ? doc.cutIntervals() : [];
  state.kept = doc ? doc.keptRanges(state.cuts) : (state.duration ? [[0, state.duration]] : []);
  state.capCues = doc ? buildCues(doc, state.captions, (t) => mapTime(t, state.cuts)) : [];
  if (doc && speakerSig() !== state.spkSig) { renderScript(); if ($("spkDlg").open) renderSpeakers(); }
  updateClasses(); drawStrip(); updateStats(); updateExportInfo(); updateClock(); updateResume(); setToolsEnabled(); drawCapOverlay(); syncCaptionUI();
  if (persist && state.key) {
    clearTimeout(persistTimer);
    $("saved").textContent = "Saving…";
    const key = state.key, snapshot = { doc: doc ? doc.toJSON() : null, peaks: state.peaks, captions: state.captions, audioFx: state.audioFx, audioBase: state.audioBase, chainLufs: state.chainLufs, reframe: state.reframe, faceSamples: state.faceSamples, scenes: state.scenes, highlights: state.highlights, speakers: state.speakers };
    pendingSave = async () => {
      pendingSave = null;
      const ok = await putProject(key, snapshot);
      $("saved").textContent = ok === null ? "Not saved in this browser" : "Saved";
    };
    persistTimer = setTimeout(() => pendingSave?.(), 400);
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
  $("scenesBtn").disabled = $("highlightsBtn").disabled = !state.doc?.n || !!state.transcribing;
  $("speakersBtn").disabled = !state.doc?.n || !!state.transcribing;
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
  const chip = e.target.closest(".spk-chip");
  if (chip && state.doc) { e.preventDefault(); const k = +chip.dataset.k; openSpkMenu(chip, k, turnEnd(k)); return; }
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
video.addEventListener("pause", () => { state.playUntil = 0; $("playIcon").innerHTML = PLAY; $("playBtn").setAttribute("aria-label", "Play"); });
video.addEventListener("seeked", () => { updateClock(); highlightNow(); drawStrip(); updateVideoCrop(); drawCapOverlay(); });

function loop() {
  if (video.paused) return;
  if (state.playUntil && video.currentTime >= state.playUntil - 0.03) { video.pause(); return; } // end of a scene preview
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
function captionOverlay(on = state.captions.on) {
  if (!on || !state.capCues.length) return null;
  const opts = { ...state.captions }, cues = state.capCues;
  return (ranges) => {
    // only captions inside the exported span (a scene exports part of the video)
    const lo = ranges[0]?.[0] ?? 0, hi = ranges.at(-1)?.[1] ?? Infinity;
    const timed = mapCues(cues.filter((c) => c.s >= lo - 0.05 && c.e <= hi + 0.05), rangeMapper(ranges));
    return (ctx, t, w, h) => drawCaptions(ctx, w, h, t, timed, opts);
  };
}

/* =====================================================================
   Reframe (vertical / square, follows the face)
   ===================================================================== */
const needsTracking = (aspect = state.reframe.aspect) => !!state.file && aspect !== "orig" && state.reframe.follow === "face" && !state.faceSamples;
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
async function ensureTracking(aspect) {
  if (!needsTracking(aspect)) return;
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
   Scenes and Highlights: separate videos from one long one
   ===================================================================== */
const scDlg = $("scenesDlg");
function openScenes(mode) {
  if (!state.doc?.n) return;
  pause(); setScMode(mode); syncScenesUI(); syncHlUI(); scDlg.showModal();
}
$("scenesBtn").onclick = () => openScenes("scenes");
$("highlightsBtn").onclick = () => openScenes("highlights");
$("scenesClose").onclick = () => scDlg.close();
scDlg.addEventListener("click", (e) => { if (e.target === scDlg) scDlg.close(); });
function setScMode(mode) {
  for (const r of document.querySelectorAll('input[name="scMode"]')) r.checked = r.value === mode;
  $("scenesPane").hidden = mode !== "scenes"; $("hlPane").hidden = mode !== "highlights";
  $("scenesTitle").textContent = mode === "scenes" ? "Scenes" : "Highlights";
  show("scNote", ""); show("scErr", "");
  syncScenesUI(); syncHlUI();
}
for (const r of document.querySelectorAll('input[name="scMode"]')) r.addEventListener("change", () => setScMode(r.value));
const scMode = () => val("scMode");

// AI provider and keys (stored only in this browser)
const AI_FIELDS = { claude: ["claudeKey", "claudeModel"], openai: ["openaiKey", "openaiModel"] };
for (const [prov, [k, m]] of Object.entries(AI_FIELDS)) {
  $(k).value = store.get(k, ""); $(m).value = store.get(m, PROVIDERS[prov].model);
  $(k).addEventListener("change", () => store.set(k, $(k).value.trim()));
  $(m).addEventListener("change", () => { $(m).value = $(m).value.trim() || PROVIDERS[prov].model; store.set(m, $(m).value); });
}
for (const [prov, id] of [["claude", "claudeForget"], ["openai", "openaiForget"]]) {
  $(id).onclick = () => { $(AI_FIELDS[prov][0]).value = ""; try { localStorage.removeItem("lumen." + AI_FIELDS[prov][0]); } catch {} show("scNote", `Your ${PROVIDERS[prov].name} key was removed from this browser.`); };
}
{ // default to Claude, unless only an OpenAI key was saved before Claude was an option
  const saved = store.get("aiProvider") || (store.get("openaiKey") && !store.get("claudeKey") ? "openai" : "claude");
  const el = document.querySelector(`input[name="aiProv"][value="${saved}"]`); if (el) el.checked = true;
}
const aiProvider = () => val("aiProv") || "claude";
function syncProvider() {
  const p = aiProvider();
  $("claudeFields").hidden = p !== "claude"; $("openaiFields").hidden = p !== "openai";
  $("aiSummary").textContent = PROVIDERS[p].name + ($(AI_FIELDS[p][0]).value.trim() ? "" : " · add your key");
  for (const el of document.querySelectorAll(".ai-name")) el.textContent = PROVIDERS[p].name;
}
for (const r of document.querySelectorAll('input[name="aiProv"]')) r.addEventListener("change", () => { store.set("aiProvider", r.value); syncProvider(); });
for (const id of ["claudeKey", "openaiKey"]) $(id).addEventListener("input", syncProvider);
syncProvider();
/** The chosen provider's key and model, or null (after pointing the user at the key field). */
function aiAuth() {
  const provider = aiProvider(), [k, m] = AI_FIELDS[provider], key = $(k).value.trim();
  if (!key) {
    $("aiSettings").open = true; $(k).focus();
    show("scErr", `Add your ${PROVIDERS[provider].company} API key first (it stays in this browser).`);
    return null;
  }
  store.set(k, key);
  return { provider, key, model: $(m).value.trim() || PROVIDERS[provider].model, url: provider === "claude" ? globalThis.__wetnixClaudeUrl : globalThis.__wetnixOpenAIUrl };
}

for (const name of ["scCount", "hlCount", "hlLen"]) {
  const saved = store.get(name); const el = saved && document.querySelector(`input[name="${name}"][value="${saved}"]`); if (el) el.checked = true;
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.addEventListener("change", () => store.set(name, r.value));
}
for (const id of ["hlVert", "hlCaps"]) {
  const saved = store.get(id); if (saved != null) $(id).checked = saved === "1";
  $(id).addEventListener("change", () => store.set(id, $(id).checked ? "1" : "0"));
}

function setSceneProgress(text, p = null, right = "") {
  $("scProgress").hidden = !text;
  if (!text) return;
  $("scStatus").textContent = text; $("scRight").textContent = right;
  $("scFill").style.width = p == null ? "30%" : (p * 100).toFixed(1) + "%";
  $("scFill").classList.toggle("indeterminate", p == null);
}
function syncScenesUI() {
  const on = scMode() === "scenes", has = state.scenes.length > 0, job = !!state.sceneJob, exporting = !!state.exporting;
  $("scenesSetup").hidden = has;
  $("sceneList").hidden = !on; $("sceneActions").hidden = !on || !has; $("scenesFoot").hidden = !on || !has;
  $("aiSettings").hidden = on ? has : state.highlights.length > 0;
  $("scenesLead").textContent = has ? `${state.scenes.length} scenes. Rename them here; the titles become the file names.` : "Split this video into self-contained parts and export each one as its own video.";
  $("aiScenesBtn").disabled = $("pauseScenesBtn").disabled = job || exporting;
  $("redoScenes").disabled = job || exporting;
  $("exportAllScenes").textContent = state.sceneExport === "scenes" ? "Cancel" : `Export all ${state.scenes.length} scenes`;
  $("exportAllScenes").classList.toggle("primary", state.sceneExport !== "scenes"); $("exportAllScenes").classList.toggle("ghost", state.sceneExport === "scenes");
  $("exportAllScenes").disabled = state.sceneExport !== "scenes" && (job || exporting);
  for (const b of $("sceneList").querySelectorAll(".scene-export")) b.disabled = job || exporting;
  for (const el of document.querySelectorAll('input[name="scMode"]')) el.disabled = job || exporting;
}

async function findScenes(useAI) {
  if (!state.doc?.n || state.sceneJob) return;
  show("scErr", ""); show("scNote", "");
  const sents = sentences(state.doc);
  if (!sents.length) { show("scErr", "Everything is cut, so there's nothing to split."); return; }
  const count = val("scCount"), duration = state.duration;
  if (!useAI) {
    state.scenes = buildScenes(sents, pauseScenes(sents, duration, count), duration);
    afterScenes(`Split into ${state.scenes.length} parts at natural pauses.`);
    return;
  }
  const auth = aiAuth(); if (!auth) return;
  const ac = new AbortController(); state.sceneJob = ac; syncScenesUI(); syncHlUI();
  setSceneProgress(`Asking ${PROVIDERS[auth.provider].name} to find the scenes…`);
  try {
    const picks = await aiScenes({ ...auth, sents, duration, count, signal: ac.signal, names: spkNames() });
    state.scenes = buildScenes(sents, picks, duration);
    afterScenes(`Found ${state.scenes.length} scenes.`);
  } catch (e) {
    if (e?.name !== "AbortError") { console.error(e); show("scErr", e instanceof AIError ? e.message : friendly(e)); }
  } finally {
    state.sceneJob = null; setSceneProgress(""); syncScenesUI(); syncHlUI();
  }
}
function afterScenes(note) { renderScenes(); show("scNote", note); afterEdit(); }
$("aiScenesBtn").onclick = () => findScenes(true);
$("pauseScenesBtn").onclick = () => findScenes(false);
$("redoScenes").onclick = () => { state.scenes = []; renderScenes(); show("scNote", ""); show("scErr", ""); afterEdit(); };

/** Seconds of a clip that are still in the edit. */
const keptIn = (clip) => sceneRanges(state.kept, clip).reduce((s, [a, b]) => s + b - a, 0);
function playClip(clip) { scDlg.close(); seek(clip.start); state.followUntil = 0; play(); state.playUntil = clip.end; }
function clipButtons(clip, onExport, cls) {
  const btns = document.createElement("div"); btns.className = "scene-btns";
  const playB = document.createElement("button"); playB.type = "button"; playB.className = "tool scene-play"; playB.textContent = "Play";
  playB.onclick = () => playClip(clip);
  const expB = document.createElement("button"); expB.type = "button"; expB.className = `tool ${cls}`; expB.textContent = "Export";
  expB.onclick = onExport;
  btns.append(playB, expB);
  return btns;
}

function renderScenes() {
  const list = $("sceneList"); list.textContent = "";
  state.scenes.forEach((sc, i) => {
    const li = document.createElement("li"); li.className = "scene"; li.dataset.i = i;
    const head = document.createElement("div"); head.className = "scene-head";
    const n = document.createElement("span"); n.className = "scene-n"; n.textContent = i + 1;
    const title = document.createElement("input"); title.className = "scene-title"; title.value = sc.title; title.maxLength = 80; title.setAttribute("aria-label", `Title of scene ${i + 1}`);
    title.addEventListener("change", () => { sc.title = title.value.trim() || `Part ${i + 1}`; title.value = sc.title; afterEdit(); });
    const chip = document.createElement("span"); chip.className = "chip";
    chip.textContent = `${fmtTime(sc.start)}–${fmtTime(sc.end)} · ${fmtTime(keptIn(sc))}`;
    head.append(n, title, chip);
    li.append(head);
    if (sc.summary) { const p = document.createElement("p"); p.className = "scene-sum"; p.textContent = sc.summary; li.append(p); }
    li.append(clipButtons(sc, () => exportClips("scenes", [i]), "scene-export"));
    list.append(li);
  });
  syncScenesUI();
}

$("exportAllScenes").onclick = () => state.sceneExport ? state.exporting?.abort() : exportClips("scenes", state.scenes.map((_, i) => i));

/* ---------- Highlights ---------- */
function syncHlUI() {
  const on = scMode() === "highlights", has = state.highlights.length > 0, job = !!state.sceneJob, exporting = !!state.exporting;
  $("hlSetup").hidden = has;
  $("hlList").hidden = !on; $("hlOpts").hidden = !on || !has; $("hlActions").hidden = !on || !has; $("hlFoot").hidden = !on || !has;
  if (on) $("aiSettings").hidden = has;
  $("hlLead").textContent = has ? `${state.highlights.length} highlight${state.highlights.length === 1 ? "" : "s"}, best first. Rename, trim or play them, then export.`
    : "Find the moments that work on their own, ready to post as Shorts, Reels or TikToks.";
  $("hlFind").disabled = job || exporting; $("hlRedo").disabled = job || exporting;
  $("hlExportAll").textContent = state.sceneExport === "highlights" ? "Cancel" : `Export all ${state.highlights.length} highlight${state.highlights.length === 1 ? "" : "s"}`;
  $("hlExportAll").classList.toggle("primary", state.sceneExport !== "highlights"); $("hlExportAll").classList.toggle("ghost", state.sceneExport === "highlights");
  $("hlExportAll").disabled = state.sceneExport !== "highlights" && (job || exporting);
  for (const b of $("hlList").querySelectorAll(".hl-export, .hl-trim .tool")) b.disabled = job || exporting;
  $("hlVert").disabled = $("hlCaps").disabled = exporting;
  $("hlCapStyle").textContent = `· ${CAPTION_STYLES[state.captions.style]?.name || ""}`;
}

async function findHighlights() {
  if (!state.doc?.n || state.sceneJob) return;
  show("scErr", ""); show("scNote", "");
  const sents = sentences(state.doc);
  if (!sents.length) { show("scErr", "Everything is cut, so there's nothing to pick from."); return; }
  const auth = aiAuth(); if (!auth) return;
  const count = val("hlCount"), length = val("hlLen"), duration = state.duration;
  const ac = new AbortController(); state.sceneJob = ac; syncScenesUI(); syncHlUI();
  setSceneProgress(`${PROVIDERS[auth.provider].name} is watching for the best moments…`, null, "usually under a minute");
  try {
    const picks = await aiHighlights({ ...auth, sents, duration, count, length, signal: ac.signal, names: spkNames() });
    state.highlights = buildHighlights(sents, picks, duration, length, count === "auto" ? 8 : +count);
    if (!state.highlights.length) throw new AIError("None of the suggested clips matched the transcript. Try again.");
    renderHighlights(); afterEdit();
    const fewer = count !== "auto" && state.highlights.length < +count;
    show("scNote", `Found ${state.highlights.length} highlight${state.highlights.length === 1 ? "" : "s"}.` + (fewer ? " That's all the strong moments in this video." : ""));
  } catch (e) {
    if (e?.name !== "AbortError") { console.error(e); show("scErr", e instanceof AIError ? e.message : friendly(e)); }
  } finally {
    state.sceneJob = null; setSceneProgress(""); syncScenesUI(); syncHlUI();
  }
}
$("hlFind").onclick = findHighlights;
$("hlRedo").onclick = () => { state.highlights = []; renderHighlights(); show("scNote", ""); show("scErr", ""); afterEdit(); };
$("hlExportAll").onclick = () => state.sceneExport ? state.exporting?.abort() : exportClips("highlights", state.highlights.map((_, i) => i));

function trimHighlight(i, edge, dir) {
  const h = state.highlights[i], next = nudgeClip(sentences(state.doc), h, edge, dir, state.duration);
  if (!next) { show("scNote", edge === "start" ? "The start can't move further that way." : "The end can't move further that way."); return; }
  Object.assign(h, next); show("scNote", "");
  renderHighlights(); afterEdit();
  $("hlList").querySelector(`[data-i="${i}"] [data-trim="${edge}${dir}"]`)?.focus();
}

function renderHighlights() {
  const list = $("hlList"); list.textContent = "";
  state.highlights.forEach((h, i) => {
    const li = document.createElement("li"); li.className = "scene"; li.dataset.i = i;
    const head = document.createElement("div"); head.className = "scene-head";
    const n = document.createElement("span"); n.className = "scene-n"; n.textContent = i + 1;
    const title = document.createElement("input"); title.className = "scene-title"; title.value = h.title; title.maxLength = 80; title.setAttribute("aria-label", `Title of highlight ${i + 1}`);
    title.addEventListener("change", () => { h.title = title.value.trim() || `Highlight ${i + 1}`; title.value = h.title; afterEdit(); });
    const score = document.createElement("span"); score.className = "hl-score" + (h.score >= 8 ? " hi" : ""); score.textContent = `${h.score}/10`;
    score.title = "How likely the clip is to hold a viewer, according to the AI";
    const chip = document.createElement("span"); chip.className = "chip";
    const kept = keptIn(h);
    chip.textContent = `${fmtTime(h.start)} · ${fmtTime(kept)}${kept < h.end - h.start - 0.3 ? " after cuts" : ""}`;
    head.append(n, title, score, chip);
    li.append(head);
    if (h.reason) { const p = document.createElement("p"); p.className = "scene-sum"; p.textContent = h.reason; li.append(p); }
    const btns = clipButtons(h, () => exportClips("highlights", [i]), "hl-export");
    const trim = document.createElement("div"); trim.className = "hl-trim";
    for (const [edge, label] of [["start", "Start"], ["end", "End"]]) {
      const s = document.createElement("span"); s.textContent = label; trim.append(s);
      for (const dir of [-1, 1]) {
        const b = document.createElement("button"); b.type = "button"; b.className = "tool"; b.dataset.trim = `${edge}${dir}`;
        b.textContent = dir < 0 ? "−" : "+";
        b.setAttribute("aria-label", `${label} of highlight ${i + 1}: ${dir < 0 ? "one sentence earlier" : "one sentence later"}`);
        b.title = dir < 0 ? "One sentence earlier" : "One sentence later";
        b.onclick = () => trimHighlight(i, edge, dir);
        trim.append(b);
      }
    }
    btns.append(trim); li.append(btns);
    list.append(li);
  });
  syncHlUI();
}

/** Exports scenes or highlights one after another, each as its own file. */
async function exportClips(kind, indices) {
  if (!state.file || busy() || !indices.length) return;
  const clips = kind === "scenes" ? state.scenes : state.highlights, list = $(kind === "scenes" ? "sceneList" : "hlList");
  const noun = kind === "scenes" ? "scene" : "highlight";
  const opts = kind === "highlights" ? { aspect: $("hlVert").checked ? "9:16" : state.reframe.aspect, captions: $("hlCaps").checked } : {};
  show("scErr", ""); show("scNote", ""); pause();
  const ac = new AbortController(); state.exporting = ac; state.sceneExport = kind;
  setExporting(true); syncScenesUI(); syncHlUI();
  const wake = await navigator.wakeLock?.request("screen").catch(() => null);
  let done = 0, skipped = 0;
  try {
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k], sc = clips[i];
      for (const li of list.children) li.classList.toggle("active", +li.dataset.i === i);
      const ranges = sceneRanges(state.kept, sc);
      if (!ranges.length) { skipped++; continue; }
      const label = indices.length > 1 ? `Exporting ${noun} ${i + 1} (${k + 1} of ${indices.length})` : `Exporting ${noun} ${i + 1}`;
      setSceneProgress(label, 0, "starting…");
      const t0 = performance.now();
      const r = await renderEdit(ranges, ac.signal, (p, { status }) => {
        if (status) { setSceneProgress(label, 0, status); return; }
        const el = (performance.now() - t0) / 1000;
        setSceneProgress(label, p, p > 0.02 ? `${fmtTime(el / p - el)} left` : `${Math.floor(p * 100)}%`);
        $("exportOpen").textContent = `${kind === "scenes" ? "Scene" : "Clip"} ${k + 1}/${indices.length} · ${Math.floor(p * 100)}%`;
      }, opts);
      const name = `${fileBase()}_${kind === "highlights" ? "highlight-" : ""}${String(i + 1).padStart(2, "0")}_${slug(sc.title)}.${r.fmt}`;
      await saveBlob(r.blob, name);
      done++;
      if (r.audioNote) show("scErr", r.audioNote);
    }
    show("scNote", `Exported ${done} ${noun}${done === 1 ? "" : "s"}.` + (skipped ? ` ${skipped} skipped because everything in ${skipped === 1 ? "it is" : "them is"} cut.` : ""));
  } catch (e) {
    if (e instanceof ExportCancelled) show("scNote", `Export cancelled${done ? ` after ${done} ${noun}${done === 1 ? "" : "s"}` : ""}.`);
    else { console.error(e); show("scErr", friendly(e)); }
  } finally {
    wake?.release?.().catch(() => {});
    for (const li of list.children) li.classList.remove("active");
    state.exporting = null; state.sceneExport = false; setSceneProgress("");
    setExporting(false); $("exportOpen").textContent = "Export"; syncScenesUI(); syncHlUI();
  }
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

function outDims(aspect = state.reframe.aspect) {
  const res = val("res");
  if (aspect !== "orig" && state.srcW) return reframeSize(state.srcW, state.srcH, aspect, res);
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

/**
 * Renders the given source ranges with every current setting (size, format, captions, reframe,
 * Studio voice). Shared by Export and scene export. Caller owns state.exporting.
 */
/* =====================================================================
   Join clips: several videos become one source for the editor
   ===================================================================== */
const join = { clips: [], reading: 0, seq: 0 };
const jdlg = $("joinDlg");
const ICON = {
  grip: '<svg viewBox="0 0 12 12" fill="currentColor"><circle cx="4" cy="2.5" r="1.1"/><circle cx="8" cy="2.5" r="1.1"/><circle cx="4" cy="6" r="1.1"/><circle cx="8" cy="6" r="1.1"/><circle cx="4" cy="9.5" r="1.1"/><circle cx="8" cy="9.5" r="1.1"/></svg>',
  up: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m3.5 8.5 3.5-3.5 3.5 3.5"/></svg>',
  down: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m3.5 5.5 3.5 3.5 3.5-3.5"/></svg>',
  x: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m3.5 3.5 7 7M10.5 3.5l-7 7"/></svg>',
};

function openJoin(files, withCurrent = false) {
  if (busy()) { show("err", "Finish or cancel the current task before joining clips."); return; }
  join.clips = []; show("jErr", ""); setJoinProgress("");
  renderClips();
  if (!jdlg.open) jdlg.showModal();
  addClips(withCurrent && state.file ? [state.file, ...files] : files);
}
$("addClipsBtn").onclick = () => { if (busy()) return; openJoin([], true); $("clipFiles").click(); };
$("addMoreClips").onclick = () => $("clipFiles").click();
$("clipFiles").addEventListener("change", (e) => { const fs = [...e.target.files]; e.target.value = ""; addClips(fs); });
$("joinClose").onclick = () => jdlg.close();
jdlg.addEventListener("click", (e) => { if (e.target === jdlg && !state.joining) jdlg.close(); });
jdlg.addEventListener("close", () => state.joining?.abort());
$("saveJoinedBtn").onclick = async () => { if (!state.joinedFile) return; try { await saveBlob(state.joinedFile, state.joinedFile.name); } catch (e) { show("err", e.message); } };

async function addClips(files) {
  if (!files.length) return;
  join.reading++; syncJoinUI();
  const errs = [];
  for (const f of files) {
    try {
      const info = await probeClip(f);
      const saved = await findProject(f).catch(() => null);
      const d = saved?.doc?.words?.length && Math.abs(saved.doc.duration - info.end) < 0.5 ? saved.doc : null;
      info.tx = !d ? "" : (d.limit ?? d.duration) >= info.end - 0.25 ? "Transcribed" : "Partly transcribed";
      info.saved = saved; info.doc = d; info.id = ++join.seq;
      join.clips.push(info);
      renderClips();
    } catch (e) { errs.push(e.message || String(e)); }
  }
  join.reading--;
  show("jErr", errs.join(" "));
  syncJoinUI();
}

function renderClips() {
  const ol = $("clipList"); ol.textContent = "";
  join.clips.forEach((c, i) => {
    const li = document.createElement("li"); li.className = "clip"; li.dataset.id = c.id;
    const grip = document.createElement("span"); grip.className = "clip-grip"; grip.innerHTML = ICON.grip; grip.setAttribute("aria-hidden", "true");
    grip.addEventListener("pointerdown", (e) => dragClip(e, li));
    const n = document.createElement("span"); n.className = "clip-n"; n.textContent = i + 1;
    const info = document.createElement("div"); info.className = "clip-info";
    const name = document.createElement("div"); name.className = "clip-name"; name.textContent = c.name; name.title = c.name;
    const meta = document.createElement("div"); meta.className = "clip-meta";
    meta.append(Object.assign(document.createElement("span"), { textContent: `${c.w}×${c.h}` }), Object.assign(document.createElement("span"), { textContent: fmtTime(c.duration) }));
    if (!c.acodec) meta.append(Object.assign(document.createElement("span"), { textContent: "no sound" }));
    if (c.tx) meta.append(Object.assign(document.createElement("span"), { className: "tx", textContent: c.tx }));
    info.append(name, meta);
    const btns = document.createElement("div"); btns.className = "clip-btns";
    const mk = (cls, label, icon, fn, dis) => { const b = document.createElement("button"); b.type = "button"; b.className = "tool " + cls; b.innerHTML = icon; b.setAttribute("aria-label", `${label}: ${c.name}`); b.title = label; b.disabled = dis || !!state.joining; b.onclick = fn; return b; };
    btns.append(
      mk("up", "Move up", ICON.up, () => moveClip(i, i - 1), i === 0),
      mk("down", "Move down", ICON.down, () => moveClip(i, i + 1), i === join.clips.length - 1),
      mk("rm", "Remove", ICON.x, () => { join.clips.splice(i, 1); renderClips(); syncJoinUI(); }),
    );
    li.append(grip, n, info, btns);
    ol.append(li);
  });
  syncJoinUI();
}
function moveClip(from, to) {
  if (to < 0 || to >= join.clips.length || state.joining) return;
  const [c] = join.clips.splice(from, 1); join.clips.splice(to, 0, c);
  renderClips();
  $("clipList").children[to]?.querySelector(to < from ? ".up" : ".down")?.focus();
}
/** Pointer drag (mouse and touch): the row follows the pointer; the order is read back from the list on release.
 *  Listens on the window because moving the row in the DOM drops pointer capture. */
function dragClip(e, li) {
  if (state.joining || e.button > 0) return;
  e.preventDefault();
  const ol = $("clipList"); li.classList.add("dragging");
  const move = (ev) => {
    for (const other of ol.children) {
      if (other === li) continue;
      const r = other.getBoundingClientRect();
      if (ev.clientY > r.top && ev.clientY < r.bottom) {
        ol.insertBefore(li, ev.clientY < r.top + r.height / 2 ? other : other.nextSibling);
        break;
      }
    }
  };
  const up = () => {
    removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
    li.classList.remove("dragging");
    const order = [...ol.children].map((x) => +x.dataset.id);
    join.clips.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    renderClips();
  };
  addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
}

function syncJoinUI() {
  const n = join.clips.length, job = !!state.joining;
  $("clipReading").hidden = !join.reading;
  $("addMoreClips").disabled = job;
  $("joinBtn").disabled = !job && (n < 2 || join.reading > 0);
  $("joinBtn").textContent = job ? "Cancel" : n >= 2 ? `Join ${n} clips` : "Join clips";
  $("joinBtn").classList.toggle("primary", !job); $("joinBtn").classList.toggle("ghost", job);
  $("joinTotal").textContent = n ? `${n} clip${n === 1 ? "" : "s"} · ${fmtTime(join.clips.reduce((t, c) => t + c.duration, 0))}` : "";
  const mode = $("joinMode");
  if (n < 2) { mode.hidden = true; return; }
  mode.hidden = false; mode.textContent = "";
  const b = document.createElement("b");
  if (canCopy(join.clips)) {
    b.textContent = "Lossless join. ";
    mode.append(b, "These clips share the same format, so they're joined without re-encoding: no quality loss, and it only takes a moment.");
  } else {
    const [W, H] = joinSize(join.clips), first = join.clips[0];
    const shape = join.clips.some((c) => Math.abs(c.w / c.h - first.w / first.h) > 0.01);
    b.textContent = "Re-encoded at high quality. ";
    mode.append(b, `These clips were recorded with different settings, so they're converted to ${W}×${H}${shape ? ", with black bars on clips of a different shape" : ""}. This takes about as long as an export.`);
  }
}
function setJoinProgress(label, p, right = "") {
  $("jProgress").hidden = !label;
  if (!label) return;
  $("jStatus").textContent = label; $("jRight").textContent = right;
  $("jFill").style.width = ((p || 0) * 100).toFixed(1) + "%";
}

$("joinBtn").onclick = () => state.joining ? state.joining.abort() : doJoin();
async function doJoin() {
  if (join.clips.length < 2 || busy()) return;
  show("jErr", "");
  const clips = join.clips.slice(), ac = new AbortController();
  state.joining = ac; renderClips();
  const wake = await navigator.wakeLock?.request("screen").catch(() => null);
  const t0 = performance.now();
  try {
    const label = canCopy(clips) ? "Joining…" : "Joining and re-encoding…";
    setJoinProgress(label, 0, "starting…");
    const r = await joinClips({ clips, signal: ac.signal, onProgress: (p) => {
      const el = (performance.now() - t0) / 1000;
      setJoinProgress(label, p, p > 0.03 ? `${fmtTime(el / p - el)} left` : `${Math.floor(p * 100)}%`);
    } });
    const duration = r.offsets.at(-1) + clips.at(-1).duration;
    const merged = mergeDocs(clips.map((c) => c.doc), clips, r.offsets, duration);
    const first = clips[0].saved || {};
    const seed = { doc: merged, captions: first.captions, audioFx: first.audioFx, reframe: first.reframe ? { ...first.reframe } : undefined };
    if (merged || first.captions || first.audioFx || first.reframe) await putProject(projectKey(r.file), seed);
    state.joining = null; state.joinedFile = r.file;
    jdlg.close();
    await loadFile(r.file);
    const kept = clips.filter((c) => c.tx).length;
    show("note", `Joined ${clips.length} clips into one ${fmtTime(duration)} video${r.mode === "copy" ? " without re-encoding" : ""}.` +
      (merged ? ` Kept the transcript from ${kept === 1 ? "1 clip" : `${kept} clips`}${merged.limit < duration - 0.25 ? "; press Resume to transcribe the rest" : ""}.` : "") +
      " Use “Save joined video” to keep a copy, so you can reopen this project later.");
  } catch (e) {
    if (e instanceof ExportCancelled) show("jErr", "Join cancelled.");
    else { console.error(e); show("jErr", e.message || String(e)); }
  } finally {
    wake?.release?.().catch(() => {});
    state.joining = null; setJoinProgress(""); renderClips();
  }
}

/* =====================================================================
   Speakers: who is talking, on-device
   ===================================================================== */
const spkDlg = $("spkDlg");
const spkNames = () => (state.speakers ? state.speakers.names : null);
const spkName = (k) => (k >= 0 ? state.speakers?.names[k] || defaultName(k) : "Unlabelled");
/** Turn starts and speakers, to know when the transcript's paragraphs need rebuilding. */
function speakerSig() {
  const d = state.doc; if (!d || !state.speakers) return "";
  let sig = "", prev = -9;
  for (let i = 0; i < d.n; i++) { const sp = d.words[i].sp ?? -1; if (sp !== prev) { sig += i + ":" + sp + ","; prev = sp; } }
  return sig + "|" + state.speakers.names.join("\u0001");
}
function turnEnd(k) { const d = state.doc, sp = d.words[k]?.sp ?? -1; let i = k; while (i + 1 < d.n && (d.words[i + 1].sp ?? -1) === sp) i++; return i; }
function speakerChip(sp, k) {
  const b = document.createElement("button"); b.type = "button"; b.className = `spk-chip sc${sp < 0 ? "x" : sp % MAX_SPEAKERS}`; b.dataset.k = k;
  b.textContent = spkName(sp); b.title = "Change who said this"; b.setAttribute("aria-haspopup", "menu"); b.contentEditable = "false";
  return b;
}

$("speakersBtn").onclick = () => { if (!state.doc?.n) return; pause(); show("spkErr", ""); renderSpeakers(); spkDlg.showModal(); };
$("spkClose").onclick = () => spkDlg.close();
spkDlg.addEventListener("click", (e) => { if (e.target === spkDlg) spkDlg.close(); });
$("spkDetect").onclick = () => (state.spkJob ? state.spkJob.cancel() : detectSpeakers());
$("spkRedo").onclick = () => detectSpeakers();
$("spkClear").onclick = () => {
  edit((d) => { d.words.forEach((w) => { delete w.sp; }); });
  state.speakers = null; renderScript(); afterEdit(); renderSpeakers();
  show("spkNote", "Labels removed.");
};
for (const r of document.querySelectorAll('input[name="spkCount"]')) r.addEventListener("change", () => {
  const sp = state.speakers;
  if (sp?.data && !state.spkJob) regroup(val("spkCount")); // fingerprints are kept, so a new count is instant
});

function setSpkProgress(label, p, right = "") {
  $("spkProgress").hidden = !label;
  if (!label) return;
  $("spkStatus").textContent = label; $("spkRight").textContent = right;
  const f = $("spkFill"); f.classList.toggle("indeterminate", p == null); f.style.width = p == null ? "30%" : ((p || 0) * 100).toFixed(1) + "%";
}

let spkWorker = null, clusterSeq = 0;
const clusterWaits = new Map();
function getSpkWorker() {
  if (spkWorker) return spkWorker;
  spkWorker = new Worker(new URL("./speakers.worker.js", import.meta.url), { type: "module" });
  spkWorker.addEventListener("message", (e) => {
    const m = e.data;
    if (m.id != null && clusterWaits.has(m.id)) {
      const w = clusterWaits.get(m.id); clusterWaits.delete(m.id);
      m.type === "clustered" ? w.ok(m.labels) : w.no(new Error(m.message));
    }
  });
  return spkWorker;
}
function cluster(sp, count) {
  const id = ++clusterSeq;
  return new Promise((ok, no) => { clusterWaits.set(id, { ok, no }); getSpkWorker().postMessage({ type: "cluster", id, data: sp.data, dim: sp.dim, durs: sp.durs, count }); });
}

async function detectSpeakers() {
  if (!state.doc?.n || state.spkJob || busy()) return;
  show("spkErr", ""); show("spkNote", "");
  let cancelled = false;
  const ac = new AbortController();
  state.spkJob = { cancel: () => { cancelled = true; ac.abort(); spkWorker?.terminate(); spkWorker = null; for (const w of clusterWaits.values()) w.no(new Error("cancelled")); clusterWaits.clear(); } };
  syncSpeakersUI();
  const t0 = performance.now();
  try {
    if (!state.audio) {
      setSpkProgress("Reading audio…", 0);
      state.audio = await extractAudio16k(state.atrack, state.duration, (p) => setSpkProgress("Reading audio…", p, Math.round(p * 100) + "%"), ac.signal);
      state.peaks = computePeaks(state.audio); drawStrip();
    }
    const doc = state.doc, segs = voiceSegments(doc.words);
    const windows = new Float64Array(segs.length * 2);
    segs.forEach((g, k) => { const [a, b] = embedWindow(g, state.duration); windows[2 * k] = a; windows[2 * k + 1] = b; });
    setSpkProgress("Loading voice model…", null);
    const w = getSpkWorker();
    const res = await new Promise((ok, no) => {
      let started = 0;
      const on = (e) => {
        const m = e.data; if (m.id != null) return;
        if (m.type === "download") setSpkProgress("Downloading voice model…", m.total ? m.loaded / m.total : null, `${fmtBytes(m.loaded)} of ${fmtBytes(m.total)}`);
        else if (m.type === "status") setSpkProgress(m.text, null);
        else if (m.type === "progress") {
          started ||= performance.now();
          const p = m.done / m.total, el = (performance.now() - started) / 1000;
          setSpkProgress("Listening for voices…", p, p > 0.05 ? `${fmtTime(el / p - el)} left` : `${m.done} of ${m.total}`);
        } else if (m.type === "done") { w.removeEventListener("message", on); ok(m); }
        else if (m.type === "error") { w.removeEventListener("message", on); no(new Error(m.message)); }
      };
      w.addEventListener("message", on);
      ac.signal.addEventListener("abort", () => no(new Error("cancelled")));
      w.postMessage({ type: "run", audio: state.audio, windows });
    });
    if (state.doc !== doc) throw new Error("cancelled");
    state.speakers = { names: [], count: val("spkCount"), segs: segs.map((g) => [g.s, g.e, g.i0, g.i1]), durs: segs.map((g) => g.e - g.s), data: res.data, dim: res.dim };
    await regroup(val("spkCount"), true);
    const secs = (performance.now() - t0) / 1000;
    console.info(`speakers: ${segs.length} segments in ${secs.toFixed(1)} s on ${res.device}`);
  } catch (e) {
    if (!cancelled && e.message !== "cancelled") { console.error(e); show("spkErr", /fetch|network|Failed to load/i.test(e.message) ? "Couldn't download the voice model. Check your connection and try again." : friendly(e)); }
    else show("spkNote", "Stopped.");
  } finally {
    state.spkJob = null; setSpkProgress(""); syncSpeakersUI();
  }
}

/** Groups the stored voice fingerprints into `count` speakers and labels every word. */
async function regroup(count, fresh = false) {
  const sp = state.speakers; if (!sp?.data) return;
  setSpkProgress("Grouping voices…", null);
  try {
    const labels = await cluster(sp, count === "auto" ? "auto" : +count);
    const doc = state.doc; if (!doc) return;
    const segs = sp.segs.map(([s, e, i0, i1]) => ({ s, e, i0, i1 }));
    const per = wordSpeakers(doc.n, segs, labels);
    const n = labels.length ? Math.max(...labels) + 1 : 0;
    sp.count = count;
    // keep names the user typed when the grouping is only re-run with another count
    sp.names = Array.from({ length: n }, (_, k) => (!fresh && sp.names[k]) || defaultName(k));
    edit((d) => { per.forEach((v, i) => { if (v >= 0) d.words[i].sp = v; else delete d.words[i].sp; }); });
    renderScript(); renderSpeakers();
    show("spkNote", n === 1 ? "Found one voice. If more people speak, choose how many above." : `Found ${n} speakers. Rename them below; the names appear in the transcript and in exported captions.`);
  } catch (e) { if (e.message !== "cancelled") show("spkErr", friendly(e)); }
  finally { if (!state.spkJob) setSpkProgress(""); }
}

function syncSpeakersUI() {
  const job = !!state.spkJob, has = !!state.speakers;
  $("spkSetup").hidden = has && !job;
  $("spkDetect").textContent = job ? "Cancel" : "Detect speakers";
  $("spkDetect").classList.toggle("primary", !job); $("spkDetect").classList.toggle("ghost", job);
  $("spkActions").hidden = !has || job;
  for (const r of document.querySelectorAll('input[name="spkCount"]')) r.disabled = job;
  $("selSpk").hidden = !has;
}

function renderSpeakers() {
  const ol = $("spkList"); ol.textContent = "";
  const sp = state.speakers, doc = state.doc;
  if (sp?.count) { const r = document.querySelector(`input[name="spkCount"][value="${sp.count}"]`); if (r) r.checked = true; }
  syncSpeakersUI();
  if (!sp || !doc) return;
  const { total, kept } = talkTime(doc, sp.names.length), all = total.reduce((a, b) => a + b, 0) || 1;
  const unl = doc.words.filter((w) => (w.sp ?? -1) < 0).length;
  sp.names.forEach((name, k) => {
    if (total[k] <= 0) return;
    const li = document.createElement("li"); li.className = "spk"; li.dataset.k = k;
    const dot = document.createElement("span"); dot.className = `spk-dot sc${k % MAX_SPEAKERS}`;
    const inp = document.createElement("input"); inp.className = "spk-name"; inp.value = name; inp.maxLength = 40; inp.setAttribute("aria-label", `Name for ${defaultName(k)}`); inp.spellcheck = false;
    inp.addEventListener("change", () => { sp.names[k] = inp.value.trim() || defaultName(k); inp.value = sp.names[k]; afterEdit(); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    const meta = document.createElement("span"); meta.className = "spk-meta";
    const allCut = kept[k] <= 0.01;
    meta.textContent = `${fmtTime(total[k])} · ${Math.round((total[k] / all) * 100)}%` + (allCut ? " · all cut" : kept[k] < total[k] - 0.5 ? ` · ${fmtTime(kept[k])} kept` : "");
    const btns = document.createElement("div"); btns.className = "spk-btns";
    const mk = (text, fn, cls = "") => { const b = document.createElement("button"); b.type = "button"; b.className = "tool " + cls; b.textContent = text; b.onclick = fn; return b; };
    btns.append(mk("Play", () => playSpeaker(k), "spk-play"));
    btns.append(mk(allCut ? "Restore all" : "Cut all", () => cutSpeaker(k, !allCut), "spk-cut"));
    const others = sp.names.map((_, j) => j).filter((j) => j !== k && total[j] > 0);
    if (others.length) {
      const sel = document.createElement("select"); sel.className = "sel spk-merge"; sel.setAttribute("aria-label", `Merge ${name} into another speaker`);
      sel.append(new Option("Merge into…", ""), ...others.map((j) => new Option(sp.names[j], j)));
      sel.onchange = () => { if (sel.value === "") return; const to = +sel.value; edit((d) => { d.words.forEach((w) => { if (w.sp === k) w.sp = to; }); }); show("spkNote", `Merged ${name} into ${sp.names[to]}. Undo reverses it.`); renderSpeakers(); };
      btns.append(sel);
    }
    li.append(dot, inp, meta, btns);
    ol.append(li);
  });
  if (unl) { const li = document.createElement("li"); li.className = "spk-unl"; li.textContent = `${unl} word${unl === 1 ? " was" : "s were"} transcribed after detection and ${unl === 1 ? "isn't" : "aren't"} labelled yet. Detect again to include ${unl === 1 ? "it" : "them"}.`; ol.append(li); }
}
function cutSpeaker(k, cut) {
  edit((d) => { let any = false; d.words.forEach((w, i) => { if (w.sp === k && !!d.cutW[i] !== cut) { d.cutW[i] = cut ? 1 : 0; any = true; } }); return any; });
  show("spkNote", cut ? `Cut everything ${spkName(k)} says. Undo or "Restore all" brings it back.` : `Restored ${spkName(k)}.`);
  renderSpeakers();
}
/** Plays the speaker's first turn that's at least 1.5 s long (or their longest). */
function playSpeaker(k) {
  const d = state.doc; let best = null;
  for (let i = 0; i < d.n; i++) {
    if (d.words[i].sp !== k || (i > 0 && d.words[i - 1].sp === k)) continue;
    const e = turnEnd(i), len = d.words[e].e - d.words[i].s;
    if (!best || (best.len < 1.5 && len > best.len)) best = { i, e, len };
    if (best.len >= 1.5) break;
  }
  if (!best) return;
  spkDlg.close(); seek(d.words[best.i].s); state.followUntil = 0; play(); state.playUntil = Math.min(d.words[best.e].e + 0.15, d.words[best.i].s + 8);
}

/* ---------- reassign a turn or a selection ---------- */
const spkMenu = $("spkMenu");
let menuFor = null;
function openSpkMenu(anchor, i0, i1) {
  const sp = state.speakers; if (!sp) return;
  menuFor = { i0, i1 }; spkMenu.textContent = "";
  const cur = i0 === i1 || state.doc.words.slice(i0, i1 + 1).every((w) => w.sp === state.doc.words[i0].sp) ? state.doc.words[i0].sp ?? -1 : -2;
  const { total } = talkTime(state.doc, sp.names.length);
  const item = (label, k, cls) => {
    const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(k === cur));
    const dot = document.createElement("span"); dot.className = `spk-dot ${cls}`; b.append(dot, label);
    b.onclick = () => assignSpeaker(k); return b;
  };
  sp.names.forEach((n, k) => { if (total[k] > 0 || k === cur) spkMenu.append(item(n, k, `sc${k % MAX_SPEAKERS}`)); });
  if (sp.names.length < MAX_SPEAKERS) spkMenu.append(item("New speaker", sp.names.length, "new"));
  spkMenu.hidden = false;
  const r = anchor.getBoundingClientRect(), mw = spkMenu.offsetWidth, mh = spkMenu.offsetHeight;
  spkMenu.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + "px";
  spkMenu.style.top = (r.bottom + 4 + mh > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + "px";
  (spkMenu.querySelector('[aria-checked="true"]') || spkMenu.firstElementChild)?.focus();
}
function closeSpkMenu() { spkMenu.hidden = true; menuFor = null; }
function assignSpeaker(k) {
  const m = menuFor, sp = state.speakers; closeSpkMenu();
  if (!m || !sp) return;
  if (k >= sp.names.length) sp.names.push(defaultName(k));
  edit((d) => { let any = false; for (let i = m.i0; i <= m.i1; i++) if (d.words[i].sp !== k) { d.words[i].sp = k; any = true; } return any; });
  getSelection().removeAllRanges(); $("seltool").hidden = true;
}
spkMenu.addEventListener("keydown", (e) => {
  const items = [...spkMenu.querySelectorAll("button")], i = items.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); closeSpkMenu(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
document.addEventListener("pointerdown", (e) => { if (!spkMenu.hidden && !spkMenu.contains(e.target) && !e.target.closest(".spk-chip, #selSpk")) closeSpkMenu(); }, true);
script.addEventListener("scroll", () => { if (!spkMenu.hidden) closeSpkMenu(); }, { passive: true });
$("selSpk").onmousedown = (e) => e.preventDefault(); // keep the text selection
$("selSpk").onclick = () => { const t = selectedTokens(); if (!t?.words.length) return; openSpkMenu($("selSpk"), t.words[0], t.words.at(-1)); };

async function renderEdit(ranges, signal, onProgress, { aspect = state.reframe.aspect, captions = state.captions.on } = {}) {
  const [ow, oh] = outDims(aspect), fmt = val("fmt"), res = val("res"), upscale = res !== "orig";
  if (captions && state.capCues.length) await loadCaptionFonts();
  if (needsTracking(aspect)) { onProgress?.(0, { frames: 0, status: "finding faces…" }); await ensureTracking(aspect); }
  const rf = { ...state.reframe, aspect }, srcW = state.srcW, srcH = state.srcH;
  const rfPath = aspect === state.reframe.aspect ? state.rfPath : state.faceSamples && aspect !== "orig" ? buildPath(state.faceSamples, srcW, srcH, aspect) : null;
  const cropFn = rf.aspect !== "orig" ? (t) => cropAt(rf, rfPath, srcW, srcH, t) : null;
  let audioFx = null;
  if (state.audioFx.on && state.atrack) {
    onProgress?.(0, { frames: 0, status: "analyzing audio…" });
    const g = await ensureAudio(signal);
    audioFx = { settings: { ...state.audioFx }, profile: state.audioBase.profile, pre: g.pre, post: g.post };
  }
  const out = await exportEdit({ file: state.file, ranges, fmt, ow, oh, quality: QUALITY.high, sharp: upscale ? 0.5 : 0, colorFix: state.colorFix, signal, overlay: captionOverlay(captions), audioFx, cropAt: cropFn, onProgress });
  return { ...out, ow, oh, fmt, res, upscale, total: ranges.reduce((s, [a, b]) => s + b - a, 0) };
}
const fileBase = () => state.file.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) || "video";

async function doExport() {
  if (!state.file || busy()) return;
  const ranges = state.kept;
  if (!ranges.length) { show("xErr", "Everything is cut. Restore some words to export."); return; }
  show("xErr", ""); show("xNote", ""); clearResult(); pause();
  const ac = new AbortController(); state.exporting = ac;
  setExporting(true);
  const wake = await navigator.wakeLock?.request("screen").catch(() => null);
  const t0 = performance.now();
  try {
    const r = await renderEdit(ranges, ac.signal, (p, { frames, status }) => {
      if (status) { $("xEta").textContent = status; return; }
      const el = (performance.now() - t0) / 1000;
      $("xFill").style.width = (p * 100).toFixed(1) + "%"; $("xPct").textContent = Math.floor(p * 100) + "%";
      $("xFps").textContent = (frames / Math.max(el, 0.001)).toFixed(1);
      $("xEta").textContent = p > 0.02 ? `${fmtTime(el / p - el)} left` : "starting…";
      $("exportOpen").textContent = `Exporting ${Math.floor(p * 100)}%`;
    });
    const secs = (performance.now() - t0) / 1000;
    const url = URL.createObjectURL(r.blob);
    state.out = { blob: r.blob, url, name: `${fileBase()}_edited${r.upscale ? "_" + RES_NAME[r.res] : ""}.${r.fmt}` };
    $("resultVideo").src = url;
    $("resultTitle").textContent = `${r.ow}×${r.oh} · ${CODEC_NAMES[r.codec] || r.codec}${r.audio ? " + " + (CODEC_NAMES[r.audio] || r.audio) : ""} · ${fmtTime(r.total)}`;
    $("resultSize").textContent = fmtBytes(r.blob.size);
    $("resultTime").textContent = `made in ${fmtTime(secs)}`;
    $("result").hidden = false;
    if (r.audioNote) show("xNote", r.audioNote);
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
$("srtBtn").onclick = async () => { if (!state.doc) return; try { await saveBlob(new Blob([toSRT(captionCues(state.doc, state.cuts), spkNames())], { type: "text/plain" }), `${baseName()}_edited.srt`); } catch (e) { show("xErr", e.message); } };
$("txtBtn").onclick = async () => { if (!state.doc) return; try { await saveBlob(new Blob([toText(state.doc, spkNames()) + "\n"], { type: "text/plain" }), `${baseName()}_edited.txt`); } catch (e) { show("xErr", e.message); } };

window.addEventListener("beforeunload", (e) => { if (busy()) { e.preventDefault(); e.returnValue = ""; } });

/* =====================================================================
   Boot
   ===================================================================== */
if (checkSupport()) {
  renderExample(); refreshProjects(); drawStrip(); setToolsEnabled();
  buildCaptionUI(); syncCaptionUI(); drawStyleTiles(); syncReframeUI();
  loadCaptionFonts().then(() => { drawStyleTiles(); drawCapOverlay(); });
}
window.__edit = { state, loadFile, transcribe, doExport, undo, redo, applySelection, edit, runFind };
