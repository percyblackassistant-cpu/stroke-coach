const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pw = require('playwright-core');

function startServer(root) {
  return new Promise((resolve) => {
    const srv = spawn('python3', ['-m', 'http.server', '8081', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
    setTimeout(() => resolve(srv), 800);
  });
}

test('debug: tracker state inside browser', async (t) => {
  const root = path.join(__dirname, '..');
  const srv = await startServer(root);
  try {
    const dir = '/tmp/row_data/row_data/club-level/iPhone';
    const f = fs.readdirSync(dir).find(n => n.startsWith('Boat2x-'));
    const csv = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = csv.split('\n');
    const iAy = lines[0].split(',').indexOf('accelerometer_acceleration_y');
    const study = [];
    for (let k = 137000; k < 141000; k++) {
      const v = lines[k].split(',')[iAy];
      if (v) study.push(parseFloat(v));
    }
    const browser = await pw.chromium.launch({
      executablePath: '/home/bence/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 20000,
    });
    const page = await browser.newPage();
    page.on('console', m => { if (m.type() === 'error') console.log('PAGE ERR:', m.text()); });
    await page.goto('http://localhost:8081/index.html');
    await page.click('#startBtn');
    const res = await page.evaluate(async (samples) => {
      const fire = (ay, t) => {
        const e = new DeviceMotionEvent('devicemotion', {
          accelerationIncludingGravity: { x: 0, y: ay, z: 9.81 }, interval: 10 });
        Object.defineProperty(e, 'timeStamp', { value: t });
        window.dispatchEvent(e);
      };
      for (let i = 0; i < samples.length; i += 100) {
        const ch = samples.slice(i, i + 100);
        for (let j = 0; j < ch.length; j++) fire(ch[j], i + j * 10);
        await new Promise(r => setTimeout(r, 20));
      }
      await new Promise(r => setTimeout(r, 300));
      return {
        spm: document.getElementById('spm').textContent.trim(),
        nSamples: window.__state ? window.__state.samples.length : 'n/a',
        // reach into the app's live tracker via a debug hook if exposed
        hasTracker: !!(window.StrokeTracker),
        rawCheck: (() => {
          const tr = window.StrokeTracker.createStrokeTracker();
          // replay the same data through a fresh tracker synchronously
          for (let i = 0; i < samples.length; i++) {
            tr.update(i * 10, 0, samples[i], 9.81);
          }
          return tr.state();
        })(),
      };
    }, study);
    console.log('RESULT:', JSON.stringify(res, null, 1));
    await browser.close();
  } finally { srv.kill(); }
});
