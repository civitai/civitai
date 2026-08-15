import type { NextApiRequest, NextApiResponse } from 'next';
import { Tracker } from '~/server/clickhouse/client';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { createCallerFactory } from '~/server/trpc';
import { appRouter } from '~/server/routers';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Kept out of `~/server/createContext` deliberately: this is the only piece that needs
// `appRouter`, and having it there put the entire tRPC router in the graph of every module
// that only wanted the `Context` type or `createContext` itself.
const createCaller = createCallerFactory(appRouter);
export const publicApiContext2 = async (req: NextApiRequest, res: NextApiResponse) => {
  const domain = getRequestDomainColor(req) ?? 'blue';

  return createCaller({
    user: undefined,
    acceptableOrigin: true,
    features: getFeatureFlagsLazy({ req }),
    track: new Tracker(req, res),
    // ATTRIBUTION surface — see the note on `ip` in `createContext` above.
    ip: resolveClientIpOrNull(req) ?? '',
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
