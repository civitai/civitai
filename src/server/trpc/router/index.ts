// src/server/trpc/router/index.ts
import { router } from '../trpc';
import { modelRouter } from './model';
import { userRouter } from './user';
import { authRouter } from './auth';

export const appRouter = router({
  auth: authRouter,
  model: modelRouter,
  user: userRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
