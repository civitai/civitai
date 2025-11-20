import type { NextApiRequest, NextApiResponse } from 'next';
import { createCallerFactory } from '@trpc/server';
import requestIp from 'request-ip';
import { appRouter } from '~/server/routers';
import { Tracker } from '~/server/clickhouse/client';
import { Fingerprint } from '~/server/utils/fingerprint';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { getRequestDomainColor } from '~/shared/constants/domain.constants';

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
  });
};
