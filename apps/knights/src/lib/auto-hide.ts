/** How long the skill-check ruling stays up untouched. */
export const RULING_AUTO_HIDE_MS = 8000;
/** How long the level-up card stays up untouched. */
export const LEVEL_AUTO_HIDE_MS = 6000;

/**
 * Calls `onHide` once the notice has gone `ms` unheld (hover, focus, a hidden tab, a dialog, an error shown). A hold pauses
 * the time and a release resumes what was left, so the countdown bar, paused alongside, always agrees with it; releasing
 * what was not held changes nothing. `onpause` hears every switch between running and paused.
 */
export function createAutoHide(
  ms: number,
  onHide: () => void,
  opts: { held?: Iterable<string>; onpause?: (paused: boolean) => void } = {}
) {
  const holds = new Set(opts.held ?? []);
  let remaining = ms;
  let startedAt = 0;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    startedAt = Date.now();
    timer = setTimeout(() => {
      done = true;
      onHide();
    }, remaining);
  };
  if (holds.size === 0) start();
  return {
    get paused() {
      return holds.size > 0;
    },
    hold(reason: string, on: boolean) {
      if (done || holds.has(reason) === on) return;
      const wasPaused = holds.size > 0;
      if (on) holds.add(reason);
      else holds.delete(reason);
      const paused = holds.size > 0;
      if (paused === wasPaused) return;
      if (paused) {
        clearTimeout(timer);
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      } else {
        start();
      }
      opts.onpause?.(paused);
    },
    stop() {
      done = true;
      clearTimeout(timer);
    },
  };
}

/** The custom properties a countdown bar animates by: the full delay, and paused exactly while the timer is. */
export const countdownStyle = (ms: number, paused: boolean) => ({
  '--auto-hide-ms': `${ms}ms`,
  '--auto-hide-state': paused ? 'paused' : 'running',
});

type AutoHideOptions = {
  ms: number;
  onhide: () => void;
  /** A failed dismissal's error is showing: wait for the player rather than retrying. */
  held?: boolean;
};

const MODAL = '[role="dialog"][aria-modal="true"]';

/**
 * Svelte action: hides the notice after `ms` through `onhide` (its dismiss form, so it takes the same path as a click),
 * waiting while the pointer or focus is inside, the tab is hidden, or a dialog covers the page. It sets `countdownStyle`
 * on the node for a `.countdown` bar inside it.
 */
export function autoHide(node: HTMLElement, opts: AutoHideOptions) {
  const dialogUp = () => !!document.querySelector(MODAL);
  const initial = [
    ...(opts.held ? ['message'] : []),
    ...(document.hidden ? ['hidden'] : []),
    ...(dialogUp() ? ['dialog'] : []),
  ];
  const paint = (paused: boolean) => {
    for (const [name, value] of Object.entries(countdownStyle(opts.ms, paused)))
      node.style.setProperty(name, value);
  };
  const timer = createAutoHide(opts.ms, () => opts.onhide(), { held: initial, onpause: paint });
  paint(timer.paused);
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
