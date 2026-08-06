# Monetization rules: paid access, licensing fees, donation goals

How the four monetization concepts on a model version interact. Written 2026-08-05 from the code, with
the surprising claims verified against the prod replica. Where a rule is enforced matters as much as what
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

- **Not `publishedAt`** — the expiry job rewrites it on republish. 27,101 versions already have the two
  diverged.
- **`<= now()` matters** — the `set_initial_published_at` trigger copies _future_ timestamps, so a
  Scheduled version carries an anchor for a release that hasn't happened. Without the comparison, the
  pre-release case the feature exists for is refused.
- **`status` alone is wrong in the other direction** — 121,096 `Unpublished` and 1,615 `Draft` versions
  have been published before.

**Carve-out**: a version with an **active** timed window may be re-priced. That's an edit, not a start.
Tombstones don't qualify.

**Enforced**: `assertUserEarlyAccessLimits` (`src/server/services/model-version.service.ts`), which both
the REST endpoint and tRPC `modelVersion.upsert` call. Moderators are exempt.

### R2. Permanent access is legal on a published version

Paywalling an already-released model is an intentional product capability. Only the _timed_ kind is
publish-restricted.

### R3. Caps come from two unrelated places

| Cap                   | Source                                        | Applies to           |
| --------------------- | --------------------------------------------- | -------------------- |
| Price ceiling         | **Membership tier** × media type              | Permanent gates only |
| Permanent slots       | **Membership tier**                           | Permanent gates      |
| Window length (days)  | **Creator score** (`models` score)            | Timed                |
| Concurrent windows    | **Creator score**                             | Timed                |
| Licensing fee ceiling | **Membership tier** × model type × media type | Fees                 |

**A timed window has no price ceiling at all** (`monetizationLimits` returns `maxPrice: null` when
`!permanent`). The cap machinery only exists on the permanent branch.

**Membership tier does not unlock early access.** The ladder reads `User.meta.scores.models` and starts at
40,000, so simulating a tier will never reach it — the studio has a separate moderator-only score simulator
for this reason. The one non-score unlock is the **granted `thirtyDayEarlyAccess` feature flag**, which by
itself confers the top rung (30 days, 30 concurrent) at any score.

Price ceilings block **raises only** (`raisesOverCap`): a stored price above the cap stays chargeable, so a
max must never clamp below the stored value or an unrelated edit silently cuts a grandfathered price.
**Exception**: the studio's _bulk_ permanent-access guard is a flat ceiling, not a raise check, so
bulk-re-saving a grandfathered over-cap price is refused there even though the single-version path allows
it.

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
  amount and then trips the completion check. A goal can therefore complete on sales alone. Verified:
  of 41.5M Buzz sitting against goals on permanent-gated versions, **41.30M (99.5%) came from buyers**,
  not donors.
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

Verified: of 3,188 live gates, **none** has neither price, so a migration always has something to move.

### Timed ↔ permanent

- Timed → permanent is allowed (subject to slots/price cap).
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

| Rule                                                 | Lives in                      | Covers both paths    |
| ---------------------------------------------------- | ----------------------------- | -------------------- |
| R1 publish restriction                               | `assertUserEarlyAccessLimits` | ✅                   |
| Window length + concurrent caps                      | `assertUserEarlyAccessLimits` | ✅                   |
| Price + permanent-slot caps                          | `assertPaidAccessCaps`        | ✅                   |
| Rights affirmation                                   | `resolveRightsAffirmation`    | ✅                   |
| "Permanent only from Creator Studio" (webhook token) | the REST endpoint             | ❌ **endpoint only** |

Client-side checks in either app are affordances, not controls — the studio posts to the same endpoint a
creator can call with a session cookie.

---

## Known gaps

- **17,259 active donation goals are attached to versions with no gate at all** — goals are never
  deactivated when a window ends naturally.
- **1,715 currently-gated versions have no rights-affirmation record**, predating the requirement. Any
  write path that re-saves their gate without passing an affirmation will 400.
- **The webhook-token restriction on permanent access is endpoint-only**; tRPC upsert can set
  `permanent: true` without it, bounded only by the tier slot cap (3 even on free).
- **`paidAccessToConfig` still returns `donationGoalEnabled: false`** — the models-page loader patches it
  from a `DonationGoal` subquery, so the sidebar's lock engages. The CSV export doesn't use that flag; it
  reads the goal columns from its own join.

See [paid-access-issues-2026-08-05.md](../paid-access-issues-2026-08-05.md) for the full list and status.
