// Highlights: the best standalone moments of a long video, as short clips for Shorts, Reels and TikTok.
// The AI (Claude by default, or OpenAI) reads the transcript and picks sentence ranges; everything
// else (length limits, clean cut points, overlaps, trimming) is decided here, on the device.
import { askJSON, AIError, PROVIDERS } from "./ai.js";
import { transcriptLines, mmss } from "./scenes.js";

export const LENGTHS = { short: [15, 30], medium: [30, 60], long: [60, 90] };
const MIN_CLIP = 5; // seconds; trimming never goes below this

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["highlights"],
  properties: {
    highlights: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["start_index", "end_index", "title", "reason", "score"],
        properties: {
          start_index: { type: "integer", description: "Index of the sentence the clip starts with" },
          end_index: { type: "integer", description: "Index of the last sentence in the clip (inclusive)" },
          title: { type: "string", description: "Catchy, specific title that works as the post's caption (max 60 characters)" },
          reason: { type: "string", description: "One sentence: why this moment works on its own" },
          score: { type: "integer", description: "1-10: how likely the clip is to hold a viewer to the end" },
        },
      },
    },
  },
};

const SYSTEM = `You are an expert short-form video editor. You find the best standalone moments in long videos to post as Shorts, Reels and TikToks.
A great highlight:
- hooks the viewer with its first sentence (a bold claim, a question, a surprising fact, the start of a story), never with filler or a greeting;
- makes complete sense without the rest of the video (no unexplained "that", "he" or "as I said");
- ends on a payoff: the punchline, the answer, the conclusion, the emotional beat. Never end before the point lands;
- has energy: humour, conflict, a strong opinion, a clear insight, a vivid story.
Highlights must not overlap. Rank honestly: only give 8 or more to moments that would clearly stand out in a feed. Write titles and reasons in the transcript's language.`;

/**
 * Asks the AI for highlight candidates. Sends only transcript text and timestamps.
 * @returns {Promise<{start_index:number,end_index:number,title:string,reason:string,score:number}[]>}
 */
export async function aiHighlights({ provider = "claude", key, model, sents, duration, count = "auto", length = "medium", signal, url, names = null }) {
  const [lo, hi] = LENGTHS[length] || LENGTHS.medium;
  const want = count === "auto" ? "the strongest highlights: between 3 and 8, only as many as are genuinely good (fewer for a short video)" : `the ${count} best highlights`;
  const parsed = await askJSON({
    provider, key, model, signal, url, schema: SCHEMA, name: "highlights",
    system: SYSTEM,
    prompt: `Video length: ${mmss(duration)}. Find ${want}. Each highlight should run ${lo}-${hi} seconds: a clip runs from the start time of its first sentence to the start time of the sentence after its last one. Return each highlight's first and last sentence index (inclusive), a title, why it works, and a score. Best first.\n\nTranscript (one sentence per line: [index] start time, ${names ? "speaker: " : ""}text):\n${transcriptLines(sents, provider === "claude" ? 400000 : 120000, names)}`,
  });
  if (!Array.isArray(parsed?.highlights) || !parsed.highlights.length) throw new AIError(`${PROVIDERS[provider]?.name || "The AI"} didn't find any highlights. Try again, or try a longer clip length.`);
  return parsed.highlights;
}

/** Where a clip starting at sentence i begins: just before the first word, inside the pause before it. */
const startAt = (sents, i) => (i === 0 ? Math.max(0, sents[0].s - 0.25) : Math.max((sents[i - 1].e + sents[i].s) / 2, sents[i].s - 0.4));
/** Where a clip ending with sentence i ends: just after the last word, inside the pause after it. */
const endAt = (sents, i, duration) => (i === sents.length - 1 ? Math.min(duration, sents[i].e + 0.5) : Math.min((sents[i].e + sents[i + 1].s) / 2, sents[i].e + 0.5));

/**
 * Validates the AI's picks and turns them into clips: indices are checked, lengths are pulled into
 * range a sentence at a time, overlapping picks keep only the higher-scored one.
 * @returns {{start:number,end:number,title:string,reason:string,score:number}[]} best first
 */
export function buildHighlights(sents, picks, duration, length = "medium", max = Infinity) {
  const n = sents.length;
  if (!n) return [];
  const [lo, hi] = LENGTHS[length] || LENGTHS.medium;
  const cands = [];
  for (const p of picks || []) {
    let i0 = Math.round(Number(p?.start_index)), i1 = Math.round(Number(p?.end_index));
    if (!Number.isFinite(i0) || !Number.isFinite(i1)) continue;
    if (i1 < i0) [i0, i1] = [i1, i0];
    if (i0 < 0 || i0 >= n) continue;
    i1 = Math.min(i1, n - 1);
    const len = () => sents[i1].e - sents[i0].s;
    // too short: add the following sentences (the payoff usually comes after); too long: drop from the end
    while (len() < lo * 0.75 && i1 < n - 1 && sents[i1 + 1].e - sents[i0].s <= hi * 1.25) i1++;
    while (len() > hi * 1.3 && i1 > i0) i1--;
    const score = Math.max(1, Math.min(10, Math.round(Number(p.score)) || 5));
    cands.push({ i0, i1, start: startAt(sents, i0), end: endAt(sents, i1, duration), score,
      title: String(p.title || "").trim().slice(0, 80), reason: String(p.reason || "").trim().slice(0, 300) });
  }
  // stable sort: best first, the AI's own order breaks ties
  cands.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of cands) {
    if (out.length >= max) break;
    const clash = out.some((o) => Math.min(o.end, c.end) - Math.max(o.start, c.start) > 0.3 * Math.min(o.end - o.start, c.end - c.start));
    if (!clash) out.push(c);
  }
  return out.map(({ i0, i1, ...c }, k) => ({ ...c, title: c.title || `Highlight ${k + 1}` }));
}

/**
 * Moves one edge of a clip to the next sentence boundary (dir -1 earlier, +1 later).
 * @returns {{start:number,end:number}|null} the new edges, or null if that edge can't move further
 */
export function nudgeClip(sents, clip, edge, dir, duration) {
  const n = sents.length;
  if (!n) return null;
  if (edge === "start") {
    let i = -1;
    if (dir < 0) { for (let k = n - 1; k >= 0; k--) if (startAt(sents, k) < clip.start - 0.05) { i = k; break; } }
    else { for (let k = 0; k < n; k++) if (startAt(sents, k) > clip.start + 0.05) { i = k; break; } }
    if (i < 0) return null;
    const start = startAt(sents, i);
    return clip.end - start >= MIN_CLIP ? { start, end: clip.end } : null;
  }
  let i = -1;
  if (dir > 0) { for (let k = 0; k < n; k++) if (endAt(sents, k, duration) > clip.end + 0.05) { i = k; break; } }
  else { for (let k = n - 1; k >= 0; k--) if (endAt(sents, k, duration) < clip.end - 0.05) { i = k; break; } }
  if (i < 0) return null;
  const end = endAt(sents, i, duration);
  return end - clip.start >= MIN_CLIP ? { start: clip.start, end } : null;
}
