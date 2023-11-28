import { useEffect, useRef } from 'react';

export const useResizeObserver = <T extends HTMLElement = any>(
  callback: ResizeObserverCallback
) => {
  const frameID = useRef(0);
  const ref = useRef<T>(null);
  const callbackRef = useRef<ResizeObserverCallback | null>(null);

  callbackRef.current = callback;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const handleResize = (entries: ResizeObserverEntry[], observer: ResizeObserver) => {
      if (entries.length > 0) cancelAnimationFrame(frameID.current);
      frameID.current = requestAnimationFrame(() => {
        if (callbackRef.current) {
          callbackRef.current(entries, observer);
        }
      });
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(node);

    return () => {
      observer.disconnect();

      if (frameID.current) {
        cancelAnimationFrame(frameID.current);
      }
    };
  }, []);

  return ref;
};
