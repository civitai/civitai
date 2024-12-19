import type { IntersectionOptions } from 'react-intersection-observer';
import {
  CustomIntersectionObserverCallback,
  useInView as useElementInView,
} from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { Key, useDeferredValue } from 'react';

export function useInView<T extends HTMLElement = HTMLDivElement>(options?: {
  key?: Key;
  initialInView?: boolean;
  callback?: CustomIntersectionObserverCallback;
}) {
  const [ref, inView] = useElementInView<T>(options);
  // const deferred = useDeferredValue(inView);
  return { ref, inView };
}
