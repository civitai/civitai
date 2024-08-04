import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { create } from 'zustand';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollArea';

type SizeMapping = { height: number; width: number };
// const sizeMappings = new Map<string, SizeMapping>();
function getSizeMappingKey(ids: string[]) {
  return ids.join('_');
}

const useSizeMappingStore = create<Record<string, SizeMapping>>(() => ({}));

type ObserverCallback = (inView: boolean, entry: IntersectionObserverEntry) => void;
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
  const sizeMapping = useSizeMappingStore(useCallback((state) => state[keyRef.current], []));
  const [inView, setInView] = useState(!sizeMapping ? true : false);

  useEffect(() => {
    console.log(2);
    const key = keyRef.current;
    const target = ref.current;

    function callback(inView: boolean, entry: IntersectionObserverEntry) {
      if (!inView) {
        const bounds = entry.target.getBoundingClientRect();
        useSizeMappingStore.setState({ [key]: { width: bounds.width, height: bounds.height } });
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

  useLayoutEffect(() => {
    // assigne the observer in the effect so that we react has time to assign refs before we initialize
    if (!observerRef.current) {
      console.log(1);
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
      // setReady(true);
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
      <IntersectionObserverCtx.Provider value={{ providerId: id, observe, unobserve }}>
        {children}
      </IntersectionObserverCtx.Provider>
    </div>
  );
}
