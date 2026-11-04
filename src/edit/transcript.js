// Transcript document model: words + the gaps between them, which of them are cut,
// and how those cuts turn into time ranges to keep. Pure logic, no DOM.

export const FILLERS = new Set(["um", "umm", "ummm", "uh", "uhh", "uhm", "erm", "er", "ah", "ahh", "hmm", "hm", "mm", "mmm", "mhm"]);
export const normWord = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Padding (s) of natural pause kept on each side of a cut, so speech doesn't collide. */
export const PAD = 0.12;

/**
 * Clean raw ASR words: trim text, drop empties, force non-overlapping increasing times within [0, duration].
 * @param {{t:string,s:number,e:number}[]} words
 */
export function sanitizeWords(words, duration) {
  const out = [];
  let prevE = 0;
  for (const w of words) {
    const t = String(w.t ?? "").trim();
    if (!t) continue;
    let s = Number.isFinite(w.s) ? w.s : prevE;
    let e = Number.isFinite(w.e) ? w.e : s + 0.3;
    s = Math.min(Math.max(s, prevE), duration);
    e = Math.min(Math.max(e, s + 0.02), duration);
    if (e <= s) continue;
    out.push({ t, s, e });
    prevE = e;
  }
  return out;
}

export class Doc {
  /** @param {{t:string,s:number,e:number}[]} words already sanitized */
  constructor(words, duration) {
    this.words = words;
    this.duration = duration;
    this.cutW = new Uint8Array(words.length);      // word i is cut
    this.cutG = new Uint8Array(words.length + 1);  // gap k (before word k; k = n is trailing) is cut explicitly
  }
  get n() { return this.words.length; }
  gapStart(k) { return k === 0 ? 0 : this.words[k - 1].e; }
  gapEnd(k) { return k === this.n ? this.duration : this.words[k].s; }
  gapDur(k) { return this.gapEnd(k) - this.gapStart(k); }
  /** A gap is removed when cut explicitly or when a neighbouring word is cut. */
  gapCut(k) { return !!(this.cutG[k] || (k > 0 && this.cutW[k - 1]) || (k < this.n && this.cutW[k])); }

  snapshot() { return { w: this.cutW.slice(), g: this.cutG.slice() }; }
  restore(s) { this.cutW.set(s.w); this.cutG.set(s.g); }
  toJSON() { return { words: this.words, duration: this.duration, cutW: Array.from(this.cutW), cutG: Array.from(this.cutG) }; }
  static fromJSON(o) {
    const d = new Doc(o.words, o.duration);
    if (o.cutW?.length === d.cutW.length) d.cutW.set(o.cutW);
    if (o.cutG?.length === d.cutG.length) d.cutG.set(o.cutG);
    return d;
  }

  /** Time intervals to remove, merged and sorted. */
  cutIntervals(pad = PAD) {
    const n = this.n, out = [];
    // Walk tokens gap0, w0, gap1, w1, …, w(n-1), gapN and collect maximal runs of cut tokens.
    let run = null; // {a, b, firstGap, lastGap, startsAfterWord}
    const close = (followedByWord) => {
      if (!run) return;
      let { a, b } = run;
      if (run.firstGap !== null && run.precededByWord) a += Math.min(pad, this.gapDur(run.firstGap) / 2);
      if (run.lastGap !== null && followedByWord) b -= Math.min(pad, this.gapDur(run.lastGap) / 2);
      if (b - a > 0.01) out.push([a, b]);
      run = null;
    };
    for (let k = 0; k <= n; k++) {
      // gap k
      const gs = this.gapStart(k), ge = this.gapEnd(k);
      if (this.gapCut(k) && ge > gs) {
        if (!run) run = { a: gs, b: ge, firstGap: k, lastGap: k, precededByWord: k > 0 };
        else { run.b = ge; run.lastGap = k; }
      } else if (ge > gs) close(true);
      if (k === n) break;
      // word k
      const w = this.words[k];
      if (this.cutW[k]) {
        if (!run) run = { a: w.s, b: w.e, firstGap: null, lastGap: null, precededByWord: true };
        else { run.b = w.e; run.lastGap = null; }
      } else close(true);
    }
    close(false);
    return out;
  }

  /** Time ranges to keep, in source time. */
  keptRanges(cuts = this.cutIntervals()) {
    const keep = [];
    let t = 0;
    for (const [a, b] of cuts) { if (a - t > 0.04) keep.push([t, a]); t = Math.max(t, b); }
    if (this.duration - t > 0.04) keep.push([t, this.duration]);
    return keep;
  }

  removedSeconds(cuts = this.cutIntervals()) { return cuts.reduce((s, [a, b]) => s + (b - a), 0); }

  /** Marks pauses ≥ min seconds as cut. Returns how many were newly cut. */
  trimPauses(min) {
    let c = 0;
    for (let k = 0; k <= this.n; k++) if (this.gapDur(k) >= min && !this.gapCut(k)) { this.cutG[k] = 1; c++; }
    return c;
  }
  removeFillers() {
    let c = 0;
    this.words.forEach((w, i) => { if (!this.cutW[i] && FILLERS.has(normWord(w.t))) { this.cutW[i] = 1; c++; } });
    return c;
  }
  restoreAll() { this.cutW.fill(0); this.cutG.fill(0); }

  /** Index of the word playing at time t, or -1. */
  wordAt(t) {
    let lo = 0, hi = this.n - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.words[m].s <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans >= 0 && t < this.words[ans].e + 0.25 ? ans : -1;
  }
}

/** Maps a source time to edited (output) time. */
export function mapTime(t, cuts) {
  let removed = 0;
  for (const [a, b] of cuts) { if (b <= t) removed += b - a; else if (a < t) { removed += t - a; break; } else break; }
  return t - removed;
}

/** Finds the cut containing t (with a small lookahead), or null. cuts sorted. */
export function cutAt(t, cuts, ahead = 0.02) {
  let lo = 0, hi = cuts.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, [a, b] = cuts[m];
    if (t + ahead < a) hi = m - 1; else if (t >= b) lo = m + 1; else return cuts[m];
  }
  return null;
}

const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
};

/** Caption cues for the edited video (kept words only, re-timed). */
export function captionCues(doc, cuts = doc.cutIntervals(), { maxChars = 42, maxDur = 5 } = {}) {
  const cues = [];
  let cur = null;
  const flush = () => { if (cur) { cues.push(cur); cur = null; } };
  doc.words.forEach((w, i) => {
    if (doc.cutW[i]) return;
    const s = mapTime(w.s, cuts), e = mapTime(w.e, cuts);
    if (cur && (cur.text.length + 1 + w.t.length > maxChars || e - cur.s > maxDur || s - cur.e > 0.8)) flush();
    if (!cur) cur = { s, e, text: w.t };
    else { cur.text += " " + w.t; cur.e = e; }
    if (/[.?!]$/.test(w.t)) flush();
  });
  flush();
  return cues;
}

export function toSRT(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.s)} --> ${srtTime(Math.max(c.e, c.s + 0.3))}\n${c.text}\n`).join("\n");
}

export function toText(doc) {
  return doc.words.filter((_, i) => !doc.cutW[i]).map((w) => w.t).join(" ").replace(/\s+([,.?!;:])/g, "$1");
}
