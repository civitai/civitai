import { IntersectionOptions, useInView as useInViewObserver } from 'react-intersection-observer';
import { useScrollAreaContext } from '~/components/ScrollArea/ScrollArea';

export function useInView(options?: IntersectionOptions) {
  const node = useScrollAreaContext();
  return useInViewObserver({ root: node, ...options });
}
