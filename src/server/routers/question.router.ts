import { setQuestionAnswerHandler } from './../controllers/question.controller';
import { setQuestionAnswerSchema } from './../schema/question.schema';
import { getQuestionsSchema, upsertQuestionSchema } from '../schema/question.schema';
import { getByIdSchema } from '~/server/schema/base.schema';

import {
  middleware,
  router,
  publicProcedure,
  protectedProcedure,
  guardedProcedure,
} from '~/server/trpc';
import { dbRead } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  deleteQuestionHandler,
  getQuestionDetailHandler,
  getQuestionsHandler,
  upsertQuestionHandler,
} from '~/server/controllers/question.controller';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await dbRead.question.findUnique({ where: { id } }))?.userId ?? 0;
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

export const questionRouter = router({
  getById: publicProcedure.input(getByIdSchema).query(getQuestionDetailHandler),
  getPaged: publicProcedure.input(getQuestionsSchema).query(getQuestionsHandler),
  upsert: guardedProcedure
    .input(upsertQuestionSchema)
    .use(isOwnerOrModerator)
    .mutation(upsertQuestionHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteQuestionHandler),
  setAnswer: protectedProcedure
    .input(setQuestionAnswerSchema)
    .use(isOwnerOrModerator)
    .mutation(setQuestionAnswerHandler),
});
