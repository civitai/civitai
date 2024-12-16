import type { IntersectionOptions } from 'react-intersection-observer';
import { useInView as useElementInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { useDeferredValue } from 'react';

export function useInView<T extends HTMLElement = HTMLDivElement>(options?: IntersectionOptions) {
  const [ref, inView] = useElementInView<T>();
  // const deferred = useDeferredValue(inView);
  return { ref, inView };
}
