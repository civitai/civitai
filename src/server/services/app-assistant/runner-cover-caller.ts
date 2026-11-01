import type { NextApiRequest, NextApiResponse } from 'next';
import type { CoverListingApi } from '@civitai/app-assistant';
import { Tracker } from '~/server/clickhouse/client';
import { appRouter } from '~/server/routers';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { createCallerFactory } from '~/server/trpc';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

// Its own module (as `public-api-context.ts`): only the cover endpoints pull the router in.
const createCaller = createCallerFactory(appRouter);

/**
 * The listing editor's own read (`appListings.getMyListingForApp`), called as `user` exactly as the
 * page calls it over tRPC: every middleware it carries (the author capability and Apps flags, its
 * per-user rate limit, shared with the page) runs, and the service behind it is the same one. Only
 * the transport differs: a run grant in place of the session cookie. Covers are only made by the
 * page, on the user's press, so the runner reaches nothing that writes.
 */
export function runnerCoverListingApi(
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
): Pick<CoverListingApi, 'getMyListingForApp'> {
  const caller = createCaller({
    user,
    // A server-to-server call with the runner's secret: no browser origin to check (as a Bearer call).
    acceptableOrigin: true,
    features: getFeatureFlagsLazy({ user, req }),
    track: new Tracker(req, res, { user }),
    ip: resolveClientIpOrNull(req) ?? '',
    cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: false, skip: true },
    res,
    req,
    domain: getRequestDomainColor(req) ?? 'blue',
    signal: new AbortController().signal,
    // The page's session cookie carries the full scope; these procedures are what the page calls.
    tokenScope: TokenScope.Full,
    apiKeyId: undefined,
    apiKeyType: undefined,
    subject: undefined,
  });
  return { getMyListingForApp: (input) => caller.appListings.getMyListingForApp(input) };
}
