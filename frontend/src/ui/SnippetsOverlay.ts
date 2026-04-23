/**
 * Snippets Overlay - Quick command picker modal
 *
 * Shows snippets from the server and command buttons from config.
 * Tap sends to terminal; long-press shows full command with a copy button.
 */

import type { Snippet, ButtonConfig, ButtonSend } from '@/types';
import { showToast } from '@/utils/toast';

export interface SnippetsCallbacks {
    onSelect: (command: string) => void;
    onAdd: (name: string, command: string) => Promise<void>;
    onDelete: (label: string) => Promise<void>;
}

export interface SnippetsOverlay {
    show(snippets: Snippet[], buttons: ButtonConfig[]): void;
    hide(): void;
    setup(callbacks: SnippetsCallbacks): void;
}

const LONG_PRESS_MS = 500;

function getCommandText(send: ButtonSend): string {
    if (typeof send === 'string') return send;
    return send.filter((x): x is string => typeof x === 'string').join('');
}

export function createSnippetsOverlay(): SnippetsOverlay {
    const overlay = document.getElementById('snippets-overlay');
    const content = document.getElementById('snippets-content');
    const listEl = document.getElementById('snippets-list');
    const closeBtn = document.getElementById('snippets-close');
    const addToggleBtn = document.getElementById('snippets-add-toggle');
    const addForm = document.getElementById('snippets-add-form');
    const addNameInput = document.getElementById('snippets-add-name') as HTMLInputElement | null;
    const addCommandInput = document.getElementById('snippets-add-command') as HTMLInputElement | null;
    const addSubmitBtn = document.getElementById('snippets-add-submit');
    const detailPanel = document.getElementById('snippets-detail');
    const detailNameEl = document.getElementById('snippets-detail-name');
    const detailCommandEl = document.getElementById('snippets-detail-command');
    const detailCopyBtn = document.getElementById('snippets-detail-copy');
    const detailCloseBtn = document.getElementById('snippets-detail-close');

    let cbs: SnippetsCallbacks | null = null;

    function hideDetail(): void {
        detailPanel?.classList.add('hidden');
    }

    function showDetail(name: string, command: string): void {
        if (!detailPanel || !detailNameEl || !detailCommandEl) return;
        detailNameEl.textContent = name;
        detailCommandEl.textContent = command;
        detailPanel.classList.remove('hidden');
    }

    function hide(): void {
        overlay?.classList.add('hidden');
        hideDetail();
        addForm?.classList.add('hidden');
    }

    function attachLongPress(el: HTMLElement, name: string, command: string): void {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let triggered = false;
        let startX = 0;
        let startY = 0;

        el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            triggered = false;
            startX = e.clientX;
            startY = e.clientY;
            timer = setTimeout(() => {
                triggered = true;
                if (navigator.vibrate) navigator.vibrate(30);
                showDetail(name, command);
            }, LONG_PRESS_MS);
        }, { passive: false });

        el.addEventListener('pointerup', () => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (!triggered) {
                cbs?.onSelect(command);
                hide();
            }
        });

        el.addEventListener('pointermove', (e) => {
            if (!timer) return;
            if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) {
                clearTimeout(timer);
                timer = null;
            }
        });

        el.addEventListener('pointercancel', () => {
            if (timer) { clearTimeout(timer); timer = null; }
        });

        el.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    function renderList(snippets: Snippet[], buttons: ButtonConfig[]): void {
        if (!listEl) return;
        listEl.innerHTML = '';

        if (snippets.length === 0 && buttons.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'snippets-empty';
            empty.textContent = 'No commands yet. Tap + to add one, or pass --snippets <file.json> to run-local.sh.';
            listEl.appendChild(empty);
            return;
        }

        for (const snippet of snippets) {
            const item = document.createElement('div');
            item.className = 'snippets-item';

            const nameEl = document.createElement('span');
            nameEl.className = 'snippets-name';
            nameEl.textContent = snippet.name;

            const cmdEl = document.createElement('code');
            cmdEl.className = 'snippets-command';
            cmdEl.textContent = snippet.command;

            item.appendChild(nameEl);
            item.appendChild(cmdEl);
            attachLongPress(item, snippet.name, snippet.command);
            listEl.appendChild(item);
        }

        for (const btn of buttons) {
            const cmdText = getCommandText(btn.send);

            const item = document.createElement('div');
            item.className = 'snippets-item snippets-item-dynamic';

            const textWrap = document.createElement('div');
            textWrap.className = 'snippets-item-text';

            const nameEl = document.createElement('span');
            nameEl.className = 'snippets-name';
            nameEl.textContent = btn.label;

            const cmdEl = document.createElement('code');
            cmdEl.className = 'snippets-command';
            cmdEl.textContent = cmdText;

            textWrap.appendChild(nameEl);
            textWrap.appendChild(cmdEl);
            item.appendChild(textWrap);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'snippets-delete-btn';
            deleteBtn.textContent = '×';
            deleteBtn.title = 'Delete';
            deleteBtn.addEventListener('pointerup', async (e) => {
                e.stopPropagation();
                await cbs?.onDelete(btn.label);
            });
            item.appendChild(deleteBtn);

            // Long-press on the text area only
            attachLongPress(textWrap, btn.label, cmdText);
            listEl.appendChild(item);
        }
    }

    return {
        show(snippets: Snippet[], buttons: ButtonConfig[]): void {
            hideDetail();
            addForm?.classList.add('hidden');
            renderList(snippets, buttons);
            overlay?.classList.remove('hidden');
        },

        hide,

        setup(callbacks: SnippetsCallbacks): void {
            cbs = callbacks;

            closeBtn?.addEventListener('click', hide);
            overlay?.addEventListener('click', (e) => {
                if (e.target === overlay) hide();
            });

            detailCopyBtn?.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(detailCommandEl?.textContent ?? '');
                    if (detailCopyBtn) detailCopyBtn.textContent = 'Copied!';
                    setTimeout(() => { if (detailCopyBtn) detailCopyBtn.textContent = 'Copy'; }, 1500);
                } catch {
                    if (detailCommandEl) {
                        const range = document.createRange();
                        range.selectNodeContents(detailCommandEl);
                        window.getSelection()?.removeAllRanges();
                        window.getSelection()?.addRange(range);
                    }
                }
            });
            detailCloseBtn?.addEventListener('click', hideDetail);

            addToggleBtn?.addEventListener('click', () => {
                const isHidden = addForm?.classList.toggle('hidden');
                if (!isHidden) addNameInput?.focus();
            });

            const handleAddSubmit = async (): Promise<void> => {
                const name = addNameInput?.value.trim() ?? '';
                const command = addCommandInput?.value.trim() ?? '';
                if (!name || !command) {
                    if (content) showToast(content, 'snippets-toast', 'Name and command required', 'error');
                    return;
                }
                await cbs?.onAdd(name, command);
                if (addNameInput) addNameInput.value = '';
                if (addCommandInput) addCommandInput.value = '';
                addForm?.classList.add('hidden');
            };

            addSubmitBtn?.addEventListener('click', handleAddSubmit);
            addCommandInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); void handleAddSubmit(); }
            });
            addNameInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); addCommandInput?.focus(); }
            });
        },
    };
}
