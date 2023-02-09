import {
  createReportHandler,
  getReportsHandler,
  setReportStatusHandler,
  updateReportHandler,
} from '~/server/controllers/report.controller';
import { isModerator } from '~/server/routers/base.router';
import {
  createReportInputSchema,
  getReportsSchema,
  setReportStatusSchema,
  updateReportSchema,
} from '~/server/schema/report.schema';
import { protectedProcedure, router } from '~/server/trpc';

export const reportRouter = router({
  create: protectedProcedure.input(createReportInputSchema).mutation(createReportHandler),
  getAll: protectedProcedure.input(getReportsSchema).use(isModerator).query(getReportsHandler),
  update: protectedProcedure
    .input(updateReportSchema)
    .use(isModerator)
    .mutation(updateReportHandler),
  setStatus: protectedProcedure
    .input(setReportStatusSchema)
    .use(isModerator)
    .mutation(setReportStatusHandler),
});
