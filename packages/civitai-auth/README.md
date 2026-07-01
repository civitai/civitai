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
import { createSpokeGuard } from '@civitai/auth';

export const guard = createSpokeGuard({ require: (u) => u.isModerator === true });
// guard.check(cookieHeader, returnUrl) -> { status: 'ok'|'login'|'forbidden', ... }
```

Then a tiny framework adapter (SvelteKit `hooks.server.ts` / Next `proxy.ts`) acts on the result:
`login` → redirect to hub, `forbidden` → 403 or app-specific redirect, `ok` → set `locals.user`.

Other exports: `createSessionClient` (token→user, invalidate/refresh), `createAuthVerifier`,
`createDeviceAccountClient` (account switching), `createImpersonationClient`, `hubLoginUrl`/`hubLogoutUrl`,
and the `SessionUser` / `SessionClaims` types. Browser-safe constants are under `@civitai/auth/client`.

## Gotchas

- **Redis is optional but coupled**: the session client reads the shared session cache via `@civitai/redis`
  and **fails open** to a hub identity fetch when redis is absent. But if you set `REDIS_URL` you must also
  set `REDIS_SYS_URL` — `@civitai/redis`'s env load requires both (a partial config throws, caught as
  fail-open, so you silently lose the cache). See [@civitai/redis](../civitai-redis/README.md).
- **No revocation without redis**: omitting the `isRevoked` injection makes the gate signature+expiry only
  (a logged-out/banned token still resolves until expiry). Wire a redis client + `isRevoked` for real-time
  revocation.
- Same registrable domain (`*.civitai.com`) → the session cookie is shared automatically; no login UI,
  no OAuth bridge, no cookie-domain config needed in a spoke.

Reference implementation: [apps/moderator](../../apps/moderator) (`src/lib/server/auth.ts` + `src/hooks.server.ts`).
