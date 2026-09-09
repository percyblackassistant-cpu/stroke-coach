#!/usr/bin/env node
// Run StrokeDetector on buffers dumped by validate_dataset.py
// stdin: {"buffers": [[{t,mag}...], ...]}  ->  stdout: JSON array of spm per buffer
const path = require('path');
const { detectStrokeRate } = require(path.join(__dirname, '..', 'js', 'stroke-detector.js'));
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const { buffers, opts } = JSON.parse(input);
  const out = buffers.map(b => detectStrokeRate(b, opts || {}));
  console.log(JSON.stringify(out));
});
