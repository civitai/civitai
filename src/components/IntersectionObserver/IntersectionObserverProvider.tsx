import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollArea';

type SizeMapping = { height: number; width: number };
const sizeMappings = new Map<string, SizeMapping>();
function getSizeMappingKey(ids: string[]) {
  return ids.join('_');
}

type ObserverCallbackArgs = { intersecting: boolean; size: SizeMapping };
type ObserverCallback = (args: ObserverCallbackArgs) => void;
const IntersectionObserverCtx = createContext<{
  providerId: string;
  observe: (element: HTMLElement, callback: ObserverCallback) => void;
  unobserve: (element: HTMLElement) => void;
} | null>(null);

function useProviderContext() {
  const context = useContext(IntersectionObserverCtx);
  if (!context) throw new Error('missing IntersectionObserverCtx in tree');
  return context;
}

export function useIntersectionObserverContext({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { providerId, observe, unobserve } = useProviderContext();
  const keyRef = useRef(getSizeMappingKey([providerId, id]));
  const [sizeMapping, setSizeMapping] = useState(sizeMappings.get(keyRef.current));
  const [inView, setInView] = useState(false);
  // const inViewRef = useRef(inView);

  useEffect(() => {
    const key = keyRef.current;
    const target = ref.current;

    if (target && !sizeMappings.get(key)) {
      const bounds = target.getBoundingClientRect();
      sizeMappings.set(key, { height: bounds.height, width: bounds.width });
    }

    function callback({ intersecting, size }: ObserverCallbackArgs) {
      // const sizeMapping = sizeMappings.get(key);
      // const inView = !sizeMapping ? true : intersecting;
      setInView(intersecting);
      sizeMappings.set(key, size);
      setSizeMapping(size);
      // inViewRef.current = inView;
      // if (target) {
      //   if (!inView) {
      //     target.style.height = `${size.height}px`;
      //   } else {
      //     target.style.removeProperty('height');
      //   }
      // }
    }

    if (target) {
      observe(target, callback);
    }

    return () => {
      if (target) {
        unobserve(target);
      }
      // if (inViewRef.current && key) {
      //   sizeMappings.delete(key);
      // }
    };
  }, []);

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
  if (!mappingRef.current) mappingRef.current = new Map<Element, ObserverCallback>();

  useEffect(() => {
    // assigne the observer in the effect so that we can access the targetRef
    if (!observerRef.current)
      observerRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const bounds = entry.target.getBoundingClientRect();
            const callback = mappingRef.current?.get(entry.target);
            callback?.({
              intersecting: entry.isIntersecting,
              size: { width: bounds.width, height: bounds.height },
            });
          }
        },
        {
          root: node?.current,
          ...options,
        }
      );
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
      <IntersectionObserverCtx.Provider value={{ providerId: id, observe, unobserve }}>
        {children}
      </IntersectionObserverCtx.Provider>
    </div>
  );
}
