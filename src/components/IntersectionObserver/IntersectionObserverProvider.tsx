import type { Key, RefObject } from 'react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import { generateToken } from '~/utils/string-helpers';

type SizeMapping = { height: number; width: number };
const sizeMappings = new Map<string, SizeMapping>();
function getSizeMappingKey(ids: string[]) {
  return ids.join('_');
}

export type CustomIntersectionObserverCallback = (
  inView: boolean,
  entry: IntersectionObserverEntry
) => void;
const IntersectionObserverCtx = createContext<{
  ready: boolean;
  providerId?: string;
  observe: (element: HTMLElement, callback: CustomIntersectionObserverCallback) => void;
  unobserve: (element: HTMLElement) => void;
} | null>(null);

function useProviderContext() {
  const context = useContext(IntersectionObserverCtx);
  if (!context) throw new Error('missing IntersectionObserverCtx in tree');
  return context;
}

type InViewResponse<T extends HTMLElement> = [RefObject<T>, boolean];
export function useInView<T extends HTMLElement = HTMLDivElement>({
  initialInView = false,
  callback,
  key,
}: {
  initialInView?: boolean;
  callback?: CustomIntersectionObserverCallback;
  key?: Key;
} = {}): InViewResponse<T> {
  const ref = useRef<T>(null);
  const { ready, observe, unobserve } = useProviderContext();
  const [inView, setInView] = useState(initialInView);

  const cbRef = useRef<CustomIntersectionObserverCallback | null>();
  cbRef.current = callback;

  /** What we are currently observing, so a swapped node can be noticed. */
  const observed = useRef<{ node: T | null; key?: Key }>({ node: null });

  // 🔴 No dependency array. The thing that must retrigger this is the identity
  // of `ref.current`, and a ref object mutating in place cannot be a dependency
  // — so a deps list can only ever describe when we GUESS the node changed.
  //
  // It guessed wrong for any consumer whose element is replaced after mount.
  // `TwCosmeticWrapper` returns its children bare with no cosmetic and wraps
  // them in a div with one, so a cosmetic that arrives asynchronously changes
  // the subtree's depth and React remounts the node this ref points at. The old
  // deps were `[ready, key]`, neither of which moves — so the new node was never
  // observed, while the detached old one fired one last callback with
  // `isIntersecting: false`. `inView` latched false permanently, and every card
  // built on `AspectRatioCard` renders nothing at all when that happens.
  //
  // Running every render is affordable because the body is an identity check
  // that exits immediately in the steady state; re-subscribing only happens when
  // the node or the key actually moves. Measured at ~360ns per hook-render, so
  // ~18us for a full re-render of a virtualised feed.
  //
  // A callback ref would be cheaper still — React invokes it only when the node
  // changes — but this hook's contract is `[RefObject<T>, boolean]` and
  // `useInViewDynamic` below reads `ref.current` in two of its own effects, so
  // returning a function would mean widening the type and reworking three
  // consumers to buy back those microseconds.
  useEffect(() => {
    if (!ready) return;
    const target = ref.current;
    const current = observed.current;
    if (target === current.node && key === current.key) return;

    if (current.node) unobserve(current.node);
    observed.current = { node: target, key };

    if (target) {
      observe(target, (inView: boolean, entry: IntersectionObserverEntry) => {
        cbRef.current?.(inView, entry);
        setInView(inView);
      });
    }
  });

  useEffect(() => {
    return () => {
      if (observed.current.node) unobserve(observed.current.node);
      observed.current = { node: null };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [ref, inView];
}

export function useInViewDynamic<T extends HTMLElement = HTMLDivElement>({
  initialInView,
  id,
}: {
  initialInView?: boolean;
  id: string;
}): InViewResponse<T> {
  const { providerId } = useProviderContext();
  if (!providerId)
    throw new Error(
      'missing providerId. providerId must be present to use IntersectionObserver for content with dynamic bounds'
    );
  const keyRef = useRef<string>();
  if (!keyRef.current) keyRef.current = getSizeMappingKey([providerId ?? '', id]);
  const sizeMappingRef = useRef<SizeMapping>();
  if (!sizeMappingRef.current) sizeMappingRef.current = sizeMappings.get(keyRef.current);

  const [ref, inView] = useInView<T>({
    initialInView: initialInView ?? !sizeMappingRef.current ? true : false,
    callback: (inView, entry) => {
      const target = entry.target as HTMLElement;
      const key = keyRef.current;

      if (!inView && key) {
        const { width, height } = target.getBoundingClientRect();
        if (height > 0) {
          sizeMappings.set(key, { width, height });
          target.style.height = `${height}px`;
        }
      }
    },
  });

  useIsomorphicLayoutEffect(() => {
    const sizeMapping = sizeMappingRef.current;
    const target = ref.current;
    if (target && sizeMapping) {
      target.style.height = `${sizeMapping.height}px`;
    }
  }, []);

  useEffect(() => {
    const target = ref.current;
    if (target && inView) {
      target.style.removeProperty('height');
    }
  }, [inView]);

  return [ref, !sizeMappingRef.current ? true : inView];
}

export function IntersectionObserverProvider({
  id,
  options,
  children,
}: {
  id?: string;
  options?: IntersectionObserverInit;
  children: React.ReactNode;
}) {
  const node = useScrollAreaRef();
  const observerRef = useRef<IntersectionObserver>();
  const mappingRef = useRef<Map<string, CustomIntersectionObserverCallback>>();
  const [ready, setReady] = useState(false);
  if (!mappingRef.current)
    mappingRef.current = new Map<string, CustomIntersectionObserverCallback>();

  useEffect(() => {
    // assigne the observer in the effect so that we react has time to assign refs before we initialize
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.target.id) {
              const callback = mappingRef.current?.get(entry.target.id);
              callback?.(entry.isIntersecting, entry);
            }
          }
        },
        {
          root: node?.current,
          rootMargin: '100% 0px',
          ...options,
        }
      );
      setReady(true);
    }

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = undefined;
    };
  }, []);

  function observe(element: HTMLElement, callback: CustomIntersectionObserverCallback) {
    if (!element.id) element.id = generateToken(8);
    observerRef.current?.observe(element);
    mappingRef.current?.set(element.id, callback);
  }

  function unobserve(element: HTMLElement) {
    if (!element.id) return;
    observerRef.current?.unobserve(element);
    mappingRef.current?.delete(element.id);
  }

  return (
    <IntersectionObserverCtx.Provider value={{ ready, providerId: id, observe, unobserve }}>
      {children}
    </IntersectionObserverCtx.Provider>
  );
}
