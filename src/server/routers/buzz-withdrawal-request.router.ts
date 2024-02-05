import {
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '../trpc';
import {
  createBuzzWithdrawalRequestSchema,
  getPaginatedBuzzWithdrawalRequestSchema,
  getPaginatedOwnedBuzzWithdrawalRequestSchema,
  updateBuzzWithdrawalRequestSchema,
} from '../schema/buzz-withdrawal-request.schema';
import {
  cancelBuzzWithdrawalRequestHandler,
  createBuzzWithdrawalRequestHandler,
  getPaginatedBuzzWithdrawalRequestsHandler,
  getPaginatedOwnedBuzzWithdrawalRequestsHandler,
  updateBuzzWithdrawalRequestHandler,
} from '../controllers/buzz-withdrawal-request.controller';
import { getByIdStringSchema } from '~/server/schema/base.schema';

export const buzzWithdrawalRequestRouter = router({
  getPaginatedOwned: publicProcedure
    .input(getPaginatedOwnedBuzzWithdrawalRequestSchema)
    .use(isFlagProtected('creatorsProgram'))
    .query(getPaginatedOwnedBuzzWithdrawalRequestsHandler),
  getPaginated: moderatorProcedure
    .input(getPaginatedBuzzWithdrawalRequestSchema)
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
  update: moderatorProcedure
    .input(updateBuzzWithdrawalRequestSchema)
    .use(isFlagProtected('creatorsProgram'))
    .mutation(updateBuzzWithdrawalRequestHandler),
  // update:
});
