import {
  getAnswersHandler,
  getAnswerDetailHandler,
  upsertAnswerHandler,
  deleteAnswerHandler,
  setAnswerVoteHandler,
} from './../controllers/answer.controller';
import { getAnswersSchema, upsertAnswerSchema, answerVoteSchema } from './../schema/answer.schema';
import { getByIdSchema } from '~/server/schema/base.schema';

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
    ownerId = (await prisma.answer.findUnique({ where: { id } }))?.userId ?? 0;
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

export const answerRouter = router({
  getById: publicProcedure.input(getByIdSchema).query(getAnswerDetailHandler),
  getAll: publicProcedure.input(getAnswersSchema).query(getAnswersHandler),
  upsert: protectedProcedure
    .input(upsertAnswerSchema)
    .use(isOwnerOrModerator)
    .mutation(upsertAnswerHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteAnswerHandler),
  vote: protectedProcedure.input(answerVoteSchema).mutation(setAnswerVoteHandler),
});
