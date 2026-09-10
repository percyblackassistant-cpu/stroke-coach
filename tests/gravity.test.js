// tests/gravity.test.js — gravity-orientation invariance battery (Bence, 09-10)
//
// Requirement: we never know which axis gravity points down; the only
// invariant is that the gravity VECTOR is constant throughout rowing.
// So: synthesize rowing with gravity spread across axes at many orientations
// (polar θ × azimuth φ), verify the tracker locks the true rate in every case.
const test = require('node:test');
const assert = require('node:assert');
const { createStrokeTracker } = require('../js/stroke-tracker.js');
const { detectStrokeRate } = require('../js/stroke-detector.js');

function rngFactory(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rowing on "ay" (any axis works; tracker must pick it), gravity vector
// (gx, gy, gz) added raw = the physical sensor reading. phase integrates rate.
function synthWithGravity({ spm, seconds, hz = 100, noise = 0.3, amp = 8, g = [0, 0, 9.81] }, rnd) {
  const out = [];
  let phase = 0;
  const n = seconds * hz;
  for (let i = 0; i < n; i++) {
    phase += 2 * Math.PI * (spm / 60) / hz;
    const s = Math.sin(phase);
    const stroke = s > 0 ? s * amp : s * amp * 0.4;
    out.push({
      t: i / hz * 1000,
      ax: g[0] + (rnd() - 0.5) * noise,
      ay: g[1] + stroke + (rnd() - 0.5) * 2 * noise,
      az: g[2] + (rnd() - 0.5) * noise,
    });
  }
  return out;
}

// 56 orientations: θ polar 0..90° step 15 (7) × φ azimuth step 45° (8)
function gravityVector(thetaDeg, phiDeg) {
  const th = thetaDeg * Math.PI / 180, ph = phiDeg * Math.PI / 180;
  return [
    9.81 * Math.sin(th) * Math.cos(ph),
    9.81 * Math.sin(th) * Math.sin(ph),
    9.81 * Math.cos(th),
  ];
}

test('gravity battery: 56 orientations × 2 seeds — tracker locks ±1 spm ≥95%', () => {
  const failures = [];
  let n = 0, ok = 0;
  for (let th = 0; th <= 90; th += 15) {
    for (let ph = 0; ph < 360; ph += 45) {
      for (let seed = 0; seed < 2; seed++) {
        const rnd = rngFactory(800000 + n * 29);
        const data = synthWithGravity({ spm: 24, seconds: 40, g: gravityVector(th, ph) }, rnd);
        const tr = createStrokeTracker();
        const s = tr.process(data);
        n++;
        if (s.locked && s.spm != null && Math.abs(s.spm - 24) <= 1) ok++;
        else failures.push({ th, ph, seed, state: s });
      }
    }
  }
  const rate = ok / n;
  assert.ok(rate >= 0.95,
    `gravity-invariance accuracy ${(rate * 100).toFixed(1)}% (${ok}/${n}); ` +
    `first failures: ${JSON.stringify(failures.slice(0, 6))}`);
});

test('gravity battery: detector also invariant (same 56 orientations, FP-free)', () => {
  const failures = [];
  let n = 0, ok = 0;
  for (let th = 0; th <= 90; th += 15) {
    for (let ph = 0; ph < 360; ph += 45) {
      const rnd = rngFactory(900000 + n * 31);
      // long window so acquisition works like the live tracker's validator
      const data = synthWithGravity({ spm: 24, seconds: 20, g: gravityVector(th, ph) }, rnd);
      const got = detectStrokeRate(data.map(d => ({ t: d.t, mag: d.ay })), {});
      n++;
      if (got != null && Math.abs(got - 24) <= 1) ok++;
      else failures.push({ th, ph, got });
    }
  }
  const rate = ok / n;
  assert.ok(rate >= 0.95,
    `detector gravity-invariance ${(rate * 100).toFixed(1)}% (${ok}/${n}); ` +
    `first failures: ${JSON.stringify(failures.slice(0, 6))}`);
});

test('gravity battery: flat water at ANY orientation stays silent (no FP)', () => {
  const failures = [];
  let n = 0, fp = 0;
  for (let th = 0; th <= 90; th += 15) {
    for (let ph = 0; ph < 360; ph += 45) {
      const rnd = rngFactory(950000 + n * 37);
      // no stroke: amp=0, just gravity + small noise
      const data = synthWithGravity({
        spm: 24, seconds: 20, amp: 0, noise: 0.25, g: gravityVector(th, ph),
      }, rnd);
      const got = detectStrokeRate(data, {});
      n++;
      if (got == null) continue;
      fp++;
      failures.push({ th, ph, got });
    }
  }
  const rate = fp / n;
  assert.ok(rate <= 0.05,
    `gravity no-rowing FP rate ${(rate * 100).toFixed(1)}% (${fp}/${n}); ` +
    `first: ${JSON.stringify(failures.slice(0, 6))}`);
});

test('gravity battery: gravity constant but phone slowly reoriented mid-row', () => {
  // real boats tilt slightly; gravity stays "constant enough" — tracker must
  // ride through a gentle reorientation without unlock
  const failures = [];
  let n = 0, ok = 0;
  for (let seed = 0; seed < 4; seed++) {
    const rnd = rngFactory(980000 + seed * 41);
    const data = [];
    let phase = 0;
    const hz = 100, seconds = 60;
    // gravity rotates 15° over the session (slow hull roll)
    for (let i = 0; i < seconds * hz; i++) {
      const roll = (i / (seconds * hz)) * 15 * Math.PI / 180;
      const gz = 9.81 * Math.cos(roll), gx = 9.81 * Math.sin(roll);
      phase += 2 * Math.PI * (22 / 60) / hz;
      const s = Math.sin(phase);
      const stroke = s > 0 ? s * 8 : s * 8 * 0.4;
      data.push({
        t: i / hz * 1000,
        ax: gx + (rnd() - 0.5) * 0.3,
        ay: stroke + (rnd() - 0.5) * 0.6,
        az: gz + (rnd() - 0.5) * 0.3,
      });
    }
    const tr = createStrokeTracker();
    const st = tr.process(data);
    n++;
    if (st.locked && st.spm != null && Math.abs(st.spm - 22) <= 1) ok++;
    else failures.push({ seed, state: st });
  }
  assert.ok(ok === n, `slow-reorient cases ${ok}/${n}; failures: ${JSON.stringify(failures)}`);
});
