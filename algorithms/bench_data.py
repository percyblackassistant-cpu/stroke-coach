#!/usr/bin/env python3
"""Data loaders + truth extraction for the estimator benchmark (2026-09-10).

Loaders:
  - load_maria_real(): tests/fixtures/maria-real-water.csv  (M accel rows + G GPS rows)
  - load_fixture(name): other fixture CSVs (M accel rows only, custom format)
  - moore_windows(): Moore et al. 2019 club-level trials -> aligned 14 s windows
    (correlation alignment of phone envelope vs diffGPS speed, same approach
    as algorithms/eval_spm_aligned.py so the mapping stays consistent with the
    offline ±1把她 milestone runs)

Truth:
  - maria: G-line GPS speed, highpassed 20–80 cpm, FFT peak verified + refined
    by zero-crossing count inside the scored stretch; window-local curve from
    24 s windows (interpolated) for per-window truth.
  - moore: window-local FFT peak of diffGPS speed over the same span.
All space-free helpers, no network. Pure analysis — nothing is committed.
"""
import csv, glob, os, re
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOORE_ROOT = '/tmp/row_data/row_data/club-level'
MOORE_TZ_OFF_H = -7  # 2018-04-20 local PDT offset hours applied in original harness
MOORE_EPOCH_BASE = None  # computed lazily

MOORE_TARGETS = {
    '090501': 20, '091022': 22, '091604': 22, '091858': 16,
    '092004': 24, '092443': 24, '092925': 26, '093324': 26,
}
MOORE_HOLDS = ['091318', '092314', '092738', '093143', '093533']


# ---------------------------------------------------------------- fixtures
def _parse_fixture(path):
    """Custom AUX recording: HEADER line then M(...) G(...) S(...) segments that
    can share one line via | separators. Returns dict t/ax/ay/az, gps (t,lat,lon,speed), st(status rows)."""
    txt = open(path, encoding='utf-8', errors='replace').read()
    t_m = []; ax = []; ay = []; az = []
    g_t = []; g_lat = []; g_lon = []; g_sp = []
    s_t = []; s_spm = []; s_locked = []; s_tracker = []
    # regex over whole text (a line may merge several record groups with |)
    for m in re.finditer(r'(?:^|\|)M,([0-9.Ee+-]+),([-0-9.Ee+-]+),([-0-9.Ee+-]+),([-0-9.Ee+-]+)', txt, re.M):
        t_m.append(float(m.group(1)) / 1.0 / 1000.0 if False else float(m.group(1)))
        ax.append(float(m.group(2))); ay.append(float(m.group(3))); az.append(float(m.group(4)))
    for m in re.finditer(r'(?:^|\|)G,([0-9.Ee+-]+),([-0-9.]+),([-0-9.]+),([-0-9.]+)', txt, re.M):
        g_t.append(float(m.group(1))); g_lat.append(float(m.group(2)))
        g_lon.append(float(m.group(3))); g_sp.append(float(m.group(4)))
    for m in re.finditer(r'(?:^|\|)S,([0-9.Ee+-]+),([-0-9.Ee+-]+),([0-9.]+),([-0-9.Ee+-]+)', txt, re.M):
        s_t.append(float(m.group(1))); s_spm.append(float(m.group(2)))
        s_locked.append(float(m.group(3))); s_tracker.append(float(m.group(4)))
    t_m = np.array(t_m) / 1000.0
    ay = np.array(ay)
    rel = t_m - t_m[0] if len(t_m) else t_m
    # stream segmentation: split where the gap > 1 s (phone throttling/reboots)
    if len(rel) > 1:
        gaps = np.where(np.diff(rel) > 1.0)[0]
        bounds = [0] + [g + 1 for g in gaps] + [len(rel)]
        seg_id = np.zeros(len(rel), dtype=int)
        for k in range(len(bounds) - 1):
            seg_id[bounds[k]:bounds[k + 1]] = k
    else:
        seg_id = np.zeros(len(rel), dtype=int)
    return {
        't': rel, 'ax': np.array(ax), 'ay': ay, 'az': np.array(az), 'fs': None,
        'seg_id': seg_id,
        'seg_t0': [float(rel[bounds[k]]) for k in range(len(bounds) - 1)] if len(rel) > 1 else [0.0],
        'n_seg': len(bounds) - 1 if len(rel) > 1 else 1,
        'gps_t': np.array(g_t) / 1000.0, 'gps_lat': np.array(g_lat),
        'gps_lon': np.array(g_lon), 'gps_speed': np.array(g_sp),
        'st_t': np.array(s_t) / 1000.0, 'st_spm': np.array(s_spm),
        'st_locked': np.array(s_locked), 'st_tracker': np.array(s_tracker),
    }


def _fit_fs(t, seg_id=None):
    """fs from the LARGEST contiguous segment, median-delta based (robust to gaps)."""
    if len(t) < 100:
        return None
    if seg_id is not None:
        sizes = np.bincount(seg_id)
        main = int(np.argmax(sizes))
        t = t[seg_id == main]
    d = np.diff(t)
    d = d[d > 0]
    return 1.0 / np.median(d) if len(d) > 0 else None


def load_maria_real():
    d = _parse_fixture(os.path.join(REPO, 'tests', 'fixtures', 'maria-real-water.csv'))
    d['fs'] = _fit_fs(d['t'], d.get('seg_id'))
    d['name'] = 'maria-real-water'
    return d


def load_fixture(name):
    d = _parse_fixture(os.path.join(REPO, 'tests', 'fixtures', f'{name}.csv'))
    d['fs'] = _fit_fs(d['t'], d.get('seg_id'))
    d['name'] = name
    return d


FIXTURE_NAMES = ['bence-trial1', 'bence-trial2', 'maria-trial1', 'maria-trial2', 'maria-trial5']


# ---------------------------------------------------------------- maria truth
def _band_filter(x, fs, lo, hi):
    n = len(x)
    X = np.fft.rfft(x * np.hanning(n))
    fr = np.fft.rfftfreq(n, 1.0 / fs)
    X[(fr < lo) | (fr > hi)] = 0
    return np.fft.irfft(X, n), fr, X


def maria_truth_curve(d, span=(5, 115), win=24.0, hop=6.0, band=(0.20, 0.80)):
    """Windowed GPS-speed FFT truth inside the rowing stretch (interpolatable curve)."""
    t = d['gps_t'] - d['gps_t'][0]
    v = d['gps_speed']
    fs = 1.0 / np.median(np.diff(t))
    out = []
    for c in np.arange(span[0] + win / 2, span[1] - win / 2 + 1e-6, hop):
        m = (t >= c - win / 2) & (t <= c + win / 2)
        tv, vv = t[m], v[m] - v[m].mean()
        if len(vv) < 10:
            continue
        n = len(vv)
        X = np.abs(np.fft.rfft(vv * np.hanning(n)))
        fr = np.fft.rfftfreq(n, 1.0 / fs)
        bm = (fr >= band[0]) & (fr <= band[1])
        k = int(np.argmax(X * bm))
        p = np.log(X[[max(k - 1, 0), k, min(k + 1, len(X) - 1)]] + 1e-9)
        den = p[0] - 2 * p[1] + p[2]
        f = fr[k]
        if den < 0:
            f = fr[k] + 0.5 * (p[0] - p[2]) / den * (fr[1] - fr[0])
        out.append((c, f * 60.0, float(X[k] / max(np.median(X[bm]), 1e-9))))
    return np.array(out)  # cols: t_center_s, spm, spectral ratio


def maria_truth_scalar(d, span=(5, 115), band=(0.20, 0.80)):
    """Single-stretch scalar: FFT peak + zero-crossing refinement."""
    t = d['gps_t'] - d['gps_t'][0]
    v = d['gps_speed']
    fs = 1.0 / np.median(np.diff(t))
    m = (t >= span[0]) & (t <= span[1])
    vv = v[m] - v[m].mean()
    n = len(vv)
    hp, fr, X = _band_filter(vv, fs, band[0], band[1])
    sp = np.abs(X)
    bm = (fr >= band[0]) & (fr <= band[1])
    k = int(np.argmax(sp * bm))
    peak_spm = fr[k] * 60.0
    tv = t[m]
    zc = np.where(np.diff(np.sign(hp)) != 0)[0]
    zc_spm = None
    if len(zc) > 4:
        period = 2 * (tv[zc[-1]] - tv[zc[0]]) / (len(zc) - 1)
        zc_spm = 60.0 / period
    ratio = float(sp[k] / max(np.median(sp[bm]), 1e-9))
    return {'fft_spm': peak_spm, 'xcross_spm': zc_spm, 'ratio': ratio,
            'n_cross': int(len(zc)), 'span': span}


# ---------------------------------------------------------------- moore
def _moore_pc_time(s):
    from datetime import datetime, timezone, timedelta
    TZ = timezone(timedelta(hours=MOORE_TZ_OFF_H))
    if not s or ' ' not in s:
        return None
    p = s.split(' ')[1].split(':')
    if len(p) < 3:
        return None
    h, m = int(p[0]), int(p[1])
    sec = float(p[2])
    return datetime(2018, 4, 20, h, m, int(sec), tzinfo=TZ).timestamp() + (sec - int(sec))


def moore_speed(fn):
    rows = list(csv.DictReader(open(fn)))
    if len(rows) < 240:
        return None
    lat = np.array([float(r['latitude(degrees)']) for r in rows])
    lon = np.array([float(r['longitude(degrees)']) for r in rows])
    R = 6371000
    dd = 2 * R * np.arcsin(np.sqrt(
        np.sin(np.diff(lat) * np.pi / 180 / 2) ** 2 +
        np.cos(lat[:-1]) * np.cos(lat[1:]) * np.sin(np.diff(lon) * np.pi / 180 / 2) ** 2))
    v = np.convolve(dd * 10.0, np.ones(10) / 10, mode='same')
    t0 = _moore_pc_time(rows[0]['pc_time'])
    if t0 is None:
        return None
    return v, t0  # 10 Hz speed


def moore_phone():
    fn = glob.glob(f'{MOORE_ROOT}/iPhone/Boat2x-*.csv')[0]
    ay_list, lt_list = [], []
    for r in csv.DictReader(open(fn)):
        ay = r.get('accelerometer_acceleration_y')
        if ay and r.get('log_time'):
            ay_list.append(float(ay)); lt_list.append(float(r['log_time']))
    ay = np.array(ay_list); lt = np.array(lt_list)
    return ay, lt  # 100 Hz nominal (jittery packet clock)


def moore_trials(windows_win=14.0, hop=7.0, env_fs=5.0):
    """Return list of dicts: tag, target, windows[(t_center_rel_s, truth_spm)], raw[] per window."""
    ay, lt = moore_phone()
    n5 = len(ay) // 20
    env = ay[:n5 * 20].reshape(n5, 20).mean(axis=1)
    env_t = lt[:n5 * 20].reshape(n5, 20).mean(axis=1)
    N20 = int(windows_win * 100)

    def bandpass(x, fs, lo, hi):
        n = len(x)
        sp = np.fft.rfft(x * np.hanning(n)); fr = np.fft.rfftfreq(n, 1 / fs)
        sp[(fr < lo) | (fr > hi)] = 0
        return np.fft.irfft(sp, n)

    trials = []
    for tag in sorted(MOORE_TARGETS):
        fns = glob.glob(f'{MOORE_ROOT}/diffGPS/log*_position_log_*{tag}.csv')
        if not fns:
            continue
        ld = moore_speed(fns[0])
        if not ld:
            continue
        v, t0 = ld
        vb = bandpass(v - v.mean(), 10.0, 0.18, 0.75)
        i_center = int(np.searchsorted(env_t, t0))
        lo_i = max(0, i_center - 90 * 5); hi_i = min(len(env), i_center + int(len(v) / 2) + 90 * 5)
        seg = env[lo_i:hi_i]
        if len(seg) < len(vb) / 4:
            continue
        eb = bandpass(seg - seg.mean(), env_fs, 0.18, 0.75)
        n5v = int(len(vb) / 2)
        vb5 = vb[:n5v * 2].reshape(n5v, 2).mean(axis=1)
        best_r, best_off = -2, 0
        for off in range(0, max(1, len(eb) - len(vb5)), 5):
            a = eb[off:off + len(vb5)]
            if len(a) < len(vb5):
                break
            sa, sb = a.std(), vb5.std()
            if sa < 1e-9 or sb < 1e-9:
                continue
            r = float(np.dot(a - a.mean(), vb5 - vb5.mean()) / (len(a) * sa * sb))
            if r > best_r:
                best_r, best_off = r, off
        t_start = t0 + (env_t[lo_i + best_off] - t0)
        start_block = int(np.searchsorted(env_t, t_start))
        start_row = start_block * 20
        wins = []
        for st in range(0, int(len(v) / 2) - int(windows_win * 5), int(hop * 5)):
            b0 = start_block + st
            b1 = b0 + int(windows_win * 5)
            if b1 > n5:
                break
            seg_env = env[b0:b1]
            if seg_env.std() < 0.05:
                continue
            r0 = b0 * 20
            raw = ay[r0: b1 * 20]
            if len(raw) < N20:
                break
            vseg = v[st * 2: st * 2 + int(windows_win * 10)]
            if len(vseg) < 50:
                break
            sp = np.fft.rfft((vseg - vseg.mean()) * np.hanning(len(vseg)))
            fr = np.fft.rfftfreq(len(vseg), 0.1)
            band = (fr >= 0.18) & (fr <= 0.75)
            if not band.any():
                continue
            truth = float(fr[band][np.argmax(sp[band])] * 60)
            wins.append({'tc': st + windows_win / 2, 'truth': truth, 'raw': raw})
        trials.append({'tag': tag, 'target': MOORE_TARGETS[tag], 'windows': wins})
    return trials


def moore_holds(win=14.0, hop=7.0):
    """No-rowing hold trials → windows of raw accel for FP tests."""
    ay, lt = moore_phone()
    N = int(win * 100)
    out = []
    for tag in MOORE_HOLDS:
        fns = glob.glob(f'{MOORE_ROOT}/diffGPS/log*_position_log_*{tag}.csv')
        if not fns:
            continue
        rows = list(csv.DictReader(open(fns[0])))
        t0 = _moore_pc_time(rows[0]['pc_time'])
        if t0 is None:
            continue
        dur = len(rows) / 10.0
        i0 = int(np.searchsorted(lt, t0))
        n_win = int(dur / hop)
        for k in range(max(1, n_win)):
            st = i0 + int(k * hop * 100)
            raw = ay[st: st + N * 2]
            if len(raw) < N:
                break
            out.append({'tag': f'{tag}#{k}', 'raw': raw[:N]})
    return out
