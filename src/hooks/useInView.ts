import { IntersectionOptions, useInView as useInViewObserver } from 'react-intersection-observer';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useInView as useElementInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';

export function useInView(options?: IntersectionOptions) {
  // const node = useScrollAreaRef();
  // return useElementInView({ root: node?.current, ...options });
  const [ref, inView] = useElementInView();
  return { ref, inView };
}
