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
  createBuzzWithdrawalRequestHandler,
  getPaginatedBuzzWithdrawalRequestsHandler,
  getPaginatedOwnedBuzzWithdrawalRequestsHandler,
} from '../controllers/buzz-withdrawal-request.controller';

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
  // cancel:
  // update:
});
