import { allowMatureContentForCeiling } from '~/shared/constants/browsingLevel.constants';
import { isMatureContentRating } from '~/server/utils/server-domain';

/**
 * Whether a block token with this `maxBrowsingLevel` claim may reach an app rated `rating`: the
 * mint's rule ({@link isMatureContentRating}, refused off a red-capable host) read from the ceiling
 * the mint derived from that host (`allowMatureContentForCeiling`). An absent claim is the SFW
 * ceiling. The one statement of it: the document store's import read (`doc-store-access.ts`) and the
 * registry's private feed, for a block-exchange token's `civitai_max_browsing_level`
 * (`registry-adapter/private-feed.ts`), both call it.
 *
 * Its own module, not `server-domain.ts`: `browsingLevel.constants` reads `NsfwLevel` at load, and
 * `server-domain.ts` is in the import graph of the auth session modules (via `session-metrics.ts`),
 * whose suites mock `~/server/common/enums` without `NsfwLevel`. Importing it there failed those
 * suites at load.
 */
export function ratingAllowedForCeiling(
  rating: unknown,
  maxBrowsingLevel: number | undefined
): boolean {
  if (!isMatureContentRating(typeof rating === 'string' ? rating : null)) return true;
  if (typeof maxBrowsingLevel !== 'number' || !Number.isFinite(maxBrowsingLevel)) return false;
  return allowMatureContentForCeiling(maxBrowsingLevel) !== false;
}
