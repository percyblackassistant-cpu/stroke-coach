// app.js — Stroke Coach v0: GPS speed + accelerometer-derived stroke rate
const $ = (id) => document.getElementById(id);
const state = {
  running: false,
  watchId: null,
  startT: null,
  distance: 0,
  lastPos: null,
  samples: [],     // motion ring buffer {t, mag}
  csvLog: [],
  motionActive: false,
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
  const t = e.timeStamp;
  const mag = Math.sqrt(a.x*a.x + a.y*a.y + a.z*a.z);
  state.samples.push({ t, mag });
  if (state.samples.length > 600) state.samples.shift();
  state.csvLog.push(
    `M,${Date.now()},${mag.toFixed(4)},${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}`);
  if (state.csvLog.length > 30000) state.csvLog.splice(0, 3000);
}

// shared detector lives in stroke-detector.js (window.StrokeDetector)
const { smooth, detectStrokeRate } = window.StrokeDetector;

// ---------- stroke rate (v0: peak counting on smoothed |a|) ----------

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
  const spm = detectStrokeRate(state.samples);
  if (spm) $('spm').firstChild.textContent = String(spm);
  const el = Math.floor((Date.now() - state.startT) / 1000);
  $('elapsed').textContent = `${Math.floor(el / 60)}:${String(el % 60).padStart(2, '0')}`;
  drawScope();
  requestAnimationFrame(tick);
}

function drawScope() {
  const c = $('scope'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#1652f0'; ctx.lineWidth = 1.5; ctx.beginPath();
  const sm = smooth(state.samples.slice(-240), 3);
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

// ---------- session control ----------
async function start() {
  try {
    await initMotion();
  } catch (err) {
    alert('Motion sensor permission needed for stroke rate. ' + err.message);
  }
  state.running = true; state.startT = Date.now();
  state.distance = 0; state.lastPos = null; state.csvLog = []; state.samples = [];
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
  const blob = new Blob([state.csvLog.join('\n') + '\n'], { type: 'text/csv' });
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
