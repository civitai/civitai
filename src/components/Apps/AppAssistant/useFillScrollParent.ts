import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

const PROBE_HEIGHT_PX = 20000;

/**
 * Sizes the element to the space left in its scrolling ancestor, between its own top edge and
 * whatever follows it, so the page does not scroll however tall the title band is.
 * Writes `--assistant-fill-height` on the element; the stylesheet supplies the fallback.
 *
 * What the rest of the scroller needs is measured with the element stretched far past the viewport:
 * `scrollHeight` clamps to the scroller's own height once content is shorter than it, and that slack
 * would count as content below the element and stop it from growing back.
 */
export function useFillScrollParent<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const node = ref.current;
    const parent = node?.closest<HTMLElement>('.scroll-area');
    if (!node || !parent) return;
    node.style.setProperty('--assistant-fill-height', `${PROBE_HEIGHT_PX}px`);
    const used = parent.scrollHeight - node.getBoundingClientRect().height;
    const height = Math.floor(parent.clientHeight - used);
    node.style.setProperty('--assistant-fill-height', `${height}px`);

    if (observed.current !== parent) {
      observer.current?.disconnect();
      observer.current = new ResizeObserver(measure);
      observer.current.observe(parent);
      if (parent.firstElementChild) observer.current.observe(parent.firstElementChild);
      observed.current = parent;
    }
  }, []);

  // The element mounts after the access check, so measure after every render.
  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      observer.current?.disconnect();
    };
  }, [measure]);

  return ref;
}
