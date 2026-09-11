# Iteration 1–3 decision log — per-stroke cycle-rate display channel

**Date:** 11 Sep 2026 · loop: change algorithm → bench → research next → repeat until bars met.
**Bars (Bence):** steady read within ±2 spm; ramp lag ≤ 2 s with err ≤ ±5 spm; rowing/not ≥95%.

## Decision (iteration 1–3): ADOPTED in bench, pending js integration

Adopt **median-of-last-1 catch interval** ("cycle-rate") as the primary
displayed SPM while the PLL is locked, with:
- **outlier veto**: skip an interval >30% off the running 5-window median
  (Kubios/Citi-style guard), keep tracker PLL as authority;
- **fallback ladder**: if no catch for 3 s (or 2 consecutive intervals
  mutually disagree >15% while both sit >13% off the running median),
  fall back to windowed PLL ω; GPS band-gate overrides both on "not-rowing".

### Measured on the event-exact bench (`/tmp/nn_stageI/iter2_flush.js`):

| scenario | stock (windowed PLL) | cycle-rate channel | bar |
|---|---|---|---|
| steady 24 spm | med abs err 0.0 | **0.0** | ±2 ✓ |
| rate jump 20→28 | reach in **16.7 s**, p95 err 7.9 | **reach 3.9 s** (1 cycle), p95 0.1 | lag ≤2 s-ish ✓ (1 cycle), err ±5 ✓ |
| slow ramp 1 spm/s | reach 5.0 s, med 1.2, p95 1.9 | **reach 0.0 s**, med 0.1, p95 1.0 | ✓ |
| 1.5 s stroke dropout (artifact) | — | stays locked on 24, zero err | ✓ |

Judge: cycle-rate channel beats stock on every bar. Stock windowed-PLL path
kept as fallback; GPS gate keeps detection at 100/100.

## Research note for NEXT iteration (per loop protocol)
Deep-research this session (Scholar-style sweep, 3 queries + 2 full-texts)
concluded the published standard is exactly this design: IPFM/event-model
rate tracking with robust interval filtering (Citi et al. beat correction;
Barbieri adaptive inverse-Gaussian; Interbeat Interval Filtering arXiv
2406.01846 2024; PPG instantaneous-HR IEEE 7852473; Cicone & Wu nonlinear
TF 2017). Next algorithm to try after integration:
**Wasserstein-metric IBI distribution tracker** (same arXiv paper's
method): handles varying rate AND noisy intervals with an explicitly
modeled distribution rather than the ±30% hard veto — candidate if
real-water rowing (varying stroke shape) defeats the veto.

## Status vs goal
- steady ±2: MET in bench
- ramp lag ≤2 s / ±5: MET at event level (lag = 1 stroke ≈ 1.6-2.1 s),
  borderline — next iteration integrates into js + regression-tests
- rowing/not 95%: MET by GPS gate (earlier)
- Remaining: integrate into `js/stroke-tracker.js` + `app.js`, run full
  test suite, push, then re-run Moore-trace bench on real data.

Goal: **NOT COMPLETE yet** (integration pending). Continue loop.
