# Unifying licensing fees + paid access into `@civitai/monetization`

**Status:** Plan — not started. Sequenced so every step ships independently.

## Why

`@civitai/buzz` already shares the **pure** monetization rules — caps, `effectiveLicensingFee`,
`cappedTerms`, `monetizationLimits`, `resolveCapTier`, `isPermanentGate`, `gatePrices`. Everything that
touches the **database or a cache** is written twice: once in the main app against Prisma, once in the
spoke against kysely.

That seam produced four money bugs in one week. This is the argument for the work — not tidiness:

| Bug                                                               | Cause                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Fee set in Creator Studio kept earning tips (CU 868kk4j2k)        | Main app maintained `DisablePayout` alongside the fee; the spoke's `writeFee` never touched `flags` |
| "Fee set" filter listed 64,485 versions whose chip read "Fee off" | Spoke filtered `IS NOT NULL`; every read gates `> 0`                                                |
| Licensing fee clamped for a gold member                           | Tier read from a cache the spoke can't bust                                                         |
| Cleared fee stored `0`, not `NULL`                                | Two clear paths, two normalizations                                                                 |

Each was fixed in both places by hand. The next one will be too, unless the DB/cache layer is shared.

### The divergence that matters most

**The two apps resolve the cap tier from different sources.** The main app queries
`CustomerSubscription` (`getCapTier`, Redis-cached); the spoke reads `user.tier` / `memberInBadState`
off the session. They can disagree for as long as either cache is stale, and when they do the creator's
editor shows one ceiling while the charge path applies another. Both delegate to the same
`resolveCapTier`, which _hides_ the disagreement: the rule is shared, the input is not.

Sharing the rule was not enough. The input has to be shared too.

---

## Decision record: package, not a service

Considered standing up a monetization API server instead. Rejected, for three reasons worth recording
so this isn't relitigated:

1. **The service can't be extracted without the data.** Fees, `DisablePayout` and paid-access terms
   live on `ModelVersion` / `PaidAccess` in the main Postgres, beside the model and its files. A service
   reading the main app's `ModelVersion` is a distributed monolith — a network hop _plus_ the shared-DB
   coupling. Extracting the data instead means the main app can no longer join fees into a version
   query, which is most of what it does. (Contrast the buzz service, a _correct_ extraction: it owns the
   ledger, its API is coarse, and consumers tolerate staleness.)
2. **Every service boundary in a pricing domain creates a far-side cache, and each is a silent
   correctness liability.** The orchestrator is the live proof: it caches resource data because it can't
   call per generation, and when `invalidateResource` fell out of the generated client that cache became
   un-bustable — mispricing every affected model for ~2.5 months with no signal. `getPaidAccess` and
   `getCapTiers` are per-row on the feed and generation paths, so the consumers that would hurt most are
   exactly the ones that would be forced to cache.
3. **It pre-empts a decision that has its own forum.** `docs/event-bus-discovery.md` exists to replace
   "a sprawl of little backend services-behind-endpoints" with one substrate, and is on hold pending
   leadership air-cover.

A package fixes **modularity**; a service fixes **deployment and ownership** coupling. The pain here is
modularity.

**When a service would be right:** if monetization ever owns its own store, with `ModelVersion` holding
only a reference. That's a data-model project, and it belongs in the event-bus conversation.

---

## Target layout

`@civitai/buzz` today mixes two domains. Splitting them along how they're actually used is nearly clean:

|                         | uses currency/client symbols | uses monetization symbols |
| ----------------------- | ---------------------------- | ------------------------- |
| main app (24 importers) | **2**                        | 20                        |
| spoke (9 importers)     | **1**                        | 7                         |

```
@civitai/buzz               currency transport — buzz service client, account-types,
                            queries, responses, env (BUZZ_ENDPOINT). 3 consumers.

@civitai/monetization       licensing fees, paid access, caps, limits, creator program.
  ├── (root)                pure rules — client-safe, no IO
  └── /server               kysely queries + redis caches + write guards
```

Enforced by `exports` in `package.json`, so `@civitai/monetization` _cannot resolve_ a server module —
stronger than the discipline a naming convention buys. `@civitai/buzz` keeps meaning what its name says.

The `/server` entrypoint **constructs nothing**: both apps already build kysely (`@civitai/db/kysely`)
and Redis (`@civitai/redis`) clients, so they're passed in. No env reading, no singletons, and tests
inject fakes.

```
packages/civitai-monetization/src/
  index.ts            pure re-exports (licensing-fee, paid-access rules, monetization-limits, media-type, creator-program)
  server/
    context.ts        MonetizationContext = { db: Kysely<DB>, redis, sysRedis }
    cap-tier.ts       getCapTier / getCapTiers / bustCapTier
    paid-access.ts    getPaidAccess / write / count / bust
    licensing-fee.ts  setFee (fee + type + currency + DisablePayout, one statement) / bulk / preview
    guards.ts         assertPaidAccessCaps / assertFeeCaps
    filters.ts        feeFilter / paidAccessFilter kysely fragments
```

---

## Prerequisite: move the batched cache builder to `@civitai/redis`

`paidAccessCache` and `capTierCache` are `createCachedObject` — batched per-id (`fetch(ids[]) →
Record`), with msgpack packing, request debounce, `notFound` markers, optional per-pod L1, and fail-open
on Redis errors. It lives in `src/server/utils/cache-helpers.ts`, main-app only. `@civitai/redis` today
exports only a **single-key** read-through cache, which can't express "fetch 200 version ids in one
round trip" — what `getPaidAccess` and `getCapTiers` do on the feed path.

Move `createCachedArray` / `createCachedObject` into `@civitai/redis`. A second, narrower batched
primitive would mean two implementations of the same semantics — the exact duplication this document
exists to remove.

Smaller than the file's 1,044 lines suggests:

- **The redis dependency is already in the package.** `~/server/redis/client` is a shim that does
  `export * from '@civitai/redis/client'`; the package already owns the typed client, `REDIS_KEYS` and
  the key-template types.
- **Only the two builders move** (~470 lines). `queryCache(db: PrismaClient)`, tag busting, pattern
  clearing, counters and `fetchThroughCache` stay.
- **What's left to inject is small**: five prom counters, `logToAxiom` / `logSysRedisFailOpen` /
  `createLogger`, and `CacheTTL`. The package already takes injected behavior (the client's debug logger
  and Flipt policy).
- **Small utils come along**: `createLruCache`, `sleep`, `hashifyObject`, `isDefined`.

Measured test blast radius:

|                                                              | suites |
| ------------------------------------------------------------ | ------ |
| mock `~/server/redis/client`                                 | 155    |
| mock `~/server/utils/cache-helpers`                          | 26     |
| reference `createCachedObject`/`Array` in their mock factory | **4**  |

`cache-helpers.ts` keeps re-exporting both builders, so all 26 module-path mocks keep working. The 155
mocking the redis client stay unaffected **only if the builder receives its client as an argument
rather than importing one.** That is the single design constraint that keeps this cheap.

---

## Implementation steps

**Branching.** Step 0 is its own PR — it's a monorepo-wide caching primitive, not monetization work,
with a different reviewer and its own test blast radius, and it's worth having even if the rest is
abandoned. **Steps 1–6 land together on one branch off `main`.**

Not one PR per step: the repo forbids stacked PRs, so N PRs means N serialized merge waits, each
rebasing on the last. Steps 1–6 are also one coherent end state — a half-migrated layer, with logic
live in both the package and the app, is a worse place to sit than either bookend, and the package's
interface emerges as things move, so an interface fixed in Step 2 and invalidated by Step 5 is churn
paid twice.

**Keep each step as its own commit.** That preserves commit-by-commit review and a bisectable history
if a money bug reaches prod, without the serialized merges. Step 1 in particular should be a commit of
_only_ moves and import rewrites, so review attention goes to Steps 4–5 where money logic changes.

Every step leaves the tree green: `pnpm typecheck` + the spoke's `pnpm run check` + `pnpm test`.

### Step 0 — cache builder to `@civitai/redis`

1. Add `createCachedArray` / `createCachedObject` to `packages/civitai-redis/src/cached-array.ts`,
   taking `{ redis, sysRedis, metrics, log }` at construction.
2. Move `createLruCache`, `sleep`, `hashifyObject`, `isDefined` (or copy the two small ones).
3. In `src/server/utils/cache-helpers.ts`, delete both builders and re-export the package versions
   pre-bound to the app's client, counters and loggers.
4. **Verify:** the 4 suites whose mock factory names the builders; then the full suite.

**Done when:** no behavior change, `cache-helpers` is ~470 lines lighter, and both builders are
importable from `@civitai/redis` with an injected client.

### Step 1 — create the package and split `@civitai/buzz`

1. Scaffold `packages/civitai-monetization` with `exports: { ".": …, "./server": … }`.
2. Move `licensing-fee.ts`, `paid-access.ts`, `monetization-limits.ts`, `media-type.ts`,
   `creator-program.ts` (+ their tests) from `civitai-buzz` to the new package root.
3. Leave `client.ts`, `env.ts`, `queries.ts`, `responses.ts`, `account-types.ts` in `@civitai/buzz`.
4. Update **27 import statements** (20 main-app + 7 spoke files). Mechanical: `@civitai/buzz` →
   `@civitai/monetization`. The 3 currency/client importers are untouched.
5. Add `@civitai/monetization` to both apps' `package.json`.

**Done when:** typecheck + `svelte-check` green, no `/server` code exists yet. Pure move, no logic
change — keep it reviewable by making this commit contain _only_ moves and import rewrites.

### Step 2 — cap tier (the divergence)

1. `server/cap-tier.ts`: port `getCapTier` from `subscriptions.service.ts` to kysely
   (`CustomerSubscription` ⋈ `Product`, `status NOT IN (...)`, `renewalEmailSent` filter,
   `pickHighestTier`), plus `getCapTiers` on the Step-0 batched cache and an exported `bustCapTier`.
2. Main app: `paid-access.service.ts` delegates `getCapTiers` / `getCachedCapTier` to the package
   (**2 call-site files each**); `subscriptions.service.ts` keeps `getHighestTierSubscription` for
   non-cap uses (**5 files reference `getCapTier`** — confirm which are cap-related).
3. `clearSessionCache` calls `bustCapTier(userId)` instead of rebuilding the Redis key by hand.
4. **Spoke stops reading tier off the session** — `cappedTier(resolveMembership(...))` becomes a
   package call. `membership.ts` keeps `isCreatorProgramMember` and the test-cookie override.

**Done when:** both apps resolve the cap tier from one DB-backed, one-cache definition. This closes the
gold-membership class of bug and is a read path, so a mistake is visible without being destructive.

**Watch:** adds a cached DB read to Studio pages showing caps (1h TTL, bust on subscription change → one
Redis get per page). See open question 2.

### Step 3 — reads and filters

1. `server/paid-access.ts`: `getPaidAccess` + its cache, kysely-backed (**8 call-site files**).
2. `server/filters.ts`: `feeFilter` and `paidAccessFilter` as kysely fragments, moved out of
   `apps/creator-studio/src/lib/server/models.ts`. Keep the parenthesization — the `off` branch is
   OR'd and reassociates if unwrapped.
3. Main app `getViewerMonetization` (**6 call-site files**) becomes a thin wrapper over the package.
4. `countUserPermanentAccessVersions` (**1 file**) and the spoke's `countPermanentAccessVersions` /
   `countPermanentAccessVersionsExcluding` collapse into one function with an `exclude` param.
5. `strictestCapMediaType` and per-row `capMediaType` unify.

**Done when:** "fee set" cannot mean two things again, and the permanent-gate count has one definition.

### Step 4 — write guards

1. `server/guards.ts`: one `assertPaidAccessCaps` (**3 call-site files** today) and a new
   `assertFeeCaps`, both preserving the increase-only rule (`raisesOverCap` — resubmitting or lowering
   always passes; this is the outage `82f64846ba` hot-fixed).
2. Callers: the tRPC handler, the REST endpoint, and both spoke form actions in
   `models/+page.server.ts` (which today enforce caps inline).
3. `currentAccessPrices` moves in as the guards' read.

**Done when:** three copies of the cap rule become one. Requires open question 1 (guards read current
state, so they sit on the write path).

### Step 5 — writes

1. `server/licensing-fee.ts`: one `setFee` owning the invariant **"a fee and its payout flag move
   together"** — fee, `licensingFeeType`, `licensingFeeSettlementCurrency` and `DisablePayout` in a
   single statement. Absorbs the spoke's `writeFee` / `normalizeFee` / bulk paths and the main app's
   fee block in `upsertModelVersion`.
2. `server/paid-access.ts`: gate write absorbing `writePaidAccessForModelVersion` (**2 files**),
   `setPaidAccessConfig`, `bulkSetPermanentAccess`, `materializePaidAccessEndsAt`.
3. One fee-input schema replaces `modelVersionUpsertSchema2.licensingFee` and the spoke's
   `licensingFeeRatioSchema` + `normalizeFee`.
4. **Keep the `feeProvided` guard**: `undefined` (caller sent no fee) must stay distinguishable from
   `null`/`0` (creator cleared it), or `requestReviewHandler` / `declineReviewHandler` wipe fees on
   partial saves. Port the regression test alongside.

**Done when:** the CU 868kk4j2k class of bug is structurally impossible.

### Step 6 — cache busting

1. `bustMonetizationCaches(versionIds)` for the caches the package owns (paid access, cap tier).
2. Main app `bustMvCache` keeps app-specific work — search index, CDN purge, `dataForModelsCache`,
   `bustOrchestratorModelCache` — and calls the package for the rest.
3. Spoke _may_ bust directly instead of HTTP-hopping `/api/v1/model-versions/bust-cache`. Keep the
   endpoint until the spoke's Redis access is proven in production; this is the least reversible step.

---

## Out of scope

- **Orchestrator invalidation** stays in the main app — needs `ORCHESTRATOR_ACCESS_TOKEN` and the
  resource-data cache, neither of which belongs here.
- **Search-index and CDN busting** stay app-side.
- **The 67k legacy `licensingFee = 0` rows.** Cosmetic now (every read gates `> 0`, filter fixed).
  Optional separate migration.
- **`@civitai/buzz`'s currency client.** Untouched beyond losing the monetization modules.

## Open questions

`@ai:*` **The fork in the road.** `upsertModelVersion` writes `licensingFee` and `flags` inside a Prisma
`$transaction` alongside files, images and recommended resources. A kysely write cannot join that
transaction — separate connections, so the fee write would commit outside the version write's
atomicity. Options: (a) move the fee/flag write to a package call immediately after the transaction
commits — simplest, and the spoke already lives with that window; (b) share a connection — not viable,
Prisma won't hand over its pool; (c) the package returns SQL builders each app executes — preserves
atomicity but costs the package its caching, which is half the point. **Recommend (a).** Steps 4–5
depend on this answer.

`@ai:*` Step 2 moves the spoke's tier from session → DB, adding one cached Redis get per Studio page
that shows caps. Acceptable?

`@ai:*` The Steps 1–6 branch is long-lived and will conflict with anything touching monetization files
(Step 1 alone rewrites 27 import statements). Worth doing in a focused window rather than spread over
weeks — is there a quiet period, or should it wait for the current PR queue to settle?
