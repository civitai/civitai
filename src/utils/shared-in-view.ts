type Listener = (inView: boolean) => void;

const listeners = new Map<Element, Listener>();
let observer: IntersectionObserver | undefined;

/**
 * Reports whether `el` intersects the viewport, through one IntersectionObserver shared by every
 * caller, one listener per element (a second call for the same element replaces the first). Unlike
 * `useInView`, it needs no provider and never re-renders. Returns the unobserve.
 */
export function observeInView(el: Element, listener: Listener): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => undefined;
  observer ??= new IntersectionObserver((entries) => {
    // Entries queue oldest-first; the last one per element is its current state.
    for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
  });
  listeners.set(el, listener);
  observer.observe(el);
  return () => {
    listeners.delete(el);
    observer?.unobserve(el);
  };
}
