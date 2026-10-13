import { useEffect, useState } from 'react';

type VisualViewportLike = { height: number; offsetTop: number; scale?: number };

/**
 * Smaller gaps than this are not a keyboard: a collapsing URL bar or a scrollbar leaves a sliver
 * between the two viewports. Well under the shortest real on-screen keyboard.
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
 * - a gap under {@link KEYBOARD_INSET_MIN_PX}.
 *
 * `0` as well whenever the numbers are unusable, so a missing or odd reading leaves the element
 * where it would have been without this.
 */
export function visualViewportBottomInset(
  layoutHeight: number,
  viewport: VisualViewportLike | null | undefined
): number {
  if (!viewport) return 0;
  if (viewport.scale != null && Math.abs(viewport.scale - 1) > SCALE_TOLERANCE) return 0;
  const inset = layoutHeight - (viewport.height + viewport.offsetTop);
  return Number.isFinite(inset) && inset >= KEYBOARD_INSET_MIN_PX ? Math.round(inset) : 0;
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
