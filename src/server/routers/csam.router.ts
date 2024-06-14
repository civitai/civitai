import { createCsamReportHandler } from '~/server/controllers/csam.controller';
import { paginationSchema } from '~/server/schema/base.schema';
import { csamReportSchema, getImageResourcesSchema } from '~/server/schema/csam.schema';
import {
  getCsamReportStats,
  getCsamReportsPaged,
  getImageResources,
} from '~/server/services/csam.service';
import { moderatorProcedure, router } from '~/server/trpc';

export const csamRouter = router({
  getImageResources: moderatorProcedure
    .input(getImageResourcesSchema)
    .query(({ input }) => getImageResources(input)),
  createReport: moderatorProcedure.input(csamReportSchema).mutation(createCsamReportHandler),
  getCsamReports: moderatorProcedure
    .input(paginationSchema)
    .query(({ input }) => getCsamReportsPaged(input)),
  getCsamReportsStats: moderatorProcedure.query(() => getCsamReportStats()),
});
