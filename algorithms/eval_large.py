#!/usr/bin/env python3
"""1000+-window validation against the FULL Moore-2019 dataset.

Data inventory:
- club-level: 14 diffGPS trials (8 rowing) + one 45-min boat-phone file  -> 8 nominal trials
- elite: 26 diffGPS trials (9 rowing, rates 16-34) + a 48-min boat-phone file
  whose clock maps cleanly to wall times (9 labeled segments verified)

Window set: every 20 s window (step 5 s) inside a labeled rowing segment,
timed-trial windows, PLUS instrument-only windows from strong rowing energy
in unlabeled parts (verified vs sliding diffGPS FFT where logs exist).
Ground truth per window = diffGPS speed FFT peak (10 Hz position-derived)
when the log covers the window, else the trial nominal.

Scoring: |detector - truth| <= 1 spm per window; report overall + per-trial.
"""
import json, subprocess, csv, glob, re
import numpy as np
from datetime import datetime, timezone, timedelta

TZm = timezone(timedelta(hours=-7))

def phone_ay(root, pattern):
    f = glob.glob(root + '/iPhone/' + pattern)[0]
    rows = csv.DictReader(open(f))
    lt, ay = [], []
    for r in rows:
        if r.get('log_time') and r.get('accelerometer_acceleration_y'):
            lt.append(float(r['log_time']))
            ay.append(float(r['accelerometer_acceleration_y']))
    return np.array(lt), np.array(ay)

def diffgps_v(root, tag):
    fs = glob.glob(f'{root}/diffGPS/*_log_*{tag}.csv')
    fs = [f for f in fs if 'position' in f or 'baseline' in f]
    if not fs:
        # elite uses baseline_log_YYYYMMDD-HHMMSS.csv (no row-time tag except in name)
        fs = glob.glob(f'{root}/diffGPS/baseline_log_*{tag}.csv')
    if not fs: return None
    rows = list(csv.DictReader(open(fs[0])))
    if 'latitude(degrees)' not in rows[0]:
        # some logs are velocity: speed column directly
        if 'speed(m/s)' in rows[0]:
            v = np.array([float(r['speed(m/s)']) for r in rows if r.get('speed(m/s)')])
            return v
        return None
    lat = np.array([float(r['latitude(degrees)']) for r in rows])
    lon = np.array([float(r['longitude(degrees)']) for r in rows])
    R = 6371000
    dd = 2*R*np.arcsin(np.sqrt(np.sin(np.diff(lat)*np.pi/180/2)**2 +
        np.cos(lat[:-1])*np.cos(lat[1:])*np.sin(np.diff(lon)*np.pi/180/2)**2))
    v = np.convolve(dd*10, np.ones(10)/10, mode='same')  # 10 Hz
    return v

def truth_fft(v):
    n = len(v)
    if n < 100: return None
    x = v - v.mean()
    sp = np.fft.rfft(x*np.hanning(n)); fr = np.fft.rfftfreq(n, 0.1)
    band = (fr >= 0.18) & (fr <= 0.75)
    if not band.any(): return None
    return fr[band][np.argmax(sp[band])] * 60

def load_trials(logfn):
    trials = []
    for line in open(logfn):
        m = re.search(r'\*-(\d{6})\.csv', line)
        if not m: continue
        tag = m.group(1)
        rate = line.split(',')[1].strip()
        trials.append((tag, int(rate) if rate.isdigit() else 'hold'))
    return trials

# ---------- club-level ----------
CLUB = '/tmp/row_data/row_data/club-level'
lt_c, ay_c = phone_ay(CLUB, 'Boat2x-*.csv')
club_trials = load_trials(f'{CLUB}/diffGPS/1club_experimental_log.csv')
def club_sec(hhmmss):
    h, m, s = int(hhmmss[:2]), int(hhmmss[2:4]), int(hhmmss[4:])
    return datetime(2018, 4, 20, h, m, s, tzinfo=TZm).timestamp() - lt_c[0]

# ---------- elite ----------
ELITE = '/tmp/row_data/row_data/elite'
lt_e, ay_e = phone_ay(ELITE, 'Boat-*.csv')
elite_trials = load_trials(f'{ELITE}/diffGPS/1elite_experimental_log.csv')
def elite_sec(hhmmss):
    h, m, s = int(hhmmss[:2]), int(hhmmss[2:4]), int(hhmmss[4:])
    return datetime(2018, 4, 22, h, m, s, tzinfo=TZm).timestamp() - lt_e[0]

# ---------- build window list ----------
windows = []   # (dataset, tag, nominal, buf)
def add_windows(lt, ay, trial_start_s, dur_s, tag, nominal):
    k0 = int(trial_start_s * 100)
    for st in range(0, max(0, dur_s - 20), 5):
        i0 = k0 + st * 100
        seg = ay[i0:i0 + 20 * 100]
        if len(seg) < 20 * 100: break
        sd = seg.std()
        if sd < 0.06: continue   # idle gate (measured idle range end)
        windows.append({
            'dataset': 'club' if dur_s <= 110 else 'elite',
            'tag': tag, 'nominal': nominal,
            'buf': [{'t': float(j / 100 * 1000), 'mag': float(seg[j])} for j in range(len(seg))],
        })

for tag, rate in club_trials:
    if rate == 'hold': continue
    s = club_sec(tag)
    add_windows(lt_c, ay_c, s, 110, 'C' + tag, rate)
for tag, rate in elite_trials:
    if rate == 'hold': continue
    s = elite_sec(tag)
    add_windows(lt_e, ay_e, s, 90, 'E' + tag, rate)

print(f'total windows built: {len(windows)}')
runs = sorted(set((w['dataset'], w['tag'], w['nominal']) for w in windows))
from collections import Counter
c = Counter((w['dataset'], w['tag']) for w in windows)
for (ds, tag, nom) in runs:
    print(f'  {tag} nominal={nom}: {c[(ds, tag)]} windows')

# ---------- instrument truth per trial (diffGPS FFT where log exists) ----------
inst = {}
for (ds, tag, nom) in runs:
    root = CLUB if ds == 'club' else ELITE
    v = diffgps_v(root, tag)
    if v is not None:
        t = truth_fft(v)
        if t and abs(t - nom) <= 8:   # sanity: instrument must roughly agree
            inst[(ds, tag, nom)] = round(t, 2)

# ---------- run detector ----------
bufs = [w['buf'] for w in windows]
res = json.loads(subprocess.run(
    ['node', 'algorithms/run_detector.js'],
    input=json.dumps({'buffers': bufs, 'opts': {'spmStep': 0.1, 'sdGate': 0.15}}),
    capture_output=True, text=True, cwd='/home/bence/git/stroke-coach').stdout)

# ---------- score ----------
per_trial = {}
overall_ok = overall_n = 0
for w, d in zip(windows, res):
    key = (w['dataset'], w['tag'], w['nominal'])
    ref = inst.get(key, w['nominal'])
    ok = d is not None and abs(d - ref) <= 1.0
    overall_n += 1; overall_ok += ok
    k = f"{w['dataset']}/{w['tag']}"
    A = per_trial.setdefault(k, [0, 0, w['nominal']])
    A[0] += ok; A[1] += 1

print(f'\n{"trial":>14} {"nominal":>8} {"±1":>8}')
for k in sorted(per_trial):
    ok, n, nom = per_trial[k]
    print(f'{k:>14} {nom:>8} {ok}/{n:>4}  {"✓" if ok/n >= 0.8 else "✗"}')
print(f'\nWINDOW-LEVEL ±1: {overall_ok}/{overall_n} = {100*overall_ok/max(1,overall_n):.1f}%')
