# Gesture e2e checks

Playwright checks for the gesture scheme defined in
[`docs/design/gestures.md`](../../docs/design/gestures.md). They drive **real
Chrome** (via `channel: 'chrome'`, no browser download) and dispatch synthetic
pointer/touch/mouse events at terminal cells.

- `gestures.e2e.mjs` — **touch** (mobile context): long-press select, drag-adjust,
  tap-dismiss, scroll, pinch/zoom, two-finger pan, double-tap zoom, tap
  click-through cell mapping.
- `dex.e2e.mjs` — **Samsung DeX** (desktop context, mouse + keyboard): keyboard
  input, Copy-bar on selection, mouse click cell mapping, Ctrl+wheel zoom,
  middle-drag pan. Real mouse-drag→selection is xterm-native and not asserted
  (Playwright's synthetic mouse can't reliably drive xterm's SelectionService).

`./run.sh` runs both.

## Run

```bash
./run.sh              # build frontend, start throwaway server, test, teardown
SKIP_BUILD=1 ./run.sh # skip the rebuild if static/ is already current
```

Or against an already-running instance (must be built with the `?e2e` hook):

```bash
PTN_URL='http://127.0.0.1:9444/?e2e=1' node gestures.e2e.mjs
```

## How it works

- `run.sh` starts `ptn --no-tunnel` with `ptn-e2e.yaml` (no password, port 9455),
  waits for it, runs the checks, then kills the server.
- The served build must include the **`?e2e`-gated test hook** in
  `frontend/src/main.ts` — it exposes `window.__ptn` (active terminal, selection
  bar state, and `enterFixedGrid` to exercise the zellij fixed-grid path). The
  hook is inert on normal loads.
- Playwright is resolved from `node_modules` (`npm install` here) or, failing
  that, linked from the npm `_npx` cache automatically.

## Coverage & limits

Covers: long-press-selects-word, action bar + handles, drag-adjust, tap-dismiss,
1-finger scroll, pinch font-size (reflow), double-tap no-op (reflow), and in a
forced fixed grid: double-tap zoom 1↔2 and two-finger pan.

These are **synthetic events**, not a physical device, and fixed-grid mode is
forced via the test hook rather than a real zellij size-lock. The gesture
*logic* is verified; on-device feel (momentum, handle ergonomics, iOS quirks)
still needs a hands-on pass.
