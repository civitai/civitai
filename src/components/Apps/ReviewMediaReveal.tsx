import type { ReactNode } from 'react';
import {
  BrowsingModeOverrideCtx,
  useBrowsingLevelContext,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { reviewMediaNeedsReveal } from '~/components/Apps/reviewMediaRevealRule';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  getHighestBrowsingLevelBit,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * Click-to-reveal for listing media on the MODERATOR review surfaces: on a host that cannot show
 * mature content (civitai.com), an image rated above PG-13 (R, X, XXX, or Blocked) is blurred,
 * with the site's own "This image is rated … / Show" overlay, until the moderator clicks Show.
 * Everywhere else the children render as they are.
 *
 * 🔴 BUILT ON `ImageGuard2`, NOT BESIDE IT — the same overlay, the same per-image reveal state
 * (revealing an image here reveals every copy of it on the page). One thing differs: the guard
 * normally follows the viewer's own blur preference, and a moderator who turned blurring off
 * would then see mature media unblurred on civitai.com. The review must not depend on that, so
 * the subtree's `blurLevels` is pinned to every mature level.
 *
 * `image` is the image the block is held by (for a block of several, the most mature —
 * `mostMatureReviewImage`). `explain: false` blurs without the overlay, for a thumbnail too small
 * to carry it whose row opens the full-size review.
 */
export function ReviewMediaReveal({
  image,
  children,
  explain = true,
  testId,
}: {
  image: { imageId: number; nsfwLevel: number } | null | undefined;
  children: ReactNode;
  explain?: boolean;
  testId?: string;
}) {
  const features = useFeatureFlags();
  const ctx = useBrowsingLevelContext();
  if (!image || !reviewMediaNeedsReveal(features?.canViewNsfw, image.nsfwLevel))
    return <>{children}</>;
  return (
    <BrowsingModeOverrideCtx.Provider value={{ ...ctx, blurLevels: nsfwBrowsingLevelsFlag }}>
      <div style={{ position: 'relative' }} data-testid={testId}>
        {/* The guard's own "is this mature" test reads a level as ONE rung, so it is handed
            the image's most severe bit (`getHighestBrowsingLevelBit`, what the site labels a
            composite by): a composite carrying R (PG | R) is held back here, and the guard must
            agree, or it would show what this wrapper decided to blur. */}
        <ImageGuard2
          image={{ id: image.imageId, nsfwLevel: getHighestBrowsingLevelBit(image.nsfwLevel) }}
          explain={explain}
        >
          {(shown) => (
            <div
              data-revealed={shown ? 'true' : 'false'}
              aria-hidden={shown ? undefined : true}
              style={shown ? undefined : { filter: 'blur(24px)', pointerEvents: 'none' }}
            >
              {children}
            </div>
          )}
        </ImageGuard2>
      </div>
    </BrowsingModeOverrideCtx.Provider>
  );
}
