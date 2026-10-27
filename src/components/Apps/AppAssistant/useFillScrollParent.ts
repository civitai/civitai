import { useEffect, useLayoutEffect, useRef } from 'react';

export const FILL_HEIGHT_VAR = '--assistant-fill-height';

/**
 * Sizes the element to the space left in its scrolling ancestor below its own top edge and above whatever follows it, so the page
 * does not scroll however tall the title band above it is. Sets `FILL_HEIGHT_VAR` on the element;
 * the stylesheet decides what to do when the variable is absent or too small.
 */
export function useFillScrollParent<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  const measure = () => {
    const node = ref.current;
    const parent = node?.closest<HTMLElement>('.scroll-area');
    if (!node || !parent) return;
    const top =
      node.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop;
    const below = Math.max(0, parent.scrollHeight - top - node.offsetHeight);
    const height = Math.floor(parent.clientHeight - top - below);
    node.style.setProperty(FILL_HEIGHT_VAR, `${height}px`);
  };

  // The element mounts late (after the access check), so measure after every render.
  useLayoutEffect(measure);

  useEffect(() => {
    const parent = ref.current?.closest<HTMLElement>('.scroll-area');
    window.addEventListener('resize', measure);
    const observer = parent ? new ResizeObserver(measure) : null;
    if (parent) observer?.observe(parent);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  return ref;
}
