// bench_compare.js — head-to-head windowed benchmark on real data.
// Window bundles come from bench_windows.json built by prep_bench_windows.py
// (repo pattern: python data prep -> node estimator eval via JSON).
//
// Estimators: YIN, ANF (adaptive local-scan tracker), GoertzelHarmo
// (disambiguated), BASELINE = deployed js/stroke-detector.js unmodified.
// Analysis only — writes nothing outside /tmp; run from repo root:
//   python3 algorithms/prep_bench_windows.py && node algorithms/bench_compare.js
const fs = require('fs');
const path = require('path');
const B = require(path.join(__dirname, 'bench_estimators.js'));
const { detectStrokeRate } = require(
  path.join(__dirname, '..', 'js', 'stroke-detector.js'));

const BUNDLE = process.env.BENCH_BUNDLE || '/tmp/bench_windows.json';

function toSampleList(tMs, v) {
  const out = [];
  for (let i = 0; i < tMs.length; i++) out.push({ t: tMs[i], mag: v[i], v: v[i] });
  return out;
}

function runEstimators(samples, opts = {}) {
  const yin = B.yinDetect(samples, opts.yin || {});
  const anfTr = B.anfTrack(samples, opts.anf || {});
  const dur = (samples[samples.length - 1].t - samples[0].t) / 1000;
  const anf = anfTr ? B.anfWindow(anfTr.spmLog, dur * 0.6, dur + 0.01) : null;
  const gh = B.goertzelHarmoDetect(samples, opts.gh || {});
  const base = detectStrokeRate(samples, opts.base || { spmStep: 0.1, sdGate: 0.05 });
  return { yin, anf, gh, base };
}

function stats(errs) {
  if (!errs.length) return { n: 0, medErr: null, maxErr: null, within1: null };
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  return {
    n: errs.length,
    medErr: abs[Math.floor(abs.length / 2)],
    maxErr: abs[abs.length - 1],
    within1: errs.filter(e => Math.abs(e) <= 1.0).length / errs.length,
  };
}

const KEYS = ['yin', 'anf', 'gh', 'base'];

function scoredReads(windows, opts) {
  const errs = Object.fromEntries(KEYS.map(k => [k, []]));
  const nulled = Object.fromEntries(KEYS.map(k => [k, 0]));
  for (const w of windows) {
    const samples = toSampleList(w.samples.map(p => p[0]), w.samples.map(p => p[1]));
    const r = runEstimators(samples, opts);
    for (const k of KEYS) {
      const v = r[k];
      if (v == null || !isFinite(v)) { nulled[k]++; continue; }
      if (w.truth != null && isFinite(w.truth)) errs[k].push(v - w.truth);
    }
  }
  return { stats: Object.fromEntries(KEYS.map(k => [k, stats(errs[k])])), nulled };
}

function fmt(x, d = 2) { return x == null || Number.isNaN(x) ? '--' : x.toFixed(d); }
function pct(x) { return x == null ? '--' : (100 * x).toFixed(0) + '%'; }

function headline(rows, errKey, withinKey) {
  const h1 = ['estimator', 'medErr', 'maxErr', '%±1'].join('\t');
  return [h1, ...rows.map(r => [r.name, fmt(r.stats[errKey].medErr, 2), fmt(r.stats[errKey].maxErr, 1), pct(r.stats[errKey].within1)].join('\t'))].join('\n');
}

function main() {
  const bundle = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
  const report = { datasets: {} };

  // ---------- maria A (row with per-window GPS truth) ----------
  const A = bundle.maria.A;
  const rsA = scoredReads(A.filter(w => w.truth != null));
  report.datasets['maria-A 5-115s'] = rsA;

  // ---------- maria B (readings distribution, no per-window truth) ----------
  const rsB = scoredReads(bundle.maria.B);
  const reads = { yin: [], anf: [], gh: [], base: [] };
  for (const w of bundle.maria.B) {
    const samples = toSampleList(w.samples.map(p => p[0]), w.samples.map(p => p[1]));
    const r = runEstimators(samples);
    for (const k of KEYS) if (r[k] != null && isFinite(r[k])) reads[k].push(r[k]);
  }
  report.datasets['maria-B 120-330s'] = {
    nulls: rsB.nulled,
    readDist: Object.fromEntries(KEYS.map(k => {
      const v = [...reads[k]].sort((a, b) => a - b);
      return [k, {
        n: v.length,
        p50: v.length ? v[Math.floor(v.length / 2)] : null,
        p90: v.length ? v[Math.floor(v.length * 0.9)] : null,
        min: v.length ? v[0] : null, max: v.length ? v[v.length - 1] : null,
      }];
    })),
  };

  // ---------- moore ----------
  const mooreRows = [];
  const mooreAgg = Object.fromEntries(KEYS.map(k => [k, []]));
  for (const tr of bundle.moore) {
    const rs = scoredReads(tr.wins);
    for (const k of KEYS) if (rs.stats[k].medErr != null) mooreAgg[k].push(rs.stats[k]);
    mooreRows.push(`${tr.tag} (tgt ${tr.tgt}) n=${rs.stats.yin.n}  ${KEYS.map(k => `${k}=${fmt(rs.stats[k].medErr)}/${fmt(rs.stats[k].maxErr, 1)}/${pct(rs.stats[k].within1)}(nulls ${rs.nulled[k]})`).join('  ')}`);
  }
  const mooreAggStats = Object.fromEntries(KEYS.map(k => {
    const s = mooreAgg[k];
    const medErr = s.length ? s.map(x => x.medErr).sort((a, b) => a - b)[Math.floor(s.length / 2)] : null;
    const w1 = s.length ? s.reduce((a, b) => a + b.within1, 0) / s.length : null;
    return [k, { trials: s.length, medErr, within1: w1 }];  }));
  report.datasets['moore'] = { perTrial: mooreRows, aggregate: mooreAggStats };

  // ---------- fixtures ----------
  const fixtureRows = [];
  for (const [name, fx] of Object.entries(bundle.fixtures)) {
    for (const w of fx.wins) w.truth = fx.truth;
    const rs = scoredReads(fx.wins);
    fixtureRows.push(`${name} (truth ${fx.truth}) n=${rs.stats.yin.n}  ${KEYS.map(k => `${k}=${fmt(rs.stats[k].medErr)}/${fmt(rs.stats[k].maxErr, 1)}/${pct(rs.stats[k].within1)}(nulls ${rs.nulled[k]})`).join('  ')}`);
  }
  report.datasets['fixtures'] = { rows: fixtureRows };

  // ---------- headline print ----------
  console.log('== maria-real 5-115s (harmonic case; per-window GPS truth, 10s/5s) ==');
  console.log('estimator\tmedErr\tmaxErr\t%±1\treads');
  const A2 = rsA.stats;
  for (const k of KEYS) {
    const nm = { yin: 'YIN', anf: 'ANF', gh: 'GoertzelHarmo', base: 'BASELINE(deployed)' }[k];
    console.log([nm, fmt(A2[k].medErr), fmt(A2[k].maxErr, 1), pct(A2[k].within1), `${A2[k].n - rsA.nulled[k]}/${A2[k].n + rsA.nulled[k]} reads`].join('\t'));
  }
  console.log('\n== maria-real 120-330s (weak secondary: reading distribution) ==');
  console.log('estimator\treads\tp50\tp90\tmin..max');
  for (const k of KEYS) {
    const nm = { yin: 'YIN', anf: 'ANF', gh: 'GoertzelHarmo', base: 'BASELINE(deployed)' }[k];
    const d = report.datasets['maria-B 120-330s'].readDist[k];
    console.log([nm, d.n, fmt(d.p50, 1), fmt(d.p90, 1), `${fmt(d.min, 1)}..${fmt(d.max, 1)}`].join('\t'));
  }
  console.log('\n== Moore per trial (medErr/maxErr/%±1/reads) ==');
  mooreRows.forEach(r => console.log(r));
  console.log('\n== Moore aggregate ==');
  console.log('estimator\ttrials\tmedErr\t%±1');
  for (const k of KEYS) {
    const nm = { yin: 'YIN', anf: 'ANF', gh: 'GoertzelHarmo', base: 'BASELINE(deployed)' }[k];
    console.log([nm, mooreAggStats[k].trials, fmt(mooreAggStats[k].medErr), pct(mooreAggStats[k].within1)].join('\t'));
  }
  console.log('\n== fixtures sanity ==');
  fixtureRows.forEach(r => console.log(r));

  fs.writeFileSync('/tmp/bench_report.json', JSON.stringify(report, null, 1));
  console.log('\n(full report -> /tmp/bench_report.json)');
}

if (require.main === module) main();
module.exports = { runEstimators, scoredReads, stats };
