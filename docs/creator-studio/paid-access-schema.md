# PaidAccess — concrete schema plan

The database changes for the paid-access refactor. Reasoning and staging live in
[onsite-monetization-parity.md](onsite-monetization-parity.md); this doc is just the shapes, shown as diffs.

Schema file: `packages/civitai-db-schema/prisma/schema.prisma`.

## Decisions baked into this schema (2026-07-24)

- **No feature flag** — permanent access releases with Creator Studio.
- **Comics: timed early access only for now** — no permanent access, so the Comics adapter offers no permanent
  cap. Comics migration onto `PaidAccess` is a later stage.
- **Promotions are deferred** (see Deferred section) — not in the initial schema. When built, they'll be a
  discoverable `Promotion` table (a "browse deals" surface needs the sale window queryable across entities),
  not `terms` jsonb. Until then, pricing is `terms` standard prices only.
- **`trialLimit` is a real, functional mode** — free preview generations before purchase.
- **Explicit `kind` discriminator** (`Timed | Permanent`) instead of inferring the mode from `endsAt`
  nullability — each mode's shape is self-describing and `endsAt IS NULL` unambiguously means permanent.
- **`download.price ≥ generation.price`** — download is the superset tier (buying it grants generation too).
  Prod bears this out: of 281 active dual-charge versions, 226 price download higher, 55 equal, **0** lower.
  Enforced in `terms` validation (§7), and it is what makes upgrade proration well-defined (§4).

---

## 1. New: `PaidAccess` (+ its enum)

```diff
+ enum PaidAccessEntityType {
+   ModelVersion
+   ComicChapter
+ }
+
+ enum PaidAccessKind {
+   Timed        // window with an end date; a donation goal can overwrite it to end early
+   Permanent    // never expires — endsAt is always NULL
+ }
+
+ model PaidAccess {
+   entityType   PaidAccessEntityType
+   entityId     Int
+   ownerId      Int            // denormalized at write — owner-scoped cap counts without a polymorphic join
+   kind         PaidAccessKind // the discriminator the gate branches on
+   endsAt       DateTime?      // MATERIALIZED end for Timed; always NULL for Permanent. Invariant: endsAt IS NULL ⟺ kind = Permanent
+   termsVersion Int            @default(1)
+   terms        Json           // PaidAccessTerms — see §7
+   createdAt    DateTime       @default(now())
+   updatedAt    DateTime       @updatedAt
+
+   @@id([entityType, entityId])                 // one gate per entity
+   @@index([ownerId, entityType, endsAt])       // owner-scoped range/active queries; the permanent cap count uses a partial index (see below)
+ }
```

- **Row exists ⇒ gated.** No row ⇒ free.
- **The gate branches on `kind` + `endsAt`:** active ⇔ `kind = 'Permanent' OR endsAt > now()`. `kind` is the
  explicit discriminator (no NULL-overload); `endsAt` is materialized (a date up front, or a threshold
  overwriting it to `now()` to end early). A `Timed` row always has a date; a `Permanent` row always has
  `NULL` — so `endsAt IS NULL ⟺ Permanent`, cleanly.
- **`ownerId`** is stamped at write (same pattern as licensing-fee owner-stamping / `reactions.ownerId`) so the
  per-`ownerId`, per-`entityType` cap counts need no join to the entity.
- No `donationGoalId`, no `anchorAt` — see §3 and §4.
- **Read through the accessor, not ad-hoc joins.** `getPaidAccess(entityType, entityIds)` (cached, batch) to
  *decorate* known ids on hot paths; `paidAccessSql()` *only* to filter/sort/count in-query. See
  [caching `getPaidAccess`](onsite-monetization-parity.md#caching-getpaidaccess).
- **Cap-count index is partial, keyed on `kind`.** The tier cap counts an owner's *permanent* rows, so the
  tightest index is `(ownerId, entityType) WHERE kind = 'Permanent'` — created via **raw SQL** (Prisma can't
  express a partial index in-schema). The general `@@index([ownerId, entityType, endsAt])` above stays for
  owner-scoped *range* queries (active / ending-soon): `endsAt` is the right key there because it answers the
  count via `IS NULL` **and** supports ranges, which `kind` as an ordinary key cannot. So `kind` is the
  partial-index *predicate*, not a key column.

## 2. `ModelVersion` — add the anchor, retire the tangle

```diff
  model ModelVersion {
    // …
    availability         Availability @default(Public)   // KEEP — visibility only (stop writing payment into it: stage 6)
+   initialPublishedAt   DateTime?                        // write-once anchor; set on first publish, never rewritten
-   earlyAccessEndsAt    DateTime?                        // → PaidAccess.endsAt
-   earlyAccessConfig    Json?                            // → PaidAccess.terms (+ the DonationGoal back-link is dropped)
-   earlyAccessPermanent Boolean      @default(false)     // → PaidAccess.kind = Permanent (endsAt NULL)
-   earlyAccessTimeFrame Int          @default(0)         // DELETE — duplicate duration, unused after migration
  }
```

**Staging matters here.** `initialPublishedAt` is added *first* (stage 2). The four removals happen *last*
(after `PaidAccess` is backfilled and the [read-site sweep](paid-access-query-sites.md) is done) — until then
they're dual-maintained. The diff shows the end state, not a single migration.

`initialPublishedAt` also fixes a standalone bug: the expiry job rewrites `publishedAt` to resurface lapsed
versions as "New", and stashes `originalPublishedAt` in the jsonb to compensate. A stable anchor replaces that
hack — and because it never moves, the end can be computed once at publish and stored, which is what lets the
trigger go away.

## 3. `DonationGoal` — unchanged (the fix is a deletion elsewhere)

```diff
  model DonationGoal {
    // … unchanged …
    modelVersionId Int?          // forward FK to the version — this is the real, kept link
  }
```

Nothing changes on `DonationGoal`. The hack was the **back-link** (`earlyAccessConfig.donationGoalId`), which
disappears when `earlyAccessConfig` is removed above. "The goal for this sale" becomes the forward query
`DonationGoal WHERE modelVersionId = ? AND isEarlyAccess AND active`. A completed goal writes
`PaidAccess.endsAt = now()` (the threshold materializing).

**Why it stays a first-class entity, not a facet of `PaidAccess` (empirical, prod 2026-07-24).** A goal is
funded by two paths into one pot: an early-access *purchase* (records a `Donation` for the price + grants
`EntityAccess`) and a standalone *donation* (`donationGoal.donate` — records a `Donation`, grants nothing).
Of **84,539** users who ever contributed, **77.5% donated without ever purchasing** (65,515 donate-only;
9,403 both; 9,621 purchase-only) — and pure donations are ~84% of contributions by count. So `DonationGoal`
is predominantly a **crowdfunding ledger in its own right**, whose *only* tie to the gate is the single
`endsAt = now()` write when `SUM(amount) ≥ goalAmount`. Folding it into `PaidAccess` would model the majority
behavior (pure crowdfunding by non-buyers) as a footnote of the minority (purchase) — hence the separate
table with a one-way completion write.

## 4. `EntityAccess` — unchanged (already polymorphic)

```diff
  model EntityAccess {
    // … unchanged …
    accessToType String     // already polymorphic — the purchase side needs nothing
    permissions  Int        // bitmask: EarlyAccessGeneration=1, EarlyAccessDownload=2
  }
```

This is why the refactor is smaller than it looks: the *purchase* side is already entity-agnostic. `PaidAccess`
is the *config* side finally matching it. `resolveAccess` joins the two.

### Upgrade proration (generation → download)

`download` is a superset of `generation` (buying it grants both) and `download.price ≥ generation.price`
(§7 invariant). So a user who already bought generation should pay only the **difference** to upgrade, not
full download price. Today's code charges **full** `downloadPrice` on that path
([model-version.service.ts:1832](../../src/server/services/model-version.service.ts)) — a buyer's-regret
penalty. Proration removes it, needing no stored amount — the user's existing `EarlyAccessGeneration` bit is the only
state:

- upgrade charge = `max(0, downloadPrice − generationPrice)` — the tier gap, read from `terms`.

So generation costs `generationPrice`, the upgrade costs the gap, and the total is exactly `downloadPrice` —
the two paths (generation-then-upgrade vs download outright) cost the same. `download.price ≥ generation.price`
(§7) keeps the gap ≥ 0; `max(0, …)` is a guard. One-directional only — buying `generation` after `download` is
already blocked (download bit set).

**When promotions ship (deferred — see Deferred section)** this gains a wrinkle: crediting the generation *list* price rather
than a discounted price paid would let a generation-sale buyer carry their saving into the upgrade. That
refinement is deferred with promotions; on standard prices the upgrade total is simply `downloadPrice`.

## 5. `ComicChapter` — later (stage 5), timed-only

```diff
  model ComicChapter {
    // …  PK is @@id([projectId, position]) — but PaidAccess.entityId uses the stable `id` (@unique), not position
    availability      Availability @default(Public)
+   initialPublishedAt DateTime?                    // REQUIRED write-once anchor — set only when NULL (publishedAt is not stable; see below)
-   earlyAccessEndsAt DateTime?                     // → PaidAccess.endsAt
-   earlyAccessConfig Json?                         // → PaidAccess.terms
    // ComicChapter has no earlyAccessPermanent and gains none — comics stays timed-only
  }
```

**Investigated (2026-07-24) — comics *can* adopt the shared timed path, but `publishedAt` cannot be the
anchor.** Findings:

- **`ComicChapter.publishedAt` is not write-once.** `publishChapter`
  ([comics.router.ts:4773](../../src/server/routers/comics.router.ts)) sets `publishedAt = now()` on *every*
  publish, and a normal `unpublishChapter` leaves the old value — so a Draft→republish round-trip overwrites it
  and **restarts the early-access clock**. (Reordering is safe — position-only, `publishedAt` untouched.) So
  comics needs a genuine write-once `initialPublishedAt`, set only when `NULL` (the pattern the code already
  uses for `ComicProject.publishedAt`). This is *required*, not "if".
- **EA is already duration-from-publish, and already trigger-driven.** A DB trigger
  (`comic_chapter_early_access`) recomputes `earlyAccessEndsAt = publishedAt + timeframe`. So comics has the
  *same* trigger-to-materialized-`endsAt` shape as models — stage 5 drops this trigger too, the same way.
- **No baggage to untangle** — comics has **no** resurface hack (nothing rewrites `publishedAt` on expiry, no
  `process-ending-early-access` branch), no `original*` fields, and no permanent access. So the anchor is a
  clean, low-conflict addition; comics is actually *tidier* to migrate than models.
- **Key on `id`, not the PK.** The PK is `[projectId, position]` (mutable position); `PaidAccess.entityId`
  must use `ComicChapter.id` (`@unique`, stable).

Comics keeps **timed early access only**; its adapter exposes no permanent cap.

---

## 6. Current `earlyAccessConfig` → where each field goes

The blob being retired. Source of truth: `modelVersionEarlyAccessConfigSchema`
(`src/server/schema/model-version.schema.ts`). Twelve fields spanning three concerns — **timing**,
**pricing**, **donation** — which the new schema splits across a column, the `terms` jsonb, and rows that
already exist. This table is the migration contract: every field has a destination or an explicit reason it
is dropped.

```typescript
// current shape — z.infer<typeof modelVersionEarlyAccessConfigSchema>
{
  timeframe: number;              // EA duration (days); 0 = permanent
  permanent: boolean;             // never-expires gate (CP-member only)
  chargeForDownload: boolean;
  downloadPrice?: number;         // min 100
  chargeForGeneration: boolean;
  generationPrice?: number;       // min 50
  generationTrialLimit: number;   // max 1000, default 10
  donationGoalEnabled: boolean;
  donationGoal?: number;
  donationGoalId?: number;
  originalPublishedAt?: Date;
  freeGeneration?: boolean;
}
```

| Field | New home | Note |
| --- | --- | --- |
| `timeframe` | consumed → `kind` + `PaidAccess.endsAt` | `> 0` → `kind = Timed`, `endsAt = initialPublishedAt + timeframe` (not stored; form re-derives "N days" from `endsAt − initialPublishedAt`). `0` → `kind = Permanent`, `endsAt NULL`. |
| `permanent` | `PaidAccess.kind = Permanent` | (⟺ `endsAt IS NULL`). No boolean column. |
| `chargeForDownload` | `terms.download` present | today: enables a download purchase; not redundant — see gating note. New model: a `download` grant means download is paid. |
| `downloadPrice` | `terms.download.price` | `min(100)` floor kept in §7 validation. |
| `chargeForGeneration` | `terms.generation` present | today: enables a generation-only purchase tier. New model: a `generation` grant means generation is paid. |
| `generationPrice` | `terms.generation.price` | `min(50)` floor kept. |
| `generationTrialLimit` | `terms.generation.trialLimit` | default 10, `max(1000)` kept. |
| `donationGoalEnabled` | `DonationGoal` row exists | already modeled — `DonationGoal.modelVersionId` forward FK (§3), `isEarlyAccess`/`active` flags. Not in `PaidAccess`. |
| `donationGoal` | `DonationGoal.goalAmount` | lives on the goal row, not the gate. |
| `donationGoalId` | **dropped** | the back-link hack (§3); the forward FK replaces it. |
| `originalPublishedAt` | `ModelVersion.initialPublishedAt` | the compensation-hack field the anchor was built to kill (§2). |
| `freeGeneration` | **dropped** | subsumed by grant independence — no `generation` grant already means generation is free. |

**Old model gated on the window; new model gates on the grant — and grants are independent.** In the
current schema, being in the early-access window is what gates access: download is gated whenever in-EA
([file.service.ts:270](../../src/server/services/file.service.ts)), generation whenever in-EA and not
`freeGeneration` ([mini/[id].ts:134](../../src/pages/api/v1/model-versions/mini/[id].ts)). The
`chargeFor*`/`*Price` fields are **not** the gate — they only define *purchase tiers*, and today a `download`
purchase grants **both** permissions (the bundle,
[model-version.service.ts:1861](../../src/server/services/model-version.service.ts)). The new model drops
this: **a `download` grant gates only download, a `generation` grant gates only generation, absence of a
grant means that action is free.** Setting a download price says nothing about generation — you set a
generation price (grant) if and only if you want generation paid.

**The one migration decision this forces (verified against prod 2026-07-24).** Of **453** currently-active
early-access versions: **279** charge for both, **173** charge download only, **1** generation only;
**0** are permanent, `freeGeneration`, or timeframe-0. The **173 download-only** rows are the catch — today
their generation is gated (reachable only by buying the download bundle); under independent grants they have
no `generation` grant, so **generation would become free** on those 173 live versions. The backfill must
choose deliberately, not silently:

- **(a) preserve current gating** — materialize `generation: { price: downloadPrice }` for the 173, so paying
  to generate is still required; or
- **(b) adopt the clean model** — leave generation ungated (free) on them, matching the new independent
  semantics going forward.

**Decided: (a)** for the existing 173 — don't silently un-gate live paid content — with **(b) as the
go-forward default** for new setups. The backfill (Part 1, Migration §) materializes the `generation` grant for
those 173. The single generation-only row and the (empty) permanent/`freeGeneration` sets need no special
handling.

**Donation goals stay normalized, but they *are* a paid-access end-condition.** The `donationGoal*` fields
move onto / stay on the `DonationGoal` row (its own entity, with `paidAmount`/`donations` progress) rather
than into `terms` — but "not in `PaidAccess`" means the goal's *data* isn't duplicated there, **not** that
goals are unrelated to the gate. Functionally the goal is one of the three ways `PaidAccess.endsAt` is set:
reaching it writes `endsAt = now()` — the threshold materializing (§1, §3), the same column a fixed date or
`NULL`/permanent would occupy. The link is the forward FK `DonationGoal.modelVersionId` (no `donationGoalId`
back-link on `PaidAccess`).

**The three timing fields leave the jsonb entirely.** `timeframe`, `permanent`, and `originalPublishedAt`
all migrate to columns: duration materializes into `kind`/`endsAt`, permanent becomes `kind = Permanent`, and
the publish-rewrite compensation becomes the write-once `initialPublishedAt` (§2). That is the point of the
split — nothing in `terms` is ever about *when*.

---

## 7. `PaidAccess.terms` — the TypeScript type

`terms` is *what is purchasable* — the **standard prices**. Its **shape varies by the row's `entityType`** (a
`ModelVersion` has download/generation grants; a `ComicChapter` has one `access` grant), parsed by
`parseTerms(entityType, …)` (§8). For a model, a grant's absence means that action is free; a comic always
carries its single `access` grant. Nothing about *when* the gate ends lives here (that's `endsAt`), *who owns
it* (`ownerId`), or **time-boxed discounts** (promotions are **deferred** — see the Deferred section — so for
now `terms` is the whole pricing story).

```typescript
/**
 * PaidAccess.terms — shape varies by PaidAccess.entityType; parsed via parseTerms (§8).
 * Versioned by PaidAccess.termsVersion.
 */
export type PaidAccessTerms = ModelVersionTerms | ComicChapterTerms;

/** ModelVersion — two tiered grants. At least one present; a grant's absence ⇒ that action is free. */
export type ModelVersionTerms = {
  /** Paid download. Omit → downloads are free. */
  download?: Grant;
  /** Paid generation. Omit → generation is free. */
  generation?: GenerationGrant;
};

/** ComicChapter — one grant: unlock/read the chapter. Always present (a gated chapter has a price). */
export type ComicChapterTerms = {
  access: Grant;
};

export type Grant = {
  /** Standard price, in Buzz. (Time-boxed discounts / promotions are deferred — Deferred section.) */
  price: number;
};

export type GenerationGrant = Grant & {
  /**
   * Free preview generations before purchase is required (functional — meters per user).
   * Omit or 0 → no free trials. ModelVersion-only.
   */
  trialLimit?: number;
};
```

**Validation (zod at the write boundary):**

- **ModelVersion:** at least one of `download` / `generation` present; `download.price ≥ 100`,
  `generation.price ≥ 50` (today's `MIN_*` floors); if both present, **`download.price ≥ generation.price`**
  (superset tier — enables proration, §4); `trialLimit ≤ 1000`.
- **ComicChapter:** `access` present; `access.price` in `100..10000` (today's `buzzPrice` bounds).

**Effective price (read side).** With promotions deferred (Deferred section), the effective price is simply the
standard price: `const effectivePrice = grant.price;`. When promotions ship, this becomes
`activePromotion?.price ?? grant.price` (the promo read via `getPromotions`).

**Example rows:**

```jsonc
// ModelVersion — download 5000, generation 2500 w/ 10 preview gens
{ "download": { "price": 5000 }, "generation": { "price": 2500, "trialLimit": 10 } }

// ModelVersion — paid download, free generation
{ "download": { "price": 5000 } }

// ComicChapter — unlock the chapter for 500
{ "access": { "price": 500 } }
```

---

## 8. `termsVersion` — how it works, and why it's here

`termsVersion` is a **per-row stamp of which shape the `terms` blob was written in**. Rows written at different
times can legitimately hold different shapes; the stamp is what lets you read old rows correctly and migrate
them deliberately instead of guessing.

```text
termsVersion | terms
     1       | { "download": { "price": 5000 } }
     2       | { "grants": { "download": { "price": 5000, "currency": "buzz" } } }   -- hypothetical restructure
```

- **Reads dispatch on `(entityType, version)`** — the shape varies by both (§7): `entityType` picks the grant
  vocabulary, `version` picks the shape within it. One parser per pair, normalizing to the current in-memory
  `PaidAccessTerms`:

  ```typescript
  const CURRENT_TERMS_VERSION = 1;

  function parseTerms(entityType: PaidAccessEntityType, version: number, raw: unknown): PaidAccessTerms {
    switch (entityType) {
      case 'ModelVersion': return parseModelVersionTerms(version, raw); // v1 → { download?, generation? }
      case 'ComicChapter': return parseComicChapterTerms(version, raw); // v1 → { access }
    }
  }
  ```

- **Writes always emit `CURRENT_TERMS_VERSION`** in the current shape, so old versions only ever shrink.
- **Migration is then tractable:** `WHERE termsVersion < N` finds exactly the rows still on an old shape —
  lazily (upgrade on next write until the count hits zero, then delete the old parser) or via a backfill job.
  The column being *queryable* is the payoff; without it you would have to content-sniff the jsonb to guess.

**Why it's here:** `earlyAccessConfig` is the cautionary tale — unversioned jsonb that accreted `permanent`,
`donationGoalId`, `originalPublishedAt`, `originalTimeframe`… and now nobody can tell what shape a given row is
in or safely remove a field. `termsVersion` is the direct lesson.

**Honest caveat — it only earns its keep on *breaking* changes** (rename, restructure, changed meaning). A
purely **additive** change (a new *optional* field) needs no version bump: old rows simply lack the field and
readers default it. So if `terms` only ever grows optional fields, `termsVersion` never does anything.

**Recommendation:** keep it, default `1`, and build **no** version machinery until the first breaking change —
it costs one integer column and a `CURRENT_TERMS_VERSION` constant now, and buys a clean migration the day the
blob has to be reshaped. Given this whole refactor exists *because* an unversioned jsonb became untrackable,
that is cheap insurance — but if `terms` stays additive-only, it is droppable dead weight.

---

## Migration — two-part expand/contract

Shipped in two independently-deployable parts. **Part 1 is additive and fully reversible; Part 2 is the
destructive cleanup**, run only after Part 1 has soaked in production. Migrations are applied by hand here, so
Part 2's drops are hand-run SQL (preview → staging → prod).

### Part 1 — expand (additive, reversible)

1. **Create** `PaidAccess` (+ `PaidAccessKind` / `PaidAccessEntityType` enums), and add `initialPublishedAt` to
   `ModelVersion` (and to `ComicChapter` at its stage-5 turn). All additive — no existing column is touched.
2. **Backfill** `PaidAccess` + `initialPublishedAt` from the current early-access columns. Prod has **0**
   permanent rows, so every backfilled row is `kind = Timed`. The **173 download-only versions** get a
   materialized `generation` grant (decision **(a)**, §6); everything else maps mechanically (§6 table).
3. **Dual-write** — keep writing the old columns *and* `PaidAccess`. This is what makes Part 1 reversible (old
   readers still work; roll back with no data loss) and keeps both stores consistent while both exist. The
   existing DB trigger keeps maintaining `earlyAccessEndsAt`; `PaidAccess.endsAt` is materialized alongside.
4. **Switch reads** to the helper — `getPaidAccess` (decorate) / `paidAccessSql` (predicate) — across the
   [~37 sweep sites](paid-access-query-sites.md).

Deploy. Old columns stay intact and maintained, so Part 1 ships on its own and is fully back-outable. Let it
soak; confirm nothing reads the old columns before proceeding.

### Part 2 — contract (destructive, after soak)

1. **Stop dual-writing** the old columns.
2. **Drop** the deprecated columns — `earlyAccessEndsAt`, `earlyAccessConfig`, `earlyAccessPermanent`,
   `earlyAccessTimeFrame` on `ModelVersion` (and `earlyAccessEndsAt` / `earlyAccessConfig` on `ComicChapter` at
   stage 5).
3. **Drop the DB trigger(s)** (`early_access_ends_at`, `comic_chapter_early_access`) — `endsAt` is now
   materialized at write from `initialPublishedAt`, so the trigger is redundant.
4. **Retarget the expiry job** (`process-ending-early-access`) to cache/search invalidation only; its
   `publishedAt`-rewrite hack goes away (`initialPublishedAt` is the stable anchor).

`Availability.EarlyAccess` retirement is a **separate, later** project (~213 refs) — not part of either part.
Broader program-level staging lives in [onsite-monetization-parity.md](onsite-monetization-parity.md).

## Open (not blocking this schema)

- **Cross-type permanent budget** (policy, not index) — the cap-count index is settled (partial, on `kind` —
  §1). The open part is a product call: is the permanent allowance **per entity type** or **combined across
  types**? Moot until a second type gets permanent access (comics is timed-only). Default: per-type.

---

## Deferred

Intentionally postponed — **not part of the initial schema**, captured here so they're ready when picked up.

### Promotions — time-boxed discounts

> **⏸ Deferred.** The initial paid-access release has **standard prices only** (no sales/discounts). The design
> below is captured for when we pick it up; nothing here is built now, and `terms` carries no discount data in
> the meantime.

When built, promotions go in their **own table** for one reason: **discoverability.** A "browse deals" surface
must answer *"what is discounted right now?"* across all entities — a range query on the sale window — and a
jsonb array buried in `terms` cannot be indexed for that. Per-entity reads (rendering one entity's price) would
use a `getPromotions` accessor, exactly the
[decorate-vs-predicate](onsite-monetization-parity.md#caching-getpaidaccess) split as `PaidAccess`.

**Creator requirements (Discord, 2026-07-24) — build to these, they expand the sketch below.**

- **Item-level, not per-grant.** Creators don't want separate download vs generation sale prices; one discount
  applies to the whole item. (The one exception raised — making an item *free* for an event — is still
  item-level: a 100% discount.) → the drafted per-`grant` column below is likely wrong; a discount scales the
  item's grants together.
- **Percentage discounts** (flat optional) — the timed tiers below are naturally "X% off."
- **Two scopes:** *individual item* (entity-scoped) **and** *store-wide* (owner-scoped — one discount across
  all of a creator's items). → the model needs an `ownerId`-scoped variant, not only `(entityType, entityId)`.
- **Age-based auto-pricing rules — the standout ask.** Creator-defined tiers that discount by content *age*,
  applied per item: e.g. "after 1 month → 20% off, after 3 months → 50% off." Goal: auto-depreciate older
  content without micro-managing ("older things should be cheaper than new"); framed equally as "auto-updating
  prices." This is a *rule* (age → discount), distinct from a fixed-window promo, and it's the **strongest
  validation yet for keeping `initialPublishedAt`** — age = `now − initialPublishedAt` is exactly its basis.

So the eventual system is bigger than a fixed-window table: (a) item + store-wide scopes, (b) percentage
discounts, (c) age-relative auto-pricing rules keyed off `initialPublishedAt`. The sketch below is only the
per-entity fixed-window piece — a starting point these requirements revise.

```diff
+ enum PaidAccessGrant {
+   Download
+   Generation
+ }
+
+ model Promotion {
+   id         Int                  @id @default(autoincrement())
+   entityType PaidAccessEntityType
+   entityId   Int
+   grant      PaidAccessGrant      // which grant is discounted
+   price      Int                  // discounted Buzz price for the window; must be < the grant's standard price
+   startsAt   DateTime             // SALE-window start — NOT PaidAccess.endsAt (the gate window)
+   endsAt     DateTime             // SALE-window end   — likewise distinct from the gate's endsAt
+   createdAt  DateTime             @default(now())
+
+   @@unique([entityType, entityId, grant, startsAt])  // decorate lookups + no duplicate window starts
+   @@index([startsAt, endsAt])                          // discovery: "on sale now" (startsAt <= now < endsAt)
+ }
```

- **`grant`** ties the discount to `download` or `generation` (the two `terms` grants); the same `PaidAccessGrant`
  enum can label proration/purchase types too.
- **Naming caution:** `Promotion.startsAt`/`endsAt` are the *sale* window — unrelated to `PaidAccess.endsAt`,
  which is the *gate* window. Same word, different table, different meaning.
- **Discovery query** (the reason it's a table):

  ```sql
  SELECT * FROM "Promotion" WHERE "startsAt" <= now() AND "endsAt" > now();   -- everything on sale, indexable
  ```

**Validation (Promotion write boundary)** — the old `SalePeriod` rules, now on the row:

- `startsAt < endsAt`;
- `price < the grant's standard price` (`terms.<grant>.price`) — a promotion must discount;
- the window lies within the gate's life (a timed offer's sale can't outlast `PaidAccess.endsAt`);
- **no overlapping windows** for the same `(entityType, entityId, grant)` — so "effective price" is unambiguous.
