# Paid access — plan (onsite ↔ Creator Studio)

Ask from **Justin (2026-07-23)**:

> "We likely should update the onsite model version management to include the fractional licensing fees
> (1 buzz for 10 images) stuff just like we have on the studio just to be consistent, so that people can
> technically still do it from on-site in their model creation flow as well. Probably need to port the perm
> paid access to onsite as well. I know all the license fee stuff onsite is currently behind a flipt flag too."

Decision that followed: **permanent paid access is now settable from the main app**, not Creator-Studio-only.

This doc has **two tracks**. [Track 1](#track-1--ship-paid-access-now) is what ships this feature with no schema
change. [Track 2](#track-2--migrate-to-a-paidaccess-table) is the refactor that stops this area generating bugs.
They are independent — Track 1 does not depend on Track 2, and Track 2 is worth doing regardless.

---

## Track 1 — ship paid access now

No schema change, no migration, no backfill.

### Already done (in the working tree, uncommitted)

- **Fee as a whole-number ratio onsite.** `ModelVersionUpsertForm` now shows a Buzz amount + "per N images"
  selector instead of a decimal field, reusing `feeToRatio` / `FEE_IMAGE_OPTIONS` from `@civitai/buzz` so the
  two surfaces cannot disagree on rounding. The stored value is the same per-image decimal as before.
- **Permanent access enforcement moved server-side.** `assertPermanentAccessAllowed()` in
  `model-version.service.ts`, called from **both** write paths — the tRPC upsert (onsite) and the REST endpoint
  (Studio). Counts on the primary, off the trigger-maintained `earlyAccessPermanent` column, excluding deleted
  models and the version being edited. Previously the cap lived only in the Studio's own action, so it was a
  client-side invariant rather than a platform guarantee — and the onsite tRPC path had neither the cap nor the
  REST endpoint's 403.
- **Permanent toggle onsite**, settable after publish (permanent has no publish-anchored window), with the tier
  allowance shown. Timeframe control hides when permanent; donation goals correctly key on `isPublished`.
- **Canonical read helper** — `@civitai/buzz/paid-access.ts` (`paidAccessMode`, `isPaidAccessActive`,
  `isTimedWindowOver`, `paidAccessSql`), with tests whose permanent cases encode what every ad-hoc check got
  wrong.
- **Five review bugs fixed**, including one data-loss bug (the form nulled any config whose `timeframe` was
  falsy — i.e. every permanent config — so re-saving destroyed the paid gate).

### Blocking — do before shipping

- [ ] **Exercise in a browser.** Nothing here has been clicked through; typecheck + unit tests only. Cover:
      set a fee ratio, set permanent on an unpublished version, set permanent on a *published* version, hit the
      tier cap, and round-trip a fee between Studio and onsite.
- [ ] **Decide the feature flag.** Does permanent ride the existing `licensing-fee` Flipt flag or get its own?
      Mirror the fee block's escape hatch (versions that already have a fee keep rendering it) so toggling the
      flag can't strand a version in an uneditable state.
- [ ] **Targeted mini-sweep of user-visible "is this paid" surfaces.** Not the full sweep (see Track 2) — just
      the badges/filters/labels a creator or buyer will see for a *permanent* version. Use
      `isPaidAccessActive`.

### Ship-with-known-caveats (fast-follow, not blocking)

- [ ] **Full call-site sweep** — ~37 predicate sites. **Not a money risk**: the paywall
      (`file.service.ts`), the mini endpoint and the redis resource-data query already handle permanent
      correctly. The exposure is cosmetic — permanent versions may read as un-gated in some lists/UI.
- [ ] **Membership source mismatch.** The UI reads `requirements.validMembership`
      (`status IN ('incomplete','active')`, `LIMIT 1`, no tier ordering); the server reads
      `getHighestTierSubscription` (excludes canceled/past_due/unpaid, picks the highest tier). A user with
      multiple subs, or a `trialing` one, can see one cap and get another enforced. Pick one as authoritative.
- [ ] **Live "X of Y set" count onsite.** Only the tier *allowance* is shown today; the usage count needs a
      small tRPC query. Hitting the cap currently surfaces as a server error with a specific message.
- [ ] **Naming divergence.** UI says "Paid Access"; every field is `earlyAccess*`. Rename deliberately or
      accept the split.

---

## Track 2 — migrate to a `PaidAccess` table

### Why

`ModelVersion` carries **six encodings of one concept**:

| Encoding | Kind | Note |
| --- | --- | --- |
| `earlyAccessConfig.timeframe` | jsonb | duration (source A) |
| `earlyAccessConfig.permanent` | jsonb | mode flag; permanent is `timeframe: 0` |
| `earlyAccessTimeFrame` | column | duration (source B) — **still live**, 9 sites |
| `earlyAccessEndsAt` | column | derived window end; **NULL means two things** |
| `earlyAccessPermanent` | column | derived mode flag |
| `availability` | enum | `EarlyAccess` conflates payment with visibility |

…maintained by **three derivation paths**: the `early_access_ends_at` trigger (on write),
`process-ending-early-access` (on time), and ad-hoc SQL recomputing deadlines from the legacy column.

`ComicChapter` models the same concept with three fields and **has already drifted** — no
`earlyAccessPermanent`, so comics structurally cannot offer permanent access.

**Six distinct bugs trace to this**: the Studio badge and access filter, the form wiping a permanent config,
every price control locking after publish, an unusable empty timeframe on seed, and ~37 unaudited call sites.
One modelling decision, six failures, different files and authors — that is the argument for the refactor.

> **Do not justify this work on performance.** See [Improvements](#improvements-and-risks) — the wins are
> correctness and comprehensibility. There is no benchmark to point at.

### Target shape

```text
PaidAccess
  entityType  PaidAccess_EntityType   -- 'ModelVersion' | 'ComicChapter' | …
  entityId    int

  anchorAt    timestamp(3) NOT NULL   -- WRITE-ONCE: when the sale began
  endsAt      timestamp(3) NULL       -- NULL = permanent
  terms       jsonb                   -- prices, trial limit, what's purchasable

  @@id([entityType, entityId])        -- one gate per entity
```

**Four distinct states** — no sentinel, no overload:

| State | Encoding |
| --- | --- |
| Never gated, or creator removed it | no row |
| Running | `now() < endsAt` |
| Expired | `endsAt <= now()` |
| Permanent | `endsAt IS NULL` |

Today **expired and permanent share an encoding** (`timeframe: 0` + `earlyAccessEndsAt NULL`), separated only
by the `permanent` flag. Here they are structurally different.

**Row lifecycle (decided):** created when the creator gates the version; **kept when the sale ends** (preserves
"this was in early access", and distinguishes expired from never-gated); **deleted only when the creator
explicitly removes paid/early access**. The row is the *gate configuration*, not the sales ledger — purchases
live in `buzzTransactions` / `resourceCompensations` — so deleting it loses no financial history.

**Why `anchorAt`, not `publishedAt`:** the platform **rewrites `publishedAt`** (the expiry job re-dates lapsed
versions to `NOW()` so they resurface as "New" — see [traps](#reference--how-access-state-works-today)).
Anchoring to it would shift the window on its own, before any user tried to game it. `anchorAt` is write-once
and mirrors nothing, so unpublish/republish cannot move the gate. Enforce with a `BEFORE UPDATE` trigger so the
anti-gaming property is structural, not a convention.

**Why `endsAt` is stored, not derived:** both inputs are immutable, so it cannot go stale — unlike today's,
which derives from the mutable `publishedAt`. Duration for display is `endsAt - anchorAt`; there is no separate
duration column to disagree with the dates.

**Counting for caps — these differ:**

- permanent cap → `count(*) WHERE endsAt IS NULL`
- concurrent early-access cap → `count(*) WHERE endsAt > now()` — **must exclude expired rows**, which now
  persist. A naive `count(*)` would charge old sales against the live cap.

### Polymorphic, and what that costs

`entityType` + `entityId` follows the house pattern — 11+ models use it (`EntityMetric`, `BuzzTip`,
`EntityCollaborator`, `EntityModeration`, `Appeal`, `UserStrike`, `Outbox`, `JobQueue`), including
money-adjacent ones, and `EntityMetric` uses this exact `@@id` shape with no declared relation.

The cost is no referential integrity, **and we have already been bitten by it**: the permanent cap counted
versions of *deleted* models, locking a creator out with a phantom count. So the mitigations are required, not
optional:

- **Cap counts must join the owning entity and filter deleted rows** — the join replaces the missing FK.
- **Deleting an entity must delete its `PaidAccess` row** in application code; the DB won't cascade.
- **A periodic orphan sweep**, as the other polymorphic tables need.
- **No Prisma relation** — no `include`, hand-written joins. Normal for these tables, but it makes the shared
  read helper matter more, not less.

### Staged path — each stage independently shippable

| Stage | Change | Notes |
| --- | --- | --- |
| 1 | Sweep reads onto `@civitai/buzz/paid-access` | Prereq for everything; no schema change. Also the requirements-gathering for stages 2+ |
| 2 | Retire `earlyAccessTimeFrame` (duplicate duration) | One duration source; kills a falsy-sentinel site |
| 3 | Create `PaidAccess`, dual-write, backfill | Backfill is derivational; **0 permanent rows in prod today**, so only timed rows convert |
| 4 | Move reads onto `PaidAccess`; drop the trigger's derivation | Trigger logic moves to the service, testable in CI |
| 5 | Migrate `ComicChapter` onto the same table | The payoff for going polymorphic |
| 6 | Stop writing payment meaning into `availability` | **Largest ripple — 213 `EarlyAccess` references.** Do last, or never |

**Do the sweep first regardless.** It is required either way, and it tells you how many sites ask "is it paid?"
versus "when does the window end" — which is what sizes stages 3–4.

**Keep `availability = 'EarlyAccess'` as a derived cache** through stages 1–5; only stop *reading it to answer
"is this paid"*. Retiring the enum value is a separate project.

---

## Reference — how access state works today

### The trigger

`early_access_ends_at` is `AFTER INSERT OR UPDATE OF "earlyAccessConfig", "publishedAt" … FOR EACH ROW`, and
branches five ways on published state, writing `earlyAccessEndsAt`, `availability` and `earlyAccessPermanent`
via `UPDATE … WHERE id = NEW.id`.

> Recursion is avoided **by column scope**: the trigger fires only on `earlyAccessConfig` / `publishedAt`, and
> its self-update writes different columns, so it cannot re-fire. That is deliberate and easy to break.

### Trap 1 — `publishedAt` is rewritten when early access ends

`process-ending-early-access` does not merely expire the window:

```sql
SET "earlyAccessConfig" = COALESCE("earlyAccessConfig", '{}') || JSONB_BUILD_OBJECT(
      'timeframe', 0,
      'originalPublishedAt', "publishedAt",
      'originalTimeframe', "earlyAccessConfig"->>'timeframe'
    ),
    "earlyAccessEndsAt" = NULL,
    "publishedAt"       = NOW(),      -- ← re-dated so it resurfaces as "New"
    "availability"      = 'Public'
WHERE status = 'Published' AND "earlyAccessEndsAt" <= NOW()
```

`donation-goal.service.ts` does the same on goal completion. That is why `originalPublishedAt` exists inside the
config — the real publish date must be stashed because the column gets overwritten.

**Consequences:** `publishedAt` is not a stable anchor, and "newest models" ordering silently includes versions
whose early access just lapsed.

### Trap 2 — expired and permanent share an encoding

After that job runs, an expired version has `timeframe: 0` **and** `earlyAccessEndsAt = NULL` — exactly how
permanent is encoded. Only the `permanent` flag separates "this sale ended" from "this sells forever". Any code
reasoning about `timeframe` or `earlyAccessEndsAt` without checking `earlyAccessPermanent` will confuse the two.

### Trap 3 — a third derivation path

`model-version.service.ts` recomputes a deadline from the legacy `earlyAccessTimeFrame` column guarded by
`> 0` — another falsy-sentinel that permanent (duration 0) fails.

---

## Decisions log — options considered and rejected

**`earlyAccessEndsAt = 'infinity'` for permanent — REJECTED.** Attractive because the SQL works
(`'infinity' > NOW()` → true, `<= NOW()` → false), so the ~37 predicate sites would have become correct
untouched. Probed the live DB with all three clients:

| Client | `SELECT 'infinity'::timestamp` |
| --- | --- |
| raw `pg` | `Infinity` — a **number**, not a `Date` |
| Kysely | `Infinity` — a **number**, not a `Date` |
| **Prisma** | **throws**: `error deserializing column 0: value too large to decode` |

Prisma cannot read it at all, and the main app reads this column via Prisma in dozens of places — permanent rows
would make those queries **throw**. Even ignoring Prisma, pg/Kysely return a number while TypeScript says
`Date`, breaking `dayjs()` / `getTime()` call sites. **Do not retry this.**

**A far-future sentinel (`9999-12-31`) — rejected.** Prisma-safe, but a magic value that leaks into any date
formatting, and it lies (the window does "end").

**A new `accessMode` enum column — rejected.** Would be a *fifth* field encoding the same state, also
trigger-maintained, overlapping `availability`, and stale between a window ending and the cron running. It also
wouldn't shrink the sweep. The problem is too much derived state; another derived column is more of it.

**Nullable FKs + `CHECK` instead of polymorphic — rejected.** Real referential integrity and cascade deletes,
but it would make `PaidAccess` the odd table out against an established house pattern, and each new entity type
would need a migration instead of an enum value. See the mitigations above for the integrity cost this accepts.

---

## Improvements and risks

**Genuine, but preventative — indexes.** There are **no indexes on any access field** today (`ModelVersion` has
`modelId`, `status_publishedAt`, `vaeId`, `licensingSourceVersionId`, `modelId_baseModel`). It isn't hurting
yet: the expiry job is a cron, the cap count is scoped to one user's catalogue via the `Model` join, and paywall
reads are cached. Build the right ones into `PaidAccess` from day one — a partial index `WHERE endsAt IS NULL`
makes the permanent cap an index-only scan.

**Not a performance win — the trigger.** An earlier draft claimed removing it would cut write cost. It won't:
`ModelVersion` already has **8 triggers, 3 firing on every update**, and version saves are user-initiated and
low-frequency. Move the logic for **testability and visibility** (today it is plpgsql CI cannot exercise, and it
silently rewrites `availability`) — not for speed.

**⚠️ A regression risk, not a win — the expiry cron.** With interval-based expiry the job is no longer needed
for *correctness*, but **it is still the cache-invalidation event**. `resource-data.redis.ts` embeds
`earlyAccessConfig` behind `CASE WHEN … earlyAccessEndsAt >= NOW()` and would keep serving "still gated" until
its TTL lapses. **Retarget the job to cache + search invalidation; do not delete it.**

**Blast radius, not a detail.** Because the expiry job re-dates `publishedAt` so lapsed versions resurface as
"New", **feed ordering and the search index depend on expiry timing**. Any change to expiry semantics ripples
into search/feeds.

**Smaller wins.** `getUserEarlyAccessModelVersions` fetches rows to evaluate a *count* cap — make it
`count(*)`. `assertPermanentAccessAllowed` could skip its count when the config is unchanged.

---

## References

- Canonical read helper — `packages/civitai-buzz/src/paid-access.ts`
  (+ `src/shared/utils/__tests__/paid-access.test.ts`)
- Fee ratio helper — `packages/civitai-buzz/src/licensing-fee.ts`
- Permanent / early-access caps — `packages/civitai-buzz/src/early-access.ts`
- Studio access filter + badge fix (the NULL-end-date trap) — commit `3c85f898df`
- Studio early-access quantity cap (was missing) — commit `909b8347b2`
- Permanent trigger + column — `prisma/migrations/20260721120000_early_access_permanent/`
