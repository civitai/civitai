import type { ReactNode } from 'react';
import {
  BrowsingModeOverrideCtx,
  useBrowsingLevelContext,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { reviewMediaNeedsReveal } from '~/components/Apps/reviewMediaRevealRule';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
 * to carry it whose row opens the full-size review. `toggle` is for a thumbnail too small to carry
 * the overlay that has NO larger view to reveal it in (the sub-listing queue): it blurs without
 * the overlay and puts the site's own compact show / hide control (`ImageGuard2.BlurToggle`) in
 * the corner instead — outside the `inert` subtree, so it stays clickable while the image is
 * hidden.
 */
export function ReviewMediaReveal({
  image,
  children,
  explain = true,
  toggle = false,
  testId,
}: {
  image: { imageId: number; nsfwLevel: number } | null | undefined;
  children: ReactNode;
  explain?: boolean;
  toggle?: boolean;
  testId?: string;
}) {
  // Optional: a surface rendered outside the flags provider reads as civitai.com (blur), never
  // as a crash or as a host that shows mature content.
  const features = useOptionalFeatureFlags();
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
          explain={explain && !toggle}
        >
          {(shown) => (
            <>
              {toggle && (
                <ImageGuard2.BlurToggle
                  className="absolute left-1 top-1 z-10"
                  size="sm"
                  data-testid={testId ? `${testId}-toggle` : undefined}
                />
              )}
              {/* 🔴 `inert` WHILE HIDDEN, NOT JUST A BLUR. `filter` and `pointerEvents` stop the
                  eye and the mouse, not the keyboard: a focusable child (a screenshot tile, a
                  lightbox button) stayed reachable by Tab, and Enter opened its full-size viewer
                  — a portal outside this blur — so the reveal could be bypassed without clicking
                  Show. `inert` removes the subtree from focus, pointer targeting and the
                  accessibility tree (which is why there is no `aria-hidden`). React 18 has no
                  `inert` prop, so it is set as a plain attribute: '' = present. */}
              <div
                data-revealed={shown ? 'true' : 'false'}
                {...(shown ? {} : { inert: '' })}
                style={shown ? undefined : { filter: 'blur(24px)', pointerEvents: 'none' }}
              >
                {children}
              </div>
            </>
          )}
        </ImageGuard2>
      </div>
    </BrowsingModeOverrideCtx.Provider>
  );
}
