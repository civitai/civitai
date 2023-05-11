import { useRef } from 'react';

export const createDebouncer = (timeout: number) => {
  let timer: NodeJS.Timeout | undefined;
  const debouncer = (func: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(func, timeout);
  };
  return debouncer;
};

export const useDebouncer = (timeout: number) => {
  const timerRef = useRef<NodeJS.Timeout | undefined>();
  const debouncer = (func: () => void) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(func, timeout);
  };
  return debouncer;
};
