# @civitai/auth

Framework-agnostic auth for Civitai apps — JWT/session verification, the rich-user session client, and
the **spoke guard** that first-party `*.civitai.com` apps use to gate themselves. The decision logic is
pure (operates on a cookie header string), so each app's adapter is ~5 lines.

For the full mental model (hub vs spoke, tiers, the spoke→hub contract), read
[docs/auth/spoke-integration-guide.md](../../docs/auth/spoke-integration-guide.md). This README is the
package reference.

## Add to an app

```jsonc
// package.json
"@civitai/auth": "workspace:*"
```

Transpile (raw TS): Next `transpilePackages: ['@civitai/auth']`, Vite `ssr.noExternal: ['@civitai/auth']`.
`@civitai/redis`, `jose`, `zod` come in transitively.

## Env

All optional in the schema, but the spoke guard functionally needs:

| Var | Purpose |
|---|---|
| `AUTH_JWT_ISSUER` | hub origin — verifies the JWT `iss` and builds the login redirect |
| `AUTH_JWKS_URI` | hub public keys for local ES256 verification |
| `AUTH_INTERNAL_TOKEN` | service secret for INTERNAL-authed read-through to the hub (`/api/auth/identity`) |

Local dev against a local hub: point the two URLs at `http://localhost:5173`. See
[src/env.ts](src/env.ts) for the rest (signing keys, session max-age — hub-only).

## Use — spoke guard (gate a first-party app)

```ts
import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { logToAxiom, safeError } from './axiom'; // the app's Axiom logger
import { getSysRedis } from './redis';

// A sign-out, ban or force-logout written anywhere ends the session here. When the store can't be reached the
// check allows the request, so log each time it does.
export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  onError: (err) => {
    logToAxiom({
      ...safeError(err),
      name: 'sysredis-fail-open',
      type: 'warning',
      subtype: 'read-degraded',
      fn: 'spoke isRevoked',
    }).catch(() => undefined);
  },
});

export const guard = createSpokeGuard({ require: (u) => u.isModerator === true, isRevoked });
// guard.check(cookieHeader, returnUrl, { navigation }) -> { status: 'ok'|'login'|'reauth'|'forbidden', ... }
```

`isRevoked` is required: `createSpokeGuard` throws without it. `apps/moderator/src/lib/server/auth.ts` is the
reference wiring.

Then a tiny framework adapter (SvelteKit `hooks.server.ts` / Next `proxy.ts`) acts on the result:
`login` → redirect, `reauth` → `spokeReauthResponse(result.authorize)` (a 401 carrying the sign-in URL),
`forbidden` → 403 or app-specific redirect, `ok` → set `locals.user` and pass `result.setCookies` to
`withSetCookies`.

Other exports: `createSessionClient` (token→user, invalidate/refresh), `createAuthVerifier`,
`createDeviceAccountClient` (account switching), `createImpersonationClient`, `hubLoginUrl`/`hubLogoutUrl`,
and the `SessionUser` / `SessionClaims` types. Browser-safe constants are under `@civitai/auth/client`.

## Gotchas

- **Redis is optional but coupled**: the session client reads the shared session cache via `@civitai/redis`
  and **fails open** to a hub identity fetch when redis is absent. But if you set `REDIS_URL` you must also
  set `REDIS_SYS_URL` — `@civitai/redis`'s env load requires both (a partial config throws, caught as
  fail-open, so you silently lose the cache). See [@civitai/redis](../civitai-redis/README.md).
- **Revocation needs the shared sys redis**: `createSpokeGuard` requires `isRevoked`
  (`createRevocationCheck` over the sys redis). The check allows the request when the store can't be
  reached, so pass `onError` and log it, as above.
- Same registrable domain (`*.civitai.com`) → the session cookie is shared automatically; no login UI,
  no OAuth bridge, no cookie-domain config needed in a spoke.

Reference implementation: [apps/moderator](../../apps/moderator) (`src/lib/server/auth.ts` + `src/hooks.server.ts`).
