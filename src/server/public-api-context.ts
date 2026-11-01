import type { NextApiRequest, NextApiResponse } from 'next';
import { Tracker } from '~/server/clickhouse/client';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { createCallerFactory } from '~/server/trpc';
import { appRouter } from '~/server/routers';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { Context } from '~/server/createContext';
import type { SessionUser } from '~/types/session';

// Kept out of `~/server/createContext` deliberately: this is the only piece that needs
// `appRouter`, and having it there put the entire tRPC router in the graph of every module
// that only wanted the `Context` type or `createContext` itself.
const createCaller = createCallerFactory(appRouter);

type CallerCache = NonNullable<Context['cache']>;

/** A server-side caller's context: no browser origin to check, the full scope, an open signal. */
function serverCaller(
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser | undefined,
  cache: CallerCache
) {
  return createCaller({
    user,
    acceptableOrigin: true,
    features: getFeatureFlagsLazy(user ? { user, req } : { req }),
    track: user ? new Tracker(req, res, { user }) : new Tracker(req, res),
    // ATTRIBUTION surface — see the note on `ip` in `createContext` above.
    ip: resolveClientIpOrNull(req) ?? '',
    cache,
    res,
    req,
    domain: getRequestDomainColor(req) ?? 'blue',
    // Non-client-facing context — use an always-open signal so downstream
    // callers that expect AbortSignal have a valid value.
    signal: new AbortController().signal,
    tokenScope: TokenScope.Full,
    apiKeyId: undefined,
    apiKeyType: undefined,
    subject: undefined,
  });
}

export const publicApiContext2 = async (req: NextApiRequest, res: NextApiResponse) =>
  serverCaller(req, res, undefined, {
    browserTTL: 3 * 60,
    edgeTTL: 3 * 60,
    staleWhileRevalidate: 60,
    canCache: true,
    skip: false,
  });

/**
 * The tRPC procedures as `user`, called server-side exactly as the page calls them: every
 * middleware runs (flags, rate limits, shared with the page). Only the transport differs, so the
 * caller must already have authenticated `user` itself. Never cached.
 */
export const userApiCaller = (req: NextApiRequest, res: NextApiResponse, user: SessionUser) =>
  serverCaller(req, res, user, {
    browserTTL: 0,
    edgeTTL: 0,
    staleWhileRevalidate: 0,
    canCache: false,
    skip: true,
  });
