/**
 * Selection Bar - WhatsApp-style top action bar + selection handles.
 * Single Responsibility: render the Copy / Paste / Select-all / Clear bar and
 * the two endpoint handles. It is a passive view: the GestureRecognizer drives
 * the actual selection (long-press to grab a word, drag to adjust); this
 * component only reflects the current selection and dispatches bar actions.
 */

import type { Terminal } from '@xterm/xterm';
import type { SelectionHandler } from '@/gestures/SelectionHandler';

export interface SelectionBar {
    /** Create the DOM (idempotent). */
    setup(): void;
    /** Show the bar + handles for the current selection. */
    show(): void;
    /** Recompute handle positions from the current selection (no-op if hidden). */
    reposition(): void;
    /** Hide the bar + handles. */
    hide(): void;
    /** Whether the bar is currently shown. */
    isVisible(): boolean;
}

export interface SelectionBarCallbacks {
    getActiveTerminal: () => Terminal | null;
    /** Copy the given text to the clipboard. */
    copy: (text: string) => void;
    /** Paste the clipboard into the active terminal. */
    paste: () => void;
    /** Clear the active terminal's selection. */
    clear: () => void;
}

export function createSelectionBar(
    selectionHandler: SelectionHandler,
    callbacks: SelectionBarCallbacks,
): SelectionBar {
    let bar: HTMLElement | null = null;
    let startHandle: HTMLElement | null = null;
    let endHandle: HTMLElement | null = null;
    let visible = false;

    function currentText(): string {
        const term = callbacks.getActiveTerminal();
        return term ? selectionHandler.getSelection(term) : '';
    }

    function doHide(): void {
        visible = false;
        bar?.classList.add('hidden');
        startHandle?.classList.add('hidden');
        endHandle?.classList.add('hidden');
    }

    function doReposition(): void {
        if (!visible) return;
        const term = callbacks.getActiveTerminal();
        const ep = term ? selectionHandler.getSelectionEndpoints(term) : null;
        if (!ep || !startHandle || !endHandle) {
            doHide();
            return;
        }
        startHandle.style.left = `${ep.start.x}px`;
        startHandle.style.top = `${ep.start.y}px`;
        endHandle.style.left = `${ep.end.x}px`;
        endHandle.style.top = `${ep.end.y}px`;
        startHandle.classList.remove('hidden');
        endHandle.classList.remove('hidden');
    }

    function handleCopy(): void {
        const text = currentText();
        if (text) callbacks.copy(text);
        doHide();
    }
    function handlePaste(): void {
        callbacks.paste();
        doHide();
    }
    function handleSelectAll(): void {
        const term = callbacks.getActiveTerminal();
        if (!term) return;
        selectionHandler.selectVisibleScreen(term);
        doReposition();
    }
    function handleClear(): void {
        callbacks.clear();
        doHide();
    }

    /** Button with touch/click dedup (mirrors the app's touchUsed pattern). */
    function makeButton(label: string, cls: string, onTap: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = 'selection-bar-btn' + (cls ? ` ${cls}` : '');
        btn.textContent = label;
        let touchUsed = false;
        btn.addEventListener('touchstart', (e) => {
            touchUsed = true;
            e.preventDefault();
            e.stopPropagation();
            onTap();
        }, { passive: false });
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (touchUsed) { touchUsed = false; return; }
            onTap();
        });
        return btn;
    }

    function build(): void {
        if (bar) return;

        bar = document.createElement('div');
        bar.id = 'selection-bar';
        bar.className = 'selection-bar hidden';
        bar.appendChild(makeButton('Copy', 'primary', handleCopy));
        bar.appendChild(makeButton('Paste', '', handlePaste));
        bar.appendChild(makeButton('All', '', handleSelectAll));
        bar.appendChild(makeButton('✕', 'close', handleClear));
        document.body.appendChild(bar);

        startHandle = document.createElement('div');
        startHandle.className = 'sel-handle sel-handle-start hidden';
        endHandle = document.createElement('div');
        endHandle.className = 'sel-handle sel-handle-end hidden';
        document.body.appendChild(startHandle);
        document.body.appendChild(endHandle);
    }

    return {
        setup(): void {
            build();
        },
        show(): void {
            build();
            visible = true;
            bar?.classList.remove('hidden');
            doReposition();
        },
        reposition(): void {
            doReposition();
        },
        hide(): void {
            doHide();
        },
        isVisible(): boolean {
            return visible;
        },
    };
}
