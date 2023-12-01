import { IntersectionOptions, useInView as useInViewObserver } from 'react-intersection-observer';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollArea';

export function useInView(options?: IntersectionOptions) {
  const node = useScrollAreaRef();
  return useInViewObserver({ root: node?.current, ...options });
}
