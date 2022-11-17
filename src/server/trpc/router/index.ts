// src/server/trpc/router/index.ts
import { router } from '~/server/router';
import { accountRouter } from './accounts';
import { authRouter } from './auth';
import { modelRouter } from './model';
import { reviewRouter } from './review';
import { tagRouter } from './tag';
import { userRouter } from './user';

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
