import {
  bulkUpdateReportStatusHandler,
  createEntityAppealHandler,
  createReportHandler,
  getRecentAppealsHandler,
  getReportsHandler,
  resolveEntityAppealHandler,
  setReportStatusHandler,
  updateReportHandler,
} from '~/server/controllers/report.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  bulkUpdateReportStatusSchema,
  createEntityAppealSchema,
  createReportInputSchema,
  getRecentAppealsSchema,
  getReportsSchema,
  resolveAppealSchema,
  setReportStatusSchema,
  updateReportSchema,
} from '~/server/schema/report.schema';
import { getAppealDetails } from '~/server/services/report.service';
import { guardedProcedure, moderatorProcedure, protectedProcedure, router } from '~/server/trpc';

export const reportRouter = router({
  create: guardedProcedure.input(createReportInputSchema).mutation(createReportHandler),
  getAll: moderatorProcedure.input(getReportsSchema).query(getReportsHandler),
  update: moderatorProcedure.input(updateReportSchema).mutation(updateReportHandler),
  setStatus: moderatorProcedure.input(setReportStatusSchema).mutation(setReportStatusHandler),
  bulkUpdateStatus: moderatorProcedure
    .input(bulkUpdateReportStatusSchema)
    .mutation(bulkUpdateReportStatusHandler),

  // #region [appeal]
  getRecentAppeals: protectedProcedure.input(getRecentAppealsSchema).query(getRecentAppealsHandler),
  getAppealDetails: protectedProcedure
    .input(getByIdSchema)
    .query(({ input }) => getAppealDetails({ ...input })),
  createAppeal: guardedProcedure
    .input(createEntityAppealSchema)
    .mutation(createEntityAppealHandler),
  resolveAppeal: moderatorProcedure.input(resolveAppealSchema).mutation(resolveEntityAppealHandler),
  // #endregion
});
