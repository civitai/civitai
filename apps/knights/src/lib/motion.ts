/** Small helpers for the motion the CSS cannot do alone. The keyframes are in src/motion.css. */

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The design's `ease-in-out`, cubic-bezier(0.65, 0, 0.35, 1), approximated for a counter. */
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Counts from one number to another; under reduced motion it lands at once. Returns a cancel function. */
export function tween(
  from: number,
  to: number,
  ms: number,
  onUpdate: (value: number) => void
): () => void {
  if (from === to || ms <= 0 || reducedMotion() || typeof requestAnimationFrame !== 'function') {
    onUpdate(to);
    return () => undefined;
  }
  const start = performance.now();
  let frame = 0;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    onUpdate(from + (to - from) * easeInOut(t));
    if (t < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

/**
 * A milestone's entrance animation is skippable: the first click or key press marks the node, and src/motion.css
 * then drops every animation under it, which leaves the end state. The listeners go when the milestone's time is up.
 */
export function skippable(node: HTMLElement, ms = 1300) {
  const events = ['pointerdown', 'keydown'] as const;
  const stop = () => {
    for (const event of events) window.removeEventListener(event, skip, true);
    clearTimeout(timer);
  };
  function skip() {
    node.setAttribute('data-skipped', '');
    stop();
  }
  const timer = setTimeout(stop, ms);
  for (const event of events) window.addEventListener(event, skip, true);
  return { destroy: stop };
}

/**
 * Marks a node with `data-bump` for one animation each time `value` goes up (never on the first read, never for a drop), so
 * a stylesheet can pulse it. The attribute is dropped and set again after a reflow, which restarts a pulse still running.
 */
export function bump(node: HTMLElement | SVGElement, value: number) {
  let last = value;
  return {
    update(next: number) {
      if (next > last && !reducedMotion()) {
        node.removeAttribute('data-bump');
        void node.getBoundingClientRect();
        node.setAttribute('data-bump', '');
      }
      last = next;
    },
    destroy() {},
  };
}
