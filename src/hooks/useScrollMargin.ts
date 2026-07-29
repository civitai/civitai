import type { MutableRefObject, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';

type Observed = { element: HTMLElement; root: HTMLElement; observer: ResizeObserver };

/** A scroll container that mounts in the same commit attaches its ref after this hook's
 * effect. More frames than that means there is no ScrollArea above us — stop looking. */
const ROOT_ATTACH_RETRIES = 3;

/**
 * Distance between the top of the scroll container and the top of `ref`, kept in
 * sync while content above it grows or shrinks (expanding descriptions, ads that
 * load late). `useVirtualizer` turns `scrollTop - scrollMargin` into the window of
 * items it renders, so a stale value blanks rows that are on screen.
 */
export function useScrollMargin(ref: RefObject<HTMLElement | null>) {
  const scrollAreaRef = useScrollAreaRef();
  const [scrollMargin, setScrollMargin] = useState(0);
  const [, retry] = useState(0);
  const retriesRef = useRef(0);
  const warnedRef = useRef(false);
  const observedRef = useRef<Observed | null>(null);

  // No dependency array: the measured element commonly mounts later than the hook (lists
  // rendered behind a loading state), and a commit is the cheapest place to catch layout
  // changes the observer below can't see.
  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      disconnect(observedRef);
      return;
    }

    const root = scrollAreaRef?.current;
    if (!root) {
      if (retriesRef.current >= ROOT_ATTACH_RETRIES) return;
      retriesRef.current++;
      const frame = requestAnimationFrame(() => retry((count) => count + 1));
      return () => cancelAnimationFrame(frame);
    }
    retriesRef.current = 0;

    const update = () => {
      const offset = getOffsetTopRelativeToAncestor(element, root);
      if (offset === null) {
        if (process.env.NODE_ENV !== 'production' && !warnedRef.current) {
          warnedRef.current = true;
          console.warn(
            'useScrollMargin: the scroll container is not an offsetParent of the measured element — is it positioned?'
          );
        }
        return;
      }
      setScrollMargin((prev) => (prev !== offset ? offset : prev));
    };

    update();

    if (observedRef.current?.element === element && observedRef.current.root === root) return;
    disconnect(observedRef);

    // Whatever grows above the list lives inside one of the scroll container's children,
    // and grows that child's own box. Observing the list's ancestors instead would also
    // fire on the list growing downward, which can never move its own top.
    const observer = new ResizeObserver(update);
    observer.observe(root);
    for (const child of Array.from(root.children)) observer.observe(child);

    observedRef.current = { element, root, observer };
  });

  useEffect(() => () => disconnect(observedRef), []);

  return scrollMargin;
}

function disconnect(ref: MutableRefObject<Observed | null>) {
  ref.current?.observer.disconnect();
  ref.current = null;
}

function getOffsetTopRelativeToAncestor(
  descendant: HTMLElement,
  ancestor: HTMLElement
): number | null {
  let offset = 0;
  let current: HTMLElement | null = descendant;

  while (current && current !== ancestor) {
    offset += current.offsetTop;
    current = current.offsetParent as HTMLElement;
  }

  return current === ancestor ? offset : null;
}
