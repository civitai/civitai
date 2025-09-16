import { useCallback, useEffect, useRef } from 'react';
import { isDev } from '~/env/other';

export const createDebouncer = (timeout: number) => {
  let timer: NodeJS.Timeout | undefined;
  const debouncer = (func: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(func, timeout);
  };
  return debouncer;
};

export const useDebouncer = (timeout: number) => {
  const timeoutRef = useRef<NodeJS.Timeout | undefined>();

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [timeout]);

  const debouncer = useCallback(
    (func: () => void) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(func, timeout);
    },
    [timeout]
  );

  return debouncer;
};

export const createKeyDebouncer = (timeout: number) => {
  const dictionary: Record<string, NodeJS.Timeout> = {};

  const debouncer = (key: string, fn: () => void) => {
    if (dictionary[key]) clearTimeout(dictionary[key]);
    dictionary[key] = setTimeout(() => {
      try {
        fn();
      } catch (e) {
        if (isDev) console.log(e);
      }
      delete dictionary[key];
    }, timeout);
  };

  return debouncer;
};
