# Generator resource picker: the paid filter

Build plan and record for CU 868m5q2a6 — "Generator: can't filter out paid models in the resource
picker". Written 2026-09-21, scope cut 2026-09-23. Every claim below was measured against the prod
replica or probed against the live search index; numbers are as of those dates.

**Goal**: let someone picking a resource in the on-site generator exclude models they would have to
buy before generating with — and see, on the card, which ones those are.

**"Paid" means a paid-access gate.** Not a licensing fee. That is how the product uses the word and
how every existing filter already behaves (`getModelsRaw`'s `hidePaid`, `hasActivePaidAccess`), and
this feature keeps to it. Licensing fees are **out of scope** (see Deliberately not built).

---

## The problem

The picker (`ResourceSelectFiltersDropdown`, `src/components/ImageGeneration/GenerationForm/ResourceSelectFilters.tsx`)
offered two axes: resource type and base model. So paid models sat mixed in with free ones with no way
to exclude them, and the card (`ResourceSelectModal/ResourceSelectCard.tsx`) showed no pricing at all
beyond a `Private` badge.

## Where the filter has to live

`trpc model.getResourceSelect` → `src/server/services/resource-select.service.ts` → `MODELS_SEARCH_INDEX`.
`buildFilter()` composes the whole Meilisearch filter string, so a new axis must be a **filterable
attribute on the models index**.

## Why the attribute that already existed is the wrong one

`hasActivePaidAccess` is filterable and backs "Hide Paid" on `/search/models` — built, and behind
`paid-model-search-filter`, which is off. It means **"some version of this model has a live gate"**,
which is wrong for the generator twice over.

**It says paid when generation is free.** `PaidAccess.terms` supports `generation: { free: true }` —
gate the download, leave generation open — and `buildModelVersionTerms` has a `freeGeneration` option
for exactly that creator choice:

| Live `PaidAccess` gates on `ModelVersion` (2026-09-21)            | 4,959       |
| ----------------------------------------------------------------- | ----------- |
| `generation: { free: true }` — paid download, **free generation** | 2,762 (56%) |
| paid generation tier                                              | 2,197       |
| bundled (no `generation` key — must buy the download)             | 0           |

So the majority of gated models cost nothing to generate with, and the model-level attribute would
hide all of them.

**It is model-level.** The picker resolves to a *version*. A model with one gated version and five
free ones reads as paid.

## The domain model

`packages/civitai-buzz/src/paid-access.ts` already models download vs generation:

| `terms` shape                          | generation costs              |
| -------------------------------------- | ----------------------------- |
| `generation: { free: true }`           | nothing                       |
| `generation: { price, trialLimit? }`   | that price                    |
| `generation: { trialLimit }`, no price | the **download** tier's price |
| `generation` absent                    | must buy the download tier    |

`isFreeGeneration(terms)` answers this, and `applyPaidAccessGating`
(`src/server/services/generation/paid-access-gating.ts`) is the single enforcement point that already
uses it. The pricing util builds on those rather than restating the rules.

---

## Design

### 1. A shared pricing util

`packages/civitai-buzz/src/model-version-pricing.ts`, beside `paid-access.ts`, so the main app, the
search-index build and Creator Studio share one definition of "is this version free":

```ts
resolveModelVersionPricing({ paidAccess }): {
  free: boolean;          // no live gate of either kind
  payToGenerate: boolean; // live gate whose generation tier is not free
  payToDownload: boolean; // live gate carrying a download tier
}
```

**Sales are deliberately not resolved.** `discountedPrice` floors at `MIN_SALE_PRICE`, so a sale can
never make a paid version free and no signal can move under one.

### 2. One filterable attribute

`versions.pricing: ModelVersionPricingSignal[]` — per version:

```ts
export enum ModelVersionPricingSignal {
  Free = 0, // no live gate of either kind
  PayToGenerate = 1,
  PayToDownload = 2,
  GenerationFree = 3, // complement of 1 — the only member any filter matches
}
```

Separate booleans were considered and rejected. The live index carries 22 filterable attributes and
each settings write reindexes the filterable fields across every document — the `hasActivePaidAccess`
addition took 6.5 min of processing after ~2h50m queued (see the header comment in
`src/pages/api/admin/temp/apply-models-index-filterable-attributes.ts`). One array attribute means one
write, and **a future member is a document rewrite rather than a settings change**, which is what
keeps licensing fees cheap to add back later.

**Ordinals, not bit flags, and an array rather than a packed int.** Meilisearch has no bitwise filter,
so `1/2/4/8` buys nothing inside an array — and packing the signals into one integer would make "has
PayToGenerate" an `IN [...]` enumerating every combination containing that bit.

**The enum is append-only.** Re-meaning an ordinal needs a backfill.

### 3. `GenerationFree` exists because the filter MUST be written positively

Meilisearch flattens an array field, so a positive filter is ANY and a negation is NONE. Probed
against the live `models_v9` with `versions.baseModel`, which has the same shape:

```
model 257749, versions span Pony | SD 1.5
  versions.baseModel = "Pony"       -> 1   (matches)
  versions.baseModel = "SD 1.5"     -> 1   (matches)
  NOT versions.baseModel = "Pony"   -> 0   (excluded)
```

So `NOT versions.pricing = PayToGenerate` means *no* version is gated — it would hide a model with one
paid version and five free ones. The product keeps those visible, so the hide filter is:

```
versions.pricing = 3      // GenerationFree — has at least one version free to generate
```

That only works while **every** version carries at least one member. A version with no gate is written
`[Free, GenerationFree]`, never `[]`. This is the opposite discipline from `hasActivePaidAccess`, whose
sparseness forces `NOT hasActivePaidAccess = true` — `HIDE_PAID_MODELS_FILTER` in
`src/components/Search/paid-model-search-filter.ts`, which carries the measurements behind that spelling.
Two hide-paid clause builders, deliberately opposite. Do not let them be "unified".

Two tests hold this: `toPricingSignals` never returns an empty array (deploy 1), and the emitted query for
`hidePaid` is asserted to contain no negation of the field. The negation half scans only
`model-pricing-filter.ts` plus the one query it produces — **it does not police other call sites**, so
a second clause builder elsewhere would not be caught.

---

## What was built

| Piece | Where | Deploy |
| ----- | ----- | ------ |
| Pricing util + signal enum | `packages/civitai-buzz/src/model-version-pricing.ts` | 1 ✅ |
| Per-version gate terms | `getModelVersionPaidAccessTerms` in `paid-access.service.ts` | 1 ✅ |
| Document build | `models.search-index.ts` (`transformData`) | 1 ✅ |
| `versions.pricing` filterable | `filterable-attributes.ts` | 1 ✅ |
| Tests | `model-version-pricing.test.ts`, `models-index-pricing-signals.test.ts` | 1 ✅ |
| Clause builder, version + badge predicates | `src/shared/search/model-pricing-filter.ts` | 2 |
| Server filter + input | `resource-select.service.ts`, `model.schema.ts` | 2 |
| Filter state + wire | `resource-select.types.ts`, `ResourceSelectProvider.tsx`, `useResourceSelectInfinite.ts` | 2 |
| "Hide paid" chip | `ResourceSelectFilters.tsx` (generation sources only) | 2 |
| Card badge | `VersionPricingBadge.tsx`, `ResourceSelectCard.tsx` | 2 |
| Version pre-selection | `pickInitialVersionIndex` / `resolveSelectedIndex` in `resource-select.types.ts` | 2 |
| Tests | `model-pricing-filter.test.ts`, `resource-select.pricing-filter.test.ts` (the clause reaches the query, and the official pin re-applies it), `pick-initial-version-index.test.ts`, `ResourceSelectPersistence.test.ts` | 2 |

Rows marked 2 are not in `main` until deploy 2 merges.

`getModelVersionPaidAccessTerms` is raw SQL sharing `paidAccessLiveSql` with the model-level rollup, so
the two cannot disagree about which gates are live. Its JSDoc carries the rest (why not the cached
`getPaidAccess`, why the `ModelVersion` join is load-bearing, why sales are not resolved).

## Decisions

- **No pricing filter applies by default.** It is an opt-in chip; an untouched picker behaves exactly
  as before.
- **`PayToDownload` is indexed but never surfaced in the generator.** A version with a paid download
  tier and `generation: { free: true }` costs nothing to generate with. The signal is written for other
  surfaces (a feed filter would read it).
- **Partially-paid models stay visible**, which is what forces the positive filter form above.
- **The chip is NOT persisted** to localStorage — unlike the type filter, like the base-model filter.
  A remembered "hide paid" removes results on a later, unrelated picker open with nothing on screen
  explaining why. Pinned in `ResourceSelectPersistence.test.ts`.
- **The picker card surfaces pricing, and pre-selects a free version.** With the chip on, the card
  opens on a version that satisfies it rather than index 0 — but **compatibility outranks price**: a
  free version the current ecosystem cannot use is not a resource the viewer can generate with, while a
  compatible paid one is at least honest once the badge shows its cost. With the chip **off** the card
  opens on index 0 exactly as before; re-selecting on compatibility alone would have silently changed
  an untouched picker. ⚠️ The card does not see every version: `filterVersions` in `ResourceHitList.tsx`
  has already dropped versions failing `canGenerate`, the ecosystem's base models or `excludedVersionIds`
  (base models are skipped on `featured` and the own-tabs). So `pickInitialVersionIndex`'s compatibility
  arm is a THIRD copy of that rule and only bites where it and `filterVersions` disagree — it is not the
  first line of defence, and `docs/resource-select-modal-refactor.md` already tracks de-duplicating them.
- **The chip is generation-only.** `ResourceSelectFiltersDropdown` is shared with the
  auction / addResource / modelVersion / training pickers, where "paid" ignoring the download price is
  the wrong question, so it renders only for `selectSource === 'generation'`. There is no feature flag:
  the deploy ordering above is what keeps the chip from reaching users before the attribute is live.
- **The badge shows WHETHER, not how much.** The attribute is an ordinal enum carrying no price, so an
  amount would need a second attribute or a per-version lookup.
- **The official-model pin re-applies the filter by hand.** Pinned models come from Postgres and never
  pass through `buildFilter`, so every filter they could violate has to be re-applied at the pin — the
  facet filters by switching the pin off, pricing by filtering the pinned set. 0 official models carry a
  live gate today, so this is structural rather than a live leak.

## Deliberately not built

- **Licensing fees.** Dropped 2026-09-23: "paid" means pay-for-access, and a per-generation fee is a
  different concept that no surface filters on. This removed four enum members, the licensing-lineage
  lookups, and the fan-out obligation below. **31,121 models charge a fee** against 1,424 with a live
  generation gate (2026-09-23), so
  if this ever comes back it is the larger population — and it comes back as appended enum members and a
  document rewrite, with no settings write.
  - The lineage it would need: `ModelVersion.licensingSourceVersionId` points at a version registered as
    a `LicensingRoot`, and prod has **4 distinct sources, none with its own source** — one hop, no
    recursion. **1,626 versions (1,004 models) carry ONLY an inherited fee**, so a parent-fee signal is
    not optional if fees are tracked at all.
  - The obligation it would carry: editing a source's fee reindexes only its own model. Nothing fans out
    to the derivatives, and the incremental index scan reads `Model.updatedAt` alone, so those 1,004
    models would hold a stale signal until each is separately edited. Tracking fees means building a
    fan-out over `licensingDerivatives`.
- **Whether the viewer has bought access.** Ruled out 2026-09-23 — "don't worry about if a user has paid
  for access to models or not". This also settles free trial generations: remaining trials are per-viewer
  state, so the index prices a trial-bearing gate as paid. Recorded here because it is the one place the
  index is deliberately **narrower** than `generationOpenToNonBuyers`, the predicate that actually gates
  generation — 1,974 of 4,815 live gates (41%), counted 2026-09-23, carry a trial allowance, so "Hide
  paid" hides versions a
  viewer could still generate with for free. The badge copy says only that the creator charges, never
  that purchase is required right now.
  The shape it would have taken, if this is ever revisited: it cannot be a document attribute — the search
  doc is one shared precomputed record — so it layers on as an OR against `versions.id`, which is already
  filterable: `(versions.pricing = 3 OR versions.id IN [...purchased])`. The per-viewer set is small at
  the median and long-tailed. Three things it needs:
  - **A read path sized for "what has this user bought"**, which is the opposite direction from how
    `EntityAccess` is addressed elsewhere. Confirm the access-path and caching specifics with an infra
    owner before designing against them — they are recorded privately, not here.
  - **A permission filter.** A grant is not automatically a *generation* grant; the id set has to be
    narrowed by `EntityAccessPermission` before it can widen a search filter.
  - **A cap** on the id list, with a defined fallback.

## Rollout — TWO deploys, in this order

The ordering is the enforcement; there is no feature flag. Shipping the client half first breaks the
picker **for any user who turns the chip on** — filtering on an attribute Meilisearch does not have
applied is a **400**, `isTransientMeiliError` does not classify it as transient, and `searchModels`
rethrows. It is bounded and recoverable: the clause is emitted only when `hidePaid` is true, so an
untouched chip changes nothing; `ResourceHitList` renders its "Couldn't load models" panel rather than
an empty one; and the chip is unpersisted, so unticking or reopening clears it. Between the settings
write and the end of the backfill it degrades gracefully instead, matching only rewritten documents.

⚠️ A rollback or a full rebuild of the models index **re-opens that window after the fact** —
`onIndexSetup` is the only writer of the filterable list and it runs against a swap index, so nothing
in an ordinary deploy re-applies it.

**Deploy 1 — `feat/model-version-pricing-signals`. ✅ Merged 2026-09-23**, PR #5071, commit
`a80b72f0fa`. The util, `getModelVersionPaidAccessTerms`, the document build, and `versions.pricing` in
the filterable list. Nothing reads the attribute yet, so it is inert on its own.

Then, with an owner watching. **Both ran against production on 2026-09-23 and are complete** —
`/api/testing/models-pricing-backfill?action=verify` reported `backfillComplete: true`:

1. ✅ Apply the filterable-attributes settings write
   (`/api/admin/temp/apply-models-index-filterable-attributes`). **Three attributes were already
   pending before this work** — `canGenerateNext`, `versions.canGenerateNext` and
   `versions.generatorLoaded` — so `versions.pricing` made four in one write.
2. ✅ Backfill the **gated** models only (`/api/admin/temp/queue-paid-models-reindex`) — 3,464 of them,
   0 still missing the attribute. Not every document: the clause's `NOT ... EXISTS` half covers the
   ~697K that have not been rewritten yet, which is what turned a 713K sweep into a 3.5K one.

**`NOT ... EXISTS` was probed live before shipping** — it is this repo's first use of `EXISTS` in a
Meilisearch filter, and a rejected operator form would have 400'd every ticked-chip query with no 5xx
recorded. Against `models_v9`: `NOT cannotPromote EXISTS` returns the sparse complement, and the real
clause `canGenerate = true AND (versions.pricing = 3 OR NOT versions.pricing EXISTS)` runs in 26-27 ms
against a 21 ms baseline.

🔴 **The completeness check is "how many GATED models lack the attribute", and nothing else.** "How
many documents lack it" is capped by the index's `maxTotalHits` *and* falls forever as the index
rewrites, so it can neither reach zero nor prove anything. The gated set is the one that must be
complete, because the clause fails open.

Measured at completion: 3,464 gated models, of which **1,415 are gated for generation** — the other
2,049 are download-only and remain visible under "Hide paid". That ratio is the feature.

**Deploy 2 — `feat/generator-paid-filter-ui`.** The clause builder, the tRPC input, the chip, the card
badge and the version pre-selection. Branched off `main` at `8463a16b77` — deploy 1's merge — because
this repo squash-merges and `CLAUDE.md` forbids stacked PRs.

⚠️ The abandoned pre-split branch `feat/generator-pricing-filters` may still exist locally and does
**not** contain deploy 1. It is not this work.

## Known limitation: flattening pairs clauses across versions

Meilisearch flattens `versions[]`, so a filter on two version attributes can satisfy each from a
*different* version. Probed on the live index — model 257749 has a Pony version and an SD 1.5 version
with different hashes:

```
id = 257749 AND versions.baseModel = "SD 1.5"
              AND versions.hashes  = "<the PONY version's hash>"   -> 1
```

So `versions.baseModel = "SDXL" AND versions.pricing = 3` matches a model whose SDXL version is paid and
whose SD 1.5 version is free. This matters routinely rather than rarely: `buildFilter`'s `typeClauses`
pins `versions.baseModel` to the loaded resource's compatible set, so the generator almost always carries
a base-model constraint alongside the pricing one.

| models with both a gated and an ungated version | 201 |
| ------------------------------------------------ | ----- |
| …**and versions spanning >1 base model** (exposed) | 125 |

Pre-existing — type and base model already pair across versions — but pricing is the first axis where the
wrong answer costs someone Buzz.

**Accepted, with the card as the mitigation**: the model still appears, the card shows whether the shown
version is paid, and the initial selection prefers a version that is both free and compatible. A
server-side post-filter was rejected — it would drop hits after paging and break the cursor contract.

## Verified NOT a problem

- **The nested shape works.** `versions.hashes` is already an array of strings inside the array of
  objects and is filterable (`versions.hashes EXISTS` → 100,000+ on the live index); `versions.id` proves
  the integer case.
- **Gate expiry reindexes.** `src/server/jobs/process-ending-early-access.ts` queues a model update for
  every affected model, so a closing timed window does not leave a stale signal.
- **Creator Studio's direct-SQL writes reindex.** The spoke writes with kysely and never reaches the
  service layer, but it POSTs to `/api/v1/model-versions/bust-cache` → `bustMvCache` →
  `bustModelLevelVersionCaches` → `modelsSearchIndex.queueUpdate`.

⚠️ `versions.pricing` holds integers, so Meilisearch also accepts range operators on it. `versions.pricing > 1`
is syntactically valid and meaningless on an ordinal enum — the clause builder is what keeps anyone from
writing one.
