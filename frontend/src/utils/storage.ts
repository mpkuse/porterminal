/**
 * Storage utilities for authentication
 */

const STORAGE_PREFIX = 'ptn_auth_';
const CLIENT_TAB_ID_KEY = 'ptn_client_tab_id';

function getStorageKey(): string {
    // Simple hash of origin for uniqueness across different tunnel URLs
    const origin = window.location.origin;
    let hash = 0;
    for (let i = 0; i < origin.length; i++) {
        const char = origin.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return `${STORAGE_PREFIX}${Math.abs(hash).toString(36)}`;
}

export function getSavedPassword(): string | null {
    try {
        return localStorage.getItem(getStorageKey());
    } catch {
        return null;
    }
}

export function savePassword(password: string): void {
    try {
        localStorage.setItem(getStorageKey(), password);
    } catch {
        // localStorage may be unavailable in some contexts
    }
}

export function clearPassword(): void {
    try {
        localStorage.removeItem(getStorageKey());
    } catch {
        // Ignore errors
    }
}

function generateClientTabId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Get a stable ID for the current browser tab.
 * Uses sessionStorage so reloads keep the same workspace, while a new tab gets a new one.
 */
export function getClientTabId(): string {
    try {
        const existing = sessionStorage.getItem(CLIENT_TAB_ID_KEY);
        if (existing) {
            return existing;
        }

        const generated = generateClientTabId();
        sessionStorage.setItem(CLIENT_TAB_ID_KEY, generated);
        return generated;
    } catch {
        return generateClientTabId();
    }
}

// ========== Compose Mode Storage ==========

const COMPOSE_MODE_KEY = 'ptn_compose_mode';
const LIGHT_MODE_KEY = 'ptn_light_mode';
const TERMINAL_FONT_SIZE_KEY = 'ptn_terminal_font_size';
const DESKTOP_TOOLBAR_AUTOHIDE_KEY = 'ptn_desktop_toolbar_autohide';

/**
 * Check if user has explicitly set a compose mode preference.
 * Returns true if user has toggled compose mode at least once.
 */
export function hasComposeModePreference(): boolean {
    try {
        return localStorage.getItem(COMPOSE_MODE_KEY) !== null;
    } catch {
        return false;
    }
}

/**
 * Get compose mode from localStorage.
 * Returns null if no preference has been set (use server default).
 */
export function getComposeMode(): boolean | null {
    try {
        const value = localStorage.getItem(COMPOSE_MODE_KEY);
        if (value === null) return null;
        return value === 'true';
    } catch {
        return null;
    }
}

export function setComposeMode(enabled: boolean): void {
    try {
        // Always store the explicit value so user preference takes precedence
        localStorage.setItem(COMPOSE_MODE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Ignore errors
    }
}

// ========== Theme Storage ==========

export function getLightMode(): boolean {
    try {
        return localStorage.getItem(LIGHT_MODE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setLightMode(enabled: boolean): void {
    try {
        localStorage.setItem(LIGHT_MODE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Ignore errors
    }
}

export function applyTheme(lightMode: boolean): void {
    document.documentElement.dataset.theme = lightMode ? 'light' : 'dark';
}

// ========== Terminal Font Size Storage ==========

export const DEFAULT_TERMINAL_FONT_SIZE = 10;
export const MIN_TERMINAL_FONT_SIZE = 7;
export const MAX_TERMINAL_FONT_SIZE = 20;

export function clampTerminalFontSize(size: number): number {
    return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, size));
}

export function getTerminalFontSize(): number {
    try {
        const value = Number(localStorage.getItem(TERMINAL_FONT_SIZE_KEY));
        if (Number.isFinite(value)) {
            return clampTerminalFontSize(value);
        }
    } catch {
        // Ignore errors
    }
    return DEFAULT_TERMINAL_FONT_SIZE;
}

export function setTerminalFontSize(size: number): void {
    try {
        localStorage.setItem(
            TERMINAL_FONT_SIZE_KEY,
            String(clampTerminalFontSize(size)),
        );
    } catch {
        // Ignore errors
    }
}

// ========== Desktop Toolbar Storage ==========

export function getDesktopToolbarAutohide(): boolean {
    try {
        const value = localStorage.getItem(DESKTOP_TOOLBAR_AUTOHIDE_KEY);
        return value === null ? true : value === 'true';
    } catch {
        return true;
    }
}

export function setDesktopToolbarAutohide(enabled: boolean): void {
    try {
        localStorage.setItem(DESKTOP_TOOLBAR_AUTOHIDE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Ignore errors
    }
}

// ========== Disabled Buttons Storage ==========

const DISABLED_BUTTONS_KEY = 'ptn_disabled_buttons';

/**
 * Get list of disabled button labels from localStorage.
 * These buttons will be hidden in the toolbar.
 */
export function getDisabledButtons(): string[] {
    try {
        const value = localStorage.getItem(DISABLED_BUTTONS_KEY);
        if (!value) return [];
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Set the list of disabled button labels.
 */
export function setDisabledButtons(labels: string[]): void {
    try {
        localStorage.setItem(DISABLED_BUTTONS_KEY, JSON.stringify(labels));
    } catch {
        // Ignore errors
    }
}
