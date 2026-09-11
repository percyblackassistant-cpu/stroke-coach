// app.js — Stroke Coach v5: GPS speed + phase-locked stroke tracker
const $ = (id) => document.getElementById(id);
const state = {
  running: false,
  watchId: null,
  startT: null,
  distance: 0,
  lastPos: null,
  samples: [],     // motion ring buffer {t, ax, ay, az}
  csvLog: [],
  motionActive: false,
  gpsSpeed: null,
  lastSpmShown: null,
  lastSpmAt: 0,
  lastScreenLog: 0,  // last screen-state CSV line timestamp
  tracker: null,   // StrokeTracker (v5 PLL)
};

// ---------- accelerometer ----------
async function initMotion() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    const res = await DeviceMotionEvent.requestPermission();
    if (res !== 'granted') throw new Error('Motion permission denied');
  }
  if (state.motionActive) return;
  window.addEventListener('devicemotion', onMotion, { passive: true });
  state.motionActive = true;
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  // Sample clock: Date.now() is guaranteed ms+monotonic (Safari's e.timeStamp
  // can be seconds-scale — that's in dd7b4e8). Tests may set
  // window.__scTOverride to replay data at exact device timing.
  const t = (typeof window.__scTOverride === 'function') ? window.__scTOverride() : Date.now();
  const sample = { t, ax: a.x, ay: a.y, az: a.z };
  state.samples.push(sample);
  // cap must exceed winSecs*fs for the tracker's 12s+ acquire window: 200Hz // devices deliver 2400+ samples in 12s
    if (state.samples.length > 6000) state.samples.shift();
  state.csvLog.push(
    `M,${Date.now()},${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}`);
  if (state.csvLog.length > 30000) state.csvLog.splice(0, 3000);
  // feed the v5 tracker (continuous smooth SPM + phase + drive curves)
  if (state.tracker) state.tracker.update(t, a.x, a.y, a.z);
}

// shared modules: detector (acquisition) + tracker (smooth follow)
const { smooth } = window.StrokeDetector;
const trackerOpts = {
  detectorOpts: { gateSpeed: () => state.gpsSpeed },
};

// ---------- GPS ----------
function onGps(pos) {
  const c = pos.coords;
  const now = Date.now();
  state.csvLog.push(`G,${now},${c.latitude.toFixed(6)},${c.longitude.toFixed(6)},` +
    `${(c.speed ?? -1).toFixed(3)},${(c.accuracy ?? -1).toFixed(1)},${(c.heading ?? -1).toFixed(1)}`);
  if (c.speed != null && c.accuracy != null && c.accuracy < 25) {
    $('speed').firstChild.textContent = (c.speed * 3.6).toFixed(1);
    $('pace').textContent = c.speed > 0.4 ? fmtPace(500 / c.speed) : '--:--';
  }
  $('gps').textContent = c.accuracy < 25 ? `±${Math.round(c.accuracy)}m` : 'weak';
  if (c.speed != null && c.speed >= 0) state.gpsSpeed = c.speed;
  if (state.lastPos) {
    state.distance += haversine(state.lastPos, c);
    $('dist').textContent = Math.round(state.distance);
  }
  state.lastPos = c;
}

function fmtPace(secPer500) {
  const m = Math.floor(secPer500 / 60), s = Math.round(secPer500 % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function haversine(a, b) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- UI loop ----------
function tick() {
  if (!state.running) return;
  if (state.tracker) {
    const s = state.tracker.state();
    // DISPLAY HOLD (Maria/Bence 09-10): keep the last numeric reading on
    // screen for 4 s after unlock so a brief tracking flicker doesn't flash
    // '--' and wipe a good number; '--' only once truly stale.
    if (s.spm != null) { state.lastSpmShown = s.spm.toFixed(1); state.lastSpmAt = Date.now(); }
    if (state.lastSpmShown && Date.now() - state.lastSpmAt < 4000) {
      setSpmDisplay(state.lastSpmShown);
    } else {
      state.lastSpmShown = null;
      // warm-up feedback (Bence 09-10: 'no result' — the app is collecting,
      // it just needs ~10-20 s before it can lock; a blank '--' hides that)
      const elapsed = Date.now() - state.startT;
      setSpmDisplay(elapsed < 22000 ? 'warming…' : '--');
    }
  }
  // SCREEN-STATE CSV LINES (Bence 09-10): record exactly what the UI displays,
  // 1 Hz, so an export shows screen behaviour without a witness.
  if (Date.now() - state.lastScreenLog >= 1000) {
    state.lastScreenLog = Date.now();
    const sState = state.tracker.state();
    state.csvLog.push('S,' + Date.now() + ',' +
      ($('spm').firstChild.textContent || '').trim() + ',' +
      (sState.locked ? 1 : 0) + ',' +
      (sState.spm == null ? '' : sState.spm) + ',' +
      $('gps').textContent.trim() + ',' +
      state.samples.length);
  }
  const el = Math.floor((Date.now() - state.startT) / 1000);
  $('elapsed').textContent = `${Math.floor(el / 60)}:${String(el % 60).padStart(2, '0')}`;
  drawScope();
  drawCurve();
  requestAnimationFrame(tick);
}

function drawScope() {
  const c = $('scope'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#1652f0'; ctx.lineWidth = 1.5; ctx.beginPath();
  const recent = state.samples.slice(-240).map(s => ({ t: s.t, mag: Math.hypot(s.ax, s.ay, s.az) }));
  const sm = smooth(recent, 3);
  if (sm.length > 2) {
    const min = Math.min(...sm.map(s => s.mag)), max = Math.max(...sm.map(s => s.mag));
    const rng = Math.max(0.5, max - min);
    sm.forEach((s, i) => {
      const x = i / (sm.length - 1) * c.width;
      const y = c.height - (s.mag - min) / rng * (c.height - 10) - 5;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
}

// erg-style drive curve (normalized shape, median of last ~8-12 strokes)
function setSpmDisplay(v) {
  const el = $('spm');
  el.firstChild.textContent = v;
  el.classList.toggle('txtMode', !/^[0-9.]+$/.test(String(v).trim()));
}

function drawCurve() {
  const c = $('curve'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!state.tracker) return;
  // per-stroke curves: each stroke its own line (Bence 09-10), newest brightest
  let curves;
  try { curves = state.tracker.strokeCurves ? state.tracker.strokeCurves(8) : null; } catch { curves = null; }
  if (curves && curves.length) {
    // shared height scale: normalize each curve by its own max keeps classic erg
    // look; shared max keeps relative force honest. Use shared max.
  // LIVE partial path for the in-progress stroke (Bence 09-11: the last
  // stroke must be visible while it's being pulled, not only after completion)
  let partial = null;
  try { partial = state.tracker.strokeCurvesPartial ? state.tracker.strokeCurvesPartial(64) : null; } catch { partial = null; }
  const mx = Math.max(
    ...curves.flatMap(s => s.curve.map(v => Math.abs(v))),
    ...(partial ? partial.curve.map(v => Math.abs(v)) : [0]),
    0.01);
    curves.forEach((s, ci) => {
      const alpha = 0.25 + 0.75 * (ci + 1) / curves.length;
      ctx.strokeStyle = `rgba(255, 225, 77, ${alpha.toFixed(2)})`;
      ctx.lineWidth = ci === curves.length - 1 ? 2.5 : 1.5;
      ctx.beginPath();
      s.curve.forEach((v, i) => {
        const x = i / (s.curve.length - 1) * c.width;
        const y = c.height - 6 - (v / mx) * (c.height - 16);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    });
    // the live stroke drawn last, on top, full brightness
    if (partial && partial.curve.length > 3) {
      ctx.strokeStyle = 'rgba(255, 240, 140, 0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      partial.curve.forEach((v, i) => {
        const x = i / (partial.curve.length - 1) * c.width;
        const y = c.height - 6 - (v / mx) * (c.height - 16);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    return;
  }
  // fallback until 3 strokes complete: median blend (old behavior)
  const curve = state.tracker.driveCurve();
  if (!curve) return;
  ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2; ctx.beginPath();
  curve.forEach((v, i) => {
    const x = i / (curve.length - 1) * c.width;
    const y = c.height / 2 - v * (c.height / 2 - 6);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

// ---------- session control ----------
async function start() {
  try {
    await initMotion();
  } catch (err) {
    alert('Motion sensor permission needed for stroke rate. ' + err.message);
  }
  state.running = true; state.startT = Date.now();
  state.distance = 0; state.lastPos = null; state.csvLog = []; state.samples = [];
  state.gpsSpeed = null;
  state.tracker = window.StrokeTracker.createStrokeTracker(trackerOpts);
  state.watchId = navigator.geolocation.watchPosition(onGps, err => {
    $('gps').textContent = 'gps err';
  }, { enableHighAccuracy: true, maximumAge: 1000 });
  $('startBtn').hidden = true;
  $('dashboard').hidden = false;
  $('exportBtn').hidden = false;
  requestAnimationFrame(tick);
}

function stop() {
  state.running = false;
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  saveSession();
  $('startBtn').hidden = false;
  $('dashboard').hidden = true;
  renderHistory();
}

function saveSession() {
  // final screen-state line (Bence 09-10): freeze last displayed value into export
  state.csvLog.push('S,' + Date.now() + ',' +
    ($('spm').firstChild.textContent || '').trim() + ',' +
    (state.tracker && state.tracker.state().locked ? 1 : 0) + ',' +
    (state.tracker && state.tracker.state().spm == null ? '' : state.tracker.state().spm) + ',' +
    $('gps').textContent.trim() + ',' +
    state.samples.length);
  const sessions = JSON.parse(localStorage.getItem('sc_sessions') || '[]');
  sessions.unshift({
    date: new Date().toISOString(),
    durationS: Math.round((Date.now() - state.startT) / 1000),
    distanceM: Math.round(state.distance),
    avgSpm: $('spm').firstChild.textContent,
    avgKmh: $('speed').innerText.trim(),
  });
  localStorage.setItem('sc_sessions', JSON.stringify(sessions.slice(0, 50)));
}

function renderHistory() {
  const sessions = JSON.parse(localStorage.getItem('sc_sessions') || '[]');
  $('sessionList').innerHTML = sessions.map(s =>
    `<li>${new Date(s.date).toLocaleString()} — ${s.distanceM} m · ${s.avgSpm} spm · ${s.avgKmh} km/h</li>`).join('');
}

function exportCsv() {
  const header = 'HEADER,columns:M=ms,ax,ay,az|G=ms,lat,lon,speed,acc,heading|S=ms,shown_spm,locked,tracker_spm,gps_label,sample_buf';
  const blob = new Blob([header + '\n' + state.csvLog.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `stroke-coach-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
}

$('startBtn').addEventListener('click', start);
$('stopBtn').addEventListener('click', stop);
$('exportBtn').addEventListener('click', exportCsv);
$('clearBtn').addEventListener('click', () => {
  localStorage.removeItem('sc_sessions'); renderHistory();
});
renderHistory();

// testability hook (read-only usage by e2e tests) — must be AFTER state init
window.__sc = state;
