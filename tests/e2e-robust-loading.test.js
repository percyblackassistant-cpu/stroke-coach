// tests/e2e-robust-loading.test.js — blind-spot regression (Bence 09-10)
// Complaint → test policy: his Firefox-on-Android screenshot showed the app as
// a broken white page with naked "START" text: HTML loaded but the stylesheet
// fetch failed. Assert that even when main.css is unreachable (request fails),
// the page still renders dark-themed with a visible, styled START button.
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

test('e2e-robust-loading: missing main.css still renders usable dark UI', async (t) => {
  if (!pw) { t.skip('playwright-core missing'); return; }
  const root = path.join(__dirname, '..');
  const srv = await startServer(root, 8097);
  let browser = null;
  try {
    browser = await pw.chromium.launch({
      executablePath: '/home/bence/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 20000,
    });
    const page = await browser.newPage();
    // BLOCK the stylesheet and the PWA manifest (worst-case partial fetch)
    await page.route('**/main.css*', r => r.abort());
    await page.route('**/manifest.webmanifest*', r => r.abort());
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:8097/index.html', { waitUntil: 'load' });

    // the critical inline CSS must give dark bg + colored START button
    const res = await page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor;
      const btn = document.getElementById('startBtn');
      const vis = btn && btn.offsetParent !== null;
      const btnBg = btn ? getComputedStyle(btn).backgroundColor : null;
      return { bg, vis, btnBg, dark: document.documentElement.classList.contains('dark') };
    });
    const [r, g, b] = res.bg.match(/\d+/g).map(Number);
    // dark theme: overall dark pixels (r+g+b low)
    assert.ok(r + g + b < 120, `body bg must be dark, got ${res.bg}`);
    assert.ok(res.vis, 'START button must be visible');
    assert.equal(res.btnBg, 'rgb(22, 82, 240)', `START button themed (#1652f0), got ${res.btnBg}`);

    // and the app itself must still be functional (scripts independent of CSS)
    await page.click('#startBtn');
    await page.waitForTimeout(600);
    const dashShown = await page.evaluate(() => !document.getElementById('dashboard').hidden);
    assert.equal(dashShown, true, 'app still works with stylesheet missing');

    console.error('E2E-ROBUST', JSON.stringify(res));
    await browser.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
});
