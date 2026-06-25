# @civitai/auth-app — centralized login hub

SvelteKit (Svelte 5 + adapter-node) implementation of the login/authorization **hub** from
[`docs/centralized-auth-app.md`](../../docs/centralized-auth-app.md). It is the only token
**issuer**; every other Civitai app is a **spoke** that verifies the JWT it mints (Path C,
[`docs/auth-verification-strategy.md`](../../docs/auth-verification-strategy.md)).

Stack mirrors `civitai-advertising`: SvelteKit + **Kysely over `pg`** + `jose` (via
`@civitai/auth`). RS256 session JWTs verified by spokes through the JWKS endpoint.

## What it does

- **Login view** — `/login` renders buttons for each configured upstream provider.
- **Upstream OAuth** — `/login/[provider]` → provider consent → `/login/[provider]/callback`
  (generic Authorization-Code + PKCE flow in `lib/server/auth/providers.ts`).
- **Session issuance** — on callback, find/create the user (Kysely), mint the RS256 session
  JWT via `@civitai/auth`, set it as the `.civitai.com` cross-subdomain cookie.
- **JWKS** — `/api/auth/jwks` and `/.well-known/jwks.json` serve the public keys (spokes +
  third-party OIDC RPs verify here).
- **Cross-root swap** — `/api/auth/sync` mints a short-lived signed swap token for
  different-root spokes (civitai.red).

## Env

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres (shared Civitai DB) |
| `AUTH_JWT_PRIVATE_KEY` / `AUTH_JWT_PUBLIC_KEY` / `AUTH_JWT_KID` | RS256 signing keypair (PKCS8 / SPKI PEM) |
| `AUTH_JWT_ISSUER` | issuer; also the OIDC `iss` (e.g. `https://auth.civitai.com`) |
| `AUTH_JWKS_URI` | this app's own `/api/auth/jwks` (used to verify its own cookies) |
| `AUTH_COOKIE_DOMAIN` | `.civitai.com` for cross-subdomain sharing |
| `{DISCORD,GOOGLE,GITHUB,REDDIT}_CLIENT_ID` / `_SECRET` | per-provider; a provider only appears once both are set |

## Status / TODO

- **DB types are a hand-written subset** (`lib/server/db/schema.ts`) — replace with a
  `prisma-kysely`-generated `DB` from `@civitai/db-schema` (as advertising does).
- Email magic-link provider not yet implemented.
- GitHub email needs the follow-up `/user/emails` call for the verified primary.
- No consent/account-merge UX yet; new-user provisioning is minimal.
