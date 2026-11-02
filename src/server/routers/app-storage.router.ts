import { TRPCError } from '@trpc/server';
import { rateLimit } from '~/server/middleware.trpc';
import {
  appStorageForAppSchema,
  emptyMyAppStorageSchema,
} from '~/server/schema/app-storage.schema';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { protectedProcedure, router } from '~/server/trpc';

/**
 * The signed-in user's OWN App Blocks document-store data (`doc-store-viewer-usage.service.ts`):
 * the account-settings "App storage" card and the running app's near-limit notice. Session
 * callers only (no token scope is annotated, so an API token is refused), and every procedure
 * acts on `ctx.user.id`, never on a user named in the input.
 */
const appStorageUserProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (await isAppBlocksEnabled({ user: ctx.user })) return next();
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
});

export const appStorageRouter = router({
  /** Every app the user holds production documents in, with their usage against the ceiling. */
  listMine: appStorageUserProcedure.query(async ({ ctx }) => {
    const { getMyAppStorage } = await import(
      '~/server/services/apps/doc-store-viewer-usage.service'
    );
    return getMyAppStorage(ctx.user.id);
  }),

  /** The user's usage in one app: read once when they open it, for the near-limit notice. */
  getMineForApp: appStorageUserProcedure
    .input(appStorageForAppSchema)
    .query(async ({ ctx, input }) => {
      const { getMyAppStorageForApp } = await import(
        '~/server/services/apps/doc-store-viewer-usage.service'
      );
      return getMyAppStorageForApp(ctx.user.id, input.appBlockId);
    }),

  /** Empty the user's data in one app (private documents; shared ones only when asked). */
  emptyMine: appStorageUserProcedure
    .input(emptyMyAppStorageSchema)
    .use(rateLimit({ limit: 20, period: 60 * 60 }))
    .mutation(async ({ ctx, input }) => {
      const { emptyMyAppStorage } = await import(
        '~/server/services/apps/doc-store-viewer-usage.service'
      );
      return emptyMyAppStorage(ctx.user.id, input.appBlockId, {
        includeShared: input.includeShared,
      });
    }),
});
