import { RefObject, createContext, useContext, useEffect, useRef } from 'react';

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
    if (!elem) return;
    function handleScroll() {
      if (!ref?.current) return;
      onScrollRef.current?.(ref.current);
    }
    elem?.addEventListener('scroll', handleScroll);
    return () => {
      elem?.removeEventListener('scroll', handleScroll);
    };
  }, []); // eslint-disable-line

  return ref;
};
