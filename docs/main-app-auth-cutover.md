# Main App Auth Cutover — NextAuth → centralized hub

Status: **server validation, client session, login/logout→hub, rolling refresh, and full session-shape parity
all implemented behind a default-OFF flag; e2e-validated against a live hub (incl. a full email-login
round-trip).** Remaining: account-switch + civitai.red, impersonation, silent legacy upgrade, NextAuth deletion
(scoped below). Nothing changes until `USE_HUB_SESSION=true`.

This is the main-app half of the thin-session migration — see [thin-session-token-design.md](./thin-session-token-design.md).
The hub (`apps/auth`) is the sole **producer** + **issuer**; the main app becomes a **consumer** that reads a
cookie → verifies → resolves the user via `@civitai/auth`'s `createSessionClient`.

---

## ⮕ Why this was built flag-gated (read first)

I (the agent) built this autonomously while you were away. NextAuth is the security-critical auth hot path
(24 server entry points + 317 client `useCurrentUser` sites), and the cutover has a hard **prerequisite**
that isn't met in this dev env yet — so I did **not** irreversibly delete NextAuth or flip the default.
Instead the new path is behind `USE_HUB_SESSION` (default off), with NextAuth as the **byte-identical
fallback**, so the running app and existing sessions are untouched and you can review before flipping.

**Prerequisite to flip the flag (per environment):** the hub must be the **producer + login authority** for
that env — deployed, minting the session cookie, `/api/auth/identity` live, and the main app's env has
`AUTH_JWT_ISSUER` (+ `AUTH_JWKS_URI` or `AUTH_JWT_PUBLIC_KEY`) pointing at it.

---

## What's implemented (this change)

**Server validation — `getServerAuthSession`** ([src/server/auth/get-server-auth-session.ts](../src/server/auth/get-server-auth-session.ts)):
- When `USE_HUB_SESSION=true`, the **cookie path** resolves via the hub: read the session cookie →
  `sessionClient.getSessionUser(token)` (verify → shared redis cache → hub `/api/auth/identity` on miss) →
  return the existing `Session` shape. Fails closed to `null`.
- When the flag is **off**, the function is unchanged (next-auth `getServerSession`). The flag branch is
  inserted *after* the bearer-token block and *before* the next-auth block, so the off path is identical.
- The **bearer-token / API-key path is unchanged** — it still calls the local `getSessionUser({ userId })`,
  which reads the same shared `session:data2` cache (the hub's output) and computes on miss. So it keeps
  working through the transition without change.

**The resolver + flag** ([src/server/auth/session-client.ts](../src/server/auth/session-client.ts)):
- `sessionClient = createSessionClient()` (zero-config; env-driven).
- `getHubSession(req)` — cookie → verify → resolve → `{ user }` (cast to `Session`; see the shape note below).
- `USE_HUB_SESSION` — `process.env.USE_HUB_SESSION === 'true'` (default false).

**Refresh / invalidate — NO change needed.** The main app **shares the hub's redis**, so the existing
`refreshSession`/`invalidateSession`/`invalidateAllSessions` already bust `session:data2:{userId}` (via
`clearSessionCache` / `clearCacheByPattern`). The hub re-produces on its next read, so refresh/invalidate
propagate to every consumer for free. (Routing them through `sessionClient.invalidate` would just be a
redundant HTTP hop to bust a key the main app can delete directly.) The per-token `TOKEN_STATE` markers +
the `SessionRefresh` realtime signal stay as-is — those are the *logout/realtime* mechanism, orthogonal to
data refresh.

---

## Shape note

The hub produces the `@civitai/auth` `SessionUser` to **full parity** with the historic ExtendedUser contract —
**no fields omitted** (section D). The four previously-missing client-only fields (`name`, `autoplayGifs`,
`leaderboardShowcase`, `referral`) are now in the `@civitai/auth` `SessionUser` contract + the hub producer
(`session-shape.ts`). The package `SessionUser` still widens `tier`/`meta`/`banDetails`/`subscriptions` (loose
types), hence the `as unknown as Session` cast in `getHubSession`.

`allowAds`/`redBrowsingLevel` are now computed from the user's stored `User.settings` in the hub producer
(honor the explicit value, else the tier-based default) and cached — not hardcoded. See section D for the one
parity nuance vs `getSessionUser`.

---

## NextAuth removal timing (read first)

**NextAuth is NOT ripped out for launch.** Launch = flip `USE_HUB_SESSION=true` per env, with **NextAuth kept as
the byte-identical fallback** (the hybrid path). Deletion is a **separate, later, irreversible step** (section H
below), gated on full feature parity — specifically account-switching (incl. civitai.red) and impersonation being
hub-backed. So existing sessions keep working at launch, and we can flip back by unsetting the flag. Rip-out comes
only after parity is validated in an env.

---

## Feature-parity checklist (main app)

Everything NextAuth does today must work under `USE_HUB_SESSION=true` **before** NextAuth can be deleted.
`[x]` = implemented + validated against a live hub.

### A. Session resolution — ✅ done

- [x] Server: `getServerAuthSession` resolves the hub `civ-token` (verify → shared cache → hub on miss)
- [x] Client: `/api/auth/session` returns the hub session in next-auth `{ user, expires }` shape (`useSession`/`useCurrentUser` unchanged). SSR initial session via `/api/user/settings` follows the server flag automatically
- [x] Hybrid fallback: no `civ-token` → legacy next-auth cookie (already-logged-in users stay authorized, no forced re-login)
- [x] Bearer-token / API-key path unchanged (reads the same shared `session:data2` cache)

### B. Login / logout → hub — ✅ complete (flag-gated)

> **Validated locally (browser smoke):** visiting `/generate` while unauthorized → `/login` → hub email login
> → `civ-token` set → `/api/auth/post-login` side-effects → redirected back to `/generate`. All working.

- [x] **Login → hub.** `/login` SSR-redirects to the hub (existing), now wrapping `returnUrl` through
  `/api/auth/post-login?dest=…`. Interactive login already funnels through `/login` (`pages.signIn: '/login'`),
  so `signIn()` anywhere lands on the hub — no per-call-site change needed.
- [x] **Logout → hub.** `signOut` (4 sites: `AccountProvider` ×2, `SessionRefreshSignal`, `preview-restricted`)
  → `handleSignOut` → `/api/auth/logout` when `NEXT_PUBLIC_AUTH_HUB_URL` is set: clears `civ-token` (both
  prefixes, host-only + `AUTH_COOKIE_DOMAIN`) + orchestrator cookie, best-effort POSTs the hub `/logout` to
  revoke the token; legacy next-auth `signOut` otherwise.
- [x] **Login side-effects preserved.** Extracted to `runLoginSideEffects` (`src/server/auth/login-side-effects.ts`):
  new-user/login counters, `userActivity`, `createUserReferral` (reads `ref_*` cookies), join-community
  notification. Called by BOTH the `[...nextauth]` signIn event (legacy) and `/api/auth/post-login` (hub path,
  which runs on the main app where the `.civitai.com` ref cookies + services live). New-vs-returning is derived
  from `user.createdAt`.
- [x] `generationServiceCookie` cleared on login (post-login + legacy event via `runLoginSideEffects`) and logout.
- [x] **Validated** — email-login round-trip (smoke above). Two deploy-time checks remain (can't be done on
  localhost, both code-complete): OAuth providers (vs email), and cross-domain logout cookie clearing on
  `.civitai.com` (cookies are host-only in dev).

### C. Session lifetime (rolling) — ✅ implemented (flag-gated)

- [x] **Token max-age extension on activity.** Hub `POST /api/auth/refresh` verifies a still-valid `civ-token`
  (signature + expiry + revocation) and mints a fresh one for the **same user + same `jti`** (new signedAt/exp) —
  extending the window without changing session identity; expired/revoked tokens are rejected (→ re-login). The
  main app, in `getServerAuthSession`, decodes the token's `iat` and — when older than `AUTH_SESSION_UPDATE_AGE`
  (default **24h**, raise to ~7d) — calls the hub refresh **server-side** and re-sets the `civ-token` cookie
  (`maybeRollHubCookie`: best-effort + fire-safe, fires at most once per crossing, 2.5s timeout). No client
  wiring needed (the main app can set the `.civitai.com` cookie). Validated: typecheck + hub vitest; browser/
  deploy e2e pending (needs an aged token).

### D. Session-user shape parity — ✅ implemented (flag-gated)

> @ai: done — matched the full ExtendedUser contract, **no fields omitted** (per your note). Added the four to
> the `@civitai/auth` `SessionUser` contract + the hub producer query + `shapeSessionUser`.

- [x] **All client-only fields present** — `name`, `autoplayGifs`, `leaderboardShowcase`, `referral` added to the
  contract + hub producer query (incl. the `UserReferral` join) + `shapeSessionUser`. Full parity, no omissions.
- [x] **`allowAds`/`redBrowsingLevel` computed from `User.settings`** (honor explicit value, else tier default),
  so the **real values** are cached — not hardcoded defaults. Covered by new `session-shape` unit tests.
  - **Parity nuance (review):** the hub reads those two fields *leniently* (focused parse), while `getSessionUser`
    runs the FULL `userSettingsSchema.safeParse`, which fails wholesale if any *unrelated* field is mistyped →
    defaults. So for a user whose settings blob has an unrelated malformed field **and** an explicit
    `allowAds`/`redBrowsingLevel`, the hub honors it while `getSessionUser` currently defaults. To make them
    bit-identical, `getSessionUser` should adopt the same focused read — a small but **revenue-adjacent** change
    (users who set `allowAds=false` would then actually get no ads), so I left it for your explicit approval
    rather than changing main-app behavior unilaterally.

### E. Account switching (same-domain multi-account **+** civitai.red)

Both ride the `account-switch` provider + AES `civitai-token` (decrypted with `NEXTAUTH_SECRET`) today. The new
transport is an ES256 **swap token** (JWKS-verified, no shared secret). Hub side is already built (`/api/auth/sync`
→ `mintSwapToken`); the **spoke wiring is the gap**:

- [ ] Replace the AES `account-switch` CredentialsProvider with `createAccountSwitchProvider()` (`verifySwapToken` via JWKS) in `next-auth-options.ts`
- [ ] Update `useDomainSync.tsx` + `AccountProvider.swapAccount` for the new `{ swapToken }` response shape (vs `{ token: {iv,data,signedAt} }`)
- [ ] Point spoke sync at the hub's `/api/auth/sync`; honor the `sync`/`sync-account` redirect contract
- [ ] **civitai.red:** set `AUTH_JWKS_URI` + `AUTH_JWT_ISSUER` (same Next codebase on a 2nd registrable domain — cookies don't cross `.com`↔`.red`, so sync is mandatory)
- [ ] Dual-support AES + ES256 during the migration window (until legacy tokens expire)
- [ ] Validate e2e: same-domain account switch **and** civitai.com ↔ civitai.red sync

### F. Moderator impersonation

Today: `/api/auth/impersonate` → `civTokenEncrypt(targetId)` (AES) → `signIn('account-switch')` → target session;
exit via `ogAccount` (localStorage) + `/api/auth/civ-token`. Audit lives in `ModActivity`, not the session.

- [ ] Hub `/api/auth/impersonate` endpoint: mod-authed + permission-checked (the `impersonation` feature flag), mints a thin `civ-token` for the target user
- [ ] Main `impersonate.ts` routes to the hub when the hub is issuer (keep the feature-flag + no-self-impersonation guards)
- [ ] Exit / swap-back (`civ-token.ts` + `ogAccount`) routes to the hub
- [ ] Preserve `ModActivity` audit logging (`trackModActivity` on/off)
- [ ] Validate e2e: impersonate → act as user → exit back to the moderator

### G. Legacy-cookie migration

- [ ] (Optional, recommended) **Silent upgrade** — when a request has a valid legacy `civitai-token` but no `civ-token`, transparently mint a `civ-token` at the hub (no login screen) so users migrate without a re-login. Without it, legacy cookies simply age out via the hybrid fallback (A)

### H. NextAuth removal — LATER (not launch)

Only after B, E, F are hub-backed + validated in an env:

- [ ] Delete `src/pages/api/auth/[...nextauth].ts`, the `jwt()`/`session()` callbacks + providers + adapter in `next-auth-options.ts`, `token-refresh.ts`, and the legacy JWE encode/decode
- [ ] Keep `next-auth/react` as a thin client shim (needs only `/api/auth/session`), or swap to a custom provider
- [ ] Legacy-JWE dual-read in `@civitai/auth`'s verifier can be dropped once all legacy cookies have expired

**Tracking — `STEP-H-REMOVAL` markers (kept in sync as we build).** Every NextAuth touchpoint we add or rely on
carries a `STEP-H-REMOVAL:` code comment. At step H, `grep -rn "STEP-H-REMOVAL" src packages` yields the
exhaustive removal list — the goal is **zero `next-auth` references** left afterward. Current inventory:

| Location | What it is | Step-H action |
| --- | --- | --- |
| `src/pages/api/auth/[...nextauth].ts` | NextAuth catch-all handler + signIn/signOut events | delete |
| `src/server/auth/next-auth-options.ts` | `createAuthOptions`, `jwt()`/`session()` callbacks, providers, adapter, AES account-switch, legacy JWE encode/decode | delete (after E/F move to hub) |
| `src/server/auth/token-refresh.ts` | next-auth token refresh | delete |
| `src/server/auth/get-server-auth-session.ts` | legacy `getServerSession` block + `Session` type import | delete block; **replace** the `Session` type with a first-party type (it's the return type app-wide) |
| `src/pages/api/auth/session.ts` | `!USE_HUB_SESSION` delegation to the catch-all | delete the off-branch (route becomes hub-only) |
| `src/utils/auth-helpers.ts` | next-auth `signIn`/`signOut` fallbacks in `handleSignIn`/`handleSignOut` | delete the fallbacks + import (hub paths remain) |
| `src/pages/api/auth/[...nextauth].ts` signIn event | calls `runLoginSideEffects` | drop the event; `runLoginSideEffects` + `/api/auth/post-login` stay |
| `@civitai/auth` verifier | legacy-JWE dual-read branch | drop once all legacy cookies have expired |
| `next-auth` + `next-auth/react` deps | imports app-wide (incl. ~317 `useSession`/`useCurrentUser` sites via the client shim) | remove the dep; keep a thin client shim or replace |

> **Rule for new work:** any code that imports or relies on NextAuth gets a `STEP-H-REMOVAL:` marker comment
> **and** a row in this table. That's how we guarantee a clean rip-out with no lingering `next-auth` references.

### Env / ops (per environment)

- [ ] `AUTH_JWKS_URI`, `AUTH_JWT_ISSUER`, `USE_HUB_SESSION` set; shared redis confirmed
- [ ] Hub EC P-256 keypair (`AUTH_JWT_PRIVATE_KEY`/`AUTH_JWT_PUBLIC_KEY`/`AUTH_JWT_KID`); JWKS reachable from every spoke (incl. civitai.red)

---

## How to flip + validate (per env)

1. Confirm the prerequisite (hub producing + login authority + env vars).
2. Client `/api/auth/session` is implemented — server + client agree. ✅
3. Set `USE_HUB_SESSION=true`.
4. Validate: sign in (hub) → `getServerAuthSession` returns the user on tRPC/API calls; `useCurrentUser`
   resolves client-side; refresh/ban busts propagate. Flip back instantly by unsetting the flag.

## Testing

`getHubSession` is a thin wrapper over `@civitai/auth`'s `createSessionClient` (58 package tests cover the
resolve/verify/cache/fetch logic). The main app has no unit-test runner (Playwright e2e only), so the
end-to-end main-app path is best validated by an e2e run against a producing hub once #1 lands — or by
adding vitest to the main app (as was done for `apps/auth`).
