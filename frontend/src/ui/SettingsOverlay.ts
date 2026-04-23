/**
 * Settings Overlay - Settings panel UI
 * Provides toggles for compose mode, update notifications, and custom button visibility
 */

import type { AppConfig } from '@/types';
import type { ConfigService } from '@/services/ConfigService';
import type { ManagementService } from '@/services/ManagementService';
import {
    applyTheme,
    getComposeMode,
    getLightMode,
    setComposeMode,
    setLightMode,
} from '@/utils/storage';
import { showToast as _showToast } from '@/utils/toast';

export interface SettingsCallbacks {
    onComposeModeChange: (enabled: boolean) => void;
    onThemeChange?: () => void;
}

export interface SettingsOverlay {
    /** Show the settings overlay */
    show(config: AppConfig): void;
    /** Hide the overlay */
    hide(): void;
    /** Setup event handlers and wire callbacks */
    setup(configService: ConfigService, managementService: ManagementService, callbacks: SettingsCallbacks): void;
    /** Sync compose mode state (for external changes) */
    syncComposeMode(enabled: boolean): void;
}

/** Create a debounced function that delays invocation */
function debounce(fn: () => void, delay: number): () => void {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(fn, delay);
    };
}


function showToast(message: string, type: 'success' | 'error' = 'success'): void {
    _showToast(document.body, 'settings-toast', message, type);
}

/**
 * Create a settings overlay controller
 */
export function createSettingsOverlay(): SettingsOverlay {
    const overlay = document.getElementById('settings-overlay');
    const content = document.getElementById('settings-content');
    const closeBtn = document.getElementById('settings-close');
    const composeToggle = document.getElementById('settings-compose') as HTMLInputElement | null;
    const updatesToggle = document.getElementById('settings-updates') as HTMLInputElement | null;
    const lightModeToggle = document.getElementById('settings-light-mode') as HTMLInputElement | null;
    const passwordStatus = document.getElementById('settings-password-status');

    // Password elements
    const requirePasswordToggle = document.getElementById('settings-require-password') as HTMLInputElement | null;
    const setPasswordBtn = document.getElementById('settings-set-password') as HTMLButtonElement | null;
    const clearPasswordBtn = document.getElementById('settings-clear-password') as HTMLButtonElement | null;
    const passwordForm = document.getElementById('settings-password-form');
    const passwordInput = document.getElementById('settings-password-input') as HTMLInputElement | null;
    const passwordConfirm = document.getElementById('settings-password-confirm') as HTMLInputElement | null;
    const passwordSaveBtn = document.getElementById('settings-password-save') as HTMLButtonElement | null;
    const passwordCancelBtn = document.getElementById('settings-password-cancel') as HTMLButtonElement | null;
    const restartNotice = document.getElementById('settings-restart-notice');

    // URL visibility toggle
    const showUrlToggle = document.getElementById('settings-show-url') as HTMLInputElement | null;

    let callbacks: SettingsCallbacks | null = null;
    let configService: ConfigService | null = null;
    let managementService: ManagementService | null = null;
    let focusTrap: (() => void) | null = null;
    let needsRestart = false;

    /** Save notification setting to server (debounced) */
    const saveNotificationSetting = debounce(async () => {
        if (!configService || !updatesToggle) return;
        const result = await configService.updateSettings({
            notify_on_startup: updatesToggle.checked,
        });
        showToast(result.success ? 'Saved' : (result.error || 'Failed, try refresh'),
            result.success ? 'success' : 'error');
    }, 300);

    /** Update password UI state based on status */
    function updatePasswordUI(passwordSaved: boolean, requirePassword: boolean, currentlyProtected: boolean): void {
        // Update status text - only show when active or pending
        if (passwordStatus) {
            if (currentlyProtected) {
                passwordStatus.textContent = 'Active';
                passwordStatus.className = 'settings-desc password-on';
            } else if (requirePassword) {
                passwordStatus.textContent = 'Restart needed';
                passwordStatus.className = 'settings-desc password-on';
            } else {
                passwordStatus.textContent = '';
                passwordStatus.className = 'settings-desc';
            }
        }

        // Update toggle
        if (requirePasswordToggle) {
            requirePasswordToggle.checked = requirePassword;
        }

        // Update Edit link text
        if (setPasswordBtn) {
            setPasswordBtn.textContent = passwordSaved ? 'Edit' : 'Set';
        }

        // Show Clear button only when password is saved
        if (clearPasswordBtn) {
            clearPasswordBtn.classList.toggle('hidden', !passwordSaved);
        }

        // Show restart notice if needed
        if (restartNotice) {
            restartNotice.classList.toggle('hidden', !needsRestart);
        }
    }

    /** Fetch and update password status */
    async function refreshPasswordStatus(): Promise<void> {
        if (!configService) return;
        const status = await configService.getPasswordStatus();
        updatePasswordUI(status.password_saved, status.require_password, status.currently_protected);
    }

    /** Show/hide password form */
    function showPasswordForm(show: boolean): void {
        passwordForm?.classList.toggle('hidden', !show);
        if (show && passwordInput) {
            passwordInput.value = '';
            if (passwordConfirm) passwordConfirm.value = '';
            passwordInput.focus();
        }
    }

    /** Handle password save */
    async function handlePasswordSave(): Promise<void> {
        if (!configService || !passwordInput || !passwordConfirm) return;

        const password = passwordInput.value;
        const confirm = passwordConfirm.value;

        if (!password) {
            showToast('Password required', 'error');
            return;
        }
        if (password !== confirm) {
            showToast('Passwords do not match', 'error');
            passwordConfirm.focus();
            return;
        }

        const result = await configService.setPassword(password);
        if (result.success) {
            showToast('Password saved');
            needsRestart = true;
            showPasswordForm(false);
            await refreshPasswordStatus();
        } else {
            showToast(result.error || 'Failed, try refresh', 'error');
        }
    }

    /** Handle password clear */
    async function handlePasswordClear(): Promise<void> {
        if (!configService) return;

        const result = await configService.clearPassword();
        if (result.success) {
            showToast('Password cleared');
            needsRestart = true;
            await refreshPasswordStatus();
        } else {
            showToast(result.error || 'Failed, try refresh', 'error');
        }
    }

    /** Handle require password toggle */
    async function handleRequirePasswordToggle(): Promise<void> {
        if (!configService || !requirePasswordToggle) return;

        const result = await configService.setRequirePassword(requirePasswordToggle.checked);
        if (result.success) {
            showToast(requirePasswordToggle.checked ? 'Password required' : 'Password optional');
            needsRestart = true;
            await refreshPasswordStatus();
        } else {
            // Revert toggle on failure
            requirePasswordToggle.checked = !requirePasswordToggle.checked;
            showToast(result.error || 'Failed, try refresh', 'error');
        }
    }

    /** Handle show URL toggle */
    async function handleShowUrlToggle(): Promise<void> {
        if (!managementService || !showUrlToggle) return;

        try {
            const visible = await managementService.setUrlVisibility(showUrlToggle.checked);
            showToast(visible ? 'URL visible' : 'URL hidden');
        } catch {
            // Revert toggle on failure
            showUrlToggle.checked = !showUrlToggle.checked;
            showToast('Failed, try refresh', 'error');
        }
    }

    /** Setup focus trap for accessibility */
    function setupFocusTrap(): () => void {
        if (!content) return () => {};

        const focusableSelector = 'button, input, [tabindex]:not([tabindex="-1"])';
        const focusableElements = content.querySelectorAll<HTMLElement>(focusableSelector);
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];

        const handleKeydown = (e: KeyboardEvent) => {
            if (e.key === 'Tab') {
                if (e.shiftKey) {
                    if (document.activeElement === firstFocusable) {
                        e.preventDefault();
                        lastFocusable?.focus();
                    }
                } else {
                    if (document.activeElement === lastFocusable) {
                        e.preventDefault();
                        firstFocusable?.focus();
                    }
                }
            }
        };

        content.addEventListener('keydown', handleKeydown);
        return () => content.removeEventListener('keydown', handleKeydown);
    }

    return {
        show(config: AppConfig): void {
            // Update compose mode toggle
            if (composeToggle) {
                const localPref = getComposeMode();
                composeToggle.checked = localPref !== null ? localPref : (config.compose_mode ?? false);
            }

            // Update notifications toggle
            if (updatesToggle) {
                updatesToggle.checked = config.notify_on_startup ?? true;
            }

            if (lightModeToggle) {
                lightModeToggle.checked = getLightMode();
            }

            // Fetch and update password status
            refreshPasswordStatus();

            // Hide password form initially
            showPasswordForm(false);

            // Show overlay
            overlay?.classList.remove('hidden');

            // Setup focus trap
            focusTrap = setupFocusTrap();

            // Focus close button
            closeBtn?.focus();
        },

        hide(): void {
            overlay?.classList.add('hidden');
            focusTrap?.();
            focusTrap = null;
        },

        syncComposeMode(enabled: boolean): void {
            if (composeToggle) {
                composeToggle.checked = enabled;
            }
        },

        setup(service: ConfigService, mgmtService: ManagementService, cbs: SettingsCallbacks): void {
            configService = service;
            managementService = mgmtService;
            callbacks = cbs;

            // Close button
            closeBtn?.addEventListener('click', () => this.hide());

            // Click outside to close
            overlay?.addEventListener('click', (e) => {
                if (e.target === overlay) this.hide();
            });

            // Escape key to close
            const handleEscape = (e: KeyboardEvent) => {
                if (e.key === 'Escape' && !overlay?.classList.contains('hidden')) {
                    e.preventDefault();
                    this.hide();
                }
            };
            document.addEventListener('keydown', handleEscape);

            // Compose mode toggle
            composeToggle?.addEventListener('change', () => {
                const enabled = composeToggle.checked;
                setComposeMode(enabled);
                callbacks?.onComposeModeChange(enabled);
            });

            // Update notifications toggle
            updatesToggle?.addEventListener('change', saveNotificationSetting);

            // Theme toggle
            lightModeToggle?.addEventListener('change', () => {
                const enabled = lightModeToggle.checked;
                setLightMode(enabled);
                applyTheme(enabled);
                callbacks?.onThemeChange?.();
            });

            // Password management
            requirePasswordToggle?.addEventListener('change', handleRequirePasswordToggle);
            setPasswordBtn?.addEventListener('click', () => showPasswordForm(true));
            clearPasswordBtn?.addEventListener('click', handlePasswordClear);
            passwordSaveBtn?.addEventListener('click', handlePasswordSave);
            passwordCancelBtn?.addEventListener('click', () => showPasswordForm(false));

            // URL visibility toggle
            showUrlToggle?.addEventListener('change', handleShowUrlToggle);

            // Enter key to save password
            passwordConfirm?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handlePasswordSave();
                }
            });
            passwordInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    passwordConfirm?.focus();
                }
            });
        },
    };
}
