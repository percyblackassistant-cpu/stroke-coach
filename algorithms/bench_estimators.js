// Stroke-rate benchmark estimators — analysis only, not part of the app.
//
// Three estimators + a harmonic-disambiguated variant of the deployed
// Goertzel detector, all process one buffer of samples [{t_ms, v}] and
// return {spm, extra}:
//   - yin: lag-domain pitch-style estimator on a highpassed, decimated signal
//   - anf: adaptive notch filter (gradient ANF) tracked continuously over the
//     session, reporting per-window median notch frequency
//   - goertzelHarmo: deployed detector scan modified with harmonic preference
// Baseline #4 = js/stroke-detector.js detectStrokeRate() unmodified.
//
// Signal model: stroke rate = [0.2..0.75] Hz on rowing accel.phonesample
(function () {
  // ---------- shared helpers ----------
  function toArr(samples) {
    // samples: [{t, mag}] like detector input or [{t, v}]
    const m = [];
    for (const s of samples) m.push('v' in s ? s.v : s.mag);
    return m;
  }
  function sampleRate(samples) {
    if (!samples || samples.length < 10) return null;
    const span = samples[samples.length - 1].t - samples[0].t;
    if (!(span > 0)) return null;
    const fs = 1000 * (samples.length - 1) / span;
    return isFinite(fs) && fs > 0 ? fs : null;
  }
  function highpass(x, fs, fc) {
    // one-pole DC blocker: y[k] = x[k] - x[k-1] + a*y[k-1]; corner ~ fc.
    // (A boxcar baseline subtractor was tried first: its sinc nulls land at
    // 0.1/0.2/0.3 Hz and NULL the very stroke tone we measure - caught after
    // the adaptive tracker stalled on flat local spectra.)
    const a = Math.exp(-2 * Math.PI * fc / fs);
    const y = new Array(x.length).fill(0);
    let prev = 0, prevX = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i] - prevX + a * prev;
      y[i] = v; prev = v; prevX = x[i];
    }
    return y;
  }
  function smoothArr(x, win) {
    const y = new Array(x.length).fill(0);
    for (let i = 0; i < x.length; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(x.length - 1, i + win);
           j++) { s += x[j]; c++; }
      y[i] = s / c;
    }
    return y;
  }
  // fraction-based decimate (keep 1 every k). For bench: converts to low fs.
  function decimate(x, fs, targetFs) {
    const k = Math.max(1, Math.floor(fs / targetFs));
    const y = [];
    for (let i = 0; i < x.length; i += k) {
      let s = 0, c = 0;
      for (let j = i; j < Math.min(x.length, i + k); j++) { s += x[j]; c++; }
      y.push(s / c);
    }
    return { x: y, fs: fs / k };
  }

  // ---------- 1. YIN / CMNDF ----------
  // picks the earliest lag in [lagMin..lagMax] where CMNDF < threshold.
  // Returns null when no lag satisfies threshold (signal not periodic).
  function yinSpmFromRawSamples(samples, opts = {}) {
    // yinSpmFromRawSamples: samples [{t, v}], band 12..45 spm
    const arr = toArr(samples);
    const fsRaw = sampleRate(samples);
    if (!fsRaw || arr.length < 50) return null;
    // band-limit: highpass at ~0.1 Hz to remove DC / slow tilt, then smooth a bit
    let x = highpass(arr, fsRaw, 0.1);
    x = smoothArr(x, 1);
    // decimate to <= 20 Hz (stroke band <= 0.75 Hz, 20 Hz is ample)
    const { x: xd, fs } = decimate(x, fsRaw, 20);
    return yinSpm(xd, fs, opts);
  }

  function yinSpm(xIn, fs, opts = {}) {
    const spmMin = opts.spmMin ?? 12, spmMax = opts.spmMax ?? 45;
    const thr = opts.yinThr ?? 0.2;   // absolute threshold per YIN paper default 0.1-0.2
    const N = xIn.length;
    const lagMax = Math.min(Math.floor(fs * 60 / spmMin), Math.floor(N / 2) - 1);
    const lagMin = Math.max(2, Math.floor(fs * 60 / spmMax));
    if (N < 2 * lagMax + 1) return null; // need enough data
    const W = Math.floor(N / 2);  // integration window
    const cmndf = new Float64Array(lagMax + 1);
    const d = new Float64Array(lagMax + 1);
    for (let tau = 0; tau <= lagMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const dd = xIn[j] - xIn[j + tau];
        s += dd * dd;
      }
      d[tau] = s;
    }
    cmndf[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= lagMax; tau++) {
      run += d[tau];
      cmndf[tau] = run === 0 ? 1 : d[tau] * tau / run;
    }
    // earliest lag below absolute threshold, with local-minimum refine
    let tauEst = -1;
    for (let tau = lagMin; tau <= lagMax; tau++) {
      if (cmndf[tau] < thr) {
        while (tau + 1 <= lagMax && cmndf[tau + 1] < cmndf[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) {
      // fall back: the global CMNDF minimum inside the band, flagged low-conf
      let best = Infinity, bi = -1;
      for (let tau = lagMin; tau <= lagMax; tau++) {
        if (cmndf[tau] < best) { best = cmndf[tau]; bi = tau; }
      }
      if (bi < 0 || best > (opts.absMasterThr ?? 0.8)) return null;
      tauEst = bi;
    }
    // parabolic refine around tauEst on cmndf
    let better = tauEst;
    if (tauEst > 1 && tauEst < lagMax) {
      const s0 = cmndf[tauEst - 1], s1 = cmndf[tauEst], s2 = cmndf[tauEst + 1];
      const den = 2 * (2 * s1 - s0 - s2);
      if (den !== 0) better = tauEst + (s2 - s0) / den;
    }
    return { spm: 60 * fs / better, cmndfMin: cmndf[tauEst], lag: tauEst };
  }

  function pwAt(x, fs, spm) {
    const f = spm / 60, w = 2 * Math.PI * f / fs, coef = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) {
      const s0 = x[i] + coef * s1 - s2; s2 = s1; s1 = s0;
    }
    return (s1 * s1 + s2 * s2 - coef * s1 * s2) / (x.length * x.length);
  }
  // ---------- 2. Adaptive notch / PLL (heterodyne adaptive oscillator) ----------
  // Gradient-ANF (FIR notch + steepest descent) was implemented and trailed
  // first: on clean tones it locks fine, but with a strong 2nd harmonic or
  // broadband noise the LS minimum jumps to 2f and random-walks (measured on
  // synth selftest). Replaced core with a heterodyne PLL, functionally the
  // "adaptive notch = adaptive oscillator" estimator: mix x by e^{-j*theta},
  // lowpass I/Q (this rejects harmonics: they rotate at k*f != DC), steer
  // instantaneous freq by the demodulated phase error. Equivalent to a
  // first-order PLL whose VCO frequency is the stroke-rate estimate.
  function anfTrack(samples, opts = {}) {
    const arr = toArr(samples);
    const fsRaw = sampleRate(samples);
    if (!fsRaw || arr.length < 50) return null;
    const { x, fs } = decimate(highpass(arr, fsRaw, 0.1), fsRaw, 20);
    // normalize amplitude
    let mu = 0;
    for (const v of x) mu += v; mu /= x.length;
    let sd = 0;
    for (const v of x) sd += (v - mu) ** 2; sd = Math.sqrt(sd / x.length) || 1;
    const xn = x.map(v => (v - mu) / sd);

    const fLo = (opts.spmMin ?? 12) / 60, fHi = (opts.spmMax ?? 45) / 60;
    // adaptive tracking: hop-wise LOCAL spectral scan restricted to +-capture
    // around the current notch center (the discrete-time analogue of a
    // first-order PLL/adaptive notch: band-limited pull, amplitude-gated,
    // EMA-smoothed). Converges in 1-2 hops from any in-band start.
    const hopSecs = opts.anfHopSecs ?? 0.5;
    const blkSecs = opts.anfBlkSecs ?? 4.0;
    const captureSpm = opts.anfCaptureSpm ?? 6.0;  // max spm shift per hop
    const ampGate = opts.anfAmpGate ?? 0.01;   // tone-power floor (norm block)       // tone power floor (norm x, unit-var => power ~ S_abs)
    const n = xn.length;
    const spmLog = [];
    let f = Math.sqrt(fLo * fHi);                  // notch center (Hz), band mid
    // warm-up at t=0: one full-band scan on the leading 10 s (Hann-reduced
    // leakage, 0.1 spm effective bin) so the tracker starts on the tone
    // instead of walking from band mid (halves time-to-reading).
    const warmSecs = Math.min(opts.anfWarmSecs ?? 10, n / fs);
    if (warmSecs >= 4) {
      const i1 = Math.min(n, Math.round(warmSecs * fs));
      const L = i1;
      const seg = xn.slice(0, i1).map((v, j) => v * (0.54 - 0.46 * Math.cos(2 * Math.PI * j / (L - 1))));
      const r = goertzelScan(seg, fs, { spmMin: opts.spmMin ?? 12, spmMax: opts.spmMax ?? 45, spmStep: 0.25 });
      let bi = 0;
      for (let i = 1; i < r.powers.length; i++) if (r.powers[i] > r.powers[bi]) bi = i;
      const sorted = [...r.powers].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const p = r.powers[bi];
      if (p > (opts.anfWarmAbs ?? 0.03) && p > (opts.anfWarmRatio ?? 1.5) * med) {
        f = r.spms[bi] / 60;
        // warm harmonic prune: prefer a comparable-power fundamental at f/2
        // (P(f/2) >= warmHarmT * P(f); measured ratio 0.93 on a synth tone
        // whose 2nd harmonic is slightly stronger than the fundamental)
        const warmHarmT = opts.anfHarmT ?? 0.82;
        let fW = f, pHB = p;
        for (const div of [2, 3]) {
          const candSpm = fW * 60 / div;
          if (candSpm < (opts.spmMin ?? 12)) break;
          const c = pwAt(seg, fs, candSpm);
          if (c >= warmHarmT * pHB) { fW = candSpm / 60; pHB = c; }
        }
        f = fW;
      }
    }
    const emaC = Math.exp(-1 / ((opts.anfTau ?? 1.2) / hopSecs)); // per-hop EMA
    let fS = f;
    for (let k0 = 0; k0 + blkSecs * fs < n + 1e-9; k0 += hopSecs * fs) {
      const i0 = Math.round(k0), i1 = Math.min(n, Math.round(k0 + blkSecs * fs));
      const segRaw = xn.slice(i0, i1);
      const L = segRaw.length;
      const seg = segRaw.map((v, j) => v * (0.54 - 0.46 * Math.cos(2 * Math.PI * j / (L - 1))));
      // local fine scan around current center within +-capture
      const cSpm = f * 60;
      const lo = Math.max(opts.spmMin ?? 12, cSpm - captureSpm);
      const hi = Math.min(opts.spmMax ?? 45, cSpm + captureSpm);
      const fPrev = f;
      const r = goertzelScan(seg, fs, { spmMin: lo, spmMax: hi, spmStep: 0.25 });
      if (!r.powers.length) break;
      let bi = 0;
      for (let i = 1; i < r.powers.length; i++) if (r.powers[i] > r.powers[bi]) bi = i;
      const p = r.powers[bi];
      // amplitude gate: absolute tone-power floor (block is normalized;
      // unit-variance quarter-sec blocks give real tone peaks >> 0.01)
      const med = [...r.powers].sort((a, b) => a - b)[Math.floor(r.powers.length / 2)];
      // tone gate: absolute power floor AND peakedness (peak/median). With a
      // Hann-tapered local scan the median sits off-lobe again; ratio ~1.2+
      // for tones, ~1.0 for white noise (measured on synth).
      const ratioGate = opts.anfRatioGate ?? 1.5;
      const atEdge = bi <= 1 || bi >= r.powers.length - 2;
      // edge-ridge reach: a real tone outside the +-capture window shows up
      // only as a leakage ridge at the scan edge (ratio ~1.2, measured).
      // Re-acquire it (steep absolute floor 0.03 keeps white noise out:
      // noise-block argmax ~0.01 on normalized Hann data).
      const edgeReach = atEdge && p > (opts.anfEdgeAbs ?? 0.12);
      if (p > ampGate && (p > ratioGate * med || edgeReach)) {
        const fT = r.spms[bi] / 60;
        // damped hop toward the local peak
        f = fPrev + (opts.anfDamp ?? 0.85) * (fT - fPrev);
      }
      fS = emaC * fS + (1 - emaC) * f;
      spmLog.push({ t: (i0 + i1) / 2 / fs, spm: fS * 60, amp: p / (med + 1e-30) });
    }
    return { spmLog, fs, n };
  }

  // summarize anfLog into per-window medians: given window centers & halfwidth
  function anfWindow(spmLog, t0, t1) {
    const vals = spmLog.filter(s => s.t >= t0 && s.t < t1).map(s => s.spm);
    if (!vals.length) return null;
    vals.sort((p, q) => p - q);
    return vals[Math.floor(vals.length / 2)];
  }

  // ---------- 3. Goertzel scan + harmonic disambiguation ----------
  // Same scan as deployed estimateOne, but with:
  //   - prefer the subharmonic f/2 when power(f) and power(f/2) are comparable
  //     and both in-band (the KEY fix for the 35.8-vs-17.9 lock): when
  //     p(f/2) > harmThreshold * p(f) AND p(f/2) is a real local tone (ratio
  //     check), report f/2.
  //   - explicit "prefer lower" rule: on ties (ratio>=0.5) take the lower one
  //     unless the lower's power is negligible (<0.25 of upper).
  function goertzelScan(x, fs, opts = {}) {
    const spmMin = opts.spmMin ?? 12, spmMax = opts.spmMax ?? 45;
    const spmStep = opts.spmStep ?? 0.5;
    const n = x.length;
    const mean = x.reduce((a, b) => a + b, 0) / n;
    const xs = x.map((v, i) => {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
      return (v - mean) * w;
    });
    const powers = []; const spms = [];
    for (let spm = spmMin; spm <= spmMax + 1e-9; spm += spmStep) {
      const f = spm / 60;
      const w = 2 * Math.PI * f / fs;
      const coef = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        const s0 = xs[i] + coef * s1 - s2;
        s2 = s1; s1 = s0;
      }
      powers.push((s1 * s1 + s2 * s2 - coef * s1 * s2) / (n * n));
      spms.push(spm);
    }
    return { powers, spms };
  }

  function powerAt(x, fs, spm) {
    const r = goertzelScan(x, fs, { spmMin: spm - 0.01, spmMax: spm + 0.01, spmStep: 1 });
    return r.powers[0];
  }

  function estimateOneHarmo(x, fs, opts = {}) {
    const { powers, spms } = goertzelScan(x, fs, opts);
    if (!powers.length) return null;
    let bi = 0;
    for (let i = 1; i < powers.length; i++) if (powers[i] > powers[bi]) bi = i;
    let spm = spms[bi], p = powers[bi];
    if (p <= 0 || !isFinite(p)) return null;

    // subtle peak with harmonics can alias upward: if p at f/2 in band and p(f/2)
    // is a comparable-sized tone, prefer the FUNDAMENTAL (f/2).
    const halfSpm = spm / 2;
    let promoted = false;
    if (halfSpm >= (opts.spmMin ?? 12) - 1e-6) {
      const ph = powerAt(x, fs, halfSpm);
      const rel = ph / p;
      // prefer f/2 when its power is not negligible AND the harmonic ratio is
      // at or below ~1 (protect against pure subharmonic spikes)
      if (rel >= (opts.harmoDownThr ?? 0.25) && rel <= 1.6) {
        spm = halfSpm; p = ph; promoted = true;
      }
    }
    // also: if the TRUE peak is at f but a much stronger 2f exists (data-dependent
    // spectral shape), prefer f only if p(f) is 'comparable' (>=0.5 * p(2f)):
    const doubleSpm = spm * 2;
    if (!promoted && doubleSpm <= (opts.spmMax ?? 45)) {
      const pd = powerAt(x, fs, doubleSpm);
      if (pd >= (opts.harmoUpThr ?? 1.2) * p && !opts.strictNoUp) {
        // a genuinely stronger 2f: keep the scan pick (already f) but flag
      }
    }
    // sub-step refinement on the scan spectrum (skip if we promoted: the
    // scan peak bin is the harmonic, not the fundamental)
    const refined = promoted ? spm : parabolicRefine(powers, spms, bi);
    const sorted = [...powers].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const ratio = med > 0 ? p / med : null;
    return { spm: refined, ratio, promoted };
  }

  function parabolicRefine(powers, spms, bi) {
    if (bi <= 0 || bi >= powers.length - 1) return spms[bi];
    const p0 = Math.log(powers[bi - 1] + 1e-30);
    const p1 = Math.log(powers[bi] + 1e-30);
    const p2 = Math.log(powers[bi + 1] + 1e-30);
    const den = p0 - 2 * p1 + p2;
    if (!(den < 0)) return spms[bi];
    return spms[bi] + 0.5 * (spms[1] - spms[0]) * (p0 - p2) / den;
  }

  // windowed API mirroring the deployed detector's shape so bench code can
  // call all estimators uniformly. Returns spm or null.
  function yinDetect(samples, opts) {
    const r = yinSpmFromRawSamples(samples, opts || {});
    return r ? r.spm : null;
  }
  function goertzelHarmoDetect(samples, opts) {
    if (!samples || samples.length < (opts?.minSamples ?? 60)) return null;
    const mags = toArr(samples);
    const fs = sampleRate(samples);
    if (!fs) return null;
    const hp = highpass(mags, fs, 0.1);
    const r = estimateOneHarmo(hp, fs, opts || {});
    return r ? r.spm : null;
  }

  const api = {
    yinSpmFromRawSamples, yinSpm, anfTrack, anfWindow,
    goertzelScan, estimateOneHarmo, yinDetect, goertzelHarmoDetect,
    sampleRate, highpass, decimate, toArr,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.BenchEstimators = api;
})();
