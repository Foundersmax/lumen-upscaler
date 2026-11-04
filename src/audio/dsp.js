// Voice-processing DSP. Pure JS, no DOM: runs in the page (export, analysis), in an AudioWorklet
// (live preview) and in Node (tests). All processors are streaming, block-based and planar
// (one Float32Array per channel), so long files never need to be held in memory.
//
// Chain: pre-gain → low cut → spectral noise reduction → voice EQ → de-esser → expander
//        → compressor → loudness gain → peak limiter

/* ---------------------------------------------------------------- FFT */
export class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = Math.sin((2 * Math.PI * i) / n); }
  }
  /** In-place complex FFT; inverse=true computes the unscaled inverse. */
  run(re, im, inverse = false) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const sg = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k], wi = sg * this.sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

/* ------------------------------------------------------------ Biquads */
/** RBJ cookbook coefficients, normalised (a0 = 1). */
export function biquad(type, f, sr, q = Math.SQRT1_2, gainDb = 0) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr, c = Math.cos(w), s = Math.sin(w);
  const A = Math.pow(10, gainDb / 40), al = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case "highpass": b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
    case "lowpass": b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
    case "peaking": b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; break;
    case "lowshelf": { const t = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) - (A - 1) * c + t); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - t);
      a0 = (A + 1) + (A - 1) * c + t; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - t; break; }
    case "highshelf": { const t = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) + (A - 1) * c + t); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - t);
      a0 = (A + 1) - (A - 1) * c + t; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - t; break; }
    default: throw new Error("unknown filter " + type);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** A cascade of biquads applied to every channel (transposed direct form II). */
export class FilterChain {
  constructor(coefs, channels) {
    this.c = coefs; this.ch = channels;
    this.z = coefs.map(() => ({ z1: new Float64Array(channels), z2: new Float64Array(channels) }));
  }
  process(chans, n) {
    for (let f = 0; f < this.c.length; f++) {
      const { b0, b1, b2, a1, a2 } = this.c[f], st = this.z[f];
      for (let ch = 0; ch < chans.length; ch++) {
        const x = chans[ch]; let z1 = st.z1[ch], z2 = st.z2[ch];
        for (let i = 0; i < n; i++) { const v = x[i], y = b0 * v + z1; z1 = b1 * v - a1 * y + z2; z2 = b2 * v - a2 * y; x[i] = y; }
        st.z1[ch] = z1; st.z2[ch] = z2;
      }
    }
  }
  /** Magnitude response in dB at frequency f (for tests and UI). */
  static responseDb(coefs, f, sr) {
    const w = (2 * Math.PI * f) / sr; let mag = 1;
    for (const { b0, b1, b2, a1, a2 } of coefs) {
      const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), ni = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
      const dr = 1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), di = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w));
      mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
    }
    return 20 * Math.log10(mag);
  }
}

/* --------------------------------------------------------------- STFT */
export const fftSizeFor = (sr) => (sr >= 32000 ? 1024 : 512);
const hann = (n) => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); return w; };

/**
 * Overlap-add STFT engine with 75 % overlap. `onFrame(re[], im[])` receives each channel's spectrum
 * (bins 0..N/2) and may modify it in place. Output is delayed by `latency` samples.
 */
class Stft {
  constructor(sr, channels, onFrame, analysisOnly = false) {
    const N = fftSizeFor(sr), hop = N / 4;
    Object.assign(this, { N, hop, ch: channels, onFrame, analysisOnly, fft: new FFT(N), win: hann(N), fill: 0 });
    this.inp = Array.from({ length: channels }, () => new Float32Array(N));
    this.ola = Array.from({ length: channels }, () => new Float32Array(N));
    this.re = Array.from({ length: channels }, () => new Float64Array(N));
    this.im = Array.from({ length: channels }, () => new Float64Array(N));
    // Output is emitted before each frame is computed, so one hop of zeros is queued up front.
    // Queue position hop + j holds input sample j − (N − hop), i.e. a constant delay of N samples.
    this.outQ = Array.from({ length: channels }, () => new Float32Array(2 * hop));
    this.outLen = hop;
    this.latency = N;
    this.norm = 1 / 1.5; // Hann² summed at 75 % overlap
    this.filled = N - hop; // first frame needs a full window of input
  }
  process(chans, n) {
    const { N, hop } = this;
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, N - this.filled);
      for (let c = 0; c < this.ch; c++) this.inp[c].set(chans[c].subarray(i, i + take), this.filled);
      // emit already-available output for these input positions
      if (!this.analysisOnly) this.#emit(chans, i, take);
      this.filled += take; i += take;
      if (this.filled === N) { this.#frame(); this.filled = N - hop; for (let c = 0; c < this.ch; c++) this.inp[c].copyWithin(0, hop); }
    }
  }
  #emit(chans, at, count) {
    for (let c = 0; c < this.ch; c++) {
      const q = this.outQ[c];
      chans[c].set(q.subarray(0, count), at);
      q.copyWithin(0, count, this.outLen); q.fill(0, this.outLen - count);
    }
    this.outLen -= count;
  }
  #frame() {
    const { N, hop, win, fft } = this;
    for (let c = 0; c < this.ch; c++) {
      const re = this.re[c], im = this.im[c], x = this.inp[c];
      for (let k = 0; k < N; k++) { re[k] = x[k] * win[k]; im[k] = 0; }
      fft.run(re, im);
    }
    this.onFrame(this.re, this.im);
    if (this.analysisOnly) return;
    for (let c = 0; c < this.ch; c++) {
      const re = this.re[c], im = this.im[c];
      for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; } // Hermitian
      im[0] = 0; im[N / 2] = 0;
      fft.run(re, im, true);
      const ola = this.ola[c], s = this.norm / N;
      for (let k = 0; k < N; k++) ola[k] += re[k] * win[k] * s;
      // the first `hop` samples are complete: queue them
      this.outQ[c].set(ola.subarray(0, hop), this.outLen);
      ola.copyWithin(0, hop); ola.fill(0, N - hop);
    }
    this.outLen += hop;
  }
}

/* ------------------------------------------------- Noise profiling */
/**
 * Estimates the background-noise spectrum: frames whose total energy is within 3 dB of a slowly
 * rising minimum are treated as noise-only, and their power spectra are averaged. (A plain
 * per-bin minimum underestimates noise by 4–13 dB.) Feed it the whole file once.
 */
export class NoiseProfiler {
  constructor(sr, channels) {
    this.sr = sr;
    const N = fftSizeFor(sr), B = N / 2 + 1;
    this.N = N; this.B = B;
    this.sum = new Float64Array(B); this.count = 0; this.frames = 0; this.minE = Infinity;
    this.fallback = new Float64Array(B).fill(Infinity); this.p = new Float64Array(B);
    const rise = Math.pow(10, 3 / 10 / ((sr / (N / 4)) * 2)); // the minimum may rise 3 dB per 2 s
    this.stft = new Stft(sr, channels, (re, im) => {
      // the first N/hop − 1 windows are partly zero padding: they'd fake a very quiet minimum
      if (++this.frames < 4) return;
      let E = 0;
      for (let k = 1; k < B; k++) {
        let p = 0; for (let c = 0; c < re.length; c++) p += re[c][k] * re[c][k] + im[c][k] * im[c][k];
        p /= re.length; this.p[k] = p; E += p;
        if (p < this.fallback[k]) this.fallback[k] = p;
      }
      // Skip digital silence (e.g. AAC priming samples): below −90 dBFS it says nothing about the room,
      // and letting it set the minimum would hide all real noise frames.
      if ((2 * E) / N / (0.375 * N) < 1e-9) return;
      this.minE = Math.min(this.minE * rise, E);
      if (E < this.minE * 2) { this.count++; for (let k = 1; k < B; k++) this.sum[k] += this.p[k]; }
    }, true);
  }
  process(chans, n) { this.stft.process(chans, n); }
  /** {sr, n, power: Float32Array(B)} */
  result() {
    const p = new Float32Array(this.B);
    for (let k = 1; k < this.B; k++) p[k] = this.count >= 20 ? this.sum[k] / this.count : (Number.isFinite(this.fallback[k]) ? this.fallback[k] * 4 : 0);
    p[0] = p[1];
    return { sr: this.sr, n: this.N, power: p, frames: this.count };
  }
}

/** Resamples a noise profile onto the bins of another rate (preview contexts may run at 44.1 kHz). */
function profileFor(profile, sr) {
  const N = fftSizeFor(sr), B = N / 2 + 1, out = new Float64Array(B);
  if (!profile) return out;
  const P = profile.power, srcB = P.length, hzPerSrc = profile.sr / profile.n, hz = sr / N;
  for (let k = 0; k < B; k++) {
    const pos = (k * hz) / hzPerSrc, i = Math.floor(pos), f = pos - i;
    out[k] = i + 1 < srcB ? P[i] * (1 - f) + P[i + 1] * f : P[srcB - 1] || 0;
  }
  return out;
}

/* ------------------------------------------------ Spectral denoiser */
class Denoiser {
  constructor(sr, channels, profile, { over, floorDb }, preGain) {
    const noise = profileFor(profile, sr).map((v) => v * preGain * preGain);
    const B = noise.length, floor = Math.pow(10, -floorDb / 20);
    const g = new Float64Array(B).fill(1), raw = new Float64Array(B), ps = new Float64Array(B);
    let first = true;
    this.stft = new Stft(sr, channels, (re, im) => {
      for (let k = 0; k < B; k++) {
        let p = 0; for (let c = 0; c < re.length; c++) p += re[c][k] * re[c][k] + im[c][k] * im[c][k];
        p /= re.length;
        // smoothed power: rises instantly (keeps speech onsets), falls gradually (steadies noise bins)
        ps[k] = first || p > ps[k] ? p : 0.55 * ps[k] + 0.45 * p;
        raw[k] = Math.max(floor, Math.sqrt(Math.max(0, 1 - (over * noise[k]) / (ps[k] + 1e-20))));
      }
      first = false;
      for (let k = 0; k < B; k++) { // smooth across frequency, then fast-attack / slow-release in time
        const sm = 0.25 * raw[Math.max(0, k - 1)] + 0.5 * raw[k] + 0.25 * raw[Math.min(B - 1, k + 1)];
        g[k] = sm > g[k] ? sm : 0.7 * g[k] + 0.3 * sm;
        for (let c = 0; c < re.length; c++) { re[c][k] *= g[k]; im[c][k] *= g[k]; }
      }
    });
    this.latency = this.stft.latency;
  }
  process(chans, n) { this.stft.process(chans, n); }
}

/* ---------------------------------------------------- Dynamics */
const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (v) => 20 * Math.log10(Math.max(v, 1e-12));
const coef = (ms, sr) => Math.exp(-1 / ((ms / 1000) * sr));

/** Splits off 6 kHz+ and turns it down when it dominates (sibilance). Perfect reconstruction at unity. */
class DeEsser {
  constructor(sr, channels, maxCutDb = 8) {
    this.hp = new FilterChain([biquad("highpass", 6000, sr, 0.7)], channels);
    this.ch = channels; this.max = maxCutDb;
    this.envHi = 0; this.envAll = 0; this.g = 1;
    this.aA = coef(1, sr); this.aR = coef(60, sr); this.gA = coef(2, sr); this.gR = coef(50, sr);
    this.tmp = Array.from({ length: channels }, () => new Float32Array(0));
  }
  process(chans, n) {
    for (let c = 0; c < this.ch; c++) { if (this.tmp[c].length < n) this.tmp[c] = new Float32Array(n); this.tmp[c].set(chans[c].subarray(0, n)); }
    this.hp.process(this.tmp, n);
    for (let i = 0; i < n; i++) {
      let hi = 0, all = 0;
      for (let c = 0; c < this.ch; c++) { hi = Math.max(hi, Math.abs(this.tmp[c][i])); all = Math.max(all, Math.abs(chans[c][i])); }
      this.envHi = hi > this.envHi ? this.aA * this.envHi + (1 - this.aA) * hi : this.aR * this.envHi + (1 - this.aR) * hi;
      this.envAll = all > this.envAll ? this.aA * this.envAll + (1 - this.aA) * all : this.aR * this.envAll + (1 - this.aR) * all;
      const excess = linToDb(this.envHi) - (linToDb(this.envAll) - 5); // hi band within 5 dB of the whole signal
      const target = this.envHi > 0.01 ? dbToLin(-Math.min(this.max, Math.max(0, excess * 1.2))) : 1;
      this.g = target < this.g ? this.gA * this.g + (1 - this.gA) * target : this.gR * this.g + (1 - this.gR) * target;
      if (this.g < 0.999) for (let c = 0; c < this.ch; c++) { const h = this.tmp[c][i]; chans[c][i] = chans[c][i] - h + h * this.g; }
    }
  }
}

/** Downward expander: lowers room tone between words. */
class Expander {
  constructor(sr, channels, { thresholdDb, ratio, rangeDb }) {
    Object.assign(this, { ch: channels, t: thresholdDb, r: ratio, range: rangeDb, env: 0, g: 1 });
    this.eA = coef(3, sr); this.eR = coef(80, sr); this.gA = coef(2, sr); this.gR = coef(150, sr);
  }
  process(chans, n) {
    for (let i = 0; i < n; i++) {
      let pk = 0; for (let c = 0; c < this.ch; c++) pk = Math.max(pk, Math.abs(chans[c][i]));
      this.env = pk > this.env ? this.eA * this.env + (1 - this.eA) * pk : this.eR * this.env + (1 - this.eR) * pk;
      const lvl = linToDb(this.env);
      const target = lvl < this.t ? dbToLin(Math.max(-this.range, (lvl - this.t) * (this.r - 1))) : 1;
      this.g = target > this.g ? this.gA * this.g + (1 - this.gA) * target : this.gR * this.g + (1 - this.gR) * target;
      for (let c = 0; c < this.ch; c++) chans[c][i] *= this.g;
    }
  }
}

/** Feed-forward compressor with a soft knee. */
class Compressor {
  constructor(sr, channels, { thresholdDb, ratio, kneeDb = 6, attackMs = 5, releaseMs = 120 }) {
    Object.assign(this, { ch: channels, t: thresholdDb, r: ratio, k: kneeDb, env: 0 });
    this.a = coef(attackMs, sr); this.rel = coef(releaseMs, sr);
  }
  gainDb(x) {
    const { t, r, k } = this, over = x - t;
    if (2 * over < -k) return 0;
    if (2 * Math.abs(over) <= k) return ((1 / r - 1) * (over + k / 2) ** 2) / (2 * k);
    return (1 / r - 1) * over;
  }
  process(chans, n) {
    for (let i = 0; i < n; i++) {
      let pk = 0; for (let c = 0; c < this.ch; c++) pk = Math.max(pk, Math.abs(chans[c][i]));
      this.env = pk > this.env ? this.a * this.env + (1 - this.a) * pk : this.rel * this.env + (1 - this.rel) * pk;
      const g = dbToLin(this.gainDb(linToDb(this.env)));
      for (let c = 0; c < this.ch; c++) chans[c][i] *= g;
    }
  }
}

/** Look-ahead peak limiter (5 ms). Adds `latency` samples of delay. Sliding-window minimum in O(1). */
class Limiter {
  constructor(sr, channels, ceilingDb = -1) {
    const L = Math.max(1, Math.round(sr * 0.005));
    Object.assign(this, { ch: channels, L, latency: L, ceil: dbToLin(ceilingDb), g: 1, pos: 0, t: 0 });
    this.buf = Array.from({ length: channels }, () => new Float32Array(L));
    // monotonic deque of (time, required gain), increasing gains from head to tail
    this.dqT = new Float64Array(L + 1); this.dqV = new Float64Array(L + 1); this.h = 0; this.n = 0;
    this.att = 1 - Math.exp(-4 / L); this.rel = coef(80, sr);
  }
  process(chans, n) {
    const { L, ch } = this, cap = L + 1;
    for (let i = 0; i < n; i++) {
      let pk = 0; for (let c = 0; c < ch; c++) { const v = Math.abs(chans[c][i]); if (v > pk) pk = v; }
      const need = pk > this.ceil ? this.ceil / pk : 1, t = this.t++;
      while (this.n && this.dqV[(this.h + this.n - 1) % cap] >= need) this.n--;
      const tail = (this.h + this.n) % cap; this.dqT[tail] = t; this.dqV[tail] = need; this.n++;
      while (this.dqT[this.h] <= t - L) { this.h = (this.h + 1) % cap; this.n--; }
      const want = this.dqV[this.h];
      this.g = want < this.g ? this.g + (want - this.g) * this.att : this.rel * this.g + (1 - this.rel) * want;
      for (let c = 0; c < ch; c++) {
        const delayed = this.buf[c][this.pos];
        this.buf[c][this.pos] = chans[c][i];
        let y = delayed * this.g;
        if (y > this.ceil) y = this.ceil; else if (y < -this.ceil) y = -this.ceil; // safety
        chans[c][i] = y;
      }
      this.pos = (this.pos + 1) % L;
    }
  }
}

/* ------------------------------------------------ Loudness (BS.1770) */
/** BS.1770 K-weighting for any rate (libebur128's design; equals the spec's 48 kHz coefficients). */
export function kWeighting(sr) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}
/** Integrated loudness meter (ITU-R BS.1770-4, gated). Feed the whole programme; read `.lufs()`. */
export class LoudnessMeter {
  constructor(sr, channels) {
    this.k = new FilterChain(kWeighting(sr), channels);
    this.ch = channels; this.sub = Math.round(sr * 0.1); this.acc = 0; this.cnt = 0; this.blocks = [];
    this.tmp = Array.from({ length: channels }, () => new Float32Array(0));
  }
  process(chans, n) {
    for (let c = 0; c < this.ch; c++) { if (this.tmp[c].length < n) this.tmp[c] = new Float32Array(n); this.tmp[c].set(chans[c].subarray(0, n)); }
    this.k.process(this.tmp, n);
    for (let i = 0; i < n; i++) {
      let s = 0; for (let c = 0; c < this.ch; c++) s += this.tmp[c][i] * this.tmp[c][i];
      this.acc += s;
      if (++this.cnt === this.sub) { this.blocks.push(this.acc / this.sub); this.acc = 0; this.cnt = 0; }
    }
  }
  lufs() {
    const b = this.blocks, ms = [];
    for (let i = 0; i + 4 <= b.length; i++) ms.push((b[i] + b[i + 1] + b[i + 2] + b[i + 3]) / 4); // 400 ms, 75 % overlap
    const L = (m) => -0.691 + 10 * Math.log10(m);
    const abs = ms.filter((m) => L(m) > -70);
    if (!abs.length) return -Infinity;
    const rel = L(abs.reduce((a, v) => a + v, 0) / abs.length) - 10;
    const gated = abs.filter((m) => L(m) > rel);
    return L(gated.reduce((a, v) => a + v, 0) / gated.length);
  }
}

/* ------------------------------------------------------- Presets */
export const VOICE_TONES = {
  // Close-miked dynamic broadcast microphone: warm, present, smooth top, little room.
  broadcast: { name: "Broadcast", eq: [["lowshelf", 140, 0.7, 3], ["peaking", 320, 1.1, -2.5], ["peaking", 4800, 0.8, 3.5], ["highshelf", 11000, 0.7, -4]],
    comp: { thresholdDb: -26, ratio: 3.5 }, expander: { thresholdDb: -46, ratio: 2, rangeDb: 12 }, deess: 8 },
  clear: { name: "Clear", eq: [["lowshelf", 120, 0.7, -1], ["peaking", 300, 1, -2], ["peaking", 3500, 1, 2], ["highshelf", 9000, 0.7, 2.5]],
    comp: { thresholdDb: -24, ratio: 2.5 }, expander: { thresholdDb: -48, ratio: 1.6, rangeDb: 8 }, deess: 6 },
  natural: { name: "Natural", eq: [], comp: { thresholdDb: -22, ratio: 1.8 }, expander: null, deess: 0 },
};
export const NOISE_LEVELS = { off: null, light: { over: 1.8, floorDb: 14 }, strong: { over: 3, floorDb: 26 } };
export const LOUDNESS_TARGETS = { "-14": -14, "-16": -16, off: null };
export const DEFAULT_AUDIO = { on: false, noise: "light", tone: "broadcast", loudness: "-14" };

/**
 * The full voice chain. Output is delayed by `latency` samples relative to input.
 * @param {object} o
 * @param {number} o.sr @param {number} o.channels
 * @param {{noise:string,tone:string}} o.settings
 * @param {{sr:number,n:number,power:Float32Array}|null} o.profile noise profile from NoiseProfiler
 * @param {number} o.preGainDb input gain so speech sits near −20 LUFS before dynamics
 * @param {number} o.postGainDb loudness gain after dynamics
 * @param {boolean} [o.limit=true] peak limiter at −1 dBFS
 */
export class VoiceChain {
  constructor({ sr, channels, settings, profile, preGainDb = 0, postGainDb = 0, limit = true }) {
    const tone = VOICE_TONES[settings.tone] || VOICE_TONES.natural;
    const nr = NOISE_LEVELS[settings.noise];
    this.ch = channels;
    this.pre = dbToLin(preGainDb); this.post = dbToLin(postGainDb);
    this.lowcut = new FilterChain([biquad("highpass", 80, sr, 0.54), biquad("highpass", 80, sr, 1.31)], channels); // 24 dB/oct
    this.nr = nr && profile ? new Denoiser(sr, channels, profile, nr, this.pre) : null;
    this.eq = tone.eq.length ? new FilterChain(tone.eq.map(([t, f, q, g]) => biquad(t, f, sr, q, g)), channels) : null;
    this.deess = tone.deess ? new DeEsser(sr, channels, tone.deess) : null;
    this.exp = tone.expander ? new Expander(sr, channels, tone.expander) : null;
    this.comp = new Compressor(sr, channels, tone.comp);
    this.lim = limit ? new Limiter(sr, channels, -1) : null;
    this.latency = (this.nr?.latency || 0) + (this.lim?.latency || 0);
  }
  /** Processes `n` samples of planar audio in place. */
  process(chans, n) {
    if (this.pre !== 1) for (const x of chans) for (let i = 0; i < n; i++) x[i] *= this.pre;
    this.lowcut.process(chans, n);
    this.nr?.process(chans, n);
    this.eq?.process(chans, n);
    this.deess?.process(chans, n);
    this.exp?.process(chans, n);
    this.comp.process(chans, n);
    if (this.post !== 1) for (const x of chans) for (let i = 0; i < n; i++) x[i] *= this.post;
    this.lim?.process(chans, n);
  }
}

/** Analysis gains: bring speech to −20 LUFS before the dynamics, then hit the target after them. */
export const preGainFor = (rawLufs) => (Number.isFinite(rawLufs) ? Math.min(30, Math.max(-12, -20 - rawLufs)) : 0);
export function postGainFor(target, rawLufs, chainLufs) {
  if (!Number.isFinite(chainLufs)) return 0;
  const want = target ?? rawLufs; // "off" keeps the original loudness
  return Math.min(30, Math.max(-30, want - chainLufs));
}
