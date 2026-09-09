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

  // Sample rate (Hz) from [{t,...}] timestamps in ms — span-based: (n-1)/total.
  // Median-of-deltas breaks on jittery/repeating clocks (dataset log_time ticks
  // ~3ms between 100Hz rows → 324 Hz instead of 100; found validating v5).
  function sampleRate(samples) {
    if (!samples || samples.length < 10) return null;
    const span = samples[samples.length - 1].t - samples[0].t;
    if (!(span > 0)) return null;
    const fs = 1000 * (samples.length - 1) / span;
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

    // sub-step refinement: parabolic interpolation on log-power around the
    // peak. A 20s window has ~3 spm raw bin width — interpolation gets the
    // peak location to ~0.2 spm on a clean tone (needed for ±1 spm scoring).
    const idx = Math.round((bestSpm - spmMin) / spmStep);
    let refined = bestSpm;
    if (idx > 0 && idx < powers.length - 1) {
      const p0 = Math.log(powers[idx - 1] + 1e-30);
      const p1 = Math.log(powers[idx] + 1e-30);
      const p2 = Math.log(powers[idx + 1] + 1e-30);
      const denom = p0 - 2 * p1 + p2;
      if (denom < 0) refined = bestSpm + 0.5 * spmStep * (p0 - p2) / denom;
    }

    // harmonic folding: catch subharmonic picks (12 shown for real 24).
    // Down-folding (44→22) was tried and REVERTED: it collided with the
    // up-fold on 092004 (read 12 instead of 24) and lost a trial net.
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
    return { spm: Math.round(refined * 10) / 10, ratio: bestP / med };
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
    // gateSpeed may be a number or a getter (live app passes latest GPS speed)
    const gs = typeof opts.gateSpeed === 'function' ? opts.gateSpeed() : opts.gateSpeed;
    if (gs != null && gs < gateMin) return null;
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

    // split-half consistency helper: a true stroke tone produces strong,
    // agreeing peaks in BOTH halves; white noise (sd ≥ 0.3) picks independent
    // random peaks with low spectral ratio — 64% of no-rowing windows passed
    // path 2 before this gate (stress suite). Ratio floor must stay LOW
    // enough to keep real-water windows (Moore-2019 ratios measured 2.6-17.6
    // on 60s decimated windows; ~8 is the compromise, verified both suites).
    // Returns true/false; null when halves too short to judge (short buffers
    // must still work via path 2).
    function halvesAgree() {
      const halfN = Math.floor(samples.length / 2);
      if (halfN < (opts.splitMinSamples ?? 600)) {
        // halves too short for meaningful spectral ratios (short buffers):
        // fall back to the full-window ratio, which is the reliable noise
        // discriminator — white noise reads ~3, true tones read 50+ (a 20s
        // HALF can hit ratio 34 on chance peaks; the full window can't)
        return full.ratio >= (opts.fullRatioFloor ?? 12);
      }
      const h1 = estimateOne(mags.slice(0, halfN), fs, opts);
      const h2 = estimateOne(mags.slice(samples.length - halfN), fs, opts);
      if (!h1 || !h2) return null;
      const floor = opts.splitRatioFloor ?? 8;
      const tol = opts.splitTol ?? 3.5;
      const halvesOk = h1.ratio >= floor && h2.ratio >= floor &&
             Math.abs(h1.spm - h2.spm) <= tol;
      // white-noise chance peaks can fool both halves; the full-window ratio
      // (peak vs band median) separates them decisively
      return halvesOk && full.ratio >= (opts.fullRatioFloor ?? 12);
    }

    // confidence path 1: quarter-window agreement. Only meaningful when each
    // quarter contains ≥ ~3 strokes: at 16 spm a 20 s window's quarters have
    // 1.3 cycles each — per-quarter readings are garbage and the cluster gate
    // locks onto noise (read 14 for true 16 across ALL variants — found by the
    // stress suite). Gate on cycles-per-quarter using the full-window estimate.
    const qSecs = full ? (opts.quarterCycles ?? 3) * 60 / Math.max(full.spm, 1) : 0;
    if (full && secs >= 4 * qSecs) {
      const qMin = Math.max(30, Math.round(qSecs * fs));
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
      if (cluster != null && halvesAgree() !== false) return Math.round(cluster);
    }

    // confidence path 2: prominent full-window peak (rate drifted mid-window
    // so quarters disagree, but the spectrum is clear at one frequency).
    // Gated on split-half agreement when the halves are long enough to judge
    // (null = too short → allow, preserving short-buffer start-up behavior).
    if (full && full.ratio >= (opts.ratioFallback ?? 3)) {
      const agree = halvesAgree();
      if (agree !== false) {
        return Math.round(full.spm * 10) / 10;
      }
    }

    return null;
  }

  const api = { smooth, detectStrokeRate, sampleRate, estimateOne, stableCluster };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.StrokeDetector = api;
})();
