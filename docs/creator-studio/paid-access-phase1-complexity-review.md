# Phase 1 PaidAccess cutover — complexity / spaghetti review

Companion to [paid-access-phase1-review.md](paid-access-phase1-review.md) (naming + consistency). This one
is about **control flow that has become hard to follow**: duplicated logic, tangled publish paths,
validation smeared across layers, and in-place mutation pipelines.

**Second pass**, re-verified line-by-line against the working tree after the consistency fixes landed.
`pnpm typecheck` clean; the 27 paid-access / donation-goal unit tests pass.

## What's resolved since the first pass

The DonationGoal side of the refactor is in good shape now. Specifically:

- **`endPaidAccessNow`** extracted into `paid-access.service` — the raw `UPDATE "PaidAccess"` no longer
  lives in `donation-goal.service`, and its "deliberately does NOT bust, here's why" docblock is exactly
  right.
- **`sumDonationsByGoal`** — the four hand-copied `SUM("amount")` blocks collapsed to one.
- **`getOwnerDonationGoals`** — the owner/public read split is real now, and both controllers gate on
  ownership before using it. This closes the "owner's form shows no donation goal" bug from review 1 §1a.
- **`ensureDonationGoal` busts the cache**, `donationGoalById`'s inverted `||` guard is fixed,
  `ensureModelVersionDonationGoal` is inlined, the fabricated `const version = { id, modelId }` is gone,
  `getPublicDonationGoals` routes through `getDonationGoals`, `toModelVersionPaidAccessDto` replaces the
  three inline DTO literals, `DEFAULT_GENERATION_TRIAL_LIMIT` replaces the four magic `10`s, and
  `isTimedGateActive` now exists and is used in three places.
- **Renames** — `updateModelVersionPaidAccess` / `updateModelVersionPaidAccessSchema` /
  `UpdateModelVersionPaidAccessInput`. Dead `isPaidAccessGated` and `paidAccessActiveSql` deleted.

Everything below is **still open** and was re-confirmed against current code, except §9 which is new.

---

## 1. The publish path has five entry points; `endsAt` materialization is wired into two — UNCHANGED

Still the biggest structural problem on the branch, and still a live defect.

The anti-bump `UPDATE ... WHERE ("publishedAt" IS NULL OR "publishedAt" > NOW())` targeting `ModelVersion`
appears at:

| Site | Materializes `endsAt`? |
| --- | --- |
| [model-version.service.ts:987](../../src/server/services/model-version.service.ts#L987) (`updateModelVersionById`) | ✅ |
| [model-version.service.ts:1088](../../src/server/services/model-version.service.ts#L1088) (`publishModelVersionsWithEarlyAccess`) | ✅ but only `if (publishedAt !== undefined)` |
| [model-version.service.ts:1257](../../src/server/services/model-version.service.ts#L1257) (`publishModelVersionById`, non-EA branch) | ❌ |
| [model.service.ts:2405](../../src/server/services/model.service.ts#L2405) (`publishModelById`, Scheduled branch) | ❌ |
| [process-scheduled-publishing.ts:223](../../src/server/jobs/process-scheduled-publishing.ts#L223) (the job's own status flip) | ❌ |

Four copies of the same six-line guard, each with its own comment restating the rule, and materialization
bolted onto two of them.

### 1a. A **scheduled** early-access version never gets an `endsAt` — still reproducible

1. `publishModelVersionById({ publishedAt: future })` → `status = Scheduled` → the EA branch requires
   `status === Published`, so it falls to the non-EA branch → publishedAt written, **no materialize**.
   `PaidAccess.endsAt` stays `NULL`, `timeframeDays` holds the window.
2. At the scheduled time, `processScheduledPublishing` flips status via its own raw UPDATE, then calls
   `publishModelVersionsWithEarlyAccess({ modelVersionIds, continueOnError: true, tx })` —
   **still without `publishedAt`** ([:238](../../src/server/jobs/process-scheduled-publishing.ts#L238)).
3. Inside, `if (publishedAt !== undefined)` is false → neither the publishedAt write nor
   `materializePaidAccessEndsAt` runs.

`endsAt` stays NULL forever, and `endsAt IS NULL` is the encoding for **permanent**. A version scheduled
with a 7-day window becomes a permanent paid gate. `process-ending-early-access` filters on
`pa."endsAt" > lastRun AND pa."endsAt" <= NOW()`, which NULL never satisfies, so nothing ever releases it.

The job's own follow-up query confirms the gap — it reads `pa."endsAt"` to set `Model.earlyAccessDeadline`
([:250](../../src/server/jobs/process-scheduled-publishing.ts#L250)) and gets NULL.

**Root cause is structural**, not a missing call: "materialize the gate" is a step in *publishing*, but
there's no single publish function to hang it on, so it got attached to the `publishedAt`-write **branch** —
and one publish path legitimately doesn't write `publishedAt`.

**Fix shape:** one `applyPublishedAt(tx, versionId, publishedAt)` owning both the anti-bump SQL and the
materialize call, used by all four sites; plus a materialize in the scheduled-publishing job keyed off the
version's already-set `publishedAt`. The invariant becomes greppable: no raw `publishedAt` write outside the
helper.

### 1b. `publishModelVersionById`'s EA detection is a hand-rolled predicate read outside the transaction

[:1207-1214](../../src/server/services/model-version.service.ts#L1207) still does
`dbWrite.paidAccess.findFirst({ where: { ..., OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] } })` —
`findFirst` against a composite **primary key** (should be `findUnique`), a hand-rolled `OR` that restates
`isPaidAccessActive` (now that the helper exists, this is the odd one out), and the read happens *before*
the transaction opens, so the branch decision can be contradicted by the transaction. Every other money
guard in this file reads inside the tx and explains why; this one does neither.

### 1c. `publishModelVersionsWithEarlyAccess` returns `(Version | undefined)[]` and does four jobs

With `continueOnError: true` the catch swallows and the arrow returns `undefined`, so the caller at
[:1218](../../src/server/services/model-version.service.ts#L1218) destructures `const [updated]` and
null-checks it into `throwBadRequestError('Failed to publish model version.')` — erasing the real error. The
job caller ignores the return entirely.

The function also still carries NSFW validation, `cannotPublish` validation, the publish loop, a
`console.log(e.message)`, and an inline `e?.message?.includes('Insufficient funds to pay for early access.')`
**string match** on an error that can no longer originate here (charging moved to `earlyAccessPurchase`).
That branch and its transaction-timeout comment look like dead weight — worth confirming and deleting.

---

## 2. Validation for one field is spread across five layers — UNCHANGED

`paidAccess` is validated in `formEarlyAccessConfigSchema` + a `.refine`, `toPaidAccessInput`,
`modelVersionPaidAccessInputSchema`, `upsertModelVersionHandler`, the `early-access.ts` endpoint, and
`assertPaidAccessInput`. Two live defects fall out of the split.

### 2a. `permanent: true` is still unguarded on the tRPC path

The only guard is [early-access.ts:44](../../src/pages/api/v1/model-versions/early-access.ts#L44)
(moderator or `WEBHOOK_TOKEN`). `upsertModelVersionHandler`
([:386-405](../../src/server/controllers/model-version.controller.ts#L386)) has no equivalent, and **both**
user-level caps there are gated on `if (earlyAccessDays)` — which a permanent gate doesn't have. So:

```json
{ "paidAccess": { "permanent": true, "terms": { "download": { "price": 100 } } } }
```

through `modelVersion.upsert` sets a never-expiring paid gate while skipping the Creator-Program tier cap,
max-days, **and** max-concurrent-EA-models. `assertPaidAccessInput` passes it (permanent counts as gated and
there's a price). Nothing downstream objects.

The form can't produce it (`toPaidAccessInput` hardcodes `permanent: false`), but the tRPC procedure is the
API surface, not the form. The guard belongs where the input is validated — once — not on one transport.

### 2b. A blank access price still silently drops the gate

`accessPrice` is `z.number().optional()`; `withAsterisk` on the `InputNumber` is cosmetic in Mantine; and
[:113](../../src/components/Resource/Forms/ModelVersionUpsertForm.tsx#L113) is still:

```ts
if (timeframeDays <= 0 || config.accessPrice == null) return null;
```

Creator toggles "I want to charge for access", leaves the price blank, saves → `paidAccess: null` on the
wire → the version saves **ungated**, no error anywhere. The service guard that would catch it
(`assertPaidAccessInput`'s "you must charge for something") never fires, because `null` legitimately means
"not gated".

A transform that turns invalid input into a valid-looking "off" is the failure mode to design against. Make
`accessPrice` required whenever the config object exists, and never let `toPaidAccessInput` return null for
a config that reached it.

### 2c. The duplicated caps are now in **three** places

The maxDays + concurrent-models block is written in `upsertModelVersionHandler`, in `early-access.ts`, and
again in [comics.router.ts:644/661](../../src/server/routers/comics.router.ts#L644) — with different
predicates (`(!input.id || !activeEarlyAccess.some(...))` vs `!activeEarlyAccess.some(...)`) and different
error text for the same condition. One `assertUserEarlyAccessLimits({ user, versionId, paidAccess })` that
all three call.

---

## 3. `getResourceData` — five-pass in-place mutation pipeline — UNCHANGED

[generation.service.ts:1118-1374](../../src/server/services/generation/generation.service.ts#L1118).

- **The type still lies.** `transformGenerationData` returns
  `paidAccess: null as { endsAt; terms } | null` and `donationGoal: null as ...`
  ([:1153-1154](../../src/server/services/generation/generation.service.ts#L1153)). The declared type says
  populated; at that point it's always null and only becomes meaningful after
  `mergePaidAccessAndDonationGoals` mutates it. Any caller who uses `transformGenerationData` without the
  merge pass gets silent nulls — precisely the shape of the `paidAccessTerms` bug this branch already hit
  once.
- **`[...resources, ...substitutes]` is still rebuilt four times** in eleven lines
  ([:1349-1366](../../src/server/services/generation/generation.service.ts#L1349)).
- **Double negation:** `getEntityAccess` filters to `!x.hasAccess`, then the caller loops over *all*
  resources re-checking `if (!resource.hasAccess)` with an O(n) `entityAccess.find` inside.
- **The merge is unconditional** — two cache round-trips on every generation-resource lookup, including the
  overwhelmingly common ungated case. The reason for moving terms out of `resourceDataCache` (stale terms
  behind a 1h TTL) is sound and well-commented; the cost is now paid on the hottest path in the app with no
  early exit.
- **`donationGoal` is populated and still read by nobody.** Grep for consumers of
  `GenerationResourceBase.donationGoal` returns only the type declaration and the code that writes it.
  Extra fetch + extra payload per generation resource for an unused field.

Cleaner shape: fetch paid access + goals alongside `resourceDataCache.fetch` (they're independent), pass
them into `transformGenerationData`, return a fully-formed object. That removes the placeholders, the
mutation pass, and the type lie together.

---

## 4. `upsertModelVersion` — two ~130-line branches differing in ~15 lines — SLIGHTLY WORSE

[model-version.service.ts:355-659](../../src/server/services/model-version.service.ts#L355).

Inlining `ensureModelVersionDonationGoal` (a good change on its own) expanded the duplicated tail from 2
lines to 8, in both branches:

```ts
await writePaidAccessForModelVersion(version.id, paidAccess ?? null);
if (donationGoal)
  await ensureDonationGoal({
    entityType: 'ModelVersion', entityId: version.id,
    amount: donationGoal.amount, userId: model.userId,
  });
await Promise.all([preventModelVersionLag(...), bustMvCache(...), dataForModelsCache.refresh(...)]);
```

Both branches converge on `version` with the same shape, so all of this is common tail work that belongs
**after** the `if/else` — which also makes it structurally impossible for the two paths to diverge.

Also still open in this function:

- The `monetization` nested-write blob appears twice (once `create`, once `upsert` with `create` **and**
  `update` sub-blobs repeating the same four fields four times) — ~50 lines of ternary nesting that has
  nothing to do with paid access and is the main reason the function won't fit on a screen. Wants a
  `buildMonetizationWrite(existing, input)`.
- `cannotPublish` is checked twice, once per branch, against two different reads of the same model meta
  ([:421](../../src/server/services/model-version.service.ts#L421) and
  [:545](../../src/server/services/model-version.service.ts#L545)).

### 4a. The gate write is still outside the transaction it appears to belong to

The create branch runs `dbWrite.$transaction([...])`, then calls `writePaidAccessForModelVersion` **after**
it against the default `dbWrite`; same in the update branch. `writePaidAccessForModelVersion` and
`materializePaidAccessEndsAt` both still accept a `tx` that **no caller passes**, and `ensureDonationGoal`
still has one too. A failed gate write leaves a committed version with no gate.

Either thread `tx` through or delete the parameter — the signature currently advertises atomicity the call
sites don't use.

---

## 5. `hasEntityAccess` — five exit points rebuilding the result by hand — UNCHANGED

[common.service.ts](../../src/server/services/common.service.ts).

- Five separate `return ...map(...)` blocks, each hand-constructing
  `{ entityId, entityType, hasAccess, availability, permissions }` with different values and different key
  order; three are "grant everything" with different justifications.
- O(n²): `data.find(...)` inside `entityIds.map(...)`, twice, plus `entityAccess.find(...)`.
- **The `getPaidAccess` call still runs before every early exit**
  ([:132](../../src/server/services/common.service.ts#L132)) — above the
  `privateRecords.length === 0 || isModerator` fast path and above the owner fast path. On the dominant case
  (all-public, or a moderator) the fetch is performed and discarded. Cached, so cheap — but this is the
  access check on the generation and download paths. Move it below the fast exits or make it lazy.
- The 60-line chained-ternary `Prisma.sql` selector above it (seven entity types, identical three-column
  SELECTs) is pre-existing, but it's a lookup table written as an expression.

---

## 6. The form's boundary is three transforms and a lossy round-trip equality check — UNCHANGED

[ModelVersionUpsertForm.tsx:93-148](../../src/components/Resource/Forms/ModelVersionUpsertForm.tsx#L93).

Keeping a UX-shaped local field is a reasonable pattern; the problem is how many places know the mapping —
`toPaidAccessInput`, `toDonationGoalInput`, `toFormEarlyAccessConfig` (called in **three** places), a schema
built as `.omit({ paidAccess, donationGoal }).extend({ earlyAccessConfig: ...extend({ timeframe }) })`, and
a `VersionInput` that omits the write fields and re-adds the read shapes by hand.

The dirty check is the fragile part:

```ts
!isEqual(data.earlyAccessConfig, toFormEarlyAccessConfig(version?.paidAccess, version?.donationGoal))
```

It compares live form state against a **reconstruction** of what that state should have been — and the
reconstruction is lossy both ways: `toFormEarlyAccessConfig` substitutes `timeframeValues[0]` for a null
`timeframeDays` and `DEFAULT_GENERATION_TRIAL_LIMIT` for a missing `trialLimit`, while `toPaidAccessInput`
drops `generationPrice` when unset and drops the whole object when `accessPrice` is missing. The round trip
is not the identity, and any field added to one transform but not the other makes this check silently
wrong — and it decides whether the version gets saved at all.

Comparing `toPaidAccessInput(data.earlyAccessConfig)` against `version.paidAccess` instead removes the
asymmetry.

Smaller, same file: `disabled={!!version?.donationGoal || isEarlyAccessOver}` appears twice plus
`(version?.status !== 'Published' || version?.donationGoal) && features.donationGoals` gating the card —
three overlapping conditions for one rule ("the goal locks once it exists").

---

## 7. `checkDonationGoalComplete` — RESOLVED (structurally)

The raw PaidAccess write is gone, replaced by `endPaidAccessNow`, and the fail-open / fail-closed split is
now documented on **both** sides (the writer explains why it doesn't bust; the caller explains why the bust
is swallowed). This reads well.

One residual: the function still mutates `goal.active = false` in memory to keep its return value truthful
after the DB write, and still both closes the goal and orchestrates the gate end. Fine as-is — noting only
that the "check" name still undersells it.

---

## 8. Smaller knots — mostly RESOLVED

Fixed: `ensureModelVersionDonationGoal` inlined; the fabricated `version` row removed; the two doors into
the donation-goals cache merged (`getPublicDonationGoals` now routes through `getDonationGoals`); the four
goal-read paths consolidated onto `getDonationGoals` / `getOwnerDonationGoals`.

Still open:

- **`getUserEarlyAccessModelVersions`** ([:286](../../src/server/services/model-version.service.ts#L286))
  is still hand-written SQL with an inline `EXISTS ... pa."endsAt" > now()` — the SQL twin of the new
  `isTimedGateActive`. It also returns `{ id }[]` purely so callers can do `.length` and
  `.some(v => v.id === input.id)`.
- **`process-ending-early-access`'s marker-free idempotency** (`mv.publishedAt < pa.endsAt`, which stops
  matching once the republish bumps `publishedAt` past `endsAt`) is clever and well-commented, but it's an
  implicit invariant coupling two columns across two tables — and §1a's NULL-`endsAt` versions are invisible
  to it. Worth a test asserting the job is a no-op on a second run.
- **`process-scheduled-publishing`'s `extras` blob** still builds `hasEarlyAccess` and `earlyAccessEndsAt`
  via two separate correlated subqueries against the same `PaidAccess` row, and `earlyAccessEndsAt` is never
  read. One `LEFT JOIN`; drop the unused field. (`hasEarlyAccess` is `timeframeDays IS NOT NULL`, so
  permanent gates report false — behavior-preserving, but it reads like a bug on a column whose NULL means
  "permanent". Worth a comment either way.)

---

## 9. New in this pass — small, from the fixes themselves

None of these are defects; they're seams worth tightening while the code is fresh.

- **The two goal accessors have opposite "missing" contracts.** `getDonationGoals` **omits** ids for
  non-existent entities (deliberately — `getPublicDonationGoals` depends on it for its 404 via
  `if (!(id in goals))`), while `getOwnerDonationGoals` seeds **every** id to `null`
  ([:82](../../src/server/services/donation-goal.service.ts#L82)). Two sibling functions, same signature,
  same return type, contradictory semantics for the same condition — and one caller's 404 hangs on the
  difference. If the owner variant is ever used for a 404 path it will silently return 200. Worth aligning,
  or at minimum a one-line contract note on each.
- **`getOwnerDonationGoals` returns `PublicDonationGoal`.** The privileged read is typed with the type
  named "Public". Rename the type (`DonationGoalWithTotal`?) — it's not a public-only shape any more.
- **`earlyAccessPurchase` calls `getOwnerDonationGoals`** ([:1782](../../src/server/services/model-version.service.ts#L1782))
  on a **buyer** path, then narrows with `ownerGoal?.active ? ownerGoal : null`. It's correct (the value
  only decides whether to call `checkDonationGoalComplete`, and nothing leaks to the response), but a
  function documented "Callers MUST gate on ownership/moderator — never hand this to an anonymous viewer"
  being called from the purchase path is exactly the kind of thing a future reader will either break or
  mistake for a bug. Either use the entity read (`donationGoalByEntity`) there or add a line saying why this
  is safe.
- **`getDonationGoals` calls `getPaidAccess` internally**, and both `getModelHandler` and `loadModelVersion`
  also call `getPaidAccess` directly in the same request. Cached, so ~free — but the double call means the
  two can observe different snapshots if a bust lands between them.
- **`isTimedGateActive` exists but the same expression is still spelled out** three lines below its own
  import in [donation-goal.service.ts:47-49](../../src/server/services/donation-goal.service.ts#L47):
  `const endsAt = row && isPaidAccessActive(row) ? row.endsAt : null; ... goal && endsAt && endsAt > now`.
  That's `isTimedGateActive(row)` written longhand.
- **"Every PaidAccess writer busts" is no longer a greppable invariant** — `endPaidAccessNow` deliberately
  doesn't, for a documented and correct reason. Fine, but the exception now needs to stay documented at the
  call site too (it is, today).

---

## Suggested order

1. **§1a** — scheduled EA versions becoming permanent gates. Silent, accumulating data corruption.
2. **§2a** — `permanent: true` unguarded on tRPC. Bypasses the CP tier cap and both EA limits.
3. **§2b** — blank access price silently saves an ungated version.
4. **§1** — collapse the four anti-bump copies into one `applyPublishedAt` that owns materialization.
5. **§4** — hoist `upsertModelVersion`'s common tail out of both branches; extract the monetization blob.
6. **§3** — pass paid access into `transformGenerationData` instead of mutating placeholders after;
   drop the unused `donationGoal` from the generation payload.
7. **§2c, §5, §6, §8, §9** — deduplicate the caps, move the `getPaidAccess` call below the fast exits,
   fix the dirty check, clear the remaining knots.
