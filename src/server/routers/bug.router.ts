import { CacheTTL } from '~/server/common/constants';
import { applyRequestDomainColor, edgeCacheIt } from '~/server/middleware.trpc';
import {
  createBugInput,
  deleteBugInput,
  getBugByIdInput,
  getBugReportStatsInput,
  getBugsInput,
  reportBugInput,
  updateBugInput,
} from '~/server/schema/bug.schema';
import {
  bugReportCounter,
  createBug,
  deleteBug,
  getBugById,
  getBugReportStats,
  getBugStatusForReport,
  getBugs,
  getLatestBugUpdate,
  updateBug,
} from '~/server/services/bug.service';
import { isFlagProtected, moderatorProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const bugRouter = router({
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getBugsInput)
    .use(applyRequestDomainColor)
    .query(({ input, ctx }) =>
      getBugs({
        ...input,
        hasFeature: ctx.features.bugsEdit,
      })
    ),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getBugByIdInput)
    .query(({ input }) => getBugById(input)),
  getLatest: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getBugsInput.pick({ domain: true }).default({}))
    .use(applyRequestDomainColor)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ input }) => getLatestBugUpdate(input)),
  report: publicProcedure.input(reportBugInput).mutation(async ({ input, ctx }) => {
    const status = await getBugStatusForReport(input.bugId);
    await ctx.track.bugReport({ bugId: input.bugId, status });
    const newCount = await bugReportCounter.incrementBy(input.bugId, 1);
    return { reportCount: newCount };
  }),
  getReportStats: moderatorProcedure
    .input(getBugReportStatsInput)
    .use(isFlagProtected('bugsEdit'))
    .query(({ input }) => getBugReportStats(input)),
  create: moderatorProcedure
    .input(createBugInput)
    .use(isFlagProtected('bugsEdit'))
    .mutation(({ input }) => createBug(input)),
  update: moderatorProcedure
    .input(updateBugInput)
    .use(isFlagProtected('bugsEdit'))
    .mutation(({ input }) => updateBug(input)),
  delete: moderatorProcedure
    .input(deleteBugInput)
    .use(isFlagProtected('bugsEdit'))
    .mutation(({ input }) => deleteBug(input)),
});
