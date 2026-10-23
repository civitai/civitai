import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt } from '~/server/middleware.trpc';
import {
  editSiteAlertSchema,
  extendSiteAlertSchema,
  getActiveSiteAlertsSchema,
  postSiteAlertSchema,
  siteAlertIdSchema,
} from '~/server/schema/site-alert.schema';
import {
  editSiteAlert,
  endSiteAlert,
  extendSiteAlert,
  getActiveSiteAlerts,
  listSiteAlerts,
  postSiteAlert,
} from '~/server/services/site-alert.service';
import { moderatorProcedure, publicProcedure, router } from '~/server/trpc';

export const siteAlertRouter = router({
  // No cache tag and no purge on save, deliberately: a save publishes a new version, so browsers
  // fetch a URL the edge has never seen. The short TTL bounds how long an older version's list
  // (or the bare URL's) can outlive a later save.
  getActive: publicProcedure
    .input(getActiveSiteAlertsSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(async ({ input, ctx }) => {
      const payload = await getActiveSiteAlerts(input.v ?? 0);
      // Only the current version's URL (or the bare one) may be cached; one ahead of this pod
      // would pin a stale list under the new version's URL. All three flags, because with
      // `canCache` off the TTLs keep the context defaults (60s for anonymous).
      if (input.v !== undefined && input.v !== payload.version && ctx.cache) {
        ctx.cache.canCache = false;
        ctx.cache.edgeTTL = 0;
        ctx.cache.browserTTL = 0;
      }
      return payload;
    }),
  list: moderatorProcedure.query(() => listSiteAlerts()),
  post: moderatorProcedure
    .input(postSiteAlertSchema)
    .mutation(({ input, ctx }) => postSiteAlert(input, ctx.user)),
  edit: moderatorProcedure
    .input(editSiteAlertSchema)
    .mutation(({ input, ctx }) => editSiteAlert(input, ctx.user)),
  extend: moderatorProcedure
    .input(extendSiteAlertSchema)
    .mutation(({ input, ctx }) => extendSiteAlert(input, ctx.user)),
  end: moderatorProcedure
    .input(siteAlertIdSchema)
    .mutation(({ input, ctx }) => endSiteAlert(input, ctx.user)),
});
