// stroke-detector.js — pure signal-processing, shared by app + Node tests
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

  // v0 peak-counting detector: local maxima above adaptive threshold.
  // Returns strokes-per-minute, or null when insufficient data.
  function detectStrokeRate(samples, opts = {}) {
    const minGapMs = opts.minGapMs ?? 300;   // >200 spm: no real stroke is that fast
    if (!samples || samples.length < 60) return null;
    const sm = smooth(samples);
    const mags = sm.map(s => s.mag);
    const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
    const sd = Math.sqrt(mags.reduce((a, b) => a + (b - mean) ** 2, 0) / mags.length);
    // flat-signal gate: real rowing produces large oscillation amplitude;
    // sensor jitter on calm water does not. Prevents false positives.
    if (sd < (opts.sdGate ?? 0.15)) return null;
    const thr = mean + (opts.threshK ?? 0.6) * sd;
    const peaks = [];
    let lastT = -1e9;
    for (let i = 1; i < sm.length - 1; i++) {
      if (sm[i].mag > thr && sm[i].mag >= sm[i - 1].mag && sm[i].mag > sm[i + 1].mag) {
        if (sm[i].t - lastT > minGapMs) { peaks.push(sm[i].t); lastT = sm[i].t; }
      }
    }
    if (peaks.length < 2) return null;
    const span = (peaks[peaks.length - 1] - peaks[0]) / 1000;
    return Math.round((peaks.length - 1) / span * 60);
  }

  const api = { smooth, detectStrokeRate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.StrokeDetector = api;
})();
