# Migrate the OAuth2/OIDC Provider into `apps/auth`

**Status:** plan / proposal · **Date:** 2026-06-10
**Related:** [centralized-auth-app.md](./centralized-auth-app.md) (§1c, §3 — "oauth/* are natural tenants of the auth app") · [auth-verification-strategy.md](./auth-verification-strategy.md) · [oauth-scoped-tokens.md](./oauth-scoped-tokens.md)

## Goal

Make `apps/auth` (`auth.civitai.com`) the **single identity authority**, including its role as an OAuth2/OIDC **provider** to third-party apps. Today that provider lives entirely in the main Next.js app (`src/pages/login/oauth/*`, `src/pages/api/auth/oauth/*`, `src/server/oauth/*`). We move the protocol + consent UI into the hub, and leave the main app's old routes as **redirects (user pages)** and **thin proxies (machine endpoints)** so already-registered clients keep working.

## The fact that makes this safe

Both apps talk to the **same Postgres DB**, and OAuth tokens are stored as hashed `ApiKey` rows. The main app's bearer-token middleware validates any incoming token by hashing it and looking it up in `ApiKey`. **As long as the hub hashes tokens with the same algorithm + secret (`generateSecretHash`), a token issued by the hub validates everywhere with zero changes to spokes.** The DB is the integration point; we are not inventing a new trust path.

Likewise, the hub **already owns the RS256 signing keys** (`@civitai/auth` `maybeCreateSessionSigner` + the JWKS endpoints at `/.well-known/jwks.json`). OIDC `id_token` signing is *more* natural here than in the main app — the discovery doc's `jwks_uri` already points at the hub.

> ⚠️ **Verify before building (Phase 0 spike):** confirm `generateSecretHash` uses a secret that is present (and identical) in both deployments. If it keys off `NEXTAUTH_SECRET`, the hub must share it. If the hashes diverge, hub-issued tokens silently fail validation in the main app. This is the single highest-risk assumption — prove it first.

---

## What moves, and the framework gap

The main app is React/Next + Prisma + tRPC + NextAuth. `apps/auth` is **SvelteKit 2 / Svelte 5 + Kysely + custom RS256 session** (no NextAuth, no Prisma, no tRPC). So the port is not copy-paste:

| Concern | Main app today | In `apps/auth` |
|---|---|---|
| OAuth protocol core | `@node-oauth/oauth2-server` (framework-agnostic) | **Reuse as-is** — construct its `Request`/`Response` from `+server.ts` |
| DB access in `oauth/model.ts` | Prisma (`prisma.oauthClient`, `prisma.apiKey`, …) | **Rewrite to Kysely** (the real work) |
| Redis (codes, device, nonce) | `@civitai/redis` packed keys | **Reuse as-is** — same package, same keys |
| `id_token` signing | `@civitai/auth` signer (optional, off in main app) | **Reuse hub signer** — already configured here |
| Logged-in user (consent gate) | `getServerAuthSession` (NextAuth) | **`event.locals.user`** (already populated in `hooks.server.ts`) |
| Consent / device UI | React + Mantine | **Rewrite in Svelte** (+ `@civitai/brand` for client logos) |
| Client/consent **management** | tRPC routers | **Stays in main app for Phase 1** (see §Decisions) |

---

## Inventory (source → destination)

**Protocol endpoints** → `apps/auth/src/routes/...` as `+server.ts`:

| Main app | Hub route |
|---|---|
| `api/auth/oauth/authorize.ts` (GET form data + POST) | `/api/auth/oauth/authorize/+server.ts` |
| `api/auth/oauth/token.ts` | `/api/auth/oauth/token/+server.ts` |
| `api/auth/oauth/userinfo.ts` | `/api/auth/oauth/userinfo/+server.ts` |
| `api/auth/oauth/revoke.ts` | `/api/auth/oauth/revoke/+server.ts` |
| `api/auth/oauth/device.ts` | `/api/auth/oauth/device/+server.ts` |
| `api/auth/oauth/device-info.ts` | `/api/auth/oauth/device-info/+server.ts` |
| `api/auth/oauth/device-approve.ts` | `/api/auth/oauth/device-approve/+server.ts` |
| `api/auth/oauth/device-token.ts` | `/api/auth/oauth/device-token/+server.ts` |
| `api/.well-known/openid-configuration.ts` | `/.well-known/openid-configuration/+server.ts` |

**User-facing pages** → Svelte:

| Main app | Hub route |
|---|---|
| `src/pages/login/oauth/authorize.tsx` | `/login/oauth/authorize/+page.svelte` (+ `+page.server.ts`) |
| `src/pages/login/oauth/device.tsx` | `/login/oauth/device/+page.svelte` (+ `+page.server.ts`) |

**Server libs** → `apps/auth/src/lib/server/oauth/`:
`server.ts` (reuse), `model.ts` (→Kysely), `token-helpers.ts` (→Kysely), `constants.ts`, `oidc-nonce.ts`, `audit-log.ts`, `rate-limit.ts`, `errors.ts`.

---

## Phases

### Phase 0 — De-risk (spike, ~½ day)
- Prove `generateSecretHash` secret parity between main app and hub (see warning above). Mint a token via the existing main-app flow, then validate it against an `ApiKey` lookup from the hub's Kysely client. **Gate the whole project on this.**
- Confirm `@node-oauth/oauth2-server` runs under Node adapter in SvelteKit (it's pure Node; expected fine).

### Phase 1 — Schema types (consume the shared package)

> **In flight (other session):** the Kysely DB types are being moved into the `@civitai/db-schema` package (generated from `prisma/schema.prisma`). This phase consumes that work rather than hand-writing types.

- Once the generated types land, `apps/auth` imports the `OauthClient`, `OauthConsent`, `ApiKey` table types (and `ApiKeyType` enum) from the shared package and drops the hand-written `apps/auth/src/lib/server/db/schema.ts` (which only declared `User`/`Account`/`VerificationToken`). The hub's Kysely client is re-typed against the generated `DB` interface.
- **Dependency:** Phase 2's `model.ts`/`token-helpers.ts` Kysely rewrite needs these three table types. Coordinate so the OAuth tables are included in the generated output (they may not be in the initial slice if that session is scoped to the existing three tables). If the generation lands after we need it, fall back to a *temporary* local type stub for just the OAuth tables, deleted on cutover — but prefer waiting on the shared types to avoid drift.

### Phase 2 — Port the OAuth core libs
- Copy `constants.ts`, `errors.ts`, `audit-log.ts` (console logging — no change), `rate-limit.ts` (Redis — reuse `@civitai/redis`), `oidc-nonce.ts` (Redis — reuse).
- Rewrite `model.ts` + `token-helpers.ts` Prisma calls to Kysely. This is the bulk of the work. Keep behavior identical: SHA256-hashed codes in Redis, `crypto.timingSafeEqual` secret checks, scope bitmask ↔ string-array conversion, `UserRead` forced baseline, cascading refresh→access revocation, 1h access / 30d refresh TTLs.
- `server.ts` (the `@node-oauth/oauth2-server` factory) ports verbatim.

### Phase 3 — Protocol endpoints
- Implement each `+server.ts`. Build the library's `Request`/`Response` from SvelteKit's `request` (method, headers, parsed body, query). Preserve every security property: PKCE S256 required, state required, per-origin CORS for public clients vs wildcard for confidential, rate-limit keys (per-user on authorize, per-IP on token/revoke), audit events.
- `/authorize` reads `event.locals.user` for the session gate; on miss → redirect to `/login?callbackUrl=<self>` (the hub already does this for other routes).
- `id_token`: mint via the hub's existing signer (`maybeCreateSessionSigner`) on `authorization_code` grant when `UserRead` granted; pull the nonce from the OIDC context Redis key. Since the hub *always* has keys configured (unlike the main app where it's optional), OIDC is on by default here — confirm that's desired.
- `openid-configuration`: serve the authoritative copy from the hub with hub URLs + `jwks_uri` → hub JWKS.

### Phase 4 — Consent + device pages (Svelte)
- Rewrite `authorize.tsx` → Svelte: client name/logo/description, scope list (`tokenScopeLabels`), "remember my decision", Authorize/Deny. Replace `document.createElement('form')` POST with a SvelteKit form action.
- **Buzz spend-limit UI** (shown when `AIServicesWrite` is requested) pulls in `buzzLimitSchema`, `simpleBuzzLimitToBudgets`, and orchestrator calls (`bustBuzzLimitCache`, `deleteAuthSubject`). These are HTTP/orchestrator calls, portable, but add surface. **Option:** ship Phase 4 without the buzz-limit control (authorize still works; limit defaults), add it in a fast-follow. Flagged as a decision below.
- Rewrite `device.tsx` → Svelte (code entry → review → approve), calling the hub's device endpoints.

### Phase 5 — Redirect/proxy the old main-app routes
This is the compatibility layer. **GET vs POST behave differently — do not blanket-redirect.**
- **User pages** (`/login/oauth/authorize`, `/login/oauth/device`): `308`/`307` redirect to `auth.civitai.com/...` preserving the query string. Browsers follow these fine.
- **Machine endpoints** (`token`, `userinfo`, `revoke`, `device*`): **do NOT 302.** Third-party clients have `civitai.com/api/auth/oauth/*` hard-coded and will not reliably re-POST a body across origins on a redirect. Instead make each old route a **thin server-side proxy** (`fetch` passthrough to the hub, preserving method/headers/body and relaying the response + CORS). Keep these proxies until telemetry shows no client hits them.
- **Discovery** (`/.well-known/openid-configuration` on main app): redirect (GET) to the hub's, **or** keep serving but with hub endpoint URLs so new clients self-route to `auth.civitai.com`. Discovery is the indirection point — once clients read hub URLs from it, they stop touching the main app.

### Phase 6 — Management surface (`oauth-client` / `oauth-consent` routers)
- These power "register/manage my OAuth app" (developer) and "connected apps" (user) UIs. They are **management, not protocol**, and read/write the same shared DB.
- **Phase 1 stance: leave them in the main app's tRPC.** The protocol move doesn't require them. The one write the protocol needs — upserting `OauthConsent` on "remember" — is implemented directly in the hub's `/authorize` handler (Kysely), independent of the router.
- Port them to the hub later if/when the management UI itself relocates. Track as a separate effort.

### Phase 7 — Cutover
- Update each provider/app console + the OAuth client registry so **new** authorize/token URLs point at `auth.civitai.com`.
- Run the main-app proxies during a deprecation window; watch the `origin.rejected` / proxy-hit audit logs.
- Remove `src/pages/login/oauth/*`, `src/pages/api/auth/oauth/*`, `src/server/oauth/*` from the main app once proxy traffic is ~zero.

---

## Decisions needed from the team

<!-- @ai:* flagged for @dev input -->

1. **`@ai:*` Buzz spend-limit at consent time** — port it in Phase 4 (more orchestrator coupling up front), or ship authorize without it and fast-follow? Recommendation: **fast-follow** to keep the first cutover small.
2. **`@ai:*` Management routers** — confirm they stay in the main app for now (recommended), vs. port to the hub in the same effort.
3. **`@ai:*` OIDC always-on** — the hub always has signing keys, so `id_token` issuance is on by default (main app gated it behind optional keys). Confirm that's the intent.
4. **Schema source** — *resolved:* another session is moving generated Kysely types into `@civitai/db-schema`; the hub consumes those (see Phase 1). Only open sub-point: confirm the OAuth tables (`OauthClient`, `OauthConsent`, `ApiKey`) are in that generated slice, not just the existing three.
5. **`@ai:*` Proxy lifetime** — how long do we keep the main-app machine-endpoint proxies before forcing clients onto `auth.civitai.com`? Driven by how many third-party clients have hard-coded URLs.

## Risks

- **Token-hash parity** (Phase 0) — the make-or-break assumption. Gated.
- **Cross-origin POST on cutover** — mitigated by proxy-not-redirect for machine endpoints.
- **Kysely rewrite of `model.ts`** — mechanical but security-sensitive (timing-safe compares, scope bitmasks, cascade revocation). Needs careful review + parity tests against the Prisma version.
- **Scope/`TokenScope` constants + `tokenScopeLabels`** must be shared, not forked, between hub and main app — extract to a shared package or `@civitai/auth` rather than copy.
