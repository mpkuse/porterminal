/**
 * Gesture Recognizer - Orchestrates touch gesture handling
 * Single Responsibility: Gesture detection and dispatch
 *
 * Scheme (see docs/design/gestures.md):
 *   1 finger  -> interact & scroll   (tap = click-through, long-press = select,
 *                                     drag = scroll, drag-while-selected = adjust)
 *   2 fingers -> move the camera      (drag = pan the zoomed grid, pinch = zoom)
 *   double-tap -> zoom toggle at the tapped point (fixed-grid only)
 */

import type { Terminal } from '@xterm/xterm';
import type { EventBus } from '@/core/events';
import type { SelectionHandler } from './SelectionHandler';

/** Gesture timing constants */
const LONG_PRESS_MS = 250;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 30;
const MOVE_THRESHOLD = 20;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const SCROLL_SENSITIVITY = 0.15; // Lines per pixel of movement
const SCROLL_DECELERATION = 0.95; // Velocity multiplier per frame (0-1, higher = slower deceleration)
const SCROLL_MIN_VELOCITY = 0.5; // Minimum velocity to continue momentum scroll
const MIN_FIXED_GRID_ZOOM = 1;
const MAX_FIXED_GRID_ZOOM = 4;
/** Zoom level a double-tap jumps to (toggles back to fit on the next double-tap). */
const DOUBLE_TAP_ZOOM = 2;

interface FixedGridView {
    zoom: number;
    panX: number;
    panY: number;
    /** Whether the zoomed content overflows the container on each axis. */
    canPanX?: boolean;
    canPanY?: boolean;
}

interface FixedGridZoomContext {
    zoom: number;
    panX: number;
    panY: number;
    baseWidth: number;
    baseHeight: number;
    cursorFracX: number;
    cursorFracY: number;
}

export interface GestureCallbacks {
    /** Get active terminal */
    getActiveTerminal: () => Terminal | null;
    /** Focus terminal */
    focusTerminal: () => void;
    /** Schedule resize after font change */
    scheduleFitAfterFontChange: () => void;
    /** Return the persistent browser-only view while a fixed Zellij grid is active. */
    getFixedGridView: () => FixedGridView | null;
    /** Re-arm the cheap CSS preview at the start of a fixed-grid pinch. */
    beginFixedGridPinch?: () => void;
    /** Cursor position and base metrics used to anchor a zoom on the cursor. */
    getFixedGridZoomContext?: () => FixedGridZoomContext | null;
    /** Preview browser-only zoom/pan (CSS scale) during an active pinch. */
    setFixedGridView: (zoom: number, panX: number, panY: number) => void;
    /** Move the zoomed view without re-rasterising (two-finger pan). */
    panFixedGridView?: (panX: number, panY: number) => void;
    /** Commit the current zoom/pan as a crisp re-rasterised render (on release). */
    commitFixedGridView?: () => void;
    /** Enable/disable keyboard (for mobile selection) */
    setKeyboardEnabled?: (enabled: boolean) => void;
    /** A selection was just created (long-press). Show the selection UI. */
    onSelectionStart: () => void;
    /** The selection changed (adjust/select-all). Reposition the selection UI. */
    onSelectionChange: () => void;
    /** The selection was dismissed. Hide the selection UI. */
    onSelectionEnd: () => void;
}

export interface GestureRecognizer {
    /** Attach gesture handlers to container */
    attach(container: HTMLElement): void;
    /** Detach gesture handlers */
    detach(): void;
    /** Check if touch gesture is active */
    isGestureActive(): boolean;
}

/**
 * Create a gesture recognizer instance
 */
export function createGestureRecognizer(
    eventBus: EventBus,
    selectionHandler: SelectionHandler,
    callbacks: GestureCallbacks
): GestureRecognizer {
    // One-finger interaction state.
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    let pointerId: number | null = null;
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let fontSizeChanged = false;

    // Double-tap-to-select was removed; long-press grabs a word instead. This
    // flag marks the release that ends the word-selecting long-press so it does
    // not immediately count as a dismiss tap.
    let justSelected = false;

    // Selection adjustment (drag while a selection is active).
    let adjustingSelection = false;
    let adjustAnchorReady = false;
    let adjustAnchorCol = 0;
    let adjustAnchorRow = 0;

    let touchGestureActive = false;
    let isScrolling = false;
    let lastScrollY = 0;
    let lastScrollX = 0;
    let lastScrollTime = 0;
    let scrollAccumulator = 0;
    let scrollVelocity = 0;
    let momentumAnimationId: number | null = null;
    let attachedContainer: HTMLElement | null = null;

    // Pinch / two-finger state.
    let pinchTargetFontSize = 14;
    let pinchInitialFontSize = 14;
    let pinchContainer: HTMLElement | null = null;
    let pinchFixedGridView: FixedGridView | null = null;
    let isPinching = false;
    let initialDistance = 0;

    // Two-finger disambiguation: a pinch (distance change) zooms; fingers
    // translating together pan the zoomed grid (or scroll in reflow mode).
    let twoFingerMode: 'undecided' | 'zoom' | 'pan' = 'undecided';
    let twoFingerStartMidX = 0;
    let twoFingerStartMidY = 0;
    let twoFingerLastMidY = 0;
    let twoFingerScrollAccumulator = 0;
    let panStartX = 0;
    let panStartY = 0;
    let zoomContext: FixedGridZoomContext | null = null;
    // True once a fixed-grid pinch has dropped to the base font for previewing.
    let zoomPreviewArmed = false;
    // Distance must change by this fraction before a two-finger gesture is a zoom.
    const PINCH_SCALE_THRESHOLD = 0.12;

    // Mouse (e.g. Samsung DeX) fixed-grid view manipulation: Ctrl/Cmd+wheel zooms
    // at the pointer, middle-button drag pans. Touch uses pinch / two-finger.
    let isMousePanning = false;
    let mousePanPointerId: number | null = null;
    let mousePanStartX = 0;
    let mousePanStartY = 0;
    let mousePanStartPanX = 0;
    let mousePanStartPanY = 0;
    let wheelCommitTimer: ReturnType<typeof setTimeout> | null = null;

    /** Re-rasterise the fixed grid crisply once wheel-zoom settles. */
    function scheduleWheelCommit(): void {
        if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
        wheelCommitTimer = setTimeout(() => {
            wheelCommitTimer = null;
            callbacks.commitFixedGridView?.();
        }, 160);
    }

    function hasActiveSelection(term: Terminal | null): boolean {
        return Boolean(term && selectionHandler.hasSelection(term));
    }

    /**
     * Set only while tapTerminal dispatches its own synthetic mouse events, so
     * the compatibility blockers let those through without opening a window for
     * the OS-synthesised ghost click that follows a real touch.
     */
    let dispatchingSyntheticMouse = false;

    /** Reset pinch zoom state and clear CSS transform */
    function resetPinchState(): void {
        if (pinchContainer && pinchFixedGridView === null) {
            pinchContainer.style.transform = '';
            pinchContainer.style.transformOrigin = '';
        }
        pinchContainer = null;
        pinchFixedGridView = null;
        pinchTargetFontSize = 14;
        initialDistance = 0;
        fontSizeChanged = false;
    }

    /** Read the uniform CSS scale (matrix `a`) applied to an element, or 1. */
    function elementCssScale(element: HTMLElement): number {
        const transform = getComputedStyle(element).transform;
        if (!transform || transform === 'none') return 1;
        const flat = transform.match(/matrix\(([^)]+)\)/);
        if (flat) {
            const a = parseFloat(flat[1]!.split(',')[0]!);
            return a > 0 ? a : 1;
        }
        const threeD = transform.match(/matrix3d\(([^)]+)\)/);
        if (threeD) {
            const a = parseFloat(threeD[1]!.split(',')[0]!);
            return a > 0 ? a : 1;
        }
        return 1;
    }

    /** Forward a touch tap through xterm's mouse protocol to Zellij. */
    function tapTerminal(term: Terminal, clientX: number, clientY: number): boolean {
        const element = term.element;
        if (!element || term.modes.mouseTrackingMode === 'none') return false;

        // In fixed-grid (Zellij) mode the element carries a CSS scale that xterm's
        // mouse math ignores — it decodes with the unscaled cell size, so a raw tap
        // reports cell = visualCell * scale and lands on the wrong cell (e.g. the
        // wrong tab). Invert the scale about the element origin (top-left transform
        // origin; pan is already baked into rect.left/top) so xterm decodes the
        // cell actually under the finger. Reflow mode has no transform (scale 1).
        const scale = elementCssScale(element);
        let cx = clientX;
        let cy = clientY;
        if (scale !== 1) {
            const rect = element.getBoundingClientRect();
            cx = rect.left + (clientX - rect.left) / scale;
            cy = rect.top + (clientY - rect.top) / scale;
        }

        // Let these two events past the compatibility blockers without clearing
        // touchGestureActive: that flag still has to suppress the ghost click the
        // OS synthesises ~300ms after the touch, which would otherwise reach
        // xterm and report the same cell twice (double Zellij tab switch).
        dispatchingSyntheticMouse = true;
        try {
            element.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: cx,
                clientY: cy,
                button: 0,
                buttons: 1,
            }));
            element.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                clientX: cx,
                clientY: cy,
                button: 0,
                buttons: 0,
            }));
        } finally {
            dispatchingSyntheticMouse = false;
        }
        return true;
    }

    /**
     * Let xterm encode wheel reports when an alternate-screen application owns
     * the mouse. Zellij uses the reported cell to scroll only the touched pane.
     */
    function scrollTerminal(term: Terminal, lines: number, clientX: number, clientY: number): void {
        const element = term.element;
        const shouldDispatchWheel = Boolean(
            element
            && (term.modes.mouseTrackingMode !== 'none' || term.buffer.active.type === 'alternate')
        );
        if (!shouldDispatchWheel || !element) {
            term.scrollLines(lines);
            return;
        }

        const direction = Math.sign(lines);
        const count = Math.min(Math.abs(lines), 12);
        for (let index = 0; index < count; index++) {
            element.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                clientX,
                clientY,
                deltaY: direction,
                deltaMode: WheelEvent.DOM_DELTA_LINE,
            }));
        }
    }

    function stopMomentumScroll(): void {
        if (momentumAnimationId !== null) {
            cancelAnimationFrame(momentumAnimationId);
            momentumAnimationId = null;
        }
        scrollVelocity = 0;
    }

    function startMomentumScroll(): void {
        const term = callbacks.getActiveTerminal();
        if (!term || Math.abs(scrollVelocity) < SCROLL_MIN_VELOCITY) {
            scrollVelocity = 0;
            return;
        }

        function animate(): void {
            const currentTerm = callbacks.getActiveTerminal();
            if (!currentTerm || Math.abs(scrollVelocity) < SCROLL_MIN_VELOCITY) {
                scrollVelocity = 0;
                momentumAnimationId = null;
                return;
            }

            // Apply velocity to scroll
            scrollAccumulator += scrollVelocity * SCROLL_SENSITIVITY;
            const linesToScroll = Math.trunc(scrollAccumulator);
            if (linesToScroll !== 0) {
                scrollTerminal(currentTerm, linesToScroll, lastScrollX, lastScrollY);
                scrollAccumulator -= linesToScroll;
            }

            // Decelerate
            scrollVelocity *= SCROLL_DECELERATION;

            momentumAnimationId = requestAnimationFrame(animate);
        }

        momentumAnimationId = requestAnimationFrame(animate);
    }

    /** Double-tap toggles between fit (1x) and 2x, anchored on the tapped cell. */
    function doubleTapZoom(term: Terminal, clientX: number, clientY: number, view: FixedGridView): void {
        const target = view.zoom > 1.05 ? MIN_FIXED_GRID_ZOOM : DOUBLE_TAP_ZOOM;
        if (target === MIN_FIXED_GRID_ZOOM) {
            callbacks.setFixedGridView(MIN_FIXED_GRID_ZOOM, 0, 0);
            callbacks.commitFixedGridView?.();
            return;
        }

        const rect = term.element?.getBoundingClientRect();
        const ctx = callbacks.getFixedGridZoomContext?.() ?? null;
        if (rect && ctx) {
            // Keep the tapped point fixed on screen as the grid grows (same
            // anchoring math the pinch uses, but around the tap not the cursor).
            const fracX = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            const fracY = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
            const panX = ctx.panX + fracX * ctx.baseWidth * (ctx.zoom - target);
            const panY = ctx.panY + fracY * ctx.baseHeight * (ctx.zoom - target);
            callbacks.setFixedGridView(target, panX, panY);
        } else {
            callbacks.setFixedGridView(target, view.panX, view.panY);
        }
        callbacks.commitFixedGridView?.();
    }

    // Event handler references for cleanup
    const handlers: {
        pointerdown?: (e: PointerEvent) => void;
        pointermove?: (e: PointerEvent) => void;
        pointerup?: (e: PointerEvent) => void;
        pointercancel?: (e: PointerEvent) => void;
        touchstart?: (e: TouchEvent) => void;
        touchmove?: (e: TouchEvent) => void;
        touchend?: (e: TouchEvent) => void;
        touchcancel?: (e: TouchEvent) => void;
        mousedown?: (e: MouseEvent) => void;
        mousemove?: (e: MouseEvent) => void;
        mouseup?: (e: MouseEvent) => void;
        click?: (e: MouseEvent) => void;
        wheel?: (e: WheelEvent) => void;
    } = {};

    function clearLongPressTimer(): void {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }

    function releasePointer(container: HTMLElement): void {
        if (pointerId !== null) {
            try {
                container.releasePointerCapture(pointerId);
            } catch { /* ignore */ }
            pointerId = null;
        }
    }

    /** Choose which endpoint the drag moves (the nearer one) and anchor the far one. */
    function primeAdjustAnchor(term: Terminal): void {
        const ep = selectionHandler.getSelectionEndpoints(term);
        if (ep) {
            const dStart = Math.hypot(startX - ep.start.x, startY - ep.start.y);
            const dEnd = Math.hypot(startX - ep.end.x, startY - ep.end.y);
            // Move the nearer handle; keep the farther endpoint as the anchor.
            const far = dStart <= dEnd ? ep.end : ep.start;
            adjustAnchorCol = far.col;
            adjustAnchorRow = far.row;
        } else {
            const pos = selectionHandler.touchToPosition(term, startX, startY);
            adjustAnchorCol = pos.col;
            adjustAnchorRow = pos.row;
        }
        adjustAnchorReady = true;
    }

    return {
        attach(container: HTMLElement): void {
            attachedContainer = container;

            // Pointer events (primary for iOS compatibility)
            handlers.pointerdown = (e: PointerEvent) => {
                if (e.pointerType === 'mouse') {
                    // Middle-button drag pans a zoomed fixed grid (DeX/mouse).
                    if (e.button === 1) {
                        const view = callbacks.getFixedGridView();
                        if (view && view.zoom > MIN_FIXED_GRID_ZOOM) {
                            e.preventDefault();
                            e.stopPropagation();
                            isMousePanning = true;
                            mousePanPointerId = e.pointerId;
                            mousePanStartX = e.clientX;
                            mousePanStartY = e.clientY;
                            mousePanStartPanX = view.panX;
                            mousePanStartPanY = view.panY;
                            try { container.setPointerCapture(e.pointerId); } catch { /* ignore */ }
                        }
                    }
                    return;
                }
                if (isPinching) return;

                // Prevent default to stop page scrolling - we handle scroll in JS
                e.preventDefault();
                e.stopPropagation();

                stopMomentumScroll();

                touchGestureActive = true;
                isScrolling = false;
                adjustingSelection = false;
                adjustAnchorReady = false;
                lastScrollY = e.clientY;
                lastScrollX = e.clientX;
                lastScrollTime = performance.now();
                scrollAccumulator = 0;
                scrollVelocity = 0;
                startX = e.clientX;
                startY = e.clientY;
                pointerId = e.pointerId;

                clearLongPressTimer();

                const term = callbacks.getActiveTerminal();
                // A selection is already up: this touch either adjusts it (drag)
                // or dismisses it (tap). Do not arm a fresh word-select.
                if (hasActiveSelection(term)) return;

                const sx = e.clientX;
                const sy = e.clientY;
                const pid = e.pointerId;

                // Long-press grabs the word under the finger and opens selection.
                longPressTimer = setTimeout(() => {
                    const t = callbacks.getActiveTerminal();
                    if (!t || !touchGestureActive || isScrolling) return;
                    try {
                        container.setPointerCapture(pid);
                    } catch { /* ignore */ }

                    const pos = selectionHandler.touchToPosition(t, sx, sy);
                    const absRow = pos.row + Math.floor(t.buffer.active.viewportY);
                    selectionHandler.selectWordAt(t, pos.col, absRow);

                    if (selectionHandler.hasSelection(t)) {
                        justSelected = true;
                        adjustAnchorReady = false;
                        callbacks.onSelectionStart();
                        if (navigator.vibrate) navigator.vibrate(15);
                    }
                }, LONG_PRESS_MS);
            };

            handlers.pointermove = (e: PointerEvent) => {
                if (e.pointerType === 'mouse') {
                    if (isMousePanning) {
                        e.preventDefault();
                        e.stopPropagation();
                        callbacks.panFixedGridView?.(
                            mousePanStartPanX + (e.clientX - mousePanStartX),
                            mousePanStartPanY + (e.clientY - mousePanStartY),
                        );
                    }
                    return;
                }
                if (!touchGestureActive) return;
                if (isPinching) {
                    e.preventDefault();
                    return;
                }

                e.preventDefault();
                e.stopPropagation();

                const dx = Math.abs(e.clientX - startX);
                const dy = Math.abs(e.clientY - startY);
                const term = callbacks.getActiveTerminal();

                // Adjust an active selection: drag moves the nearest handle.
                if (hasActiveSelection(term) && term) {
                    if (!adjustingSelection && (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD)) {
                        clearLongPressTimer();
                        adjustingSelection = true;
                        primeAdjustAnchor(term);
                    }
                    if (adjustingSelection) {
                        if (!adjustAnchorReady) primeAdjustAnchor(term);
                        const pos = selectionHandler.touchToPosition(term, e.clientX, e.clientY);
                        selectionHandler.extendSelection(
                            term, adjustAnchorCol, adjustAnchorRow, pos.col, pos.row,
                        );
                        callbacks.onSelectionChange();
                    }
                    return;
                }

                // No selection: a drag past the threshold scrolls the pane.
                if (!isScrolling && (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD)) {
                    clearLongPressTimer();
                    isScrolling = true;
                }

                if (isScrolling && term) {
                    const now = performance.now();
                    const deltaY = lastScrollY - e.clientY; // Positive = scroll up (finger up)
                    const deltaTime = now - lastScrollTime;

                    if (deltaTime > 0) {
                        const instantVelocity = deltaY / deltaTime * 16;
                        scrollVelocity = scrollVelocity * 0.3 + instantVelocity * 0.7;
                    }

                    lastScrollY = e.clientY;
                    lastScrollX = e.clientX;
                    lastScrollTime = now;

                    scrollAccumulator += deltaY * SCROLL_SENSITIVITY;
                    const linesToScroll = Math.trunc(scrollAccumulator);
                    if (linesToScroll !== 0) {
                        scrollTerminal(term, linesToScroll, e.clientX, e.clientY);
                        scrollAccumulator -= linesToScroll;
                    }
                }
            };

            handlers.pointerup = (e: PointerEvent) => {
                if (e.pointerType === 'mouse') {
                    if (isMousePanning) {
                        e.preventDefault();
                        e.stopPropagation();
                        isMousePanning = false;
                        if (mousePanPointerId !== null) {
                            try { container.releasePointerCapture(mousePanPointerId); } catch { /* ignore */ }
                            mousePanPointerId = null;
                        }
                    }
                    return;
                }
                if (!touchGestureActive || isPinching) return;

                releasePointer(container);
                e.stopPropagation();
                clearLongPressTimer();

                const dx = Math.abs(e.clientX - startX);
                const dy = Math.abs(e.clientY - startY);
                const wasTap = dx < MOVE_THRESHOLD && dy < MOVE_THRESHOLD;
                const now = Date.now();

                const wasScrolling = isScrolling;
                const wasAdjusting = adjustingSelection;
                const didJustSelect = justSelected;
                isScrolling = false;
                adjustingSelection = false;
                adjustAnchorReady = false;
                justSelected = false;
                scrollAccumulator = 0;

                const term = callbacks.getActiveTerminal();

                // Finished dragging a handle: keep the selection, reposition UI.
                if (wasAdjusting) {
                    callbacks.onSelectionChange();
                    setTimeout(() => { touchGestureActive = false; }, 350);
                    return;
                }

                // Scrolling: carry the flick into a momentum scroll.
                if (wasScrolling) {
                    startMomentumScroll();
                    setTimeout(() => { touchGestureActive = false; }, 350);
                    return;
                }

                if (hasActiveSelection(term) && term) {
                    if (didJustSelect) {
                        // The release that ended the word-selecting long-press.
                        callbacks.onSelectionChange();
                    } else if (wasTap) {
                        // A tap while a selection is up dismisses it.
                        selectionHandler.clearSelection(term);
                        callbacks.onSelectionEnd();
                    }
                    setTimeout(() => { touchGestureActive = false; }, 350);
                    return;
                }

                // No selection: taps zoom (double) or click through (single).
                if (wasTap && term) {
                    const tapDistance = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY);
                    if (now - lastTapTime < DOUBLE_TAP_MS && tapDistance < DOUBLE_TAP_DISTANCE) {
                        lastTapTime = 0;
                        const view = callbacks.getFixedGridView();
                        if (view) doubleTapZoom(term, e.clientX, e.clientY, view);
                        // Reflow mode: no fixed grid to zoom into -> no-op.
                    } else {
                        lastTapTime = now;
                        lastTapX = e.clientX;
                        lastTapY = e.clientY;
                        if (!tapTerminal(term, e.clientX, e.clientY)) {
                            callbacks.focusTerminal();
                        }
                    }
                }

                setTimeout(() => { touchGestureActive = false; }, 350);
            };

            handlers.pointercancel = (e: PointerEvent) => {
                if (e.pointerType === 'mouse') {
                    if (isMousePanning) {
                        isMousePanning = false;
                        if (mousePanPointerId !== null) {
                            try { container.releasePointerCapture(mousePanPointerId); } catch { /* ignore */ }
                            mousePanPointerId = null;
                        }
                    }
                    return;
                }

                releasePointer(container);
                clearLongPressTimer();
                stopMomentumScroll();
                isScrolling = false;
                adjustingSelection = false;
                adjustAnchorReady = false;
                justSelected = false;
                scrollAccumulator = 0;
                touchGestureActive = false;
                resetPinchState();
            };

            // Two-finger touch events: pinch to zoom, drag together to pan.
            handlers.touchstart = (e: TouchEvent) => {
                if (e.touches.length === 2) {
                    e.preventDefault();
                    e.stopPropagation();
                    clearLongPressTimer();
                    isPinching = true;
                    isScrolling = false;
                    adjustingSelection = false;
                    stopMomentumScroll();

                    const t0 = e.touches[0]!;
                    const t1 = e.touches[1]!;
                    initialDistance = Math.hypot(
                        t0.clientX - t1.clientX,
                        t0.clientY - t1.clientY,
                    );

                    twoFingerMode = 'undecided';
                    twoFingerStartMidX = (t0.clientX + t1.clientX) / 2;
                    twoFingerStartMidY = (t0.clientY + t1.clientY) / 2;
                    twoFingerLastMidY = twoFingerStartMidY;
                    twoFingerScrollAccumulator = 0;
                    scrollVelocity = 0;
                    lastScrollTime = performance.now();
                    zoomPreviewArmed = false;

                    const term = callbacks.getActiveTerminal();
                    pinchInitialFontSize = term?.options.fontSize ?? 14;
                    pinchTargetFontSize = pinchInitialFontSize;
                    pinchFixedGridView = callbacks.getFixedGridView();
                    zoomContext = callbacks.getFixedGridZoomContext?.() ?? null;
                    panStartX = pinchFixedGridView?.panX ?? 0;
                    panStartY = pinchFixedGridView?.panY ?? 0;
                    if (term?.element) {
                        pinchContainer = term.element as HTMLElement;
                    }
                }
            };

            handlers.touchmove = (e: TouchEvent) => {
                if (e.touches.length !== 2 || initialDistance <= 0) return;
                e.preventDefault();

                const t0 = e.touches[0]!;
                const t1 = e.touches[1]!;
                const distance = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
                const scale = distance / initialDistance;
                const midX = (t0.clientX + t1.clientX) / 2;
                const midY = (t0.clientY + t1.clientY) / 2;

                // Decide zoom vs pan once the fingers have moved enough.
                if (twoFingerMode === 'undecided') {
                    if (Math.abs(scale - 1) > PINCH_SCALE_THRESHOLD) {
                        twoFingerMode = 'zoom';
                    } else if (Math.hypot(midX - twoFingerStartMidX, midY - twoFingerStartMidY) > MOVE_THRESHOLD) {
                        twoFingerMode = 'pan';
                        twoFingerLastMidY = midY;
                        lastScrollTime = performance.now();
                    } else {
                        return;
                    }
                }

                // Two-finger drag: pan the zoomed grid, or scroll in reflow mode
                // (where there is no fixed grid canvas to pan).
                if (twoFingerMode === 'pan') {
                    if (pinchFixedGridView !== null) {
                        callbacks.panFixedGridView?.(
                            panStartX + (midX - twoFingerStartMidX),
                            panStartY + (midY - twoFingerStartMidY),
                        );
                    } else {
                        const term = callbacks.getActiveTerminal();
                        if (term) {
                            const now = performance.now();
                            const deltaY = twoFingerLastMidY - midY;
                            const deltaTime = now - lastScrollTime;
                            if (deltaTime > 0) {
                                const instantVelocity = deltaY / deltaTime * 16;
                                scrollVelocity = scrollVelocity * 0.3 + instantVelocity * 0.7;
                            }
                            lastScrollTime = now;
                            lastScrollX = midX;
                            lastScrollY = midY;
                            twoFingerScrollAccumulator += deltaY * SCROLL_SENSITIVITY;
                            const lines = Math.trunc(twoFingerScrollAccumulator);
                            if (lines !== 0) {
                                scrollTerminal(term, lines, midX, midY);
                                twoFingerScrollAccumulator -= lines;
                            }
                        }
                        twoFingerLastMidY = midY;
                    }
                    return;
                }

                // Zoom mode.
                if (pinchFixedGridView !== null) {
                    if (!zoomPreviewArmed) {
                        // Drop to the base font so the CSS preview scales from a
                        // known size; the release re-rasterises crisply.
                        callbacks.beginFixedGridPinch?.();
                        zoomPreviewArmed = true;
                    }
                    const zoom = Math.max(
                        MIN_FIXED_GRID_ZOOM,
                        Math.min(MAX_FIXED_GRID_ZOOM, pinchFixedGridView.zoom * scale),
                    );
                    // Cursor-anchored: keep the cursor cell fixed on screen as
                    // the grid grows/shrinks around it.
                    const ctx = zoomContext;
                    const panX = ctx
                        ? ctx.panX + ctx.cursorFracX * ctx.baseWidth * (ctx.zoom - zoom)
                        : pinchFixedGridView.panX;
                    const panY = ctx
                        ? ctx.panY + ctx.cursorFracY * ctx.baseHeight * (ctx.zoom - zoom)
                        : pinchFixedGridView.panY;
                    callbacks.setFixedGridView(zoom, panX, panY);
                    fontSizeChanged = true;
                    eventBus.emit('gesture:pinch', { scale: zoom });
                    return;
                }

                // Non-fixed terminal: pinch changes the real font size.
                let newSize = Math.round(pinchInitialFontSize * scale);
                newSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, newSize));
                const effectiveScale = newSize / pinchInitialFontSize;
                if (pinchContainer) {
                    pinchContainer.style.transformOrigin = 'center center';
                    pinchContainer.style.transform = `scale(${effectiveScale})`;
                }
                if (newSize !== pinchTargetFontSize) {
                    pinchTargetFontSize = newSize;
                    fontSizeChanged = true;
                    eventBus.emit('gesture:pinch', { scale: effectiveScale });
                }
            };

            handlers.touchend = (e: TouchEvent) => {
                if (!isPinching || e.touches.length >= 2) return;

                const wasScrollFallback = twoFingerMode === 'pan' && pinchFixedGridView === null;
                const usedFixedGridZoom = pinchFixedGridView !== null && zoomPreviewArmed;
                const didChangeFont = fontSizeChanged;
                const targetFontSize = pinchTargetFontSize;
                resetPinchState();
                isPinching = false;
                touchGestureActive = false;
                isScrolling = false;
                twoFingerMode = 'undecided';
                zoomContext = null;
                zoomPreviewArmed = false;

                if (wasScrollFallback) {
                    // Carry the flick into a momentum scroll.
                    startMomentumScroll();
                    return;
                }

                if (usedFixedGridZoom) {
                    // Re-rasterise the fixed grid at the committed zoom so text
                    // is crisp instead of a CSS-upscaled (blurry) canvas.
                    callbacks.commitFixedGridView?.();
                } else if (didChangeFont) {
                    const term = callbacks.getActiveTerminal();
                    if (term) {
                        term.options.fontSize = targetFontSize;
                        callbacks.scheduleFitAfterFontChange();
                    }
                }
                // A pure pan (fixed grid) committed live in panFixedGridView and
                // stays crisp, so there is nothing to do on release.
            };

            // Handle touch cancellation (e.g., incoming call, OS gesture conflict)
            handlers.touchcancel = () => {
                const armedZoom = pinchFixedGridView !== null && zoomPreviewArmed;
                resetPinchState();
                isPinching = false;
                touchGestureActive = false;
                twoFingerMode = 'undecided';
                zoomContext = null;
                zoomPreviewArmed = false;
                // If a fixed-grid zoom was mid-preview, restore a crisp render.
                if (armedZoom) callbacks.commitFixedGridView?.();
            };

            // Ctrl/Cmd + wheel zooms a fixed grid at the pointer (DeX/mouse).
            // Plain wheel is left untouched so xterm still scrolls / reports it.
            handlers.wheel = (e: WheelEvent) => {
                if (!(e.ctrlKey || e.metaKey)) return;
                const view = callbacks.getFixedGridView();
                const term = callbacks.getActiveTerminal();
                const rect = term?.element?.getBoundingClientRect();
                const ctx = callbacks.getFixedGridZoomContext?.() ?? null;
                if (!view || !term || !rect || !ctx) return;
                e.preventDefault();
                e.stopPropagation();
                const factor = Math.exp(-e.deltaY * 0.0015);
                const target = Math.max(
                    MIN_FIXED_GRID_ZOOM,
                    Math.min(MAX_FIXED_GRID_ZOOM, view.zoom * factor),
                );
                // Keep the pointed-at cell fixed as the grid grows/shrinks.
                const fracX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                const fracY = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
                callbacks.setFixedGridView(
                    target,
                    ctx.panX + fracX * ctx.baseWidth * (ctx.zoom - target),
                    ctx.panY + fracY * ctx.baseHeight * (ctx.zoom - target),
                );
                scheduleWheelCommit();
            };

            // Block mouse events during touch (prevents ghost clicks on iOS);
            // also suppress middle-click autoscroll while a zoomed grid can pan.
            const blockMouseDuringTouch = (e: MouseEvent) => {
                if (touchGestureActive && !dispatchingSyntheticMouse) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            };
            handlers.mousedown = (e: MouseEvent) => {
                if (touchGestureActive && !dispatchingSyntheticMouse) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                if (e.button === 1) {
                    const view = callbacks.getFixedGridView();
                    if (view && view.zoom > MIN_FIXED_GRID_ZOOM) e.preventDefault();
                }
            };
            handlers.mousemove = blockMouseDuringTouch;
            handlers.mouseup = blockMouseDuringTouch;
            handlers.click = blockMouseDuringTouch;

            // Attach all handlers
            container.addEventListener('pointerdown', handlers.pointerdown, { passive: false, capture: true });
            container.addEventListener('pointermove', handlers.pointermove, { passive: false, capture: true });
            container.addEventListener('pointerup', handlers.pointerup, { passive: false, capture: true });
            container.addEventListener('pointercancel', handlers.pointercancel, { passive: false, capture: true });
            container.addEventListener('touchstart', handlers.touchstart, { passive: false, capture: true });
            container.addEventListener('touchmove', handlers.touchmove, { passive: false, capture: true });
            container.addEventListener('touchend', handlers.touchend, { passive: false, capture: true });
            container.addEventListener('touchcancel', handlers.touchcancel, { passive: false, capture: true });
            container.addEventListener('mousedown', handlers.mousedown, { passive: false, capture: true });
            container.addEventListener('mousemove', handlers.mousemove, { passive: false, capture: true });
            container.addEventListener('mouseup', handlers.mouseup, { passive: false, capture: true });
            container.addEventListener('click', handlers.click, { passive: false, capture: true });
            container.addEventListener('wheel', handlers.wheel, { passive: false, capture: true });
        },

        detach(): void {
            if (!attachedContainer) return;

            const eventNames = [
                'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
                'touchstart', 'touchmove', 'touchend', 'touchcancel',
                'mousedown', 'mousemove', 'mouseup', 'click', 'wheel',
            ] as const;

            for (const event of eventNames) {
                const handler = handlers[event];
                if (handler) {
                    attachedContainer.removeEventListener(event, handler as EventListener, { capture: true });
                }
            }

            attachedContainer = null;
        },

        isGestureActive(): boolean {
            return touchGestureActive;
        },
    };
}
