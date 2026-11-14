import type { NextApiRequest } from 'next';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import { effectiveBrowsingCeiling } from '~/shared/constants/browsingLevel.constants';
import type { SessionUser } from '~/types/session';

/** The viewer's own browsing level for this request (`getServerBrowsingLevel`; PG when absent). */
export function viewerOwnBrowsingLevel(req: NextApiRequest, sessionUser: SessionUser | undefined) {
  const canViewNsfw = getFeatureFlags({ user: sessionUser, req }).canViewNsfw;
  return getServerBrowsingLevel({ canViewNsfw, user: sessionUser });
}

/**
 * The domain ceiling intersected with the viewer's own level. `maxBrowsingLevel`
 * is per domain, so without this a viewer with NSFW off would get the same wide
 * ceiling as one at XXX. Never wider than `maxBrowsingLevel`: on `blue` the
 * viewer's saved level may carry R/X/XXX while the domain permits SFW only.
 */
export function viewerEffectiveBrowsingLevel(args: {
  req: NextApiRequest;
  sessionUser: SessionUser | undefined;
  maxBrowsingLevel: number;
}): number {
  const { req, sessionUser, maxBrowsingLevel } = args;
  return effectiveBrowsingCeiling(maxBrowsingLevel, viewerOwnBrowsingLevel(req, sessionUser));
}
