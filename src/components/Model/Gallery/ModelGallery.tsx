import { useInView } from 'react-intersection-observer';
import type { ImagesAsPostsInfiniteProps } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { ImagesAsPostsInfinite } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

export function ModelGallery(props: ImagesAsPostsInfiniteProps) {
  const node = useScrollAreaRef();
  const { ref, inView } = useInView({
    root: node?.current,
    rootMargin: '10% 0px',
    triggerOnce: true,
  });

  return (
    <div ref={ref} className="min-h-80 w-full">
      {inView && <ImagesAsPostsInfinite {...props} />}
    </div>
  );
}
