import type { RefObject } from 'react';
import { createContext, useContext, useEffect, useRef } from 'react';

export const ScrollAreaContext = createContext<{
  ref: RefObject<HTMLDivElement>;
} | null>(null);

export const useScrollAreaRef = (args?: { onScroll?: (node: HTMLDivElement) => void }) => {
  const onScrollRef = useRef<((node: HTMLDivElement) => void) | null>(null);
  const context = useContext(ScrollAreaContext);
  const { ref } = context ?? {};
  onScrollRef.current = args?.onScroll ?? null;

  useEffect(() => {
    const elem = ref?.current;
    function handleScroll(e: Event) {
      const node = e.target as HTMLDivElement;
      onScrollRef.current?.(node);
    }
    elem?.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      elem?.removeEventListener('scroll', handleScroll);
    };
  }, []); // eslint-disable-line

  return ref;
};
