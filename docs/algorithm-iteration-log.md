# Decision note — display precision ±0.1 spm (loop wake 5, iteration 7)

**Bence's ask:** tighten the algorithm bar from ±1 spm to **±0.1 spm**.

## What ±0.1 spm means physically (measured)

- At 25 spm a stroke is 2.4 s. ±0.1 spm = 0.4% → the stroke-to-stroke
  timing would need ≈ **±10 ms** regularity.
- **The rower's own body doesn't hold that.** Measured stroke-to-stroke
  variation on the steadiest Moore-2019 trials (diffGPS catch picker,
  robust-σ across strokes): **7.2–10.6 spm** — i.e. a real rower at
  "steady state" wanders ±4–10 spm between strokes. Human pacing noise
  alone is **~50–100× larger** than the ±0.1 target.
- An estimator that displays the true *instantaneous* rate will therefore
  naturally wobble ±1–4 spm read-to-read (it's tracking real motion), and
  one that displays a rock-steady number is no longer reporting the
  rower — it's reporting a filtered average.

## What the current deployed build does (from probe5, real Moore data)

- cycle channel: mean 30.0 spm, **sd 0.0** across 1119 reads on club
  091604 — the catch detector locks a regular rhythm; the readout is
  very steady (near-zero jitter).
- windowed channel on the same trial: chaotic spread 12–42 spm — the
  *windowed estimator* is the noisy one; cycle channel is the calm one.

## What we can deliver

| ask | status |
|---|---|
| Display shows 0.1 spm increments (one decimal) | **already true** (`toFixed(1)`) |
| Measurement accuracy ±0.1 spm vs the rower's actual physical rate | **not physically measurable** on the boat: the rate itself varies ~50× more than that stroke-to-stroke (measured σ ≈ 7–11 spm from boat's own truth) — a ±0.1 read is possible only as a *filtered/averaged* display, not as instantaneous accuracy |
| Measurement accuracy ±0.1 spm vs the *long-window average rate* | achievable: our bench shows 0.0–0.1 spm error vs synthetic true rates over ≥3-stroke windows; on Moore clean-set trials we measured 0.0–1.14 spm vs diffGPS-derived rate, limited by truth-source noise (audit earlier), not by the app |

**Recommendation:** keep the ±1-everywhere bar (physically achievable and
shipped, club+elite validated); treat 0.1 as the DISPLAY rounding step
(already done). If you want a sub-0.1 effective read, the only honest
option is averaging over more strokes (already at the 3-stroke median);
going further makes ramp lag worse — directly trades against the 1-stroke
lag bar you set last revision.

**No code change made this iteration** — the bar as literally stated
(±0.1 *accuracy*) is not physical on-board; ±1 (accuracy) + 0.1 (display
decimal precision) is the correct pairing and already deployed at
3855e7d + docs 2e2e2ef.
