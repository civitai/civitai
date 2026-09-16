/** Dismiss a menu the way users expect — Escape or a pointer outside the node — which a native
 * `<details>` doesn't do on its own. Attach to the element that should stay open; the callback runs
 * when a dismissal gesture lands outside it. Listeners are only bound while `enabled` is true. */
export function dismiss(node: HTMLElement, params: { enabled: boolean; onDismiss: () => void }) {
  let current = params;

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') current.onDismiss();
  }
  function onPointer(e: PointerEvent) {
    if (!node.contains(e.target as Node)) current.onDismiss();
  }
  function bind() {
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
  }
  function unbind() {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onPointer);
  }

  if (current.enabled) bind();

  return {
    update(next: { enabled: boolean; onDismiss: () => void }) {
      const was = current.enabled;
      current = next;
      if (next.enabled && !was) bind();
      else if (!next.enabled && was) unbind();
    },
    destroy: unbind,
  };
}
