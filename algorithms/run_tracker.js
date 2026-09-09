#!/usr/bin/env node
// Run the v5 StrokeTracker over sample buffers dumped by the validation harness.
// stdin: {"buffers": [[{t,ax,ay,az}...], ...]}
// stdout: JSON array of {locked, spm, phase, curve: bool}
const path = require('path');
const { createStrokeTracker } = require(path.join(__dirname, '..', 'js', 'stroke-tracker.js'));
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const { buffers } = JSON.parse(input);
  const out = buffers.map(buf => {
    const tr = createStrokeTracker();
    let last = null;
    for (const s of buf) last = tr.update(s.t, s.ax, s.ay, s.az);
    return { ...last, curve: !!tr.driveCurve(), strokes: tr.debug().strokes };
  });
  console.log(JSON.stringify(out));
});
