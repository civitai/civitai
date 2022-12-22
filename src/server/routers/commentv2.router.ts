import { getByIdSchema } from './../schema/base.schema';
import {
  deleteCommentV2Handler,
  getCommentsV2Handler,
  upsertCommentV2Handler,
} from './../controllers/commentv2.controller';
import { getCommentsV2Schema, upsertCommentv2Schema } from './../schema/commentv2.schema';
import { middleware, router, publicProcedure, protectedProcedure } from '~/server/trpc';
import { prisma } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await prisma.commentV2.findUnique({ where: { id } }))?.userId ?? 0;
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

export const commentv2Router = router({
  getAll: publicProcedure.input(getCommentsV2Schema).query(getCommentsV2Handler),
  upsert: protectedProcedure.input(upsertCommentv2Schema).mutation(upsertCommentV2Handler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteCommentV2Handler),
  // upsert: protectedProcedure
});
