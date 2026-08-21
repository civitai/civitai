import { useCallback, useEffect, useMemo, useRef } from 'react';
import { isDev } from '~/env/other';

export const createDebouncer = (timeout: number) => {
  let timer: NodeJS.Timeout | undefined;
  const debouncer = (func: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(func, timeout);
  };
  return debouncer;
};

export type Debouncer = ((func: () => void) => void) & {
  /** Run the pending call now. No-op when nothing is pending. */
  flush: () => void;
  /** Drop the pending call without running it. */
  cancel: () => void;
};

/**
 * The timer is cleared on unmount, so a call still inside the debounce window is dropped by any
 * navigation. Anything that navigates deliberately must `flush()` first or it discards that edit.
 */
export const useDebouncer = (timeout: number): Debouncer => {
  const timeoutRef = useRef<NodeJS.Timeout | undefined>();
  const pendingRef = useRef<(() => void) | undefined>();

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [timeout]);

  const cancel = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
    pendingRef.current = undefined;
  }, []);

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    cancel();
    pending?.();
  }, [cancel]);

  return useMemo(() => {
    const debouncer = ((func: () => void) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      pendingRef.current = func;
      timeoutRef.current = setTimeout(() => {
        // cleared before running so a flush racing the timer cannot run it twice
        timeoutRef.current = undefined;
        pendingRef.current = undefined;
        func();
      }, timeout);
    }) as Debouncer;
    debouncer.flush = flush;
    debouncer.cancel = cancel;
    return debouncer;
  }, [timeout, flush, cancel]);
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
