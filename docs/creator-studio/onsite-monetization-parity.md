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
- [x] **Feature flag — decided (2026-07-24): no flag.** Permanent access releases with Creator Studio.
- [ ] **Targeted mini-sweep of user-visible "is this paid" surfaces.** Not the full sweep (see Track 2) — just
      the badges/filters/labels a creator or buyer will see for a *permanent* version. Use
      `isPaidAccessActive`.

### Ship-with-known-caveats (fast-follow, not blocking)

- [ ] **Full call-site sweep** — ~37 predicate sites. **Not a money risk**: the paywall
      (`file.service.ts`), the mini endpoint and the redis resource-data query already handle permanent
      correctly. The exposure is cosmetic — permanent versions may read as un-gated in some lists/UI.
- [ ] **Membership source mismatch — direction decided (2026-07-24).** The UI reads
      `requirements.validMembership` (`status IN ('incomplete','active')`, `LIMIT 1`, no tier ordering); the
      server enforces with `getHighestTierSubscription` (excludes canceled/past_due/unpaid, picks the highest
      tier). **The server is authoritative; the UI should display the server-computed cap, not recompute tier
      client-side.** Have the form loader return `{ permanentCap, permanentUsed }` computed with the same helper
      enforcement uses — then displayed == enforced by construction, and it also delivers the live "X of Y"
      count below. (Same pattern as creator-studio's loader.)
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

### Target: a unified paywall, not a ModelVersion cleanup

The goal is a **reusable paywall** that models, comics, and future entity types all plug into — one place to fix,
one place to extend. This is more achievable than it sounds, because **half of it already exists**: the
*purchase* side (`EntityAccess`) is already polymorphic (`accessToType`/`accessToId`, a `permissions` bitmask).
What is not unified is the *config* side — the `earlyAccessConfig` blob bolted onto `ModelVersion`. `PaidAccess`
is that config half finally matching the shape the entitlement half already has.

Structure it as **one shared core + thin per-entity adapters.**

```text
-- SHARED, entity-agnostic --------------------------------------------------
EntityAccess   (exists)   who holds which grant        [purchase side]
PaidAccess     (new)      what is for sale, when it ends [config side]
--                        promotions live in terms jsonb as per-grant sale periods (decided 2026-07-24),
--                        not a table — see the schema doc.

PaidAccess
  entityType  PaidAccess_EntityType   -- 'ModelVersion' | 'ComicChapter' | …
  entityId    int
  ownerId     int                     -- DENORMALIZED at write; owner-scoped cap counts, entity-agnostic
  endsAt      timestamp(3) NULL       -- MATERIALIZED effective end; NULL = permanent-or-pending
  termsVersion int NOT NULL
  terms       jsonb NOT NULL          -- what is purchasable (see below)
  @@id([entityType, entityId])        -- one gate per entity

-- the anchor stays on each ENTITY (ModelVersion.initialPublishedAt, etc.),
-- write-once, used only at publish time to compute `endsAt`.
```

**The core read path is one call, works for any entity:**

```text
resolveAccess({ entityType, entityId, userId, grant }) -> { gated, hasAccess, price }
  paid = PaidAccess(entityType, entityId)
  if !paid or !isPaidAccessActive(paid)   -> { gated:false }          // free
  if grant not in paid.terms              -> { gated:false }          // that grant is free
  price     = activeSale(paid.terms[grant], now)?.price ?? paid.terms[grant].price  // sale periods in terms
  hasAccess = EntityAccess holds bit(grant) for (entity, user)
  -> { gated:true, hasAccess, price }
```

`isPaidAccessActive`, price/promotion resolution, and the `EntityAccess` bit check are all entity-agnostic —
that is the reusable module.

**The four seams — where per-entity adapters plug in.** Two are dissolved by decisions already made:

1. **The anchor** (`initialPublishedAt`) lives on each entity. → *Dissolved by materialized `endsAt`*: the shared
   read path never needs the anchor, only the entity's own publish flow does (at write). This is the decisive
   reason `endsAt` beats storing a duration.
2. **Owner-scoped cap counts** need an owner that lives on the entity. → *Dissolved by denormalizing `ownerId`
   onto `PaidAccess`* — the same stamp-at-write pattern as the licensing-fee owner work and `reactions.ownerId`.
3. **Grant vocabulary** — models have `download`/`generation`; a comic has `read`. The bitmask is generic ints;
   what each bit means is per-type. → the adapter declares the entity's grant set + bit mapping.
4. **Enforcement + lifecycle wiring** — the download endpoint, generation resolver, comic reader are per-entity
   call sites that each call `resolveAccess`; and entity deletion must delete the `PaidAccess` row (polymorphic
   → no FK cascade). → a thin adapter per entity.

**Caps are adapter policy, NOT shared core.** Read resolution never touches caps; they fire only at write. And
they differ by mode *and* entity type:

| | Gated by | Limits |
| --- | --- | --- |
| Early access (timed) | creator **score** | concurrent count (`scoreQuantityUnlock`) **and** max days (`scoreTimeFrameUnlock`) |
| Permanent | CP **tier** | concurrent count (`bronze 3 / silver 10 / gold ∞`) |
| Comics | **unknown** | **unknown** — different axis, or none |

So the split is:

- **shared plumbing**: `countActivePaidAccess({ ownerId, entityType, mode })` where `mode` = `permanent`
  (`endsAt IS NULL`) or `timed` (`endsAt > now()`). Same query for everyone; `ownerId` makes it work across
  types. Plus a generic `assertWithinCap`.
- **adapter policy**: the limits and what gates them. `assertPermanentAccessAllowed` (already written) becomes
  the *ModelVersion adapter's* permanent check on this plumbing. The Comics adapter supplies comics' rules — or
  none.

**Caps are scoped per entity type by default** (`count … WHERE entityType = 'ModelVersion'`), so models and
comics are limited independently. A shared cross-type budget would be a *deliberate later* decision, not baked
in. **The framework must not know any entity's caps** — that is exactly what lets comics differ without touching
the core.

> **Open question (comics owner):** what are a comic's paid-access limits — same score/tier axes, something
> else, or none? The design does not need the answer; it only needs to not foreclose it, which per-type adapters
> do.

No `donationGoalId` on `PaidAccess`. A donation goal is a **threshold end condition** (see the reframe below),
and the link already exists in the correct direction — `DonationGoal.modelVersionId` — so it is a forward query,
not a back-reference to denormalize.

### The rule for what is a column vs what is JSON

**Columns for what the gate branches on. JSON for what only the application reads.**

This is the line that keeps the design extensible without recreating the current mess. The bug class we are
fixing came from `permanent` and `timeframe` living in JSON **while also determining access state** — which is
exactly why a trigger had to project them into columns so queries could see them. Prices never had that
problem: nothing gates on them, they are read once you already know the entity.

| Belongs in a column | Belongs in `terms` | Belongs in its own row/table |
| --- | --- | --- |
| `endsAt`, `ownerId` — every "is it gated" / cap query (anchor is `initialPublishedAt` on the entity) | prices, trial limits, which grants are sold | end conditions (date is `endsAt`; threshold is the `DonationGoal`) |
| `entityType` / `entityId` — the join key | future purchase options | `DonationGoal` — links back via `modelVersionId`, already |

**So new purchase options need no migration** — only new *gating semantics* do, and those are rare and should
be deliberate.

### Shape `terms` so invalid states stay unrepresentable

Being JSON does not mean being loose. Model grants as **optional nested objects**, where absence means "not
sold" — never a boolean beside a value that can contradict it:

```json
{
  "download":   { "price": 5000 },
  "generation": { "price": 2500, "trialLimit": 10 }
}
```

Today's `chargeForDownload` + `downloadPrice` are separate fields that *can* disagree — which is why
`assertEarlyAccessChargeConfig` exists to throw *"You must provide a download price when charging for
downloads."* That runtime guard is a symptom of a shape that permits an invalid state; the nesting above makes
it unrepresentable and the assert unnecessary. It is the same flag-plus-value pattern that produced
`permanent` + `timeframe: 0`.

Keep `freeGeneration` expressible as a distinct case (generation has three states: charged, free, or
trial-limited), validate with zod at the boundary as today, and bump `termsVersion` when the shape changes so
readers can migrate rather than guess.

**Escape hatches if a term later needs to be queried:** add a jsonb expression index
(`(terms->'download'->>'price')`), or promote that one field to a column. Neither is blocked by starting in
JSON — so "we might want to filter by price someday" is not a reason to add columns now.

### Download and generation are separate grants

`EntityAccessPermission` is a bitmask — `EarlyAccessGeneration = 1`, `EarlyAccessDownload = 2` — so purchases
are already tracked per-grant. `terms` should mirror that structure rather than collapse it, so the config and
the entitlement agree on what was sold.

### "Donation goal" is the wrong noun — it is an *end condition*

**Reframe (2026-07-24).** A donation goal is not a payment term and not really a fundraiser. It is a
**second way for a paid-access sale to end** — a *threshold* end, the sibling of the *date* end (`endsAt`).
`donation-goal.service.ts` proves it: when `total >= goalAmount` it runs the same "sale is over" mutation as the
timer. It just wears a public presentation (title, description, progress bar) that hides the mechanic.

So the real model is: **a paid-access sale ends by zero or more end conditions; it ends when the first one
fires.**

| Sale ends by | Encoding | Notes |
| --- | --- | --- |
| never (permanent) | no end conditions | |
| a date | `endsAt` | self-evaluating |
| a threshold | a threshold condition (target + a running total) | event-driven |
| date **or** threshold | both present | earliest wins — a creator will want this |

This subsumes today's donation goal and opens exactly the cases you flagged: "sell for 7 days", "sell until 100
buyers", "sell for 7 days *or* until 100 buyers, whichever first".

#### The one hard asymmetry — do not paper over it

**Date conditions are static; threshold conditions are stateful.** `now() < endsAt` needs nothing but the row.
A threshold needs a *running total* that lives elsewhere and an *event* that fires termination when it is
crossed — which is why the current donation-goal path has to actively flip state on completion, and a pure
timer does not. Treating a threshold as "just another end date" would hide that it needs a counter and an
updater.

The read path stays cheap anyway, because the threshold **materializes** into `endsAt` when it fires:

- **gate read (the paywall, the ~37 sites):** `active = row exists AND (endsAt IS NULL OR now() < endsAt)`.
  Permanent and threshold-pending both present as "active, no end date" — which is *correct*; the gate does not
  need to know *why* it is active.
- **the updater** watches rows that have a threshold condition and sets `endsAt = now()` when the total crosses.
- **config / display** distinguishes the kinds by *which conditions exist* (a date, a threshold, both, or
  neither), never by overloading `endsAt`.

So `endsAt IS NULL` meaning both "permanent" and "threshold-pending" is fine here — unlike today's NULL
overload, both of those states are genuinely *active*, so the gate treats them identically.

#### Separate the mechanic from the presentation

"Donation goal" bundles a threshold end-condition with a public fundraising skin. Those are two things:

- **end condition** — a threshold on a metric that terminates the sale. Belongs to the sale.
- **goal presentation** — title, description, progress bar, the "help me reach X" framing. Optional.

Decoupling them lets a creator run a private "sell 100 then stop" with no fundraiser UI, *and* lets a public
goal exist without necessarily gating access. `DonationGoal` is already a real entity that points at the version
(`modelVersionId`); the only hack is the redundant **back-link** (`donationGoalId` in jsonb) — drop it, and let
the threshold end-condition be discovered by the forward FK. The goal presentation *points at* the sale; the
sale does not name the goal.

#### Scope

This is a **product expansion**, not part of shipping permanent access. Record it as the conceptual target so
the `PaidAccess` shape does not foreclose it:

- keep `endsAt` as the materialized effective-end (works for permanent, date, and fired-threshold);
- model end conditions explicitly rather than a single `donationGoalId` — even if v1 only implements
  `date` + the existing donation-goal threshold, the shape should read as "a sale with end conditions";
- do **not** build generic threshold sales as part of the current refactor unless asked — it needs the counter,
  the updater, and the materialization path, and touches the purchase/entitlement side.

### `endsAt` is authoritative, not derived — a donation goal can end the sale early

**Correction to an earlier draft.** A completed donation goal *terminates* paid access:
`donation-goal.service.ts` runs the same mutation as the expiry job when `goal.total >= goal.goalAmount`. So
the window has **two** ways to end — the timer, and the goal being met.

Consequences:

- `endsAt` cannot be modelled as "anchor + duration"; it is the source of truth and may be **moved earlier**
  by goal completion. Storing it (rather than deriving it) is therefore required, not merely convenient.
- **The anchor (`ModelVersion.initialPublishedAt`) is write-once; `endsAt` is mutable** — changed by the creator
  editing the duration, or by goal completion.
- The cache-invalidation sweeper must handle **both** termination paths, not just the timer.
- Donation goals are frozen once published (enforced in `mergeEarlyAccessConfig`), so goal edits and access
  edits have different rules and should not share a validation path.

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

**Why a separate anchor (`initialPublishedAt`), not `publishedAt`:** the platform **rewrites `publishedAt`** (the
expiry job re-dates lapsed versions to `NOW()` so they resurface as "New" — see
[traps](#reference--how-access-state-works-today)). Computing anything from it would shift on its own, before any
user tried to game it. A write-once `initialPublishedAt` on the entity mirrors nothing, so unpublish/republish
cannot move the gate — and because it never changes, the end can be computed **once at publish** and stored,
which is what removes the trigger (the trigger only exists to recompute against a *moving* anchor).

**Why `endsAt` is stored (materialized), not derived from a duration:** it is the source of truth for when the
sale ends, with two independent writers — the creator editing the duration, and a goal completing early. A
threshold end has no duration to write; it produces a concrete timestamp, so `endsAt` is the field it fires
into. Storing the materialized end also keeps the **shared** read path from needing each entity's anchor (see
the unified-paywall section) — the decisive reason to store `endsAt` rather than a duration. Duration for
display is `endsAt - initialPublishedAt`.

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
| 1 | Sweep reads onto `@civitai/buzz/paid-access` | Prereq for everything; no schema change. Inventory in [paid-access-query-sites.md](paid-access-query-sites.md) |
| 2 | Add `ModelVersion.initialPublishedAt` (write-once); retire `earlyAccessTimeFrame` | Stable anchor kills the `publishedAt`-rewrite trap and the trigger's reason to exist; one duration source |
| 3 | Create polymorphic `PaidAccess` (+ `ownerId`), dual-write, backfill | Backfill is derivational; **0 permanent rows in prod today**, so only timed rows convert |
| 4 | Move reads onto the shared `resolveAccess`; compute `endsAt` in the service, drop the trigger | Trigger logic → service, testable in CI |
| 5 | Extract per-entity adapters; migrate `ComicChapter` onto the shared core | The payoff for going polymorphic; comics gets shared fixes + promotions for free (permanent NOT added to comics now) |
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

## Caching `getPaidAccess`

**Use the existing batch primitive.** `createCachedObject` (`src/server/utils/cache-helpers.ts`) is a
per-key, batch-fill cache: give it `lookupFn(ids)` + `idKey` and it returns a map, hitting the DB only for
misses. `resource-data.redis.ts` already uses it. `getPaidAccess` is a new `createCachedObject` keyed by a
synthetic `"${entityType}:${entityId}"` (createCachedObject keys on one stringified field), which lets models
and comics share one cache namespace.

**Design for multi-entity; single is a one-key call.** The hot paths are batched:

- **generation** resolves *all* a request's resources at once (`getEntityAccess([...resources, ...substitutes])`);
- **feeds / lists** render N entities.
- the **detail page** is the only true single — a one-element call.

So the signature is `getPaidAccess(keys: {entityType, entityId}[]) -> Map`. `resolveAccess` batch-fetches
`PaidAccess` config for N entities and `EntityAccess` entitlements for N, then zips them.

**The rule that makes a money-gate cache safe: cache the row, not the verdict.** Store the `PaidAccess` row
(`endsAt`, `terms`, `ownerId`) and compute `isPaidAccessActive(row, now())` **at read time**. Because `endsAt`
is materialized, active-ness is derived live from the cached inputs. Consequences:

- the cache **never goes stale on expiry** — time passing is *not* an invalidation event;
- invalidate only on **config change**: creator edit · threshold firing (writes `endsAt`) · creator removal ·
  entity delete.

This is the same reason a materialized view was rejected (an MV caches the *derived* state, stale the instant
the window passes) — here we cache the *inputs* and derive live. It also fixes a hidden coupling in the current
cache: `resource-data.redis.ts:34` bakes `earlyAccessEndsAt >= NOW()` **into the cached value at build time**,
so its answer is only correct until the expiry job busts the key — i.e. the job is doubling as the
cache-invalidation event. Caching the raw row removes that dependence, one less reason the job must exist.

```text
getPaidAccess(keys[])  -> Map<"type:id", PaidAccessRow>   -- createCachedObject, batch, per-key TTL
resolveAccess(...)     -> isPaidAccessActive(row, now())  -- derived live, never cached
invalidate on:         edit · threshold-fires · remove · entity-delete   (NOT time)
```

### `getPaidAccess` decorates; a DB predicate filters

The accessor answers *"for these ids I already have, what is the access state?"* — it **decorates a bounded
set**. That is the hot path (feed, generation, cards): fetch the entity (its own cache) + `getPaidAccess`
(this cache) + zip. No join, and the two caches invalidate independently.

A **DB-side predicate** (`paidAccessSql()` → `JOIN` / `EXISTS` / `IN`) is required *only* when access state
participates in **selecting, ordering, or counting** rows — those must run in the DB to be correct:

- **Filtered pagination** — `WHERE (gated|not) … LIMIT/OFFSET`. You cannot page in the DB then drop gated rows
  in app code: the page shrinks and the counts lie.
- **Sort by access state** — order by `endsAt` ("ending soon") *before* `LIMIT`.
- **Aggregation / counts** — the owner cap count (a standalone `PaidAccess` query on the `ownerId` index — no
  join), paid-vs-free analytics.
- **PaidAccess-as-driver** — the expiry cron scans `endsAt <= now` to *find* entities; there are no ids to hand
  the accessor yet.
- **`EXISTS` in a larger entity query** — "does this model have *any* gated version", pushed down instead of
  loading every version to check in app.

**Rule: decorate known ids → `getPaidAccess`; select / sort / count by access state → `paidAccessSql`.** The
two do not compete — the predicate cases are exactly the dynamic, query-specific result sets a per-entity cache
cannot serve anyway, so joining there does not defeat the cache.

**The trap:** never use `getPaidAccess` to post-filter a paginated feed (fetch page → drop gated → return a
short page). The moment access state changes *which* or *how many* rows, it must be a DB predicate. Per-site
tagging (D = decorate, P = predicate) is in [paid-access-query-sites.md](paid-access-query-sites.md).

---

## References

- Concrete schema (table diffs + `terms` type) — [paid-access-schema.md](paid-access-schema.md)
- Canonical read helper — `packages/civitai-buzz/src/paid-access.ts`
  (+ `src/shared/utils/__tests__/paid-access.test.ts`)
- Fee ratio helper — `packages/civitai-buzz/src/licensing-fee.ts`
- Permanent / early-access caps — `packages/civitai-buzz/src/early-access.ts`
- Studio access filter + badge fix (the NULL-end-date trap) — commit `3c85f898df`
- Studio early-access quantity cap (was missing) — commit `909b8347b2`
- Permanent trigger + column — `prisma/migrations/20260721120000_early_access_permanent/`
