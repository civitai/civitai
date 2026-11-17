import { useEffect, useState } from 'react';

type VisualViewportLike = { height: number; offsetTop: number; scale?: number };

/**
 * A visual viewport shorter than the layout viewport by less than this is not a keyboard: a
 * collapsing URL bar or a scrollbar leaves a sliver between the two. Well under the shortest real
 * on-screen keyboard.
 */
export const KEYBOARD_INSET_MIN_PX = 100;
/** Float tolerance around `scale === 1`. */
const SCALE_TOLERANCE = 0.01;

/**
 * How many CSS px of the layout viewport's bottom edge the visual viewport does not show —
 * in practice, the height of an on-screen keyboard. The app's viewport meta does not opt into
 * `interactive-widget=resizes-content`, so on iOS Safari and current Android Chrome the keyboard
 * shrinks only the VISUAL viewport: a `position: fixed; bottom: 0` sheet stays anchored to the
 * layout viewport and ends up underneath the keyboard.
 *
 * A shrunken visual viewport is not always a keyboard, so two readings count as none:
 * - a pinch-zoomed page (`scale` not 1) — zooming shrinks the visual viewport by itself, and the
 *   gap then changes with every pan;
 * - a visual viewport less than {@link KEYBOARD_INSET_MIN_PX} shorter than the layout viewport.
 *
 * That floor is on the keyboard's HEIGHT (`layoutHeight - viewport.height`), not on what is
 * returned. Once a keyboard is up, the result is whatever part of it still overlaps the layout
 * viewport's bottom after a pan (`offsetTop`), however small, so the element tracks a pan
 * continuously instead of dropping under the keyboard when the remainder gets short.
 *
 * `0` as well whenever the numbers are unusable, so a missing or odd reading leaves the element
 * where it would have been without this.
 */
export function visualViewportBottomInset(
  layoutHeight: number,
  viewport: VisualViewportLike | null | undefined
): number {
  const keyboardHeight = visualViewportKeyboardHeight(layoutHeight, viewport);
  if (!keyboardHeight || !viewport) return 0;
  const inset = keyboardHeight - viewport.offsetTop;
  return Number.isFinite(inset) && inset > 0 ? Math.round(inset) : 0;
}

/**
 * The height of the keyboard shrinking the visual viewport, whether or not a pan has since moved
 * it off the layout viewport's bottom; `0` for none, under the same two readings as
 * {@link visualViewportBottomInset}.
 */
function visualViewportKeyboardHeight(
  layoutHeight: number,
  viewport: VisualViewportLike | null | undefined
): number {
  if (!viewport) return 0;
  if (viewport.scale != null && Math.abs(viewport.scale - 1) > SCALE_TOLERANCE) return 0;
  const keyboardHeight = layoutHeight - viewport.height;
  return Number.isFinite(keyboardHeight) && keyboardHeight >= KEYBOARD_INSET_MIN_PX
    ? keyboardHeight
    : 0;
}

/**
 * {@link visualViewportBottomInset}, kept current while `enabled`. Use it as a `bottom` offset
 * on a bottom-anchored fixed element that holds a text field, so the field and its buttons stay
 * above the keyboard while the user types.
 */
export function useVisualViewportBottomInset(enabled = true): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setInset(visualViewportBottomInset(window.innerHeight, viewport));
    update();
    // `scroll` as well as `resize`: iOS pans the visual viewport (offsetTop changes) when it
    // scrolls a focused field into view, without resizing it.
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [enabled]);

  return enabled ? inset : 0;
}

/**
 * Whether an on-screen keyboard is up: either it shrank the visual viewport (the keyboard's height,
 * not what a pan leaves of it over the bottom edge: iOS pans a low field fully into view, leaving
 * nothing), or the browser resized the layout viewport itself for it (`innerHeight` is at least
 * {@link KEYBOARD_INSET_MIN_PX} short of the tallest it has been at this width), which some Android
 * browsers do instead.
 */
export function isKeyboardOpen(
  layout: { tallest: number; height: number },
  viewport: VisualViewportLike | null | undefined
): boolean {
  return (
    visualViewportKeyboardHeight(layout.height, viewport) > 0 ||
    layout.tallest - layout.height >= KEYBOARD_INSET_MIN_PX
  );
}

/** {@link isKeyboardOpen}, kept current. A width change (a rotation) starts the tallest afresh. */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    let width = 0;
    let tallest = 0;
    const update = () => {
      const { innerWidth, innerHeight: height } = window;
      tallest = innerWidth === width ? Math.max(tallest, height) : height;
      width = innerWidth;
      setOpen(isKeyboardOpen({ tallest, height }, viewport));
    };
    update();
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
    };
  }, []);

  return open;
}
