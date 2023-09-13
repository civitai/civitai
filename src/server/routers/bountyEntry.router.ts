import { getByIdSchema } from '../schema/base.schema';
import { middleware, protectedProcedure, publicProcedure, router } from '../trpc';
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
  getById: publicProcedure.input(getByIdSchema).query(getBountyEntryHandler),
  getFiles: publicProcedure.input(getByIdSchema).query(getBountyEntryFilteredFilesHandler),
  create: protectedProcedure.input(upsertBountyEntryInputSchema).mutation(upsertBountyEntryHandler),
  award: protectedProcedure.input(getByIdSchema).mutation(awardBountyEntryHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteBountyEntryHandler),
});
