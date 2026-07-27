/**
 * Text View Overlay - Plain text view of terminal content
 * Single Responsibility: Extract and display terminal content as selectable text
 */

import type { Terminal } from '@xterm/xterm';

export interface TextViewOverlay {
    /** Show the overlay with terminal content */
    show(term: Terminal): void;
    /** Hide the overlay */
    hide(): void;
    /** Setup event handlers */
    setup(): void;
}

/** Font size limits */
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 32;
const FONT_STEP = 1;

/**
 * Guard against the specific xterm.js artifact where the entire captured screen
 * is emitted twice back-to-back (can happen during rapid output / reflow):
 * "block A\nblock A" collapses to "block A".
 *
 * Deliberately conservative: it only fires when the whole text is exactly two
 * identical multi-line halves. It must NOT touch legitimate repetition —
 * repeated tokens on one line (e.g. a long `====` rule), progress logs, ASCII
 * art, `yes` output — which the reader has to preserve verbatim. (The old
 * character-level heuristic collapsed any string whose halves matched and so
 * silently destroyed such content.)
 */
function removeDuplicates(text: string): string {
    const lines = text.split('\n');
    const n = lines.length;
    // Require a sizeable, even block so uniform-but-legitimate output does not
    // accidentally look like a doubled screen.
    if (n < 8 || n % 2 !== 0) return text;

    const half = n / 2;
    for (let i = 0; i < half; i++) {
        if (lines[i] !== lines[i + half]) return text;
    }
    return lines.slice(0, half).join('\n');
}

/**
 * Extract plain text from terminal buffer
 * Handles wrapped lines by joining continuations properly.
 *
 * Note: buffer.length can exceed actual content during reflow.
 * We use baseY + cursorY to find the actual content end.
 */
function getTerminalText(term: Terminal): string {
    const buffer = term.buffer.active;
    const logicalLines: string[] = [];
    let currentLine = '';

    // Calculate actual content length:
    // - baseY is the scroll offset (how many lines are in scrollback above viewport)
    // - cursorY is cursor position within viewport (0-indexed)
    // - Total content lines = baseY + cursorY + 1 (include cursor line)
    // But we also need to account for content below cursor, so use buffer.length
    // but cap it at a reasonable limit based on scrollback settings
    const contentEnd = Math.min(
        buffer.length,
        buffer.baseY + term.rows  // scrollback + viewport
    );

    // Get all lines from scrollback + viewport
    // Handle wrapped lines: isWrapped=true means continuation of previous line
    for (let i = 0; i < contentEnd; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;

        // translateToString(true) trims trailing whitespace
        // translateToString(false) preserves whitespace for wrapped continuations
        const text = line.isWrapped
            ? line.translateToString(false)  // preserve whitespace for wrapped lines
            : line.translateToString(true);

        if (line.isWrapped) {
            // Continuation of previous line - join without newline
            currentLine += text;
        } else {
            // Start of new logical line
            if (currentLine) {
                logicalLines.push(currentLine.trimEnd());
            }
            currentLine = text;
        }
    }

    // Push the last line
    if (currentLine) {
        logicalLines.push(currentLine.trimEnd());
    }

    // Trim trailing empty lines
    while (logicalLines.length > 0 && (logicalLines[logicalLines.length - 1] ?? '').trim() === '') {
        logicalLines.pop();
    }

    // Remove any duplicated content caused by xterm.js buffer issues
    return removeDuplicates(logicalLines.join('\n'));
}

/** Comfortable default reading font, independent of the (possibly tiny/huge)
 *  fixed-grid rasterisation font on the live terminal. */
const READER_DEFAULT_FONT = 14;
/** Re-extract at most this often while the terminal streams output. */
const LIVE_REFRESH_MS = 120;

/**
 * Create a text view overlay controller
 */
export function createTextViewOverlay(): TextViewOverlay {
    const overlay = document.getElementById('textview-overlay');
    const zoomInBtn = document.getElementById('textview-zoom-in');
    const zoomOutBtn = document.getElementById('textview-zoom-out');
    const wrapBtn = document.getElementById('textview-wrap');
    const body = document.getElementById('textview-body') as HTMLPreElement | null;

    let fontSize = READER_DEFAULT_FONT; // Persisted across opens
    let initialPinchDistance = 0;
    let initialFontSize = fontSize;
    let wrap = true;

    // Live-update state while the overlay is visible.
    let activeTerm: Terminal | null = null;
    let liveDisposable: { dispose(): void } | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    function updateFontSize(): void {
        if (body) {
            body.style.fontSize = `${fontSize}px`;
        }
    }

    function setFontSize(size: number): void {
        fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
        updateFontSize();
    }

    function zoomIn(): void {
        setFontSize(fontSize + FONT_STEP);
    }

    function zoomOut(): void {
        setFontSize(fontSize - FONT_STEP);
    }

    function applyWrap(): void {
        if (body) body.style.whiteSpace = wrap ? 'pre-wrap' : 'pre';
        wrapBtn?.classList.toggle('active', wrap);
    }

    function toggleWrap(): void {
        wrap = !wrap;
        applyWrap();
    }

    /** Re-extract terminal text, keeping the reader pinned to the bottom when it
     *  already was (pager feel) and otherwise preserving the scroll position. */
    function renderContent(term: Terminal): void {
        if (!body) return;
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 4;
        const prevTop = body.scrollTop;
        body.textContent = getTerminalText(term);
        body.scrollTop = atBottom ? body.scrollHeight : prevTop;
    }

    /** Coalesce bursts of terminal output into one re-extraction. */
    function scheduleRefresh(): void {
        if (refreshTimer !== null) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            if (activeTerm) renderContent(activeTerm);
        }, LIVE_REFRESH_MS);
    }

    function stopLive(): void {
        liveDisposable?.dispose();
        liveDisposable = null;
        if (refreshTimer !== null) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
    }

    // Pinch zoom handlers
    function getTouchDistance(touches: TouchList): number {
        const t0 = touches[0];
        const t1 = touches[1];
        if (!t0 || !t1) return 0;
        const dx = t1.clientX - t0.clientX;
        const dy = t1.clientY - t0.clientY;
        return Math.hypot(dx, dy);
    }

    function handleTouchStart(e: TouchEvent): void {
        if (e.touches.length === 2) {
            initialPinchDistance = getTouchDistance(e.touches);
            initialFontSize = fontSize;
        }
    }

    function handleTouchMove(e: TouchEvent): void {
        if (e.touches.length === 2 && initialPinchDistance > 0) {
            e.preventDefault();
            const currentDistance = getTouchDistance(e.touches);
            const scale = currentDistance / initialPinchDistance;
            setFontSize(Math.round(initialFontSize * scale));
        }
    }

    function handleTouchEnd(): void {
        initialPinchDistance = 0;
    }

    return {
        show(term: Terminal): void {
            activeTerm = term;
            updateFontSize();
            applyWrap();

            if (body) {
                body.textContent = getTerminalText(term);
            }
            overlay?.classList.remove('hidden');
            // Scroll to bottom after layout completes
            requestAnimationFrame(() => {
                if (body) {
                    body.scrollTop = body.scrollHeight;
                }
            });

            // Keep the reader in sync while the command keeps printing.
            stopLive();
            liveDisposable = term.onWriteParsed(() => scheduleRefresh());
        },

        hide(): void {
            stopLive();
            activeTerm = null;
            overlay?.classList.add('hidden');
            if (body) {
                body.textContent = '';
            }
        },

        setup(): void {
            // Note: close button handler is set up in main.ts to enable terminal refresh on close
            zoomInBtn?.addEventListener('click', zoomIn);
            zoomOutBtn?.addEventListener('click', zoomOut);
            wrapBtn?.addEventListener('click', toggleWrap);

            // Pinch zoom on body
            body?.addEventListener('touchstart', handleTouchStart, { passive: true });
            body?.addEventListener('touchmove', handleTouchMove, { passive: false });
            body?.addEventListener('touchend', handleTouchEnd, { passive: true });
        },
    };
}
