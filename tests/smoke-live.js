// tests/smoke-live.js — post-deploy verification against the LIVE site
// (Bence 09-10: "after every push go to the website and check it looks correct")
// Deployed regressions this catches (all three happened):
//   1. broken HTML (<link> tags corrupted by cache-bust) → white page
//   2. CSS not loading/failing → unstyled UI
//   3. JS runtime errors on load → dead buttons
// Exit 1 on any failure → the deploy workflow job turns red.
const pw = (() => {
  try { return require('playwright-core'); } catch { return null; }
})();

// Resolve a Chromium executable: explicit CHROME_PATH, else the local dev
// install, else whatever `playwright` (full package, CI) reports.
function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/home/bence/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ];
  const fs = require('fs');
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return require('playwright').chromium.executablePath(); } catch { return undefined; }
}

const LIVE_URL = process.env.LIVE_URL || 'https://percyblackassistant-cpu.github.io/stroke-coach/';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const failures = [];
const ok = (cond, name) => { console.log((cond ? '  ok ' : '  FAIL ') + name); if (!cond) failures.push(name); };

(async () => {
  // ---- static checks: HTML must be well-formed, assets reachable ----
  const bust = '?cb=' + Date.now();
  const html = await (await fetch(LIVE_URL + bust)).text();
  ok(/<link[^>]*?>/.test(html) === true, 'has link tags');
  const badTags = (html.match(/<(?:link|script)\b[^>]*"(?:[^">]*)?"/g) || [])
    .filter(t => t.count === undefined && (t.split('"').length - 1) % 2 !== 0);
  // every link/script tag must have balanced quotes and a closing >
  for (const m of html.matchAll(/<(link|script)\b[^>]*(?:"|')?[^>]*>/g)) {
    const t = m[0];
    const dq = (t.match(/"/g) || []).length;
    if (dq % 2 !== 0 || !t.endsWith('>')) failures.push('malformed tag: ' + t.slice(0, 80));
  }
  ok(!failures.length, 'all <link>/<script> tags well-formed');
  ok(html.includes('<style>') && /background:\s*#0b0f14/.test(html), 'inline critical CSS present');
  ok(html.includes('startBtn'), 'startBtn in markup');
  const cssPath = (html.match(/href="(css\/main\.css[^"]*)"/) || [])[1];
  ok(!!cssPath, 'main.css referenced');
  if (cssPath) {
    const cssRes = await fetch(new URL(cssPath, LIVE_URL).href);
    ok(cssRes.status === 200, 'main.css fetch 200');
  }
  const jsPaths = [...html.matchAll(/src="(js\/[^"]*)"/g)].map(m => m[1]);
  for (const p of jsPaths) {
    const r = await fetch(new URL(p, LIVE_URL).href);
    ok(r.status === 200, p + ' fetch 200');
  }

  // ---- live browser checks: does it actually render and work? ----
  if (!pw) { console.log('  (playwright-core unavailable — exiting)'); process.exit(failures.length ? 1 : 0); }

  const url = LIVE_URL + bust;
  for (const vp of [{ width: 844, height: 390, name: 'landscape' },
                    { width: 390, height: 844, name: 'portrait' }]) {
    const browser = await pw.chromium.launch({
      executablePath: resolveChrome(), args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = (bg.match(/\d+/g) || ['255', '255', '255']).map(Number);
    ok(r + g + b < 150, vp.name + ': body renders dark (' + bg + ')');
    const btn = await page.evaluate(() => {
      const el = document.getElementById('startBtn');
      return el && el.offsetParent !== null;
    });
    ok(!!btn, vp.name + ': START visible');
    await page.click('#startBtn');
    await page.waitForTimeout(400);
    const dash = await page.evaluate(() => !document.getElementById('dashboard').hidden);
    ok(dash, vp.name + ': dashboard opens on START');
    ok(errors.length === 0, vp.name + ': zero page errors' + (errors.length ? ' — ' + errors.join(' | ') : ''));
    await browser.close();
  }

  console.log('');
  if (failures.length) { console.log('SMOKE-FAILED: ' + failures.length + ' → ' + failures.join(' | ')); process.exit(1); }
  console.log('SMOKE-PASSED: live site renders correctly');
})().catch(e => { console.error('SMOKE-ERROR', e.message); process.exit(1); });
