import { lazy, type AnyTRPCRouter, type TRPCBuiltRouter } from '@trpc/server';
import { routers } from '~/server/routers/loaders';
import { router } from '~/server/trpc';

type Routers = { [K in keyof typeof routers]: Awaited<ReturnType<(typeof routers)[K]>> };
type RootTypes = ReturnType<typeof router<Record<never, never>>>['_def']['_config']['$types'];

// Don't simplify to `typeof appRouter`: inferring through `router(...)` resolves every
// router's types at once (the memory cost this avoids). This resolves a router only when
// a caller reads it.
export type AppRouter = TRPCBuiltRouter<
  RootTypes,
  { [K in keyof Routers]: Routers[K]['_def']['record'] }
>;

const lazyRouters = (input: typeof routers) =>
  Object.fromEntries(
    Object.entries(input).map(([key, load]) => [key, lazy(load as () => Promise<AnyTRPCRouter>)])
  ) as {
    [K in keyof Routers]: ReturnType<typeof lazy<Routers[K]>>;
  };

export const appRouter: AppRouter = router(lazyRouters(routers));
