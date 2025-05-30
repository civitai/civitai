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

  useEffect(() => {
    if (!ready) return;
    // console.log({ key });

    const target = ref.current;

    function callback(inView: boolean, entry: IntersectionObserverEntry) {
      cbRef.current?.(inView, entry);
      setInView(inView);
    }

    if (target) {
      observe(target, callback);
    }

    return () => {
      if (target) {
        unobserve(target);
      }
    };
  }, [ready, key]);

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
          rootMargin: '200% 0px',
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
