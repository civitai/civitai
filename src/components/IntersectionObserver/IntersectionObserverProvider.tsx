import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollArea';

type SizeMapping = { height: number; width: number };
const sizeMappings = new Map<string, SizeMapping>();
function getSizeMappingKey(ids: string[]) {
  return ids.join('_');
}

const useSizeMappingStore = create<Record<string, SizeMapping>>(() => ({}));

type ObserverCallback = (inView: boolean, entry: IntersectionObserverEntry) => void;
const IntersectionObserverCtx = createContext<{
  ready: boolean;
  providerId: string;
  observe: (element: HTMLElement, callback: ObserverCallback) => void;
  unobserve: (element: HTMLElement) => void;
} | null>(null);

function useProviderContext() {
  const context = useContext(IntersectionObserverCtx);
  if (!context) throw new Error('missing IntersectionObserverCtx in tree');
  return context;
}

export function useIntersectionObserverContext({
  id,
  preserveHeight = true,
  preserveWidth,
}: {
  id: string;
  preserveHeight?: boolean;
  preserveWidth: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { ready, providerId, observe, unobserve } = useProviderContext();
  const keyRef = useRef(getSizeMappingKey([providerId, id]));
  const sizeMapping = useSizeMappingStore(useCallback((state) => state[keyRef.current], []));
  const [inView, setInView] = useState(!sizeMapping ? true : false);

  useEffect(() => {
    if (!ready) return;
    const key = keyRef.current;
    const target = ref.current;

    function callback(inView: boolean, entry: IntersectionObserverEntry) {
      // if (!inView) {
      //   const bounds = entry.target.getBoundingClientRect();
      //   useSizeMappingStore.setState({ [key]: { width: bounds.width, height: bounds.height } });
      // }
      if (preserveHeight || preserveWidth) {
        const target = entry.target as HTMLElement;
        if (!inView) {
          const { width, height } = target.getBoundingClientRect();
          useSizeMappingStore.setState({ [key]: { width, height } });
          if (preserveHeight) target.style.height = `${height}px`;
          if (preserveWidth) target.style.width = `${width}px`;
        }
      }
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
  }, [ready]);

  useEffect(() => {
    if (inView && (preserveHeight || preserveWidth)) {
      ref.current?.removeAttribute('style');
    }
  }, [inView]);

  return { ref, inView, sizeMapping: !inView ? sizeMapping : undefined } as const;
}

export function IntersectionObserverProvider({
  id,
  children,
  options,
  ...rest
}: React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement> & {
  id: string;
  options?: IntersectionObserverInit;
}) {
  const node = useScrollAreaRef();
  const targetRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver>();
  const mappingRef = useRef<Map<Element, ObserverCallback>>();
  const [ready, setReady] = useState(false);
  if (!mappingRef.current) mappingRef.current = new Map<Element, ObserverCallback>();

  useEffect(() => {
    // assigne the observer in the effect so that we react has time to assign refs before we initialize
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const callback = mappingRef.current?.get(entry.target);
            callback?.(entry.isIntersecting, entry);
          }
        },
        {
          root: node?.current,
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

  function observe(element: HTMLElement, callback: ObserverCallback) {
    observerRef.current?.observe(element);
    mappingRef.current?.set(element, callback);
  }

  function unobserve(element: HTMLElement) {
    observerRef.current?.unobserve(element);
    mappingRef.current?.delete(element);
  }

  return (
    <div id={id} ref={targetRef} {...rest}>
      <IntersectionObserverCtx.Provider value={{ ready, providerId: id, observe, unobserve }}>
        {children}
      </IntersectionObserverCtx.Provider>
    </div>
  );
}

type DivProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>;
export function InViewDiv({
  id,
  preserveHeight = true,
  preserveWidth,
  children,
  style,
  ...props
}: { id: string; preserveHeight?: boolean; preserveWidth?: boolean } & DivProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { ready, providerId, observe, unobserve } = useProviderContext();
  const keyRef = useRef<string>();
  if (!keyRef.current) keyRef.current = getSizeMappingKey([providerId, id]);
  const sizeMappingRef = useRef<SizeMapping>();
  if (!sizeMappingRef.current) sizeMappingRef.current = sizeMappings.get(keyRef.current);
  const [inView, setInView] = useState(!sizeMappingRef.current ? true : false);

  const initialStyle = sizeMappingRef.current
    ? {
        width: preserveWidth ? sizeMappingRef.current?.width : undefined,
        height: preserveHeight ? sizeMappingRef.current?.height : undefined,
        ...style,
      }
    : style;

  useEffect(() => {
    if (!ready) return;
    const key = keyRef.current ?? getSizeMappingKey([providerId, id]);
    const target = ref.current;

    function callback(inView: boolean, entry: IntersectionObserverEntry) {
      if (preserveHeight || preserveWidth) {
        const target = entry.target as HTMLElement;
        if (!inView) {
          const { width, height } = target.getBoundingClientRect();
          sizeMappings.set(key, { width, height });
          if (preserveHeight) target.style.height = `${height}px`;
          if (preserveWidth) target.style.width = `${width}px`;
        }
      }
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
  }, [ready]);

  useEffect(() => {
    if (inView && (preserveHeight || preserveWidth)) {
      ref.current?.removeAttribute('style');
    }
  }, [inView]);

  return (
    <div ref={ref} {...props} style={initialStyle}>
      {inView && children}
    </div>
  );
}
