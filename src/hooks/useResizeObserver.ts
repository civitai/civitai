import { useEffect, useRef } from 'react';

export const useResizeObserver = <T extends HTMLElement = any>(
  callback: ResizeObserverCallback
) => {
  const ref = useRef<T>(null);
  const callbackRef = useRef<ResizeObserverCallback | null>(null);

  callbackRef.current = callback;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const handleResize = (entries: ResizeObserverEntry[], observer: ResizeObserver) => {
      if (callbackRef.current) callbackRef.current(entries, observer);
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(node);

    return () => {
      observer.unobserve(node);
    };
  }, []);

  return ref;
};
