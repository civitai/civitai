# OAuth Provider in `apps/auth` — Implementation Checklist

**Status:** checklist / ready to build · **Date:** 2026-06-11
**Companion to:** [oauth-provider-to-auth-app.md](./oauth-provider-to-auth-app.md) (the phased plan/rationale)

This is the actionable checklist, re-derived from a fresh read of the current code. Several plan assumptions have since landed — noted as ✅ **already done**. The genuinely-new work versus the plan is the **shared-code extraction** (§A): `generateSecretHash` and `TokenScope` live in the main app's `src/` today and the hub can't import them.

---

## State of play (verified 2026-06-11)

- ✅ **Kysely types incl. OAuth tables** — `@civitai/db-schema/kysely` exports `DB` with `OauthClient`, `OauthConsent`, `ApiKey`, and `ApiKeyType` enum. Hub already imports `DB` ([apps/auth/src/lib/server/db/db.ts](../../apps/auth/src/lib/server/db/db.ts)). *Plan Phase 1 is essentially complete.*
- ✅ **Token-hash parity** — `generateSecretHash` = `createHash('sha512').update(key + NEXTAUTH_SECRET)` ([src/server/utils/key-generator.ts:14](../../src/server/utils/key-generator.ts#L14)). Bearer validation ([src/server/auth/bearer-token.ts](../../src/server/auth/bearer-token.ts)) hashes incoming tokens identically and looks them up in `ApiKey`. Both apps read the same `NEXTAUTH_SECRET` → **hub-issued tokens validate in the main app with no changes**, provided the hub uses the identical hash.
- ✅ **OIDC id_token signing** — `@civitai/auth` signer exposes `mintIdToken()`, `mintSessionToken()`, `publicJwks()` ([packages/civitai-auth/src/sign.ts:61](../../packages/civitai-auth/src/sign.ts#L61)). Hub already has RS256 keys + JWKS endpoints live.
- ✅ **Session gate** — `event.locals.user` populated in `hooks.server.ts`; `/login?callbackUrl=` redirect-on-miss already used elsewhere.
- ✅ **Redis** — `@civitai/redis` with `REDIS_KEYS.OAUTH.*` shared; reuse as-is.
- ❌ **No OAuth provider routes/libs in the hub yet** — no `routes/api/auth/oauth/*`, no `routes/login/oauth/*`, no `.well-known/openid-configuration`, no `lib/server/oauth/`.
- ❌ **Shared code not extracted** — `generateSecretHash` and `TokenScope`/`tokenScopeLabels` are main-app-only.

---

## A. Shared-code extraction (do first — blocks Phase 2 & 4)

Both the hub and the main app must use the **same** hashing and scope definitions. Forking them is a latent security/correctness bug.

- [ ] **Extract `generateSecretHash`** (and `generateKey`) out of [src/server/utils/key-generator.ts](../../src/server/utils/key-generator.ts) into a shared package. It currently depends on `~/env/server` — the shared version must take the secret from a package-level env read (`NEXTAUTH_SECRET`) so both apps resolve the same value.
  - Destination candidates: `@civitai/auth` (already wires `NEXTAUTH_SECRET`) or a `@civitai/utils`. **Recommend `@civitai/auth`** — it owns token concerns already.
  - [ ] Re-point the main app's `generateSecretHash` import to the package (keep a re-export shim if call-sites are many).
  - [ ] Unit test: same input → same SHA512 output in both apps.
- [ ] **Share `TokenScope` + `tokenScopeLabels` + presets** from [src/shared/constants/token-scope.constants.ts](../../src/shared/constants/token-scope.constants.ts). Move to the shared package; re-export from the main app to avoid touching ~all call-sites at once.
  - [ ] Hub imports scope enum/labels from the package (consent UI + scope validation need them).
- [ ] **Decide where the OAuth core libs live.** Hub-only protocol logic (`model`, `server`, `token-helpers`, `constants`, `oidc-nonce`, `audit-log`, `rate-limit`, `errors`) can live **inside** `apps/auth/src/lib/server/oauth/` — they don't need sharing. Only the two items above cross the app boundary.

---

## B. Port the OAuth core libs → `apps/auth/src/lib/server/oauth/`

- [ ] `constants.ts` — copy verbatim (TTLs, `civitai_` prefix, device config).
- [ ] `errors.ts` — copy verbatim (`OriginNotAllowedError`).
- [ ] `audit-log.ts` — copy verbatim (console/structured logging).
- [ ] `rate-limit.ts` — copy; swap to `@civitai/redis` client + SvelteKit `Request` for IP/headers. Keep keys: per-user on `/authorize`, per-IP on `/token` & `/revoke`.
- [ ] `oidc-nonce.ts` — copy; reuse `@civitai/redis` `REDIS_KEYS.OAUTH.OIDC_CONTEXT`. Single-use consume.
- [ ] `server.ts` — copy verbatim (`@node-oauth/oauth2-server` factory).
- [ ] **`token-helpers.ts` → Kysely** — `createOAuthTokenPair`. Insert two `ApiKey` rows (Access + Refresh) via Kysely. Use the **shared** `generateSecretHash`. Force `UserRead` baseline. Preserve 1h/30d TTLs.
- [ ] **`model.ts` → Kysely** (the bulk). Rewrite every `prisma.*` call to Kysely against `DB`:
  - [ ] `getClient` — `OauthClient` lookup; **timing-safe** secret compare (`crypto.timingSafeEqual`); public-client origin allowlist; stash client for CORS.
  - [ ] `saveAuthorizationCode` / `getAuthorizationCode` / `revokeAuthorizationCode` — SHA256-hashed code in Redis with PKCE challenge/method, 10-min TTL.
  - [ ] `saveToken` → `createOAuthTokenPair`.
  - [ ] `getAccessToken` / `getRefreshToken` — hashed lookup in `ApiKey`, expiry check.
  - [ ] `revokeToken` — delete refresh + cascading access tokens.
  - [ ] `getUserFromClient` (client_credentials), `validateScope` (force `UserRead`, check `allowedScopes` bitmask), `verifyScope`.
- [ ] **Parity tests** against the current Prisma behavior: scope bitmask ↔ string-array round-trip, timing-safe compare, cascade revocation, code hashing. This is security-sensitive — review carefully.

## C. Add `@node-oauth/oauth2-server` dependency

- [ ] Add `@node-oauth/oauth2-server` to `apps/auth/package.json` (pure Node; works under adapter-node). `jose` is already transitive via `@civitai/auth`.

## D. Protocol endpoints → `+server.ts`

For each: build the library's `Request`/`Response` from SvelteKit `request` (method, headers, parsed body, `url.searchParams`); preserve CORS (per-origin for public clients, wildcard for confidential), rate-limit, and audit events.

- [ ] `/api/auth/oauth/authorize/+server.ts` — GET returns client+scope data for the page; POST issues the code. Gate on `event.locals.user`; redirect to `/login?callbackUrl=<self>` on miss. Upsert `OauthConsent` on "remember" (Kysely). Store OIDC nonce/auth_time.
- [ ] `/api/auth/oauth/token/+server.ts` — code & refresh grants. On `authorization_code` + `UserRead`, mint `id_token` via the hub signer's `mintIdToken()` (pull nonce from Redis). Per-origin CORS for public clients.
- [ ] `/api/auth/oauth/userinfo/+server.ts` — bearer → `ApiKey` lookup → claims (sub/username/name/picture/email…), gated on `UserRead`.
- [ ] `/api/auth/oauth/revoke/+server.ts` — RFC 7009; session OR client-secret auth; always 200.
- [ ] `/api/auth/oauth/device/+server.ts` — device/user code issuance (Redis).
- [ ] `/api/auth/oauth/device-info/+server.ts` — session-gated lookup for the verify page.
- [ ] `/api/auth/oauth/device-approve/+server.ts` — mark approved.
- [ ] `/api/auth/oauth/device-token/+server.ts` — poll → issue token pair on approval.
- [ ] `/.well-known/openid-configuration/+server.ts` — authoritative discovery with hub URLs + `jwks_uri` → hub JWKS. (OIDC is on by default here since keys always present — confirm intended.)

## E. Consent + device pages (Svelte)

- [ ] `/login/oauth/authorize/+page.svelte` (+ `+page.server.ts`) — client name/logo (`@civitai/brand`), scope list from shared `tokenScopeLabels`, "remember my decision", Authorize/Deny via form action (replace the React `document.createElement('form')`).
- [ ] `/login/oauth/device/+page.svelte` (+ `+page.server.ts`) — code entry → review → approve, calling the hub device endpoints.
- [ ] **Buzz spend-limit control** (shown for `AIServicesWrite`) — *fast-follow, optional for first cutover.* Needs `buzzLimitSchema` + `simpleBuzzLimitToBudgets` ([src/server/schema/api-key.schema.ts](../../src/server/schema/api-key.schema.ts)) and orchestrator calls `bustBuzzLimitCache`/`deleteAuthSubject` ([src/server/http/orchestrator/api-key-spend.ts](../../src/server/http/orchestrator/api-key-spend.ts)) — pure HTTP, portable; needs `ORCHESTRATOR_ENDPOINT`/`ORCHESTRATOR_ACCESS_TOKEN` in the hub env.

## F. Redirect / proxy the old main-app routes

- [ ] **User pages** `/login/oauth/authorize`, `/login/oauth/device` → `308`/`307` redirect to the hub, preserving query string.
- [ ] **Machine endpoints** `token`, `userinfo`, `revoke`, `device*` → **thin server-side proxy** to the hub (do NOT 302 — clients won't re-POST bodies cross-origin). Preserve method/headers/body + relay response & CORS.
- [ ] **Discovery** `/.well-known/openid-configuration` (main app) → redirect to hub's, or serve hub URLs so new clients self-route.
- [ ] Keep proxies until proxy-hit telemetry ≈ 0.

## G. Management surface (defer)

- [ ] **Leave `oauth-client.router.ts` / `oauth-consent.router.ts` in the main app for now.** Protocol doesn't depend on them; the only consent *write* needed (`OauthConsent` upsert) is done directly in the hub's `/authorize`. Port later with the management UI.

## H. Cutover

- [ ] Update provider/app consoles + OAuth client registry: new authorize/token URLs → `auth.civitai.com`.
- [ ] Watch `origin.rejected` / proxy-hit audit logs during the deprecation window.
- [ ] Remove `src/pages/login/oauth/*`, `src/pages/api/auth/oauth/*`, `src/server/oauth/*` from the main app once proxy traffic ≈ 0.

---

## Hub env vars (for `auth.civitai.com`)

The `.env` you're assembling needs these for the OAuth provider (beyond the existing session/JWKS/provider vars):

- [ ] `NEXTAUTH_SECRET` — **must be byte-identical to the main app's** (token-hash parity). Non-negotiable.
- [ ] `ORCHESTRATOR_ENDPOINT` + `ORCHESTRATOR_ACCESS_TOKEN` — only if the buzz-limit control (§E) ships in the first pass; can defer with the fast-follow.
- [ ] `REDIS_URL` / `REDIS_SYS_URL` — already needed for sessions; OAuth codes/devices/nonce reuse them.
- [ ] AUTH_JWT_* (private/public/kid/issuer) — already required for sessions; same keys sign OIDC id_tokens.

---

## Open decisions (carried from the plan)

1. **Buzz spend-limit at consent** — recommend fast-follow (ship authorize without it first).
2. **OIDC always-on** — hub always has keys, so `id_token` issuance is on by default. Confirm intended.
3. **Proxy lifetime** — how long before forcing clients onto the hub (driven by hard-coded client URLs).
4. **Shared-package home for `generateSecretHash` + `TokenScope`** — recommend `@civitai/auth`. Confirm.
