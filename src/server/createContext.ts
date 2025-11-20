import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { Tracker } from './clickhouse/client';
import requestIp from 'request-ip';
import { isProd } from '~/env/other';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { Fingerprint } from '~/server/utils/fingerprint';
import { getRequestDomainColor } from '~/shared/constants/domain.constants';
import type { CacheSettings, Context } from '~/server/context/types';

const origins = [...env.TRPC_ORIGINS];
const hosts = [
  env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN,
  env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE,
  env.NEXT_PUBLIC_SERVER_DOMAIN_RED,
];
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
  } as Context;
};

export const publicApiContext = async (
  req: NextApiRequest,
  res: NextApiResponse
): Promise<Context> => {
  const domain = getRequestDomainColor(req) ?? 'blue';

  return {
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
    fingerprint: new Fingerprint((req.headers['x-fingerprint'] as string) ?? ''),
    res,
    req,
    domain,
  };
};
