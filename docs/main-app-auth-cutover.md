# Main App Auth Cutover — NextAuth → centralized hub

Status: **server validation + client session both implemented behind a default-OFF flag; e2e-validated against a
live hub.** Remaining: login→hub redirect, rolling token max-age extension, NextAuth deletion (scoped below).
Nothing changes until `USE_HUB_SESSION=true`.

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

## Shape note (review this)

The hub produces the `@civitai/auth` `SessionUser`, which is the `ExtendedUser` the app expects **minus a few
client-only fields**: `name`, `autoplayGifs`, `leaderboardShowcase`, `referral`. They're cosmetic/client-only,
so omitting them server-side is low-risk, but it IS a behavior diff once the flag is on. Options before
flipping: (a) accept the omission, or (b) add those four to the frozen `@civitai/auth` `SessionUser` contract
+ the hub producer (`session-shape.ts`). Also: the package `SessionUser` widens `tier`/`meta`/`banDetails`/
`subscriptions` (loose types), hence the `as unknown as Session` cast in `getHubSession`.

Also pinned at the cutover (from the hub build): `allowAds`/`redBrowsingLevel` currently reproduce the main
app's `userSettingsSchema.safeParse`-fails-→-default behavior; when `getSessionUser` is retired, decide
whether to keep that quirk or read settings directly.

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

### B. Login / logout → hub

- [ ] `/login` (+ `handleSignIn`, ~8 sites) redirects to the hub when the flag is on
- [ ] `signOut` (3 sites) clears `civ-token` + hits hub logout (and invalidates the session/token)
- [ ] **Login side-effects preserved** — currently in the `[...nextauth]` signIn event: new-user/login counters, `userActivity` tracking, `createUserReferral` (`ref_source`/`ref_landing_page`/`ref_login_redirect_reason` cookies), join-community notification. These must fire on the hub (or via a hub→main callback) once login moves there
- [ ] `generationServiceCookie` cleared on sign-in/sign-out

### C. Session lifetime (rolling)

- [ ] **Token max-age extension on activity.** `civ-token` is a FIXED 30-day window today (`AUTH_SESSION_MAX_AGE`, minted only in `establishSession`; hub `hooks.server.ts` only reads it; main app is verify-only) — REGRESSES next-auth's rolling `updateAge`. Restore: main app sees a valid `civ-token` older than `updateAge` → calls a hub **refresh endpoint** (authed by the current token) → mints a fresh `civ-token` → re-sets the cookie; reuse the existing `needsCookieRefresh`/`SESSION_REFRESH_*` signal. Fires only once per threshold-crossing. Config `AUTH_SESSION_UPDATE_AGE`, default **24h** (parity), can raise to ~7d. Pairs with the silent legacy upgrade (G)

### D. Session-user shape parity

- [ ] Decide the 4 client-only fields the hub omits (`name`, `autoplayGifs`, `leaderboardShowcase`, `referral`) — accept the omission, or add to the `@civitai/auth` `SessionUser` contract + hub producer (`session-shape.ts`)
- [ ] Confirm `allowAds`/`redBrowsingLevel` parity (the `userSettingsSchema.safeParse`-fails→default quirk)

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
