// Animated captions: grouping kept words into cues and drawing them on a 2D canvas.
// The same draw function renders the editor preview and the burned-in export, so they match.

export const CAPTION_STYLES = {
  highlight: { name: "Highlight", font: '"Instrument Sans", system-ui, sans-serif', weight: 700, scale: 1.0, upper: false, pill: true, shadow: true },
  pop:       { name: "Pop",       font: '"Archivo Black", "Arial Black", Impact, sans-serif', weight: 400, scale: 1.05, upper: true, stroke: true, colorWord: true, bounce: true },
  box:       { name: "Box",       font: '"Instrument Sans", system-ui, sans-serif', weight: 600, scale: 0.85, upper: false, box: true },
  clean:     { name: "Clean",     font: '"Instrument Sans", system-ui, sans-serif', weight: 600, scale: 0.9, upper: false, shadow: true },
  reveal:    { name: "Reveal",    font: '"Instrument Sans", system-ui, sans-serif', weight: 700, scale: 1.0, upper: false, shadow: true, reveal: true },
  single:    { name: "One word",  font: '"Archivo Black", "Arial Black", Impact, sans-serif', weight: 400, scale: 1.6, upper: true, stroke: true, single: true, bounce: true },
};
export const CAPTION_COLORS = ["#FFD43B", "#4ADE80", "#60A5FA", "#F472B6", "#FB923C", "#FFFFFF"];
const SIZE = { s: 0.048, m: 0.064, l: 0.085 };           // font size as a fraction of the short side
const LENGTH = { short: 3, medium: 6, long: 10 };        // max words per caption

export const DEFAULT_CAPTIONS = { on: false, style: "highlight", pos: "bottom", size: "m", color: "#FFD43B", length: "medium" };

/**
 * Groups kept (non-cut) words into caption cues, in source time. Gaps and lengths are measured
 * on the edited timeline (`map`: source → edited time), so words that become adjacent after a cut
 * share a caption.
 * @returns {{s:number,e:number,words:{t:string,s:number,e:number}[]}[]}
 */
export function buildCues(doc, opts, map = (t) => t) {
  const max = opts.style === "single" ? 1 : LENGTH[opts.length] || 6;
  const cues = [];
  let cur = null;
  const flush = () => { if (cur?.words.length) cues.push(cur); cur = null; };
  for (let i = 0; i < doc.n; i++) {
    if (doc.cutW[i]) continue;
    const w = doc.words[i];
    const gapBefore = cur ? map(w.s) - map(cur.e) : 0;
    if (cur && (cur.words.length >= max || gapBefore > 0.7 || map(w.e) - map(cur.s) > 4.5)) flush();
    if (!cur) cur = { s: w.s, e: w.e, words: [] };
    cur.words.push({ t: w.t, s: w.s, e: w.e });
    cur.e = w.e;
    if (max > 1 && /[.?!]$/.test(w.t)) flush();
  }
  flush();
  return cues;
}

/** Re-times cues through a time-mapping function (source → output). */
export function mapCues(cues, map) {
  return cues.map((c) => ({ s: map(c.s), e: map(c.e), words: c.words.map((w) => ({ t: w.t, s: map(w.s), e: map(w.e) })) }));
}

/** Maps source time to output time through kept ranges (as used by the exporter). */
export function rangeMapper(ranges) {
  const offs = []; let acc = 0;
  for (const [a, b] of ranges) { offs.push(acc); acc += b - a; }
  return (t) => {
    let lo = 0, hi = ranges.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ranges[m][0] <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
    if (idx < 0) return 0;
    const [a, b] = ranges[idx];
    return offs[idx] + Math.min(t, b) - a;
  };
}

/** Active cue at time t (cues held briefly until the next one to avoid flicker). */
function cueAt(cues, t) {
  let lo = 0, hi = cues.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cues[m].s <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx < 0) return -1;
  const c = cues[idx], next = cues[idx + 1];
  const hold = next ? Math.min(0.5, Math.max(0, next.s - c.e)) : 0.4;
  return t < c.e + hold ? idx : -1;
}

const layoutCache = new WeakMap();
function layout(ctx, cue, W, H, opts, st) {
  let per = layoutCache.get(cue);
  const key = `${W}x${H}|${opts.size}|${opts.style}|${opts.scale || 1}`;
  if (per?.key === key) return per;
  let fs = Math.round(Math.min(W, H) * (SIZE[opts.size] || SIZE.m) * st.scale * (opts.scale || 1));
  const maxW = W * 0.84;
  const texts = cue.words.map((w) => (st.upper ? w.t.toUpperCase() : w.t));
  let lines, widths, space, lh;
  for (let attempt = 0; attempt < 6; attempt++) {
    ctx.font = `${st.weight} ${fs}px ${st.font}`;
    space = ctx.measureText(" ").width + (st.pill ? fs * 0.3 : 0); lh = fs * 1.22; // pills need room between words
    widths = texts.map((t) => ctx.measureText(t).width);
    lines = []; let line = [], lw = 0;
    texts.forEach((_, i) => {
      const add = (line.length ? space : 0) + widths[i];
      if (line.length && lw + add > maxW) { lines.push({ idx: line, w: lw }); line = [i]; lw = widths[i]; }
      else { line.push(i); lw += add; }
    });
    if (line.length) lines.push({ idx: line, w: lw });
    if (lines.length <= 2 && lines.every((l) => l.w <= maxW)) break;
    fs = Math.round(fs * 0.86); // too long for two lines: shrink
  }
  per = { key, fs, lines, widths, space, lh, texts };
  layoutCache.set(cue, per);
  return per;
}

const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const darkInk = (hex) => { const n = parseInt(hex.slice(1), 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255; return 0.299 * r + 0.587 * g + 0.114 * b > 150; };

/**
 * Draws captions for time t onto ctx (W×H pixels). Returns true if anything was drawn.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 */
export function drawCaptions(ctx, W, H, t, cues, opts) {
  const ci = cueAt(cues, t); if (ci < 0) return false;
  const st = CAPTION_STYLES[opts.style] || CAPTION_STYLES.highlight;
  const cue = cues[ci];
  // the word being spoken: last word that has started (stays lit through short gaps)
  let cur = -1;
  for (let i = 0; i < cue.words.length; i++) if (cue.words[i].s <= t) cur = i;
  if (st.single && cur < 0) return false;
  const L = layout(ctx, cue, W, H, opts, st);
  const { fs, lh, space, widths, texts } = L;
  const lines = st.single ? [{ idx: [Math.max(0, cur)], w: widths[Math.max(0, cur)] }] : L.lines;
  const blockH = lines.length * lh;
  const margin = H * 0.085;
  const top = opts.pos === "top" ? margin : opts.pos === "middle" ? (H - blockH) / 2 : H - margin - blockH;
  const enter = ease((t - cue.s) / 0.14);

  ctx.save();
  ctx.font = `${st.weight} ${fs}px ${st.font}`;
  ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.lineJoin = "round";
  ctx.globalAlpha = st.single ? 1 : enter;
  const dy = st.single ? 0 : (1 - enter) * fs * 0.18;

  if (st.box) {
    const bw = Math.max(...lines.map((l) => l.w)) + fs * 0.9, bh = blockH + fs * 0.42;
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    rr(ctx, (W - bw) / 2, top - fs * 0.21 + dy, bw, bh, fs * 0.28); ctx.fill();
  }

  lines.forEach((line, li) => {
    let x = (W - line.w) / 2;
    const y = top + li * lh + lh / 2 + dy;
    line.idx.forEach((i, k) => {
      const w = widths[i], word = cue.words[i];
      const active = i === cur, spoken = i <= cur;
      let scale = 1;
      if (st.bounce && active) scale = 1 + 0.14 * (1 - ease((t - word.s) / 0.16));
      ctx.save();
      ctx.translate(x + w / 2, y); ctx.scale(scale, scale); ctx.translate(-w / 2, 0);
      if (st.pill && active) {
        ctx.fillStyle = opts.color;
        rr(ctx, -fs * 0.16, -fs * 0.62, w + fs * 0.32, fs * 1.2, fs * 0.22); ctx.fill();
      }
      let fill = "#FFFFFF";
      if (st.pill && active) fill = darkInk(opts.color) ? "#111111" : "#FFFFFF";
      else if (st.colorWord && active) fill = opts.color;
      if (st.reveal && !spoken) ctx.globalAlpha *= 0.42;
      if (st.shadow && !(st.pill && active)) { ctx.shadowColor = "rgba(0,0,0,0.65)"; ctx.shadowBlur = fs * 0.18; ctx.shadowOffsetY = fs * 0.04; }
      if (st.stroke) { ctx.strokeStyle = "#000000"; ctx.lineWidth = fs * 0.17; ctx.strokeText(texts[i], 0, 0); }
      ctx.fillStyle = fill; ctx.fillText(texts[i], 0, 0);
      ctx.restore();
      x += w + (k < line.idx.length - 1 ? space : 0);
    });
  });
  ctx.restore();
  return true;
}

/** Makes sure caption fonts are loaded before drawing to a canvas (canvas won't wait for them). */
export async function loadCaptionFonts() {
  try { await Promise.all(['700 40px "Instrument Sans"', '600 40px "Instrument Sans"', '400 40px "Archivo Black"'].map((f) => document.fonts.load(f))); } catch {}
}
