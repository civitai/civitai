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
  upsertBountyEntryHandler,
} from '~/server/controllers/bountyEntry.controller';
import { upsertBountyEntryInputSchema } from '~/server/schema/bounty-entry.schema';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { dbWrite } from '~/server/db/client';

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
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .query(getBountyEntryHandler),
  getFiles: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .query(getBountyEntryFilteredFilesHandler),
  upsert: guardedProcedure
    .input(upsertBountyEntryInputSchema)
    .use(isFlagProtected('bounties'))
    .mutation(upsertBountyEntryHandler),
  award: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('bounties'))
    .mutation(awardBountyEntryHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .use(isFlagProtected('bounties'))
    .mutation(deleteBountyEntryHandler),
});
