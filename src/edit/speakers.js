// Speaker labels: who is talking when.
// The transcript is cut into short voice segments, each segment gets a voice fingerprint (an embedding
// from an on-device speaker model, see speakers.worker.js), and segments with similar voices are grouped.

export const MAX_SPEAKERS = 8;
const EMBED_MIN = 1.2;   // seconds of audio the voice model gets at least (shorter segments borrow context)
const RELIABLE = 0.9;    // segments at least this long decide the groups; shorter ones join the nearest group
const AUTO_SIM = 0.32;   // average similarity above which two groups are the same voice (auto count)
const SAME_VOICE = 0.45; // groups whose average voices are this alike are one person (measured: same 0.52+, different ≤ 0.35)

/**
 * Voice segments from word timings: a new segment starts at a pause, after a sentence once it's long
 * enough, or when it gets long (so a change of speaker without a pause is still caught within ~3 s).
 * @returns {{s:number,e:number,i0:number,i1:number}[]} i0..i1 are word indices (inclusive)
 */
export function voiceSegments(words) {
  const segs = [];
  let cur = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // a finished sentence ends a segment too: in quick exchanges, that's often the only sign of a new speaker
    if (cur && (w.s - cur.e > 0.3 || w.e - cur.s > 3.2 || (cur.e - cur.s > 0.6 && /[.?!]["')\]]?$/.test(words[i - 1].t)))) { segs.push(cur); cur = null; }
    if (!cur) cur = { s: w.s, e: w.e, i0: i, i1: i };
    else { cur.e = w.e; cur.i1 = i; }
  }
  if (cur) segs.push(cur);
  return segs;
}

/** The stretch of audio given to the voice model for a segment: the segment itself, widened to EMBED_MIN. */
export function embedWindow(seg, duration) {
  let a = seg.s - 0.05, b = seg.e + 0.05;
  if (b - a < EMBED_MIN) { const pad = (EMBED_MIN - (b - a)) / 2; a -= pad; b += pad; }
  if (a < 0) { b -= a; a = 0; }
  if (b > duration) { a = Math.max(0, a - (b - duration)); b = duration; }
  return [a, b];
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const normalize = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };

/**
 * Groups voice embeddings (unit vectors) into speakers with average-linkage clustering.
 * @param {number[][]} embs one unit vector per segment
 * @param {number[]} durs segment durations (s)
 * @param {"auto"|number} count
 * @returns {number[]} speaker index per segment, numbered by first appearance
 */
export function clusterSpeakers(embs, durs, count = "auto") {
  const n = embs.length;
  if (!n) return [];
  let core = durs.map((d, i) => (d >= RELIABLE ? i : -1)).filter((i) => i >= 0);
  if (core.length < Math.min(n, 2)) core = durs.map((_, i) => i); // all short: use everything
  const m = core.length;
  // Groups with only a sliver of speech (a cough, a laugh, a garbled segment) aren't speakers: they don't
  // count towards the number of speakers, and are folded into the nearest real speaker at the end.
  const total = durs.reduce((a, b) => a + b, 0), minTalk = Math.min(Math.max(2, total * 0.02), total / 2);
  const want = count === "auto" ? 0 : Math.max(1, Math.min(MAX_SPEAKERS, +count));
  // average linkage with a cached best neighbour per row (fast enough for a few thousand segments)
  const sim = core.map((i) => core.map((j) => dot(embs[i], embs[j])));
  const size = new Array(m).fill(1), talk = core.map((i) => durs[i]), alive = new Array(m).fill(true), members = core.map((i) => [i]);
  const best = new Array(m), bestSim = new Array(m);
  const rowBest = (r) => { let b = -1, bs = -Infinity; for (let c = 0; c < m; c++) if (c !== r && alive[c] && sim[r][c] > bs) { bs = sim[r][c]; b = c; } best[r] = b; bestSim[r] = bs; };
  for (let r = 0; r < m; r++) rowBest(r);
  const bigOnes = () => members.filter((g, i) => g && talk[i] >= minTalk);
  // With a fixed count, keep the most-merged state that still has that many real speakers.
  let chosen = null;
  for (let clusters = m; ; clusters--) {
    if (want && bigOnes().length >= want) chosen = bigOnes().map((g) => g.slice());
    if (clusters <= 1) break;
    let r = -1, rs = -Infinity;
    for (let i = 0; i < m; i++) if (alive[i] && best[i] >= 0 && bestSim[i] > rs) { rs = bestSim[i]; r = i; }
    if (r < 0 || (!want && rs < AUTO_SIM)) break;
    const c = best[r];
    for (let k = 0; k < m; k++) { // merge c into r (Lance–Williams update for average linkage)
      if (!alive[k] || k === r || k === c) continue;
      const v = (sim[r][k] * size[r] + sim[c][k] * size[c]) / (size[r] + size[c]);
      sim[r][k] = sim[k][r] = v;
    }
    size[r] += size[c]; talk[r] += talk[c]; alive[c] = false; members[r].push(...members[c]); members[c] = null;
    for (let k = 0; k < m; k++) if (alive[k] && (k === r || best[k] === r || best[k] === c)) rowBest(k);
    for (let k = 0; k < m; k++) if (alive[k] && k !== r && best[k] >= 0 && sim[k][r] > bestSim[k]) { best[k] = r; bestSim[k] = sim[k][r]; }
  }
  let groups = want ? chosen : bigOnes();
  if (!groups?.length) groups = members.filter(Boolean);
  if (want && groups.length > want) groups = groups.sort((a, b) => b.length - a.length).slice(0, want);
  const centroid = (g) => normalize(g.reduce((acc, i) => acc.map((x, d) => x + embs[i][d] * durs[i]), new Array(embs[0].length).fill(0)));
  // Short segments make individual fingerprints noisy, which can split one person in two. Their averages
  // are much cleaner, so in Auto, merge groups whose average voices match.
  if (!want) {
    for (;;) {
      const cs = groups.map(centroid); let bi = -1, bj = -1, bs = SAME_VOICE;
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) { const v = dot(cs[i], cs[j]); if (v > bs) { bs = v; bi = i; bj = j; } }
      if (bi < 0) break;
      groups[bi] = groups[bi].concat(groups[bj]); groups.splice(bj, 1);
    }
  }
  const cents = groups.map(centroid);
  let label = embs.map((e) => { let b = 0, bs = -Infinity; cents.forEach((c, k) => { const s = dot(e, c); if (s > bs) { bs = s; b = k; } }); return b; });
  label = smooth(label, embs, durs, cents);
  // number speakers by first appearance
  const order = new Map();
  for (const l of label) if (!order.has(l)) order.set(l, order.size);
  return label.map((l) => order.get(l));
}

/** A short segment sandwiched between two segments of the same other speaker is usually that speaker,
 *  unless its voice clearly says otherwise. */
function smooth(label, embs, durs, cents) {
  const out = label.slice();
  for (let i = 1; i < out.length - 1; i++) {
    if (durs[i] >= 1.5 || out[i - 1] !== out[i + 1] || out[i] === out[i - 1]) continue;
    const own = dot(embs[i], cents[out[i]]), other = dot(embs[i], cents[out[i - 1]]);
    if (own - other < 0.12) out[i] = out[i - 1];
  }
  return out;
}

/** Speaker per word from speaker per segment. */
export function wordSpeakers(n, segs, labels) {
  const sp = new Array(n).fill(-1);
  segs.forEach((g, k) => { for (let i = g.i0; i <= g.i1; i++) sp[i] = labels[k]; });
  return sp;
}

/** Speaker turns: runs of words with the same speaker. */
export function turns(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const sp = words[i].sp ?? -1;
    if (out.length && out.at(-1).sp === sp) out.at(-1).i1 = i;
    else out.push({ sp, i0: i, i1: i });
  }
  return out;
}

/** Seconds each speaker talks: total and still in the edit. */
export function talkTime(doc, count) {
  const total = new Array(count).fill(0), kept = new Array(count).fill(0);
  doc.words.forEach((w, i) => { const sp = w.sp ?? -1; if (sp < 0 || sp >= count) return; const d = w.e - w.s; total[sp] += d; if (!doc.cutW[i]) kept[sp] += d; });
  return { total, kept };
}

export const defaultName = (k) => `Speaker ${k + 1}`;
