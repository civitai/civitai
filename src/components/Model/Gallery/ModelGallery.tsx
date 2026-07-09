import { useInView } from 'react-intersection-observer';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { HiddenPreferencesProvider } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { ImagesAsPostsInfinite } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { ModelById } from '~/types/router';

type ModelVersionsProps = { id: number; name: string; modelId: number };

export type ModelGalleryProps = {
  model: ModelById;
  selectedVersionId?: number;
  modelVersions?: ModelVersionsProps[];
  showModerationOptions?: boolean;
  showPOIWarning?: boolean;
  canReview?: boolean;
  username?: string;
};

export function ModelGallery(props: ModelGalleryProps) {
  const { model, ...rest } = props;
  const node = useScrollAreaRef();
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView({
    root: node?.current,
    rootMargin: '10% 0px',
    triggerOnce: true,
  });

  const content = inView && (
    <ImagesAsPostsInfinite source={{ kind: 'model', model }} {...rest} />
  );
  const forceMinorLevel = !!model.minor && !currentUser?.isModerator;
  const minorBrowsingLevel = currentUser ? sfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;

  return (
    <div ref={ref} className="min-h-80 w-full">
      {forceMinorLevel ? (
        <BrowsingLevelProvider forcedBrowsingLevel={minorBrowsingLevel}>
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
