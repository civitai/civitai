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
  // Listening on the raw socket's 'end' event: Next.js pages router wraps
  // req/res such that req/res 'close' events don't fire until the response
  // finishes (useless for mid-handler cancellation). socket.end fires
  // immediately when the client half-closes the connection, which is exactly
  // what we need. Listener is removed as soon as the response finishes so we
  // don't accumulate handlers on a keep-alive socket.
  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!res.writableEnded && !abortController.signal.aborted) abortController.abort();
  };
  req.socket?.on('end', onDisconnect);
  req.socket?.on('close', onDisconnect);
  const detach = () => {
    req.socket?.off('end', onDisconnect);
    req.socket?.off('close', onDisconnect);
  };
  res.once('finish', detach);
  res.once('close', detach);

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
    // Non-client-facing context — use an always-open signal so downstream
    // callers that expect AbortSignal have a valid value.
    signal: new AbortController().signal,
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
