import { TRPCError } from '@trpc/server';
import { rateLimit } from '~/server/middleware.trpc';
import { sleepingAppSchema } from '~/server/schema/app-hibernation.schema';
import { isAppHibernateEnabled } from '~/server/services/app-blocks-flag';
import { protectedProcedure, router } from '~/server/trpc';

/**
 * The signed-in user's OWN sleeping apps (app hibernate): list them, get the seed a wake restores
 * from, delete one. Behind the `app-hibernate` flag. Browser session callers only
 * (`blockApiKeys`), and every procedure acts on `ctx.user.id`, never on a user named in the input.
 */
const sleepingAppsProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (await isAppHibernateEnabled({ user: ctx.user })) return next();
  throw new TRPCError({ code: 'FORBIDDEN', message: 'Sleeping apps are not enabled' });
});

async function service() {
  const [svc, { defaultHibernationDeps }] = await Promise.all([
    import('~/server/services/app-hibernation/sleeping-apps.service'),
    import('~/server/services/app-hibernation/hibernation-deps'),
  ]);
  return { svc, deps: await defaultHibernationDeps() };
}

const NO_SUCH_APP = 'No sleeping app by that name';

export const appHibernationRouter = router({
  /** Every sleeping app of the viewer, most recently put to sleep first. */
  listMine: sleepingAppsProcedure.meta({ blockApiKeys: true }).query(async ({ ctx }) => {
    const { svc, deps } = await service();
    return svc.listSleepingApps(ctx.user.id, deps);
  }),

  /**
   * The seed a wake restores from: a short-lived presigned GET of the archive, its sha256 and
   * size, and the ONE-TIME wake ticket the sandbox service redeems for the app's `.env*` files.
   * The ticket is minted only here (and by the server runner's route, for its run's own user):
   * from the signed-in user's own request.
   */
  getWakeSeed: sleepingAppsProcedure
    .meta({ blockApiKeys: true })
    .input(sleepingAppSchema)
    .use(rateLimit({ limit: 60, period: 60 * 60 }))
    .mutation(async ({ ctx, input }) => {
      const { svc, deps } = await service();
      const result = await svc.getWakeSeed(ctx.user.id, input.app, deps);
      switch (result.kind) {
        case 'ok':
          return result.seed;
        case 'not-found':
          throw new TRPCError({ code: 'NOT_FOUND', message: NO_SUCH_APP });
        case 'changed':
          throw new TRPCError({ code: 'CONFLICT', message: 'The app was changing; try again' });
        case 'disabled':
        case 'account-closed':
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Sleeping apps are not enabled' });
        case 'not-configured':
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Sleeping apps are unavailable',
          });
      }
    }),

  /** Delete one sleeping app for good: its record and its stored files. */
  deleteMine: sleepingAppsProcedure
    .meta({ blockApiKeys: true })
    .input(sleepingAppSchema)
    .use(rateLimit({ limit: 60, period: 60 * 60 }))
    .mutation(async ({ ctx, input }) => {
      const { svc, deps } = await service();
      const result = await svc.deleteSleepingApp(ctx.user.id, input.app, deps);
      if (result.kind === 'not-found')
        throw new TRPCError({ code: 'NOT_FOUND', message: NO_SUCH_APP });
      return { deleted: result.app };
    }),

  /**
   * At the sleeping-app limit: the user confirmed deleting the sleeping app the refusal named (its
   * oldest), so the request that hit the limit can continue. The same delete as `deleteMine`,
   * recorded as made at the limit; it is only ever called after the user's click on that offer
   * (nothing is deleted to make room without one).
   */
  deleteOldestAndContinue: sleepingAppsProcedure
    .meta({ blockApiKeys: true })
    .input(sleepingAppSchema)
    .use(rateLimit({ limit: 60, period: 60 * 60 }))
    .mutation(async ({ ctx, input }) => {
      const { svc, deps } = await service();
      const result = await svc.deleteSleepingApp(ctx.user.id, input.app, deps, 'limit');
      if (result.kind === 'not-found')
        throw new TRPCError({ code: 'NOT_FOUND', message: NO_SUCH_APP });
      return { deleted: result.app };
    }),
});
