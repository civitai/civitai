import { useEffect, useRef } from 'react';

type ResizeFunc = (r: ResizeObserverEntry) => void;
type ObserverCallback = {
  current: ResizeFunc;
};

let resizeObserver: ResizeObserver | undefined;
const callbackMap = new WeakMap<Element, ObserverCallback[]>();
// Merge batches across observer callbacks: a dropped entry is not redelivered until the element
// resizes again.
const pendingEntries = new Map<Element, ResizeObserverEntry>();
let frameId = 0;

function flushPendingEntries() {
  frameId = 0;
  const entries = [...pendingEntries.values()];
  pendingEntries.clear();
  for (const entry of entries) {
    const callbacks = callbackMap.get(entry.target) ?? [];
    for (const cbRef of callbacks) {
      cbRef.current(entry);
    }
  }
}

export const useResizeObserver = <T extends HTMLElement = HTMLElement>(
  callback: ResizeFunc,
  options?: { observeChildren?: boolean }
) => {
  const ref = useRef<T | null>(null);
  const { observeChildren } = options ?? {};
  const callbackRef = useRef<ResizeFunc | null>(null);

  callbackRef.current = callback;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (!resizeObserver)
      resizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]) => {
        for (const entry of entries) pendingEntries.set(entry.target, entry);
        if (!frameId && pendingEntries.size) frameId = requestAnimationFrame(flushPendingEntries);
      });
  }, []);

  useEffect(() => {
    const node = ref.current;
    const observer = resizeObserver;
    if (!node || !observer) return;

    const cbRef = callbackRef as { current: ResizeFunc };

    let mutationObserver: MutationObserver | undefined;
    const observedElements = observeChildren ? ([...node.children] as Element[]) : [node];

    const observeElements = (elems: Element[]) => {
      for (const elem of elems) {
        const callbacks = callbackMap.get(elem as Element) ?? [];
        if (!callbackMap.has(elem)) {
          observer.observe(elem);
          observedElements.push(elem);
        }
        callbackMap.set(elem, callbacks.concat(cbRef));
      }
    };

    const unobserveElements = (elems: Element[]) => {
      for (const elem of elems) {
        const callbacks = callbackMap.get(elem) ?? [];
        const filtered = callbacks.filter((ref) => ref !== cbRef);

        const index = observedElements.indexOf(elem);
        if (index > -1) observedElements.splice(index, 1);

        if (filtered.length) {
          callbackMap.set(elem, filtered);
        } else {
          observer.unobserve(elem);
          callbackMap.delete(elem);
        }
      }
    };

    if (observeChildren) {
      observeElements([...node.children] as Element[]);

      // set up observation on child mutations
      mutationObserver?.disconnect();
      mutationObserver = new MutationObserver((entries) => {
        for (const entry of entries) {
          unobserveElements(entry.removedNodes as any);
          observeElements(entry.addedNodes as any);
        }
      });
      mutationObserver.observe(node, { childList: true });
    } else {
      observeElements([node]);
    }

    return () => {
      if (observeChildren) {
        mutationObserver?.disconnect();
        unobserveElements(observedElements);
      } else {
        unobserveElements([node]);
      }
    };
  }, [observeChildren]);

  return ref;
};
