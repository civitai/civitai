import { getReportsSchema, setReportStatusSchema } from './../schema/report.schema';
import {
  createReportHandler,
  getReportsHandler,
  setReportStatusHandler,
} from '~/server/controllers/report.controller';
import { createReportInputSchema } from '~/server/schema/report.schema';
import { protectedProcedure, router } from './../trpc';
import { isModerator } from '~/server/routers/base.router';

export const reportRouter = router({
  create: protectedProcedure.input(createReportInputSchema).mutation(createReportHandler),
  getAll: protectedProcedure.input(getReportsSchema).use(isModerator).query(getReportsHandler),
  setStatus: protectedProcedure
    .input(setReportStatusSchema)
    .use(isModerator)
    .mutation(setReportStatusHandler),
});
