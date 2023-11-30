import { useEffect, useRef } from 'react';

export const useResizeObserver = <T extends HTMLElement = any>(
  callback: ResizeObserverCallback,
  options?: { observeChildren?: boolean }
) => {
  const { observeChildren } = options ?? {};
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

    let mutationObserver: MutationObserver | undefined;
    const resizeObserver = new ResizeObserver(handleResize);
    if (observeChildren) {
      const startObserveChildren = () => {
        for (const child of node.children) {
          resizeObserver.observe(child);
        }
      };
      // initial child observation
      startObserveChildren();

      // set up
      mutationObserver = new MutationObserver((entries) => {
        resizeObserver.disconnect();
        startObserveChildren();
      });
      mutationObserver.observe(node, { childList: true });
    } else resizeObserver.observe(node);

    return () => {
      resizeObserver.disconnect();
      mutationObserver?.disconnect();

      if (frameID.current) {
        cancelAnimationFrame(frameID.current);
      }
    };
  }, [observeChildren]);

  return ref;
};
