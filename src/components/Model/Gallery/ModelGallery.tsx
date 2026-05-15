import { useInView } from 'react-intersection-observer';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type { ImagesAsPostsInfiniteProps } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { ImagesAsPostsInfinite } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export function ModelGallery(props: ImagesAsPostsInfiniteProps) {
  const node = useScrollAreaRef();
  const { ref, inView } = useInView({
    root: node?.current,
    rootMargin: '10% 0px',
    triggerOnce: true,
  });

  return (
    <div ref={ref} className="min-h-80 w-full">
      <BrowsingLevelProvider
        forcedBrowsingLevel={props.model.minor ? publicBrowsingLevelsFlag : undefined}
      >
        {inView && <ImagesAsPostsInfinite {...props} />}
      </BrowsingLevelProvider>
    </div>
  );
}
