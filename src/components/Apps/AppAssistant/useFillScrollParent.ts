import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Sizes the element to the space left in its scrolling ancestor, between its own top edge and
 * whatever follows it, so the page does not scroll however tall the title band above it is.
 * Writes `--assistant-fill-height` on the element; the stylesheet supplies the fallback.
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
    node.style.setProperty('--assistant-fill-height', `${height}px`);
  };

  // The element mounts after the access check, so measure after every render.
  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return ref;
}
