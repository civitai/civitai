import { router, publicProcedure, protectedProcedure } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { getProvidersInProcess } from '~/server/auth/get-providers-in-process';

export const authRouter = router({
  getUser: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => ctx.user),
  getSecretMessage: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(() => 'You are logged in and can see this secret message!'),
  getProviders: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    // The OAuth provider list is static config. next-auth's `getProviders()`
    // (next-auth/react) nonetheless resolves it via a server-side HTTP SELF-FETCH
    // to this pod's own `${NEXTAUTH_URL_INTERNAL}/api/auth/providers` — the same
    // fragile "resolve auth by round-tripping my own serving capacity" pattern
    // that wedges api-primary on the /api/auth/session path (see PR #2502 for the
    // SSR analog). That internal fetch is UN-timed, so an outbound-HTTP slowdown
    // lets it hang to Traefik's 30s ceiling → 504. `getProvidersInProcess` builds
    // the identical provider map in-process from `createAuthOptions(ctx.req)`
    // (host-aware), with no fetch — eliminating both the latency and the dangling
    // self-socket on the hot path.
    .query(({ ctx }) => {
      const data = getProvidersInProcess(ctx.req);
      return data ? Object.values(data).filter((x) => x.type === 'oauth') : [];
    }),
});
