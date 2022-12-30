// A collection of utilities for routers

import { middleware } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

export const isModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user?.isModerator) throw throwAuthorizationError();

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
    },
  });
});
