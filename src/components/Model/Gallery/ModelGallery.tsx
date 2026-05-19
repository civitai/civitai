import { useInView } from 'react-intersection-observer';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { HiddenPreferencesProvider } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import type { ImagesAsPostsInfiniteProps } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { ImagesAsPostsInfinite } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export function ModelGallery(props: ImagesAsPostsInfiniteProps) {
  const node = useScrollAreaRef();
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView({
    root: node?.current,
    rootMargin: '10% 0px',
    triggerOnce: true,
  });

  const content = inView && <ImagesAsPostsInfinite {...props} />;
  const forceMinorLevel = props.model.minor && !currentUser?.isModerator;

  return (
    <div ref={ref} className="min-h-80 w-full">
      {forceMinorLevel ? (
        <BrowsingLevelProvider forcedBrowsingLevel={publicBrowsingLevelsFlag}>
          <BrowsingSettingsAddonsProvider>
            <HiddenPreferencesProvider>{content || null}</HiddenPreferencesProvider>
          </BrowsingSettingsAddonsProvider>
        </BrowsingLevelProvider>
      ) : (
        content
      )}
    </div>
  );
}
