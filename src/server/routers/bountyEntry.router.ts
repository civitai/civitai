import { getByIdSchema } from '../schema/base.schema';
import {
  guardedProcedure,
  isFlagProtected,
  middleware,
  protectedProcedure,
  publicProcedure,
  router,
} from '../trpc';
import {
  awardBountyEntryHandler,
  deleteBountyEntryHandler,
  getBountyEntryFilteredFilesHandler,
  getBountyEntryHandler,
  submitBountyEntryHandler,
  upsertBountyEntryHandler,
} from '~/server/controllers/bountyEntry.controller';
import {
  submitBountyEntryInputSchema,
  upsertBountyEntryInputSchema,
} from '~/server/schema/bounty-entry.schema';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { dbWrite } from '~/server/db/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;

  if (!isModerator && !!id) {
    const ownerId = (
      await dbWrite.bountyEntry.findUnique({ where: { id }, select: { userId: true } })
    )?.userId;
    if (ownerId !== userId) throw throwAuthorizationError();
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
    },
  });
});

export const bountyEntryRouter = router({
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.BountiesRead })
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .query(getBountyEntryHandler),
  getFiles: publicProcedure
    .meta({ requiredScope: TokenScope.BountiesRead })
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .query(getBountyEntryFilteredFilesHandler),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite })
    .input(upsertBountyEntryInputSchema)
    .use(isFlagProtected('bounties'))
    .mutation(upsertBountyEntryHandler),
  submit: guardedProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite })
    .input(submitBountyEntryInputSchema)
    .use(isFlagProtected('bounties'))
    .mutation(submitBountyEntryHandler),
  award: protectedProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .mutation(awardBountyEntryHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.BountiesDelete })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .use(isFlagProtected('bounties'))
    .mutation(deleteBountyEntryHandler),
});
