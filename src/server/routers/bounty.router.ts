import {
  createBountyHandler,
  deleteBountyHandler,
  getBountyHandler,
  getBountyEntriesHandler,
  getInfiniteBountiesHandler,
  updateBountyHandler,
  addBenefactorUnitAmountHandler,
  getBountyBenefactorsHandler,
} from '../controllers/bounty.controller';
import { middleware, protectedProcedure, publicProcedure, router } from '../trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  addBenefactorUnitAmountInputSchema,
  createBountyInputSchema,
  getBountyEntriesInputSchema,
  GetBountyEntriesInputSchema,
  getInfiniteBountySchema,
  updateBountyInputSchema,
} from '~/server/schema/bounty.schema';
import { dbWrite } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

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
  getInfinite: publicProcedure.input(getInfiniteBountySchema).query(getInfiniteBountiesHandler),
  getById: publicProcedure.input(getByIdSchema).query(getBountyHandler),
  getEntries: publicProcedure.input(getBountyEntriesInputSchema).query(getBountyEntriesHandler),
  getBenefactors: publicProcedure.input(getByIdSchema).query(getBountyBenefactorsHandler),
  create: protectedProcedure.input(createBountyInputSchema).mutation(createBountyHandler),
  update: protectedProcedure
    .input(updateBountyInputSchema)
    .use(isOwnerOrModerator)
    .mutation(updateBountyHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteBountyHandler),
  addBenefactorUnitAmount: protectedProcedure
    .input(addBenefactorUnitAmountInputSchema)
    .mutation(addBenefactorUnitAmountHandler),
});
