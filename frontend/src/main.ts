/**
 * Porterminal - Web-based terminal client
 * Main entry point - Application bootstrap and wiring
 *
 * Architecture: Backend-driven tab management
 * - ManagementService handles control plane (/ws/management)
 * - ConnectionService handles data plane (/ws for terminal I/O)
 * - TabService renders what the server tells it
 */

// Styles
import '@xterm/xterm/css/xterm.css';
import './styles/index.css';

// Core
import { createEventBus } from '@/core/events';

// Services
import { createConfigService } from '@/services/ConfigService';
import { createConnectionService } from '@/services/ConnectionService';
import { createManagementService } from '@/services/ManagementService';
import { createTabService } from '@/services/TabService';

// Input
import { createKeyMapper } from '@/input/KeyMapper';
import { createModifierManager } from '@/input/ModifierManager';
import { createInputHandler } from '@/input/InputHandler';

// Gestures
import { createSelectionHandler } from '@/gestures/SelectionHandler';
import { createGestureRecognizer } from '@/gestures/GestureRecognizer';

// Clipboard
import { createClipboardManager } from '@/clipboard/ClipboardManager';

// Terminal
import { createResizeManager } from '@/terminal/ResizeManager';

// UI
import { createSelectionBar } from '@/ui/SelectionBar';
import { createComposeInput } from '@/ui/ComposeInput';
import { createDisconnectOverlay } from '@/ui/DisconnectOverlay';
import { createAuthOverlay } from '@/ui/AuthOverlay';
import { createConnectionStatus } from '@/ui/ConnectionStatus';
import { createTextViewOverlay } from '@/ui/TextViewOverlay';
import { createUpdateOverlay } from '@/ui/UpdateOverlay';
import { createSettingsOverlay } from '@/ui/SettingsOverlay';
import { createSnippetsOverlay } from '@/ui/SnippetsOverlay';
import { renderToolbar } from '@/ui/Toolbar';
import { showToast } from '@/utils/toast';

// Storage
import {
    applyTheme,
    getDisabledButtons,
    getLightMode,
    getDesktopToolbarAutohide,
    getTerminalFontSize,
    getSavedPassword,
    savePassword,
    clearPassword,
    setTerminalFontSize,
    setDesktopToolbarAutohide,
    clampTerminalFontSize,
} from '@/utils/storage';

// Types
import type { AppConfig, ButtonSend, Tab } from '@/types';
import type { TabService } from '@/services/TabService';
import {
    beginFixedTerminalPinch,
    commitFixedTerminalView,
    fitTerminalToContainer,
    getFixedGridZoomContext,
    panFixedTerminalView,
    resetFixedTerminalView,
    setFixedTerminalGrid,
    setFixedTerminalView,
} from '@/terminal/TerminalLayout';

applyTheme(getLightMode());

/**
 * Perform fitAddon.fit() with scroll-to-bottom preservation.
 * Uses onRender callbacks to overcome xterm.js async reflow timing.
 */
function fitWithScrollToBottom(tab: Tab): void {
    fitTerminalToContainer(tab);

    // Immediate scroll
    tab.term.scrollToBottom();

    // onRender callbacks to catch async reflow
    let count = 0;
    const disposable = tab.term.onRender(() => {
        tab.term.scrollToBottom();
        if (++count >= 10) disposable.dispose();
    });

    // Timeout fallback
    setTimeout(() => {
        disposable.dispose();
        tab.term.scrollToBottom();
    }, 500);
}

function getCSSVar(name: string, fallback: string): string {
    const styles = getComputedStyle(document.documentElement);
    return styles.getPropertyValue(name).trim() || fallback;
}

function applyTerminalTheme(tab: Tab): void {
    tab.term.options.theme = {
        background: getCSSVar('--bg-primary', '#1e1e1e'),
        foreground: getCSSVar('--text-primary', '#cccccc'),
        cursor: getCSSVar('--cursor-color', '#aeafad'),
        cursorAccent: getCSSVar('--bg-primary', '#1e1e1e'),
        selectionBackground: getCSSVar('--selection-bg', 'rgba(38, 79, 120, 0.5)'),
        black: getLightMode() ? '#0f172a' : '#000000',
        red: getLightMode() ? '#b91c1c' : '#cd3131',
        green: getLightMode() ? '#15803d' : '#0dbc79',
        yellow: getLightMode() ? '#a16207' : '#e5e510',
        blue: getLightMode() ? '#1d4ed8' : '#2472c8',
        magenta: getLightMode() ? '#a21caf' : '#bc3fbc',
        cyan: getLightMode() ? '#0e7490' : '#11a8cd',
        white: getLightMode() ? '#334155' : '#e5e5e5',
        brightBlack: getLightMode() ? '#64748b' : '#666666',
        brightRed: getLightMode() ? '#dc2626' : '#f14c4c',
        brightGreen: getLightMode() ? '#16a34a' : '#23d18b',
        brightYellow: getLightMode() ? '#ca8a04' : '#f5f543',
        brightBlue: getLightMode() ? '#2563eb' : '#3b8eea',
        brightMagenta: getLightMode() ? '#c026d3' : '#d670d6',
        brightCyan: getLightMode() ? '#0891b2' : '#29b8db',
        brightWhite: getLightMode() ? '#0f172a' : '#e5e5e5',
    };
    tab.term.refresh(0, tab.term.rows - 1);
}

function setupFontSizeControls(tabService: TabService): void {
    const downBtn = document.getElementById('btn-font-down') as HTMLButtonElement | null;
    const upBtn = document.getElementById('btn-font-up') as HTMLButtonElement | null;
    const label = document.getElementById('font-size-label');
    if (!downBtn || !upBtn) return;

    const updateLabel = (size: number): void => {
        if (label) {
            label.textContent = String(size);
        }
    };

    const applySize = (nextSize: number): void => {
        const size = clampTerminalFontSize(nextSize);
        setTerminalFontSize(size);
        updateLabel(size);

        for (const tab of tabService.tabs) {
            if (tab.fixedGrid) {
                tab.fontSizeBeforeFixedGrid = size;
            } else {
                tab.term.options.fontSize = size;
            }
            if (tab.container.style.display !== 'none') {
                fitWithScrollToBottom(tab);
            }
        }

        tabService.focusTerminal();
    };

    updateLabel(getTerminalFontSize());
    downBtn.addEventListener('click', () => applySize(getTerminalFontSize() - 1));
    upBtn.addEventListener('click', () => applySize(getTerminalFontSize() + 1));
}

// Configuration (heartbeat matches backend HEARTBEAT_INTERVAL = 30s)
const CONFIG = {
    maxReconnectAttempts: 5,
    reconnectDelayMs: 1000,
    heartbeatMs: 30000,
};

/**
 * Create a toolbar row element
 */
function createToolbarRow(toolbar: HTMLElement, id: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'toolbar-row hidden';
    row.id = id;
    toolbar.appendChild(row);
    return row;
}

/**
 * Create a custom button element with encoded send data
 */
function createCustomButton(btn: { label: string; send: ButtonSend }): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'tool-btn';
    button.textContent = btn.label;
    const send = btn.send || '';
    const sendArray = Array.isArray(send) ? send : [send];
    const encoded = sendArray.map(item =>
        typeof item === 'number' ? item : item
            .replace(/\r/g, '{CR}')
            .replace(/\n/g, '{LF}')
            .replace(/\x1b/g, '{ESC}')
    );
    button.dataset.send = JSON.stringify(encoded);
    return button;
}

/**
 * Render custom buttons from config into toolbar rows
 */
function renderCustomButtons(buttons: AppConfig['buttons']): void {
    if (!buttons?.length) return;

    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;

    // Group buttons by row number
    const buttonsByRow = new Map<number, typeof buttons>();
    for (const btn of buttons) {
        const row = btn.row ?? 1;
        if (!buttonsByRow.has(row)) {
            buttonsByRow.set(row, []);
        }
        buttonsByRow.get(row)!.push(btn);
    }

    // Create/get toolbar rows and add buttons (row 1 = toolbar-row3, row 2 = toolbar-row4, etc.)
    for (const rowNum of [...buttonsByRow.keys()].sort((a, b) => a - b)) {
        const toolbarRowId = `toolbar-row${rowNum + 2}`;
        const toolbarRow = document.getElementById(toolbarRowId)
            ?? createToolbarRow(toolbar, toolbarRowId);

        for (const btn of buttonsByRow.get(rowNum)!) {
            toolbarRow.appendChild(createCustomButton(btn));
        }
        toolbarRow.classList.remove('hidden');
    }
}



/**
 * Initialize the application
 */
async function init(): Promise<void> {
    // Create core infrastructure
    const eventBus = createEventBus();

    // Create services
    const configService = createConfigService();

    // Load configuration early so it's available for component initialization
    const config = await configService.load();

    // Create UI components
    const connectionStatus = createConnectionStatus();
    const disconnectOverlay = createDisconnectOverlay();
    const authOverlay = createAuthOverlay();
    const textViewOverlay = createTextViewOverlay();
    const updateOverlay = createUpdateOverlay();
    const settingsOverlay = createSettingsOverlay();
    const snippetsOverlay = createSnippetsOverlay();

    // Auth state
    let currentPassword = getSavedPassword();

    // Create clipboard manager
    const clipboardManager = createClipboardManager();

    // Create input components
    const keyMapper = createKeyMapper();
    const modifierManager = createModifierManager(eventBus, (modifier) => {
        updateModifierButton(modifier);
    });

    // Forward declaration for tabService
    let tabService: TabService;

    // Forward declaration for connectionService (needed in auth callbacks)
    let connectionService: ReturnType<typeof createConnectionService>;

    // Create management service (control plane)
    const managementService = createManagementService({
        onStateSync: (serverTabs) => {
            console.log('Received state sync:', serverTabs.length, 'tabs');
            tabService.applyStateSync(serverTabs);
        },
        onStateUpdate: (changes) => {
            console.log('Received state update:', changes);
            tabService.applyStateUpdate(changes);
        },
        onDisconnect: () => {
            console.log('Management WebSocket disconnected');
            connectionStatus.set('disconnected');
            disconnectOverlay.show();
        },
        onConnect: () => {
            console.log('Management WebSocket connected');
            disconnectOverlay.hide();
            // Auto-auth if we have saved password
            if (currentPassword) {
                managementService.authenticate(currentPassword);
            }
        },
        onAuthRequired: () => {
            console.log('Authentication required');
            if (currentPassword) {
                // Try saved password first
                managementService.authenticate(currentPassword);
            } else {
                authOverlay.show();
            }
        },
        onAuthFailed: (attemptsRemaining, error) => {
            console.log('Authentication failed:', error, 'attempts remaining:', attemptsRemaining);
            clearPassword();
            currentPassword = null;
            connectionService?.setAuthPassword(null);
            if (attemptsRemaining > 0) {
                authOverlay.showError(error || `Invalid password. ${attemptsRemaining} attempts remaining.`);
            } else {
                authOverlay.showError(error || 'Too many failed attempts.');
            }
            authOverlay.clearInput();
            authOverlay.show();
        },
        onAuthSuccess: () => {
            console.log('Authentication successful');
            if (currentPassword) {
                savePassword(currentPassword);
                connectionService?.setAuthPassword(currentPassword);
            }
            authOverlay.hide();
        },
    });

    // Create connection service (data plane for terminal I/O)
    connectionService = createConnectionService(
        eventBus,
        {
            maxReconnectAttempts: CONFIG.maxReconnectAttempts,
            reconnectDelayMs: CONFIG.reconnectDelayMs,
            heartbeatMs: CONFIG.heartbeatMs,
        },
        {
            onSessionInfo: (tab, sessionId, tabId) => {
                // Update tab with server-assigned IDs
                tab.sessionId = sessionId;
                if (tabId) {
                    tab.tabId = tabId;
                }
            },
            onDisconnect: () => {
                connectionStatus.set('disconnected');
            },
            onReconnectFailed: () => {
                disconnectOverlay.show();
            },
        }
    );

    // Create resize manager
    const resizeManager = createResizeManager((tab, cols, rows) => {
        connectionService.sendResize(tab, cols, rows);
    });

    // Create tab service (render-only, backend-driven)
    tabService = createTabService(
        eventBus,
        managementService,
        connectionService,
        modifierManager.state,
        config.default_shell,
        {
            onInputSend: () => {
                modifierManager.consumeSticky();
            },
            scheduleResize: (tab) => {
                resizeManager.scheduleResize(tab);
            },
            onSelectionChange: () => {
                // Mouse-driven selection (e.g. Samsung DeX) has no long-press to
                // open the Copy bar, so surface it here. Touch selection is driven
                // by the gesture callbacks; skip while a touch gesture is active
                // to avoid double-driving the bar.
                if (gestureRecognizer.isGestureActive()) return;
                const tab = tabService.activeTab;
                if (tab && tab.term.hasSelection()) {
                    selectionBar.show();
                } else {
                    selectionBar.hide();
                }
            },
        }
    );

    // Helper to send input to active tab
    const sendToActiveTab = (data: string): void => {
        const tab = tabService.activeTab;
        if (tab) {
            connectionService.sendInput(tab, data);
        }
    };

    // Create compose input (compose-then-send text input mode)
    const composeInput = createComposeInput({
        serverDefault: config.compose_mode,
        onToggle: (enabled) => {
            // Sync settings overlay when compose button is toggled
            settingsOverlay.syncComposeMode(enabled);
        },
    });
    composeInput.setup(sendToActiveTab);

    // Helper to focus terminal only when compose mode is disabled
    const focusTerminalIfNotComposing = (): void => {
        if (!composeInput.isEnabled()) {
            tabService.focusTerminal();
        }
    };

    // Create input handler
    const inputHandler = createInputHandler(
        keyMapper,
        modifierManager,
        { sendInput: sendToActiveTab }
    );

    // Create gesture components
    const selectionHandler = createSelectionHandler();

    // Selection UI: WhatsApp-style top action bar + endpoint handles.
    const selectionBar = createSelectionBar(selectionHandler, {
        getActiveTerminal: () => tabService.activeTab?.term ?? null,
        copy: (text) => {
            clipboardManager.copy(text, 'selectionBar');
            const tab = tabService.activeTab;
            if (tab) tab.term.clearSelection();
        },
        paste: async () => {
            const tab = tabService.activeTab;
            if (!tab) return;
            const text = await clipboardManager.paste();
            if (!text) return;
            // Respect bracketed-paste mode so apps treat it as pasted, not typed.
            const data = tab.term.modes.bracketedPasteMode
                ? `\x1b[200~${text}\x1b[201~`
                : text;
            connectionService.sendInput(tab, data);
            focusTerminalIfNotComposing();
        },
        clear: () => {
            const tab = tabService.activeTab;
            if (tab) tab.term.clearSelection();
        },
    });

    const gestureRecognizer = createGestureRecognizer(
        eventBus,
        selectionHandler,
        {
            getActiveTerminal: () => tabService.activeTab?.term ?? null,
            onSelectionStart: () => selectionBar.show(),
            onSelectionChange: () => selectionBar.reposition(),
            onSelectionEnd: () => selectionBar.hide(),
            focusTerminal: focusTerminalIfNotComposing,
            scheduleFitAfterFontChange: () => {
                const tab = tabService.activeTab;
                if (tab) {
                    fitWithScrollToBottom(tab);
                }
            },
            getFixedGridView: () => {
                const tab = tabService.activeTab;
                return tab?.fixedGrid ? {
                    zoom: tab.fixedGridZoom,
                    panX: tab.fixedGridPanX,
                    panY: tab.fixedGridPanY,
                    canPanX: tab.fixedGridContentWidth > tab.container.clientWidth + 1,
                    canPanY: tab.fixedGridContentHeight > tab.container.clientHeight + 1,
                } : null;
            },
            beginFixedGridPinch: () => {
                const tab = tabService.activeTab;
                if (tab) beginFixedTerminalPinch(tab);
            },
            getFixedGridZoomContext: () => {
                const tab = tabService.activeTab;
                return tab ? getFixedGridZoomContext(tab) : null;
            },
            setFixedGridView: (zoom, panX, panY) => {
                const tab = tabService.activeTab;
                if (tab) setFixedTerminalView(tab, zoom, panX, panY);
                selectionBar.reposition();
            },
            panFixedGridView: (panX, panY) => {
                const tab = tabService.activeTab;
                if (tab) panFixedTerminalView(tab, panX, panY);
                selectionBar.reposition();
            },
            commitFixedGridView: () => {
                const tab = tabService.activeTab;
                if (tab) commitFixedTerminalView(tab);
                selectionBar.reposition();
            },
            setKeyboardEnabled: (enabled) => {
                tabService.setKeyboardEnabled(enabled);
            },
        }
    );

    // Setup UI components
    selectionBar.setup();

    // Test hook, gated behind ?e2e — lets Playwright drive the active terminal
    // deterministically (the WebGL renderer exposes no per-cell DOM to target).
    if (new URLSearchParams(window.location.search).has('e2e')) {
        (window as unknown as { __ptn?: unknown }).__ptn = {
            getActiveTerminal: () => tabService.activeTab?.term ?? null,
            selectionBarVisible: () => selectionBar.isVisible(),
            enterFixedGrid: (cols: number, rows: number) => {
                const tab = tabService.activeTab;
                if (!tab) return;
                setFixedTerminalGrid(tab, { cols, rows });
                fitWithScrollToBottom(tab);
            },
            getFixedState: () => {
                const tab = tabService.activeTab;
                if (!tab || !tab.fixedGrid) return null;
                return {
                    zoom: tab.fixedGridZoom,
                    panX: tab.fixedGridPanX,
                    panY: tab.fixedGridPanY,
                };
            },
            // Send real input down the data plane (onData path), so tests can
            // drive the shell (e.g. type `zellij attach ...`).
            sendInput: (text: string) => {
                const tab = tabService.activeTab;
                if (tab) connectionService.sendInput(tab, text);
            },
            // Logical grid + any active fixed-grid (size-lock) dimensions.
            getGrid: () => {
                const tab = tabService.activeTab;
                if (!tab) return null;
                return {
                    cols: tab.term.cols,
                    rows: tab.term.rows,
                    fixedGrid: tab.fixedGrid
                        ? { cols: tab.fixedGrid.cols, rows: tab.fixedGrid.rows }
                        : null,
                    zoom: tab.fixedGridZoom,
                    tabCount: tabService.tabs.length,
                };
            },
        };
    }

    disconnectOverlay.setup(async () => {
        try {
            // 1. Reconnect management and wait for state sync
            if (!managementService.isConnected()) {
                await managementService.connect();
            }

            // 2. Connect data plane for synced tabs
            for (const tab of tabService.tabs) {
                if (!connectionService.isConnected(tab)) {
                    tab.reconnectAttempts = 0;
                    connectionService.connect(tab, true);
                }
            }

            disconnectOverlay.hide();
        } catch (e) {
            console.error('Retry failed:', e);
        }
    });

    // Setup auth overlay
    authOverlay.setup((password) => {
        currentPassword = password;
        managementService.authenticate(password);
    });

    // Setup update overlay
    updateOverlay.setup();

    // Mutable config reference shared by snippets and settings
    let currentConfig = config;

    const openSnippets = (): void => {
        snippetsOverlay.show(currentConfig.snippets ?? [], currentConfig.buttons ?? []);
    };

    // Setup snippets overlay
    snippetsOverlay.setup({
        onSelect: (command) => {
            const tab = tabService.activeTab;
            if (tab) connectionService.sendInput(tab, command);
        },
        onAdd: async (name, command) => {
            const result = await configService.addButton(name, command);
            if (result.success) {
                currentConfig = {
                    ...currentConfig,
                    buttons: result.buttons ?? currentConfig.buttons ?? [],
                    snippets: result.snippets ?? currentConfig.snippets ?? [],
                };
                openSnippets();
            }
        },
        onDelete: async (label) => {
            const result = await configService.removeButton(label);
            if (result.success) {
                currentConfig = {
                    ...currentConfig,
                    buttons: result.buttons ?? currentConfig.buttons ?? [],
                    snippets: result.snippets ?? currentConfig.snippets ?? [],
                };
                openSnippets();
            }
        },
    });
    setupSnippetsButton(openSnippets);

    setupFontSizeControls(tabService);
    setupTapButton('btn-reset-view', () => {
        const tab = tabService.activeTab;
        if (tab) resetFixedTerminalView(tab);
    });

    // Zellij tab navigation: robust at any zoom (no aiming at tiny grid cells).
    // Sends default zellij keys: Ctrl+T (tab mode) -> h/l (prev/next) -> Enter
    // (back to normal). Only shown while a tab is Zellij-locked (fixedGrid).
    const ZELLIJ_TABMODE = '\x14'; // Ctrl+T
    const ZELLIJ_STEP_MS = 60;
    const sendZellijTabSwitch = async (dir: 'h' | 'l') => {
        const tab = tabService.activeTab;
        if (!tab || !tab.fixedGrid) return;
        inputHandler.sendInput(ZELLIJ_TABMODE);
        await new Promise(r => setTimeout(r, ZELLIJ_STEP_MS));
        inputHandler.sendInput(dir);
        await new Promise(r => setTimeout(r, ZELLIJ_STEP_MS));
        inputHandler.sendInput('\r');
    };
    const updateTabNavButtons = () => {
        const isZellij = Boolean(tabService.activeTab?.fixedGrid);
        for (const id of ['btn-tab-prev', 'btn-tab-next']) {
            const btn = document.getElementById(id) as HTMLButtonElement | null;
            if (btn) btn.hidden = !isZellij;
        }
    };
    setupTapButton('btn-tab-prev', () => { void sendZellijTabSwitch('h'); });
    setupTapButton('btn-tab-next', () => { void sendZellijTabSwitch('l'); });
    window.addEventListener('ptn:fixedgridchange', updateTabNavButtons);
    updateTabNavButtons();

    setupDesktopToolbarAutohide();

    // Render custom buttons from config (supports multiple rows)
    renderCustomButtons(config.buttons);

    // Apply button visibility from localStorage (hide disabled buttons)
    applyButtonVisibility();

    // Render toolbar buttons from config
    renderToolbar();

    // Setup modifier buttons
    setupModifierButtons(modifierManager);

    // Setup escape button
    setupEscapeButton(inputHandler);

    // Setup backspace button
    setupBackspaceButton(() => {
        const tab = tabService.activeTab;
        if (tab) {
            connectionService.sendInput(tab, '\x7f');
        }
    });

    // Setup paste button
    setupPasteButton(async () => {
        const text = await clipboardManager.paste();
        if (text) {
            const tab = tabService.activeTab;
            if (tab) {
                connectionService.sendInput(tab, text);
                if (navigator.vibrate) navigator.vibrate(30);
            }
        }
        tabService.focusTerminal();
    });

    // Setup tool buttons
    setupToolButtons(inputHandler);

    // Setup shutdown button
    setupShutdownButton(disconnectOverlay);

    // Setup help button
    setupHelpButton();

    // Setup settings overlay
    settingsOverlay.setup(configService, managementService, {
        onComposeModeChange: (enabled) => {
            composeInput.setEnabled(enabled);
        },
        onThemeChange: () => {
            for (const tab of tabService.tabs) {
                applyTerminalTheme(tab);
            }
        },
    });
    setupSettingsButton(settingsOverlay, () => currentConfig);

    // Setup text view button
    textViewOverlay.setup();
    setupTextViewButton(
        textViewOverlay,
        () => tabService.activeTab?.term ?? null,
        () => {
            const tab = tabService.activeTab;
            if (tab) {
                // Force xterm.js to repaint all rows from buffer
                tab.term.refresh(0, tab.term.rows - 1);
            }
        }
    );

    // Attach gesture recognizer
    const terminalContainer = document.getElementById('terminal-container');
    if (terminalContainer) {
        gestureRecognizer.attach(terminalContainer);

        // Use ResizeObserver to detect container size changes and refit terminal
        // This handles: compose toggle, visual viewport changes, window resize, etc.
        let resizeTimeout: ReturnType<typeof setTimeout>;
        const resizeObserver = new ResizeObserver(() => {
            // Debounce to avoid excessive refits
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                const tab = tabService.activeTab;
                if (tab) {
                    fitWithScrollToBottom(tab);
                }
            }, 50);
        });
        resizeObserver.observe(terminalContainer);
    }

    // Connection events for terminal WebSockets
    eventBus.on('connection:open', ({ tabId }) => {
        if (tabId === tabService.activeTabId) {
            connectionStatus.set('connected');
            disconnectOverlay.hide();
        }
    });

    eventBus.on('connection:close', ({ tabId }) => {
        if (tabId === tabService.activeTabId) {
            connectionStatus.set('disconnected');
        }
    });

    // Clean up resize timers when tabs are closed
    eventBus.on('tab:closed', ({ tabId }) => {
        resizeManager.cancelResize(tabId);
    });

    // Handle visibility change - sync first, then reconnect
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
            modifierManager.reset();

            try {
                // 1. Reconnect management WebSocket and wait for state sync
                if (!managementService.isConnected()) {
                    await managementService.connect();
                    // After connect() resolves, applyStateSync has been called
                    // tabService.tabs now reflects server state
                }

                // 2. Connect data plane for synced tabs only
                for (const tab of tabService.tabs) {
                    if (!connectionService.isConnected(tab)) {
                        connectionService.connect(tab, true);
                    }
                }
            } catch (e) {
                console.error('Failed to reconnect:', e);
                disconnectOverlay.show();
            }
        } else {
            modifierManager.reset();
        }
    });

    // Handle window blur
    window.addEventListener('blur', () => {
        modifierManager.reset();
    });

    // Keep the whole app inside the visible viewport while the mobile keyboard
    // is open. Android also uses interactive-widget=resizes-content from the
    // viewport meta tag; this remains necessary for iOS and older browsers.
    // Terminal refit is handled by ResizeObserver on terminal-container.
    if (window.visualViewport) {
        const app = document.getElementById('app');
        let viewportFrame: number | null = null;

        const updateAppSize = () => {
            if (!app || viewportFrame !== null) return;

            viewportFrame = requestAnimationFrame(() => {
                viewportFrame = null;
                const viewport = window.visualViewport;
                if (!viewport) return;

                app.style.position = 'fixed';
                app.style.top = `${viewport.offsetTop}px`;
                app.style.left = `${viewport.offsetLeft}px`;
                app.style.width = `${viewport.width}px`;
                app.style.height = `${viewport.height}px`;
                app.style.transform = '';
            });
        };
        window.visualViewport.addEventListener('resize', updateAppSize);
        window.visualViewport.addEventListener('scroll', updateAppSize);
        window.addEventListener('resize', updateAppSize);
        updateAppSize();
    }

    // Focus terminal on container click
    document.getElementById('terminal-container')?.addEventListener('click', focusTerminalIfNotComposing);

    // Connect management WebSocket first
    // Server will send tab_state_sync with existing tabs
    try {
        await managementService.connect();

        // If no tabs after sync, request one
        // Give a short delay for state sync to be processed
        setTimeout(async () => {
            if (tabService.tabs.length === 0) {
                console.log('No tabs from server, creating one');
                await tabService.requestCreateTab();
            }
        }, 100);

        // Update-available popup suppressed: update notifications are handled
        // out-of-band, so we no longer interrupt startup with the overlay.
    } catch (e) {
        console.error('Failed to connect management WebSocket:', e);
        disconnectOverlay.show();
    }

    console.log('Porterminal initialized (backend-driven)');
}

// Helper functions for button setup

function updateModifierButton(modifier: string): void {
    const btn = document.getElementById(`btn-${modifier}`);
    if (!btn) return;

    const modifierManager = (window as unknown as { _modifierManager?: ReturnType<typeof createModifierManager> })._modifierManager;
    if (!modifierManager) return;

    btn.classList.remove('sticky', 'locked');
    const state = modifierManager.getState(modifier as 'ctrl' | 'alt' | 'shift');
    if (state === 'sticky') {
        btn.classList.add('sticky');
    } else if (state === 'locked') {
        btn.classList.add('locked');
    }
}

function setupModifierButtons(modifierManager: ReturnType<typeof createModifierManager>): void {
    (window as unknown as { _modifierManager?: ReturnType<typeof createModifierManager> })._modifierManager = modifierManager;

    for (const mod of ['ctrl', 'alt', 'shift'] as const) {
        const btn = document.getElementById(`btn-${mod}`);
        if (!btn) continue;

        let touchUsed = false;

        btn.addEventListener('touchstart', (e) => {
            touchUsed = true;
            e.preventDefault();
        }, { passive: false });

        btn.addEventListener('touchend', (e) => {
            e.preventDefault();
            modifierManager.handleTap(mod);
        }, { passive: false });

        btn.addEventListener('click', () => {
            if (!touchUsed) {
                modifierManager.handleTap(mod);
            }
            touchUsed = false;
        });
    }
}

function setupEscapeButton(inputHandler: ReturnType<typeof createInputHandler>): void {
    const btn = document.getElementById('btn-escape');
    if (!btn) return;

    let touchUsed = false;
    let lastTapTime = 0;
    const DOUBLE_TAP_MS = 300;

    const handleTap = () => {
        const now = Date.now();
        if (now - lastTapTime < DOUBLE_TAP_MS) {
            inputHandler.sendInput('\x1b\x1b');
        } else {
            inputHandler.sendInput('\x1b');
        }
        lastTapTime = now;
    };

    btn.addEventListener('touchstart', (e) => {
        touchUsed = true;
        e.preventDefault();
    }, { passive: false });

    btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        handleTap();
    }, { passive: false });

    btn.addEventListener('click', () => {
        if (!touchUsed) {
            handleTap();
        }
        touchUsed = false;
    });
}

function setupBackspaceButton(sendBackspace: () => void): void {
    const btn = document.getElementById('btn-backspace');
    if (!btn) return;

    const INITIAL_DELAY = 400;
    const REPEAT_INTERVAL = 50;

    let repeatTimer: ReturnType<typeof setInterval> | null = null;
    let initialTimer: ReturnType<typeof setTimeout> | null = null;
    let isActive = false;

    const startRepeat = () => {
        if (isActive) return;
        isActive = true;
        sendBackspace();

        initialTimer = setTimeout(() => {
            repeatTimer = setInterval(sendBackspace, REPEAT_INTERVAL);
        }, INITIAL_DELAY);
    };

    const stopRepeat = () => {
        isActive = false;
        if (initialTimer) {
            clearTimeout(initialTimer);
            initialTimer = null;
        }
        if (repeatTimer) {
            clearInterval(repeatTimer);
            repeatTimer = null;
        }
    };

    btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        startRepeat();
    }, { passive: false });

    btn.addEventListener('pointerup', (e) => {
        e.preventDefault();
        stopRepeat();
    }, { passive: false });

    btn.addEventListener('pointercancel', stopRepeat);
    btn.addEventListener('pointerleave', stopRepeat);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

/**
 * Setup a button with touch/click handling that prevents double-triggering.
 * NOT suitable for: hold-to-repeat, custom event types, or state machines.
 */
function setupTapButton(
    buttonId: string,
    onAction: () => void | Promise<void>,
    options: { preventDefault?: boolean } = {}
): void {
    const btn = document.getElementById(buttonId);
    if (!btn) return;

    let touchUsed = false;
    const { preventDefault = true } = options;

    btn.addEventListener('touchstart', (e) => {
        touchUsed = true;
        if (preventDefault) e.preventDefault();
    }, { passive: !preventDefault });

    btn.addEventListener('touchend', (e) => {
        if (preventDefault) e.preventDefault();
        void onAction();
    }, { passive: !preventDefault });

    btn.addEventListener('click', () => {
        if (!touchUsed) {
            void onAction();
        }
        touchUsed = false;
    });
}

function setupPasteButton(doPaste: () => Promise<void>): void {
    setupTapButton('btn-paste', doPaste);
}

function setupToolButtons(
    inputHandler: ReturnType<typeof createInputHandler>
): void {
    let touchUsed = false;

    document.querySelectorAll('.tool-btn').forEach(btn => {
        const el = btn as HTMLButtonElement;
        if (el.dataset.bound) return;
        el.dataset.bound = 'true';

        if (el.id === 'btn-ctrl' || el.id === 'btn-alt' ||
            el.id === 'btn-escape' || el.id === 'btn-paste' ||
            el.id === 'btn-backspace' || el.id === 'btn-shutdown') {
            return;
        }

        const action = async () => {
            if (el.dataset.key) {
                inputHandler.handleKeyButton(el.dataset.key);
            } else if (el.dataset.send) {
                // Parse JSON array of strings/numbers
                const items: Array<string | number> = JSON.parse(el.dataset.send);
                for (const item of items) {
                    if (typeof item === 'number') {
                        // Number = wait ms
                        await new Promise(r => setTimeout(r, item));
                    } else {
                        // String = decode and send
                        const decoded = item
                            .replace(/\{CR\}/g, '\r')
                            .replace(/\{LF\}/g, '\n')
                            .replace(/\{ESC\}/g, '\x1b');
                        inputHandler.sendInput(decoded);
                    }
                }
                // Don't call focusTerminal() - soft keyboard buttons should
                // respect the current native keyboard state (iOS fix)
            }
        };

        let touchInside = false;

        el.addEventListener('touchstart', (e) => {
            touchUsed = true;
            touchInside = true;
            e.preventDefault();
        }, { passive: false });

        el.addEventListener('touchmove', (e) => {
            if (!touchInside) return;
            const touch = e.touches[0];
            if (!touch) return;
            const rect = el.getBoundingClientRect();
            if (touch.clientX < rect.left || touch.clientX > rect.right ||
                touch.clientY < rect.top || touch.clientY > rect.bottom) {
                touchInside = false;
            }
        }, { passive: true });

        el.addEventListener('touchend', (e) => {
            e.preventDefault();
            if (touchInside) {
                action();
            }
            touchInside = false;
        }, { passive: false });

        el.addEventListener('click', () => {
            if (!touchUsed) {
                action();
            }
            touchUsed = false;
        });
    });
}

function setupShutdownButton(disconnectOverlay: ReturnType<typeof createDisconnectOverlay>): void {
    const btn = document.getElementById('btn-shutdown');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        // Hide keyboard on mobile
        (document.activeElement as HTMLElement)?.blur();

        if (confirm('Shutdown server and tunnel?\n\nThis will terminate all sessions.')) {
            try {
                const response = await fetch('/api/shutdown', { method: 'POST' });
                if (response.ok) {
                    disconnectOverlay.setText('Server Shutdown');
                    disconnectOverlay.show();
                } else {
                    const data = await response.json().catch(() => ({}));
                    showToast(document.body, 'settings-toast', data.error || `Shutdown failed (${response.status})`, 'error');
                }
            } catch (e) {
                showToast(document.body, 'settings-toast', 'Shutdown failed — server unreachable', 'error');
            }
        }
    });
}

function setupHelpButton(): void {
    const btn = document.getElementById('btn-info');
    const overlay = document.getElementById('help-overlay');
    const closeBtn = document.getElementById('help-close');

    if (!btn || !overlay) return;

    const show = () => overlay.classList.remove('hidden');
    const hide = () => overlay.classList.add('hidden');

    btn.addEventListener('click', show);
    closeBtn?.addEventListener('click', hide);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) hide();
    });
}

function setupSnippetsButton(openSnippets: () => void): void {
    setupTapButton('btn-snippets', openSnippets);
}

function setupDesktopToolbarAutohide(): void {
    const app = document.getElementById('app');
    const hoverZone = document.getElementById('top-hover-zone');
    const topBar = document.getElementById('top-bar');
    const btn = document.getElementById('btn-toolbar-autohide') as HTMLButtonElement | null;
    if (!app || !hoverZone || !topBar || !btn) return;

    const desktopQuery = window.matchMedia('(pointer: fine) and (min-width: 768px)');
    let autohide = getDesktopToolbarAutohide();
    let revealTimer: ReturnType<typeof setTimeout> | null = null;

    const setRevealed = (revealed: boolean): void => {
        if (!desktopQuery.matches || !autohide) {
            app.classList.remove('desktop-toolbar-revealed');
            return;
        }
        app.classList.toggle('desktop-toolbar-revealed', revealed);
    };

    const scheduleHide = (): void => {
        if (revealTimer) clearTimeout(revealTimer);
        revealTimer = setTimeout(() => {
            if (!topBar.matches(':hover') && !hoverZone.matches(':hover')) {
                setRevealed(false);
            }
        }, 900);
    };

    const applyState = (): void => {
        const enabled = desktopQuery.matches && autohide;
        app.classList.toggle('desktop-toolbar-autohide', enabled);
        btn.classList.toggle('active', autohide);
        btn.setAttribute('aria-pressed', autohide ? 'true' : 'false');
        btn.setAttribute(
            'aria-label',
            autohide ? 'Pin desktop top bar' : 'Unpin desktop top bar',
        );
        btn.title = autohide
            ? 'Desktop top bar autohide on. Click to pin.'
            : 'Desktop top bar pinned. Click to autohide.';
        if (!enabled) {
            app.classList.remove('desktop-toolbar-revealed');
        }
    };

    btn.addEventListener('click', () => {
        autohide = !autohide;
        setDesktopToolbarAutohide(autohide);
        applyState();
        if (autohide) {
            setRevealed(true);
            scheduleHide();
        }
    });

    hoverZone.addEventListener('mouseenter', () => setRevealed(true));
    hoverZone.addEventListener('mouseleave', scheduleHide);
    topBar.addEventListener('mouseenter', () => setRevealed(true));
    topBar.addEventListener('mouseleave', scheduleHide);

    desktopQuery.addEventListener('change', applyState);
    applyState();
}

function setupSettingsButton(
    settingsOverlay: ReturnType<typeof createSettingsOverlay>,
    getConfig: () => AppConfig
): void {
    const btn = document.getElementById('btn-settings');
    if (!btn) return;

    btn.addEventListener('click', () => {
        settingsOverlay.show(getConfig());
    });
}

/**
 * Apply button visibility from localStorage
 * Hides buttons whose labels are in the disabled list
 */
function applyButtonVisibility(): void {
    const disabledButtons = getDisabledButtons();
    // Find all custom buttons (they have data-send attribute)
    document.querySelectorAll('.tool-btn[data-send]').forEach(btn => {
        const el = btn as HTMLElement;
        const label = el.textContent?.trim() || '';
        el.style.display = disabledButtons.includes(label) ? 'none' : '';
    });
}

function setupTextViewButton(
    textViewOverlay: ReturnType<typeof createTextViewOverlay>,
    getTerminal: () => import('@xterm/xterm').Terminal | null,
    refreshTerminal: () => void
): void {
    setupTapButton('btn-textview', () => {
        const term = getTerminal();
        if (term) {
            textViewOverlay.show(term);
        }
    }, { preventDefault: false });

    // Force terminal refresh when overlay closes to repaint from buffer
    const closeBtn = document.getElementById('textview-close');
    const overlay = document.getElementById('textview-overlay');

    const onClose = () => {
        textViewOverlay.hide();
        refreshTerminal();
    };

    closeBtn?.addEventListener('click', onClose);
    overlay?.addEventListener('click', (e) => {
        if (e.target === overlay) onClose();
    });
}

// Start the app
document.addEventListener('DOMContentLoaded', () => {
    void init();
});
