import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import dayjs from '~/shared/utils/dayjs';
import { isArray } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session, SessionUser } from '~/types/session';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { checkNotUpToDate } from '~/server/db/db-helpers';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { generateSecretHash } from '~/server/utils/key-generator';
import { getAllServerHosts } from '~/server/utils/server-domain';
import type { Partner } from '~/shared/utils/prisma/models';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';
import { logToAxiom, buildCentralErrorLog } from '~/server/logging/client';

// Fire-and-forget structured, cause-walked error log for a REST 500 produced by
// `handleEndpointError`. logToAxiom's stderr write is synchronous (→ Alloy → Loki),
// so the queryable `_axiom` line lands even though we don't await; the `.catch`
// guarantees telemetry can never break the error response. Server faults carry the
// un-masked `.cause` chain + `level:'error'` (queryable as detected_level="error");
// client-fault 4xx are NOT routed here, so they never hit the error stream.
function logRestServerFault(e: unknown) {
  logToAxiom({ ...buildCentralErrorLog(e), source: 'handleEndpointError' }, 'civitai-prod').catch(
    () => undefined
  );
}

type AxiomAPIRequest = NextApiRequest & { log: Logger };

// Single chokepoint every endpoint wrapper funnels through (in place of a bare
// `withAxiom`). Records a `civitai_app_http_errors_total` sample for any 5xx
// response — however it's produced — by attaching one `finish` listener. Steady-
// state cost is one listener registration + an int compare; the route
// normalization runs only on 5xx. See src/server/prom/http-errors.ts.
function withApiMetrics(
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void | NextApiResponse>
) {
  return withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    instrumentApiResponse(req, res);
    // `await` without returning so this closure is Promise<void> — withAxiom's
    // AxiomApiHandler overload requires that, and withAxiom already discards a
    // handler's return value (same shape the 6 wrappers below rely on).
    await handler(req, res);
  });
}

export function TokenSecuredEndpoint(
  token: string,
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void>
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (req.query.token !== token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await handler(req, res);
  });
}

export function JobEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void>
) {
  return TokenSecuredEndpoint(env.JOB_TOKEN, handler);
}

export function WebhookEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void>
) {
  return TokenSecuredEndpoint(env.WEBHOOK_TOKEN, handler);
}

const PUBLIC_CACHE_MAX_AGE = 300;
const PUBLIC_CACHE_STALE_WHILE_REVALIDATE = PUBLIC_CACHE_MAX_AGE / 2;

const allowedOrigins = [env.NEXTAUTH_URL, ...env.TRPC_ORIGINS, ...getAllServerHosts()]
  .filter(isDefined)
  .map((origin) => {
    if (!origin.startsWith('http')) return `https://${origin}`;
    return origin;
  });
export const addCorsHeaders = (
  req: NextApiRequest,
  res: NextApiResponse,
  allowedMethods: string[] = ['GET'],
  { allowCredentials = false }: { allowCredentials?: boolean } = {}
) => {
  if (allowCredentials) {
    const origin = req.headers.origin;
    const allowedOrigin = allowedOrigins.find((o) => origin?.startsWith(o)) ?? allowedOrigins[0];
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
};

const addPublicCacheHeaders = (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader(
    'Cache-Control',
    `public, s-maxage=${PUBLIC_CACHE_MAX_AGE}, stale-while-revalidate=${PUBLIC_CACHE_STALE_WHILE_REVALIDATE}`
  );
};

export function PublicEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void | NextApiResponse>,
  allowedMethods: string[] = ['GET']
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    const shouldStop = addCorsHeaders(req, res, allowedMethods);
    addPublicCacheHeaders(req, res);
    if (shouldStop) return;
    await handler(req, res);
  });
}

export function AuthedEndpoint(
  handler: (
    req: AxiomAPIRequest,
    res: NextApiResponse,
    user: SessionUser
  ) => Promise<void | NextApiResponse>,
  allowedMethods: string[] = ['GET']
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    const shouldStop = addCorsHeaders(req, res, allowedMethods, { allowCredentials: true });
    if (shouldStop) return;

    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    const session = await getServerAuthSession({ req, res });
    if (!session?.user) return res.status(401).json({ error: 'Unauthorized' });
    await handler(req, res, session.user);
  });
}

export function MixedAuthEndpoint(
  handler: (
    req: AxiomAPIRequest,
    res: NextApiResponse,
    user: Session['user'] | undefined
  ) => Promise<void | NextApiResponse>,
  allowedMethods: string[] = ['GET']
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    const shouldStop = addCorsHeaders(req, res, allowedMethods);
    const session = await getServerAuthSession({ req, res });
    if (!session) addPublicCacheHeaders(req, res);
    if (shouldStop) return;

    if (!!req.query?.etag && req.query.etag !== '') {
      const isNotUpToDate = await checkNotUpToDate(
        isArray(req.query.etag) ? req.query.etag[0] : req.query.etag
      );
      // logToAxiom({
      //   name: 'etag-stuff',
      //   type: 'info',
      //   data: {
      //     url: req.url,
      //     etag: req.query.etag,
      //     isNotUpToDate,
      //     expiresHeader: dayjs().add(1, 'minute').toISOString(),
      //   },
      // }).catch();
      if (isNotUpToDate) {
        res.setHeader('X-Expires', dayjs().add(1, 'minute').toISOString());
      }
    }

    await handler(req, res, session?.user);
  });
}

export function PartnerEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse, partner: Partner) => Promise<void>,
  allowedMethods: string[] = ['GET']
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    if (!req.query.token || Array.isArray(req.query.token))
      return res.status(401).json({ error: 'Unauthorized' });
    const token = generateSecretHash(req.query.token);
    const partner = await dbRead.partner.findUnique({ where: { token } });
    if (!partner) return res.status(401).json({ error: 'Unauthorized', message: 'Bad token' });

    await handler(req, res, partner);
  });
}

export function ModEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse, user: SessionUser) => Promise<void>,
  allowedMethods: string[] = ['GET']
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (!req.method || !allowedMethods.includes(req.method)) {
      res.setHeader('Allow', allowedMethods);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const session = await getServerAuthSession({ req, res });
    if (!session || !session.user?.isModerator || !!session.user.bannedAt)
      return res.status(401).json({ error: 'Unauthorized' });

    await handler(req, res, session.user);
  });
}

export function handleEndpointError(res: NextApiResponse, e: unknown) {
  if (isClientAbortError(e)) {
    // Client disconnected mid-request (closed tab / scrolled the feed past /
    // navigated away), cancelling the request signal. Not a server fault: respond
    // 499 (client closed request) so it stays out of the 5xx SLO + the
    // civitai_app_http_errors_total counter and isn't logged as a spurious 500.
    if (!res.headersSent) res.status(499).end();
    return;
  }
  if (e instanceof TRPCError) {
    const apiError = e as TRPCError;
    const status = getHTTPStatusCodeFromError(apiError);
    // A TRPCError that maps to a 5xx (INTERNAL_SERVER_ERROR / TIMEOUT) is a genuine
    // server fault that previously reached the client as a 500 with NOTHING logged
    // structurally — invisible in `_axiom`. Emit the un-masked cause-walked error
    // log so it's queryable. Sub-500 (4xx) TRPCErrors are normal client feedback —
    // skip, so they don't flood the error stream.
    if (status >= 500) logRestServerFault(apiError);
    // Older Zod-validation TRPCErrors stuff a JSON-encoded issue array into
    // `message`; many newer call sites (incl. `withMeili`'s
    // MeiliCallTimeoutError → TRPCError mapping) pass a plain string. Falling
    // through to JSON.parse on a plain string throws SyntaxError, escapes
    // uncaught, and turns a transient 408/503 into a Next.js default 500 —
    // the opposite of fail-fast. Try the parse, fall back to a one-shot
    // { message } envelope on failure.
    let body: unknown;
    try {
      body = JSON.parse(apiError.message);
    } catch {
      body = { message: apiError.message };
    }
    return res.status(status).json(body);
  } else {
    const error = e as Error;
    // This branch increments the http-errors counter (via the wrapper's
    // instrumentApiResponse) but historically logged nothing structural, so any
    // non-TRPCError throw inside a wrapped handler — e.g. an unguarded TypeError —
    // was counted yet completely un-attributable in logs (it took a live repro to
    // find one such silent 500). Emit the structured, cause-walked `_axiom` error
    // log (name + message + stack, un-masked cause) so the next one is attributable
    // from Loki the normal way. safeError keeps it PII-light (primitive fields only).
    logRestServerFault(error);
    return res.status(500).json({ message: 'An unexpected error occurred', error: error.message });
  }
}

export function OrchestratorEndpoint(
  handler: (
    req: AxiomAPIRequest,
    res: NextApiResponse,
    user: SessionUser,
    token: string
  ) => Promise<void | NextApiResponse>,
  allowedMethods: string[] = ['GET']
) {
  return AuthedEndpoint(async (req, res, user) => {
    const token = await getOrchestratorToken(user.id, { req, res });
    return await handler(req, res, user, token);
  }, allowedMethods);
}
