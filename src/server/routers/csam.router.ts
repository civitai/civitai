import { paginationSchema } from '~/server/schema/base.schema';
import { csamReportUserInputSchema, getImageResourcesSchema } from '~/server/schema/csam.schema';
import {
  createCsamReport,
  getCsamReportStats,
  getCsamReportsPaged,
  getImageResources,
} from '~/server/services/csam.service';
import { moderatorProcedure, router } from '~/server/trpc';

export const csamRouter = router({
  getImageResources: moderatorProcedure
    .input(getImageResourcesSchema)
    .query(({ input }) => getImageResources(input)),
  createReport: moderatorProcedure
    .input(csamReportUserInputSchema)
    .mutation(({ ctx, input }) => createCsamReport({ ...input, reportedById: ctx.user.id })),
  getCsamReports: moderatorProcedure
    .input(paginationSchema)
    .query(({ input }) => getCsamReportsPaged(input)),
  getCsamReportsStats: moderatorProcedure.query(() => getCsamReportStats()),
});
