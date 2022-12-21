import { createReportHandler } from '~/server/controllers/report.controller';
import { reportInputSchema } from '~/server/schema/report.schema';
import { protectedProcedure, router } from './../trpc';

export const reportRouter = router({
  create: protectedProcedure.input(reportInputSchema).mutation(createReportHandler),
});
