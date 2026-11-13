import { TRPCError } from '@trpc/server';
import { rateLimit } from '~/server/middleware.trpc';
import { sleepingAppSchema } from '~/server/schema/app-hibernation.schema';
import { isAppHibernateEnabled } from '~/server/services/app-blocks-flag';
import { protectedProcedure, router } from '~/server/trpc';

/**
 * The signed-in user's OWN sleeping (hibernated) apps: list them, get the seed a wake restores
 * from, delete one. Behind the `app-hibernate` flag. Browser session callers only
 * (`blockApiKeys`), and every procedure acts on `ctx.user.id`, never on a user named in the input.
 */
const sleepingAppsProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (await isAppHibernateEnabled({ user: ctx.user })) return next();
  throw new TRPCError({ code: 'FORBIDDEN', message: 'Sleeping apps are not enabled' });
});

async function service() {
  const [svc, { defaultHibernationDeps }] = await Promise.all([
    import('~/server/services/app-hibernation/app-hibernation.service'),
    import('~/server/services/app-hibernation/hibernation-deps'),
  ]);
  return { svc, deps: await defaultHibernationDeps() };
}

export const appHibernationRouter = router({
  /** Every sleeping app of the viewer, newest first. */
  listMine: sleepingAppsProcedure.meta({ blockApiKeys: true }).query(async ({ ctx }) => {
    const { svc, deps } = await service();
    return svc.listSleepingApps(ctx.user.id, deps);
  }),

  /**
   * The seed a wake restores from: a short-lived presigned GET of the archive with its sha256 and
   * size. `hasSecrets` tells the sandbox service to restore `.env*` after the seed lands
   * (`/api/internal/app-hibernation/secrets`); the decrypted secrets never come through here.
   */
  getWakeSeed: sleepingAppsProcedure
    .meta({ blockApiKeys: true })
    .input(sleepingAppSchema)
    .use(rateLimit({ limit: 60, period: 60 * 60 }))
    .mutation(async ({ ctx, input }) => {
      const { svc, deps } = await service();
      const seed = await svc.getWakeSeed(ctx.user.id, input.app, deps);
      if (seed === 'not-configured')
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Sleeping apps are unavailable',
        });
      if (!seed)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No sleeping app by that name' });
      return seed;
    }),

  /** Delete one sleeping app for good: its record and its stored files. */
  deleteMine: sleepingAppsProcedure
    .meta({ blockApiKeys: true })
    .input(sleepingAppSchema)
    .use(rateLimit({ limit: 60, period: 60 * 60 }))
    .mutation(async ({ ctx, input }) => {
      const { svc, deps } = await service();
      const { deleted } = await svc.deleteSleepingApp(ctx.user.id, input.app, deps);
      if (!deleted)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No sleeping app by that name' });
      return { deleted };
    }),
});
