// src/server/trpc/router/index.ts
import { router } from '../trpc';
import { exampleRouter } from './example';
import { modelRouter } from './model';
import { authRouter } from './auth';
import { userRouter } from './user';

export const appRouter = router({
  example: exampleRouter,
  auth: authRouter,
  model: modelRouter,
  user: userRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
