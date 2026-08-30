import { NsfwLevel } from '~/server/common/enums';

/**
 * Which browsing level a read should run at, given the three the provider holds.
 *
 * Pure and in its own module so the precedence can be tested without rendering
 * anything — the hooks that use it are the thinnest possible wrappers over these
 * two functions.
 *
 * The three inputs are not interchangeable:
 *
 * - `forced` is the DOMAIN cap, mirroring the server middleware: anonymous is PG
 *   anywhere, logged-in on the green domain is PG+PG-13. It is not a preference
 *   and nobody may opt out of it, so it wins in both resolutions below.
 * - `override` is a page saying "read my subtree at some OTHER level". The image
 *   detail page sets it to the image's own rating.
 * - `user` is the viewer's saved preference.
 */
type BrowsingLevelInputs = {
  forced?: number;
  override?: number;
  user?: number;
};

/** The level a page asked for, falling back to the viewer's own. */
export function resolvePageBrowsingLevel({ forced, override, user }: BrowsingLevelInputs) {
  return forced ?? override ?? user;
}

/**
 * The viewer's own level, ignoring any page override.
 *
 * 🔴 `forced` is still first, and that ordering is the safety property worth
 * protecting: skipping the page override must not also skip the domain cap.
 * Collapsing this to `user` alone would serve a logged-in viewer's saved
 * preference on the green domain, which the server middleware forbids.
 *
 * Used where a page's subtree contains OTHER people's images — a list scoped to
 * the rating of the image it hangs beside drops entries that can never intersect
 * it. Measured on prod 2026-08-29: 161 of 488 approved remix-gallery entries
 * were invisible that way, 160 of them paid.
 */
export function resolveViewerBrowsingLevel({
  forced,
  user,
}: Omit<BrowsingLevelInputs, 'override'>) {
  return forced ?? user;
}

/** What both hooks fall back to once debouncing has settled on nothing. */
export const BROWSING_LEVEL_FALLBACK = NsfwLevel.PG;
