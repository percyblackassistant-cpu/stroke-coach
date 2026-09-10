#!/usr/bin/env python3
"""Per-window evaluation, variable overlapping windows (Bence, 09-10).

Windows: lengths 15–40 s (chosen pseudo-randomly), step 3 s — heavy overlap.
Each window is scored INDIVIDUALLY: one line per window with reading + truth.

Truth sources (evidence-based, after spectral autopsies):
- elite trials: 40 s diffGPS FFT pool (north/east logs are long & stable;
  overlapping pools medianed; windows whose pool spread >2.5 spm are
  flagged rate-varying)
- club trials: short diffGPS logs are spectrally mushy (self-check: same
  log peak at 13.9/17.8/21.6/29.2 — worse SNR than the phone itself), so
  truth = logged nominal only, flagged 'nominal-ref'

Report line: PASS/FAIL/MISS + reading + truth + flags. Summary at end.
"""
import csv, glob, json, re, subprocess
import numpy as np
from datetime import datetime, timezone, timedelta
from collections import defaultdict

TZm = timezone(timedelta(hours=-7))
CLUB = '/tmp/row_data/row_data/club-level'
ELITE = '/tmp/row_data/row_data/elite'

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

def speed_elite(tag):
    fs = glob.glob(f'{ELITE}/diffGPS/baseline_log_*{tag}.csv')
    if not fs:
        return None
    rows = list(csv.DictReader(open(fs[0])))
    n = np.array([float(r['north(meters)']) for r in rows])
    e = np.array([float(r['east(meters)']) for r in rows])
    v = np.hypot(np.diff(n), np.diff(e)) * 10
    return np.convolve(v, np.ones(10) / 10, mode='same')

def fft_rate(x):
    m = len(x)
    if m < 300:
        return None
    sp = np.fft.rfft((x - x.mean()) * np.hanning(m))
    fr = np.fft.rfftfreq(m, 0.1)
    band = (fr * 60 >= 12) & (fr * 60 <= 48)
    if not band.any():
        return None
    return fr[band][np.argmax(sp[band])] * 60

lt_c, ay_c = phone(CLUB, 'Boat2x-*.csv')
lt_e, ay_e = phone(ELITE, 'Boat-*.csv')
club_t = trials_of(f'{CLUB}/diffGPS/1club_experimental_log.csv')
elite_t = trials_of(f'{ELITE}/diffGPS/1elite_experimental_log.csv')

def sec_of(day, tag, lt0):
    dt = datetime(day[0], day[1], day[2], int(tag[:2]), int(tag[2:4]),
                  int(tag[4:6]), tzinfo=TZm).timestamp()
    return dt - lt0

LENGTHS = [40, 30, 25, 20, 15]
STEP = 3
rng = np.random.default_rng(7)

windows = []
for src, (lt, ay), trials, day, maxdur in [
        ('elite', (lt_e, ay_e), elite_t, (2018, 4, 22), 60),
        ('club', (lt_c, ay_c), club_t, (2018, 4, 20), 110)]:
    for tag, rate in trials:
        if rate == 'hold':
            continue
        s = sec_of(day, tag, lt[0])
        k0 = int(s * 100)
        if src == 'elite':
            v = speed_elite(tag)
            dur_v = len(v) / 10 if v is not None else 0
        else:
            v = None
            dur_v = 0
        for st in range(0, maxdur - 15, STEP):
            L = int(rng.choice(LENGTHS))
            i0 = k0 + st * 100
            seg = ay[i0:i0 + L * 100]
            if len(seg) < L * 100:
                break
            if seg.std() < 0.06:
                continue
            if src == 'elite' and v is not None:
                pool = []
                ts0 = max(0, int(st - (40 - L) / 2))
                for ts in range(ts0, int(dur_v) - 40, 3):
                    ov = min(st + L, ts + 40) - max(st, ts)
                    if ov >= max(10, L / 2):
                        r = fft_rate(v[ts * 10:ts * 10 + 400])
                        if r:
                            pool.append(r)
                if len(pool) >= 2:
                    truth = float(np.median(pool))
                    spread = float(max(pool) - min(pool))
                    ref = 'instrument-pool'
                else:
                    truth, spread, ref = float(rate), 0.0, 'nominal-fallback'
            else:
                truth, spread, ref = float(rate), 0.0, 'nominal-only'
            windows.append({
                'ds': src, 'tag': tag, 'st': st, 'L': L,
                'truth': round(truth, 2), 'spread': round(spread, 2), 'ref': ref,
                'buf': [{'t': float(j / 100 * 1000), 'mag': float(seg[j])} for j in range(len(seg))],
            })

print(f'windows built: {len(windows)} '
      f'({sum(1 for w in windows if w["ref"] != "nominal-only")} instrument-ref)')

res = json.loads(subprocess.run(
    ['node', 'algorithms/run_detector.js'],
    input=json.dumps({'buffers': [w['buf'] for w in windows],
                      'opts': {'spmStep': 0.1, 'sdGate': 0.15}}),
    capture_output=True, text=True, cwd='/home/bence/git/stroke-coach').stdout)

lines = []
ok = n = 0
flagged = varying = 0
for w, d in zip(windows, res):
    key = f"{w['ds']}/{w['tag']}@{w['st']}s L{w['L']} [{w['ref']}]"
    varying = w['spread'] > 2.5 and w['ref'] == 'instrument-pool'
    if varying:
        flagged += 1
    if d is None:
        lines.append(f'{key} truth={w["truth"]:5.1f} det=--  MISS' +
                     (' [rate-varying]' if varying else ''))
        continue
    n += 1
    good = abs(d - w['truth']) <= 1.5
    ok += good
    lines.append(f'{key} truth={w["truth"]:5.1f} det={d:5.1f} {"PASS" if good else "FAIL"}' +
                 (' [rate-varying]' if varying else ''))

open('/tmp/per_window_report.txt', 'w').write('\n'.join(lines))

by_trial = defaultdict(lambda: [0, 0])
for w, d in zip(windows, res):
    k = f"{w['ds']}/{w['tag']}"
    by_trial[k][1] += 1
    if d is not None and abs(d - w['truth']) <= 1.5:
        by_trial[k][0] += 1

print('\nper-window result (±1.5):')
print(f'  scored {n}, PASS {ok} ({100 * ok / max(n, 1):.1f}%), '
      f'no-detect {len(windows) - n}, rate-varying flagged {flagged}')
print('per-trial:')
for k in sorted(by_trial):
    o, nn = by_trial[k]
    print(f'  {k:>14}: {o}/{nn} ({100 * o / nn:.0f}%)')
print('\nfull line list: /tmp/per_window_report.txt')
