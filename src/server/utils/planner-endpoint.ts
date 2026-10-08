import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Tracker } from '~/server/clickhouse/client';
import type { Context } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { createCallerFactory } from '~/server/trpc';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { isDriverAuthoredMessage } from '~/server/utils/errorHandling';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

// The REST twin of the planner procedures (/api/v1/posts/planner/[action]) exists for Creator
// Studio, which has no tRPC client and forwards the shared session cookie. It calls the procedures
// through this caller so every guard — ban, onboarding, flag, token scope, the release checks —
// is the procedure's own, never a second copy (docs/batch-scheduling-plan.md §2, finding 9).
// The one guard this cannot inherit is `isAcceptableOrigin`: Creator Studio forwards server-side
// with no Origin header, so `acceptableOrigin` is forced true and `requireJsonBody` stands in for
// it on writes. Same field set as `publicApiContext2`, with the session user filled in.

const createCaller = createCallerFactory(appRouter);

type RequestContext = Pick<Context, 'apiKeyId' | 'subject'> & { tokenScope?: number };

export function createPlannerCaller(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  const requestContext = ((req as NextApiRequest & { context?: RequestContext }).context ??
    {}) as RequestContext;
  const track = new Tracker(req, res, { user });
  track.setProvenance({ subject: requestContext.subject, apiKeyId: requestContext.apiKeyId });

  return createCaller({
    user,
    acceptableOrigin: true,
    features: getFeatureFlagsLazy({ user, req }),
    track,
    ip: resolveClientIpOrNull(req) ?? '',
    cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false },
    res,
    req,
    domain: getRequestDomainColor(req) ?? 'blue',
    signal: new AbortController().signal,
    // No tokenScope means a cookie session: full authority, as in `createContext`.
    tokenScope: requestContext.tokenScope ?? TokenScope.Full,
    apiKeyId: requestContext.apiKeyId,
    subject: requestContext.subject,
  });
}

export type PlannerCaller = ReturnType<typeof createPlannerCaller>;

/**
 * A cookie-authenticated write must arrive as JSON. A form-encoded POST is a "simple request" that a
 * same-site page could send on the creator's behalf without a preflight; JSON forces the preflight,
 * where `addCorsHeaders` only grants credentials to allowlisted origins. API-key requests are not
 * cookie-ridden and are exempt.
 */
export function requireJsonBody(req: NextApiRequest, res: NextApiResponse): boolean {
  const requestContext = (req as NextApiRequest & { context?: RequestContext }).context;
  if (requestContext?.apiKeyId) return true;
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.toLowerCase().startsWith('application/json')) return true;
  res
    .status(415)
    .json({ error: 'Send this request as application/json', code: 'UNSUPPORTED_MEDIA_TYPE' });
  return false;
}

/** A refusal the spoke is meant to read keeps its message; anything else goes through the
 *  shared REST error path, which genericizes server faults. */
export function handlePlannerError(res: NextApiResponse, error: unknown) {
  if (error instanceof TRPCError && !isDriverAuthoredMessage(error.message, error)) {
    const status = getHTTPStatusCodeFromError(error);
    if (status < 500) return res.status(status).json({ error: error.message, code: error.code });
  }
  return handleEndpointError(res, error);
}
