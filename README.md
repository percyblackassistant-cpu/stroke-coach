# Stroke Coach

A free, open-source stroke coach for rowers that runs entirely in the browser — no app install, no account, no sensors beyond the phone already mounted in your boat.

**Live app:** https://percyblackassistant-cpu.github.io/stroke-coach/ (once deployed)

## What it does (v0)

- **Speed** from GPS (km/h + pace per 500 m)
- **Stroke rate (SPM)** from the accelerometer — peak detection on boat acceleration
- **Distance & elapsed time** per session
- **Session history** stored on-device (localStorage), raw CSV export for algorithm development

## Why a web app

- Works on iOS and Android with nothing to install (Add to Home Screen for fullscreen)
- iOS requires a one-time permission tap for motion sensors (handled on START)
- Deployed as a static GitHub Page — free hosting, no backend, no data leaves the phone

## Development

```bash
# run tests (Node >= 18)
node --test tests/

# serve locally (needed for sensor APIs — they require HTTPS or localhost)
python3 -m http.server 8000
# open http://localhost:8000
```

## Project layout

- `js/stroke-detector.js` — pure signal-processing, no DOM (shared by app + tests)
- `js/app.js` — UI, sensor capture, session storage
- `tests/` — Node test-runner suite with synthetic stroke signals
- `algorithms/` — research notes & next-gen algorithm work (Phase 2)

## Roadmap

1. **v0 (now):** capture + basic peak-counting SPM, GPS speed, session history
2. **Phase 2:** deeper algorithm research (sensor fusion, adaptive filtering), validated against public rowing datasets
3. **Phase 3:** UI A/B testing with real rowers; rhythm/parity metrics

## Privacy

All data stays on your phone unless you explicitly export a CSV. No analytics, no tracking, no backend.
