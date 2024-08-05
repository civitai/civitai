import { IntersectionOptions, useInView as useInViewObserver } from 'react-intersection-observer';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useInView as useElementInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';

export function useInView<T extends HTMLElement = HTMLDivElement>(options?: IntersectionOptions) {
  // const node = useScrollAreaRef();
  // return useElementInView({ root: node?.current, ...options });
  const [ref, inView] = useElementInView<T>();
  return { ref, inView };
}
