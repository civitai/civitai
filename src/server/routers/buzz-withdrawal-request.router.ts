import {
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '../trpc';
import {
  createBuzzWithdrawalRequestSchema,
  getPaginatedBuzzWithdrawalRequestForModerationSchema,
  getPaginatedBuzzWithdrawalRequestSchema,
} from '../schema/buzz-withdrawal-request.schema';
import {
  cancelBuzzWithdrawalRequestHandler,
  createBuzzWithdrawalRequestHandler,
  getPaginatedBuzzWithdrawalRequestsHandler,
  getPaginatedOwnedBuzzWithdrawalRequestsHandler,
} from '../controllers/buzz-withdrawal-request.controller';
import { getByIdStringSchema } from '~/server/schema/base.schema';

export const buzzWithdrawalRequestRouter = router({
  getPaginated: publicProcedure
    .input(getPaginatedBuzzWithdrawalRequestSchema)
    .use(isFlagProtected('creatorsProgram'))
    .query(getPaginatedOwnedBuzzWithdrawalRequestsHandler),
  getPaginatedForModeration: moderatorProcedure
    .input(getPaginatedBuzzWithdrawalRequestForModerationSchema)
    .use(isFlagProtected('creatorsProgram'))
    .query(getPaginatedBuzzWithdrawalRequestsHandler),
  create: protectedProcedure
    .input(createBuzzWithdrawalRequestSchema)
    .use(isFlagProtected('creatorsProgram'))
    .mutation(createBuzzWithdrawalRequestHandler),
  cancel: protectedProcedure
    .input(getByIdStringSchema)
    .use(isFlagProtected('creatorsProgram'))
    .mutation(cancelBuzzWithdrawalRequestHandler),
  // update:
});
