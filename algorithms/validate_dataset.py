#!/usr/bin/env python3
"""Validate StrokeDetector JS against Moore et al. 2019 club dataset.

Ground truth per trial: FFT peak of diffGPS (rover) speed from position logs.
Comparison A: JS detector on phone accel in same window.
Comparison B: FFT directly on phone accel (sensor-quality check).
Also negative tests on the 'hold' (rotating/no rowing) trials.
"""
import csv, glob, json, math, re, statistics, subprocess
import numpy as np

ROOT = '/tmp/row_data/row_data/club-level'
RATE_PHONE = 100          # Hz
DECIM = 5                 # -> 20 Hz working rate
RATE_WORK = RATE_PHONE // DECIM

TARGETS = {  # HHMMSS -> target spm from 1club_experimental_log.csv
    '090501': 20, '091022': 22, '091604': 22, '091858': 16,
    '092004': 24, '092443': 24, '092925': 26, '093324': 26,
}
HOLDS = ['091318', '092314', '092738', '093143', '093533']
EPOCH_BASE = __import__('datetime').datetime(2018, 4, 20, 0, 0, 0,
              tzinfo=__import__('datetime').timezone(__import__('datetime').timedelta(hours=-7)))

def local_to_epoch(hhmmss):
    h, m, s = int(hhmmss[:2]), int(hhmmss[2:4]), int(hhmmss[4:6])
    return EPOCH_BASE.timestamp() + h*3600 + m*60 + s

# ---------- 1. diffGPS ground truth per trial ----------
def speed_series(fn):
    rows = list(csv.DictReader(open(fn)))
    lat = np.array([float(r['latitude(degrees)']) for r in rows])
    lon = np.array([float(r['longitude(degrees)']) for r in rows])
    R = 6371000
    d = 2*R*np.arcsin(np.sqrt(np.sin(np.diff(lat)*np.pi/180/2)**2 +
        np.cos(lat[:-1])*np.cos(lat[1:])*np.sin(np.diff(lon)*np.pi/180/2)**2))
    v = d*10.0  # m/s, 10 Hz
    # smooth 1 s boxcar to kill single-fix jumps
    k = np.ones(10)/10
    return np.convolve(v, k, mode='same')

def fft_spm(x, fs, lo=13, hi=45):
    n = len(x)
    if n < 100: return None
    x = x - x.mean()
    sp = np.abs(np.fft.rfft(x*np.hamming(n)))
    fr = np.fft.rfftfreq(n, d=1/fs)
    band = (fr*60 >= lo) & (fr*60 <= hi)
    if not band.any() or sp[band].max() == 0: return None
    return fr[np.argmax(sp*band)]*60

truth = {}
for fn in sorted(glob.glob(f'{ROOT}/diffGPS/log*_position_log_*.csv')):
    m = re.search(r'log(\d+)_position_log_\d+-(\d{6})', fn)
    tag = m.group(2)
    v = speed_series(fn)
    truth[tag] = fft_spm(v, 10.0)

# ---------- 2. phone accel ----------
t_all, y_all, mag_all = [], [], []
for r in csv.DictReader(open(glob.glob(f'{ROOT}/iPhone/Boat2x-*.csv')[0])):
    t = r['log_time']; ax = r['accelerometer_acceleration_x']
    ay = r['accelerometer_acceleration_y']; az = r['accelerometer_acceleration_z']
    if not t or not ay: continue
    if not ax or not az: ax = az = '0'
    t_all.append(float(t)); y_all.append(float(ay))
    axv, azv = float(ax), float(az)
    mag_all.append(math.sqrt(axv*axv + float(ay)**2 + azv*azv))
t_all = np.array(t_all)

def slice_phone(t0, t1):
    i0 = np.searchsorted(t_all, t0); i1 = np.searchsorted(t_all, t1)
    seg_t = t_all[i0:i1]; seg = np.array(mag_all[i0:i1])
    # decimate by 5
    n = len(seg) - len(seg) % DECIM
    seg_d = seg[:n].reshape(-1, DECIM).mean(1)
    t0r = seg_t[0]
    return [{'t': round((j)/RATE_WORK*1000), 'mag': round(float(x), 4)}
            for j, x in enumerate(seg_d)]

# ---------- 3. run detector per trial ----------
# trial window: from this trial start to next logged trial start (cap 90 s)
all_starts = sorted(set(list(TARGETS) + HOLDS))
opts = {'sdGate': 0.001, 'threshK': 0.5, 'minGapMs': 1200}
buffers, keys = [], []
for i, tag in enumerate(all_starts):
    if tag not in truth or truth[tag] is None: continue
    t0 = local_to_epoch(tag)
    nxt = all_starts[i+1] if i+1 < len(all_starts) else None
    t1 = local_to_epoch(nxt) if nxt else t0 + 90
    buf = slice_phone(t0, min(t1, t0+90))
    if len(buf) < 600: continue
    buffers.append(buf); keys.append(tag)
payload = json.dumps({'buffers': buffers, 'opts': opts})
res = json.loads(subprocess.run(['node', 'algorithms/run_detector.js'], input=payload,
                 capture_output=True, text=True, cwd='/home/bence/git/stroke-coach').stdout)

# ---------- 4. report ----------
print(f'{"trial":>8} {"tgt":>4} {"diffGPS":>8} {"FFTphone":>9} {"detector":>8}  verdict')
fails = []
for tag, det in zip(keys, res):
    tgt = TARGETS.get(tag)
    ref = truth.get(tag)
    # FFT on the phone window itself
    px = np.array([b['mag'] for b in buffers[keys.index(tag)]])
    fft_ph = fft_spm(px, RATE_WORK)
    ref_s = f'{ref:8.1f}' if ref else '    None'
    ph_s = f'{fft_ph:8.1f}' if fft_ph else '    None'
    det_s = f'{det:8d}'.rjust(8) if det else '    None'
    if tgt:
        ok = det and abs(det - tgt) <= 2
        verdict = 'PASS' if ok else 'FAIL'
        if not ok:
            fails.append((tag, tgt, ref, det))
    else:
        ok = det is None
        verdict = 'NEG-OK' if ok else 'FALSE-POS'
        if not ok: fails.append((tag, 'hold', ref, det))
    print(f'{tag:>8} {str(tgt or "hold"):>4} {ref_s} {ph_s} {det_s}  {verdict}')

n_tgt = sum(1 for t in keys if t in TARGETS and truth.get(t))
n_pass = sum(1 for tag in keys if tag in TARGETS and truth.get(tag)
             and (r := res[keys.index(tag)]) and abs(r - TARGETS[tag]) <= 2)
n_falsepos = sum(1 for tag, det in zip(keys, res) if tag in HOLDS and det)
print(f'\nStroke trials: {n_pass}/{n_tgt} within ±2 spm of target')
print(f'Hold (no-rowing) false positives: {n_falsepos}/{len([t for t in keys if t in HOLDS])}')
print('Failures:', [(f[0], f'tgt={f[1]}', f'ref={f[2] and round(f[2],1)}', f'det={f[3]}') for f in fails])
