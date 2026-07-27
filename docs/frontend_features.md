# Frontend Features & Design Patterns

This document details the special designs and architectural patterns in the Porterminal frontend.

## Architecture Overview

The frontend uses a **factory + dependency injection** pattern with an event-driven architecture. All services are created via `createXxxService()` factories with dependencies passed as arguments.

```
main.ts (Bootstrap)
├── EventBus (core messaging)
├── ConfigService (server config)
├── ManagementService (control plane)
├── ConnectionService (data plane)
├── TabService (terminal rendering)
├── ResizeManager (debounced resize)
├── InputHandler (keyboard dispatch)
├── GestureRecognizer (touch dispatch)
├── ClipboardManager (copy/paste)
└── UI Components (overlays, buttons)
```

---

## 1. Dual WebSocket Architecture

Two separate WebSocket connections with distinct responsibilities:

| Connection | Endpoint | Purpose |
|------------|----------|---------|
| Control Plane | `/ws/management` | Tab lifecycle, auth, state sync |
| Data Plane | `/ws?tab_id=...&session_id=...` | Binary terminal I/O only |

**Custom Close Codes:**
- `4000` - TAB_ID_REQUIRED
- `4004` - TAB_NOT_FOUND
- `4005` - SESSION_ENDED

Backend-driven architecture: server controls tab state, frontend renders what server tells it.

---

## 2. Gesture Recognition System

Location: `frontend/src/gestures/`

### Supported Gestures

Gestures are separated by contact count rather than overloaded on context:
one finger interacts and scrolls, two fingers move the camera. See
`docs/design/gestures.md` for the full scheme and its rationale.

| Gesture | Threshold | Behavior |
|---------|-----------|----------|
| Single tap | - | Click through to the app (mouse protocol), or focus |
| Long-press | 250ms | Select the word under the finger, open the selection bar |
| Drag while selected | 10px | Adjust the nearer selection endpoint |
| Double-tap | 300ms window, 30px distance | Zoom toggle at the tapped point (fixed grid only) |
| 1-finger drag | 10px | Scroll the pane under the finger |
| 2-finger drag | 10px of midpoint travel | Pan a zoomed fixed grid, else scroll |
| Pinch-zoom | 12% distance change | Fixed grid: zoom 1-4x. Reflow: font size (10-24px) |
| Momentum scroll | 0.95 deceleration per frame | Physics-based smooth scrolling |
| Ctrl/Cmd + wheel | - | Zoom a fixed grid at the pointer (mouse / DeX) |
| Middle-button drag | - | Pan a zoomed fixed grid (mouse / DeX) |

Taps and wheel events are forwarded through xterm's mouse protocol so an
alternate-screen application (Zellij) receives them against the correct cell.
The synthetic dispatch is flagged rather than clearing the touch-active flag,
so the ghost click iOS synthesises after a touch stays suppressed.

### Momentum Scroll Algorithm

```typescript
// Velocity smoothing with exponential moving average
scrollVelocity = scrollVelocity * 0.3 + instantVelocity * 0.7;

// Accumulator pattern for fractional scrolling
scrollAccumulator += deltaY * SCROLL_SENSITIVITY;  // 0.15 lines/pixel
const lines = Math.trunc(scrollAccumulator);
terminal.scrollLines(lines);
scrollAccumulator -= lines;  // Keep remainder
```

### Pinch-Zoom Strategy

1. During pinch: Apply CSS `transform: scale()` (visual only, no reflow)
2. On touchend: Apply actual `fontSize` change
3. If user was at bottom: Restore scroll position via `requestAnimationFrame`

---

## 3. Three-State Modifier System

Location: `frontend/src/input/ModifierManager.ts`

Each modifier (Ctrl, Alt, Shift) has three states:

```
┌─────────────────────────────────────────────┐
│  off ──single tap──► sticky ──keystroke──► off  │
│   │                                              │
│   └──double tap──► locked ──single tap──► off   │
└─────────────────────────────────────────────┘
```

- **off**: Modifier inactive
- **sticky**: Active for one keystroke, then auto-resets
- **locked**: Active until explicitly toggled off

Visual feedback via CSS classes: `.sticky`, `.locked`

---

## 4. Write Batching with requestAnimationFrame

Location: `frontend/src/services/ConnectionService.ts`

### Buffer Strategy

| Buffer | Max Size | Purpose |
|--------|----------|---------|
| Early buffer | 1MB | Data during `connecting` state |
| Write buffer | 256KB | Data during `connected` state |

All writes within one animation frame are combined into a single `terminal.write()` call.

### Multi-Frame Connection Handshake

```
Frame 0: Fit terminal + send resize
Frame 1: xterm.js layout completion
Frame 2: Flush buffered data (hidden)
Frame 3: Show terminal (remove opacity:0)
```

---

## 5. iOS-Specific Workarounds

### Delete Key Handling
iOS sends `beforeinput` event with `deleteContentBackward` type. Intercepted and converted to `\x7f` (backspace).

### Clipboard Fallback
Uses `document.execCommand('copy')` with a visible textarea (iOS requires on-screen element).

### Safari 18+ Predictions
Sets `writingsuggestions="false"` attribute to disable inline predictions.

### Virtual Keyboard Detection
Monitors `window.visualViewport` resize events to detect keyboard appearance and adjust layout.

---

## 6. Touch/Click Deduplication

Every interactive button uses the `touchUsed` flag pattern:

```typescript
button.addEventListener('touchstart', (e) => {
    touchUsed = true;
    e.preventDefault();
    handleAction();
}, { passive: false });

button.addEventListener('click', () => {
    if (touchUsed) { touchUsed = false; return; }
    handleAction();
});
```

Prevents double-firing from touch event followed by synthetic click event.

---

## 7. Hold-to-Repeat (Backspace)

Uses pointer events for cross-device compatibility:

- **Initial delay**: 400ms before repeat starts
- **Repeat interval**: 50ms between repeats
- **Cancellation**: `pointerup`, `pointerleave`, `pointercancel`

---

## 8. Hold-to-Close (Tabs)

Prevents accidental tab closure:

- **Hold duration**: 400ms
- **Visual feedback**: `holding` class → `ready` class
- **Cancellation**: `pointerleave` (swipe away gesture)

---

## 9. Text Selection Engine

Location: `frontend/src/gestures/SelectionHandler.ts`

### Coordinate Conversion
```typescript
const cellWidth = rect.width / terminal.cols;
const cellHeight = rect.height / terminal.rows;
const col = Math.floor(x / cellWidth);
const row = Math.floor(y / cellHeight);
```

### Features
- Multi-line selection with anchor tracking
- Word boundary expansion on long-press
- Viewport offset handling for scrollback
- Endpoint positions in client pixels, for placing the selection handles
- Persistent top action bar (`ui/SelectionBar.ts`): Copy / Paste / All / dismiss

---

## 10. Text View Overlay

Location: `frontend/src/ui/TextViewOverlay.ts`

Provides readable text extraction from terminal buffer:

- Handles wrapped lines (joins without newlines)
- **Deduplication algorithm**: Removes xterm.js reflow artifacts
- Pinch-zoom with font range 6-32px
- Zoom buttons for single-finger adjustment

### Deduplication Logic
Detects and removes repeated content blocks that appear from terminal reflow operations.

---

## 11. Centralized Key Configuration

Location: `frontend/src/config/keys.ts`

All button definitions in one place:

```typescript
const TOOLBAR_ROW1: KeyConfig[] = [
    { key: 'Escape', label: 'Esc', sequence: '\x1b' },
    { key: '1', label: '1', sequence: '1' },
    // ...
];
```

Custom buttons from server config support complex sequences:
```typescript
// String, array of strings, or numbers (delay in ms)
send: ['echo hello', 100, '\r']  // Type, wait 100ms, press enter
```

Special tokens: `{CR}`, `{LF}`, `{ESC}`

---

## 12. Connection Resilience

### Reconnection Strategy
- Exponential backoff with max 5 attempts
- Base delay 1000ms, multiplied by attempt count
- Server rejection codes (4xxx) prevent reconnection

### Heartbeat
30-second ping/pong interval to keep connection alive.

### Visibility Change Handling
1. Reset modifier states
2. Reconnect management WebSocket first
3. Wait for state sync
4. Reconnect data plane connections

---

## 13. Resize Coordination

Location: `frontend/src/terminal/ResizeManager.ts`

### Debouncing
- Per-tab debounce timers (50ms default)
- Dimension deduplication (skip if unchanged)
- Buffer flush before any resize operation

### Triggers
- Window resize (50ms debounce)
- Orientation change (100ms delay for layout)
- Visual viewport change (keyboard appearance)
- Font size change (pinch-zoom)

---

## 13a. Fixed Grid (Shared Zellij Sessions)

Location: `frontend/src/terminal/TerminalLayout.ts`

Normally the browser owns its terminal size and `FitAddon` picks rows and
columns to suit the viewport. When several clients share one Zellij session
that breaks down: Zellij renders every client at the minimum size across all
of them, so the smallest screen would shrink everyone else. The server
therefore picks one authoritative grid and pins the followers to it
(`zellij_size_lock` / `zellij_size_unlock` on the data plane).

A pinned tab keeps those logical rows and columns and changes only its own
presentation:

| Step | What happens |
|------|--------------|
| Fit | Binary search (10 steps) for the largest font whose grid still fits |
| Fill | A residual uniform scale absorbs cell-rounding gaps at small fonts |
| Zoom | 1-4x, re-rasterised at a larger font rather than CSS-scaled |
| Pan | A plain `translate`, clamped so content never leaves empty space |

### Why zoom re-rasterises

CSS-scaling the canvas is cheaper but blurry, and worse, xterm decodes pointer
coordinates using its *unscaled* cell size and ignores CSS transforms. Any
residual scale on `term.element` makes a click land on `visualCell x scale` -
the wrong cell, and so the wrong Zellij tab. Baking the full visual scale
(fill x zoom) into the font leaves the element carrying only a translate, which
keeps xterm's own coordinate math correct for both touch and mouse. Only
extreme zoom, where the font hits its cap, leaves a residual scale; the touch
path inverts it explicitly as a safety net.

During an active pinch the cheap CSS preview is used for responsiveness and
re-rasterised once on release.

### Invariants

- Font and CSS changes never propagate a resize: presentation is local, the
  grid is shared. `ResizeManager` drops resizes for a pinned tab, and the font
  controls record the preference without applying it.
- A resize reports the browser's *natural* grid to the server, which is what
  the authority is computed from - not the grid currently being rendered.
- Zoom and pan persist per tab across switches; a fit signature lets an
  unchanged container skip the font search entirely.

---

## 14. Clipboard Management

Location: `frontend/src/clipboard/ClipboardManager.ts`

### Copy Strategy (Priority Order)
1. On touch devices: Try fallback `execCommand` first
2. Try `navigator.clipboard.writeText()`
3. Fallback to `execCommand('copy')`

### Deduplication
300ms window prevents duplicate copies of same text.

### iOS Fallback Requirements
- Textarea must be visible on-screen (not `display: none`)
- Uses Range API + `setSelectionRange()` for iOS selection model
- Cleanup: blur and remove element after copy

---

## 15. Typed Event Bus

Location: `frontend/src/core/events.ts`

TypeScript-enforced event/payload mapping:

```typescript
interface EventMap {
    'tab:created': { tab: Tab };
    'tab:switched': { tabId: number; tab: Tab };
    'modifier:changed': { modifier: ModifierKey; state: ModifierMode };
    'gesture:pinch': { scale: number };
    // ...
}
```

Features:
- Error isolation per handler (exceptions don't break other handlers)
- Unsubscribe function returned from `on()`
- `once()` for one-time subscriptions

---

## 16. Password Storage

Location: `frontend/src/utils/storage.ts`

Origin-hashed storage key using DJB2 hash:
```typescript
key = `ptn_auth_${hash(window.location.origin).toString(36)}`
```

Different tunnel URLs get separate credential storage. Graceful fallback when localStorage unavailable (private browsing).

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Gesture types | 10 |
| iOS workarounds | 4 |
| Buffer strategies | 3 |
| State machines | 3 |
| Deduplication patterns | 3 |
| WebSocket connections | 2 |

---

## File Index

| Path | Purpose |
|------|---------|
| `frontend/src/main.ts` | Bootstrap and service wiring |
| `frontend/src/services/ConnectionService.ts` | Data plane WebSocket |
| `frontend/src/services/ManagementService.ts` | Control plane WebSocket |
| `frontend/src/services/TabService.ts` | Terminal rendering |
| `frontend/src/gestures/GestureRecognizer.ts` | Touch gesture handling |
| `frontend/src/gestures/SelectionHandler.ts` | Text selection |
| `frontend/src/input/ModifierManager.ts` | Modifier state machine |
| `frontend/src/input/KeyMapper.ts` | Key sequence mapping |
| `frontend/src/config/keys.ts` | Button configuration |
| `frontend/src/clipboard/ClipboardManager.ts` | Copy/paste operations |
| `frontend/src/terminal/ResizeManager.ts` | Resize coordination |
| `frontend/src/terminal/TerminalLayout.ts` | Fitting, fixed-grid zoom and pan |
| `frontend/src/ui/SelectionBar.ts` | Selection action bar and handles |
| `frontend/src/core/events.ts` | Event bus |
| `frontend/src/ui/*.ts` | UI overlay components |
