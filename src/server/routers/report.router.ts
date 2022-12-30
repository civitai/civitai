import { getReportsSchema, setReportStatusSchema } from './../schema/report.schema';
import {
  createReportHandler,
  getReportsHandler,
  setReportStatusHandler,
} from '~/server/controllers/report.controller';
import { createReportInputSchema } from '~/server/schema/report.schema';
import { middleware, protectedProcedure, router } from './../trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

const isModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user?.isModerator) throw throwAuthorizationError();

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
    },
  });
});

export const reportRouter = router({
  create: protectedProcedure.input(createReportInputSchema).mutation(createReportHandler),
  getAll: protectedProcedure.input(getReportsSchema).use(isModerator).query(getReportsHandler),
  setStatus: protectedProcedure
    .input(setReportStatusSchema)
    .use(isModerator)
    .mutation(setReportStatusHandler),
});
