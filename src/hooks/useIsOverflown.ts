import { useEffect, useRef, useState } from 'react';

export function useIsOverflown<T extends HTMLElement = HTMLDivElement>() {
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
  }, []);

  return { ref, overflown };
}
