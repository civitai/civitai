import type { MutableRefObject, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';

type Observed = { element: HTMLElement; root: HTMLElement; observer: ResizeObserver };

/** A scroll container that mounts in the same commit attaches its ref after this hook's
 * effect. More frames than that means there is no ScrollArea above us — stop looking. */
const ROOT_ATTACH_RETRIES = 3;

/**
 * How many margins we will publish before the element has to hold still at one of them.
 *
 * The margin is fed to `useVirtualizer`, which decides what renders inside the scroll
 * container. Where any of that ends up above the measured element, publishing a margin
 * moves the thing the next commit measures, and no offset is a fixed point. Measuring on
 * every commit then feeds itself: each layout effect sets state, the state schedules a
 * synchronous re-render, and the re-render runs the layout effect again. React counts 50
 * of those and throws "Maximum update depth exceeded" — an error no boundary can recover
 * from, so the page it happens on goes blank.
 *
 * A layout that settles spends one of these and gets it back (see `publishedRef`); only
 * one that answers a new margin with a new offset burns through them. Giving up leaves a
 * margin that is at most one layout stale, which costs a mispositioned row — and the
 * ResizeObserver hands the budget back the moment anything above the list really resizes.
 */
const UNSETTLED_PUBLISHES = 3;

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
  const warnedChaseRef = useRef(false);
  const observedRef = useRef<Observed | null>(null);
  /** The margin the element is currently positioned against — a ref, not the state, because
   * the observer below keeps the closure it was created with. Seeded to the initial state. */
  const publishedRef = useRef(0);
  /** Margins published since the element last measured at one of them: `count` is what the
   * budget spends, `offsets` is how a resize we caused is told from one we didn't. */
  const chaseRef = useRef({ count: 0, offsets: new Set<number>() });

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

    // A different element, or the same one under a different scroll container, is a
    // different measurement — nothing about the last one's chase applies to it.
    const observed = observedRef.current;
    const reattached = observed?.element !== element || observed.root !== root;
    if (reattached) {
      chaseRef.current.count = 0;
      chaseRef.current.offsets.clear();
    }

    /** `resized` distinguishes the observer — content above really moved — from the
     * per-commit read, which cannot tell our own last margin from anything else. */
    const update = (resized: boolean) => {
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

      const chase = chaseRef.current;

      // The element measured where the margin we published puts it: this margin is the
      // fixed point, and whatever chase got us here is over.
      if (offset === publishedRef.current) {
        chase.count = 0;
        chase.offsets.clear();
        return;
      }

      // A resize above the list is the case this hook exists for, so it refills the
      // budget — but only when it lands somewhere the chase has not already been. A
      // layout that answers our margin by resizing content above it fires this observer
      // too, and refilling on that is how a bounded chase becomes an endless one.
      if (resized && !chase.offsets.has(offset)) {
        chase.count = 0;
        chase.offsets.clear();
      }

      if (chase.count >= UNSETTLED_PUBLISHES) {
        if (process.env.NODE_ENV !== 'production' && !warnedChaseRef.current) {
          warnedChaseRef.current = true;
          console.warn(
            `useScrollMargin: the measured element moves every time the margin changes (${publishedRef.current} → ${offset}) — something the virtualizer sizes is rendering above it. Keeping ${publishedRef.current}.`
          );
        }
        return;
      }

      chase.count++;
      chase.offsets.add(offset);
      publishedRef.current = offset;
      setScrollMargin(offset);
    };

    update(false);

    if (!reattached) return;
    disconnect(observedRef);

    // Whatever grows above the list lives inside one of the scroll container's children,
    // and grows that child's own box. Observing the list's ancestors instead would also
    // fire on the list growing downward, which can never move its own top.
    const observer = new ResizeObserver(() => update(true));
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
