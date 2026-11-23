import type { Context } from '~/server/createContext';
import {
  domainServableLevels,
  getRequestBrowsingLevel,
  requestServableLevels,
} from '~/server/utils/browsing-level';

/**
 * `imageVisibilityConditions`' `shownReviewImageLevels` for this request: the viewer's own levels,
 * held to what the domain serves. None where service reviews are not shown (their flags): a review
 * image then opens to its uploader alone.
 */
export function shownReviewImageLevelsFor(ctx: Pick<Context, 'features' | 'user' | 'req'>) {
  const { features } = ctx;
  if (!features.creatorShop || !features.creatorServices || !features.creatorServicesNext) return 0;
  return (
    getRequestBrowsingLevel(ctx) & requestServableLevels(ctx) & domainServableLevels(ctx as Context)
  );
}
