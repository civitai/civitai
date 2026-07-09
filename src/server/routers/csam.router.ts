import {
  createCsamReportHandler,
  createExternalCsamReportHandler,
} from '~/server/controllers/csam.controller';
import { paginationSchema } from '~/server/schema/base.schema';
import {
  createCsamReportSchema,
  createExternalCsamReportSchema,
  getImageResourcesSchema,
} from '~/server/schema/csam.schema';
import {
  getCsamReportStats,
  getCsamReportsPaged,
  getImageResources,
} from '~/server/services/csam.service';
import { moderatorProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const csamRouter = router({
  getImageResources: moderatorProcedure
    .input(getImageResourcesSchema)
    .query(({ input }) => getImageResources(input)),
  createReport: moderatorProcedure.input(createCsamReportSchema).mutation(createCsamReportHandler),
  createExternalReport: moderatorProcedure
    .input(createExternalCsamReportSchema)
    .mutation(createExternalCsamReportHandler),
  getCsamReports: moderatorProcedure
    .input(paginationSchema)
    .query(({ input }) => getCsamReportsPaged(input)),
  getCsamReportsStats: moderatorProcedure.query(() => getCsamReportStats()),
});
