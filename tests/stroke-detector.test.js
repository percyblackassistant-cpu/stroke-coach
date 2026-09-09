// tests/stroke-detector.test.js — Node built-in test runner
const test = require('node:test');
const assert = require('node:assert');
const { smooth, detectStrokeRate } = require('../js/stroke-detector.js');

// synth signal generator: boat rocking at given spm + noise
function synth({ spm, seconds = 30, hz = 50, noise = 0.3, amp = 8, gravity = 9.81 }) {
  const samples = [];
  const n = seconds * hz;
  for (let i = 0; i < n; i++) {
    const t = i / hz * 1000; // ms
    const phase = 2 * Math.PI * (spm / 60) * (i / hz);
    // sharp catch impulse + slower recovery: asymmetric wave
    const stroke = Math.sin(phase) > 0
      ? Math.sin(phase) * amp
      : Math.sin(phase) * amp * 0.4;
    const jit = (Math.random() - 0.5) * 2 * noise;
    samples.push({ t, mag: gravity + stroke + jit });
  }
  return samples;
}

test('flat water, no strokes -> null (no false positives)', () => {
  const flat = synth({ spm: 0, seconds: 20, amp: 0, noise: 0.05 });
  assert.equal(detectStrokeRate(flat), null);
});

test('20 spm steady state -> within ±2 of 20', () => {
  const s = synth({ spm: 20, seconds: 45 });
  const got = detectStrokeRate(s);
  assert.ok(got !== null, 'should detect');
  assert.ok(Math.abs(got - 20) <= 2, `got ${got}, want 20±2`);
});

test('32 spm race pace -> within ±3 of 32', () => {
  const s = synth({ spm: 32, seconds: 45 });
  const got = detectStrokeRate(s);
  assert.ok(got !== null);
  assert.ok(Math.abs(got - 32) <= 3, `got ${got}, want 32±3`);
});

test('short buffer (<60 samples) -> null, no crash', () => {
  assert.equal(detectStrokeRate(synth({ spm: 24, seconds: 0.5 })), null);
});

test('smooth() preserves length and damps jitter', () => {
  const s = synth({ spm: 24, seconds: 5, noise: 1.5 });
  const sm = smooth(s);
  assert.equal(sm.length, s.length);
  const rawRange = Math.max(...s.map(x => x.mag)) - Math.min(...s.map(x => x.mag));
  const smRange = Math.max(...sm.map(x => x.mag)) - Math.min(...sm.map(x => x.mag));
  assert.ok(smRange <= rawRange, 'smoothing should not amplify range');
});

test('insufficient peaks -> null', () => {
  // two tiny bumps only
  const s = Array.from({ length: 100 }, (_, i) => ({ t: i * 20, mag: 9.81 + (i === 50 || i === 60 ? 2 : 0) }));
  assert.equal(detectStrokeRate(s), null);
});
