// synthetic self-test for bench_estimators.js: does each estimator read the
// injected rate on clean + noisy synthetic signals? Run: node bench_selftest.js
const B = require('./bench_estimators.js');

function synth(spm, secs, fs, amp = 1, noise = 0, harm2 = 0, drift = 0) {
  const out = [];
  const f = spm / 60;
  let phase = 0;
  for (let i = 0; i < secs * fs; i++) {
    const t = i / fs;
    phase += 2 * Math.PI * (f + drift * t) / fs;
    let v = amp * Math.sin(phase);
    if (harm2) v += amp * harm2 * Math.sin(2 * phase);
    v += noise * (Math.random() - 0.5) * 2;
    out.push({ t: t * 1000, v });
  }
  return out;
}

function fs_from_t(samples) { return 1000 * (samples.length - 1) / (samples[samples.length - 1].t - samples[0].t); }
function dur_s(samples) { return (samples[samples.length - 1].t - samples[0].t) / 1000; }

function report(name, samples, trueSpm, opts = {}) {
  const yin = B.yinDetect(samples, opts);
  const gh = B.goertzelHarmoDetect(samples, opts);
  const tr = B.anfTrack(samples, opts);
  const anf = tr ? B.anfWindow(tr.spmLog, 0.6 * dur_s(samples), dur_s(samples)) : null;
  console.log(`${name}: yin=${yin === null ? 'null' : yin.toFixed(1)} goertzelHarmo=${gh === null ? 'null' : gh.toFixed(1)} anf=${anf === null ? 'null' : anf.toFixed(1)}  (true ${trueSpm})`);
}

for (const spm of [13, 14.5, 17.9, 20, 26, 34, 41]) report(`clean ${spm}`, synth(spm, 30, 60), spm);
for (const spm of [17.9, 20, 26]) report(`harm2 ${spm}`, synth(spm, 30, 60, 1, 0.05, 1.0), spm);
report('noisy 17.9', synth(17.9, 30, 60, 1, 1.0), 17.9);
report('noisy 26', synth(26, 30, 60, 1, 1.0), 26);
report('ramp 16->24 60s', synth(16, 60, 60, 1, 0.05, 0, 8 / 55), 24);
