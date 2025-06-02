import type { IntersectionOptions } from 'react-intersection-observer';
import type { CustomIntersectionObserverCallback } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { useInView as useElementInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import type { Key } from 'react';
import { useDeferredValue } from 'react';

export function useInView<T extends HTMLElement = HTMLDivElement>(options?: {
  key?: Key;
  initialInView?: boolean;
  callback?: CustomIntersectionObserverCallback;
}) {
  const [ref, inView] = useElementInView<T>(options);
  // const deferred = useDeferredValue(inView);
  return { ref, inView };
}
