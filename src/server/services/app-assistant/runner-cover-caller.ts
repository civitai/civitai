import type { NextApiRequest, NextApiResponse } from 'next';
import type { CoverListingApi } from '@civitai/app-assistant';
import { userApiCaller } from '~/server/public-api-context';
import type { SessionUser } from '~/types/session';

/**
 * The listing editor's own read (`appListings.getMyListingForApp`) as `user`, through the
 * procedure, not its service: its rate limit is shared with the page, and its error mapping turns
 * someone else's listing into the NOT_FOUND / FORBIDDEN that `readCoverListing` reads as "none".
 * Its own module so only the cover endpoint pulls the router in.
 */
export function runnerCoverListingApi(
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
): Pick<CoverListingApi, 'getMyListingForApp'> {
  const caller = userApiCaller(req, res, user);
  return { getMyListingForApp: (input) => caller.appListings.getMyListingForApp(input) };
}
