import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

/**
 * Whether a moderator review surface must hold an image behind a click-to-reveal: on a host that
 * cannot show mature content (`canViewNsfw` false — civitai.com, or any host in a restricted
 * region), an image the site does not count as safe (`getIsSafeBrowsingLevel`: any R, X, XXX or
 * Blocked bit). Anything else — SFW, or a host that shows mature content — renders as it is.
 *
 * An image nothing has rated yet (level 0) is NOT held back: there is no level to judge it by,
 * which is the site's own convention for moderators (`ImageGuard2` shows unprocessed media to
 * them), and the go-live scan gate refuses to publish it until it is rated.
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
  return !!nsfwLevel && !getIsSafeBrowsingLevel(nsfwLevel);
}

/** The most mature of `images` (by level), or `null` — what a block of several is held by. */
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
