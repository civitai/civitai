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

/**
 * Model3DGallery
 *
 * Renders the canonical "as-posts" gallery (multi-image carousels, NSFW
 * level gating, image metadata popovers) bound to a Model3D. Backed by the
 * same `ImagesAsPostsInfinite` used on the regular model page — `model3dId`
 * is forwarded to `getImagesAsPostsInfinite`, which pre-resolves it to
 * `postIds` via `Post.model3dId`.
 *
 * Mirrors `ModelGallery` for the lazy-load + forced-minor-level wrapping.
 */
export function Model3DGallery({
  model3d,
}: {
  model3d: { id: number; userId: number; minor?: boolean };
}) {
  const node = useScrollAreaRef();
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView({
    root: node?.current,
    rootMargin: '10% 0px',
    triggerOnce: true,
  });

  // Surface gallery moderation controls (hide image / hide user via the
  // post card menu + the show/hide-hidden eye toggle) when the viewer is the
  // creator or a moderator. Mirrors ModelGallery's `showModerationOptions`.
  const showModerationOptions =
    !!currentUser &&
    (currentUser.id === model3d.userId || currentUser.isModerator === true);

  const content = inView && (
    <ImagesAsPostsInfinite
      source={{ kind: 'model3d', id: model3d.id, creatorUserId: model3d.userId }}
      showModerationOptions={showModerationOptions}
    />
  );
  const forceMinorLevel = !!model3d.minor && !currentUser?.isModerator;
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
