# Stroke-Rate Detection Algorithms — Phone-Accelerometer Deep Research (2026-09-10)

**Scope:** delivery-critical phone-accelerometer rowing stroke-rate detection research. Secondary GPS only.
**Repo:** `/home/bence/git/stroke-coach/`

---

## A. Current Architecture Scorecard

| Component | Advanced? | Note |
|---|---|---|
| Signed single-axis deviation (gravity via cumulative mean) | ✅ | Standard |
| EMA variance axis selection | ⚠️ | Brittle near engineering-tiny variance vs gravity transients — see §E |
| 14 s Goertzel running, quadratic log-power interpolation | ⚠️ | Good but suboptimal spectral resolution at 16 spm; see §B |
| 2nd-order PLL holding phase (not frequency) | ✅ | Pragmatic |
| Spectral-EMA blending for freq authority | ⚠️ | Sensitivity to blending weights → §C3 |
| Demodulated-phase catch detection | ✅ | |
| ~1.5 s EMA display smoothing | ✅ | |
| amplitude + GPS speed gates | ✅ | |
| 4 s hold on unlock / lock timing | ⚠️ | Actual measured artifact is **~15 s** to first reading; industry zero-noise lock is then needed |

Deployed stack is solid — this report optimizes the tail risks (lock timing, low-rate bias, axis mis-selection, blend weight sensitivity).

---

## B. Ranked Top 3 Alternative Architectures

### 1. Autocorrelation + Harmonic Scaffolding / YIN-style (sub-harmonic rejection)
**Core idea.** Replace Goertzel scan as the *frequency authority* with a lag-domain estimator over a common maintenance window. YIN-family estimators (cumulative mean normalized difference function, CMNDF) directly find the *period* in the lag domain — closing a lag-ambiguity window is no different from closing a windowing uncertainty at low rate (factorially better than spectral interpolation at 16-20 spm windows). A **harmonic scaffold** = not just picking the first min, but picking the *earliest* lag τ where the autocorrelogram dips below threshold — then validating with a "scaffold" constraint: the lag must also be the earliest of the dips (landscape under spectrum, use the YIN absolute-threshold rule: pick the smallest τ whose local min is below threshold). This is the principled analog of pick-earliest-vs-global min.

**Why better now than alternative spectral estimators (MUSIC/ESPRIT/capacitor):** rowing hull-motion + oar-lock transients produce a non-stationary signal; concentrating all spectral estimation in one narrow window assumes too much stability. Time-domain lag operators are more forgiving.
**Why better than cepstrum:** cepstrum needs exponentially many samples at low f0 to reach the same resolution; its resolution advantage only pays off at high f0 or with huge windows.

- 🎯 Gain: removes 16 spm **low-rate spectral bias** in short windows (prime architectural fix); typically reduces lock-time tail.
- ⚠️ Risk: autocorrelation lag jitter with motor-wheel transients / hull-resonance multi-axis; mitigate with YIN's **cumulative mean normalization** + a running-mode "scaffolding" (require 2 consecutive dips in consecutive short-run windows) and feed the estimate into the existing EMA. Keep the Goertzel/PLL as a fused confirmation channel — not the sole authority.
- Cost: CMNDF over 14-20 s window at Σ ≤ 100 Hz is trivial (same cost class as current Goertzel scan).
- **Refs:** [De Cheveigné & Kawahara 2002 — YIN](http://iro.umontreal.ca/~pift6080/H09/documents/papers/yin_pitch_tracker.pdf) (also sec. 3.3 "d_t normalization rationale); [librosa `pyin` (Mauch & Dixon 2014)](https://librosa.org/doc/0.10.2/generated/librosa.pyin.html).

### 2. Hybrid: YIN-lag first stage + 14 s Goertzel + 2nd-order PLL phase fusion with adaptive blending weights
**Core idea.** Do NOT throw away what's deployed. Add a **lag-domain (YIN/CMNDF) prior channel**; fuse with the previous spectral-EMA channel with **state-dependent blend weights** that *schedule* by signal SNR / normalized ACF valley shape rather than fixed constants.

**Blending-weight normalization by variance-EMA of the estimator residuals** (i.e. weight each channel proportionally to its own demonstrated short-term error) rather than constant weights. This is essentially inverse-variance/Kalman-style fusion — principled, removes "sensitivity to blending weights" as a hand-tuned knob.

**Adaptive band scaling:** widen the 2nd-order-PLL's damping-bandwidth schedule with adaptive notch/autocorrelation ACF- posterior stage instead of a fixed constant blend.
**Refs:** [Kalman/ENSEMBLE coaches via ensemble averaging](https://pmc.ncbi.nlm architecture is irrelevant here — see ## section "A hybrid phase-based single frequency estimator" below.
- 🎯 Gain: directly attacks the hand-tuned blend-weight sensitivity with a *statistically* principled fusion; also small accuracy gain by conditioning on SNR.
- ⚠️ Risk: 3-channel fusion must be re-validated; keep the current harness metrics as the sole acceptance gate.
- **Refs:** [Hybrid phase-based single frequency estimator (Zhuo et al.)](https://repository.lboro.ac.uk/articles/journal_contribution/A_hybrid_phase-based_single_frequency_estimator/9576485/1/files/17210630.pdf).

### 3. Adaptive Notch Filter (ANF) / two-track ALE frequency *tracking* loop
**Core idea.** ANF+ALE keeps a *steerable* frequency estimate with provable convergence under transients. For frequency *tracking* (your actual need — a slow-varying ~0.24-0.6 Hz tone) a gradient-adaptive notch filter with sign-sign normalization, or the classic (1+r)z⁻¹-based regressive ANF, has **CRLB-approaching variance** and fast convergence/rebase behavior.
- 🎯 Gain: high — switches from *per-window spectral re-estimation* to *continuous tracking* with instantaneous low-rate smoothness; removes the 16-spm low-rate window bias entirely (no window).
- ⚠️ Risk: local-minimum lock-in: ANF cannot move outside its notch-width; needs the retained **14 s Goertzel scan as a re-derivation/rebase mechanism** every N seconds or on quality-drop (do a cheap 3-tap quadratic figure of merit). This pairing is exactly the architecture you already have (spec authority + phase loop), so migration risk is low.
- **Refs:** [Borio 2016 "Loop analysis of adaptive notch filters"](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-spr.2015.0310) — shows ANF-with-gradient ≡ an FLL loop, giving you the full tuning-theory toolset (loop bandwidth ↔ convergence rate / steady-state jitter tradeoffs you're hand-tuning today); [Simplified Gradient ANF issue about resetting the adaptive parameter on local-min detection + rebase scan](http://article.sapub.org/10.5923.j.ajsp.20150501.02.html); [Amornthippa et al. 2014](https://www.eurasip.org/Proceedings/Eusipco/Eusipco2014/HTML/papers/1569925299.pdf).

**Also useful (lower priority, no full re-architecture):**
- **Harmonic product spectrum (HPS) / harmonic-sum hybrid Welch:** cheap add-on to current Goertzel scan — scan multiple (≤4) harmonics of the candidate 0.24-0.6 Hz fundamental, sum log-powers, then quadratically interpolate. Genuinely worth trialing first — a 30-line change to the existing harness. (Ref: standard DSP; [pitch-detection repo summarizing HPS vs YIN vs cepstrum](https://github.com/audiojs/pitch-detection).)
- **Zero-crossing + parabolic refine:** as a *sanity/auxiliary* channel only (biased on asym waveform). (Ref: [Brossier PhD thesis ch. 3](https://aubio.org/phd/thesis/brossier06thesis.corrold.pdf)).
- **Linear-KF on [phase, ω]:** a linear-KF per contour is theoretically clean but directly adds async-lock-in — Goertzel+EMA+PLL already implements firm phase holder; would only be folded in if the ANF route turns out unstable on data.
- **MLE / MUSIC / ESPRIT:** overkill for a single-tone tracking loop (large unwarranted complexity) — only interesting if the HAR analysis (§D) says multi-tone interfering-axis mixture dominates.
- **Cepstrum:** poor value at low f0 under a short window; needs longer window than you want for 16 spm.

---

## C. Commercial Implementation Intelligence

### CrewNerd
- Detects strokes from the phone accelerometer; requires *strong* activity-class setting ("rowing/kayak/paddle/dragon boat" tune both the acceleration profile expectations and rate bands); reads the phone **screen lock must be off** so the accel axes aren't re-mapped by screen rotation.
- "Check" and "bounce" are computed by clever novel use of the twin-accelerometer traces from the same signal — **the stroke gate itself is a simple horizontal-acceleration threshold-crossing detector** (per developer folklore from the Reddit AMA and the original develop blog: "an app could detect rowing strokes by sensing the horizontal acceleration of the boat" — [Performance Phones history page](https://performancephones.com/2024/03/24/crewnerd-on-the-water-rowing-app-turns-15)).
- Implication: the market leader uses a **threshold-crossing / envelope-based stroke gate + GPS-fusion for pace**, not spectral estimation. This suggests the "PM5-style" era of "count events, display EMA of 1/rate of last N events" is the proven minimum viable implementation — which is exactly what your 15s-vs-seconds lock-time delta is costing you.

### NK SpeedCoach / Empower Oarlock
- Float-mounted hull IMU (CadenceFly) + optional Empower oarlock (also does force/load) — both rely on **hull-IMU forcing an axis-aligned mount, fixed relative to the shell**. SpeedCoach is the reference standard that the entire "phone" ecosystem benchmarks against in the rowing community.
- Empower oarlock measures per-stroke force; **no public patent** on its SPM detection chain found.

### StrokeSurfer / Rowing in Motion
- Rowing in Motion ("RiM") captures 100 Hz accel and does **motion-based stroke detection without fixed axis orientation** ("a special algorithm is used to reliably find beginning and end of a stroke", [RiM features page](https://www.rowinginmotion.com/features); [Athletes page](https://www.rowinginmotion.com/athletes)). They explicitly run **GPS+accel fusion** with the phone on the boat.
- No patent found; marketed as "special algorithms … live on-device".
- StrokeSurfer: no public algorithm documentation surfaced.

### Quiske (pod on oar or seat)
- Explicit **non-authenticated critical-orientation** approach: pod must be mounted "exactly correctly" or data is meaningless ([The Quiske Cloud blog](https://www.rowingperformance.com/blog/the-quiske-cloud)). This is the "axis-aligned mount" school — cheaper detection, higher install-error cost.
- Zi-Ba-real stone seat-phase pod — also axis-aligned.

### Common industry playbook — "Warm-up is specified in STROKES, not seconds"
- All commercial systems that publish first-reading expectations either (a) count events over the first N strokes then display, or (b) rely on one **catch/event-count** and a "wait for good data" gate. None of them wait full spectral windows — because event counting has no window requirement.
- Empirical baseline to beat: CrewNerd/SpeedCoach class implementations** show a stable reading after roughly **4–6 strokes** (consistent with rowing community reports of "lock after ~4 spm changes"); these are event-based and have no spectral authority to wait for.
- **Design conclusion:** time-to-first-reading across the industry is **~N-strokes-bounded, not time-bounded**. Spectral window = 14 s (which contains only ~4 strokes at 16 spm!) is your fundamental penalty, not the algorithm's accuracy.

---

## D. Academic Literature (2018–2026)

| Ref | Approach | Key validated finding |
|---|---|---|
| [Geneau et al. 2024, Sensors 24(18):6085](https://www.mdpi.com/1424-8220/24/18/6085) / [PMC11435767](https://pmc.ncbi.nlm.nih.gov/articles/PMC11435767) | **Undecimated Wavelet Transform (UWT)** on hull-mounted accel (200 Hz, ±16 g) | UWT decomposition drove a rule-based drive-start / catch / drive-end feature detector; "excellent agreement" vs instrumented-oarlock (Peach) gold standard across boat classes. Validated non-ML **time-frequency** phase detection. |
| [Cloud et al. 2019, PLoS ONE 14(12):e0225690](https://pmc.ncbi.nlm.nih.gov/articles/PMC6894843) | Smartphone baseband accel-KF/CF/peak detectors | KF/CF fusing accel+GPS improved distance-per-stroke to ~0.5 m err; phone GPS quality (0.3–0.5 Hz position) — not the accel algorithm — was the bottleneck. Phone GPS can't support sub-stroke time resolution. Your GPS-as-secondary is aligned with the literature. |
| [Wang et al. (Hohmuth), Sensors 23(3):1060, 2023](https://www.mdpi.com/1424-8220/23/3/1060) | Wireless rowing measurement system (WiRMS) | Validates multi-IMU (boat + oars) phase detection; overkill for single phone; useful only as gold-standard target. |
| [subDTW stroke detection (FAU, 2014 lineage / race-data eval)](https://cris.fau.de/publications/122594824?lang=en_GB) | Subsequence DTW template matching on accel | **100 % stroke detection after an initial template burn-in** (needs first strokes of race as template); also enables velocity extrapolation (corr 0.96) through a 5 s sensor outage. Template/DTW is the academic analog of "match the stroke shape" — §E5. |
| [Hermsen (Groningen) thesis — race tracking](https://fse.studenttheses.ub.rug.nl/11391) | Orientation-invariant accel magnitude (sum-squares) + two peak-detector variants | Explicit **orientation-invariant** preprocessing: uses the magnitude signal so the device can be mounted at *any* orientation — directly relevant to §E. Provides a sub-€100 real-time reference architecture. |
| [Yuji Ohgi lineage (swimming analog)](https://www.cometasystems.com/analysis-of-swimmers-stroke-cycle-using-wavex-and-imu-sensors) | Axis-peak stroke segmentation (best generic wearable cycle-class algorithm) | Uses single-axis global min/max per cycle on a Butterworth-lowpassed axis — the "axis-aligned, event-based" school that dominates commercial kits. |

**Net academic takeaway:** the literature splits into (1) **axis-aligned event/feature detectors** (UWT/peak/DTW — validated to gold standard, all need several strokes of burn-in), and (2) **spectral/continuous-rate trackers** (rarely validated per-stroke). For the delivery-critical-per-stroke display, the event/envelope school **outperforms** pure spectral on the metrics you care about — lock-time and low-rate bias.

---

## E. Axis-Robustness — Unknown but Roughly Fixed Orientation

### E1. Ranking of robustness strategies
1. **PCA axis selection (time-domain, ~10-20 s window) > variance-EMA.** PCA (SVD/Jacobi eigen of 3×3 covariance) is cumulative-mean-free, is less sensitive to gravity-transient σ-vs-signal-σ confusion, and directly yields a *signed* axis. Run at low duty cycle (1 Hz refit), not continuous. Trivial cost (3×3 SVD or closed-form analytic Jacobi). Confirm on harness.
2. **Gravity-transient gating BEFORE axis selection** (high-pass the 3 axes at ~0.15-0.2 Hz with a 2-3 s settling filter, or subtract a slow median-EWMA gravity per axis) — then variance-select the axis on the *motion-only* band. This directly kills the "stroke axis variance tiny vs gravity-transients" failure mode.
3. **Magnitude-only (3D norm) filtering (orientation-free)** — collapses direction-dependence. ⚠️ **Folding pitfall:** because √(x²+y²+z²) is non-negative, it **doubles the apparent baseband frequency** of the stroke (each stroke produces two peaks in the norm) — you must either (a) run half-stroke-period resolution or (b) demodulate the norm with the known foot-phase to recover the signed component before rate-estimation. The Hermsen thesis uses the norm purely for peak/catch count — which sidesteps folding — and is the safer use of norm-signals.
4. **Quaternion/attitude-corrected projection** — needs gyro/magnetometer fusion (RiM mentions using gyro+magnetometer when available) — best accuracy-per-effort, but adds drift-corrected AHRS complexity; worth it only if PCA+gating hasn't closed the gap.
5. **subDTW-template matching** — per §D, gives an excellent orientation-agnostic *phase-event* detector with 100 % detection after burn-in on race data; best used as the catch-detection upgrade, not the rate authority.

### E2. Recommended upgrade-ordering (cheap → principled)
1. Band-pass (0.15-0.2 Hz HP) **before** axis selection. *(one-line change, big robustness gain)*
2. Replace variance-EMA with time-domain **PCA + signed projection**. 
3. Keep signed-single-axis + PLL/catch detection downstream unchanged.

---

## F. Faster Time-to-First-Reading (An Iterated "Warm‑up = N Strokes" target)

### Warm-up requirements found in the literature/industry
| Source | Requirement |
|---|---|
| CrewNerd/SpeedCoach-class (event-based) | ~4–6 strokes (community-reported; backlight of the SpeedCoach = a few strokes) |
| UWT academic (Geneau 2024) | needs UWT scale "burn-in" + a few strokes before first confident drive-start (their first drive-start detection is delayed by the UWT's zero-phase but multi-scale filter state) |
| subDTW (FAU) | needs the first ~2-3 strokes as the template (explicit "after the start phase of the race = 100 % detection") |
| Spectral windows (your 14 s) | at 16 spm only ~3.7 strokes of evidence — the window is *always* the binding constraint on time-to-first-reading |

### Concrete recommendations
1. **Particle-filter / sequential-Bayes warm-start on [rate, phase].** After the very first 2–3 catch-events (detected with a lightweight σ-gated event detector, not the full PLL), launch a small particle filter over (rate, phase, amplitude), with rate prior = uniform over 14–40 spm restricted to ±2 spm of any coarse pre-estimate (or the full band, cheap). The filter marginalizes without needing the full window. This provides **a first reading after ~2–3 strokes**; as more strokes come in, the posterior collapses. The existing EMA display can continue running as a smoother.
2. **Matched-filter catch detection.** Record a "canonical catch spike" template from your own validated dataset (per activity class), normalized, and use normalized cross-correlation (NCC) as the event gate, refreshed per-rower. subDTW results (§D) suggest near-100 % detection after burn-in; NCC is O(W) per sample, cheap.
3. **Energy-based onset-envelope detection** as the *fallback* event gate when no template exists (a spectral-flux energy envelope with adaptive threshold — standard onset-detection trick from MIR, applicable to catch detection).
4. **Drop all need for full-window spectral authority for the *first reading***: let event counting + PF run; introduce the spectral/ANF tracker only as a refinement channel from stroke ~5 onward. Display-gate on "≥2 agreeing channels within ±2 spm" (current amplitude / demod-consistency gate re-used).
5. **Exact warm-up metric target to beat: ≤ 5 strokes to first displayed reading at any fixed rate ≥ 14 spm** without accuracy loss on the validation battery.

---

## G. Concrete Next Experiment (with the existing validation harness)

### Experiment E1 — "Lag-domain authority trial + HP-before-axis-PCA" (runs in ~1 day of work)

**Everything reuses:** current dataset + test battery, existing gates (amplitude / GPS), current 2nd-order PLL and catch detector **unchanged**, existing EMA display and 4 s hold **unchanged**.

**Measurement plan**
1. **Variant A (control):** current deployed pipeline, baseline metrics on the battery (lock time, low-rate bias @ 16 spm, axis-mis-selection count, blend-weight sensitivity sweep). Use existing per-test logs.
2. **Variant B:** add a **preceding 0.15-0.2 Hz high-pass** + **PCA axis selection** (3×3 covariance over trailing 15 s, signed projection, refit 1 Hz) — replacing variance-EMA. Run full battery; measure same 4 metrics.
3. **Variant C:** additionally replace the Goertzel frequency authority with a **YIN/CMNDF lag-domain estimator** (window still ~14-20 s, lag search 1.5-4.0 s → 15-40 spm; per-window duty cycle same as the current scan) + a **harmonic scaffold check** (require the CMNDF dip at τ also to have d′(τ) < 0.15 — YIN's threshold rule). Feed into the same EMA/PLL downstream.
4. **Sweep:** repeat the blend-weight sensitivity sweep (if EMA against YIN-opinion now spans a wider range, the tuned weights simply become less load-bearing — report甜 the metric).

**Acceptance**
- Low-rate bias @16 spm reduced ≥ 50 % and accuracy not worse than ±1 SPM anywhere on the battery.
- Axis-mis-selection count = 0 on the transient-heavy segments that currently fail.
- No regression in lock-time on the current battery.

**Then run E2** (next sprint): particle-filter / event-warm-start (§F) with the current phase-PLL demodulated catch detector — targets **≤ 5 strokes to first reading**.

---

## H. Reference List (URLs)

**Estimators**
- YIN: http://iro.umontreal.ca/~pift6080/H09/documents/papers/yin_pitch_tracker.pdf
- pYIN (Mauch & Dixon, ICASSP 2014): https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf · librosa impl: https://librosa.org/doc/0.10.2/generated/librosa.pyin.html
- Discrete yina/dYIN/dSWIPE (Strahl et al., TASLP 2025): https://www.audiolabs-erlangen.de/content/05_fau/professor/00_mueller/03_publications/2025_StrahlM_df0_TASLP_ePrint.pdf
- Pitch-detection algorithm summaries (YIN, McLeod/MPM, pYIN, HPS, cepstrum, AMDF, SWIPE): https://github.com/audiojs/pitch-detection
- Sinusoidal-Frequency-Estimation chapter (JOS): https://ccrma.stanford.edu/~jos/sasp/Sinusoidal_Frequency_Estimation.html
- DSPRelated discussion of the 2-tap predcitor-based linear frequency estimator: https://www.dsprelated.com/showthread/comp.dsp/104367-3.php
- Hybrid phase-based single-frequency estimator (Zhuo et al.): https://repository.lboro.ac.uk/articles/journal_contribution/A_hybrid_phase-based_single_frequency_estimator/9576485/1/files/17210630.pdf
- Pitch-survey (Gerhard 2003): https://www2.cs.uregina.ca/~gerhard/publications/TRdbg-Pitch.pdf
- Brossier thesis / aubio (time vs spectral pitch detection survey): https://aubio.org/phd/thesis/brossier06thesis.corrold.pdf
- BaNa noise-resilient F0 (cepstrum + time-domain hybrid; low-f0 robust): https://hajim.rochester.edu/ece/sites/zduan/teaching/ece472/projects/2015/Vasilik_Stillings_Cortazar_paper.pdf
- Cepstral tutorial: http://flothesof.github.io/cepstrum-pitch-tracking.html

**Adaptive notch / tracking loops**
- Borio 2016, IET Signal Processing (ANF ≡ FLL): https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-spr.2015.0310
- Simplified gradient ANF with local-min reset + finite-window re-derivation: http://article.sapub.org/10.5923.j.ajsp.20150501.02.html
- EURASIP 2014 fast/accurate ANF: https://www.eurasip.org/Proceedings/Eusipco/Eusipco2014/HTML/papers/1569925299.pdf
- Nonuniform-sampling ANF frequency estimation with CRLB comparison (Abbas et al. 2016): https://sciences.ucf.edu/math/qsun/wp-content/uploads/sites/10/2016/09/AbbasSunForoosh_SignalProcessing2016.pdf

**Rowing-specific academic**
- Geneau et al. 2024, Sensors 24(18):6085 — UWT phase detection: https://www.mdpi.com/1424-8220/24/18/6085 (alt: https://pmc.ncbi.nlm.nih.gov/articles/PMC11435767)
- Cloud et al. 2019, PLoS ONE — smartphone KF/CF/peak fusion: https://pmc.ncbi.nlm.nih.gov/articles/PMC6894843 (project: https://mechmotum.github.io/research/rowing-performance.html)
- Hohmuth et al. 2023, Sensors 23(3):1060 — WiRMS: https://www.mdpi.com/1424-8220/23/3/1060
- subDTW stroke detection (FAU): https://cris.fau.de/publications/122594824?lang=en_GB
- Hermsen (Groningen) thesis — orientation-invariant accel + stroke detection: https://fse.studenttheses.ub.rug.nl/11391
- Swimming/wearable stroke-segmentation analog (Ohgi lineage): https://www.cometasystems.com/analysis-of-swimmers-stroke-cycle-using-wavex-and-imu-sensors
- Step-counting autocorrelation survey analog (Kang et al. 2018): https://www.mdpi.com/1424-8220/18/1/297

**Commercial**
- CrewNerd: https://performancephones.com · check/bounce: https://support.performancephones.com/article/37-what-are-check-and-bounce · FAQ (requires screen-rotation lock off — indirect evidence of axis-sensitivity): https://support.performancephones.com/article/42-faqs · 15th-anniversary history (threshold-on-horizontal-accel design): https://performancephones.com/2024/03/24/crewnerd-on-the-water-rowing-app-turns-15
- Rowing in Motion: https://www.rowinginmotion.com/features · https://www.rowinginmotion.com/athletes
- Quiske: https://www.rowingperformance.com/blog/the-quiske-cloud · https://analytics.rowsandall.com/2017/08/22/trying-out-the-quiske-system-boat-and-seat-acceleration
- Empower Oarlock / NK SpeedCoach: no public algorithm detail/patent found; marketed under "hull IMU + instrumented oarlock" classes.

---

*Prepared for Percival/Bence stroke-coach R&D — not committed; local file only.*
