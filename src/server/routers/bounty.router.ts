import {
  deleteBountyHandler,
  getBountyHandler,
  getBountyEntriesHandler,
  getInfiniteBountiesHandler,
  addBenefactorUnitAmountHandler,
  getBountyBenefactorsHandler,
  refundBountyHandler,
  upsertBountyHandler,
} from '../controllers/bounty.controller';
import {
  guardedProcedure,
  isFlagProtected,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '../trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  addBenefactorUnitAmountInputSchema,
  getBountyEntriesInputSchema,
  getInfiniteBountySchema,
  upsertBountyInputSchema,
} from '~/server/schema/bounty.schema';
import { dbWrite } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;
  if (!isModerator && !!id) {
    const ownerId = (await dbWrite.bounty.findUnique({ where: { id }, select: { userId: true } }))
      ?.userId;
    if (ownerId !== userId) throw throwAuthorizationError();
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
    },
  });
});

export const bountyRouter = router({
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.BountiesRead })
    .input(getInfiniteBountySchema)
    .use(isFlagProtected('bounties'))
    .query(getInfiniteBountiesHandler),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.BountiesRead })
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .query(getBountyHandler),
  getEntries: publicProcedure
    .meta({ requiredScope: TokenScope.BountiesRead })
    .input(getBountyEntriesInputSchema)
    .use(isFlagProtected('bounties'))
    .query(getBountyEntriesHandler),
  getBenefactors: publicProcedure
    .meta({ requiredScope: TokenScope.BountiesRead })
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .query(getBountyBenefactorsHandler),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite })
    .input(upsertBountyInputSchema)
    .use(isFlagProtected('bounties'))
    .use(isOwnerOrModerator)
    .mutation(upsertBountyHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.BountiesDelete })
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .use(isOwnerOrModerator)
    .mutation(deleteBountyHandler),
  addBenefactorUnitAmount: protectedProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite })
    .input(addBenefactorUnitAmountInputSchema)
    .use(isFlagProtected('bounties'))
    .mutation(addBenefactorUnitAmountHandler),
  refund: moderatorProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .mutation(refundBountyHandler),
});
