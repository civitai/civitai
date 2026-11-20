import { TRPCError } from '@trpc/server';
import { appBlocksAuthorAccount } from '~/server/auth/full-user-credential';
import { isAppBlocksAuthorEnabled } from '~/server/services/app-blocks-flag';
import { middleware } from '~/server/trpc';

/**
 * The App Blocks AUTHOR gate the routers attach to a `protectedProcedure` (`app-listings` and
 * `app-collaborators`), evaluated by `isAppBlocksAuthorEnabled`: the moderator floor plus the
 * `app-blocks-author` cohort, so a cohort member may manage their own listings while the
 * service-layer owner checks bound every mutation to the caller. Fail-closed: with the flag absent
 * or Flipt down, moderators only.
 *
 * It reads the ACCOUNT (`appBlocksAuthorAccount`), not `ctx.user`: a moderator on a scoped key or
 * an app token has no moderator rights on tRPC, and keeps the author capability, as on the REST
 * author routes.
 */
export const enforceAppBlocksAuthorFlag = middleware(async ({ ctx, next }) => {
  // Every attachment is `protectedProcedure.use(...)`, so `isAuthed` has already run and
  // `ctx.user` is non-null at runtime — but this is a bare `middleware`, whose ctx type does not
  // carry that narrowing. `isAppBlocksAuthorEnabled` REQUIRES a subject (a capability has nothing
  // to authorize without one), so the compiler makes this refusal mandatory rather than optional.
  // Keep it: it is also what makes the middleware safe if it is ever attached to a
  // `publicProcedure`. `appBlocksAuthorAccount` is undefined exactly when `ctx.user` is.
  const account = appBlocksAuthorAccount(ctx);
  if (!account) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps authoring is not enabled' });
  }
  if (await isAppBlocksAuthorEnabled({ user: account })) return next();
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps authoring is not enabled' });
});
