# Monetization rules: paid access, licensing fees, donation goals

How the four monetization concepts on a model version interact. Written 2026-08-05 from the code, with
the surprising claims verified against the prod replica; R3 rewritten 2026-08-21, 2026-08-24 and
2026-08-25 for the monetization revamp. Where a rule is enforced matters as much as what
it is — several are enforced in only one of two write paths, and those are called out.

**Scope**: `ModelVersion` only. `ComicChapter` has its own gate and is not covered here.

---

## The four things

| Concept           | Stored                      | What it is                                                                                |
| ----------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| **Usage control** | `ModelVersion.usageControl` | Whether buyers get files, on-site generation, or both. The axis the others price against. |
| **Paid access**   | `PaidAccess` row            | A gate. Two kinds, below.                                                                 |
| **Licensing fee** | `ModelVersion.licensingFee` | Buzz the creator earns _per generation_ by others. Independent of any gate.               |
| **Donation goal** | `DonationGoal` row          | A community target that, when met, ends a _timed_ gate early.                             |

### Usage control

Two creator-settable values (`CREATOR_USAGE_CONTROLS`): `Download` (download + on-site generation) and
`Generation` (on-site only). Two further values exist for moderators/API and are **not** editable in the
studio — the editor shows a banner instead of a picker so it can't silently downgrade them.

A gate always prices the surviving tier: a `Generation` version charges via the generation price, a
`Download` version via the download price.

When that conflicts — a gen-only version carrying a download tier — the price **migrates** to the surviving
tier rather than the write being refused. Both apps go through `migrateTermsForUsageControl`, so this is a
global rule, not a Creator Studio behaviour.

### Paid access — two kinds, one table

Distinguished by `timeframeDays`:

- **Timed ("Early Access")** — `timeframeDays` set. Ends on its own; the version becomes free.
- **Permanent ("Paid Access")** — `timeframeDays IS NULL`. Never ends.

**`endsAt` discriminates nothing on its own.** A NULL `endsAt` means _either_ of two unrelated things:

- a **permanent** gate — it has no end date by definition, or
- a **timed** gate that hasn't started — `endsAt` is materialized at publish
  (`materializePaidAccessEndsAt`), so a pending window carries NULL until then.

It never means "no gate" — that's the absence of the row. This is why `isPermanentGate` keys off
`timeframeDays` and why "currently gated" needs both columns:

| Want                                      | Test                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Is it permanent?                          | `timeframeDays IS NULL`                                                            |
| Is it a timed window that hasn't elapsed? | `timeframeDays IS NOT NULL AND (endsAt IS NULL OR endsAt > now())`                 |
| Is it gated at all right now?             | row exists AND `(endsAt IS NULL OR endsAt > now())` — this is `isPaidAccessActive` |

The third row needs no `timeframeDays` clause because a permanent gate always has a NULL `endsAt`.

**Expiry never deletes the row** (`process-ending-early-access` says so explicitly), so an expired gate is a
**tombstone** — present, `timeframeDays` set, `endsAt` in the past — and `timeframeDays != null` alone does
not mean "has a window". Three other paths _do_ delete it: clearing the gate, deleting the version, and
merging versions. Clearing also resets `availability` from `'EarlyAccess'` to `'Public'`; without that
reconciliation non-buyers stay locked out permanently.

---

## Rules

### R1. A timed window can only be _started_ on a version that has never been published

The window is meant to precede release. After publish it would gate what the audience already has, and on
expiry `process-ending-early-access` bumps `publishedAt` — resurfacing an old model as "New".

**The test is `initialPublishedAt <= now() OR status = 'Published'`.**

- **Not `publishedAt`** — the expiry job rewrites it on republish. tens of thousands of versions already have the two diverged.
- **`<= now()` matters** — the `set_initial_published_at` trigger copies _future_ timestamps, so a
  Scheduled version carries an anchor for a release that hasn't happened. Without the comparison, the
  pre-release case the feature exists for is refused.
- **`status` alone is wrong in the other direction** — a large number of `Unpublished` and `Draft` versions have been published before.

**Carve-out**: a version with an **active** timed window may be re-priced. That's an edit, not a start.
Tombstones don't qualify.

**Enforced**: `assertUserEarlyAccessLimits` (`src/server/services/model-version.service.ts`), which both
the REST endpoint and tRPC `modelVersion.upsert` call. Moderators are exempt.

### R2. Permanent access is legal on a published version

Paywalling an already-released model is an intentional product capability. Only the _timed_ kind is
publish-restricted.

### R3. Membership limits how OFTEN you may price, not how much

| Limit                     | Source                              | Applies to                    |
| ------------------------- | ----------------------------------- | ----------------------------- |
| Eligibility (score ≥ 10k)  | **Creator score** (`models` score)  | A new fee or a new gate       |
| New prices per month      | **Membership tier**                 | A new fee or a permanent gate |
| Licensing fee ceiling     | Flat 100/generation × media type    | Fees                          |
| Paid access price ceiling | — none                              | —                             |
| Window length (days)      | **Creator score**                   | Timed                         |
| Concurrent windows        | **Creator score**                   | Timed                         |

Every creator gets the same fee ceiling — `maxLicensingFeeCeiling`, 100 per generation and 500 on a
video model. Paid access has no ceiling at all. What a tier buys is **allowance**:
`monthlyPricingAllowance` — free 3, bronze 10, silver 25, gold unlimited.

**A lapse cannot change any price, but it lowers the allowance immediately.** `getCapTier` reads live
subscription state at write time, and `incomplete`/`past_due`/`unpaid` all count as lapsed, so a
membership ending mid-month drops that month's allowance to free's from that moment — in the main app.
Creator Studio resolves the tier from the session instead (4h TTL, busted by
`invalidateSubscriptionCaches`), so its own writes can honour the old allowance for up to that long.
Slots already spent stand: a creator who spent 8 as bronze and lapses on the 8th sets nothing new until
the month turns, or until clearing prices releases enough slots (R3b) to get back under 3. An unknown or
absent tier resolves to the FREE allowance rather than zero, so losing a membership never takes away the
ability to price at all. No path that reads a *price* resolves a subscription tier any more —
`getViewerMonetization` reads the gate rows and returns the stored numbers. The one read that still
resolves a tier is `modelVersion.getPricingAllowance`, which reports the allowance and names no price.

Considered and declined (2026-08-25): granting the lapsed tier's allowance for the whole calendar month
it lapsed in, which would fix the involuntary case (a failed card is the most common mid-month drop).
Gold is **unlimited**, so "held it at any point this month" would mean unlimited pricing for that month
off one payment. Left as-is deliberately; revisit with that cost in view.

**Membership tier does not unlock early access.** The ladder reads `User.meta.scores.models` and starts at
40,000, so simulating a tier will never reach it — the studio has a separate moderator-only score simulator
for this reason. The one non-score unlock is the **granted `thirtyDayEarlyAccess` feature flag**, which by
itself confers the top rung (30 days, 30 concurrent) at any score.

The fee ceiling blocks **raises only** (`raisesOverCap`): a stored price above it stays chargeable, so a
max must never clamp below the stored value or an unrelated edit silently cuts a grandfathered price.

One exception: a write that moves the version onto a **stricter media axis**. 500 is legal on a video
model and 5x the ceiling on an image one, so that write faces the ceiling outright even though the
number did not rise. The test is the fee the write *leaves behind*, not the one it names — an upsert
that omits `licensingFee` keeps the stored one, and the base model can still move under it.

#### R3a. Both rules turn on ONE question: is this version newly priced?

A "price" is a licensing fee or a **permanent** gate. A timed early-access window is neither — it prices
itself out when the window closes, and is already gated on a far higher creator score of its own.

Applying a price to a version that has none requires the score floor and spends a slot. Editing,
lowering, or clearing a price that is already set spends nothing and needs no score — and clearing the
last one may hand the slot *back* (R3b). That exemption is what grandfathers everything priced before
these rules existed, and it is why the cutover needed **no backfill**.

The two rules read that question from different places, deliberately:

- **Eligibility reads current state** — does this version carry a fee or a `PaidAccess` row right now.
  Grandfathering attaches to a price that is still set, so no history is needed.
- **The allowance reads the `PricingSlot` ledger** — what has been *spent* this calendar month. That
  needs a record, because a gate created and deleted inside the month usually still spent its slot —
  the row survives unless the release conditions in R3b are met.

⚠️ A creator below the floor who **clears** a price cannot re-apply it: current state no longer shows
one, so re-application is a new price. That follows from "no new fee below the floor" read literally.

#### R3b. One slot per entity, returned only if the last price comes off untouched

`PricingSlot` is keyed `(entityType, entityId)` — the same key as `PaidAccess`, so it already covers
ComicChapter. The primary key IS the idempotency while a price stands: a fee added beside an existing
gate, or any edit to a price already set, finds the row there and costs nothing.

**Clearing the LAST price off a version deletes its slot**, if nothing has transacted against it: no
`EntityAccess` row held by anyone but the owner, and no licensing fee charged since the slot was
created. Deleting the row is what "returned" has to mean for an allowance that counts rows created this
calendar month. Removing one of two prices returns nothing — the version is still priced. So a price
cleared and re-applied inside one month spends a second slot when the release succeeded, and nothing
when it did not.

Clearing a price set in an **earlier** month deletes the row but returns nothing — the count is of rows
created this month, and that one was not. Nothing is lost either: this month's allowance was never
reduced by it. Refunding across the boundary is exactly what would let allowance carry forward.

The transaction test reads `orchestration.resourceCompensations` in ClickHouse, bounded on the slot's
own `createdAt` and raced against a 3s timeout, falling back to the daily
`ModelVersionMetric.earnedAmount` mirror when ClickHouse cannot answer. Both fail **closed** — an
unanswerable question leaves the slot spent. A version that was never published skips the fee test
entirely: no buyer could reach it and no generation could charge for it.

There is deliberately **no foreign key to the entity**. The key is polymorphic, so there is nothing to
point at, and the consequence is wanted — deleting a version does not refund its slot. Rows that outlive
their entity are inert, because the count is scoped to the current month.

**A model transfer deletes the slots on its versions** rather than moving them, and it is the one case
where a stranded row would *not* go inert — the entity outlives it. Moving `ownerId` would charge the
recipient for a pricing they never made (what #4309 rejected for `PaidAccess` in the other direction);
leaving it makes the row unreleasable (release refuses on an owner mismatch) *and* un-insertable (the
key is the entity alone), which would let the recipient re-price that version forever without it ever
counting against their allowance.

**Moderators are not exempt** from either the floor or the allowance. That is the one creator-score gate
in the codebase they do not bypass: the floor is a statement about who may sell, not a permission level.
They remain exempt from the fee ceiling.

**Enforced**: `assertMonetizationWrite` (`src/server/services/paid-access.service.ts`), called by tRPC
`modelVersion.upsert` and the REST early-access endpoint, and mirrored for Creator Studio's direct-SQL
writes in `apps/creator-studio/src/lib/server/monetization/pricing-slot.ts`. Three write surfaces, so a
rule enforced in only one of them is not enforced.

### R4. Licensing fees are independent of gates

A fee is charged per generation by _other_ people; a gate is charged once to _the buyer_. A version can
have both, either, or neither.

The one coupling is payout: a version charging a licensing fee is **opted out of tips + creator
compensation** for that generation — it earns through the fee channel instead. A lineage fee inherited
from a source rule settles to a different creator and does **not** opt this version out.

### R5. Rights affirmation gates _starting_ monetization, never stopping it

Required the first time a version charges anything, recorded per version with the wording stored
verbatim. Never required to clear a fee, remove a gate, or set a duration of 0.

**An affirmation expires two ways**: bumping `MONETIZATION_RIGHTS_AFFIRMATION_VERSION` invalidates every
stored record, and the check is scoped to `ownerId` — so an affirmation **does not survive an ownership
transfer**.

In bulk, it's demanded whenever **any** selected version lacks one; versions already affirmed are skipped
server-side. Ids outside the current page are conservatively treated as needing one.

### R6. Donation goals

- Attached per version, addressed by `(entityType, entityId)`, with a **legacy `modelVersionId` column
  still dual-written** — any query must check both or it misses pre-re-key rows.
- **Create-once.** The endpoint never updates or removes one, and `active: false` is written in exactly
  one place: goal completion. **There is no cancel path**, for creators or moderators.
- **Early-access purchases count toward the goal.** Every purchase writes a `Donation` row for the full
  amount and then trips the completion check. A goal can therefore complete on sales alone. In practice the overwhelming majority of what sits against these goals came from purchases, not donations.
- **On completion**, the goal closes and _a timed gate ends immediately_. A **permanent gate is exempt** —
  by design (`isTimedGateActive`), so a funded goal cannot wipe a permanent paywall.

---

## Interactions

### Usage control × an existing gate

Changing usage control **moves the price to the surviving tier** — it does not refuse, and it does not
change the gate kind. Both the bulk path and the single-version editor go through the same
`bulkSetUsageControl`, so they cannot diverge.

- → `Generation`: the generation price survives; if unset, the download price becomes it.
- → `Download`: the download price survives; if unset, the generation price becomes it. **Those versions
  then sell downloads at a price the creator never chose** — the studio surfaces this after the write.
- Switching a version that gives generation away free to `Generation` **removes the free grant** — it
  can't both charge via generation and give it away. Disclosed with the affected list before applying.

Every live gate carries at least one price, so a migration always has something to move.

### Timed ↔ permanent

- Timed → permanent is allowed. It spends a pricing slot if the version is not already priced (R3b),
  and there is no price ceiling to satisfy.
- Permanent → timed is **refused on a published version** by R1, since a permanent gate is not an active
  timed window. This refuses a strictly _less_ restrictive change; deliberate but worth revisiting.
- When it does go through, `endsAt` is derived from the version's **existing `publishedAt`**, not from now —
  so on a long-published version it lands in the past and the gate is **born a tombstone**, silently ending
  paid access. R1 blocks that for creators; **moderators are exempt and can do it without an error**.

### Gate × donation goal

A goal only means anything on a timed gate. Switching to permanent **does not deactivate the goal** — the
write path treats a null goal as a no-op — so it stays `active` and keeps accruing from sales toward an
unlock that can never happen. It does so **invisibly**: the public read filters goals on
`isTimedGateActive`, so no viewer sees it; only the owner's edit form does. **754 permanent-gated versions
are in this state today.**

Nothing stops a goal being _created_ on a permanent gate either — `writeModelVersionGateAndGoal` never
checks `permanent`. Only the studio suppresses it.

**Standing product decision (Justin, 2026-08-05): leave donation goals exactly as they are.** A rule
blocking the switch was considered and rejected pending a creator survey. Do not build one.

### Gate × licensing fee

No interaction on the write path. Both can be set on the same version; the payout consequence in R4 is
the only coupling.

---

## Where each rule is enforced

Two write paths reach a **gate**: the REST endpoint `/api/v1/model-versions/early-access` (what Creator
Studio calls) and tRPC `modelVersion.upsert` (what the main app's form calls). **A rule enforced in only
one of them is not enforced.**

**Licensing fees and usage control are a third path.** Creator Studio writes both **directly to Postgres**
via kysely — they never reach the main app, so any rule about them has to be implemented there too. The
affirmation check on that path is owner-scoped, matching `resolveRightsAffirmation`.

| Rule                              | Lives in                                      | Covers every path |
| --------------------------------- | --------------------------------------------- | ----------------- |
| R1 publish restriction            | `assertUserEarlyAccessLimits`                 | ✅                |
| Window length + concurrent caps   | `assertUserEarlyAccessLimits`                 | ✅                |
| Fee ceiling                       | `assertMonetizationWrite` + the spoke's `licensing-fee.ts` | ✅ (see below) |
| Eligibility floor + allowance     | `assertPricingAllowed`                        | ✅ (see below)    |
| Rights affirmation                | `resolveRightsAffirmation`                    | ✅                |

Four rules have **two implementations each**, because Creator Studio's fee and gate writes are direct
SQL that never reaches the service layer: the fee ceiling (`assertMonetizationWrite` vs the spoke's
`licensing-fee.ts`), the eligibility floor and the allowance (`pricing-slot.service.ts` vs the spoke's
`pricing-slot.ts`), and slot release — `versionHasTransacted`/`releasePricingSlot` against
`releasableVersionIds`/`releasePricingSlots`, each with its own ClickHouse query over
`orchestration.resourceCompensations`. Keep each pair in step — a divergence makes the spoke a way
around whichever rule it drops, which is the same failure the POI guard has already had here.

---

## Known gaps

- **Active donation goals accumulate on versions with no gate at all** — goals are never
  deactivated when a window ends naturally.
- **Some currently-gated versions have no rights-affirmation record**, predating the requirement. Any
  write path that re-saves their gate without passing an affirmation will 400.
- **`paidAccessToConfig` still returns `donationGoalEnabled: false`** — the models-page loader patches it
  from a `DonationGoal` subquery, so the sidebar's lock engages. The CSV export doesn't use that flag; it
  reads the goal columns from its own join.

The full findings list and its status are kept privately — ask a maintainer.
