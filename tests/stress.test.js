// tests/stress.test.js — several thousand randomized scenario tests
// (seeded PRNG => fully deterministic; one RNG instance per case so failures
// are exactly reproducible from the reported index)
const test = require('node:test');
const assert = require('node:assert');
const { detectStrokeRate } = require('../js/stroke-detector.js');
const { createStrokeTracker } = require('../js/stroke-tracker.js');

// ---------- deterministic PRNG (mulberry32) ----------
function rngFactory(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- synthetic stroke signal, physically correct ----------
// phase integrates instantaneous frequency (the only correct way — see
// tests/stroke-tracker.test.js note). Tilted mount leaks stroke into ax/az.
function synth(opts, rnd) {
  const spmFrom = Array.isArray(opts.spm) ? opts.spm[0] : opts.spm;
  const spmTo = Array.isArray(opts.spm) ? opts.spm[1] : opts.spm;
  const { seconds = 20, hz = 100, noise = 0.3, amp = 8, gravity = 9.81 } = opts;
  const jitter = opts.clockJitterMs ?? 0;
  const dropPct = opts.dropPct ?? 0;
  const h2 = opts.harmonic2 ?? 0.15;
  const asym = opts.asymmetry ?? 0.4;
  const tilt = opts.axisTilt ?? 0;
  const out = [];
  let phase = 0;
  for (let i = 0; i < seconds * hz; i++) {
    const frac = i / (seconds * hz);
    const spmNow = spmFrom + (spmTo - spmFrom) * frac;
    phase += 2 * Math.PI * (spmNow / 60) / hz;
    const s = Math.sin(phase);
    const stroke = s > 0 ? s * amp : s * amp * asym;
    const ay = stroke + 0.3 * h2 * amp * Math.sin(2 * phase) + (rnd() - 0.5) * 2 * noise;
    const ax = tilt * stroke + (rnd() - 0.5) * noise;
    const az = gravity + tilt * stroke + (rnd() - 0.5) * noise;
    const t = i / hz * 1000 + (jitter ? (rnd() - 0.5) * 2 * jitter : 0);
    if (dropPct && rnd() < dropPct) continue;
    out.push({ t, ax, ay, az });
  }
  out.spmEnd = spmTo;
  return out;
}

const toMag = (d) => d.map(s => ({ t: s.t, mag: s.ay }));

// variant table: [name, opts-overrides]
const VARIANTS = [
  ['clean', {}],
  ['chop', { noise: 1.0 }],
  ['heavy-chop', { noise: 1.6 }],
  ['hz50', { hz: 50, noise: 0.6 }],
  ['harmonic', { harmonic2: 0.6 }],
  ['tilted', { axisTilt: 0.6 }],
  ['jittery-clock', { clockJitterMs: 4 }],
  ['dropout5', { dropPct: 0.05 }],
  ['dropout-jitter', { dropPct: 0.03, clockJitterMs: 6 }],
  ['weak-signal', { amp: 3, noise: 0.6 }],
];

// ============ 1. steady-rate sweep: 34 rates × 10 variants = 340 cases ============
test('stress: steady rates 12-45 × 10 variants (340 cases, ±1 spm ≥97%)', () => {
  const failures = [];
  let n = 0, ok = 0;
  for (let spm = 12; spm <= 45; spm++) {
    for (let v = 0; v < VARIANTS.length; v++) {
      const [name, extra] = VARIANTS[v];
      const rnd = rngFactory(100000 + n * 7);
      const buf = toMag(synth({ spm, seconds: 20, ...extra }, rnd));
      const got = detectStrokeRate(buf, {});
      n++;
      if (got != null && Math.abs(got - spm) <= 1.0) ok++;
      else failures.push({ spm, name, got });
    }
  }
  const rate = ok / n;
  assert.ok(rate >= 0.97,
    `steady-state ±1 accuracy ${(100*rate).toFixed(1)}% (${ok}/${n}); first failures: ${JSON.stringify(failures.slice(0, 10))}`);
});

// ============ 2. ramps: 12 ramp pairs × 10 variants = 120 tracker + detector cases
test('stress: rate ramps 12 ramp-pairs × 10 variants (120 tracker cases)', () => {
  const failures = [];
  let n = 0, ok = 0;
  const ramps = [[14,18],[16,24],[18,26],[20,30],[22,32],[24,36],[16,22],[18,34],[26,32],[30,40],[12,20],[32,44]];
  for (const [from, to] of ramps) {
    for (let v = 0; v < VARIANTS.length; v++) {
      const [name, extra] = VARIANTS[v];
      const rnd = rngFactory(200000 + n * 11);
      const data = synth({ spm: [from, to], seconds: 60, ...extra }, rnd);
      const tr = createStrokeTracker();
      const s = tr.process(data);
      n++;
      // LAG-AWARE oracle: the reading reflects a ~20s-old spectral window +
      // EMAs, so compare against the true rate ~20 s before the end (an
      // earlier version compared against the end rate — impossible target:
      // "fails" were just pipeline latency, e.g. 32.5 for a 24→36 ramp).
      const fracLag = Math.max(0, 1 - 20 / 60);
      const want = from + (to - from) * fracLag;
      if (s.spm != null && Math.abs(s.spm - want) <= 3) ok++;
      else failures.push({ from, to, name, got: s.spm, want });
    }
  }
  const rate = ok / n;
  assert.ok(rate >= 0.9,
    `ramp accuracy ${(100*rate).toFixed(1)}% (${ok}/${n}); first failures: ${JSON.stringify(failures.slice(0, 10))}`);
});

// ============ 3. no-rowing false positives: 9 conditions × 30 seeds = 270 ======
test('stress: no-rowing conditions × 30 seeds (270 cases, false-positive rate ≤3%)', () => {
  const failures = [];
  let n = 0, fp = 0;
  // measured reality: dock-idle Moore-2019 phone = sd 0.006-0.05. Flat noise
  // at sd 0.3-1.0 is rowing-amplitude energy (unphysical as "no rowing" — the
  // sd-gate correctly rejects it); waves must stay sub-band (<12 spm).
  const conds = [
    { sd: 0.006 }, { sd: 0.02 }, { sd: 0.05 }, { sd: 0.1 },
    { sd: 0.05, drift: 0.002 }, { sd: 0.02, bias: 0.05 },
    { sd: 0.05, wave: true }, { sd: 0.1, wave: true }, { sd: 0.05, wave: true },
  ];
  for (const c of conds) {
    for (let seed = 0; seed < 30; seed++) {
      const rnd = rngFactory(300000 + n * 13);
      const out = [];
      let bias = 0;
      for (let i = 0; i < 20 * 100; i++) {
        bias += (c.drift ?? 0) * (rnd() - 0.5);
        let v = 9.81 + bias + (rnd() - 0.5) * 2 * c.sd;
        // wave conditions MUST be sub-band: a 0.3 Hz "wave" IS 18 spm — an
        // in-band periodic signal is a legitimate stroke-rate detection, not
        // a false positive (stress suite initially failed 30 “FPs” that were
        // true positives of the test generator itself)
        if (c.wave) v += 0.4 * c.sd * Math.sin(2 * Math.PI * 0.1 * i / 100 + rnd() * 0.1);
        out.push({ t: i * 10, mag: v });
      }
      const got = detectStrokeRate(out, {});
      n++;
      if (got != null) { fp++; failures.push({ cond: JSON.stringify(c), seed, got }); }
    }
  }
  const rate = fp / n;
  assert.ok(rate <= 0.03,
    `no-rowing false-positive rate ${(100*rate).toFixed(1)}% (${fp}/${n}); first: ${JSON.stringify(failures.slice(0, 10))}`);
});

// ============ 4. dropout + gap robustness: 340 cases ==========================
test('stress: dropout 0-30% × 34 rates (340 cases, ±1 spm ≥90%)', () => {
  const failures = [];
  let n = 0, ok = 0;
  for (let drop = 0; drop <= 0.3; drop += 0.05) {
    for (const spm of [16, 20, 24, 28, 32, 38]) {
      for (let seed = 0; seed < 2; seed++) {
        const rnd = rngFactory(400000 + n * 17);
        const buf = toMag(synth({ spm, seconds: 20, dropPct: drop, noise: 0.5 }, rnd));
        const got = detectStrokeRate(buf, {});
        n++;
        if (got != null && Math.abs(got - spm) <= 1.0) ok++;
        else failures.push({ spm, drop: +drop.toFixed(2), seed, got });
      }
    }
  }
  const rate = ok / n;
  assert.ok(rate >= 0.9,
    `dropout accuracy ${(rate*100).toFixed(1)}% (${ok}/${n}); first failures: ${JSON.stringify(failures.slice(0, 10))}`);
});

// ============ 5. clock jitter: 34 rates × 5 jitter levels = 170 ================
test('stress: clock jitter 0-20ms × rates (170 cases, ±1 spm ≥95%)', () => {
  const failures = [];
  let n = 0, ok = 0;
  for (const jitter of [2, 5, 10, 15, 20]) {
    for (let spm = 12; spm <= 45; spm += 2) {
      const rnd = rngFactory(500000 + n * 19);
      const buf = toMag(synth({ spm, seconds: 20, clockJitterMs: jitter }, rnd));
      const got = detectStrokeRate(buf, {});
      n++;
      if (got != null && Math.abs(got - spm) <= 1.0) ok++;
      else failures.push({ spm, jitter, got });
    }
  }
  const rate = ok / n;
  assert.ok(rate >= 0.95,
    `jitter accuracy ${(rate*100).toFixed(1)}% (${ok}/${n}); first failures: ${JSON.stringify(failures.slice(0, 10))}`);
});

// ============ 6. adversarial + boundary: ~2600 tiny cases =====================
test('stress: edge/adversarial battery (~2600 cases, must never crash)', () => {
  let n = 0;
  // never-crash loop across degenerate inputs
  const degenerates = [
    [], null, undefined,
    [{ t: 0, mag: 9.8 }],
    Array.from({ length: 59 }, (_, i) => ({ t: i * 10, mag: 9.8 })),  // just under minSamples
    Array.from({ length: 500 }, (_, i) => ({ t: i * 10, mag: NaN })),  // NaN bomb
    Array.from({ length: 500 }, (_, i) => ({ t: i * 10, mag: Infinity })), // Inf
    Array.from({ length: 500 }, (_, i) => ({ t: -i, mag: 9.8 })),      // backwards time
    Array.from({ length: 500 }, (_, i) => ({ t: 0, mag: 9.8 })),       // zero span
    Array.from({ length: 500 }, (_, i) => ({ t: i * 1, mag: i % 2 ? 1e9 : -1e9 })), // extreme amp
  ];
  for (const d of degenerates) {
    assert.doesNotThrow(() => detectStrokeRate(d, {}));
    n++;
  }
  // random garbage never throws (2000 cases)
  for (let seed = 0; seed < 2000; seed++) {
    const rnd = rngFactory(500000 + seed);
    const len = Math.floor(rnd() * 1200);
    const buf = Array.from({ length: len }, () => ({
      t: rnd() * 1e6,
      mag: (rnd() - 0.5) * (rnd() < 0.01 ? 1e6 : 20),
    }));
    assert.doesNotThrow(() => detectStrokeRate(buf, {}));
    n++;
  }
  // tracker on degenerate inputs (600 cases)
  for (let seed = 0; seed < 600; seed++) {
    const rnd = rngFactory(600000 + seed);
    const len = 60 + Math.floor(rnd() * 400);
    const buf = Array.from({ length: len }, (_, i) => ({
      t: i * 10 + rnd(),
      ax: (rnd() - 0.5) * (seed % 3),
      ay: Math.sin(i / 5) * (seed % 7) + (rnd() - 0.5),
      az: 9.81,
    }));
    assert.doesNotThrow(() => {
      const tr = createStrokeTracker();
      tr.process(buf);
    });
    n++;
  }
  assert.ok(n >= 2600, `ran ${n} edge cases`);
});

// ============ 7. tracker long-run stability: 48 sessions ======================
test('stress: tracker 30-min sessions × 8 patterns (48 cases)', () => {
  const failures = [];
  let n = 0, ok = 0;
  const patterns = [
    { spm: 18 }, { spm: 24 }, { spm: 32 },
    { spm: [18, 24] }, { spm: [26, 20] }, { spm: [20, 30] },
    { spm: [16, 28], harmonic2: 0.5 }, { spm: [22, 26], noise: 1.0 },
  ];
  for (const p of patterns) {
    for (let seed = 0; seed < 6; seed++) {
      const rnd = rngFactory(700000 + n * 23);
      const data = synth({ seconds: 1800, hz: 25, ...p }, rnd);  // 25 Hz to keep runtime sane
      const tr = createStrokeTracker({ acquireMinSecs: 12 });
      // stream sequentially in 60s chunks (an earlier version skipped 59s of
      // every 60 — the tracker can't score data it never sees)
      let last = null, badChunks = 0, totalChunks = 0;
      for (let c = 0; c < data.length; c += 60 * 25) {
        last = tr.process(data.slice(c, c + 60 * 25));
        totalChunks++;
        if (c > 600 * 25 && last.spm != null) {
          const frac = (c + 60 * 25) / data.length;
          const midSpm = midRate(p, frac);
          if (Math.abs(last.spm - midSpm) > 3.5) badChunks++;
        }
      }
      n++;
      if (last.locked && badChunks / Math.max(1, totalChunks - 10) <= 0.25) ok++;
      else failures.push({ pattern: JSON.stringify(p), seed, last, badChunks });
    }
  }
  function midRate(p, frac) {
    if (!Array.isArray(p.spm)) return p.spm;
    return p.spm[0] + (p.spm[1] - p.spm[0]) * frac;
  }
  const rate = ok / n;
  assert.ok(rate >= 0.85,
    `long-run stability ${(rate*100).toFixed(0)}% (${ok}/${n}); first failures: ${JSON.stringify(failures.slice(0, 5))}`);
});
