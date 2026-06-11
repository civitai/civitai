# Thin Session Token — Design

Status: **decided** (supersedes the "keep fat token" framing in [auth-hub-launch-checklist.md](./auth-hub-launch-checklist.md)
#8/#11). This is the target model for the auth hub + every consumer.

## Decision

The session **cookie carries identity only** (`userId`, `signedAt`, `jti`). The session **user is resolved
fresh from a shared source per request** — never embedded in the cookie.

### Why — cross-root consistency is the clincher
`.com` and `.red` are different registrable domains → **separate cookies** established independently. A
**fat** cookie gives you **N independent snapshots, one per root**, each refreshed on its own schedule —
they *will* drift (a change on `.com` isn't in the `.red` cookie until `.red` happens to refresh, and a
`.red` refresh is invisible to `.com`). There's no way to keep N embedded copies coherent. A **thin**
cookie has nothing to diverge: every root resolves from **one shared source** → always consistent. (Fat
also forces the whole `'refresh'` marker/re-mint subsystem just to keep the snapshot from going stale;
thin deletes all of it.)

### Core principle (important nuance)
**"Thin cookie" ≠ "thin `session.user`".** The cookie carries no data; the *resolve* produces the user,
which can be as rich as today. And the resolve is **uniform across token formats** — for a thin RS256
token *or* a legacy fat NextAuth JWE, we **ignore any embedded user and always resolve**. The token only
ever supplies a verified `userId`.

---

## Cookie contents

```
{ sub: <userId>, signedAt: <epoch ms>, jti: <tokenId>, iss, exp, kid }
```
No `user`. `signedAt` stays (per-user "log out all my devices" compares against it). `jti` stays
(single-session logout).

---

## API shape — two entry points

Split so the lightweight path never drags redis/db into an edge bundle (a bundler pulls in whatever the
imported *module* references, even uncalled).

| Entry point | Method | Needs | Use |
|---|---|---|---|
| `@civitai/auth/verify` | `verifyToken(token)` → claims \| null | **jose only** (edge-safe) | "is this token authentic + who is it for?" — coarse gate (middleware), no revocation awareness |
| `@civitai/auth` | `getSessionUser(token \| userId)` → SessionUser \| null | **redis + db** (server) | "give me the current user, or null if no longer allowed" — resolves cache→db **and** enforces revocation |

`getSessionUser(token)` runs `verifyToken` internally then resolves, so the common path is one call.
Semantics to keep straight: `verifyToken` proves **authenticity**; `getSessionUser` is **authoritative**
(includes revocation). Edge = signature gate; data layer = `getSessionUser`.

---

## Auto-wiring: `@civitai/auth` owns redis + db (no injection)

Thin makes redis+db a **hard dependency** of auth (every resolve hits the shared source), so the package
uses them automatically rather than via constructor injection:
- `@civitai/auth` depends on `@civitai/redis` + `@civitai/db` (+ `@civitai/db-schema`), via **lazy internal
  singletons** (instantiated on first resolve, never at import — and never on the `verify` path).
- An **optional override** param remains for tests / alternate sources.
- This **re-tiers** `@civitai/auth` from a base/infra-free package up to a higher-tier package that consumes
  base packages — allowed by the base-package rules. (Updates the earlier "redis is injected, never imported"
  stance for this package; update that note/memory when it lands.)
- Edge/external consumers (no redis/db) use `@civitai/auth/verify` + the hub `/userinfo` HTTP path instead.

---

## Resolution model (the crux)

`getSessionUser` resolves the **lean** session user (identity + authz set — `id`, `username`, `email`,
`isModerator`, `muted`, `bannedAt`, `browsingLevel`, `onboarding`, …; the `toSessionUser` shape the hub
already mints): **read the user cache → on miss, query the DB (Kysely via `@civitai/db`) → write cache →
return**, plus the revocation check.

- **One shared source of truth = the user cache** (today `REDIS_KEYS.USER.SESSION`). Every root/spoke reads
  it → cross-root consistency on the lean set.
- **Rich/derived fields** (permissions, subscriptions, cosmetics) stay the **main app's** concern, resolved
  separately where a feature needs them — *not* dragged into the package (that logic is large and
  main-app-coupled).
- **[OPEN] cache shape + ownership:** standardize what's stored under the user-session key so the package's
  resolve and the main app's populate agree (avoids "missing field" bugs). Decide whether the main app's
  `session.user` stays **rich** (keeps its own `getSessionUser`, augmenting the lean base) or goes **lean**
  too (bigger blast radius — lots of code reads `session.user.permissions` etc.). Default plan: **keep
  `session.user` rich in the main app**; the package's lean `getSessionUser` serves the hub + spokes +
  external.

---

## Revocation model

| Need | Mechanism |
|---|---|
| ban / mute / role change (per-user) | in the resolved record (`bannedAt`/`muted`) — the resolve sees it |
| "log out all my devices" (per-user) | `sessionsValidAfter` timestamp on the user record; reject if `token.signedAt < sessionsValidAfter`; + cache bust |
| single-session / one-device logout | a per-token (`jti`) marker — the **only** thing needing a token-level check; pipeline it with the resolve |
| global **refresh** everyone | **cache bust** (`clearCacheByPattern` on the user keys) — that's all thin needs |
| global **logout** everyone (break-glass) | **key rotation** (retire the `kid` from JWKS / rotate `NEXTAUTH_SECRET`) — invalidates all tokens cryptographically |

**`SESSION.ALL` is dropped** — its only job was forcing fat snapshots to re-sync (now a cache bust), and a
true logout-all is key rotation. (Bank the dependency: key rotation must be a real, tested runbook.)

---

## Field audit — lean `SessionUser` (TO FILL IN before coding the resolve)

| Field | Keep in cookie? | In lean resolve? | Mutable? | Read without redis (external/edge)? | Must be fresh? |
|---|---|---|---|---|---|
| `id` | yes (`sub`) | — | no | yes | — |
| `signedAt` | yes | — | no | yes | — |
| `username` | no | yes | rarely | maybe | no |
| `email` / `emailVerified` | no | yes | rarely | ? | no |
| `isModerator` | no | yes | yes | ? | **yes** |
| `muted` / `mutedAt` | no | yes | yes | ? | **yes** |
| `bannedAt` | no | yes | yes | ? | **yes** |
| `browsingLevel` / `showNsfw` / `blurNsfw` | no | yes | yes | ? | yes |
| `onboarding` | no | yes | yes | ? | yes |
| permissions / subscriptions / tier / meta | no | **no — main-app rich resolve** | yes | no | yes |

(Fill the `?`s from what the external apps actually read; that sets whether any field must be cheaply
available, and confirms the lean/rich line.)

---

## Implementation — `@civitai/auth`

- **`src/verify.ts` (exposed at `@civitai/auth/verify`)** — `verifyToken(token)`: signature (RS256 via
  public key/JWKS, or legacy JWE) + expiry + issuer → lean claims or null. **No redis/db imports.**
- **`src/session-user.ts` (server, `@civitai/auth`)** — `getSessionUser(token | userId)`: lazy redis+db;
  cache→db lean resolve + revocation (`bannedAt`, `sessionsValidAfter`, per-`jti` marker). Owns the
  `toSessionUser` projection (moved out of the hub).
- **`src/redis.ts` / `src/db.ts`** — lazy internal singletons over `@civitai/redis` / `@civitai/db`.
- **Signer** (`sign.ts`) — `mintSessionToken` drops `user` from the payload (identity only).
- **Registry** (`session-registry.ts`) — keep `trackToken` + a single-session `invalidateToken`/
  `isTokenRevoked(jti)`; **drop** the `'refresh'` marker + `getState`-for-refresh.
- **From the (uncommitted) #8 work:** *keep* the verifier, signer, and per-token tracking/invalidate;
  *drop* `checkSession`-for-refresh, `createSpokeSessionChecker`, the `getState` refresh path. `/userinfo`
  **stays** — but as the **shared resolve source** for edge/external, not an on-refresh hop.

## Implementation — auth app (hub, `apps/auth`)

- **`establishSession`** — mint a **thin** token `{ sub, signedAt, jti }` (drop `toSessionUser` from the
  payload).
- **`hooks.server.ts`** — `locals.user = await getSessionUser(token)` (from `@civitai/auth`, cache→db)
  instead of reading `claims.user`.
- **`/api/auth/userinfo`** — returns `getSessionUser(userId)`; the through-the-hub source for cache-less
  consumers (`Bearer` token auth already in place).
- **`lib/server/auth/users.ts`** — `resolveSessionUser`/`toSessionUser` move into `@civitai/auth`; the hub
  calls the package. Provisioning (`findOrCreateUser*`) stays in the hub.
- **`registry.ts` / `verifier.ts`** — drop the refresh wiring; keep single-session invalidate.

## Implementation — main civitai app

The token becomes thin; `session.user` is resolved every request (it already calls `getSessionUser`
constantly — we just stop trusting `token.user`). Uniform across RS256 + legacy JWE.

- **`next-auth-options.ts` `jwt()` callback** — set `token = { id: jti, sub: userId, signedAt }`; **do not**
  set `token.user`.
- **`session()` callback** — `session.user = await getSessionUser({ userId: token.sub })` **always**
  (cache→db, the existing rich resolver). Then revocation: reject if the `jti` is marked
  (single-session logout) or `session.user.bannedAt` / `signedAt < sessionsValidAfter`. **Delete the
  `'refresh'`/re-mint path and `needsCookieRefresh`** — a thin cookie never needs re-minting for data
  (its only mutable bit, `signedAt`, changes only on re-login).
- **`token-refresh.ts`** — collapses to a thin revocation check (no marker-refresh, no `setToken` re-mint,
  no untracked self-heal-via-refresh). `clearTokenRefreshMarker` goes away.
- **`token-tracking.ts`** — `trackToken` stays (new session, for single-session logout); `invalidateToken`
  → the per-`jti` marker.
- **`session-invalidation.ts`** — `refreshSession` → **cache bust** (clear the user's cache entry);
  `invalidateSession` (ban) → set `bannedAt` + cache bust; `invalidateAllSessions` → cache-bust pattern
  (global refresh) / key rotation (global logout). **Drop `SESSION.ALL`.**
- **Next.js middleware (`proxy.ts` → `server/middleware`)** — currently decodes the FAT cookie via
  next-auth `getToken` and `route-guards.middleware.ts` checks `user.isModerator` (`/moderator`,
  `/testing`) on the Edge Runtime. Thin breaks this (no user in the cookie, can't reach redis on edge).
  **Fix:** run the proxy on the **Node.js runtime** (`config = { runtime: 'nodejs' }`, supported in Next
  16) so the guard can `verifyToken` → `getSessionUser` (redis+db) → check `isModerator`. (Alternative:
  coarse signature gate in middleware + move the 2 `isModerator` guards into those routes' server layer.)
- **Rich fields** (`session.user.permissions`, subscriptions, …) keep coming from the main app's existing
  `getSessionUser` — unchanged for callers; only *when* it's called moves to "every request."

> **Rollout-friendly:** because the resolve is uniform across formats (ignore any embedded user, always
> resolve), the main app can adopt **"always resolve"** *independently* of the hub minting thin — and it
> reads the same cache as every other consumer, so cross-root consistency holds the moment it's on.

---

## What we keep / drop from the uncommitted #8 work

- **Keep:** `verifyToken` + local-key/JWKS verify, the signer, per-token `trackToken`/`invalidateToken`,
  `/api/auth/userinfo` (repurposed as the shared resolve source), the launch-checklist edits.
- **Drop / rework:** `checkSession`-on-refresh, `createSessionChecker`/`createSpokeSessionChecker`,
  `getState`'s refresh path, the "re-resolve on `'refresh'`" framing. (Don't commit them as-is.)

## Open decisions (resolve before/while building)
1. **Field audit** (table above) → the lean `SessionUser` shape + the lean/rich line.
@dev - pretty much all the values in the SessionUser cookie beside the user id can be modified by the user. I think the thin cookie would have to just be the userId, otherwise we have to include refresh logic that updates the cookie.
@ai: Agreed — **no user-modifiable data in the cookie.** Cookie = `userId` + `jti` + `signedAt`. The
   only nuance: `jti` and `signedAt` aren't *data* — they're immutable session **metadata** set once at
   mint and never changed, so they need **no** refresh logic. They're needed for the logout you asked for
   in #3 (`jti` = single-session; `signedAt` = "logged out before X"). So "just the userId" for *data*,
   plus those two immutable ids. Everything else is resolved.
2. **Cache shape + ownership** → what's stored under the user-session key; does the main app's
   `session.user` stay rich (default) or go lean.
@dev - the cached user should be rich and match the existing user session for now.
@ai: Confirmed — shared cache = the **existing rich** user-session shape (`REDIS_KEYS.USER.SESSION`),
   populated by the main app's existing `getSessionUser` (unchanged). `@civitai/auth.getSessionUser` reads
   that same key, so the hub/spokes get the rich user on a hit. **RESOLVED:** the rich resolve +
   populate is **owned by `@civitai/auth`** (option (ii)) — `getSessionUser` (cache → rich DB resolve →
   write cache) moves into the package, so *any* consumer populates the rich cache (no cold-miss gap for
   hub/spoke-only users). This is the **gating task**; scope today's `getSessionUser` deps first to size
   the extraction.
3. **Single-session logout** → keep the per-`jti` marker, or model device logout as cookie-clear only.
@dev - we would want a single session logout and the ability to logout on all devices which would clear everything.
@ai: Confirmed — keep **both**: single-session = per-`jti` invalidate (the `jti` in the cookie);
   all-devices = invalidate every tracked `jti` for the user (`USER_TOKENS`) — "clear everything." Both
   reuse the per-token tracking we're keeping; no `SESSION.ALL` needed.
4. **Edge usage** → do we run any auth check in an edge runtime (Next Middleware/Workers)? If not, the
   `verify` split is still good hygiene but not load-bearing.
@dev - we don't do any auth check in workers that I am aware of. Can you check the main app for auth in any nextjs middleware (if any)?
@ai: **Yes — the main app's middleware does auth, and it reads user data from the FAT cookie.**
   `src/proxy.ts` → `runMiddlewares` → `src/server/middleware/index.ts` decodes the token with next-auth
   `getToken` (JWE, no redis) and `route-guards.middleware.ts` checks **`user.isModerator`** for
   `/moderator` and `/testing`. That works today *only because the user is embedded in the cookie* and
   `getToken` is edge-safe. **A thin cookie breaks it:** no `user` in the cookie → `isModerator`
   undefined → guards deny; and the Edge Runtime can't hit redis/db to resolve it.
   **Fix options:**
   - **(a, recommended) Run the proxy/middleware on the Node.js runtime** (`export const config = { runtime: 'nodejs' }`).
     Next 16 (this repo's `proxy.ts` convention) supports it, and civitai is self-hosted (no edge infra),
     so the middleware can call `getSessionUser` (redis+db) and the guards keep working under thin.
   - **(b) Coarse edge gate + fine guard in the app:** middleware does signature-only "authenticated?
     redirect if not" (`verifyToken`, edge-safe); move the `isModerator` checks (only `/moderator` +
     `/testing` — a tiny surface) into those routes' server layer (Node, redis/db).
   **RESOLVED: (a) Node.js runtime** — keeps the guards centralized (the matcher; no per-page
   replication), resolves fresh from redis/db, works with thin. It's a code change only (`runtime:
   'nodejs'` in `proxy.ts` — already applied; possibly an `experimental.nodeMiddleware` flag in
   `next.config.mjs`), no devops/infra change (self-hosted; middleware already runs in the Node process).
   The moderator app uses the same pattern.

## Resolved decisions & operational design

- **Sequencing — front-load the extraction, defer only the cutover.** The big, low-risk piece
  (move `getSessionUser` into `@civitai/auth`, re-tier, the `verify` split) is a **relocation with no
  behavior change** (tokens stay fat; the main app just calls the package's resolver) — do it
  **pre-launch**. The **only** thing after the dry-run is the coupled hot-path **cutover** (hub mints
  thin + main-app `session()` always-resolves + token-refresh simplification). This shrinks post-launch
  debt to one well-scoped, tracked change. (Alternative if zero debt is preferred: thin-first, pulling
  the cutover pre-launch.)
- **Rich resolve owned by `@civitai/auth`** (see Resolution model) — the gating task.
- **Cache-bust via `refreshSession`.** In thin, the cache is the source of truth, so every user-data
  mutation must invalidate it. Don't audit per-site — **change `refreshSession` itself to bust the cache**;
  every existing caller then propagates correctly. The only check: confirm no mutation propagates
  *without* going through `refreshSession`.
- **Single-flight on `getSessionUser` (stampede protection).** A cache bust / cold cache + N concurrent
  requests for the same user = N identical DB queries. Keep an in-memory `Map<userId, Promise>`: the
  first miss starts the resolve and stores its promise; concurrent callers await the same promise → 1
  query/pod, not 1/request. Lives in the package resolver.
- **Log-out-all via tracked `jti`s** (no timestamp). Single-session = invalidate the cookie's `jti`;
  all-devices = invalidate every tracked `jti` in `USER_TOKENS`. Reuses the per-token marker; `SESSION.ALL`
  stays dropped. (A `validAfter`-style timestamp was considered and rejected as unnecessary.)
- **Redis-outage fail-open — DECIDE explicitly.** Thin makes the cache load-bearing for auth, losing
  fat's natural resilience (data was in the cookie). Design the resolve's degraded behavior: a cache-only
  outage still resolves via DB (slower); a full redis+DB outage needs a deliberate fail-open vs fail-closed
  call. This is the sharpest cost of thin vs fat — don't default it.
- **Keep the realtime `SessionRefresh` signal** so a currently-open tab updates immediately (it tells the
  client to re-fetch → re-resolve), not just on next navigation.
- **Middleware → Node.js runtime** — done (`proxy.ts`); see Edge decision above.
- **External apps gated behind thin-activation** — the 2 external apps read user data from the cookie, so
  thin issuance to real `.com` users waits until they're updated (read-before-issue). Deferred to
  post-migration; just don't flip thin-issuance on for everyone before they're handled.

## Build order
1. **Re-tier `@civitai/auth`** onto `@civitai/redis` + `@civitai/db`; add the `verify` subpath split +
   lazy clients. (Mechanical; invariant to everything else.)
2. **Scope + extract `getSessionUser` (rich) into `@civitai/auth`** — own the cache→rich-DB-resolve→
   populate, with single-flight. The main app + hub call it. Tokens still fat → no behavior change.
   **This is the front-loaded, pre-launch heavy lift.**
3. **Hub:** mint thin + resolve via the package. *(cutover — after dry-run)*
4. **Main app:** `session()` always-resolve + drop the refresh/re-mint path + `needsCookieRefresh`;
   `refreshSession` → cache-bust; middleware guards → `getSessionUser`. *(cutover — after dry-run, hot path)*
5. **External/edge:** `verify` + `/userinfo` (the 2 external apps, post-migration).
