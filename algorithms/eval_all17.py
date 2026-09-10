#!/usr/bin/env python3
"""Trial-level ±1 evaluation across ALL 17 rowing trials in the Moore-2019 study
(9 club-named rate trials + 9 elite rate trials, deduped handling of holds).

Uses steadiest-cluster median per trial (immune to per-window truth noise).
Done as a file so it's re-runnable and commit-able, unlike ad-hoc stdin runs.
"""
import json, subprocess, csv, glob, re
import numpy as np
from datetime import datetime, timezone, timedelta
from collections import defaultdict

TZm = timezone(timedelta(hours=-7))

def phone(root, pat):
    rows = csv.DictReader(open(glob.glob(root + '/iPhone/' + pat)[0]))
    lt, ay = [], []
    for r in rows:
        if r.get('log_time') and r.get('accelerometer_acceleration_y'):
            lt.append(float(r['log_time']))
            ay.append(float(r['accelerometer_acceleration_y']))
    return np.array(lt), np.array(ay)

def trials_of(fn):
    out = []
    for line in open(fn):
        m = re.search(r'\*-(\d{6})\.csv', line)
        if not m:
            continue
        rate = line.split(',')[1].strip()
        out.append((m.group(1), int(rate) if rate.isdigit() else 'hold'))
    return out

def sec_of(day, hhmmss, lt0):
    dt = datetime(day[0], day[1], day[2], int(hhmmss[:2]), int(hhmmss[2:4]),
                  int(hhmmss[4:6]), tzinfo=TZm).timestamp()
    return dt - lt0

CLUB = '/tmp/row_data/row_data/club-level'
ELITE = '/tmp/row_data/row_data/elite'
lt_c, ay_c = phone(CLUB, 'Boat2x-*.csv')
lt_e, ay_e = phone(ELITE, 'Boat-*.csv')
club_t = trials_of(f'{CLUB}/diffGPS/1club_experimental_log.csv')
elite_t = trials_of(f'{ELITE}/diffGPS/1elite_experimental_log.csv')

all_trials = []
for tag, rate in club_t:
    if rate == 'hold':
        continue
    s = sec_of((2018, 4, 20), tag, lt_c[0])
    k0 = int(s * 100)
    wins = []
    for st in range(0, 90, 5):
        i0 = k0 + st * 100
        seg = ay_c[i0:i0 + 2000]
        if len(seg) < 2000:
            break
        if seg.std() < 0.06:
            continue
        wins.append([{'t': float(j / 100 * 1000), 'mag': float(seg[j])} for j in range(2000)])
    if wins:
        all_trials.append({'ds': 'club', 'tag': tag, 'nominal': rate, 'wins': wins})
for tag, rate in elite_t:
    if rate == 'hold':
        continue
    s = sec_of((2018, 4, 22), tag, lt_e[0])
    k0 = int(s * 100)
    wins = []
    for st in range(0, 60, 5):
        i0 = k0 + st * 100
        seg = ay_e[i0:i0 + 2000]
        if len(seg) < 2000:
            break
        if seg.std() < 0.06:
            continue
        wins.append([{'t': float(j / 100 * 1000), 'mag': float(seg[j])} for j in range(2000)])
    if wins:
        all_trials.append({'ds': 'elite', 'tag': tag, 'nominal': rate, 'wins': wins})

nw = sum(len(t['wins']) for t in all_trials)
print(f'trials: {len(all_trials)}, non-idle windows: {nw}')

flat, idx = [], []
for ti, t in enumerate(all_trials):
    for w in t['wins']:
        flat.append(w)
        idx.append(ti)
res = json.loads(subprocess.run(
    ['node', 'algorithms/run_detector.js'],
    input=json.dumps({'buffers': flat, 'opts': {'spmStep': 0.1, 'sdGate': 0.15}}),
    capture_output=True, text=True, cwd='/home/bence/git/stroke-coach').stdout)

tr = defaultdict(list)
for i, d in zip(idx, res):
    if d is not None:
        tr[i].append(d)

ok = n = 0
report = []
for ti, t in enumerate(all_trials):
    reads = tr[ti]
    label = f"{t['ds']}/{t['tag']}"
    if not reads:
        report.append((label, t['nominal'], None, 'no detections'))
        continue
    rs = sorted(reads)
    best = []
    for r0 in rs:
        cl = [x for x in rs if abs(x - r0) <= 1.5]
        if len(cl) > len(best):
            best = cl
    med = float(np.median(best))
    good = abs(med - t['nominal']) <= 1.0
    ok += good
    n += 1
    report.append((label, t['nominal'], med, f'{min(best):.1f}-{max(best):.1f} [{"✓" if good else "✗"}] det={len(reads)}'))

for label, nom, med, extra in report:
    print(f'{label:>14} nom={nom:>3} med={med if med is not None else "--":>6} {extra}')

# instrument cross-check where diffGPS log exists (whole-log FFT, club position
# / elite north-east)
def inst_club(tag):
    fs = glob.glob(f'{CLUB}/diffGPS/log*_position_log_*{tag}.csv')
    if not fs:
        return None
    rows = list(csv.DictReader(open(fs[0])))
    lat = np.array([float(r['latitude(degrees)']) for r in rows])
    lon = np.array([float(r['longitude(degrees)']) for r in rows])
    R = 6371000
    dd = 2 * R * np.arcsin(np.sqrt(np.sin(np.diff(lat) * np.pi / 180 / 2) ** 2 +
                                   np.cos(lat[:-1]) * np.cos(lat[1:]) * np.sin(np.diff(lon) * np.pi / 180 / 2) ** 2))
    v = np.convolve(dd * 10, np.ones(10) / 10, mode='same')
    sp = np.fft.rfft((v - v.mean()) * np.hanning(len(v)))
    fr = np.fft.rfftfreq(len(v), 0.1)
    band = (fr * 60 >= 13) & (fr * 60 <= 45)
    if not band.any():
        return None
    return round(fr[band][np.argmax(sp[band])] * 60, 1)

def inst_elite(tag):
    fs = glob.glob(f'{ELITE}/diffGPS/baseline_log_*{tag}.csv')
    if not fs:
        return None
    rows = list(csv.DictReader(open(fs[0])))
    n = np.array([float(r['north(meters)']) for r in rows])
    e = np.array([float(r['east(meters)']) for r in rows])
    v = np.convolve(np.hypot(np.diff(n), np.diff(e)) * 10, np.ones(10) / 10, mode='same')
    sp = np.fft.rfft((v - v.mean()) * np.hanning(len(v)))
    fr = np.fft.rfftfreq(len(v), 0.1)
    band = (fr * 60 >= 13) & (fr * 60 <= 45)
    if not band.any():
        return None
    return round(fr[band][np.argmax(sp[band])] * 60, 1)

print('\ninstrument cross-check (whole-log diffGPS FFT):')
for ti, t in enumerate(all_trials):
    ref = inst_club(t['tag']) if t['ds'] == 'club' else inst_elite(t['tag'])
    reads = tr[ti]
    if ref and reads:
        rs = sorted(reads)
        best = []
        for r0 in rs:
            cl = [x for x in rs if abs(x - r0) <= 1.5]
            if len(cl) > len(best):
                best = cl
        med = float(np.median(best))
        flag = '✓' if abs(med - ref) <= 1.5 else '✗'
        print(f"{t['ds']}/{t['tag']:>6} det={med:5.1f} inst={ref:5.1f} {flag}")

print(f'\nTRIAL-LEVEL ±1 vs logged nominals: {ok}/{n} passed')
