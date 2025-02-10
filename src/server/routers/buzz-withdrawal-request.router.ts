import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { getByIdStringSchema } from '~/server/schema/base.schema';
import {
  cancelBuzzWithdrawalRequestHandler,
  createBuzzWithdrawalRequestHandler,
  getPaginatedBuzzWithdrawalRequestsHandler,
  getPaginatedOwnedBuzzWithdrawalRequestsHandler,
  updateBuzzWithdrawalRequestHandler,
} from '../controllers/buzz-withdrawal-request.controller';
import {
  BuzzWithdrawalRequestServiceStatus,
  buzzWithdrawalRequestServiceStatusSchema,
  createBuzzWithdrawalRequestSchema,
  getPaginatedBuzzWithdrawalRequestSchema,
  getPaginatedOwnedBuzzWithdrawalRequestSchema,
  updateBuzzWithdrawalRequestSchema,
} from '../schema/buzz-withdrawal-request.schema';
import { isFlagProtected, moderatorProcedure, protectedProcedure, router } from '../trpc';

export const buzzWithdrawalRequestRouter = router({
  getPaginatedOwned: protectedProcedure
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
  getServiceStatus: protectedProcedure.query(async () => {
    const status = buzzWithdrawalRequestServiceStatusSchema.parse(
      JSON.parse(
        (await sysRedis.hGet(
          REDIS_SYS_KEYS.SYSTEM.FEATURES,
          REDIS_SYS_KEYS.BUZZ_WITHDRAWAL_REQUEST.STATUS
        )) ?? '{}'
      )
    );

    return status as BuzzWithdrawalRequestServiceStatus;
  }),
  // update:
});
