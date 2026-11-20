import { TRPCError } from '@trpc/server';
import { appBlocksAuthorAccount } from '~/server/auth/full-user-credential';
import { isAppBlocksAuthorEnabled } from '~/server/services/app-blocks-flag';
import { middleware } from '~/server/trpc';

/**
 * The App Blocks AUTHOR gate the routers attach to a `protectedProcedure` (`app-listings` and
 * `app-collaborators`), evaluated by `isAppBlocksAuthorEnabled`: the moderator floor plus the
 * `app-blocks-author` cohort. Fail-closed: with the flag absent or Flipt down, moderators only.
 *
 * Reads the account via `appBlocksAuthorAccount`, not `ctx.user` (see there).
 */
export const enforceAppBlocksAuthorFlag = middleware(async ({ ctx, next }) => {
  // A bare middleware's ctx is not narrowed by `isAuthed`; this refusal keeps it safe on a
  // `publicProcedure`.
  const account = appBlocksAuthorAccount(ctx);
  if (!account) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps authoring is not enabled' });
  }
  if (await isAppBlocksAuthorEnabled({ user: account })) return next();
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps authoring is not enabled' });
});
