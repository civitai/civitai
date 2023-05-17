import { useCallback, useEffect, useRef } from 'react';

export const useDebouncer = (timeout: number) => {
  const timeoutRef = useRef<NodeJS.Timeout | undefined>();

  const clearTimeout = () => window.clearTimeout(timeoutRef.current);
  useEffect(() => clearTimeout, []);

  const debouncer = useCallback(
    (func: () => void) => {
      clearTimeout();
      timeoutRef.current = setTimeout(func, timeout);
    },
    [timeout]
  );

  return debouncer;
};
