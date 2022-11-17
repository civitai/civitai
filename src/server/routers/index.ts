// src/server/trpc/router/index.ts
import { router } from '~/server/trpc';
import { accountRouter } from './account.router';
import { authRouter } from './auth.router';
import { modelRouter } from './model.router';
import { reviewRouter } from './review.router';
import { tagRouter } from './tag.router';
import { userRouter } from './user.router';

export const appRouter = router({
  account: accountRouter,
  auth: authRouter,
  model: modelRouter,
  review: reviewRouter,
  tag: tagRouter,
  user: userRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
