# Touch Gesture Scheme (Mobile)

## 1. Executive Summary

This document defines the complete touch-gesture vocabulary for Porterminal on a
phone, replacing the ad-hoc mapping that grew inside
`frontend/src/gestures/GestureRecognizer.ts`. The redesign is driven by the four
things actually done on the phone, in order of pain: **selecting/copying text**,
**scrolling output**, **switching zellij tabs/panes**, and **zooming + panning to
read**.

The guiding principle is **clean separation by contact count**:

```
1 finger  →  interact & scroll   (tap, long-press select, drag = scroll)
2 fingers →  move the camera      (drag = pan, pinch = zoom)
```

No gesture is overloaded on context (the old "one-finger-drag pans when zoomed,
scrolls otherwise" ambiguity is gone), and every finger count means one thing.

### Design Philosophy: One Hand, Two Modes

A phone is held in one hand, so the practical budget is **1- and 2-finger**
gestures only; 3-finger is a tablet-only stretch and partly OS-reserved. Beyond
that, Porterminal already runs in two distinct layout modes and gestures respect
them:

| Mode | When | Mental model |
|------|------|--------------|
| **Fixed-grid** | Inside zellij (a native client pins the logical grid; see `docs/design/multi-client-sessions.md` and `terminal/TerminalLayout.ts`) | A large canvas you **zoom + pan** around |
| **Reflow** | Plain shell, Porterminal owns the size | Content fits the width; **scroll** is king, pan is meaningless |

---

## 2. Gesture Map

| Gesture | Fixed-grid (zellij) | Reflow (plain shell) |
|---|---|---|
| **Single tap** | Click-through to the app: switch zellij tab, focus pane, position cursor | Focus / click-through (when mouse mode on) |
| **Double tap** | **Zoom toggle at point** — zoom in ~2× centered on the tapped cell; tap again snaps back to fit. Doubles as "reset zoom". | No-op (nothing to zoom into) |
| **Long-press (250 ms)** | Select the **word** under the finger → selection UI appears (§3) | Same |
| **1-finger drag** | **Scroll** the pane under the finger (wheel events → zellij) | **Scroll** (with momentum) |
| **1-finger flick** | Momentum scroll | Momentum scroll |
| **2-finger drag** | **Pan** the zoomed canvas (no-op at zoom 1×) | Falls back to scroll (nothing to pan) |
| **Pinch / spread** | **Zoom** the fixed grid, cursor-anchored (1×–4×) | **Font size** (10–24 px) |

### Reserved / unused (intentionally free)

`2-finger tap`, `2-finger double-tap`, `2-finger long-press`, and horizontal
1-finger swipe are **unassigned**. They are kept free rather than invented uses;
new actions land here first.

---

## 3. Selection & Copy Flow (WhatsApp-style)

Selecting-then-copying is the top task, so it gets a first-class, messaging-app
feel instead of a transient floating button.

1. **Long-press** → the word under the finger highlights immediately (no drag
   required to get a usable selection).
2. **Draggable handles** appear at both ends of the selection — a ~14 px dot
   with a ~44 px touch target, each snapping to the nearest cell. Dragging
   either handle grows/shrinks the range, including across lines.

   While a selection is active, **1-finger drag adjusts the nearest handle and
   scroll is paused** — the selection is screen-only, so there is no cross-screen
   tracking and no repaint-drift in zellij. To grab off-screen text: dismiss,
   scroll to it, then re-select. **2-finger pan stays enabled**; panning only
   moves the camera and the handles ride along with their cells.
3. A **top action bar** slides in below Porterminal's own tab bar:

   ```
   ┌────────────────────────────────┐
   │  Copy    Paste    Select-all  ✕ │
   └────────────────────────────────┘
   ```

   It is anchored to the top (never hides under the finger) and persists until
   the user acts.
4. **Copy** → copies + flashes "Copied", then dismisses. **✕** or a tap outside
   the selection → dismiss and clear.

### Action semantics (defaults)

- **Copy** — `terminal.getSelection()` → clipboard (existing `ClipboardManager`,
  with the iOS `execCommand` fallback).
- **Paste** — write the clipboard to the PTY at the cursor as a bracketed paste.
  (Also available on the keyboard toolbar.)
- **Select-all** — the visible screen.
- **✕ / tap-outside** — `clearSelection()` and hide the bar.

---

## 4. What Changes From Today

Current behavior lives in `GestureRecognizer.ts` / `SwipeDetector.ts` /
`CopyButton.ts`. The redesign:

**Removed**
- Horizontal 1-finger swipe → arrow keys (`SwipeDetector` usage in `pointerup`).
  Arrows remain on the keyboard toolbar.
- One-finger-drag-pans-when-zoomed (`isPanning`/`canPan` path). Pan is now
  unambiguously 2-finger.
- 2-finger drag → scroll. It becomes **pan**.
- Double-tap → select word. Word-select moves to **long-press**; double-tap
  becomes **zoom toggle**.
- Single floating `CopyButton`. Replaced by the persistent top action bar.

**Added**
- Long-press grabs the word immediately (today it only sets an anchor).
- Draggable selection handles.
- Top `SelectionBar` UI component (Copy / Paste / Select-all / ✕).
- Double-tap zoom toggle (fit ↔ ~2× at point), fixed-grid only.

**Unchanged**
- Single-tap click-through (already coordinate-maps through the fixed-grid CSS
  transform via `tapTerminal`).
- Pinch zoom mechanics (`setFixedGridView` / `commitFixedGridView`, font-size
  path in reflow).
- Momentum scroll physics.

---

## 5. Implementation Plan & Sizing

**Status: implemented** (all five steps) and verified with a Playwright gesture
harness driving real Chrome against a running server — 16/16 checks passing:
long-press-selects-word, bar appears/persists, drag-adjust extends, tap dismisses
+ clears, pinch changes font (reflow), double-tap no-op (reflow), and in a
forced fixed grid: double-tap zoom 1→2→1, two-finger pan, and tap click-through
mapping to the correct cell. The old floating copy button, swipe-to-arrows, and
selection auto-copy were removed.

**Fixed-grid tap-through fix (touch + mouse / Samsung DeX):** xterm decodes
pointer coordinates with its unscaled cell size, ignoring any CSS scale on
`term.element`. The fixed-grid renderer used to leave a residual CSS scale
(≈ the fill-scale, ~1.05–1.1) even at zoom 1, so a click/tap reported
`visualCell × scale` and hit the wrong cell — e.g. the wrong Zellij tab.
Fixed at the source: `applyCrispScale` (TerminalLayout) now bakes the *full*
visual scale (fill × zoom) into the font, so the element carries only a translate
(scale ≈ 1) and xterm's native coordinate math is correct for **both** touch and
mouse. The mouse path matters on **Samsung DeX** (external display + mouse/
keyboard): the gesture layer ignores `pointerType === 'mouse'`, so DeX relies on
xterm's native mouse handling, which the residual scale used to break. Only
extreme zoom (font hits the cap) leaves a residual scale; `tapTerminal` still
inverts it as a touch-only safety net. Regression-covered by the e2e "tap
click-through maps to the correct cell" check; DeX mouse mapping verified
separately (native clicks map exactly at zoom 1).

**DeX / mouse support (implemented):** on Samsung DeX the input is mouse +
physical keyboard, so the gesture layer (which ignores `pointerType === 'mouse'`)
falls back to xterm's native handling. Added:
- **Copy bar on mouse selection** — `TabService` forwards xterm's
  `onSelectionChange`; `main.ts` shows the SelectionBar when a selection exists
  and no touch gesture is active (touch keeps its own long-press flow). Real
  mouse-drag → xterm selection is xterm-native.
- **Ctrl/Cmd + wheel → zoom** the fixed grid, anchored at the pointer, with a
  debounced crisp re-render (GestureRecognizer `wheel` handler).
- **Middle-button drag → pan** the zoomed fixed grid (GestureRecognizer mouse
  branch; middle-click autoscroll suppressed while a zoomed grid can pan).

Verified by `frontend/e2e/dex.e2e.mjs` (mouse click cell mapping, Copy-bar
wiring, Ctrl+wheel zoom in/out, middle-drag pan) — 10/10, alongside the 16/16
touch suite.

**Still not addressed:** in a Zellij session with mouse tracking on, a mouse drag
goes to Zellij (not xterm), so the browser Copy bar only applies to plain-shell /
non-mouse-tracking selection; use Zellij's own copy mode inside Zellij.

Ordered by dependency; each item is independently shippable.

1. **Gesture model rework** — *small*. In `GestureRecognizer.ts`: drop the swipe
   → arrow branch, remove the 1-finger pan path, switch the 2-finger `scroll`
   branch to call `panFixedGridView`, and gate double-tap to the zoom toggle.
2. **Long-press grabs word** — *small*. On long-press fire `selectWordAt` at the
   press point instead of only anchoring; drag still extends.
3. **Top action bar (`SelectionBar`)** — *medium*. New UI component + wiring;
   `SelectionHandler` already exposes word + range + get/clear.
4. **Draggable handles** — *large, the bulk of the work*. New handle elements,
   cell↔pixel mapping through the fixed-grid transform (reuse
   `SelectionHandler.touchToPosition` inverse), and repositioning on
   zoom / pan / resize. Scroll is paused during selection, so no scroll-tracking
   or edge-auto-scroll is needed — the selection lives entirely on the visible
   screen.
5. **Double-tap zoom toggle** — *small*. Toggle between fit (`zoom = 1`) and 2×
   anchored on the tapped cell, reusing `getFixedGridZoomContext` /
   `setFixedGridView` / `commitFixedGridView`.

---

## 6. Resolved Decisions

- **Selection vs. scroll** — scroll is **paused** while a selection is active;
  1-finger drag adjusts the nearest handle. Selection is screen-only (no
  edge-auto-scroll, no cross-screen tracking). 2-finger pan stays enabled.
- **Handle visuals** — ~14 px dot, ~44 px touch target, snaps to nearest cell.
- **Select-all** — the **visible screen only**, in both modes (consistent;
  zellij has no xterm scrollback anyway).
- **Double-tap zoom** — **toggle fit (1×) ↔ 2×** at the tapped cell. Pinch still
  covers continuous 1–4×.
