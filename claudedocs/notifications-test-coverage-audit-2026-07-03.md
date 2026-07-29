# Notifications App — Test Coverage Audit (2026-07-03)

**Scope:** `apps/notifications` (`@civitai/notifications-app`) — the Fastify + raw-pg fan-out/producer service.
**Method:** ran `corepack pnpm exec vitest run --coverage` (v8 provider, worked) + static analysis of every source module and test. Read-only; no source or tests changed.

**Headline:** 25 tests pass across 5 files, but overall coverage is **32% statements / 27% branch / 23% functions / 34% lines**. The two highest-blast-radius modules are effectively untested behaviorally: the **fan-out worker `poll-loop.ts` (10% lines)** and the **producer write path `create.ts` (0%)**. Every existing test that touches SQL asserts on the *generated string*, never on the *behavior* of running it — there is **no integration / real-Postgres coverage anywhere**, including for the load-bearing claim query.

---

## 1. Coverage map

| Module | Tests? | What's covered | v8 line % (branch) |
|---|---|---|---|
| `src/app.ts` | `__tests__/app.test.ts` | `/health`, `/metrics` (+ XFF 404 guard), one 400-validation path, RED-histogram scope guard | 45.1% (35.3%) |
| `src/env.ts` | — | none (`assertRequiredEnv` L30–40 unrun) | 53.8% (50%) |
| `src/server.ts` | — | none (entrypoint; not imported by any test) | 0% |
| `src/worker/poll-loop.ts` | `poll-loop.test.ts` | **only** the `PENDING_CLAIM_QUERY` *string* (structural asserts). `handleNormal`/`handleDebounce`/`create`/`run`/`startWorker` all unrun | **10.9% (0%)** |
| `src/lib/server/operations.ts` | `operations.test.ts` | `queryNotifications` + `countNotifications` SQL string + `$n` param indexing (fake pool) | 35.6% (20.8%) |
| `src/lib/server/create.ts` | — | **none** — producer create path entirely unrun (L24–80) | **0% (0%)** |
| `src/lib/server/cache.ts` | `cache.test.ts` | error-counter wrapper on `getUser`+`incrementUser` only | 35.6% (14.3%) |
| `src/lib/server/auth.ts` | `auth.test.ts` | 7 behavioral cases — bearer / x-webhook-token / wrong / len-mismatch / missing / non-bearer / disabled | 100% (87.5%) |
| `src/lib/server/lag.ts` | — | none (`getNotifDbWithoutLag`/`preventReplicationLag` L20–24 unrun) | 66.7% (25%) |
| `src/lib/server/metrics.ts` | (via app.test) | full — baseline series exercised | 100% (100%) |
| `src/lib/server/clients/db.ts` | (import side-effect) | pool construction only | 75% (42.9%) |
| `src/lib/server/clients/axiom.ts` | — | none | 33.3% (0%) |
| `src/lib/server/clients/redis.ts` | — | none | 0% (0%) |

---

## 2. Gaps ranked by risk (blast radius first)

### G1 — Fan-out worker `handleDebounce` / `handleNormal` behavior is 0% (`poll-loop.ts:96–195`) 🔴
**Untested:** the entire fan-out logic. Specifically the debounce **drop decision** (`poll-loop.ts:147–154`): `dayjs(lastTriggered).add(debounceSeconds,'seconds').isBefore(dayjs(nextSendAt))` → `DELETE` the pending row and return empty. Also the `ON CONFLICT (notificationId,userId) DO UPDATE SET createdAt=now(), viewed=FALSE` resurrection (L176–178), the reschedule `claimedAt=null, nextSendAt=now()+debounceSeconds` (L186–193), and `handleNormal`'s SELECT-before-INSERT + 23505 retry (L100–121).
**Failure it hides:** an inverted/off-by-one comparison or a swapped `lastTriggered`/`nextSendAt` silently either **drops every debounced notification** or **re-fans on every tick** (mass duplicate unread badges + signal spam). None of `poll-loop.test.ts`'s 5 assertions would change.
**Suggested approach:** unit-test `handleNormal`/`handleDebounce` with a **fake `PoolClient`** that records `client.query(...)` calls and returns canned rows (same recorder pattern as `operations.test.ts`). Export the two handlers (or test via `create` with a fake `notifDbWrite().connect()`). Assert: (a) debounce-drop path issues a `DELETE` and no `UserNotification` insert when `lastTriggered+debounce < nextSendAt`; (b) fan-out path issues the reschedule UPDATE; (c) `handleNormal` on a 23505 re-SELECTs instead of throwing.

### G2 — Producer write path `create.ts` is 0% (`create.ts:21–81`) 🔴
**Untested:** recipient dedup (`userIds` + `userId` → Set, L24–26), the **opt-out filter + `-1` sentinel drop** (L37: `id !== -1 && !disabled.has(id)`), UPDATE-first→INSERT-ON-CONFLICT fallback (L43–68), and the swallow-and-return-`{queued:0}` error contract (L71–81).
**Failure it hides:** a broken opt-out filter **delivers to users who disabled the type** (privacy/spam regression) or the `-1` sentinel leaks into `users[]`; a param/cast mistake (`$4::int[]`, `$5::jsonb`, `$3::"NotificationCategory"`) throws and is swallowed → producer silently queues nothing while returning 202. `createNotificationsBulk` (`operations.ts:23–66`) shares the same UPDATE-first/ON-CONFLICT shape and `pg-format` value building and is equally unrun.
**Suggested approach:** fake `mainDbRead`/`notifDbWrite` pools (as `operations.test.ts` mocks `./clients/db`). Assert the settings query filters out `disabled` ids + `-1`; assert `queued` counts targets; assert the INSERT fires only when the UPDATE returns 0 rows; assert a thrown pool error yields `{queued:0}` not a throw.

### G3 — `markNotificationsRead` serialization + retry is 0% (`operations.ts:172–289`) 🔴
**Untested:** the per-user promise-chain queue (L193–202, "never >1 concurrent `connect()` per user" — the rapid-click pool-starvation guard), `isTransientWriteError` matching (L184–186), the exponential backoff + `MARK_READ_MAX_ATTEMPTS` retry (L204–245), and `markReadImpl`'s all/category/single branches + cache decrement (L247–289).
**Failure it hides:** a break in the queue chaining reintroduces concurrent per-user writes (pool starvation under rapid clicks — the exact bug this code exists to prevent); a wrong transient-error substring makes every mark-read retry a permanent failure 4× or give up immediately. Pure in-process logic — cheap to test, high value.
**Suggested approach:** fake `notifDbWrite` whose `query` rejects N times with a transient message then resolves; use `vi.useFakeTimers()` to advance backoff; assert attempt count, that a non-transient error does **not** retry, and that two `markNotificationsRead` calls for the same user serialize (second `connect` starts only after the first settles).

### G4 — Replica-lag routing `lag.ts` untested + `countNotifications` write-pool branch unexercised 🟡
**Untested:** `getNotifDbWithoutLag` (`lag.ts:23–25`) — the `isStale → write : read` decision that gives read-your-writes after a mark-read. `operations.test.ts` mocks `./lag` with `isWritePool: () => false`, so `countNotifications`'s **write-pool cache-bust branch** (`operations.ts:114–115`) and the **cache-hit early return** (L117–118) are both never taken.
**Failure it hides:** a routing inversion serves **stale unread counts** right after the user marks read (the classic "badge won't clear" complaint) — invisible to current tests.
**Suggested approach:** unit `getNotifDbWithoutLag` with a fake tracker (`isStale` → true/false) asserting it returns the write vs read pool; add a `countNotifications` case with `isWritePool: () => true` asserting `bustUser` is called and the DB is queried.

### G5 — Cache semantics mostly untested (`cache.ts`) 🟡
**Untested:** `decrementUser` clamp-and-delete (L79–83 → `incrementUser` L72–76: `hDel` when value ≤ 0), `hasUser` gating, `setUser`/`clearCategory`/`bustUser` bodies, and the **null-redis degrade-to-no-op** path (every op's `if (!redis) return`). Only the error-counter wrapper on `getUser`+`incrementUser` is tested.
**Failure it hides:** a broken clamp lets the unread counter go **negative** (badge shows a bogus count); a regression in the null-redis guard throws when redis is unconfigured (dev/degraded prod) instead of no-op'ing.
**Suggested approach:** extend `cache.test.ts` (fake redis already present) — assert `decrementUser` calls `hDel` when `hGet` returns `"0"`, and that with `getRedis: () => null` every op resolves without throwing.

### G6 — SQL param-indexing untested for 5 of 7 operations 🟡
`operations.test.ts` guards `$n` indexing for `queryNotifications`/`countNotifications` only. `createNotificationsBulk`, `create.ts`, `notificationExists`, `cleanupNotifications`, and `markReadImpl` build SQL/params with no such guard — `create.ts`'s positional casts (`$1..$6`) and `createNotificationsBulk`'s `pg-format` value strings are the real off-by-one/injection-shape risk and are unrun. (Covered by adding G2/G3 tests.)

### G7 — `assertRequiredEnv` fail-fast boot check untested (`env.ts:29–42`) 🟢
The pod-won't-go-Ready-on-misconfig guard — including the **prod-only `NOTIFICATIONS_TOKEN` requirement** (L37, i.e. "don't ship an open producer API in prod"). A regression here silently reopens that gate. Cheap: stub env, assert it throws with the right missing-keys list; assert prod+no-token throws, dev+no-token doesn't.

### G8 — Authed-route 401 + success paths untested (`app.ts`) 🟢
`app.test.ts` runs with no token set, so `isAuthorized` always returns true → the **401 branch of `authedBody` (`app.ts:99–103`) is never hit end-to-end**, and no route is exercised past validation into a handler. The RED-outcome mapping (L61–70) is only verified for `rejected`. A route-level test with a mocked `operations`/`create` layer and a configured token would cover the 401, the 202-success, and the `success`/`error` outcome labels.

---

## 3. Quality assessment of existing tests

- **`auth.test.ts` — genuinely good.** 7 behavioral cases hitting every real branch (both header forms, wrong/short/missing/non-bearer, gate-disabled). The one true behavioral suite. Only gap: array-valued headers (`auth.ts:19,26`, branch 87.5%).
- **`operations.test.ts` — meaningful but narrow.** The fake-pool-records-SQL pattern correctly targets the real off-by-one risk (`$n` indexing) and is the right shape. But it covers 2 of 7 exported operations, asserts only on the *emitted string*, and its `./lag` + `./cache` mocks pin the branches so `countNotifications`'s write-pool/cache-hit paths never run. It verifies the SQL is *built* right, not that it *behaves* right.
- **`poll-loop.test.ts` — superficial by design, and the riskiest gap.** All 5 assertions are `toContain`/regex over a whitespace-collapsed **static string**. They guard exactly one edit (deleting `FOR UPDATE SKIP LOCKED`) — valuable as a regression pin, honestly scoped in its own comment — but **would all still pass if `handleNormal`, `handleDebounce`, the debounce drop math, the txn wrapper, and the entire `run()` fan-out were deleted or inverted.** The module's actual logic has zero behavioral coverage.
- **`cache.test.ts` — thin.** Tests only that the error-counter wrapper increments + rethrows on 2 of 6 ops. The cache's actual read/write/decrement-clamp/null-degrade behavior is untested.
- **`app.test.ts` — solid for what it covers (real `inject`), blind past the gate.** Health/metrics/XFF-404/RED-scope are well done (the RED-scope regex belt-and-suspenders is a nice touch). But every authed route stops at the 400 validation; no 401, no handler success, no DB-touching path. Its own comment defers the create path to "an integration run" — **that integration run does not exist in the repo.**

**Integration coverage:** none. Every SQL assertion is against a fake pool or a static string. The load-bearing `PENDING_CLAIM_QUERY` (concurrency correctness under `FOR UPDATE SKIP LOCKED`) is only structurally asserted — its actual claim/lease semantics under concurrent workers are never executed against Postgres. Given replicas:1 + Recreate makes that clause a happy-path no-op today, the *behavioral* correctness of claim → fan-out → reschedule is the more urgent, and entirely absent, coverage.

---

## 4. Top 5 prioritized recommendations (impact vs effort)

1. **★ HIGHEST VALUE — behaviorally test `handleDebounce` + `handleNormal` with a fake `PoolClient` (G1).** Highest blast radius (silent mass drop or duplicate of every debounced notification), pure logic, and the established fake-pool recorder pattern applies directly. Start with the debounce **drop-vs-fanout decision** (`poll-loop.ts:147–154`) and the reschedule UPDATE — the single most consequential untested branch in the app. *High impact / low-med effort.*
2. **Test the producer write path `create.ts` — opt-out filter + `-1` drop + UPDATE→INSERT fallback (G2).** Directly protects against delivering to opted-out users and against silent `{queued:0}` swallowing. Fake `mainDbRead`/`notifDbWrite`. *High impact / low effort.*
3. **Test `markNotificationsRead` retry + per-user serialization (G3).** Fake-timer unit test of the transient-retry/backoff and the pool-starvation guard the code exists for. *Med-high impact / low effort (no infra).* 
4. **Cover `getNotifDbWithoutLag` routing + `countNotifications` write-pool/cache branches (G4/G5).** Guards read-your-writes staleness and counter-clamp correctness; small extensions to existing mocked suites. *Med impact / low effort.*
5. **Add route-level auth+success tests and an `assertRequiredEnv` test (G8/G7).** Close the 401 gate, the 202-success outcome labels, and the prod-token fail-fast — the "don't ship an open producer API" guard. *Med impact / low effort.*

**Stretch (separate track):** one real-Postgres integration test (Testcontainers or a throwaway schema) that runs two concurrent `getPending()` claims and asserts no row is fanned twice — the only way to actually verify `FOR UPDATE SKIP LOCKED` rather than assert its presence in a string. Higher effort; do after 1–3.
