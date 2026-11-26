// Scenes: split a long video into a few self-contained parts.
//   aiScenes():    Claude or OpenAI picks topic boundaries from the transcript (text only; the video never leaves the device)
//   pauseScenes(): on-device fallback, roughly equal parts cut at the longest nearby pauses
// Both return start points at sentence boundaries; buildScenes() turns them into clean time ranges.

import { askJSON, AIError, PROVIDERS, OPENAI_URL } from "./ai.js";
export { AIError, OPENAI_URL };
export const DEFAULT_MODEL = PROVIDERS.openai.model;
const MIN_SCENE = 20; // seconds; shorter parts are merged into a neighbour

/** Transcript as sentences of kept (not cut) words: [{s, e, text}], in order. */
export function sentences(doc) {
  const out = [];
  let cur = null;
  for (let i = 0; i < doc.n; i++) {
    if (doc.cutW[i]) continue;
    const w = doc.words[i];
    if (cur && (w.s - cur.e > 1.0 || cur.count >= 40 || (w.sp ?? -1) !== cur.sp)) { out.push(cur); cur = null; }
    if (!cur) cur = { s: w.s, e: w.e, text: w.t, count: 1, sp: w.sp ?? -1 };
    else { cur.e = w.e; cur.text += " " + w.t; cur.count++; }
    if (/[.?!]["')\]]?$/.test(w.t)) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map(({ s, e, text, sp }) => ({ s, e, text, sp }));
}

export const mmss = (t) => { t = Math.max(0, Math.floor(t)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`; };

/** "[index] m:ss text" lines, trimmed to a character budget so very long videos still fit one request. */
export function transcriptLines(sents, budget = 120000, names = null) {
  const total = sents.reduce((n, x) => n + x.text.length + 12, 0);
  const per = total > budget ? Math.max(40, Math.floor((budget / sents.length) - 12)) : Infinity;
  return sents.map((x, i) => `[${i}] ${mmss(x.s)} ${names && x.sp >= 0 && names[x.sp] ? names[x.sp] + ": " : ""}${x.text.length > per ? x.text.slice(0, per) + "…" : x.text}`).join("\n");
}

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["scenes"],
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["start_index", "title", "summary"],
        properties: {
          start_index: { type: "integer", description: "Index of the sentence this scene starts at" },
          title: { type: "string", description: "Short, specific title (max 60 characters)" },
          summary: { type: "string", description: "One sentence describing the scene" },
        },
      },
    },
  },
};

/**
 * Asks Claude or OpenAI for scene boundaries. Sends only transcript text and timestamps.
 * @returns {Promise<{start_index:number,title:string,summary:string}[]>}
 */
export async function aiScenes({ provider = "openai", key, model, sents, duration, count, signal, url, names = null }) {
  const want = count === "auto" ? "between 4 and 6 scenes (fewer for short videos)" : `exactly ${count} scenes`;
  const parsed = await askJSON({
    provider, key, model, signal, url, schema: SCHEMA, name: "scenes",
    system: "You split long video transcripts into self-contained scenes for separate short videos. Each scene must cover one topic or segment and make sense on its own. Scenes are contiguous and together cover the whole video. Choose boundaries where the topic changes, never mid-thought. Write titles and summaries in the transcript's language.",
    prompt: `Video length: ${mmss(duration)}. Split it into ${want}. The first scene starts at sentence 0. Return each scene's starting sentence index, a title and a one-sentence summary.\n\nTranscript (one sentence per line: [index] start time, ${names ? "speaker: " : ""}text):\n${transcriptLines(sents, provider === "claude" ? 400000 : 120000, names)}`,
  });
  if (!Array.isArray(parsed?.scenes) || !parsed.scenes.length) throw new AIError(`${PROVIDERS[provider].name} didn't return any scenes. Try again.`);
  return parsed.scenes;
}

/** On-device: n roughly equal parts, each cut at the longest pause within ±15 % of the even split. */
export function pauseScenes(sents, duration, count) {
  const n = count === "auto" ? Math.max(1, Math.min(6, Math.round(duration / 600) || 1)) : +count;
  const picks = [{ start_index: 0 }];
  let prev = 0;
  for (let k = 1; k < n; k++) {
    // aim for an even share of what is left after the previous cut, so one early miss doesn't skew the rest
    const target = prev + (duration - prev) / (n - k + 1), win = duration * 0.15;
    let best = -1, bestScore = -Infinity;
    for (let i = 1; i < sents.length; i++) {
      const at = sents[i].s; if (Math.abs(at - target) > win) continue;
      const pause = sents[i].s - sents[i - 1].e, sentenceEnd = /[.?!]["')\]]?$/.test(sents[i - 1].text) ? 0.5 : 0;
      const score = pause + sentenceEnd - Math.abs(at - target) / win; // long pause, after a full stop, near the target
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best > 0) { picks.push({ start_index: best }); prev = sents[best].s; }
    else prev = target;
  }
  return picks.map((p, i) => ({ ...p, title: `Part ${i + 1}`, summary: "" }));
}

/**
 * Validates scene starts and turns them into time ranges. Cut points sit in the middle of the pause
 * between sentences, so no word is clipped. Scenes shorter than 20 s merge into the previous one.
 * @returns {{start:number,end:number,title:string,summary:string}[]}
 */
export function buildScenes(sents, picks, duration) {
  if (!sents.length) return [{ start: 0, end: duration, title: "Full video", summary: "" }];
  const byIdx = new Map();
  for (const p of picks) {
    const i = Math.round(Number(p.start_index));
    if (!Number.isFinite(i) || i < 0 || i >= sents.length) continue;
    if (!byIdx.has(i)) byIdx.set(i, { i, title: String(p.title || "").trim().slice(0, 80), summary: String(p.summary || "").trim().slice(0, 300) });
  }
  if (!byIdx.has(0)) byIdx.set(0, { i: 0, title: "", summary: "" });
  const starts = [...byIdx.values()].sort((a, b) => a.i - b.i);
  const cut = (i) => (i === 0 ? 0 : (sents[i - 1].e + sents[i].s) / 2);
  let scenes = starts.map((x, k) => ({ start: cut(x.i), end: k + 1 < starts.length ? cut(starts[k + 1].i) : duration, title: x.title, summary: x.summary }));
  // A too-short scene usually means two starts were marked a few sentences apart: merge it into the
  // next scene but keep its (earlier) title, since that is where the topic actually begins.
  for (let k = 0; k < scenes.length - 1;) {
    if (scenes[k].end - scenes[k].start < MIN_SCENE) {
      const next = scenes[k + 1];
      scenes[k + 1] = { start: scenes[k].start, end: next.end, title: scenes[k].title || next.title, summary: scenes[k].summary || next.summary };
      scenes.splice(k, 1);
    } else k++;
  }
  if (scenes.length > 1 && scenes.at(-1).end - scenes.at(-1).start < MIN_SCENE) { scenes.at(-2).end = scenes.at(-1).end; scenes.pop(); }
  return scenes.map((s, k) => ({ ...s, title: s.title || `Part ${k + 1}` }));
}

/** The parts of the edit (kept ranges) that fall inside one scene. */
export function sceneRanges(kept, scene) {
  return kept.map(([a, b]) => [Math.max(a, scene.start), Math.min(b, scene.end)]).filter(([a, b]) => b - a > 0.04);
}

/** File-name-safe version of a scene title. */
export const slug = (t) => String(t).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 50).toLowerCase() || "scene";
