# Thin Session Token — Design

Status: **decided** (supersedes the "keep fat token" framing in [auth-hub-launch-checklist.md](./auth-hub-launch-checklist.md)
#8/#11). This is the target model for the auth hub + every consumer.

---

## ⮕ LOCKED ARCHITECTURE (2026-06-11) — read this first; supersedes the injected-compute model lower in this doc

The design evolved past "package owns the cache, the main app injects the compute." Final model:

**One producer: the auth hub.** `auth.civitai.com` is the **sole** producer of session-user data — nothing
else computes it. The hub:
- Queries Postgres via **Kysely** — `jsonObjectFrom`/`jsonArrayFrom` collapse `User` + `profilePicture` +
  `referral` + `customerSubscription→product→price` into one shaped read.
- Ports the **derivation** SQL can't do: tier ranking (`tierOrder`, highest-active, `memberInBadState`,
  `subscriptionsByBuzzType`), `getUserBanDetails(meta)`, `userSettings`→`allowAds`/`redBrowsingLevel`. These
  are pure functions of the queried rows (clean ports; ban/settings are candidates for a tiny ORM-agnostic
  shared util so they're not forked).
- Reads `permissions` from the **system-permissions sysRedis cache** (today's `getSystemPermissions`) — the
  one non-DB input — with the **degraded-skip** rule (never cache a permissions-less user; re-derive).
- Writes the rich `SessionUser` to the **shared cache** `session:data2:{userId}` and owns the
  `invalidateCivitaiUser` side-effect.
- Exposes **`GET /api/auth/identity`** — verify the caller's Bearer session token (the hub is the issuer) →
  userId → **read-through** (return the shared-cache entry when warm, produce fresh on a miss) → JSON,
  **revocation enforced in the same call** (the hub owns the registry). Read-through so HTTP-only consumers
  get the same caching as shared-redis ones.
- **Invalidation — `POST /api/auth/identity`** (same path, write side). **Service-authed** (`AUTH_INTERNAL_TOKEN`,
  not a user token — it targets an arbitrary `userId`: a mod banning user X, a subscription webhook). Body
  `{ userId, refresh? }`: busts `session:data2:{userId}` (lazy — next read re-produces); `refresh:true` also
  re-produces now and returns the fresh user. This is the single invalidation primitive — "refresh" reduces
  to it. Consumers call it via `@civitai/auth`'s `createSessionClient().invalidate(userId)` /
  `.refresh(userId)` (zero-config: hub URL from `AUTH_JWT_ISSUER`, token from `AUTH_INTERNAL_TOKEN`). So
  every cache write/delete is owned by the hub.

**Everyone else is a zero-config consumer** — main app, moderator, every spoke. One builder,
`createSessionClient()`, is the whole consumer session surface (read + write); **no injectable config**:
```
const session = createSessionClient({ isRevoked }); // shipped: revocation check injected
const user = await session.getSessionUser(token);   // read
await session.invalidate(userId);                   // write: bust
const fresh = await session.refresh(userId);        // write: bust + re-produce
// getSessionUser: verify → read shared redis (session:data2) → on miss GET {iss}/api/auth/identity → return.
```
**Most requests hit redis; only a cache miss falls back to the hub's API endpoint.** Redis is auto-wired;
the lookup URL is **self-describing** (the token's `iss` claim = the hub base, `AUTH_JWT_ISSUER`). No
injection, no per-app config — production lives in exactly one place, so `.com`/`.red` can never compute
divergent answers (single source of truth).

**The main app NEVER produces.** Today's `src/server/auth/session-user.ts` derivation **relocates into the
hub**; the main app becomes a reader like every other consumer. (This reverses the "main app stays the
producer / injects `computeUser`" framing in the lower sections.)

### Supersedes (now stale lower in this doc)
- **"Auto-wiring: owns redis + db (no injection)"** → consumers own **redis + an HTTP fetch**, NOT `@civitai/db`.
  Only the **hub** touches the DB (Kysely); `@civitai/auth`'s consumer side does not depend on `@civitai/db`.
- **"Resolution model — rich compute INJECTED"** → no injection; the built-in miss-handler is the hub fetch.
- **"Implementation — main civitai app: session() always-resolve via the existing rich resolver"** → the main
  app calls the zero-config package resolver (which falls back to the hub fetch); it keeps no local rich resolver.

### Status — package + hub BUILT (2026-06-11, uncommitted, all checks green)

**`@civitai/auth` (consumer side) — DONE.**
- `createSessionClient()` ([session-client.ts](../../packages/civitai-auth/src/session-client.ts)) — ONE
  zero-config builder for the whole consumer surface: `getSessionUser` (read) + `invalidate`/`refresh`
  (write). **NO injectable options**: verifier, cache client, hub URL, and service secret all come from env /
  the verified token's `iss`, so a consumer can't repoint verification, the identity fetch, or invalidation.
  `getSessionUser(token)` → verify → shared-cache read (fail-open) → single-flight → on miss
  `GET {iss}/api/auth/identity` → return. No `computeUser`, no write-through (the producer owns the cache
  write); a hub-unreachable cold miss → null. Tests mock the module boundaries (verify / redis / env / fetch).
- `SessionUser` contract ([types.ts](../../packages/civitai-auth/src/types.ts)) **unchanged** (frozen by
  decision — no `name`/extra fields right now).

**`apps/auth` (the sole producer) — DONE.**
- `produceSessionUser(userId)` ([session-producer.ts](../../apps/auth/src/lib/server/auth/session-producer.ts)):
  Kysely query (`jsonObjectFrom` profilePicture + product) → tier/subscription derivation → `permissions`
  from the system-permissions sysRedis cache (degraded-skip) → `allowAds`/`redBrowsingLevel` → assemble
  `SessionUser` → write the shared `session:data2:{userId}` cache (packed, real Dates).
- Ban util ([ban.ts](../../apps/auth/src/lib/server/auth/ban.ts)) — vendored `BanReasonCode` + public-label map
  + `getUserBanDetails`.
- `GET /api/auth/identity` ([+server.ts](../../apps/auth/src/routes/api/auth/identity/+server.ts)) — verify
  Bearer (revocation enforced) → **read-through** (`getOrProduceSessionUser`: cache when warm, produce on
  miss) → JSON; 401/404 = "no session".

**Checks:** `@civitai/auth` 52 tests green; hub `svelte-check` 0; main app `typecheck` 0. Sub-agent reviewed
for parity vs the main app's `getSessionUser` (tier loop, permissions/degraded, cache key/TTL, ban map,
single-flight all confirmed sound; the `allowAds`/`redBrowsingLevel` `safeParse`-gating quirk reproduced).

**Known parity notes for the main-app phase:**
- `allowAds`/`redBrowsingLevel`: the main app gates these on `userSettingsSchema.safeParse` succeeding,
  which (due to non-coerced `z.date()` TOS fields stored as strings) fails for ~all active users → defaults.
  The producer reproduces that dominant behavior; a user with no stored TOS dates + explicit values is the
  rare divergent case. Decide whether to keep the quirk or read settings directly when `getSessionUser` is
  rewritten.
- Omitted from the produced user (not in the frozen contract): `name`, `autoplayGifs`, `leaderboardShowcase`,
  `referral`. Add to the contract + producer if a consumer needs them.
- `TIER_METADATA_KEY` must be set in the hub env for tier derivation.
- Date fields are real `Date`s on a cache hit, ISO strings on the rare cold-miss HTTP path — consumers coerce.

### Deferred — the main civitai app phase + cutover
- **Main app = consumer:** replace `getSessionUser`'s Prisma compute with `createSessionClient().getSessionUser`;
  `session()` resolves from cache/hub every request; delete the refresh/re-mint path + `needsCookieRefresh`.
- **Hub mints thin:** `establishSession` drops the embedded user from the token.
- **Middleware** guard → `getSessionUser` (proxy already on the Node.js runtime — a real build still needs to
  confirm whether `experimental.nodeMiddleware` is also required in `next.config.mjs`).

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
which can be as rich as today. And the resolve is **uniform across token formats** — for a thin ES256
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

> **SCOPING FINDING (implementation):** the existing `src/server/auth/session-user.ts` `getSessionUser`
> is **heavily main-app-coupled** — the *compute* pulls in Prisma `user` includes, `customerSubscription`
> + tier logic, `getSystemPermissions` (system-cache), `getUserBanDetails`, `userSettingsSchema`, and
> `invalidateCivitaiUser` (orchestrator). Moving it **wholesale** into `@civitai/auth` would drag that
> whole domain in — wrong. BUT the *cache orchestration* (read → single-flight → write, with the
> `degraded`-skip-cache rule and the `clearedAt` check) is generic. **Decomposition (refines decision #3):**
> the **package owns the cache + single-flight + degraded-skip contract**; the **rich compute is INJECTED**.

- **`@civitai/auth` `createSessionUserResolver({ computeUser })`** → `getSessionUser(userId)` that does:
  cache read (auto `@civitai/redis`) → `clearedAt` guard → single-flight per pod → on miss call the
  **injected** `computeUser(userId)` → cache write (4h, **skipped when `degraded`**). This is the package
  half of build-step 2 and is fully testable in isolation (mock `computeUser` + mock redis).
- **The rich compute stays in the main app** (the current `session-user.ts` body, lightly refactored to
  return `{ user, degraded }` and drop its own cache read/write — the resolver owns those). The main app
  injects it. So `session.user` stays **rich**, unchanged for callers.
- **One shared cache key (`REDIS_KEYS.USER.SESSION:{userId}`), rich shape** — every consumer reads/writes
  the same key → cross-root consistency. (Confirmed: cache stays the existing rich shape.)
- **Cold-miss for spoke-only users (sub-detail to settle at app-wiring):** the hub/spokes don't have the
  main app's rich compute. Options: (i) they inject a *leaner* compute (identity-level) but must **not**
  write a lean shape to the rich key (cache-write only the rich shape, or don't cache lean) to avoid
  "missing field" bugs; or (ii) on a spoke cold-miss, call the main app / a shared resolve. Default: the
  resolver's `computeUser` injection makes this each consumer's choice; the main app's traffic keeps the
  cache warm so spoke cold-misses are rare.

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

- **`src/verify.ts` (exposed at `@civitai/auth/verify`)** — `verifyToken(token)`: signature (ES256 via
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
