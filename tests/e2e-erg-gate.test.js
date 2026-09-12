#!/usr/bin/env node
/**
 * e2e-erg-gate: regression for Bence's 09-12 indoor session.
 *
 * Failure: indoors the phone's (assisted/stale) GPS fix reports speed ~0 m/s,
 * the detector's gate (`gateSpeed` < 0.5 m/s → return null) blocks EVERY
 * acquisition attempt, so the tracker never locks: spm shows warming…/-- and
 * the force graph stays blank ("no spm no graph").
 *
 * A/B harness, Boat2x verified block (t≈1940 s, the e2e pattern):
 *   A. gps speed 0 + erg mode OFF  → must stay honest no-lock (no spm, no
 *      strokes, blank force graph) — the dock false-positive guard works.
 *   B. gps speed 0 + ERG MODE ON   → detector acquires, spm numeric in band,
 *      strokes complete, force graph painted. THIS is the fix being specified.
 *   C. pace layout: split card present, km/h `#speed` element GONE.
 *
 * The toggle is the REAL UI control (#ergChk) — not a state poke — so the
 * start() wiring is under test, not just the tracker.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8096';

function loadStudySlice() {
  const dir = '/tmp/row_data/row_data/club-level/iPhone';
  const f = fs.readdirSync(dir).find(n => n.startsWith('Boat2x-'));
  const csv = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = csv.split('\n');
  const hdr = lines[0].split(',');
  const iAx = hdr.indexOf('accelerometer_acceleration_x');
  const iAy = hdr.indexOf('accelerometer_acceleration_y');
  const iAz = hdr.indexOf('accelerometer_acceleration_z');
  const out = [];
  for (let k = 194000; k < 198000 && k < lines.length; k++) {
    const c = lines[k].split(',');
    if (c[iAy]) out.push({ x: +c[iAx], y: +c[iAy], z: +c[iAz] });
  }
  return out;
}

function startServer(root, port) {
  return new Promise((resolve) => {
    const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
    setTimeout(() => resolve(srv), 800);
  });
}

let playwright;
try {
  playwright = require('playwright-core');
  const cache = path.join(process.env.HOME, '.cache', 'ms-playwright');
  if (fs.existsSync(cache)) {
    const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
    if (dir) {
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const exe = path.join(cache, dir, sub, 'chrome');
        if (fs.existsSync(exe)) { playwright.executablePath = exe; break; }
      }
    }
  }
} catch { playwright = null; }

async function replaySession(browser, { erg, gpsSpeed }) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/index.html`);
  await page.evaluate(() => { let n = 0; window.__scTOverride = () => 1000 + (n++) * 10; });
  if (erg) {
    const chk = await page.$('#ergChk');
    if (chk) await chk.check();   // RED runs on the unfixed build: absent toggle must not hang
  }
  await page.click('#startBtn');
  await page.waitForTimeout(300);
  // the field condition: a live-but-stale fix reporting ~0 m/s (indoors;
  // previously only settable via real geolocation, poked here via __sc)
  await page.evaluate((v) => { window.__sc.gpsSpeed = v; }, gpsSpeed);
  const res = await page.evaluate(async (samples) => {
    const fire = (s, t) => {
      const e = new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: s, interval: 10 });
      Object.defineProperty(e, 'timeStamp', { value: t });
      window.dispatchEvent(e);
    };
    for (let i = 0; i < samples.length; i += 1000) {
      const chunk = samples.slice(i, i + 1000);
      for (let j = 0; j < chunk.length; j++) fire(chunk[j], (i + j) * 10);
      await new Promise(r => setTimeout(r, 15));
    }
    await new Promise(r => setTimeout(r, 400));
    const sc = window.__sc;
    const st = sc.tracker.state();
    const dbg = sc.tracker.debug();
    const c = document.getElementById('curve');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = false;
    for (let k = 3; k < d.length; k += 4) if (d[k] > 0) { painted = true; break; }
    return {
      spmText: (document.getElementById('spm').firstChild.textContent || '').trim(),
      locked: st.locked, spm: st.spm, strokes: dbg.strokes,
      painted, ergChkVisible: !!document.getElementById('ergChk'),
      speedEl: !!document.getElementById('speed'),   // C: must be gone
      splitEl: !!document.getElementById('pace'),    // C: split must stay
    };
  }, loadStudySlice());
  await page.close();
  return res;
}

test('erg-gate A/B: stale 0-speed fix blocks acquire outdoors-gated, ERG MODE unlocks, split stays & km/h gone', async (t) => {
  if (!playwright) { t.skip('playwright not installed'); return; }
  for (let attempt = 1; attempt <= 2; attempt++) {   // repo rule: rerun a failing e2e once
    const root = path.join(__dirname, '..');
    const srv = await startServer(root, 8096);
    let browser = null;
    try {
      browser = await playwright.chromium.launch({ executablePath: playwright.executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 20000 });

      // ---- A: gate active (no erg) → honest no-lock, no false spm ----
      const a = await replaySession(browser, { erg: false, gpsSpeed: 0.0 });
      const spmNumA = parseFloat(a.spmText);
      assert.ok(
        Number.isNaN(spmNumA) || a.spmText.includes('warming') || a.spmText.includes('--'),
        `A: no numeric spm while gated at 0 m/s, got "${a.spmText}"`);
      assert.equal(a.strokes, 0, 'A: zero completed strokes while gated');
      assert.equal(a.painted, false, 'A: force graph stays blank while gated');
      assert.ok(a.ergChkVisible, 'A: erg toggle exists on start screen');

      // ---- B: ERG MODE → acquires, locks, paints ONE-stroke graph ----
      const b = await replaySession(browser, { erg: true, gpsSpeed: 0.0 });
      const spmNumB = parseFloat(b.spmText);
      assert.ok(!Number.isNaN(spmNumB), `B: numeric spm in erg mode, got "${b.spmText}"`);
      assert.ok(spmNumB >= 12 && spmNumB <= 45, `B: spm ${spmNumB} in band`);
      assert.ok(b.strokes >= 3, `B: strokes completed in erg mode (${b.strokes})`);
      assert.equal(b.painted, true, 'B: force graph painted in erg mode');

      // ---- C: split stays, km/h gone ----
      assert.equal(b.speedEl, false, 'C: #speed (km/h) element removed');
      assert.equal(b.splitEl, true, 'C: #pace (split) element kept');
      return; // green
    } catch (err) {
      if (attempt === 2) throw err;
      console.log('attempt 1 failed (tracker non-determinism?), retrying once:', err.message);
    } finally {
      if (browser) await browser.close().catch(() => {});
      srv.kill();
    }
  }
});
