// tests/report-accuracy.cjs — prints the accuracy monitor table in CI logs.
// Reads /tmp/test-accuracy.json (written by stress.test.js at process exit).
// Committed as a file, not an inline node -e, because ${...} template
// placeholders inside a double-quoted shell string get expanded by bash —
// that's exactly what broke the first CI run (e785728).
const fs = require('fs');
const path = '/tmp/test-accuracy.json';
if (!fs.existsSync(path)) {
  console.error('accuracy monitor output missing — suites crashed early?');
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(path, 'utf8'));
let tp = 0, tt = 0;
console.log('=== Accuracy Monitor ===');
for (const [k, v] of Object.entries(d)) {
  console.log(`  ${k.padEnd(22)} ${v.pass}/${v.total} = ${v.pct}%  (gate: ${v.gate || ''})`);
  tp += v.pass; tt += v.total;
}
if (tt) console.log(`  ${'TOTAL'.padEnd(22)} ${tp}/${tt} = ${(100 * tp / tt).toFixed(1)}%`);
