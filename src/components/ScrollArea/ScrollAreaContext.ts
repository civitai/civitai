import { RefObject, createContext, useContext, useEffect, useRef } from 'react';

export const ScrollAreaContext = createContext<{
  ref: RefObject<HTMLDivElement>;
} | null>(null);

export const useScrollAreaRef = (args?: { onScroll?: () => void }) => {
  const onScrollRef = useRef<(() => void) | null>(null);
  const context = useContext(ScrollAreaContext);
  const { ref } = context ?? {};
  onScrollRef.current = args?.onScroll ?? null;

  useEffect(() => {
    const elem = ref?.current;
    const onScroll = onScrollRef.current;
    if (!onScroll || !elem) return;
    elem?.addEventListener('scroll', onScroll);
    return () => {
      elem?.removeEventListener('scroll', onScroll);
    };
  }, []); // eslint-disable-line

  return ref;
};
