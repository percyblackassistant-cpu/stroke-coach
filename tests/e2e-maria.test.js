#!/usr/bin/env node
/**
 * tests/e2e-maria.test.js — e2e with Maria's actual device CSVs.
 *
 * Difference vs e2e-browser: injects HER recorded device-motion CSVs (as saved
 * exports) instead of study data. Asserts the FULL UI pipeline: dashboard
 * visible, SPM numeric + when her ramp settles, lock within 100s batch,
 * curve canvas painted. Fixture: tests/fixtures/maria-trial2.csv.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const pw = (() => {
  process.env.NODE_PATH = path.join(__dirname, '..', 'node_modules');
  require('module').Module._initPaths();
  try { return require('playwright-core'); } catch { return null; }
})();

function startServer(root, port) {
  return new Promise((resolve) => {
    const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
      { cwd: root, stdio: 'ignore' });
    setTimeout(() => resolve(srv), 800);
  });
}

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    const p = line.split(',');
    if (p[0] === 'M') {
      out.push({ ax: +p[2], ay: +p[3], az: +p[4] });
    }
  }
  return out;
}

test('e2e-maria: her device CSVs lock SPM + paint curve in the real UI', async (t) => {
  if (!pw) {
    t.skip('playwright-core missing');
    return;
  }
  const fixture = path.join(__dirname, 'fixtures', 'maria-trial2.csv');
  if (!fs.existsSync(fixture)) {
    t.skip('maria-trial2.csv fixture not found');
    return;
  }
  const samples = parseCsv(fixture);
  assert.ok(samples.length >= 1500, `fixture has ${samples.length} samples`);

  const root = path.join(__dirname, '..');
  const srv = await startServer(root, 8095);
  let browser = null;
  try {
    browser = await pw.chromium.launch({
      executablePath: '/home/bence/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 20000,
    });
    const page = await browser.newPage();
    page.on('pageerror', e => console.error('PAGEERROR:', e.message));
    await page.goto('http://127.0.0.1:8095/index.html');
    // start the app
    await page.click('#startBtn');
    await page.waitForTimeout(400);

    // inject her devicemotion data in worker batches with monotonic Date.now-ts
    // (fixture timestamps are absolute epoch ms; rebase to "now" so the app's
    // Date.now-based timestamping sees monotonic ms)
    const res = await page.evaluate(async (payload) => {
      const samples = payload.samples;
      // clock override: each event advances 17ms (her ~59 Hz device), so data
      // replays at true device rate regardless of dispatch speed
      let n = 0;
      const t0 = Date.now();
      window.__scTOverride = () => t0 + (n++) * 17;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const e = new DeviceMotionEvent('devicemotion', {
          accelerationIncludingGravity: { x: s.ax, y: s.ay, z: s.az },
          interval: 17,
        });
        window.dispatchEvent(e);
        if (i % 400 === 0) await new Promise(r => setTimeout(r, 20));
      }
      window.__scTOverride = null;
      await new Promise(r => setTimeout(r, 400));
      const curve = document.getElementById('curve');
      let curvePainted = false;
      if (curve) {
        const d = curve.getContext('2d').getImageData(0, 0, curve.width, curve.height).data;
        for (let k = 3; k < d.length; k += 4) if (d[k] > 0) { curvePainted = true; break; }
      }
      const sc = window.__sc;
      return {
        spmText: document.getElementById('spm').textContent.trim(),
        samplesSeen: sc ? sc.samples.length : -1,
        trackerLocked: sc && sc.tracker ? sc.tracker.state().locked : false,
        trackerSpm: sc && sc.tracker ? sc.tracker.state().spm : null,
        curvePainted,
        dbg: sc && sc.tracker ? sc.tracker.debug() : null,
      };
    }, { samples: samples.map(s => ({ ax: s.ax, ay: s.ay, az: s.az })) });

    console.error('E2E-MARIA-RES', JSON.stringify(res));

    assert.equal(res.samplesSeen >= 1500, true, `app received her samples (${res.samplesSeen})`);
    assert.equal(res.trackerLocked, true, 'tracker locked on her real device data');
    assert.ok(res.trackerSpm !== null && res.trackerSpm >= 25 && res.trackerSpm <= 45,
      `SPM ${res.trackerSpm} in her trial's band (25-45; FFT says ~34-40)`);
    assert.equal(res.curvePainted, true, 'drive curve painted from her data');
    assert.ok(!res.spmText.startsWith('--'), `SPM readout shows number, not "--": "${res.spmText}"`);

    await browser.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
});
