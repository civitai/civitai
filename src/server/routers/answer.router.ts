import {
  getAnswersHandler,
  getAnswerDetailHandler,
  upsertAnswerHandler,
  deleteAnswerHandler,
  setAnswerVoteHandler,
} from './../controllers/answer.controller';
import { getAnswersSchema, upsertAnswerSchema, answerVoteSchema } from './../schema/answer.schema';
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
import { TokenScope } from '~/shared/constants/token-scope.constants';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await dbRead.answer.findUnique({ where: { id } }))?.userId ?? 0;
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
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getAnswerDetailHandler),
  getAll: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getAnswersSchema)
    .query(getAnswersHandler),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(upsertAnswerSchema)
    .use(isOwnerOrModerator)
    .mutation(upsertAnswerHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteAnswerHandler),
  vote: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(answerVoteSchema)
    .mutation(setAnswerVoteHandler),
});
