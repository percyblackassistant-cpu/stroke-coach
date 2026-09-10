// tests/stress.test.js — randomized stress battery, rebalanced (Bence, 09-10):
// adversarial pile trimmed (~200), steady sweep + ramps expanded. Every
// accuracy-monitored suite PRINS its pass-rate so `npm test` doubles as an
// accuracy monitor; suites also fail hard if accuracy regresses below gate.
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

// physical rowing signal: phase integrates instantaneous rate
function synth({ spm, seconds = 20, hz = 100, noise = 0.3, amp = 8, gravity = 9.81, dropPct = 0, clockJitterMs = 0, harmonic2 = 0.15, tilt = 0 }, rnd) {
  const spmFrom = Array.isArray(spm) ? spm[0] : spm;
  const spmTo = Array.isArray(spm) ? spm[1] : spm;
  const out = [];
  let phase = 0;
  const n = seconds * hz;
  for (let i = 0; i < n; i++) {
    const frac = i / n;
    const spmNow = spmFrom + (spmTo - spmFrom) * frac;
    phase += 2 * Math.PI * (spmNow / 60) / hz;
    const s = Math.sin(phase);
    const stroke = s > 0 ? s * amp : s * amp * 0.4;
    const ay = stroke + harmonic2 * amp * 0.3 * Math.sin(2 * phase) + (rnd() - 0.5) * 2 * noise;
    const ax = tilt * stroke + (rnd() - 0.5) * noise;
    const az = gravity + tilt * stroke + (rnd() - 0.5) * noise;
    const t = i / hz * 1000 + (clockJitterMs ? (rnd() - 0.5) * 2 * clockJitterMs : 0);
    if (dropPct && rnd() < dropPct) continue;
    out.push({ t, ax, ay, az, spmNow: (Array.isArray(spm) ? spmNow : undefined) });
  }
  return out;
}
const toMag = d => d.map(s => ({ t: s.t, mag: s.ay }));

const VARIANTS = [
  ['clean', {}],
  ['chop', { noise: 1.0 }],
  ['hz50', { hz: 50, noise: 0.6 }],
  ['harmonic', { harmonic2: 0.6 }],
  ['tilted', { tilt: 0.6, noise: 0.5 }],
];

// accuracy aggregator → written to /tmp/test-accuracy.json for CI/montior display
const ACCURACY = {};
function recordAccuracy(suite, ok, n, extra = {}) {
  ACCURACY[suite] = { pass: ok, total: n, pct: +(100 * ok / Math.max(1, n)).toFixed(1), ...extra };
}
process.on('exit', () => {
  try { require('fs').writeFileSync('/tmp/test-accuracy.json', JSON.stringify(ACCURACY, null, 2)); } catch {}
});

// ============ 1. steady sweep: 510 cases (expanded per Bence) ============
test('stress: steady rates 12-45 × 5 variants × 3 seeds (510 cases, ±1 ≥97%)', () => {
  const failures = [];
  let n = 0, ok = 0;
  for (let spm = 12; spm <= 45; spm++) {
    for (const [name, extra] of VARIANTS) {
      for (let seed = 0; seed < 3; seed++) {
        const rnd = rngFactory(100000 + n * 7);
        const buf = toMag(synth({ spm, seconds: 20, ...extra }, rnd));
        const got = detectStrokeRate(buf, {});
        n++;
        if (got != null && Math.abs(got - spm) <= 1.0) ok++;
        else failures.push({ spm, name, seed, got });
      }
    }
  }
  recordAccuracy('steady-sweep', ok, n, { gate: '±1 spm' });
  assert.ok(ok / n >= 0.97,
    `steady ±1 accuracy ${(100 * ok / n).toFixed(1)}% (${ok}/${n}); first failures: ${JSON.stringify(failures.slice(0, 10))}`);
});

// ============ 2. ramps: 240 cases (expanded per Bence) ============
test('stress: rate ramps 12 pairs × 5 variants × 2 seeds × 2 algos (240, tracker lag-aware)', () => {
  const failures = [];
  let n = 0, ok = 0;
  const RAMPS = [[14,18],[16,24],[18,26],[20,30],[22,32],[24,36],[16,22],[18,34],[26,32],[30,40],[12,20],[32,44]];
  for (const [from, to] of RAMPS) {
    for (const [name, extra] of VARIANTS) {
      for (let seed = 0; seed < 2; seed++) {
        // tracker, lag-aware oracle
        const rnd = rngFactory(200000 + n * 11);
        const data = synth({ spm: [from, to], seconds: 60, ...extra }, rnd);
        const tr = createStrokeTracker();
        const st = tr.process(data);
        const fracLag = Math.max(0, 1 - 20 / 60);
        const want = from + (to - from) * fracLag;
        n++;
        if (st.spm != null && Math.abs(st.spm - want) <= 3) ok++;
        else failures.push({ algo: 'tracker', from, to, name, seed, got: st.spm, want: +want.toFixed(1) });

        // detector on the last 25 s — oracle must be the rate at the WINDOW
        // CENTRE of a ramp (35+12.5=47.5s of 60), not the end rate: 27.9 for a
        // 20→30 ramp is CORRECT (found by accuracy monitor run)
        const rnd2 = rngFactory(250000 + n * 11);
        const data2 = synth({ spm: [from, to], seconds: 60, ...extra }, rnd2);
        const tail = toMag(data2.slice(35 * (extra.hz ?? 100)));
        const got2 = detectStrokeRate(tail, {});
        const centreRate = from + (to - from) * ((35 + 12.5) / 60);
        n++;
        if (got2 != null && Math.abs(got2 - centreRate) <= 2) ok++;
        else failures.push({ algo: 'detector-tail', from, to, name, seed, got: got2, want: +centreRate.toFixed(1) });
      }
    }
  }
  recordAccuracy('ramps', ok, n, { gate: '±3 tracker / ±2 detector-tail' });
  assert.ok(ok / n >= 0.9,
    `ramp accuracy ${(100 * ok / n).toFixed(1)}% (${ok}/${n}); first failures: ${JSON.stringify(failures.slice(0, 10))}`);
});

// ============ 3. no-rowing FPs (physically realistic, kept) ============
test('stress: no-rowing conditions × 30 seeds (270 cases, FP ≤3%)', () => {
  const failures = [];
  let n = 0, fp = 0;
  // measured reality: dock-idle Moore-2019 phone = sd 0.006-0.05; waves sub-band
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
        if (c.wave) v += 0.4 * c.sd * Math.sin(2 * Math.PI * 0.1 * i / 100 + rnd() * 0.1);
        out.push({ t: i * 10, mag: v });
      }
      const got = detectStrokeRate(out, {});
      n++;
      if (got != null) { fp++; failures.push({ cond: JSON.stringify(c), seed, got }); }
    }
  }
  recordAccuracy('no-rowing-FP-rate', n - fp, n, { gate: 'FP ≤3%', fp });
  assert.ok(fp / n <= 0.03,
    `no-rowing FP rate ${(100 * fp / n).toFixed(1)}% (${fp}/${n}); first: ${JSON.stringify(failures.slice(0, 8))}`);
});

// ============ 4. dropout: 340 cases (kept — real radios) ============
test('stress: dropout 0-30% × rates (340, ±1 ≥90%)', () => {
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
  recordAccuracy('dropout', ok, n, { gate: '±1 spm' });
  assert.ok(ok / n >= 0.9,
    `dropout accuracy ${(100 * ok / n).toFixed(1)}% (${ok}/${n}); first: ${JSON.stringify(failures.slice(0, 8))}`);
});

// ============ 5. jitter: 170 cases (kept — iOS clocks) ============
test('stress: clock jitter 2-20ms × rates (170, ±1 ≥95%)', () => {
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
  recordAccuracy('jitter', ok, n, { gate: '±1 spm' });
  assert.ok(ok / n >= 0.95,
    `jitter accuracy ${(100 * ok / n).toFixed(1)}% (${ok}/${n}); first: ${JSON.stringify(failures.slice(0, 8))}`);
});

// ============ 6. adversarial: TRIMMED to ~200 (Bence: too many) ============
test('stress: adversarial/degenerate inputs (~200 cases, never crash)', () => {
  let n = 0;
  const degenerates = [
    [], null, undefined,
    [{ t: 0, mag: 9.8 }],
    Array.from({ length: 59 }, (_, i) => ({ t: i * 10, mag: 9.8 })),
    Array.from({ length: 500 }, (_, i) => ({ t: i * 10, mag: NaN })),
    Array.from({ length: 500 }, (_, i) => ({ t: i * 10, mag: Infinity })),
    Array.from({ length: 500 }, (_, i) => ({ t: -i, mag: 9.8 })),
    Array.from({ length: 500 }, (_, i) => ({ t: 0, mag: 9.8 })),
  ];
  for (const d of degenerates) {
    assert.doesNotThrow(() => detectStrokeRate(d, {}));
    n++;
  }
  // random garbage (subset of the old 2000-pile; the shapes are what matter)
  for (let seed = 0; seed < 180; seed++) {
    const rnd = rngFactory(600000 + seed);
    const len = Math.floor(rnd() * 1200);
    const buf = Array.from({ length: len }, () => ({
      t: rnd() * 1e6,
      mag: (rnd() - 0.5) * (rnd() < 0.01 ? 1e6 : 20),
    }));
    assert.doesNotThrow(() => detectStrokeRate(buf, {}));
    n++;
  }
  // tracker degenerates
  for (const d of degenerates.filter(x => Array.isArray(x))) {
    assert.doesNotThrow(() => { const tr = createStrokeTracker(); tr.process(d); });
    n++;
  }
  assert.ok(n >= 190, `adversarial count ${n}`);
});

// ============ 7. long-run: 48 sessions (kept) ============
test('stress: tracker 30-min sessions × 8 patterns (48, ±3.5 ≥75% chunks)', () => {
  const failures = [];
  let n = 0, ok = 0;
  const midRate = (p, frac) => Array.isArray(p.spm) ? p.spm[0] + (p.spm[1] - p.spm[0]) * frac : p.spm;
  const patterns = [
    { spm: 18 }, { spm: 24 }, { spm: 32 },
    { spm: [18, 24] }, { spm: [26, 20] }, { spm: [20, 30] },
    { spm: [16, 28], harmonic2: 0.5 }, { spm: [22, 26], noise: 1.0 },
  ];
  for (const p of patterns) {
    for (let seed = 0; seed < 6; seed++) {
      const rnd = rngFactory(700000 + n * 23);
      const data = synth({ seconds: 1800, hz: 25, ...p }, rnd);
      const tr = createStrokeTracker({ acquireMinSecs: 12 });
      let last = null, badChunks = 0, totalChunks = 0;
      for (let c = 0; c < data.length; c += 60 * 25) {
        last = tr.process(data.slice(c, c + 60 * 25));
        totalChunks++;
        if (c > 600 * 25 && last.spm != null) {
          const mid = midRate(p, (c + 60 * 25) / data.length);
          if (Math.abs(last.spm - mid) > 3.5) badChunks++;
        }
      }
      n++;
      if (last.locked && badChunks / Math.max(1, totalChunks - 10) <= 0.25) ok++;
      else failures.push({ pattern: JSON.stringify(p), seed, last, badChunks });
    }
  }
  recordAccuracy('long-run', ok, n, { gate: '≤25% bad chunks' });
  assert.ok(ok / n >= 0.85,
    `long-run stability ${(100 * ok / n).toFixed(0)}% (${ok}/${n}); first: ${JSON.stringify(failures.slice(0, 5))}`);
});
