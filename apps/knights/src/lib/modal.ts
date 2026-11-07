const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The control Tab or Shift+Tab must be sent to so focus stays in a dialog, or null when the browser's own move stays inside. */
export function trapTarget(current: number, count: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (current === -1) return backwards ? count - 1 : 0;
  if (!backwards && current === count - 1) return 0;
  if (backwards && current === 0) return count - 1;
  return null;
}

/**
 * A dialog's keyboard contract: focus moves in on open (to `[data-autofocus]`, else the first control), Tab stays
 * inside, Escape calls `onescape`, and focus returns to what had it when the dialog closes.
 */
export function modal(node: HTMLElement, options: { onescape?: () => void } = {}) {
  let current = options;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const controls = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];

  (node.querySelector<HTMLElement>('[data-autofocus]') ?? controls()[0] ?? node).focus();

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      current.onescape?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const all = controls();
    const target = trapTarget(
      all.indexOf(document.activeElement as HTMLElement),
      all.length,
      event.shiftKey
    );
    if (target === null && all.length > 0) return;
    event.preventDefault();
    (target === null ? node : all[target]).focus();
  }

  window.addEventListener('keydown', onkeydown);
  return {
    update: (next: { onescape?: () => void }) => (current = next),
    destroy() {
      window.removeEventListener('keydown', onkeydown);
      if (opener?.isConnected) opener.focus();
    },
  };
}
