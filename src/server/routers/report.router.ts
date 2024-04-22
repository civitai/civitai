import {
  bulkUpdateReportStatusHandler,
  createReportHandler,
  getReportsHandler,
  setReportStatusHandler,
  updateReportHandler,
} from '~/server/controllers/report.controller';
import {
  bulkUpdateReportStatusSchema,
  createReportInputSchema,
  getReportsSchema,
  setReportStatusSchema,
  updateReportSchema,
} from '~/server/schema/report.schema';
import { guardedProcedure, moderatorProcedure, router } from '~/server/trpc';

export const reportRouter = router({
  create: guardedProcedure.input(createReportInputSchema).mutation(createReportHandler),
  getAll: moderatorProcedure.input(getReportsSchema).query(getReportsHandler),
  update: moderatorProcedure.input(updateReportSchema).mutation(updateReportHandler),
  setStatus: moderatorProcedure.input(setReportStatusSchema).mutation(setReportStatusHandler),
  bulkUpdateStatus: moderatorProcedure
    .input(bulkUpdateReportStatusSchema)
    .mutation(bulkUpdateReportStatusHandler),
});
