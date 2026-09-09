// stroke-detector.js — pure signal-processing, shared by app + Node tests
//
// v4: windowed Goertzel scan + harmonic folding + quarter-window confidence.
// Evolution (all measured against the Moore et al. 2019 public dataset, 12 trials):
//   v1 peak counting:   1/7 row trials ±2 spm, 5/5 no-rowing false positives
//   v2 autocorrelation: real-water ACF peaks too weak (r≈0.1)
//   v3 Goertzel:        5/7 row trials, still 5/5 no-rowing FPs
//   v4: folding + stability confidence — wrong-but-confident becomes
//       correct, unstable becomes "--" (no display beats wrong display)
(function () {
  function smooth(buf, win = 5) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(buf.length - 1, i + win); j++) {
        s += buf[j].mag; n++;
      }
      out.push({ t: buf[i].t, mag: s / n });
    }
    return out;
  }

  // Sample rate (Hz) from [{t,...}] timestamps in ms (median delta).
  function sampleRate(samples) {
    const dts = [];
    for (let i = 1; i < samples.length; i++) {
      const d = samples[i].t - samples[i - 1].t;
      if (d > 0) dts.push(d);
    }
    if (dts.length < 10) return null;
    dts.sort((a, b) => a - b);
    const fs = 1000 / dts[Math.floor(dts.length / 2)];
    return isFinite(fs) && fs > 0 ? fs : null;
  }

  // One Goertzel pass: scan spmMin..spmMax (step), Hamming-tapered.
  // Returns {spm, ratio} where ratio = peakPower / medianPower, or null.
  function estimateOne(mags, fs, opts) {
    const spmMin = opts.spmMin ?? 12;
    const spmMax = opts.spmMax ?? 45;
    const spmStep = opts.spmStep ?? 0.5;
    const n = mags.length;
    const mean = mags.reduce((a, b) => a + b, 0) / n;
    const x = mags.map((v, i) => {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hamming
      return (v - mean) * w;
    });

    let bestSpm = -1, bestP = 0;
    const powers = [];
    for (let spm = spmMin; spm <= spmMax + 1e-9; spm += spmStep) {
      const f = spm / 60;
      const w = 2 * Math.PI * f / fs;
      const coef = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        const s0 = x[i] + coef * s1 - s2;
        s2 = s1; s1 = s0;
      }
      const p = (s1 * s1 + s2 * s2 - coef * s1 * s2) / (n * n);
      powers.push(p);
      if (p > bestP) { bestP = p; bestSpm = spm; }
    }
    if (bestSpm < 0) return null;

    // harmonic folding: catch subharmonic picks (12 spm shown as half of real 24)
    const foldK = opts.foldK ?? 0.35;
    if (bestSpm < spmMax / 1.6 && 2 * bestSpm <= spmMax) {
      const f = (2 * bestSpm) / 60;
      const w = 2 * Math.PI * f / fs;
      const coef = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        const s0 = x[i] + coef * s1 - s2;
        s2 = s1; s1 = s0;
      }
      const p2 = (s1 * s1 + s2 * s2 - coef * s1 * s2) / (n * n);
      if (p2 >= foldK * bestP) bestSpm = 2 * bestSpm;
    }

    const sorted = [...powers].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (med <= 0) return null;
    return { spm: bestSpm, ratio: bestP / med };
  }

  // Largest cluster (pairwise spread ≤ tol) of quarter peaks; the rowing
  // rate is stable, turning/docking noise is not — this is the FP killer.
  function stableCluster(spms, tol) {
    if (spms.length < 3) return null;
    const sorted = [...spms].sort((a, b) => a - b);
    for (let i = 0; i + 3 <= sorted.length; i++) {
      if (sorted[i + 2] - sorted[i] <= tol) {
        return (sorted[i] + sorted[i + 1] + sorted[i + 2]) / 3; // mean of 3
      }
    }
    return null;
  }

  // Main entry. samples: [{t (ms), mag}]. Returns spm (number) or null.
  function detectStrokeRate(samples, opts = {}) {
    const gateMin = opts.gateMinSpeed ?? 0.5;
    if (opts.gateSpeed != null && opts.gateSpeed < gateMin) return null;
    if (!samples || samples.length < (opts.minSamples ?? 60)) return null;
    const fs = sampleRate(samples);
    if (!fs) return null;

    // flat-water gate: no rowing = tiny oscillation
    const mags = samples.map(s => s.mag);
    const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
    const sd = Math.sqrt(mags.reduce((a, b) => a + (b - mean) ** 2, 0) / mags.length);
    if (sd < (opts.sdGate ?? 0.15)) return null;

    const secs = samples.length / fs;
    const full = estimateOne(mags, fs, opts);

    // confidence path 1: quarter-window agreement (needs ≥ 8 s)
    if (secs >= (opts.quarterMinSecs ?? 8)) {
      const qMin = Math.max(30, Math.round(1.2 * fs)); // ≥1.2 s per quarter
      const q = [];
      for (let k = 0; k < 4; k++) {
        const a = Math.floor((samples.length * k) / 4);
        const b = Math.floor((samples.length * (k + 1)) / 4);
        if (b - a >= qMin) {
          const e = estimateOne(mags.slice(a, b), fs, opts);
          if (e) q.push(e.spm);
        }
      }
      const cluster = stableCluster(q, opts.clusterTol ?? 2.5);
      if (cluster != null) return Math.round(cluster);
    }

    // confidence path 2: very prominent full-window peak (rate drifted mid-window
    // so quarters disagree, but the spectrum screams at one frequency)
    if (full && full.ratio >= (opts.ratioFallback ?? 8)) {
      return Math.round(full.spm);
    }

    // short buffers (live app start-up): single prominent estimate only
    if (secs < (opts.quarterMinSecs ?? 8) && full && full.ratio >= (opts.shortRatio ?? 6)) {
      return Math.round(full.spm);
    }

    return null;
  }

  const api = { smooth, detectStrokeRate, sampleRate, estimateOne, stableCluster };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.StrokeDetector = api;
})();
