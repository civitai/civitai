import { useEffect, useRef, useState } from 'react';

export function useIsOverflown<T extends HTMLElement = HTMLDivElement>(deps: unknown[] = []) {
  const ref = useRef<T>(null);
  const [overflown, setOverflown] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const check = () =>
      setOverflown(
        element.offsetWidth < element.scrollWidth || element.offsetHeight < element.scrollHeight
      );

    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
    // ResizeObserver only sees box changes, so text changes need an explicit re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, overflown };
}
