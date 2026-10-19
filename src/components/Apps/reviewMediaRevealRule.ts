import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * Whether a moderator review surface must hold an image behind a click-to-reveal: on a host that
 * cannot show mature content (`canViewNsfw` false — civitai.com, or any host in a restricted
 * region), an image rated R, X or XXX. Anything else — SFW, not rated yet, or a host that shows
 * mature content — renders as it is.
 *
 * The host test is the browsing-level provider's own (`BrowsingLevelProvider` caps a host
 * without `canViewNsfw` to SFW), so the review blurs exactly where the rest of the site would
 * not show the image at all.
 */
export function reviewMediaNeedsReveal(
  canViewNsfw: boolean | null | undefined,
  nsfwLevel: number | null | undefined
): boolean {
  if (canViewNsfw) return false;
  return !!nsfwLevel && Flags.intersects(nsfwLevel, nsfwBrowsingLevelsFlag);
}

/** The most mature of `images` (by level), or `null` — what a block of several images is held by. */
export function mostMatureReviewImage<T extends { nsfwLevel: number }>(
  images: readonly (T | null | undefined)[]
): T | null {
  let out: T | null = null;
  for (const image of images) {
    if (!image) continue;
    if (!out || image.nsfwLevel > out.nsfwLevel) out = image;
  }
  return out;
}
