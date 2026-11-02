import {
  createCsamReportHandler,
  createExternalCsamReportHandler,
} from '~/server/controllers/csam.controller';
import { paginationSchema } from '~/server/schema/base.schema';
import {
  createCsamReportSchema,
  createExternalCsamReportSchema,
  getCsamSupplementalPreviewSchema,
  getImageResourcesSchema,
} from '~/server/schema/csam.schema';
import { getCsamSupplementalPreview } from '~/server/services/csam-supplemental.service';
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
  getSupplementalPreview: moderatorProcedure
    .input(getCsamSupplementalPreviewSchema)
    .query(({ input, ctx }) => getCsamSupplementalPreview({ ...input, reportedById: ctx.user.id })),
  createExternalReport: moderatorProcedure
    .input(createExternalCsamReportSchema)
    .mutation(createExternalCsamReportHandler),
  getCsamReports: moderatorProcedure
    .input(paginationSchema)
    .query(({ input }) => getCsamReportsPaged(input)),
  getCsamReportsStats: moderatorProcedure.query(() => getCsamReportStats()),
});
