# Main App Auth Cutover — NextAuth → centralized hub

Status: **server validation path implemented behind a default-OFF flag.** The rest (client session flip,
login redirect, NextAuth deletion) is scoped below. Nothing changes until `USE_HUB_SESSION=true`.

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

## Remaining work (scoped, NOT done)

1. **Client session flip — `/api/auth/session`.** `SessionProvider` + `useSession` (and thus the 317
   `useCurrentUser` sites) read next-auth's `/api/auth/session` (served by the `[...nextauth]` catch-all).
   To flip the client without touching call sites, add a **specific** `src/pages/api/auth/session.ts` route
   (a specific route shadows the catch-all for that exact path) that, when `USE_HUB_SESSION`, returns the hub
   session in next-auth's shape `{ user, expires }`; otherwise delegates to next-auth. *(I left this out: the
   off-case delegation to the catch-all is fragile to get right unvalidated, and it's the client half — best
   done with the app runnable against a producing hub.)*
   - The SSR initial session in `_app.tsx` comes from `/api/user/settings` (which calls
     `getServerAuthSession`) — so it follows the server flag automatically. Good.

2. **Login → hub.** `/login` should redirect to `auth.civitai.com` (the hub owns OAuth + email). Today
   `signIn(...)` (8 sites, mostly via `~/utils/auth-helpers.ts handleSignIn`) hits next-auth providers. Flip
   `handleSignIn` to a hub redirect when the flag is on; `signOut` (3 sites) → clear the cookie + hub logout.

3. **Delete NextAuth** (the final, irreversible step — only after 1+2 are flipped and validated in an env):
   `src/pages/api/auth/[...nextauth].ts`, the `jwt()`/`session()` callbacks + providers + adapter in
   `next-auth-options.ts`, `token-refresh.ts`, and the legacy JWE encode/decode. Keep `next-auth/react` on
   the client as a thin shim (it only needs `/api/auth/session`), unless you want to swap to a custom
   provider as polish. Dual-read (legacy JWE + RS256) is already handled by `@civitai/auth`'s verifier, so
   existing cookies survive.

---

## How to flip + validate (per env)

1. Confirm the prerequisite (hub producing + login authority + env vars).
2. Implement remaining #1 (client `/api/auth/session`) so server + client agree.
3. Set `USE_HUB_SESSION=true`.
4. Validate: sign in (hub) → `getServerAuthSession` returns the user on tRPC/API calls; `useCurrentUser`
   resolves client-side; refresh/ban busts propagate. Flip back instantly by unsetting the flag.

## Testing

`getHubSession` is a thin wrapper over `@civitai/auth`'s `createSessionClient` (58 package tests cover the
resolve/verify/cache/fetch logic). The main app has no unit-test runner (Playwright e2e only), so the
end-to-end main-app path is best validated by an e2e run against a producing hub once #1 lands — or by
adding vitest to the main app (as was done for `apps/auth`).
