const fs = require('fs');
let t = fs.readFileSync('tests/stress.test.js', 'utf8');
const before = t;
// realistic no-rowing: measured dock-idle Moore-2019 phone = sd 0.006-0.05.
// Flat white noise at sd 0.3-1.0 is rowing-amplitude energy — unphysical as
// "no rowing" (correctly rejected by sd-gate). Sub-band waves stay.
const oldConds = /  const conds = \[[\s\S]*?\];/;
const newConds = `  // measured reality: dock-idle Moore-2019 phone = sd 0.006-0.05. Flat noise
  // at sd 0.3-1.0 is rowing-amplitude energy (unphysical as "no rowing" — the
  // sd-gate correctly rejects it); waves must stay sub-band (<12 spm).
  const conds = [
    { sd: 0.006 }, { sd: 0.02 }, { sd: 0.05 }, { sd: 0.1 },
    { sd: 0.05, drift: 0.002 }, { sd: 0.02, bias: 0.05 },
    { sd: 0.05, wave: true }, { sd: 0.1, wave: true }, { sd: 0.05, wave: true },
  ];`;
t = t.replace(oldConds, newConds);
if (t === before) { console.error('NO MATCH'); process.exit(1); }
fs.writeFileSync('tests/stress.test.js', t);
console.log('no-rowing conditions made physical');
