import { publicProcedure, router } from '~/server/trpc';
import { getDomainSettings, getLiveNow } from '~/server/services/system-cache';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL, getRequestDomainColor } from '~/server/common/constants';
import { getFeatureFlags } from '../services/feature-flags.service';

export const systemRouter = router({
  getLiveNow: publicProcedure.use(edgeCacheIt({ ttl: CacheTTL.xs })).query(() => getLiveNow()),
  getDomainSettings: publicProcedure.query(({ ctx }) => {
    let colorDomain = getRequestDomainColor(ctx.req);
    if (!colorDomain) {
      const features = getFeatureFlags({ user: ctx.user, host: ctx.req.headers.host });
      colorDomain = features?.isRed ? 'red' : features?.isGreen ? 'green' : 'blue';
    }

    return getDomainSettings(colorDomain);
  }),
});
