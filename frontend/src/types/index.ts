/**
 * Shared type definitions for Porterminal
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export interface TerminalGrid {
    cols: number;
    rows: number;
}

/** Tab state */
export interface Tab {
    id: number;                  // Local numeric ID for UI
    tabId: string | null;        // Server-assigned UUID
    shellId: string;
    term: Terminal;
    fitAddon: FitAddon;
    container: HTMLElement;
    ws: WebSocket | null;
    sessionId: string | null;
    heartbeatInterval: ReturnType<typeof setInterval> | null;
    reconnectAttempts: number;
    fixedGrid: TerminalGrid | null;
    fixedGridBaseScale: number;
    fixedGridBaseScreenWidth: number;
    fixedGridBaseScreenHeight: number;
    /** Fitted font size at zoom 1; zoom re-rasterises from this for crisp text. */
    fixedGridBaseFontSize: number;
    /** `<cw>x<ch>:<cols>x<rows>` of the last fit; lets switches skip re-fitting. */
    fixedGridFitSignature: string;
    fixedGridZoom: number;
    fixedGridPanX: number;
    fixedGridPanY: number;
    /** CSS scale and content size of the last render, reused for cheap panning. */
    fixedGridRenderScale: number;
    fixedGridContentWidth: number;
    fixedGridContentHeight: number;
    fontSizeBeforeFixedGrid: number | null;
    cursorBlinkBeforeFixedGrid: boolean | null;
}

/** Server tab info from tab_list message */
export interface ServerTab {
    id: string;                  // Server UUID
    session_id: string;
    shell_id: string;
    name: string;
    created_at: string;
    last_accessed: string;
}

/** Connection state machine */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

/** Modifier key state */
export type ModifierMode = 'off' | 'sticky' | 'locked';

export interface ModifierState {
    ctrl: ModifierMode;
    alt: ModifierMode;
    shift: ModifierMode;
}

/** Shell configuration from server */
export interface ShellConfig {
    id: string;
    name: string;
}

/** Button send value: string or array of strings/numbers (numbers = wait ms) */
export type ButtonSend = string | Array<string | number>;

/** Button configuration */
export interface ButtonConfig {
    label: string;
    send: ButtonSend;
    row?: number;
}

/** Command snippet from snippets file */
export interface Snippet {
    name: string;
    command: string;
}

/** App configuration from /api/config */
export interface AppConfig {
    shells: ShellConfig[];
    default_shell: string;
    buttons?: ButtonConfig[];
    snippets?: Snippet[];
    compose_mode?: boolean;  // Server default for compose mode
    // Version and update info
    version?: string;
    update_available?: boolean;
    latest_version?: string | null;
    upgrade_command?: string | null;
    // Settings
    password_protected?: boolean;
    notify_on_startup?: boolean;
}

/** Terminal position */
export interface TerminalPosition {
    col: number;
    row: number;
}

/** WebSocket message types */
export interface SessionInfoMessage {
    type: 'session_info';
    session_id: string;
    shell?: string;
    tab_id?: string | null;
    cols?: number;
    rows?: number;
    zellij_size_lock?: TerminalGrid;
}

export interface PingMessage {
    type: 'ping';
}

export interface PongMessage {
    type: 'pong';
}

export interface ErrorMessage {
    type: 'error';
    message: string;
}

export interface ResizeMessage {
    type: 'resize';
    cols: number;
    rows: number;
}

/** Tab sync messages from server */
export interface TabListMessage {
    type: 'tab_list';
    tabs: ServerTab[];
    timestamp: string;
}

export interface TabCreatedMessage {
    type: 'tab_created';
    tab: ServerTab;
}

export interface TabClosedMessage {
    type: 'tab_closed';
    tab_id: string;
    reason: string;
}

/** Management WebSocket message types */

/** Tab state change */
export interface TabChange {
    action: 'add' | 'remove' | 'update';
    tab_id: string;
    tab?: ServerTab;
    reason?: string;
}

/** Full state sync from server */
export interface TabStateSyncMessage {
    type: 'tab_state_sync';
    tabs: ServerTab[];
}

/** Incremental state update from server */
export interface TabStateUpdateMessage {
    type: 'tab_state_update';
    changes: TabChange[];
}

/** Response to create_tab request */
export interface CreateTabResponse {
    type: 'create_tab_response';
    request_id: string;
    success: boolean;
    tab?: ServerTab;
    error?: string;
}

/** Response to close_tab request */
export interface CloseTabResponse {
    type: 'close_tab_response';
    request_id: string;
    success: boolean;
    error?: string;
}

/** Authentication messages */
export interface AuthRequiredMessage {
    type: 'auth_required';
}

export interface AuthSuccessMessage {
    type: 'auth_success';
}

export interface AuthFailedMessage {
    type: 'auth_failed';
    attempts_remaining: number;
    error?: string;
}

export interface AuthMessage {
    type: 'auth';
    password: string;
}

/** Response to show_url request */
export interface ShowUrlResponse {
    type: 'show_url_response';
    request_id: string;
    success: boolean;
    visible: boolean;
}

export type ManagementMessage =
    | TabStateSyncMessage
    | TabStateUpdateMessage
    | CreateTabResponse
    | CloseTabResponse
    | ShowUrlResponse
    | PongMessage
    | AuthRequiredMessage
    | AuthSuccessMessage
    | AuthFailedMessage;
