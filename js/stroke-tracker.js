// stroke-tracker.js — pure module: phase-locked stroke tracker.
//
// v5 core per research recommendation (algorithms/RESEARCH-NOTES.md):
// acquisition = Goertzel scan (stroke-detector.js, only while unlocked),
// tracking = second-order phase-locked loop on the stroke harmonic:
//   state: thetaAbs (accumulated phase — an oscillator integrates phase
//     incrementally; recomputing from a fixed anchor multiplies every ω
//     correction by elapsed time and destabilizes the loop, found via synth),
//     omega (rad/s); demod: I = EMA(m0·cos θ), Q = EMA(−m0·sin θ)
//   control: steer only when demod amplitude is meaningful (noise random-walk
//     otherwise — found via synth: omega walked into the 12-spm clamp while
//     "locked"), hold ~0.8 s after acquire for I/Q EMAs to settle
// Outputs: continuous smoothed SPM (fixes the "bumpy" readout), stroke phase
// 0..1 (0 = catch), per-stroke normalized drive curves (erg-style shape).
(function () {
  let det;
  if (typeof module !== 'undefined' && module.exports) det = require('./stroke-detector.js');
  else if (typeof window !== 'undefined' && window.StrokeDetector) det = window.StrokeDetector;
  else det = { detectStrokeRate: () => null };

  function createStrokeTracker(opts = {}) {
    const spmMin = opts.spmMin ?? 12, spmMax = opts.spmMax ?? 45;
    const acqEveryMs = opts.acqEveryMs ?? 2000;
    const acquireMinSecs = opts.acquireMinSecs ?? 12;
    const winSecs = opts.winSecs ?? 20;
    const tauMs = opts.tauMs ?? 1200;          // demod EMA tau
    const sigVarTauMs = opts.sigVarTauMs ?? 1500;
    const ctrlMs = opts.ctrlMs ?? 250;
    const ctrlHoldMs = opts.ctrlHoldMs ?? 800; // ignore demod right after acquire
    const unlockAfterMs = opts.unlockAfterMs ?? 4000;
    const lockAmpFrac = opts.lockAmpFrac ?? 0.25;
    const ki = opts.ki ?? 0;                   // DEPRECATED: PLL must not steer freq (see control note)
    const kp = opts.kp ?? 0.12;                // phase snap fraction per step
    const maxOmegaStep = opts.maxOmegaStep ?? 0.05;
    const validatorAlpha = opts.validatorAlpha ?? 0.4; // omega EMA toward spectral reading
    const dispTauMs = opts.dispTauMs ?? 3000;  // display SPM EMA — final anti-jitter layer
    const detectorOpts = Object.assign({ spmStep: 0.1 }, opts.detectorOpts ?? {});

    let buf = [];                    // {t, mag, s|null}
    let fs = null, bufMax = 1500;
    let locked = false, omega = 0, thetaAbs = 0;
    let I = 0, Q = 0, iqInit = false, lastCtrl = 0, ctrlHoldUntil = 0;
    let lastAcq = 0, lastLowT = 0;
    let meanSig = 0, lastSig = null;
    const sigVar = { m: 0, v: 0 };
    let spm = null, spmDisp = null, lastT = null;
    let axisVars = [0, 0, 0], axisMeans = [0, 0, 0], nAx = 0, axisIdx = null, axisRechecked = false;
    let lastN = -1;
    let strokes = [];                // {catchT, curve|null}
    const maxStrokes = opts.maxStrokes ?? 12;
    const curveN = opts.curveN ?? 64;

    function estimateFs() {
      if (fs !== null) return fs;
      if (buf.length < 10) return null;
      // span-based: (n-1)/total-time. Median-of-deltas breaks when the clock
      // jitters or repeats ticks (dataset log_time ticks ~3ms between 100Hz
      // rows → median delta gave 324 Hz instead of 100).
      const span = buf[buf.length - 1].t - buf[0].t;
      if (!(span > 0)) return null;
      fs = 1000 * (buf.length - 1) / span;
      bufMax = Math.round(winSecs * fs * 1.3);
      return fs;
    }

    function theta(t) { return omega * (t - tLock) / 1000 + psi; }

    function unlock() { locked = false; iqInit = false; spm = null; spmDisp = null; lastLowT = 0; }

    // spectral helper: detector on the MOST RECENT winSecs of signed samples.
    // (Longer windows include the acquisition transient and systematically
    // disagree with steady-state readings — 092004 read 14 vs true 24 until
    // the window was clipped; found validating v5.1 on the dataset.)
    function recentSigned() {
      const signed = [];
      for (let i = 0; i < buf.length; i++) if (buf[i].s != null) signed.push({ t: buf[i].t, mag: buf[i].s });
      if (!fs) return signed;
      const cut = signed.length - Math.round(winSecs * fs);
      return cut > 0 ? signed.slice(cut) : signed;
    }

    function acquire(t) {
      if (t - lastAcq < acqEveryMs) return;
      const fr0 = estimateFs();
      if (fr0 === null || axisIdx === null) return;
      // acquisition ONLY on signed-axis samples: raw magnitude folds the stroke
      // to double frequency via gravity DC (√(g²+a²) ≈ g + a²/2g) which lands
      // outside the 12–45 spm band and locked the PLL to garbage
      const signed = [];
      for (let i = 0; i < buf.length; i++) if (buf[i].s != null) signed.push({ t: buf[i].t, mag: buf[i].s });
      if (signed.length < acquireMinSecs * fr0) return;
      lastAcq = t;
      const spm0 = det.detectStrokeRate(recentSigned(), detectorOpts);
      if (spm0 == null) return;
      omega = 2 * Math.PI * spm0 / 60;
      // FFT coefficient at omega: Σ s·e^{-iωt} ≈ (AN/2)e^{iφ} for s=A·cos(ωt+φ).
      // Initialize absolute phase so demod equilibrium (I>0, Q=0) is immediate.
      let re = 0, im = 0;
      for (let i = 0; i < signed.length; i++) {
        const w = -omega * signed[i].t / 1000;
        re += signed[i].mag * Math.cos(w);
        im += signed[i].mag * Math.sin(w);
      }
      thetaAbs = omega * t / 1000 + Math.atan2(im, re);
      locked = true; iqInit = false;
      lastCtrl = t; ctrlHoldUntil = t + ctrlHoldMs;
      lastLowT = t;
      lastN = Math.floor(thetaAbs / (2 * Math.PI));
    }

    function expectAmp() {
      // sinusoid amplitude A → demod |I+iQ| ≈ A/2 → full-scale 2·|I+iQ| ≈ A
      const a = Math.sqrt(Math.max(sigVar.v, 1e-12)) * Math.SQRT2;
      return Math.max(a, 1e-4);
    }

    function onCycle(t) {
      if (axisIdx === null || !fs) return;
      const T = 2 * Math.PI / omega * 1000;
      const t0w = t - 0.75 * T;
      let minT = null, minV = Infinity;
      for (let i = buf.length - 1; i >= 0; i--) {
        const s = buf[i];
        if (s.t < t0w) break;
        if (s.t <= t && s.s != null && s.s < minV) { minV = s.s; minT = s.t; }
      }
      if (minT === null) return;
      if (strokes.length && Math.abs(strokes[0].catchT - minT) < 0.35 * T) return;
      strokes.unshift({ catchT: minT, curve: null });
      if (strokes.length > maxStrokes) strokes.pop();
    }

    function findIdx(tt) {
      for (let i = buf.length - 1; i >= 0; i--) if (buf[i].t <= tt) return i;
      return -1;
    }

    function buildCurves(tEnd) {
      if (!fs) return;
      for (const st of strokes) {
        if (st.curve !== null) continue;
        const T = 2 * Math.PI / omega * 1000;
        const eT = st.catchT + 0.55 * T;       // drive ≈ 55% of cycle
        if (eT > tEnd) continue;
        const i0 = findIdx(st.catchT), i1 = findIdx(eT);
        if (i0 < 0 || i1 < 0 || i1 - i0 < 8) continue;
        if (buf[i0].s == null || buf[i1].s == null) continue;
        const pts = [];
        for (let k = 0; k < curveN; k++) {
          const target = st.catchT + (eT - st.catchT) * k / (curveN - 1);
          let j = i0;
          while (j < i1 && buf[j + 1].t < target) j++;
          const a = buf[j], b = buf[Math.min(j + 1, buf.length - 1)];
          const f = b.t > a.t ? Math.min(1, Math.max(0, (target - a.t) / (b.t - a.t))) : 0;
          pts.push(a.s * (1 - f) + b.s * f);
        }
        const mx = Math.max(...pts.map(Math.abs)) || 1;
        st.curve = pts.map(v => Math.round(v / mx * 1000) / 1000);
      }
      while (strokes.length && strokes[strokes.length - 1].curve === null &&
             tEnd - strokes[strokes.length - 1].catchT > winSecs * 1000) strokes.pop();
    }

    function update(t, ax, ay, az, magOverride) {
      let mag = magOverride ?? null;
      let s = null;
      if (ax != null) {
        const vals = [ax, ay, az];
        nAx++;
        // GRAVITY INVARIANCE (Bence, 09-10): the gravity vector is a CONSTANT
        // of arbitrary orientation — we never know which axis it points down.
        // So: estimate each axis mean cumulatively (optimal for a constant),
        // subtract it, and select the axis by DEVIATION variance. A 45°-tilted
        // phone spreads gravity over two axes; after DC removal only the
        // stroke axis has real variance, wherever gravity points.
        for (let k = 0; k < 3; k++) axisMeans[k] += (vals[k] - axisMeans[k]) / nAx;
        const dev = [0, 0, 0];
        for (let k = 0; k < 3; k++) dev[k] = vals[k] - axisMeans[k];
        const dtAx = lastT === null ? 10 : Math.max(1, t - lastT);
        const aAx = dtAx / (sigVarTauMs + dtAx);
        for (let k = 0; k < 3; k++) {
          axisVars[k] += aAx * (dev[k] * dev[k] - axisVars[k]);
        }
        const fr = estimateFs();
        // select at 5 s (cumulative means converged enough); one recheck at 15 s
        if (fr && axisIdx === null && nAx > fr * 5) {
          axisIdx = axisVars.indexOf(Math.max(...axisVars));
        }
        if (fr && nAx > fr * 15 && !axisRechecked) {
          axisRechecked = true;
          const best = axisVars.indexOf(Math.max(...axisVars));
          if (best !== axisIdx) axisIdx = best;
        }
        // signed feed = gravity-REMOVED dynamic acceleration
        if (axisIdx !== null) s = dev[axisIdx];
        if (mag === null) mag = Math.sqrt(ax * ax + ay * ay + az * az);
      }
      const sig = (s != null ? s : mag);
      lastSig = sig;
      const dt0 = lastT === null ? 10 : Math.max(1, t - lastT);
      const a0 = dt0 / (sigVarTauMs + dt0);
      sigVar.m += a0 * (sig - sigVar.m);
      sigVar.v += a0 * ((sig - sigVar.m) ** 2 - sigVar.v);
      meanSig += dt0 / (tauMs + dt0) * (sig - meanSig);
      if (mag == null) return state();
      buf.push({ t, mag, s });
      if (buf.length > bufMax) buf.splice(0, buf.length - bufMax);

      estimateFs();
      if (!locked) { acquire(t); lastT = t; return state(); }

      // periodic validator (research: two-stage hybrid): the spectral detector
      // re-runs on the rolling signed buffer even while locked; its reading is
      // EMA-blended into omega. This is the ONLY frequency authority — see the
      // control-step note for why the PLL must not steer frequency.
      if (t - lastAcq >= acqEveryMs * 2) {
        const signed = recentSigned();
        if (fs && signed.length >= acquireMinSecs * fs) {
          lastAcq = t;
          const spmV = det.detectStrokeRate(signed, detectorOpts);
          if (spmV != null) {
            const target = 2 * Math.PI * spmV / 60;
            omega = omega * validatorAlpha + target * (1 - validatorAlpha);
          }
        }
      }

      // demodulate the signed axis at the accumulated phase
      const th = thetaAbs;
      const dt = lastT === null ? 10 : Math.max(1, t - lastT);
      const alpha = dt / (tauMs + dt);
      const m0 = sig - meanSig;
      const c = m0 * Math.cos(th), q = -m0 * Math.sin(th);
      if (!iqInit) { I = c; Q = q; iqInit = true; }
      else { I += alpha * (c - I); Q += alpha * (q - Q); }
      // oscillator advances incrementally: thetaAbs += ω·dt (never recompute
      // from an anchor — see header note)
      thetaAbs += omega * dt / 1000;
      lastT = t;

      // control step: phase-only. Frequency is NOT steered by the PLL: real
      // stroke waveforms are asymmetric, which biases atan2 systematically and
      // walks omega to the clamps (12 or 44 spm) no matter the gain — v5 lost
      // 5/8 trials this way. Frequency authority belongs to the spectral
      // validator (EMA-blended below); the loop only keeps phase aligned so
      // stroke segmentation stays stable.
      const amp = 2 * Math.hypot(I, Q);
      const ea = expectAmp();
      if (t >= ctrlHoldUntil && t - lastCtrl >= ctrlMs && amp > lockAmpFrac * ea) {
        lastCtrl = t;
        const err = Math.atan2(Q, I);
        if (opts.onControl) opts.onControl(t, { err, omega, I, Q, amp, ea });
        thetaAbs += kp * err;   // phase snap only
      }

      // lock quality: demod amp vs signal oscillation size
      if (amp < lockAmpFrac * ea) {
        if (!lastLowT) lastLowT = t;
      } else lastLowT = t;
      if (lastLowT && t - lastLowT > unlockAfterMs) { unlock(); return state(); }

      // stroke cycle events + curve building
      const n = Math.floor(thetaAbs / (2 * Math.PI));
      if (n > lastN) { lastN = n; onCycle(t); }
      buildCurves(t);

      spm = omega * 60 / (2 * Math.PI);
      // display smoothing: exponential average over ~dispTauMs (tracker omega
      // follows the spectrum, which legitimately wobbles on real water)
      if (spmDisp === null) spmDisp = spm;
      else spmDisp += (dt / (dispTauMs + dt)) * (spm - spmDisp);
      return state();
    }

    function state() {
      const ph = locked && omega > 0
        ? (((thetaAbs % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)
        : null;
      return { locked, spm: spmDisp === null ? null : Math.round(spmDisp * 10) / 10, phase: ph };
    }

    function driveCurve() {
      const done = strokes.filter(s => s.curve).map(s => s.curve);
      if (done.length < 3) return null;
      const out = new Array(curveN);
      for (let k = 0; k < curveN; k++) {
        const col = done.map(c => c[k]).sort((a, b) => a - b);
        out[k] = col[Math.floor(col.length / 2)];
      }
      return out;
    }

    // bulk entry for tests/validation: [{t, ax,ay,az}] or [{t, mag}]
    function process(samples) {
      let last = null;
      for (const s of samples) {
        last = (s.ax != null)
          ? update(s.t, s.ax, s.ay, s.az)
          : update(s.t, null, null, null, s.mag);
      }
      return last;
    }

    return { update, process, state, driveCurve,
             debug: () => ({ fs, locked, omega, axisIdx, axes: axisVars.slice(), strokes: strokes.length, sigVar: sigVar.v, amp: 2 * Math.hypot(I, Q), exp: expectAmp() }) };
  }

  const api = { createStrokeTracker };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.StrokeTracker = api;
})();
