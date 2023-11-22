import { IntersectionOptions, useInView as useInViewObserver } from 'react-intersection-observer';
import { useScrollAreaNode } from '~/components/ScrollArea/ScrollArea';

export function useInView(options?: IntersectionOptions) {
  const node = useScrollAreaNode();
  return useInViewObserver({ root: node, ...options });
}
