# Martingale Extension

A Chrome extension (Manifest V3) providing a **floating dashboard** to operate a Martingale-style progression on any web application: real-time tracking of a live counter, round-by-round automation, session statistics, and a zoomable chart.

> Educational / research purpose — demonstrates extension architecture for state-driven automation, SPA DOM tracking, and real-time data visualization.

## Tech stack

| Component | Technology |
|---|---|
| Platform | Chrome Extension Manifest V3 (content scripts + service worker) |
| Language | Vanilla JavaScript (ES2020), **no build step, no dependencies** |
| DOM tracker | Polling + MutationObserver, SPA re-attach resilient |
| RNG | `crypto.getRandomValues` — cryptographic entropy, never `Math.random` |
| Storage | `chrome.storage` shimmed to `localStorage` for test environments |
| Chart | Hand-written Canvas 2D, zoom (wheel) + pan (drag) |
| Shortcuts | `chrome.commands` forwarded by the service worker |
| Dev | Mock page (`dev/mock.html`) simulating a target app + verification bridge — serve with `python3 -m http.server` |

## Features

- Floating dashboard: enter the base level, Start / Pause / Resume / Reset
- Progression rules: success → reset to base level, failure → double the level; automatic stop when the tracked value falls to 30% of the baseline or cannot cover the next level
- Safeguards: 2-decimal precision, sufficiency check before every round, duplicate-result protection via fingerprinting, reload survival (session restore + pending-round reconciliation)
- Statistics: rounds / successes / failures / longest streak, CSV export, tracked-value-over-time chart
- Dashboard collapse shortcut (configurable in `chrome://extensions/shortcuts`)
- Background running: silent-audio keepalive + service-worker tick pulse keep the round cadence stable while the tab is hidden

## Structure

```
manifest.json          MV3 declaration, content scripts, commands
background.js          service worker: shortcut forwarding + 30s tick pulse
content/
  rng.js               cryptographic randomness source
  storage.js           session persistence / restore
  dom.js               DOM tracker + page UI reader/writer
  cf-watch.js          page availability / blocking detection
  stats.js             progression math (pure, testable)
  engine.js            session state machine
  chart.js             canvas chart
  ui.js                floating dashboard
  main.js              bootstrap, module wiring
dev/
  mock.html/.css       mock target app for testing without a real site
  mock-bridge.js       mock ↔ dashboard bridge
```

## Getting started

1. Edit `manifest.json`: replace `https://example.com/*` with the domain of your target application.
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
3. Open the target app, click 🎲 on the dashboard, enter the base level → Start.
4. Or run the mock page: `python3 -m http.server 8088` in the repo folder → open `http://localhost:8088/dev/mock.html`.

## Default shortcut

- macOS: `Cmd+Shift+X` — Windows/Linux: `Alt+Shift+X` (configurable in `chrome://extensions/shortcuts`)

## License

MIT
