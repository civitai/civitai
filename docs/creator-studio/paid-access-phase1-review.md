# Phase 1 PaidAccess cutover — consistency review

Review of branch `feat/paid-access` (commit `4725b30` + working-tree changes) against the stated goals:
**PaidAccess and DonationGoal should be fetched and queried largely the same way**, and the whole thing
should be a **net simplification** over `earlyAccessConfig`.

Scope: naming and coding consistency. Not a bug hunt — but a handful of findings below are behavioral
consequences of an inconsistency, and those are called out explicitly.

Verified: `pnpm typecheck` passes clean.

---

## 1. The core asymmetry: PaidAccess is one accessor, DonationGoal is four

`PaidAccess` reads go through exactly one door — `getPaidAccess(entityType, ids)` — with two deliberate
exceptions that read the primary directly and say why (the delete guard in `deleteVersionById`, the merge
guard in `mergeVersions`). That's a good design and it reads well.

`DonationGoal` has **four** parallel read paths for the same row:

| Site | Mechanism | Filters |
|---|---|---|
| [donation-goal.service.ts:19](../../src/server/services/donation-goal.service.ts#L19) `getDonationGoals` | `modelVersionPublicDonationGoalsCache` | public: `active`, hideDonationGoals opt-out, **live timed EA window** |
| [donation-goal.service.ts:68](../../src/server/services/donation-goal.service.ts#L68) `donationGoalByEntity` | `dbWrite.findFirst` + raw total | none |
| [donation-goal.service.ts:30](../../src/server/services/donation-goal.service.ts#L30) `donationGoalById` | `dbWrite.findUniqueOrThrow` + raw total | numeric-id keyed |
| [model-version.service.ts:1745](../../src/server/services/model-version.service.ts#L1745) `earlyAccessPurchase` | inline `dbRead.donationGoal.findFirst` | `active: true` |

plus a fifth shape in `modelVersionDonationGoals`' privileged branch (its own `findFirst` + its own raw
`SUM`). The `SELECT ... SUM("amount") FROM "Donation"` snippet is hand-copied **four** times.

**Recommendation:** mirror the PaidAccess shape. One `getDonationGoals(entityType, ids)` batch accessor as
the door, plus one `getDonationGoalForOwner(...)` for the privileged variant, both in
`donation-goal.service.ts`; every other site calls one of them. `earlyAccessPurchase`'s inline `findFirst`
in particular has no reason to exist — it already has the version id and its neighbours use `getPaidAccess`.

### 1a. Where that asymmetry becomes a real bug

`getDonationGoals` returns the **public** variant, but the controllers use it to build **owner-facing form
state**:

- [model-version.controller.ts:283](../../src/server/controllers/model-version.controller.ts#L283) and
  [model.controller.ts:265](../../src/server/controllers/model.controller.ts#L265) feed `donationGoal`
  into the DTO.
- `ModelVersionUpsertForm`'s `toFormEarlyAccessConfig` derives `donationGoalEnabled: !!donationGoal` and
  the `disabled` state of both the switch and the amount input from it.

The public lookup drops a goal when the entity has no **live timed** window
([donation-goals-cache.ts:154](../../src/server/redis/donation-goals-cache.ts#L154)) and when the owner has
`hideDonationGoals` set. So:

- a **draft/unpublished** version (endsAt still NULL → pending) with a saved goal renders the owner's form
  as "no donation goal", switch off, inputs unlocked;
- so does a **permanent** gate (endsAt NULL by definition);
- so does a version whose window has elapsed;
- so does any owner who opted out of public display.

`ensureDonationGoal` is create-once so nothing is destroyed, but the form lies about current state, and the
"cannot change after publish" lock silently disengages. The owner path needs the privileged read, not the
public one.

### 1b. Cache semantics differ for two things fetched side-by-side

| | PaidAccess | DonationGoal |
|---|---|---|
| TTL | `CacheTTL.hour` | `CacheTTL.xs` (60s) |
| Keyed by | per-`entityType` cache, entity id | ModelVersion only (`modelVersionId`) |
| Correctness relies on | explicit bust on every write | TTL expiry |
| Bust on create | `writePaidAccessForModelVersion` always busts | **`ensureDonationGoal` never busts** |
| Bust helper | `bustPaidAccessCache` (exported) | `bustPublicDonationGoalsCache` (module-private) |

`ensureDonationGoal` ([donation-goal.service.ts:103](../../src/server/services/donation-goal.service.ts#L103))
writes a row and leaves the cache alone — it happens to be masked by the 60s TTL and by `cacheNotFound:
false`, but that is an accident, not a design. If DonationGoal is meant to be fetched like PaidAccess, it
should bust on write and carry a comparable TTL.

Also, `createPaidAccessCache` is a factory producing one cache **per entityType** precisely so ModelVersion
123 and ComicChapter 123 can't collide. `modelVersionPublicDonationGoalsCache` is a single hand-rolled
ModelVersion cache, and `getDonationGoals` papers over the gap with `if (entityType !== 'ModelVersion')
return {}`. When comics arrive in stage 5, that branch is where the divergence bites. Make it a factory now.

### 1c. Return-shape and guard mismatches between the two accessors

```ts
getPaidAccess(entityType, ids):    Promise<Record<number, PaidAccessRow>>            // absent key = free
getDonationGoals(entityType, ids): Promise<Record<number, PublicDonationGoal | null>> // explicit null
```

One signals "no row" by key absence, the other by an explicit `null`, so callers can't be written the same
way: `paidAccessByVersion[id]` vs `donationGoalsByVersion[id] ?? null`. Pick one (absence is the more
natural for a `Record`) and make both match.

Likewise `getDonationGoals` early-returns on `!ids.length`; `getPaidAccess` does not (it delegates to
`fetch([])`). Small, but they're presented as siblings.

### 1d. PaidAccess writes leak out of `paid-access.service`

Everything writes PaidAccess through `writePaidAccessForModelVersion` / `materializePaidAccessEndsAt`, with
one exception:
[donation-goal.service.ts:245](../../src/server/services/donation-goal.service.ts#L245) hand-writes

```sql
UPDATE "PaidAccess" SET "endsAt" = NOW() WHERE "entityType" = ...::"PaidAccessEntityType" AND "entityId" = ...
```

It's the only site that needs a `::"PaidAccessEntityType"` cast and the only PaidAccess mutation outside its
owning service. It wants to be `endPaidAccessNow(entityType, entityId)` exported from `paid-access.service`
(which would also fold the follow-up `bustPaidAccessCache` into the writer, matching every other writer).

---

## 2. Naming

### 2.1 The rename stopped one file short — dead client field

The committed pass renamed the generation resource field to `paidAccessTerms`; the working-tree pass renamed
the server side again to `paidAccess: { endsAt, terms }` — but not everywhere:

- [resource-data.redis.ts](../../src/server/redis/resource-data.redis.ts) no longer emits `paidAccessTerms`
  (the column was dropped from the SQL).
- [generation.schema.ts:63](../../src/server/schema/generation.schema.ts#L63) now declares
  `paidAccess` + `donationGoal`.
- [generation.types.ts:18](../../src/shared/types/generation.types.ts#L18) still declares
  `paidAccessTerms?: ModelVersionTerms | null` on `GenerationResourceBase`.
- [FormFooter.tsx:1207](../../src/components/generation_v2/FormFooter.tsx#L1207) still reads it:
  `const hasEarlyAccess = resourceData.some((x) => x.paidAccessTerms)`.

The field is optional, so `typecheck` passes — and `hasEarlyAccess` is now **permanently `false`**. That's a
live regression hiding behind an optional property.

Related: `GenerationResourceBase` and `generationResourceSchemaBase` are two hand-maintained descriptions of
the same DTO that have now drifted (`paidAccessTerms` vs `paidAccess`/`donationGoal`). Derive one from the
other.

### 2.2 `paidAccessTerms` vs `paidAccess.terms`

Even inside the flipped code, the same value is called two things: `paidAccessTerms` as a local
(`ModelVersionDetails`, `ModelVersionEarlyAccessPurchase`, `model-version.utils`) and `paidAccess.terms` on
the wire. Fine as a local alias, but pick one spelling for the *field* name and stop mixing (see 2.1).

### 2.3 The write path is still named after the thing being deprecated

The payload is now `{ paidAccess, donationGoal }`, but the surrounding names all still say
`earlyAccessConfig`:

| Name | Location |
|---|---|
| `updateEarlyAccessConfigSchema` / `UpdateEarlyAccessConfigInput` | `model-version.schema.ts` |
| `updateModelVersionEarlyAccessConfig` | `model-version.service.ts` |
| `api/v1/model-versions/early-access.ts` | REST endpoint |
| `formEarlyAccessConfigSchema` / `FormEarlyAccessConfig` / form field `earlyAccessConfig` | `ModelVersionUpsertForm.tsx` |

"Early access" is the *product name for one configuration of PaidAccess* (timed + terms). Keeping it on
user-facing copy is right; keeping it on the schema/service/endpoint that now writes a generic gate is what
makes the refactor read as a rename rather than a simplification. At minimum the zod type and the service
function should be `updateModelVersionPaidAccess` / `UpdateModelVersionPaidAccessInput`.

Stale comment to fix regardless: `updateModelVersionEarlyAccessConfig` is still documented as "Shares the
same guards + merge" — the merge is gone.

Same for `assertPaidAccessInput`, whose doc comment still opens "Field-level early-access requirements".

### 2.4 Plural names for a singular value

The model is now explicitly *one goal per entity*, but the plural survived everywhere:

- tRPC route `modelVersion.donationGoals` → returns `PublicDonationGoal | null`
- `modelVersionDonationGoals()`, `getPublicDonationGoals()` → return one goal
- `ModelVersionPublicDonationGoalsCacheItem` (holds `goal:`, singular)
- `type ModelVersionDonationGoal = NonNullable<RouterOutput['modelVersion']['donationGoals']>` — singular
  type name, plural source
- component `ModelVersionDonationGoals` + inner `DonationGoalItem` (a list-item component rendering the only
  item)
- `useQueryModelVersionDonationGoals` returning `{ donationGoal }`

`getDonationGoals` (batch, plural) is correct — it's `Record<id, goal>`. Everything else should be singular.

### 2.5 `PaidAccessEntityType` is declared four times, imported from two

Declarations: prisma enum, `civitai-db-schema/src/enums.ts`, `civitai-db-schema/src/models.ts`, and a
hand-written union in `@civitai/buzz/paid-access.ts`. Generated ones are fine; the hand-written one in
`@civitai/buzz` is the drift risk.

Imports also disagree — `donation-goal.service.ts` takes it from `~/shared/utils/prisma/enums`, everything
else from `@civitai/buzz`. Two sibling services, two sources for the same type.

### 2.6 Two definitions of every write input

| Domain type (`paid-access.service.ts`) | Zod type (`model-version.schema.ts`) |
|---|---|
| `ModelVersionPaidAccessInput` | `ModelVersionPaidAccessInputSchema` |
| `DonationGoalInput = { amount: number }` | `DonationGoalInputSchema` |

They're structurally identical and already worded differently (`timeframeDays?: number` vs
`.min(0).optional()`). `assertPaidAccessInput` takes the zod one, `writePaidAccessForModelVersion` takes the
hand-written one, and the same object flows through both. Delete the hand-written pair and export
`z.infer<>` — that's a straight subtraction.

The DTO shape is a third copy: `{ endsAt, timeframeDays, terms }` is spelled out inline at
`model-version.controller.ts:290`, `model.controller.ts:428`, and again in `ModelVersionUpsertForm`'s
`VersionInput`. One exported `ModelVersionPaidAccessDto` would cover all three (and would have caught 2.1).

---

## 3. SQL vs TypeScript disagree about the same predicate

`@civitai/buzz` defines the terms predicates once (`isFreeGeneration`, `paidGenerationGrant`,
`generationPrice`, `isPaidAccessActive`, `paidAccessActiveSql`). The raw-SQL sites re-derive them by hand and
one of them gets it wrong.

**[mini/\[id\].ts:148](../../src/pages/api/v1/model-versions/mini/[id].ts#L148)** — free trial limit:

```sql
WHEN pa."terms"->'generation'->>'price' IS NOT NULL
THEN COALESCE(CAST(pa."terms"->'generation'->>'trialLimit' AS int), 10)
```

`paidGenerationGrant` says a paid generation tier is "`generation` present and not `{free:true}`" — `price`
is **optional** and falls back to the download price (documented in `paid-access.ts:34-48`). The new form
(`toPaidAccessInput`) emits `generation: { trialLimit: N }` with **no `price`** unless the creator sets a
cheaper tier — which is the default path. So for the common case this SQL evaluates false and
`freeTrialLimit` comes back `NULL`. Predicate should be `pa."terms" ? 'generation' AND
COALESCE(pa."terms"->'generation'->>'free','') <> 'true'`.

**Other hand-rolled variants of the same idea:**

- `getUserEarlyAccessModelVersions` (`model-version.service.ts:270`) — inline `EXISTS ... endsAt > now()`
- `publishModelVersionById` (`:1199`) — Prisma `OR: [{endsAt: null}, {endsAt: {gt: now}}]`
- `process-scheduled-publishing.ts` — two correlated subqueries
- `model.notifications.ts` — `pa."endsAt" <= NOW() AND pa."endsAt" >= lastSent`
- `mini/[id].ts` — `LEFT JOIN` + `pa."endsAt" IS NULL OR pa."endsAt" > NOW()`
- `donation-goal.service.ts:242` — `paidAccess.endsAt != null && paidAccess.endsAt > new Date()`

Six spellings of "active gate". Meanwhile **`paidAccessActiveSql` is exported and has zero call sites** —
the doc's §0 claims reads were flipped to it. So is **`isPaidAccessGated`** (exported, never called). Both
are dead code today; either route the SQL sites through `paidAccessActiveSql` or delete it.

Also worth naming as a shared concept: "timed-active" (`endsAt > now()`, excludes permanent) shows up
independently in `getUserEarlyAccessModelVersions`, the delete guard, the merge guard, and
`checkDonationGoalComplete`. Four hand-rolled copies of a rule that deserves one helper next to
`isPaidAccessActive` (e.g. `isTimedGateActive`).

**`process-scheduled-publishing.ts:46`** — `'hasEarlyAccess'` is `pa."timeframeDays" IS NOT NULL`, i.e.
**permanent gates report `hasEarlyAccess = false`**. That matches the old `timeframe > 0` behavior so it's
preserved, not introduced — but it's now expressed as a NULL check on a column whose NULL means "permanent",
which reads as a mistake. Worth an explicit comment or a fix.

---

## 4. Places the simplification didn't land

- **`donationGoalById` / `donationGoalByEntity` read from `dbWrite`.** PaidAccess reads go to the replica via
  the cache and only escalate to the primary where money is on the line, with a comment explaining why.
  These two are unexplained primary reads on a public path (pre-existing for `donationGoalById`, newly
  copied into `donationGoalByEntity`).
- **`ensureDonationGoal` is check-then-create with no unique constraint.** `PaidAccess` upserts against a
  real composite PK; `DonationGoal` has only `@@index([entityType, entityId])`, so the create-once
  invariant is racy. Phase 2 makes `(entityType, entityId)` the PK — until then a unique index would make
  the two writers behave the same.
- **Dead schema columns kept alive.** `DonationGoal.isEarlyAccess` and `DonationGoal.paidAmount` are now
  code-unused (`isEarlyAccess` is correctly derived from PaidAccess), and `ensureDonationGoal` writes neither.
  The phase-1 cutover doc lists `isEarlyAccess` for phase-2 removal — good — but nothing tracks `paidAmount`.
- **`ensureModelVersionDonationGoal`** (`model-version.service.ts:658`) is a 5-line pass-through wrapper
  around `ensureDonationGoal` that only hard-codes `entityType: 'ModelVersion'`. Its `tx` parameter is never
  passed by either caller. Inline it.
- **The `tx` parameters are decorative.** `writePaidAccessForModelVersion`, `materializePaidAccessEndsAt`,
  and `ensureDonationGoal` all accept a `tx`, but both `upsertModelVersion` call sites invoke them *outside*
  the version write with the default `dbWrite` — so a gate write can succeed against a version write that
  rolled back. Either thread the transaction or drop the parameter; keeping it suggests atomicity that isn't
  there.
- **`upsertModelVersion` duplicates the write pair.** The identical two lines
  (`writePaidAccessForModelVersion` + `if (donationGoal) ensureModelVersionDonationGoal`) appear in both the
  create and update branches, each followed by the same `Promise.all` bust block.
- **`updateModelVersionEarlyAccessConfig` now builds a fake row**: `const version = { id, modelId:
  existingVersion.modelId }` purely to keep the downstream `version.modelId` reads compiling. Use
  `existingVersion` directly.
- **`hasEntityAccess` fires an extra `getPaidAccess` on every ModelVersion access check**, including the
  all-public fast path that used to short-circuit before any extra I/O. Cached, so cheap — but it's now
  unconditional on a very hot path. Worth confirming that's intended.

---

## 5. The doc no longer matches the code

[paid-access-phase1-cutover.md](paid-access-phase1-cutover.md) still opens with **"Status: plan for review.
Nothing here is implemented beyond §0"**, which is no longer true. Concrete divergences:

- §3 specifies a new **`ModelVersion.earlyAccessEndedAt`** column as the expiry/notification signal, plus
  "delete those rows" in the expiry job. The implementation does neither: the job republishes and leaves
  the row as a tombstone (`process-ending-early-access.ts`), and the notification query windows on
  `pa."endsAt"` instead. No `earlyAccessEndedAt` migration exists. The implemented design is the better one —
  the doc should say so.
- §1 says the terms flip includes `resource-data.redis.ts` "emit terms from PaidAccess"; the working tree
  reverses that and merges terms in at the service layer instead (`mergePaidAccessAndDonationGoals`), with a
  good reason (the 1h `resourceDataCache` TTL would serve stale gating terms). Also undocumented.
- §5's phase-2 list is accurate and worth keeping; add `DonationGoal.paidAmount` and the now-dead
  `ModelVersionEarlyAccessPurchase` / `earlyAccessPurchase` naming to it.
- The three "Open decisions" at the bottom are all settled (timeframeDays: yes; comics: deferred to stage 5,
  contradicting §4's "fold in"; `earlyAccessEndedAt`: dropped).

---

## 6. Smaller notes

- `ensureDonationGoal`'s default title changed from `'Early Access Donation Goal'` to `'Donation Goal'`.
  Deliberate (the goal is no longer EA-specific), but it's a user-visible copy change on existing flows —
  worth confirming it's intended and that nothing matches on the old string.
- `ModelVersionEarlyAccessPurchase.tsx` and `paid-access.ts` both default `trialLimit` to `10`, as does the
  form (`freePreviewGenerations: z.number().default(10)`) and `mini/[id].ts`'s `COALESCE(..., 10)`. Four
  copies of the same magic number; one exported constant.
- The form's min for free preview generations dropped from `10` to `0` while the SQL/TS defaults still say
  10 — check that's intended.
- `donationGoalById`'s visibility guard reads
  `if (!donationGoal.active && (!isModerator || donationGoal.userId === userId)) throw` — the `||` looks
  inverted (a moderator viewing *their own* inactive goal is blocked; a non-moderator non-owner is blocked
  correctly only by the first clause). Pre-existing, not introduced here, but this refactor is the moment to
  fix it.
- `donation-goal.util.ts`'s `setData` callback returns `data ?? null` when the ids don't match, which
  discards nothing but reads oddly next to the `if (!data) return []` it replaced. Minor.
- `PaidAccessCacheRow.endsAtMs` (epoch ms for serialization safety) is a nice touch and correctly commented;
  the donation-goal cache stores a raw `Date` in `createdAt` with no equivalent treatment. Not a bug today
  (superjson handles it) — just another place the two don't match.

---

## Suggested order of work

1. **Fix the live regression** — `paidAccessTerms` → `paidAccess` in `generation.types.ts` + `FormFooter`
   (§2.1), and the `mini/[id].ts` trial-limit predicate (§3).
2. **Fix the owner/public read mix-up** — controllers must use a privileged donation-goal read (§1a).
3. **Unify the accessors** — one `getDonationGoals` door + per-entityType cache factory + bust on write, and
   move the raw `UPDATE "PaidAccess"` into `paid-access.service` (§1).
4. **Collapse the duplicate types** — drop the hand-written input types, export one DTO type (§2.6).
5. **Rename** — `updateModelVersionPaidAccess`, singularize the donation-goal surface (§2.3, §2.4).
6. **Delete the dead code** — `paidAccessActiveSql` / `isPaidAccessGated` if the SQL sites won't adopt them;
   `ensureModelVersionDonationGoal`; the decorative `tx` params (§3, §4).
7. **Update the cutover doc** to describe what was actually built (§5).
