import { router, publicProcedure, protectedProcedure } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { getProvidersBounded } from '~/server/auth/get-providers-bounded';

export const authRouter = router({
  getUser: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => ctx.user),
  getSecretMessage: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(() => 'You are logged in and can see this secret message!'),
  getProviders: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    // `getProviders()` (next-auth/react) is a server-side HTTP SELF-FETCH to this
    // pod's own `${NEXTAUTH_URL_INTERNAL}/api/auth/providers` — the same fragile
    // "resolve auth by round-tripping my own serving capacity" pattern that
    // wedges api-primary on the /api/auth/session path (see PR #2502 for the SSR
    // analog). next-auth's internal fetch is UN-timed, so an outbound-HTTP
    // slowdown lets this hang to Traefik's 30s ceiling → 504. `getProvidersBounded`
    // fast-fails to `null` instead of hanging; we degrade to an empty provider
    // list rather than throwing out of the query.
    .query(() =>
      getProvidersBounded().then((data) =>
        data ? Object.values(data).filter((x) => x.type === 'oauth') : []
      )
    ),
});
