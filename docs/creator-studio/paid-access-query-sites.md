# Early-access query sites — sweep inventory

Every place in `src/` that reads, queries, or compares early-access state. This is the work-list for **stage 1**
of the paid-access refactor (see [onsite-monetization-parity.md](onsite-monetization-parity.md)) — moving the
"is this paid?" decision onto the canonical helper so permanent access stops being invisible.

Generated 2026-07-24 by grep over `src/**/*.{ts,tsx}`. Re-run the commands at the bottom to refresh.

## Blast radius

| Symbol | Count | What it is |
| --- | --- | --- |
| `earlyAccessConfig` | 203 | the jsonb blob (prices, permanent, timeframe, donationGoalId, …) |
| `earlyAccessEndsAt` | 122 | the window-end column — **the one most code reads** |
| `earlyAccessPermanent` | 11 | the permanent flag — only **8 real reads** know about it |
| `Availability.EarlyAccess` | 11 | availability conflated with payment |
| `earlyAccessTimeFrame` | 9 | legacy duplicate duration column |

The gap in one line: **122 reads of `earlyAccessEndsAt`, but only ~8 that also check `earlyAccessPermanent`.**
Most code that decides "is this paid?" cannot see permanent.

## Legend

- ✅ **correct** — already permanent-aware. Migrate to the helper for consistency, but not a bug.
- 🔴 **needs helper** — infers "is it paid" from the date alone; **misses permanent**. Replace with
  `isPaidAccessActive` / `paidAccessSql`.
- 🪟 **window-specific** — legitimately about the *window itself* (a countdown, the expiry match). Leave as-is;
  permanent correctly has no window.
- 🟣 **comics** — correct *today* because comics has no permanent access, but must be updated the moment the
  paywall is unified. Grouped separately so they're not missed.

---

## A. Date predicates — the actionable set (~26)

These test `earlyAccessEndsAt` against `now()` or null. Each is where the permanent bug does or could live.

### ✅ Already permanent-aware (money-critical paths are here — verify, don't rewrite)

| File:line | Note |
| --- | --- |
| `src/server/services/file.service.ts:231` | **the download paywall.** `earlyAccessPermanent \|\| now < deadline`. Correct. |
| `src/pages/api/v1/model-versions/mini/[id].ts:134` | `earlyAccessEndsAt > NOW() OR earlyAccessPermanent`. Correct. |
| `src/server/redis/resource-data.redis.ts:34` | resource cache build; `>= NOW() OR earlyAccessPermanent`. Correct. |
| `src/server/services/model.service.ts:1554` | `earlyAccessPermanent \|\| (endsAt && isFutureDate)`. Correct. |
| `src/server/services/model-version.service.ts:1752` | `!earlyAccessEndsAt && !earlyAccessPermanent`. Correct (negation). |
| `src/components/Model/ModelVersions/model-version.utils.ts:68` | `(endsAt && > now) \|\| earlyAccessConfig?.permanent`. Correct (via config). |

### 🔴 Needs the helper — infers paid from the date, misses permanent

**How** column: **D** = decorate a known/loaded row → `isPaidAccessActive(row)` (fed by `getPaidAccess` on
hot paths); **P** = the row set is *filtered/counted* by access state → `paidAccessSql()` in the query. See
the decorate-vs-predicate rule in [onsite-monetization-parity.md](onsite-monetization-parity.md#caching-getpaidaccess).

| File:line | How | What it drives |
| --- | --- | --- |
| `src/components/Model/ModelVersions/ModelVersionDetails.tsx:279` | D | the version-detail "isEarlyAccess" → generate button gating/UI |
| `src/components/Model/ModelVersionList/ModelVersionList.tsx:133` | D | the early-access badge in the version list |
| `src/components/Model/ModelVersions/ModelVersionDonationGoals.tsx:54` | D | whether the donation-goal block shows |
| `src/server/services/model-version.service.ts:268` | **P** | Prisma `where earlyAccessEndsAt: { gt: now }` — a **query filter** for "in early access" |
| `src/server/services/model-version.service.ts:835` | D | guards an early-access-only branch on save |
| `src/server/services/model-version.service.ts:2615` | D | early-access check in version copy/duplicate |
| `src/server/services/model.service.ts:2882` | D→P? | `find(v => !!v.earlyAccessEndsAt)` — "does this model have EA"; app-side over loaded versions today, a candidate to push down to `EXISTS` |
| `src/server/services/donation-goal.service.ts:157` | D | gates the goal-creation-on-publish path |
| `src/server/redis/donation-goals-cache.ts:136` | D | `!endsAt \|\| endsAt <= now` → drops the goal; a permanent version's goal is wrongly treated as ended |

### 🪟 Window-specific — leave as-is

| File:line | Why it's fine |
| --- | --- |
| `src/server/jobs/process-ending-early-access.ts:26` | the expiry job: matches windows that have **elapsed**; permanent must *not* match (it has no window) |
| `src/components/Model/ModelVersions/ModelVersionEarlyAccessPurchase.tsx:104` | `<Countdown endTime={earlyAccessEndsAt}>` — a timer; permanent has nothing to count down |
| `src/server/services/model-version.service.ts:1767` | `earlyAccessEndsAt && < now` — "the timed window is over"; verify intent, likely window-specific |

### 🟣 Comics — correct today, must update if the paywall is unified

| File:line | |
| --- | --- |
| `src/components/Comics/comic-chapter.utils.ts:36` | `!!earlyAccessEndsAt && > now` |
| `src/pages/comics/project/[id]/index.tsx:1591` | chapter early-access check |
| `src/pages/comics/project/[id]/index.tsx:1831` | active-chapter early-access check |
| `src/server/routers/comics.router.ts:615` | `where earlyAccessEndsAt: { gt: now }` |
| `src/server/routers/comics.router.ts:1921` | `ch.earlyAccessEndsAt > now` |
| `src/server/routers/comics.router.ts:1942` | `ch.earlyAccessEndsAt > now` |
| `src/server/routers/comics.router.ts:4918` | `ch.earlyAccessEndsAt <= now` |

---

## B. `earlyAccessTimeFrame` — the legacy duplicate duration (9 sites, retire in stage 2)

A second duration source alongside `earlyAccessConfig.timeframe`, still read. Note `:1542` is a **third**
falsy-sentinel (`earlyAccessTimeFrame > 0`) that permanent (duration 0) fails.

- `src/server/services/model-version.service.ts:1521, 1534, 1542, 1545`
- `src/server/services/model.service.ts:238, 3414, 3437`
- `src/server/redis/caches.ts:473, 511`

## C. `Availability.EarlyAccess` used as the gate — **convert the reads in Part 1** (11 sites, 5 files)

`availability = 'EarlyAccess'` doubles as a paid-gate signal. Every one of these sits **next to** an
`earlyAccessEndsAt` read you're already migrating — `availability = 'EarlyAccess' AND earlyAccessEndsAt > NOW()`
— so you can't rewrite the right side without the left. **Convert them in the same Part 1 sweep** (drop the
`availability` condition, route through the helper); deferring just forces re-deriving this map later, and
leaving `availability` as a second "is this gated" answer is the three-concepts trap.

- `src/server/services/common.service.ts:138`
- `src/server/services/model.service.ts:1009`
- `src/server/redis/resource-data.redis.ts:35`
- `src/pages/api/v1/model-versions/mini/[id].ts:135`
- `src/server/routers/comics.router.ts` — 7 sites

**Not** in this PR: dropping the `EarlyAccess` **enum value** — a Postgres type recreate that crosses into
event-engine (`models.feed.ts`, `model-feed-types.ts`) and the Meilisearch doc shape (coordinated deploy +
reindex). Part 2 stops *writing* the value; the drop is a separate **dated** ticket. (The "~213 refs" figure is
inflated — component names, the deprecated `isEarlyAccess()` helper, the unrelated `PaidEarlyAccess` enum. The
real gate-reads are these 11.)

## D. `earlyAccessConfig` readers (203 sites)

The bulk. Most are **not** access-state decisions — they read prices, trial limits, donation config, etc., and
are fine. Only the subset that reads `.permanent` / `.timeframe` **to decide access state** matters here, and
those overlap the predicates in section A. Treat section A as the authoritative actionable list; grep this set
only to confirm no `.permanent`/`.timeframe` access-decision hides outside A.

---

## E. Part-2 column-drop work-list (from the 2026-07-24 safety review)

Section A is scoped to the *permanent bug*. These sites are **not** permanent-bug holes (they inherit a
cache's build-time gate) but they read the **columns/blob** and therefore break when Part 2 drops them, so they
must be migrated before the drop. Grouped separately because §A misses them.

### Main app (`src/`)

| File:line | What it reads | Migrate to |
| --- | --- | --- |
| `src/pages/api/v1/model-versions/[id].ts:69` | public API selects `earlyAccessEndsAt`/`earlyAccessConfig` | `getPaidAccess` decorate |
| `src/server/services/creator-shop.service.ts:660` | `getEarlyAccessModelPrices` reads config | `terms` via `getPaidAccess` |
| `src/server/services/generation/generation.service.ts:1362,1490` | `earlyAccessConfig.freeGeneration` (**dropped**) / `generationTrialLimit` (→ `terms.generation.trialLimit`) | `terms` |

### creator-studio spoke (`apps/creator-studio/`)

The spoke queries the **same DB** via Kysely; reads permanence from `earlyAccessConfig->>'permanent'` (its
Kysely lacks the column), so it breaks on the `earlyAccessConfig` drop specifically. Kysely types need
`PaidAccess` added.

| File:line | What it drives | How |
| --- | --- | --- |
| `lib/server/models.ts:10` | `accessFilter` "sold in any form" | **P** → `PaidAccess` `EXISTS` |
| `lib/server/models.ts:208,258` | select + `hasEarlyAccess` | D → `getPaidAccess` |
| `lib/server/monetization/early-access.ts:98` | permanent **cap count** | count `PaidAccess WHERE "endsAt" IS NULL` |
| `lib/server/monetization/early-access.ts:114` | timed-window **cap count** | count active `Timed` `PaidAccess` |

Spoke **writes** go through the main app's REST early-access endpoint (`early-access.ts:62-68`) → covered by the
main-app dual-write; no separate spoke write change.

---

## How to classify a site (the rule)

Ask **what the code does with the answer**:

- decides **"is this gated / can this user access / is it paid"** → 🔴 use `isPaidAccessActive(v)` (JS) or
  `paidAccessSql(alias)` (SQL) from `@civitai/buzz`. These are permanent-aware.
- asks **"when does the window end / how long is left"** → 🪟 leave it; that is genuinely about the timed window.
- filters a **query** for "currently in early access" → 🔴 replace the `earlyAccessEndsAt > now` predicate with
  `paidAccessSql()` (adds `OR earlyAccessPermanent`).

Helper: `packages/civitai-buzz/src/paid-access.ts` (`isPaidAccessActive`, `paidAccessMode`, `isTimedWindowOver`,
`paidAccessSql`), tests in `src/shared/utils/__tests__/paid-access.test.ts`.

## Refresh commands

```bash
# totals
for p in earlyAccessConfig earlyAccessEndsAt earlyAccessPermanent earlyAccessTimeFrame; do
  echo "$p: $(grep -rnE "$p" src/ --include=*.ts --include=*.tsx | wc -l)"
done

# the actionable date predicates
grep -rnE "earlyAccessEndsAt" src/ --include=*.ts --include=*.tsx \
  | grep -E "(>|<|>=|<=|gt:|lt:|gte:|lte:|isFutureDate)"

# which sites already know about permanent (the ✅ set)
grep -rnE "earlyAccessPermanent" src/ --include=*.ts --include=*.tsx
```
