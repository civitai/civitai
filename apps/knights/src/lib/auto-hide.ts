/** How long the skill-check ruling stays up untouched; it holds the answers until it goes. */
export const RULING_AUTO_HIDE_MS = 8000;
/** How long the level-up card stays up untouched. */
export const LEVEL_AUTO_HIDE_MS = 6000;

/** Calls `onHide` once, `ms` after it was last neither hovered nor focused. */
export function createAutoHide(ms: number, onHide: () => void) {
  let hovered = false;
  let focused = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    if (done || hovered || focused) return;
    timer = setTimeout(() => {
      done = true;
      onHide();
    }, ms);
  };
  run();
  return {
    hover(on: boolean) {
      hovered = on;
      run();
    },
    focus(on: boolean) {
      focused = on;
      run();
    },
    stop() {
      done = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Svelte action: hides the notice after `ms` through `onhide` (its dismiss form, so it takes the same path as a click),
 * waiting while the pointer or focus is inside. `focus` names the element to focus on mount; that focus is given before
 * listening, so it does not hold the timer by itself.
 */
export function autoHide(
  node: HTMLElement,
  opts: { ms: number; onhide: () => void; focus?: string }
) {
  if (opts.focus) node.querySelector<HTMLElement>(opts.focus)?.focus({ preventScroll: true });
  const timer = createAutoHide(opts.ms, () => opts.onhide());
  const enter = () => timer.hover(true);
  const leave = () => timer.hover(false);
  const focusin = () => timer.focus(true);
  const focusout = (event: FocusEvent) => {
    if (!node.contains(event.relatedTarget as Node | null)) timer.focus(false);
  };
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('focusin', focusin);
  node.addEventListener('focusout', focusout);
  return {
    destroy() {
      timer.stop();
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('focusin', focusin);
      node.removeEventListener('focusout', focusout);
    },
  };
}
