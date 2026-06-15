import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { Tracker } from './clickhouse/client';
import requestIp from 'request-ip';
import { isProd } from '~/env/other';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { createCallerFactory } from '~/server/trpc';
import { appRouter } from '~/server/routers';
import { getAllServerHosts, getRequestDomainColor } from '~/server/utils/server-domain';
import { TokenScope } from '~/shared/constants/token-scope.constants';

type CacheSettings = {
  browserTTL?: number;
  edgeTTL?: number;
  staleWhileRevalidate?: number;
  tags?: string[];
  canCache?: boolean;
  skip: boolean;
};

function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

// Allowlist of hosts permitted to issue cookie-authenticated cross-origin
// requests. Built from server domains (primary + aliases), explicit
// TRPC_ORIGINS, and NEXTAUTH_URL.
const allowedOriginHosts = new Set<string>(
  [...getAllServerHosts(), ...env.TRPC_ORIGINS.map(hostFromUrl), hostFromUrl(env.NEXTAUTH_URL)]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase())
);

// Origin preferred; Referer is the fallback for clients that suppress Origin.
// Absent both, treat as untrusted — isAcceptableOrigin rejects the request.
function isAllowedOriginRequest(req: NextApiRequest): boolean {
  const sourceHost = hostFromUrl(req.headers.origin) ?? hostFromUrl(req.headers.referer);
  return !!sourceHost && allowedOriginHosts.has(sourceHost);
}

export const createContext = async ({
  req,
  res,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
}) => {
  const session = await getServerAuthSession({ req, res });
  const ip = requestIp.getClientIp(req) ?? '';
  // Bearer/API-key auth carries no cookies, so CSRF does not apply.
  const isBearerAuth = (req as any).context?.apiKeyId != null;
  const acceptableOrigin = !isProd || isBearerAuth || isAllowedOriginRequest(req);
  // Pass the already-resolved session so high-volume tracking routes
  // (e.g. track.addView ~100/s on api-primary) skip the Tracker's own
  // getServerAuthSession call. Matters for ANONYMOUS requests: a null session
  // isn't memoized by req.context.session, so the lazy path re-decrypted the
  // JWE on every track() call (authenticated requests already cache-hit).
  const track = new Tracker(req, res, session);
  const cache: CacheSettings | null = {
    browserTTL: session?.user ? 0 : 60,
    edgeTTL: session?.user ? 0 : 60,
    staleWhileRevalidate: session?.user ? 0 : 30,
    canCache: true,
    skip: false,
  };
  const domain = getRequestDomainColor(req) ?? 'blue';

  // Abort downstream work (Meili, DB calls that plumb signal) when the client
  // disconnects — e.g. when the image feed's slow-fetch timeout cancels a hung
  // request. Saves pod CPU on requests whose response will never be read.
  //
  // Listen on `res` (per-request) rather than `req.socket` (long-lived,
  // reused across keep-alive requests). `res.close` fires once when the
  // underlying connection terminates OR after `res.end()` completes, covering
  // both abnormal client disconnect and normal completion. Because `res` is
  // per-request and not reused, the listener is reclaimed by GC when `res`
  // becomes unreferenced — no manual detach needed, and no accumulation on
  // the keep-alive socket.
  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!res.writableEnded && !abortController.signal.aborted) abortController.abort();
  };
  res.once('close', onDisconnect);

  // tokenScope: from bearer token auth (stored on req.context by getServerAuthSession).
  // Session auth (cookies) gets Full scope â€” no restrictions for browser users.
  const tokenScope = ((req as any).context?.tokenScope as number) ?? TokenScope.Full;
  // apiKeyId / subject are only present when auth came from a Bearer token.
  // Modeled as optional (undefined when absent) so DeepNonNullable<Context> in
  // controller signatures can collapse them to required fields when the caller
  // already knows the request is token-auth'd.
  const apiKeyId = (req as any).context?.apiKeyId as number | undefined;
  const subject = (req as any).context?.subject as
    | { type: 'apiKey'; id: number }
    | { type: 'oauth'; id: string }
    | undefined;

  // Tag content-creation tracking with how the request was authenticated (web vs.
  // personal API key vs. OAuth app) so moderators can trace agent/API activity.
  track.setProvenance({ subject, apiKeyId });

  return {
    user: session?.user,
    acceptableOrigin,
    features: getFeatureFlagsLazy({ user: session?.user, req }),
    track,
    ip,
    cache,
    res,
    req,
    domain,
    signal: abortController.signal,
    tokenScope,
    apiKeyId,
    subject,
  };
};

const createCaller = createCallerFactory(appRouter);
export const publicApiContext2 = async (req: NextApiRequest, res: NextApiResponse) => {
  const domain = getRequestDomainColor(req) ?? 'blue';

  return createCaller({
    user: undefined,
    acceptableOrigin: true,
    features: getFeatureFlagsLazy({ req }),
    track: new Tracker(req, res),
    ip: requestIp.getClientIp(req) ?? '',
    cache: {
      browserTTL: 3 * 60,
      edgeTTL: 3 * 60,
      staleWhileRevalidate: 60,
      canCache: true,
      skip: false,
    },
    res,
    req,
    domain,
    // Non-client-facing context â€” use an always-open signal so downstream
    // callers that expect AbortSignal have a valid value.
    signal: new AbortController().signal,
    tokenScope: TokenScope.Full,
    apiKeyId: undefined,
    subject: undefined,
  });
};

export const publicApiContext = async (req: NextApiRequest, res: NextApiResponse) => {
  return {
    user: undefined,
    acceptableOrigin: true,
    features: getFeatureFlagsLazy({ req }),
    track: new Tracker(req, res),
    ip: requestIp.getClientIp(req) ?? '',
    cache: {
      browserCacheTTL: 3 * 60,
      edgeCacheTTL: 3 * 60,
      staleWhileRevalidate: 60,
      canCache: true,
      skip: false,
    },
    res,
    req,
  };
};

export type Context = AsyncReturnType<typeof createContext>;

/**
 * Context shape for protected procedures, where `user` (and other base fields)
 * are guaranteed non-null but `apiKeyId`/`subject` legitimately remain nullable
 * (session auth has no apiKeyId). Replaces `DeepNonNullable<Context>` for
 * controllers, which would otherwise strip the nullability of these fields.
 */
export type ProtectedContext = Omit<DeepNonNullable<Context>, 'apiKeyId' | 'subject'> &
  Pick<Context, 'apiKeyId' | 'subject'>;
