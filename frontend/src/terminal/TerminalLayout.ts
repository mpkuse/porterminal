/** Terminal fitting with optional fixed logical dimensions. */

import type { Tab, TerminalGrid } from '@/types';

const MIN_AUTO_FONT_SIZE = 1;
const MAX_AUTO_FONT_SIZE = 48;
const FONT_SEARCH_STEPS = 10;
const MIN_FIXED_GRID_ZOOM = 1;
const MAX_FIXED_GRID_ZOOM = 4;
// A zoomed fixed grid re-rasterises text at a larger font instead of
// CSS-scaling the canvas, which keeps glyphs crisp. This caps that font so the
// WebGL glyph atlas stays a sane size at extreme zoom.
const MAX_ZOOM_FONT_SIZE = 160;

function clearPresentationScale(tab: Tab): void {
    const element = tab.term.element;
    if (!element) return;
    element.style.width = '';
    element.style.height = '';
    element.style.transform = '';
    element.style.transformOrigin = '';
}

/** Clamp pan so scaled content never leaves empty space inside the container. */
function clampPan(tab: Tab, contentWidth: number, contentHeight: number): void {
    const minPanX = Math.min(0, tab.container.clientWidth - contentWidth);
    const minPanY = Math.min(0, tab.container.clientHeight - contentHeight);
    tab.fixedGridPanX = Math.max(minPanX, Math.min(0, tab.fixedGridPanX));
    tab.fixedGridPanY = Math.max(minPanY, Math.min(0, tab.fixedGridPanY));
}

function writeViewDataset(tab: Tab): void {
    tab.container.dataset.fixedGridZoom = tab.fixedGridZoom.toFixed(3);
    tab.container.dataset.fixedGridPanX = tab.fixedGridPanX.toFixed(1);
    tab.container.dataset.fixedGridPanY = tab.fixedGridPanY.toFixed(1);
}

/** Cache the last applied CSS scale and content size so panning can reuse them
 * without re-measuring or re-rasterising. */
function rememberRender(tab: Tab, scale: number, contentWidth: number, contentHeight: number): void {
    tab.fixedGridRenderScale = scale;
    tab.fixedGridContentWidth = contentWidth;
    tab.fixedGridContentHeight = contentHeight;
}

/**
 * Live preview transform used during an active pinch. Cheap: the font stays at
 * the base size and the whole element is CSS-scaled. Glyphs blur transiently
 * while the fingers move; commitFixedTerminalView re-rasterises on release.
 */
function applyPreviewScale(tab: Tab): void {
    const element = tab.term.element;
    if (!element) return;

    const baseScale = tab.fixedGridBaseScale;
    const zoom = tab.fixedGridZoom;
    const scale = baseScale * zoom;
    const contentWidth = tab.fixedGridBaseScreenWidth * zoom;
    const contentHeight = tab.fixedGridBaseScreenHeight * zoom;
    clampPan(tab, contentWidth, contentHeight);
    rememberRender(tab, scale, contentWidth, contentHeight);

    element.style.width = `${100 / baseScale}%`;
    element.style.height = `${100 / baseScale}%`;
    element.style.transformOrigin = 'top left';
    element.style.transform =
        `translate(${tab.fixedGridPanX}px, ${tab.fixedGridPanY}px) scale(${scale})`;
    writeViewDataset(tab);
}

/**
 * Crisp transform. The FULL visual scale (fill scale × zoom) is baked into the
 * terminal font so the renderer rasterises glyphs at the displayed resolution
 * and no CSS scale is needed — `term.element` gets only a translate for pan.
 * This is what keeps xterm's native mouse math correct in fixed-grid mode:
 * xterm ignores CSS transforms, so any residual element scale makes a click or
 * tap land on the wrong cell (e.g. the wrong Zellij tab under mouse/DeX). Only
 * extreme zoom (where the font hits MAX_ZOOM_FONT_SIZE) leaves a residual CSS
 * scale, and that path is touch-only. Panning uses a plain translate, which
 * never degrades quality. Falls back to the CSS preview if base metrics are not
 * measured yet.
 */
function applyCrispScale(tab: Tab): void {
    const grid = tab.fixedGrid;
    const element = tab.term.element;
    const screen = element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!grid || !element || !screen || !tab.fixedGridBaseFontSize || !tab.fixedGridBaseScale) {
        applyPreviewScale(tab);
        return;
    }

    const zoom = tab.fixedGridZoom;
    // Total visual scale (over the base render) the preview would apply.
    const desiredScale = tab.fixedGridBaseScale * zoom;

    // Drop any live-preview transform first: getBoundingClientRect reports the
    // transformed box, so the screen must be measured at its natural size.
    element.style.transform = '';
    element.style.width = '';
    element.style.height = '';

    // Re-rasterise at a font that bakes in the full visual scale (fill × zoom),
    // not just the zoom, so the residual CSS scale below collapses to ~1 and the
    // element carries only a translate. (Baking just `zoom` left a ~fill-scale
    // CSS scale that xterm's mouse math ignored, mis-targeting cells.)
    const targetFont = Math.min(
        MAX_ZOOM_FONT_SIZE,
        Math.max(MIN_AUTO_FONT_SIZE, tab.fixedGridBaseFontSize * desiredScale),
    );
    tab.term.options.fontSize = targetFont;
    tab.term.resize(grid.cols, grid.rows);

    const screenRect = screen.getBoundingClientRect();
    if (screenRect.width <= 0 || screenRect.height <= 0) {
        applyPreviewScale(tab);
        return;
    }

    // The font already made the render fontZoom× bigger than the base render;
    // any shortfall (font clamp / cell rounding) is made up by a residual CSS
    // scale so the on-screen size matches the preview exactly.
    const fontZoom = targetFont / tab.fixedGridBaseFontSize;
    const residualScale = desiredScale / fontZoom;
    const contentWidth = screenRect.width * residualScale;
    const contentHeight = screenRect.height * residualScale;
    clampPan(tab, contentWidth, contentHeight);
    rememberRender(tab, residualScale, contentWidth, contentHeight);

    element.style.width = '';
    element.style.height = '';
    element.style.transformOrigin = 'top left';
    element.style.transform =
        `translate(${tab.fixedGridPanX}px, ${tab.fixedGridPanY}px) scale(${residualScale})`;
    writeViewDataset(tab);
}

/** Measure the fitted screen and derive the residual fill scale at zoom 1. */
function measureBaseScale(tab: Tab): void {
    const element = tab.term.element;
    const screen = element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!element || !screen) return;

    const screenRect = screen.getBoundingClientRect();
    const availableWidth = tab.container.clientWidth;
    const availableHeight = tab.container.clientHeight;
    if (
        screenRect.width <= 0
        || screenRect.height <= 0
        || availableWidth <= 0
        || availableHeight <= 0
    ) {
        return;
    }

    // At very small font sizes xterm rounds cell pixels, so adjacent font
    // values can jump from an overflow to leaving substantial unused space.
    // A final uniform transform fills that rounding gap without changing the
    // logical rows/columns reported to Zellij.
    const scale = Math.min(
        availableWidth / screenRect.width,
        availableHeight / screenRect.height,
    );
    tab.fixedGridBaseScale = scale;
    tab.fixedGridBaseScreenWidth = screenRect.width * scale;
    tab.fixedGridBaseScreenHeight = screenRect.height * scale;
}

function dimensionsFit(tab: Tab, grid: TerminalGrid, fontSize: number): boolean {
    tab.term.options.fontSize = fontSize;
    const proposed = tab.fitAddon.proposeDimensions();
    return Boolean(
        proposed
        && proposed.cols >= grid.cols
        && proposed.rows >= grid.rows,
    );
}

/**
 * Fit a terminal to its container.
 *
 * A Zellij-attached terminal keeps the native client's logical grid and only
 * changes browser-side font metrics. All other terminals use FitAddon as usual.
 */
export function fitTerminalToContainer(tab: Tab): void {
    const grid = tab.fixedGrid;
    clearPresentationScale(tab);
    if (!grid) {
        tab.fitAddon.fit();
        return;
    }

    // Hidden tabs have no measurable parent. Keep their logical grid now and
    // calculate the presentation size when the tab becomes visible.
    if (tab.container.style.display === 'none') {
        tab.term.resize(grid.cols, grid.rows);
        tab.fixedGridBaseFontSize = 0;
        tab.fixedGridFitSignature = '';
        return;
    }

    // Tab switches re-fit constantly. When neither the container nor the grid
    // changed since the last fit, skip the font binary search and its reflows
    // and just re-render crisply at the current zoom.
    const signature =
        `${tab.container.clientWidth}x${tab.container.clientHeight}`
        + `:${grid.cols}x${grid.rows}`;
    if (signature === tab.fixedGridFitSignature && tab.fixedGridBaseFontSize > 0) {
        applyCrispScale(tab);
        return;
    }

    let lower = MIN_AUTO_FONT_SIZE;
    let upper = MAX_AUTO_FONT_SIZE;
    let best = MIN_AUTO_FONT_SIZE;

    for (let step = 0; step < FONT_SEARCH_STEPS; step++) {
        const candidate = (lower + upper) / 2;
        if (dimensionsFit(tab, grid, candidate)) {
            best = candidate;
            lower = candidate;
        } else {
            upper = candidate;
        }
    }

    // Leave a small rounding margin so fractional device pixels do not clip
    // the final row or column on high-DPI phones and tablets.
    const baseFont = Math.max(MIN_AUTO_FONT_SIZE, Math.floor(best * 10) / 10 - 0.1);
    tab.fixedGridBaseFontSize = baseFont;
    tab.term.options.fontSize = baseFont;
    tab.term.resize(grid.cols, grid.rows);
    measureBaseScale(tab);
    tab.fixedGridFitSignature = signature;
    // Render crisply at the current (persisted) zoom.
    applyCrispScale(tab);
}

/** Activate or release browser-side presentation of a fixed terminal grid. */
export function setFixedTerminalGrid(tab: Tab, grid: TerminalGrid | null): void {
    if (grid) {
        if (!tab.fixedGrid) {
            tab.fontSizeBeforeFixedGrid = tab.term.options.fontSize ?? null;
            tab.cursorBlinkBeforeFixedGrid = tab.term.options.cursorBlink ?? null;
            tab.fixedGridBaseScale = 1;
            tab.fixedGridBaseScreenWidth = 0;
            tab.fixedGridBaseScreenHeight = 0;
            tab.fixedGridBaseFontSize = 0;
            tab.fixedGridFitSignature = '';
            tab.fixedGridZoom = 1;
            tab.fixedGridPanX = 0;
            tab.fixedGridPanY = 0;
        }
        tab.fixedGrid = grid;
        tab.term.options.cursorBlink = false;
        tab.container.dataset.fixedGridCols = String(grid.cols);
        tab.container.dataset.fixedGridRows = String(grid.rows);
    } else {
        tab.fixedGrid = null;
        delete tab.container.dataset.fixedGridCols;
        delete tab.container.dataset.fixedGridRows;
        delete tab.container.dataset.fixedGridZoom;
        delete tab.container.dataset.fixedGridPanX;
        delete tab.container.dataset.fixedGridPanY;
        tab.fixedGridBaseScale = 1;
        tab.fixedGridBaseScreenWidth = 0;
        tab.fixedGridBaseScreenHeight = 0;
        tab.fixedGridBaseFontSize = 0;
        tab.fixedGridFitSignature = '';
        tab.fixedGridZoom = 1;
        tab.fixedGridPanX = 0;
        tab.fixedGridPanY = 0;
        if (tab.fontSizeBeforeFixedGrid !== null) {
            tab.term.options.fontSize = tab.fontSizeBeforeFixedGrid;
        }
        if (tab.cursorBlinkBeforeFixedGrid !== null) {
            tab.term.options.cursorBlink = tab.cursorBlinkBeforeFixedGrid;
        }
        tab.fontSizeBeforeFixedGrid = null;
        tab.cursorBlinkBeforeFixedGrid = null;
    }

    // Let the top bar show/hide the view-mode toggle for the active tab.
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('ptn:fixedgridchange'));
    }
    requestAnimationFrame(() => fitTerminalToContainer(tab));
}

/**
 * Re-arm the cheap CSS preview at the start of a pinch. Restores the base font
 * so the live scale grows from a known size rather than the last committed
 * (already enlarged) render.
 */
export function beginFixedTerminalPinch(tab: Tab): void {
    if (!tab.fixedGrid || !tab.fixedGridBaseFontSize) return;
    if (tab.term.options.fontSize !== tab.fixedGridBaseFontSize) {
        tab.term.options.fontSize = tab.fixedGridBaseFontSize;
        tab.term.resize(tab.fixedGrid.cols, tab.fixedGrid.rows);
    }
    applyPreviewScale(tab);
}

/** Preview a browser-only zoom/pan during an active pinch (CSS scale, cheap). */
export function setFixedTerminalView(
    tab: Tab,
    zoom: number,
    panX: number,
    panY: number,
): void {
    if (!tab.fixedGrid) return;

    tab.fixedGridZoom = Math.max(MIN_FIXED_GRID_ZOOM, Math.min(MAX_FIXED_GRID_ZOOM, zoom));
    tab.fixedGridPanX = panX;
    tab.fixedGridPanY = panY;
    applyPreviewScale(tab);
}

/** Commit the current zoom/pan as a crisp, re-rasterised render (on release). */
export function commitFixedTerminalView(tab: Tab): void {
    if (!tab.fixedGrid) return;
    applyCrispScale(tab);
}

/**
 * Move the zoomed view (one-finger pan). Only the translate changes, so the
 * already-rasterised render stays crisp and this is cheap enough per frame.
 */
export function panFixedTerminalView(tab: Tab, panX: number, panY: number): void {
    const element = tab.term.element;
    if (!tab.fixedGrid || !tab.fixedGridRenderScale || !element) return;
    tab.fixedGridPanX = panX;
    tab.fixedGridPanY = panY;
    clampPan(tab, tab.fixedGridContentWidth, tab.fixedGridContentHeight);
    element.style.transformOrigin = 'top left';
    element.style.transform =
        `translate(${tab.fixedGridPanX}px, ${tab.fixedGridPanY}px) scale(${tab.fixedGridRenderScale})`;
    writeViewDataset(tab);
}

/**
 * Read what the gesture layer needs to anchor a zoom on the text cursor: the
 * current zoom/pan, the base (zoom-1) on-screen grid size, and the cursor's
 * fractional position within the grid.
 */
export function getFixedGridZoomContext(tab: Tab): {
    zoom: number;
    panX: number;
    panY: number;
    baseWidth: number;
    baseHeight: number;
    cursorFracX: number;
    cursorFracY: number;
} | null {
    const grid = tab.fixedGrid;
    if (!grid || !tab.fixedGridBaseScreenWidth || !tab.fixedGridBaseScreenHeight) return null;
    const cursorX = tab.term.buffer.active.cursorX;
    const cursorY = tab.term.buffer.active.cursorY;
    return {
        zoom: tab.fixedGridZoom,
        panX: tab.fixedGridPanX,
        panY: tab.fixedGridPanY,
        baseWidth: tab.fixedGridBaseScreenWidth,
        baseHeight: tab.fixedGridBaseScreenHeight,
        cursorFracX: Math.min(1, Math.max(0, (cursorX + 0.5) / grid.cols)),
        cursorFracY: Math.min(1, Math.max(0, (cursorY + 0.5) / grid.rows)),
    };
}

/** Restore a fixed-grid terminal to its full fitted browser view. */
export function resetFixedTerminalView(tab: Tab): void {
    if (!tab.fixedGrid) return;
    tab.fixedGridZoom = 1;
    tab.fixedGridPanX = 0;
    tab.fixedGridPanY = 0;
    applyCrispScale(tab);
}
