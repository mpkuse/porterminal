export function showToast(
    container: HTMLElement,
    className: string,
    message: string,
    type: 'success' | 'error' = 'success',
): void {
    container.querySelector(`.${className}`)?.remove();
    const toast = document.createElement('div');
    toast.className = `${className} ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}
