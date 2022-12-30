import {
  createBountyHandler,
  deleteBountyHandler,
  getBountiesInfiniteHandler,
  getBountyDetailsHandler,
  updateBountyHandler,
} from '~/server/controllers/bounty.controller';
import { prisma } from '~/server/db/client';
import { getByIdSchema } from '~/server/schema/base.schema';
import { bountyUpsertSchema, getAllBountiesSchema } from '~/server/schema/bounty.schema';
import { middleware, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await prisma.bounty.findUnique({ where: { id } }))?.userId ?? 0;
    if (!isModerator) {
      if (ownerId !== userId) throw throwAuthorizationError();
    }
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
      ownerId,
    },
  });
});

export const bountyRouter = router({
  getAll: publicProcedure.input(getAllBountiesSchema).query(getBountiesInfiniteHandler),
  getById: publicProcedure.input(getByIdSchema).query(getBountyDetailsHandler),
  add: protectedProcedure.input(bountyUpsertSchema).mutation(createBountyHandler),
  update: protectedProcedure
    .input(bountyUpsertSchema)
    .use(isOwnerOrModerator)
    .mutation(updateBountyHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteBountyHandler),
});
