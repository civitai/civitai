# Main App Auth Cutover — NextAuth → centralized hub

Status: **A–D done (server validation, client session, login/logout→hub, rolling refresh, shape parity).
DECISION: strip NextAuth BEFORE ship (no flag-flip hybrid — see "Decision" below).** In flight: device-level
account switching (E). Remaining: the 5-phase strip — resilient resolution, legacy `jose` decoder, E + F
hub-native, replace `next-auth/react`, delete server NextAuth.

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

## Decision: strip NextAuth BEFORE ship (no hybrid) — read first

We are **removing NextAuth entirely before shipping**, not keeping it as a flag-flip fallback. The hybrid's
"flip back to NextAuth" safety net is illusory: once users log in at the hub they hold a `civ-token`, and
flipping `USE_HUB_SESSION` back to NextAuth would ignore that cookie → log them out — and they can't re-login
if the hub is the thing that's down. The net shrinks every day and sacrifices the sessions that matter.

Instead the main app validates sessions **hub-independently**, so existing sessions survive a hub outage and
only *new logins* are affected (the hub is the login authority either way — mitigate with hub HA).

**Resolution model (`getServerAuthSession` / `createSessionClient`):**

1. **Verify** `civ-token` LOCALLY with the hub's public key (`AUTH_JWT_PUBLIC_KEY`), not a JWKS fetch — no hub
   call to validate a token.
2. **Resolve the session user**: shared cache (hub's output) → hub `/api/auth/identity` on a miss (hub is the
   producer by **default**) → **`produceFallback`** (local DB production) if the hub is unreachable.
3. Legacy `civitai-token`: a `jose`-based JWE decode in `@civitai/auth` (read-only, sunsets as those sessions
   age out) — NO `next-auth` dependency.

`produceFallback` is **injected into `createSessionClient`** and enabled for BOTH the main app AND **civitai.red**
(both can reach the DB). It is a **temporary** resilience measure — **revert it once the hub is proven stable**,
restoring the hub as the sole producer. Pure HTTP-only spokes never get it.

### Phased rollout (each phase keeps the app working; NextAuth stays until the last)

1. **Resilient resolution** — local verify + cache→hub→`produceFallback` chain.
2. **Legacy decoder** — `jose` `civitai-token` decode; `getServerAuthSession` resolves new-or-legacy, no NextAuth.
3. **Account-switch + impersonation hub-native** (E + F).
4. **Client** — replace `next-auth/react` (`SessionProvider`/`useSession`) with a first-party provider over
   `/api/auth/session`; the ~317 `useCurrentUser` sites swap transparently (`signIn`/`signOut` already hub-routed).
5. **Delete server NextAuth** — `[...nextauth].ts`, `next-auth-options`, `token-refresh`, AES civ-token; drop the dep.

> **Rule — no hand-rolled hub calls.** Every spoke→hub auth request goes through a `@civitai/auth` helper; app
> code never builds the hub URL/contract inline. Today's surface: `createSessionClient` (token→user + service
> invalidate/refresh), `createDeviceAccountClient` (list/switch/remove, cookie-forwarded), `createSessionTokenClient`
> (rolling refresh + revoke, token-authed). App proxies are thin forwarders that only add framework glue (e.g.
> setting the Next response cookie). Future hub calls (cross-domain exchange, impersonation) get helpers too.

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

### E. Account switching — DEVICE-LEVEL — 🔨 in progress

Hub-native, **device-level**: not a client-held credential and not a DB-level account link (no cross-device
association, nothing in the User table). The hub keeps a per-browser **device set** — an httpOnly `civ-device`
cookie → a Redis hash `device:accounts:{deviceId}` of `userId → lastSwitchedAt`, **30-day rolling** (matches the
session; refreshed on login + switch + rolling refresh). A switch is authorized by an **active session** + the
target being in **this** device's set and fresh (<30d); `localStorage` holds zero credentials (display only).

**Hub — done (type-clean):**

- [x] `device.ts` (device cookie + Redis set: link/list/isFresh/remove + 30d prune); `mintUserSession` extracted
- [x] login links the account (`establishSession` → `touchAccount`); rolling refresh touches the active account
- [x] `POST /api/auth/switch` (active session + device + fresh → mint civ-token, return it); `GET /api/auth/accounts`

**Main app — same-domain done (type-clean):**

- [x] `/api/auth/accounts` proxy (GET list + `DELETE ?userId=` remove); device-cookie roll in `maybeRollHubCookie`
- [x] `/api/auth/switch` proxy (forward → set civ-token → roll device cookie)
- [x] `AccountProvider` rewrite: list from the hub device set, `swapAccount(userId)` switch, **logout-one without
      switching**, `removeAccount` → device-set DELETE

**Legacy migration — DON'T lose existing linked accounts:**

- [x] The switcher **merges** the hub device set with the pre-existing `civitai-accounts` localStorage, so no
      user loses a linked account at cutover. Switching to a legacy-only entry **redeems its stored token** at
      the hub (which links it to the device set); migrated entries are then pruned from localStorage. New links
      never write localStorage.
- [ ] ⚠️ **Strip ordering:** the legacy redeem currently uses next-auth's `account-switch` provider. Before
      Phase 5 deletes it, convert the redeem to a **hub-native legacy-token exchange** (decrypt the AES token →
      hub mints + links), or legacy localStorage accounts become unredeemable post-strip.

**Cross-domain — remaining:**

- [ ] **civitai.red** (different registrable domain — cookies don't cross): hub-minted ES256 **swap token** +
      hub-native **exchange** (verify-only spoke can't mint → POST the swap token back to the hub, which mints a
      civ-token the spoke stores in its own cookie). Same mechanism unlocks **localhost → auth.civitai.com** dev
      login (localhost is just another cross-domain spoke). Needs `isSecureCookie()` to follow the app's own
      base URL (`NEXT_PUBLIC_BASE_URL`) so an http-localhost spoke uses a non-secure cookie.
- [ ] Validate e2e: same-domain switch + `.com ↔ .red` + localhost

### F. Moderator impersonation — 🔨 to do

Hub-native and **separate** from account-switch (different authorization model: ownership vs moderator
privilege). The **only** authorization is **the requester being a moderator** — no internal token, no extra
credential, no ownership/device check. It must NOT touch the device account-set (the target isn't a linked
account).

- [ ] Hub `POST /api/auth/impersonate`: the requester's own session must be a moderator (the sole gate) → mint a
      thin `civ-token` for the target with an `impersonatedBy: modId` claim; write the `ModActivity` audit row
- [ ] Main `impersonate.ts` routes to the hub (keep the no-self-impersonation guard)
- [ ] Exit reads the `impersonatedBy` claim to re-mint the moderator's session — no `localStorage` `ogAccount`
- [ ] Validate e2e: impersonate → act as user → exit back to the moderator

### G. Legacy-cookie migration

- [ ] (Optional, recommended) **Silent upgrade** — when a request has a valid legacy `civitai-token` but no `civ-token`, transparently mint a `civ-token` at the hub (no login screen) so users migrate without a re-login. Without it, legacy cookies simply age out via the hybrid fallback (A)

### H. Delete server NextAuth — Phase 5 (before ship)

After phases 1–4 (resilient resolution, legacy decoder, E + F hub-native, client replaced):

- [ ] Delete `src/pages/api/auth/[...nextauth].ts`, the `jwt()`/`session()` callbacks + providers + adapter in `next-auth-options.ts`, `token-refresh.ts`, the AES civ-token (`civ-token.ts`), and the legacy JWE encode/decode
- [ ] **Replace** `next-auth/react` with a first-party `SessionProvider`/`useSession` over `/api/auth/session` (phase 4), then remove the `next-auth` + `next-auth/react` deps entirely
- [ ] The legacy `jose` `civitai-token` decoder (phase 2) stays read-only until those sessions age out, then deletes

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
