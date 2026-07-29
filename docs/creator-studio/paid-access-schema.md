# PaidAccess — concrete schema plan

The database changes for the paid-access refactor. Reasoning and staging live in
[onsite-monetization-parity.md](onsite-monetization-parity.md); this doc is the shapes + `terms` semantics, shown
as diffs. **The migration is applied** (see the record in `prisma/migrations/`); the Migration section below is
kept as the design record. For where the code lives now + open items, see
[paid-access-current-state.md](paid-access-current-state.md).

Schema file: `packages/civitai-db-schema/prisma/schema.prisma`.

> **Scope (post-review, 2026-07-24).** This PR is a **behavior-preserving structural migration** — move
> paid-access config off the entity into a `PaidAccess` table, nothing more. Three things were cut to keep it
> that way (Justin's review): no `kind` enum, no `termsVersion`, and **no independent grants** (today's bundle
> semantics are kept). Independent grants, comics-onto-`PaidAccess`, and promotions each become their own later
> PR. The gate that lets Part 2 proceed is literally *"does prod behave identically before and after?"* — which
> is only a real test if this PR changes no behavior.

## Decisions baked into this schema (2026-07-24)

- **No feature flag** — permanent access releases with Creator Studio.
- **No `kind` column** — `endsAt IS NULL` **is** the permanent discriminator (invariant, both directions). A
  `kind` enum would be a *second copy of the same fact that can drift* — exactly the bug we have in prod today
  (`earlyAccessPermanent` column + `earlyAccessConfig.permanent` jsonb, two sources of truth held together by a
  trigger). If a third mode ever appears, the enum is a cheap add then.
- **No `termsVersion`** — the zod boundary at the write path (§7) is the real protection against blob rot;
  versioning is a one-line int column to add the day a *breaking* `terms` change actually lands.
- **Bundle semantics kept; independent grants deferred** — today, buying `download` grants generation too, and
  a version with only a download price still gates generation (via the bundle). This PR preserves that exactly.
  "Price download and generation independently" (where a missing generation price would mean *free*) is a
  product change that moves what live versions cost buyers — it ships as its own PR, with its own decision and
  creator comms.
- **Comics: timed early access only for now** — no permanent access. Comics migration onto `PaidAccess` is a
  later stage; the anchor (below) lands for comics *first*, though.
- **Promotions are deferred — and they're the reason the foundation is worth building now.** They stay out of
  this PR (see Deferred), but each creator ask lands on something this PR creates: **store-wide discounts** need
  the denormalized `ownerId`, **age-based auto-pricing** needs `initialPublishedAt`, and **"browse deals"** needs
  one indexable place prices live. Without `PaidAccess` we'd build most of it anyway, under schedule pressure.
- **`trialLimit` is a real, functional mode** — free preview generations before purchasing the generation tier.
- **`download.price ≥ generation.price`** — download is the superset tier (buying it grants generation).
  Prod: of 281 active dual-charge versions, 226 price download higher, 55 equal, **0** lower. Enforced in
  `terms` validation (§7); it is what makes upgrade proration well-defined (§4).

---

## 1. New: `PaidAccess` (+ its enum)

```diff
+ enum PaidAccessEntityType {
+   ModelVersion
+   ComicChapter
+ }
+
+ model PaidAccess {
+   entityType PaidAccessEntityType
+   entityId   Int
+   ownerId    Int          // denormalized at write — owner-scoped cap counts without a polymorphic join
+   endsAt     DateTime?    // MATERIALIZED end. endsAt IS NULL ⟺ permanent (no window). A threshold overwrites it to now() to end early.
+   terms      Json         // PaidAccessTerms — see §7
+   createdAt  DateTime     @default(now())
+   updatedAt  DateTime     @updatedAt
+
+   @@id([entityType, entityId])                 // one gate per entity
+   @@index([ownerId, entityType, endsAt])       // owner-scoped range/active queries; the permanent cap count uses a partial index (see below)
+ }
```

- **Row exists ⇒ gated.** No row ⇒ free.
- **The gate reads one column, `endsAt`:** active ⇔ `endsAt IS NULL OR endsAt > now()`. `endsAt IS NULL` means
  *permanent* (no window); a date means *timed*; a threshold (donation goal) overwrites it to `now()` to end a
  window early. There is no separate discriminator — a second one could disagree with `endsAt`, which is the
  precise failure mode this refactor exists to remove.
- **`ownerId`** is stamped at write (same pattern as licensing-fee owner-stamping / `reactions.ownerId`) so the
  per-`ownerId`, per-`entityType` cap counts need no join to the entity.
- No `donationGoalId`, no `anchorAt` — see §3 and §4.
- **Read through the accessor, not ad-hoc joins.** `getPaidAccess(entityType, entityIds)` (cached, batch) to
  *decorate* known ids on hot paths; `paidAccessSql()` *only* to filter/sort/count in-query. See
  [caching `getPaidAccess`](onsite-monetization-parity.md#caching-getpaidaccess).
- **Cap-count index is partial.** The tier cap counts an owner's *permanent* rows, so the tightest index is
  `(ownerId, entityType) WHERE "endsAt" IS NULL` — created via **raw SQL** (Prisma can't express a partial index
  in-schema). The general `@@index([ownerId, entityType, endsAt])` above stays for owner-scoped *range* queries
  (active / ending-soon), which `IS NULL` alone can't serve.

## 2. `ModelVersion` — add the anchor, retire the tangle

```diff
  model ModelVersion {
    // …
    availability         Availability @default(Public)   // KEEP — visibility. Its use as the *gate* is retired in Part 1; the enum value drop is a separate dated ticket.
+   initialPublishedAt   DateTime?                        // write-once anchor; set on first publish, never rewritten (Slice 0)
-   earlyAccessEndsAt    DateTime?                        // → PaidAccess.endsAt
-   earlyAccessConfig    Json?                            // → PaidAccess.terms (+ the DonationGoal back-link is dropped)
-   earlyAccessPermanent Boolean      @default(false)     // → PaidAccess.endsAt IS NULL
-   earlyAccessTimeFrame Int          @default(0)         // DELETE — duplicate duration, unused after migration
  }
```

**Staging.** `initialPublishedAt` lands **first**, as its own slice (Slice 0, Migration §) — on `ModelVersion`
*and* `ComicChapter`. The four removals happen **last** (Part 2), after `PaidAccess` is backfilled and the
read-site sweep is done; until then they're dual-maintained. The diff shows the end state, not a single migration.

`initialPublishedAt` fixes a standalone defect on its own: the expiry job rewrites `publishedAt` to resurface
lapsed versions as "New", and stashes `originalPublishedAt` in the jsonb to compensate. A stable, never-moving
anchor replaces that hack — and because it never moves, the end can be computed once at publish and stored,
which is what later lets the trigger go away. This is the highest-value piece of the refactor and it needs no
table, which is why it ships first (Slice 0).

## 3. `DonationGoal` — unchanged (the fix is a deletion elsewhere)

```diff
  model DonationGoal {
    // … unchanged …
    modelVersionId Int?          // forward FK to the version — this is the real, kept link
  }
```

Nothing changes on `DonationGoal`. The hack was the **back-link** (`earlyAccessConfig.donationGoalId`), which
disappears when `earlyAccessConfig` is removed above. "The goal for this sale" becomes the forward query
`DonationGoal WHERE modelVersionId = ? AND isEarlyAccess AND active`.

**Invariant: an early-access `DonationGoal` always has a `PaidAccess` row for its version.** A completed goal
**updates that `PaidAccess` row** — `endsAt = now()` (the threshold materializing, the window closes early).
Critically this is `now()`, **never `NULL`**: `endsAt IS NULL` means *permanent*, so clearing it would flip
"goal met → free" into "permanently paid" (an inversion the safety review caught). Today the completion path
writes the old columns via raw SQL
([donation-goal.service.ts:157](../../src/server/services/donation-goal.service.ts)); it must be an explicit
member of the dual-write set (Migration Part 1 step 3b).

**Why it stays a first-class entity, not a facet of `PaidAccess` (empirical, prod 2026-07-24).** A goal is
funded by two paths into one pot: an early-access *purchase* (records a `Donation` for the price + grants
`EntityAccess`) and a standalone *donation* (`donationGoal.donate` — records a `Donation`, grants nothing).
Of **84,539** users who ever contributed, **77.5% donated without ever purchasing** (65,515 donate-only;
9,403 both; 9,621 purchase-only) — pure donations are ~84% of contributions by count. So `DonationGoal` is
predominantly a **crowdfunding ledger in its own right**, whose *only* tie to the gate is the single
`endsAt = now()` write when `SUM(amount) ≥ goalAmount`. Folding it into `PaidAccess` would model the majority
behavior (pure crowdfunding by non-buyers) as a footnote of the minority (purchase) — hence the separate table
with a one-way completion write.

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
(§7 invariant). So a user who already bought the generation tier should pay only the **difference** to upgrade,
not full download price. Today's code charges **full** `downloadPrice` on that path
([model-version.service.ts:1832](../../src/server/services/model-version.service.ts)) — a buyer's-regret
penalty. Proration removes it, needing no stored amount — the user's existing `EarlyAccessGeneration` bit is the
only state:

- upgrade charge = `max(0, downloadPrice − generationPrice)` — the tier gap, read from `terms`.

So generation costs `generationPrice`, the upgrade costs the gap, total is exactly `downloadPrice` — the two
paths (generation-then-upgrade vs download outright) cost the same. One-directional only — buying `generation`
after `download` is already blocked (download bit set). **Nice-to-have, not a blocker** for this PR; the math
is unchanged by anything else here.

## 5. `ComicChapter` — anchor now (Slice 0), table later (stage 5), timed-only

```diff
  model ComicChapter {
    // …  PK is @@id([projectId, position]) — but PaidAccess.entityId uses the stable `id` (@unique), not position
    availability      Availability @default(Public)
+   initialPublishedAt DateTime?                    // REQUIRED write-once anchor — set only when NULL. Lands in Slice 0 (fixes the republish-clock bug now).
-   earlyAccessEndsAt DateTime?                     // → PaidAccess.endsAt (stage 5)
-   earlyAccessConfig Json?                         // → PaidAccess.terms  (stage 5)
    // ComicChapter has no earlyAccessPermanent and gains none — comics stays timed-only
  }
```

**Investigated (2026-07-24) — comics *can* adopt the shared timed path, but `publishedAt` cannot be the
anchor.** Findings:

- **`ComicChapter.publishedAt` is not write-once.** `publishChapter`
  ([comics.router.ts:4773](../../src/server/routers/comics.router.ts)) sets `publishedAt = now()` on *every*
  publish, and a normal `unpublishChapter` leaves the old value — so a Draft→republish round-trip overwrites it
  and **restarts the early-access clock** (a live bug models don't have). Comics needs a genuine write-once
  `initialPublishedAt`, set only when `NULL` (the pattern `ComicProject.publishedAt` already uses). This is why
  the anchor lands for comics in **Slice 0** — it fixes this bug with **no table**.
- **EA is already duration-from-publish, trigger-driven.** A DB trigger (`comic_chapter_early_access`) recomputes
  `earlyAccessEndsAt = publishedAt + timeframe` — the *same* trigger-to-materialized-`endsAt` shape as models.
- **No baggage to untangle** — no resurface hack, no `original*` fields, no permanent access. Comics is *tidier*
  to migrate than models.
- **Key on `id`, not the PK.** The PK is `[projectId, position]` (mutable position); `PaidAccess.entityId` uses
  `ComicChapter.id` (`@unique`, stable).

The comics `PaidAccess` migration (dropping its `earlyAccess*` columns onto the table) is **stage 5** — after
this PR. Only the anchor comes now.

---

## 6. Current `earlyAccessConfig` → where each field goes (behavior-preserving)

The blob being retired. Source: `modelVersionEarlyAccessConfigSchema`
(`src/server/schema/model-version.schema.ts`). This table is the migration contract: every field has a
destination, and the mapping **changes no behavior** — bundle semantics are kept exactly.

```typescript
// current shape — z.infer<typeof modelVersionEarlyAccessConfigSchema>
{
  timeframe: number;              // EA duration (days)
  permanent: boolean;             // never-expires gate (CP-member only)
  chargeForDownload: boolean;
  downloadPrice?: number;         // min 100
  chargeForGeneration: boolean;   // enables the optional cheaper generation-only tier
  generationPrice?: number;       // min 50
  generationTrialLimit: number;   // max 1000, default 10
  donationGoalEnabled: boolean;
  donationGoal?: number;
  donationGoalId?: number;
  originalPublishedAt?: Date;
  freeGeneration?: boolean;       // generation free even though download is gated (rare)
}
```

| Field | New home | Note |
| --- | --- | --- |
| `timeframe` | consumed → `endsAt` (timed only) | `endsAt = initialPublishedAt + timeframe`; not stored (form re-derives "N days"). Permanence is the **`permanent` flag**, *not* `timeframe:0`. |
| `permanent` | `endsAt IS NULL` | the `earlyAccessPermanent` flag → a NULL `endsAt`. No boolean column. |
| `chargeForDownload` + `downloadPrice` | `terms.download` (`{ price }`) | the full-access (bundle) tier; buying it grants generation too. `min(100)` floor kept. |
| `chargeForGeneration` + `generationPrice` | `terms.generation` (`{ price }`) | the **optional cheaper generation-only tier**. `min(50)` floor kept. |
| `generationTrialLimit` | `terms.generation.trialLimit` | default 10, `max(1000)` kept. |
| `freeGeneration` | `terms.freeGeneration` | **preserved** — "download gated, generation free." Rare (1 row ever, 0 active). Goes away only when independent grants ship. |
| `donationGoalEnabled` | `DonationGoal` row exists | already modeled — `DonationGoal.modelVersionId` forward FK (§3). Not in `PaidAccess`. |
| `donationGoal` | `DonationGoal.goalAmount` | lives on the goal row, not the gate. |
| `donationGoalId` | **dropped** | the back-link hack (§3); the forward FK replaces it. |
| `originalPublishedAt` | `ModelVersion.initialPublishedAt` | the compensation-hack field the anchor was built to kill (§2). |

**Gating is unchanged — the gate is still the window, the tiers are still tiers.** Today, being in the paid
window gates download and generation together; the `chargeFor*`/`*Price` fields define *purchase tiers*, and a
`download` purchase grants **both** permissions (the bundle,
[model-version.service.ts:1861](../../src/server/services/model-version.service.ts)). The new model keeps all of
this: `PaidAccess` row active = gated; `terms.download` is the full-access tier (grants both); `terms.generation`
is the optional cheaper generation-only tier; `terms.freeGeneration` preserves the "generation free" case. **A
missing `generation` grant does NOT mean generation is free** — generation is still gated by the download bundle,
exactly as today.

**No `(a)/(b)` decision, because nothing changes.** Prod today (453 active): 279 charge both, **173 charge
download only**, 1 generation only. The 173 map mechanically to `{ "download": { "price": … } }` and their
generation stays gated (buy download to generate) — **identical to today**. Making a missing generation grant
mean *free* is the independent-grants product change, which is **out of this PR** (Decisions header). Ship the
plumbing with zero behavior change; ship independent grants — and any decision about those 173 — as its own PR.

**Donation goals stay normalized, but they *are* a paid-access end-condition.** The `donationGoal*` fields
move onto / stay on the `DonationGoal` row (its own entity, with `paidAmount`/`donations` progress) rather than
into `terms`. Functionally the goal is one of the ways `PaidAccess.endsAt` is set: reaching it writes
`endsAt = now()` (§1, §3). The link is the forward FK `DonationGoal.modelVersionId`.

**The three timing fields leave the jsonb entirely.** `timeframe`, `permanent`, and `originalPublishedAt`
migrate to columns: duration materializes into `endsAt`, permanent becomes `endsAt IS NULL`, and the
publish-rewrite compensation becomes the write-once `initialPublishedAt` (§2). Nothing in `terms` is ever about
*when*.

---

## 7. `PaidAccess.terms` — the TypeScript type

`terms` is *what is purchasable* — the **standard prices**. Its **shape varies by the row's `entityType`** (a
`ModelVersion` has download/generation tiers; a `ComicChapter` has one `access` grant), dispatched by
`parseTerms(entityType, raw)`. Nothing about *when* the gate ends lives here (that's `endsAt`), *who owns it*
(`ownerId`), or **time-boxed discounts** (promotions are **deferred** — see the Deferred section).

```typescript
export type PaidAccessTerms = ModelVersionTerms | ComicChapterTerms;

/**
 * ModelVersion — bundle semantics (today's behavior).
 * `download` = full-access tier; BUYING IT GRANTS GENERATION TOO.
 * `generation` = optional cheaper generation-only tier.
 * A missing `generation` does NOT mean generation is free — it's gated by the download bundle.
 */
export type ModelVersionTerms = {
  download?: Grant;             // full-access (bundle) tier
  generation?: GenerationGrant; // optional cheaper generation-only tier
  freeGeneration?: boolean;     // rare: generation free even though download is gated (preserves today)
};

/** ComicChapter — one grant: unlock/read the chapter. Always present. */
export type ComicChapterTerms = {
  access: Grant;
};

export type Grant = { price: number };  // standard price, in Buzz (promotions deferred)

export type GenerationGrant = Grant & {
  /** Free preview generations before the generation tier must be bought. Omit/0 → none. ModelVersion-only. */
  trialLimit?: number;
};
```

`parseTerms` dispatches on `entityType` (`ModelVersion` → `{ download?, generation?, freeGeneration? }`;
`ComicChapter` → `{ access }`). No `termsVersion`: the zod validation below is the write-boundary contract, and
if a *breaking* reshape ever lands, an int stamp is a one-line addition then (`earlyAccessConfig` rotted because
it was unversioned **and unvalidated** — the validation is the fix).

**Validation (zod at the write boundary):**

- **ModelVersion:** at least one of `download` / `generation` present; `download.price ≥ 100`,
  `generation.price ≥ 50` (today's `MIN_*` floors); if both present, **`download.price ≥ generation.price`**
  (superset tier — enables proration, §4); `trialLimit ≤ 1000`.
- **ComicChapter:** `access` present; `access.price` in `100..10000` (today's `buzzPrice` bounds).

**Effective price (read side).** With promotions deferred, the effective price is simply `grant.price`. When
promotions ship, this becomes `activePromotion?.price ?? grant.price` (the promo read via `getPromotions`).

**Example rows:**

```jsonc
// ModelVersion — full access 8000, cheaper generation-only tier 5000 w/ 10 preview gens
{ "download": { "price": 8000 }, "generation": { "price": 5000, "trialLimit": 10 } }

// ModelVersion — download-only (the 173): generation still gated by the bundle
{ "download": { "price": 8000 } }

// ComicChapter — unlock the chapter for 500
{ "access": { "price": 500 } }
```

---

## Migration — anchor → expand → flip → contract

> **Applied.** This section is the design record; all slices (incl. the Part 2 column drops) shipped — the record
> is in `prisma/migrations/`. Kept for the rationale, not as pending work.

Shipped as independently-deployable slices. **Slice 0, Part 1, and Part 1.5 are additive and reversible; Part 2
is the destructive cleanup**, run only after a soak. Migrations are hand-applied here, so the drops are hand-run
SQL (preview → staging → prod). The gate for Part 2 is **"does prod behave identically before and after?"** —
which is only meaningful because this PR changes no behavior (Decisions header).

### Slice 0 — the anchor (ship first, no table)

Land `initialPublishedAt` on **`ModelVersion` and `ComicChapter`** (write-once, set only when `NULL`), backfill
it, and stop the expiry job rewriting `publishedAt`.

- Backfill `initialPublishedAt = COALESCE(earlyAccessConfig->>'originalPublishedAt', publishedAt)` — expired rows
  had `publishedAt` rewritten, so the true first-publish date is in the config.
- Retarget the expiry job so it no longer rewrites `publishedAt` (it read from a moving anchor; now it doesn't
  move). This **fixes the comics republish-clock bug on its own**, with no `PaidAccess` table.

Independently valuable and low-risk. Everything below builds on it.

### Part 1 — expand (additive, reversible)

1. **Create** `PaidAccess` (+ `PaidAccessEntityType` enum). Additive — no existing column is touched.
2. **Backfill — the row-selection predicate is the safety-critical part.** Insert a `PaidAccess` row **only for
   currently-gated versions**:

   ```sql
   WHERE availability = 'EarlyAccess' AND (earlyAccessEndsAt > now() OR earlyAccessPermanent = true)
   ```

   **Not** "has an `earlyAccessConfig` blob" — expired versions retain the blob with `earlyAccessEndsAt = NULL`,
   so a config-presence predicate would map ~26k expired versions to a NULL-`endsAt` (permanent!) row and
   **permanently paywall free content**.
   - **Permanent rows are real now** — re-measure at backfill time. Permanent access shipped 2026-07-21, so the
     "0 permanent" figure from three days in will not hold. `earlyAccessPermanent = true` → a row with
     `endsAt = NULL`; everything else timed. Do **not** assume the permanent set is empty.
   - The **173 download-only** versions map to `{ "download": { "price" } }` — generation stays gated by the
     bundle (§6). Nothing materialized; no behavior change.
   - Run the §7 `terms` validation over backfilled rows; clamp/report dirty historical prices before cutover.
3. **Dual-write — translate, don't mirror, and cover *every* writer.**
   - a. **All app write paths** — the tRPC upsert, the REST early-access endpoint, and the publish paths
     (`publishModelVersionsWithEarlyAccess`, scheduled publishing) write `PaidAccess` alongside the columns.
   - b. **The raw-SQL writers must be included explicitly** — **donation-goal completion**
     (`donation-goal.service.ts:157`) and the **expiry job** bypass app code; each updates `PaidAccess` in the
     *same* transaction (§3).
   - c. **The "ended" encoding is inverted — map it, don't copy it.**

     | old columns | → `PaidAccess.endsAt` |
     | --- | --- |
     | `earlyAccessPermanent = true` | `NULL` (permanent) |
     | active timed (`earlyAccessEndsAt > now()`) | `earlyAccessEndsAt` (mirror the trigger's output) |
     | **ended** (goal met / expired: `earlyAccessEndsAt = NULL`, not permanent) | **`now()`** — **never NULL** |

     Mirroring `earlyAccessEndsAt` for active-timed rows keeps old- and new-path in agreement during Part 1 even
     for republished versions; `initialPublishedAt` only *becomes* the anchor in Part 2, when the trigger is gone
     and the service computes `endsAt = initialPublishedAt + timeframe` on write.
4. **Sweep the reads onto the helper — including the `availability` gate-reads.** Route the ~37
   `earlyAccessEndsAt` reads through the helper (`getPaidAccess` / `paidAccessSql`), and in the **same edit**
   drop the `availability = 'EarlyAccess'` condition sitting next to them. There are **11** such gate-reads
   across 5 files — `common.service.ts:138`, `model.service.ts:1009`, `resource-data.redis.ts:35`,
   `mini/[id].ts:135`, and 7 in `comics.router.ts` — every one of the form
   `availability = 'EarlyAccess' AND earlyAccessEndsAt > NOW()`. You can't rewrite the right side without
   touching the left, so converting them is nearly free now and expensive to re-find later. This stops
   `availability` being a *second* answer to "is this gated" the moment `PaidAccess` ships. (The trigger keeps
   *writing* `availability='EarlyAccess'` for feed/visibility during Part 1 — only its use as the **gate** is
   retired here.)
5. **Cache:** every `PaidAccess` write must **also bust the legacy caches** (`bustMvCache`, `RESOURCE_DATA`,
   `dataForModelsCache`) — they bake the gate in at build time and stay live throughout Part 1.

Deploy. Old columns intact and maintained → reversible; roll back loses nothing. **Verify prod behaves
identically** before proceeding.

### Part 1.5 — flip the helper onto `PaidAccess` (additive, reversible)

Reimplement `packages/civitai-buzz/src/paid-access.ts` to read `PaidAccess` instead of the columns — the single
boundary that lets the data source flip without editing every call site.

- **JS:** `isPaidAccessActive(row)` — `row.endsAt == null || row.endsAt > now` — fed by `getPaidAccess`.
- **SQL:** `paidAccessSql` becomes an **`EXISTS` subquery**:
  `EXISTS (SELECT 1 FROM "PaidAccess" pa WHERE pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id AND (pa."endsAt" IS NULL OR pa."endsAt" > now()))`.
- Rewrite `paid-access.test.ts` so the permanent cases assert `endsAt IS NULL ⇒ active`.

Now the **main app's** reads come from `PaidAccess`; old columns are dual-written backup. Soak; confirm nothing
in `src/` reads the old columns. **The creator-studio spoke does *not* ride this flip** — it has its own inline
Kysely predicate + count queries and never imports the helper, so it's converted separately in Phase B (§E).

### Part 2 — contract (destructive, after soak)

> **Release gate — this is Phase C, not the "main app first" release.** Part 2 is a main-app change, but it
> **must not deploy until the creator-studio spoke has been converted to read `PaidAccess` and deployed** (the
> §E spoke sites). Dropping the old columns while the spoke still reads them breaks it instantly and removes
> them from the shared Kysely types.

1. **Stop dual-writing** the old columns; **stop writing `availability = 'EarlyAccess'`** from the paid path
   (the value goes vestigial — feeds that accept `Public | EarlyAccess` keep working on existing rows).
2. **Drop** the deprecated columns — `earlyAccessEndsAt`, `earlyAccessConfig`, `earlyAccessPermanent`,
   `earlyAccessTimeFrame` on `ModelVersion` (comics pair at stage 5). Requires the **broader reader inventory**
   below migrated first.
3. **Drop the DB trigger(s)** — `endsAt` is now service-materialized from `initialPublishedAt`.
4. **Retarget the expiry job** to cache/search invalidation only.

**Broader Part-2 reader inventory** (columns/blob read for decoration; break at the drop): `model-versions/[id].ts:69`
(public API), `creator-shop.service.ts:660` (`getEarlyAccessModelPrices`), `generation.service.ts:1362/1490`
(`freeGeneration` → `terms.freeGeneration`; `generationTrialLimit` → `terms.generation.trialLimit`). In the
query-sites doc as the Part-2 work-list.

**`Availability.EarlyAccess` enum-value removal is a separate, dated ticket — not this PR.** The *reads* are
converted in Part 1 (step 4) and writes stop in Part 2, so `availability` stops meaning "gated." But dropping
the enum **value** is a Postgres type recreate and crosses repos: a DB trigger writes it, event-engine reads it
(`event-engine-common/feeds/models.feed.ts`, `types/model-feed-types.ts`), and it's in the Meilisearch document
shape — a coordinated deploy **plus a reindex**. Give it a ticket with a date, not "later."

### Cross-app: the creator-studio spoke reads this too

The SvelteKit spoke (`apps/creator-studio`) queries the **same database** via Kysely, so it's part of the sweep
alongside `src/`:

- `lib/server/models.ts:10` — `accessFilter` predicate → the `PaidAccess` `EXISTS` predicate.
- `lib/server/models.ts:208/258` — selects the columns + `hasEarlyAccess` → decorate via `getPaidAccess`.
- `lib/server/monetization/early-access.ts:98` — permanent **cap count** (`earlyAccessConfig->>'permanent'`) →
  count `PaidAccess WHERE "endsAt" IS NULL`.
- `lib/server/monetization/early-access.ts:114` — timed-window **cap count** → count active timed `PaidAccess`.

Notes: it reads permanence from `earlyAccessConfig->>'permanent'` (its Kysely lacks the column), so it breaks
specifically on the `earlyAccessConfig` drop and must move to `PaidAccess`; its Kysely types need `PaidAccess`
added (`@civitai/db-schema`). Spoke **writes** go through the main app's REST endpoint (`early-access.ts:62-68`),
so they're covered by the main-app dual-write.

## Open (not blocking this schema)

- **Cross-type permanent budget** (policy) — is the permanent allowance **per entity type** or **combined**?
  Moot until a second type gets permanent access (comics is timed-only). Default: per-type.
- **Independent grants** — a future product PR (price download/generation separately; missing generation grant
  becomes *free*). Requires a decision on the 173 download-only versions and creator comms.

---

## Deferred

Intentionally postponed — **not part of the initial schema**. As the Decisions header notes, promotions are the
*reason the foundation is worth building now*: their three creator asks each land on something this PR creates
(`ownerId`, `initialPublishedAt`, one indexable price place).

### Promotions — time-boxed discounts

> **⏸ Deferred.** The initial paid-access release has **standard prices only** (no sales/discounts). Captured
> for when we pick it up; nothing here is built now, and `terms` carries no discount data in the meantime.

When built, promotions go in their **own table** for one reason: **discoverability.** A "browse deals" surface
must answer *"what is discounted right now?"* across all entities — a range query on the sale window — which a
jsonb array buried in `terms` can't be indexed for. Per-entity reads use a `getPromotions` accessor, the same
[decorate-vs-predicate](onsite-monetization-parity.md#caching-getpaidaccess) split as `PaidAccess`.

**Creator requirements (Discord, 2026-07-24) — build to these; they expand the sketch below.**

- **Item-level, not per-grant.** Creators don't want separate download vs generation sale prices; one discount
  applies to the whole item. → **drop the per-`grant` column** from the sketch below; a discount scales the
  item's tiers together.
- **Percentage discounts** (flat optional) — the timed tiers are naturally "X% off."
- **Two scopes:** *individual item* (entity-scoped) **and** *store-wide* (owner-scoped). → needs an
  `ownerId`-scoped variant, which `PaidAccess.ownerId` sets up.
- **Age-based auto-pricing rules — the standout ask.** "After 1 month → 20% off, after 3 months → 50% off",
  per item by age. Keyed off `initialPublishedAt` (`age = now − initialPublishedAt`) — which this PR adds.

So the eventual system is bigger than a fixed-window table: item + store-wide scopes, percentage discounts, and
age-relative auto-pricing. The sketch below is only the per-entity fixed-window piece — a starting point.

```diff
+ model Promotion {
+   id         Int                  @id @default(autoincrement())
+   entityType PaidAccessEntityType
+   entityId   Int
+   price      Int                  // discounted Buzz price for the window; item-level, not per-grant
+   startsAt   DateTime             // SALE-window start — NOT PaidAccess.endsAt (the gate window)
+   endsAt     DateTime             // SALE-window end
+   createdAt  DateTime             @default(now())
+
+   @@unique([entityType, entityId, startsAt])  // decorate lookups + no duplicate window starts
+   @@index([startsAt, endsAt])                   // discovery: "on sale now"
+ }
```

**Naming caution:** `Promotion.startsAt`/`endsAt` are the *sale* window — unrelated to `PaidAccess.endsAt`, the
*gate* window. Same word, different table, different meaning.

**Validation (Promotion write boundary):** `startsAt < endsAt`; `price` below the item's standard price; the
window inside the gate's life; no overlapping windows per `(entityType, entityId)`.
