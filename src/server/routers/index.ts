import { router } from '~/server/createRouter';
import { modelRouter } from '~/server/routers/model.router';

export const appRouter = router({
  model: modelRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
