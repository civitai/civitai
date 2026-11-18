/** How long the skill-check ruling stays up untouched; it holds the answers until it goes. */
export const RULING_AUTO_HIDE_MS = 8000;
/** How long the level-up card stays up untouched. */
export const LEVEL_AUTO_HIDE_MS = 6000;

/**
 * Calls `onHide` once, `ms` after the last hold was released (hover, focus, a hidden tab, a dialog, an error shown).
 * Each release starts the full time again; releasing what was not held changes nothing.
 */
export function createAutoHide(ms: number, onHide: () => void, held: Iterable<string> = []) {
  const holds = new Set(held);
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    if (done || holds.size > 0) return;
    timer = setTimeout(() => {
      done = true;
      onHide();
    }, ms);
  };
  run();
  return {
    hold(reason: string, on: boolean) {
      if (holds.has(reason) === on) return;
      if (on) holds.add(reason);
      else holds.delete(reason);
      run();
    },
    stop() {
      done = true;
      clearTimeout(timer);
    },
  };
}

type AutoHideOptions = {
  ms: number;
  onhide: () => void;
  /** The element to focus on mount, unless focus is in a dialog; given before listening, so it holds nothing by itself. */
  focus?: string;
  /** A failed dismissal's error is showing: wait for the player rather than retrying. */
  held?: boolean;
};

const MODAL = '[role="dialog"][aria-modal="true"]';

/**
 * Svelte action: hides the notice after `ms` through `onhide` (its dismiss form, so it takes the same path as a click),
 * waiting while the pointer or focus is inside, the tab is hidden, or a dialog covers the page.
 */
export function autoHide(node: HTMLElement, opts: AutoHideOptions) {
  if (opts.focus && !document.activeElement?.closest('[role="dialog"]')) {
    node.querySelector<HTMLElement>(opts.focus)?.focus({ preventScroll: true });
  }
  const dialogUp = () => !!document.querySelector(MODAL);
  const initial = [
    ...(opts.held ? ['message'] : []),
    ...(document.hidden ? ['hidden'] : []),
    ...(dialogUp() ? ['dialog'] : []),
  ];
  const timer = createAutoHide(opts.ms, () => opts.onhide(), initial);
  const enter = () => timer.hold('hover', true);
  const leave = () => timer.hold('hover', false);
  const focusin = () => timer.hold('focus', true);
  const focusout = (event: FocusEvent) => {
    if (!node.contains(event.relatedTarget as Node | null)) timer.hold('focus', false);
  };
  const visibility = () => timer.hold('hidden', document.hidden);
  const dialogs = new MutationObserver(() => timer.hold('dialog', dialogUp()));
  dialogs.observe(document.body, {
    childList: true,
    subtree: true,
    attributeFilter: ['aria-modal'],
  });
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('focusin', focusin);
  node.addEventListener('focusout', focusout);
  document.addEventListener('visibilitychange', visibility);
  return {
    update(next: AutoHideOptions) {
      timer.hold('message', !!next.held);
    },
    destroy() {
      timer.stop();
      dialogs.disconnect();
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('focusin', focusin);
      node.removeEventListener('focusout', focusout);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
