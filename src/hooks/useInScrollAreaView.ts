import { IntersectionOptions, useInView } from 'react-intersection-observer';
import { useScrollAreaContext } from '~/components/ScrollArea/ScrollArea';

export function useInScrollAreaView(options?: IntersectionOptions) {
  const node = useScrollAreaContext();
  return useInView({ root: node, ...options });
}
