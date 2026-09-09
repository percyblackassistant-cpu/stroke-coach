#!/usr/bin/env python3
"""±1 spm evaluation with correlation-based time alignment.

Why: the phone log_time clock jitters ±0.4 s per row (packet clock), so
wall-clock trial slicing is unreliable at ±1 spm. The stroke rhythm itself is
the alignment signal: cross-correlate the phone accel envelope against the
diffGPS speed oscillation per trial, then score detector vs window-local
diffGPS truth on the SAME 20 s span.
"""
import json, subprocess, csv, glob, re
import numpy as np
from datetime import datetime, timezone, timedelta

ROOT = '/tmp/row_data/row_data/club-level'
TZ = timezone(timedelta(hours=-7))
FS = 100.0
ENV_FS = 5.0   # envelope working rate

# logged target rates from 1club_experimental_log.csv (experimenter metadata)
TARGETS = {
    '090501': 20, '091022': 22, '091604': 22, '091858': 16,
    '092004': 24, '092443': 24, '092925': 26, '093324': 26,
}

def parse_pc(t):
    if not t or ' ' not in t: return None
    try:
        p = t.split(' ')[1].split(':')
        if len(p) < 3: return None
        h, m = int(p[0]), int(p[1]); s = float(p[2])
        return datetime(2018,4,20,h,m,int(s),tzinfo=TZ).timestamp() + (s-int(s))
    except Exception: return None

# ---- phone stream: ay + per-row wall time from log_time (jittery but mean-correct)
ay_list, lt_list = [], []
for r in csv.DictReader(open(glob.glob(f'{ROOT}/iPhone/Boat2x-*.csv')[0])):
    ay = r['accelerometer_acceleration_y']
    if ay and r['log_time']:
        ay_list.append(float(ay)); lt_list.append(float(r['log_time']))
ay = np.array(ay_list); lt = np.array(lt_list)

# envelope at 5 Hz: resample by averaging 20-row blocks (jitter averages out)
n5 = len(ay)//20
env = ay[:n5*20].reshape(n5, 20).mean(axis=1)
env_t = lt[:n5*20].reshape(n5, 20).mean(axis=1)  # block-mean wall time

def bandpass(x, fs, lo, hi):
    n = len(x)
    sp = np.fft.rfft(x*np.hanning(n)); fr = np.fft.rfftfreq(n, 1/fs)
    sp[(fr < lo) | (fr > hi)] = 0
    return np.fft.irfft(sp, n)

# ---- per-trial: load diffGPS speed, bandpass, correlate against phone envelope
def load_speed(fn):
    rows = list(csv.DictReader(open(fn)))
    if len(rows) < 240: return None
    lat = np.array([float(r['latitude(degrees)']) for r in rows])
    lon = np.array([float(r['longitude(degrees)']) for r in rows])
    R = 6371000
    dd = 2*R*np.arcsin(np.sqrt(np.sin(np.diff(lat)*np.pi/180/2)**2 +
        np.cos(lat[:-1])*np.cos(lat[1:])*np.sin(np.diff(lon)*np.pi/180/2)**2))
    v = np.convolve(dd*10, np.ones(10)/10, mode='same')
    t0 = parse_pc(rows[0]['pc_time'])
    if t0 is None: return None
    return v, t0

TRIALS = sorted(TARGETS)
print('Aligning trials by rhythm cross-correlation...')
offsets = {}
for tag in TRIALS:
    fn = glob.glob(f'{ROOT}/diffGPS/log*_position_log_*{tag}.csv')
    if not fn: continue
    ld = load_speed(fn[0])
    if not ld: continue
    v, t0 = ld
    vb = bandpass(v - v.mean(), 10.0, 0.18, 0.75)
    # phone envelope band around expected trial window (target ±90 s search)
    t_expect = t0  # diffGPS pc_time ≈ wall start; env_t is phone wall time
    i_center = int(np.searchsorted(env_t, t_expect))
    lo_i = max(0, i_center - 90*5); hi_i = min(len(env), i_center + int(len(v)/2) + 90*5)
    seg = env[lo_i:hi_i]
    if len(seg) < len(vb)/2: continue
    eb = bandpass(seg - seg.mean(), ENV_FS, 0.18, 0.75)
    # resample vb to 5 Hz
    n5v = int(len(vb)/2)
    vb5 = vb[:n5v*2].reshape(n5v, 2).mean(axis=1)
    # slide vb5 over eb, find best normalized correlation
    best_r, best_off = -2, 0
    for off in range(0, max(1, len(eb) - len(vb5)), 5):  # 1 s steps
        a = eb[off:off+len(vb5)]
        if len(a) < len(vb5): break
        va, vb_ = a.std(), vb5.std()
        if va < 1e-9: continue
        r = float(np.dot(a - a.mean(), vb5 - vb5.mean()) / (len(a)*va*vb_))
        if r > best_r: best_r, best_off = r, off
    phone_t0 = env_t[lo_i + best_off]
    offsets[tag] = (phone_t0 - t_expect, best_r)
    print(f'  {tag}: offset {phone_t0 - t_expect:+.0f}s (corr {best_r:.2f})')

# ---- window-local truth + detector scoring on aligned spans
print('\nScoring: detector vs diffGPS window-local truth (±1 spm)')
results = []
for tag in TRIALS:
    if tag not in offsets: continue
    fn = glob.glob(f'{ROOT}/diffGPS/log*_position_log_*{tag}.csv')[0]
    ld = load_speed(fn)
    if not ld: continue
    v, t0 = ld
    shift, corr = offsets[tag]
    # aligned phone start: trial wall start + correlation shift
    t_start = t0 + shift
    start_block = int(np.searchsorted(env_t, t_start))
    start_row = start_block * 20
    wins = []
    for st in range(0, int(len(v)/2) - 20*5, 10*5):
        seg = env[start_block+st : start_block+st+20*5]
        if len(seg) < 20*5 or seg.std() < 0.05: continue
        # RAW 100Hz samples for the detector (env is only 5 Hz — feeding it
        # mislabeled as 100 Hz aliased everything to null)
        r0 = start_row + st*20
        raw = ay[r0 : r0 + 20*100]
        if len(raw) < 20*100: break
        # window-local truth: FFT peak of diffGPS speed over same span
        vseg = v[st*2 : st*2+20*10]
        if len(vseg) < 100: break
        sp = np.fft.rfft((vseg-vseg.mean())*np.hanning(len(vseg)))
        fr = np.fft.rfftfreq(len(vseg), 0.1)
        band = (fr >= 0.18) & (fr <= 0.75)
        if not band.any(): continue
        truth = fr[band][np.argmax(sp[band])] * 60
        wins.append({'buf': [{'t': float(j/FS*1000),
                              'mag': float(raw[j])} for j in range(len(raw))],
                     'truth': truth, 'st': st})
    if wins:
        results.append((tag, wins))

total = ok = 0
print(f'{"tag":>8} {"n_win":>6} {"median|err|":>12} {"±1 rate":>8}')
for tag, wins in results:
    det = json.loads(subprocess.run(
        ['node', 'algorithms/run_detector.js'],
        input=json.dumps({'buffers': [w['buf'] for w in wins],
                          'opts': {'spmStep': 0.1, 'sdGate': 0.05}}),
        capture_output=True, text=True, cwd='/home/bence/git/stroke-coach').stdout)
    errs = [d - w['truth'] for d, w in zip(det, wins) if d is not None]
    if not errs:
        print(f'{tag:>8} {len(wins):6} {"--":>12}')
        continue
    med = float(np.median(np.abs(errs)))
    within1 = sum(1 for e in errs if abs(e) <= 1.0)
    total += len(errs); ok += within1
    print(f'{tag:>8} {len(errs):6} {med:12.2f} {within1}/{len(errs):>4}')
print(f'\nWindow-local ±1 spm: {ok}/{total} = {100*ok/max(total,1):.0f}%')
