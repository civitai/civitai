import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { Tracker } from './clickhouse/client';
import requestIp from 'request-ip';
import { isProd } from '~/env/other';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { createCallerFactory } from '@trpc/server';
import { appRouter } from '~/server/routers';
import { Fingerprint } from '~/server/utils/fingerprint';
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

const origins = [...env.TRPC_ORIGINS];
const hosts = getAllServerHosts();
export const createContext = async ({
  req,
  res,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
}) => {
  const session = await getServerAuthSession({ req, res });
  const ip = requestIp.getClientIp(req) ?? '';
  const acceptableOrigin = isProd
    ? (origins.some((o) => req.headers.referer?.startsWith(o)) ||
        hosts.some((h) => req.headers.host === h)) ??
      false
    : true;
  const track = new Tracker(req, res);
  const cache: CacheSettings | null = {
    browserTTL: session?.user ? 0 : 60,
    edgeTTL: session?.user ? 0 : 60,
    staleWhileRevalidate: session?.user ? 0 : 30,
    canCache: true,
    skip: false,
  };
  const fingerprint = new Fingerprint((req.headers['x-fingerprint'] as string) ?? '');
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

  return {
    user: session?.user,
    acceptableOrigin,
    features: getFeatureFlagsLazy({ user: session?.user, req }),
    track,
    ip,
    cache,
    fingerprint,
    res,
    req,
    domain,
    signal: abortController.signal,
    tokenScope,
    apiKeyId,
    subject,
  };
};

const createCaller = createCallerFactory()(appRouter);
export const publicApiContext2 = async (req: NextApiRequest, res: NextApiResponse) => {
  const domain = getRequestDomainColor(req) ?? 'blue';

  return createCaller({
    user: undefined,
    acceptableOrigin: true,
    features: getFeatureFlagsLazy({ req }),
    fingerprint: new Fingerprint((req.headers['x-fingerprint'] as string) ?? ''),
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
    fingerprint: new Fingerprint((req.headers['x-fingerprint'] as string) ?? ''),
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
