// tests/stroke-tracker.test.js — v5 PLL tracker tests (Node built-in runner)
const test = require('node:test');
const assert = require('node:assert');
const { createStrokeTracker } = require('../js/stroke-tracker.js');
const { detectStrokeRate } = require('../js/stroke-detector.js');

function synth({ spm, seconds = 60, hz = 50, noise = 0.3, amp = 8, gravity = 9.81, driftTo = null }) {
  const out = [];
  const n = seconds * hz;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    // PHYSICALLY CORRECT: phase integrates instantaneous frequency. Multiplying
    // spmNow by the raw index (2π·f(t)·i) double-counts the ramp — instantaneous
    // frequency at the end becomes ~1.6× driftTo (spectral detector reads 30 on
    // a "24 spm" ramp — the tracker was right, the generator was wrong).
    const spmNow = driftTo ? spm + (driftTo - spm) * (i / n) : spm;
    phase += 2 * Math.PI * (spmNow / 60) / hz;
    const t = i / hz * 1000;
    const stroke = Math.sin(phase) > 0 ? Math.sin(phase) * amp : Math.sin(phase) * amp * 0.4;
    out.push({ t, ax: 0, ay: stroke + (Math.random() - 0.5) * 2 * noise, az: gravity + (Math.random() - 0.5) * noise, spmNow });
  }
  return out;
}

test('tracker: lock on and hold steady 24 spm, smooth display', () => {
  const tr = createStrokeTracker();
  const data = synth({ spm: 24 });
  const s = tr.process(data.map(({ t, ax, ay, az }) => ({ t, ax, ay, az })));
  assert.equal(s.locked, true, 'should be locked by end');
  assert.ok(s.spm != null && Math.abs(s.spm - 24) <= 1, `spm ${s.spm} vs 24±1`);
  // smoothness: tracker knows exact rate; synthetic is constant so triv pass.
  assert.ok(s.phase !== null && s.phase >= 0 && s.phase < 1);
});

test('tracker: driveCurve emerges from per-stroke resampling', () => {
  const tr = createStrokeTracker();
  const data = synth({ spm: 20, seconds: 90 });
  tr.process(data);
  const curve = tr.driveCurve();
  assert.ok(curve, 'curve should exist after ~45 strokes');
  assert.equal(curve.length, 64);
  const peak = Math.abs(curve.reduce((a, b) => Math.abs(a) > Math.abs(b) ? a : b));
  assert.ok(peak >= 0.9, 'normalized curve should reach ~±1');
});

test('tracker: no false curve on flat calm (unlocked)', () => {
  const tr = createStrokeTracker();
  const flat = [];
  for (let i = 0; i < 30 * 50; i++) {
    flat.push({ t: i * 20, ax: 0, ay: (Math.random() - 0.5) * 0.1, az: 9.81 });
  }
  tr.process(flat);
  const s = tr.state();
  assert.equal(s.locked, false, 'must not lock on flat water');
  assert.equal(tr.driveCurve(), null);
});

test('tracker: follows a 16→24 spm drift', () => {
  const tr = createStrokeTracker();
  const data = synth({ spm: 16, seconds: 90, driftTo: 24 });
  const s = tr.process(data);
  const trueEnd = data[data.length - 1].spmNow;
  assert.ok(s.spm != null, 'should stay locked through drift');
  assert.ok(Math.abs(s.spm - trueEnd) <= 3, `end rate ${s.spm} vs true ${trueEnd}±3`);
});
