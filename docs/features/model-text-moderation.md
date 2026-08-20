# Model Text Moderation

**Status**: Planned
**Tracking**: CU 868ktb1wb
**Last Updated**: 2026-08-19

Moves model name + description moderation onto the shared XGuard `EntityModeration`
pipeline, replacing the two mechanisms that handle it today.

---

## Why

Model text is moderated by two independent systems, neither of which produces a usable
outcome:

| Mechanism | Where | Outcome |
|---|---|---|
| Profanity filter | `model.service.ts` → `upsertModel`, synchronous | Sets `nsfw = true` + locks the property |
| Clavata | `jobs/entity-moderation.ts`, cron over `JobQueue` | Creates a `Report(reason: Automated)` |

The profanity filter is density-gated: it fires on a *proportion* of flagged words, so a
single unambiguous term in a title can never trigger it regardless of what the term is.
The Clavata path writes into an automated-report queue that is not drained.

Neither system has any notion of the non-sexual policy axes (youth signals, bestiality,
extremism, staff impersonation) that XGuard already classifies for articles, challenges,
wildcard categories, and App Block text output.

## What this replaces

- **Removed**: the profanity-filter branch in `upsertModel`. `bounty.service.ts` keeps its
  own copy — out of scope here.
- **Removed**: `Model` from the `queues` map and from `allowedNSFWTypes` in
  `jobs/entity-moderation.ts`, after the XGuard path is verified in production.
- **Added**: a `Model` entry in the moderation-adapter registry.

Net: one pipeline, one source of truth (`EntityModeration`), one audit trail.

---

## Architecture

No new infrastructure. `Model` becomes another `entityType` on the existing pipeline:

```
upsertModel ──> submitTextModeration({ entityType: 'Model', ... })
                      │
                      └─> createXGuardModerationRequest
                            ├─ contentHash dedup (skip unchanged text)
                            ├─ EntityModeration upsert (Pending / Failed)
                            └─ orchestrator workflow + callback
                                    │
      /api/webhooks/text-moderation-result <───────┘
                      ├─ recordEntityModerationSuccess (workflowId-gated)
                      ├─ recordXGuardScanFromWorkflow (audit log)
                      └─ getModerationAdapter('Model').applyResult(...)
```

Everything above the adapter is entity-agnostic and already shipped. `EntityModeration.entityType`
is a plain `String` column, so no schema change is required.

Inherited for free: contentHash dedup, stale-callback gating, the
`retry-failed-text-moderation` cron, `scanner_label_results` audit rows, and the moderator
focused-review UI at `/moderator/scanner-audit/text/<label>`.

## The adapter

Lives in `src/server/services/model-moderation.adapter.ts`, registered in
`moderation-adapters.ts` alongside `Article`, `Challenge` and `WildcardSetCategory`.

**`resolveContent`** — `[name, removeTags(description)].filter(Boolean).join(' ')`.

> Must produce byte-identical output to what the submit path sends, or the `contentHash`
> dedup can never hit and the retry cron re-audits already-scanned models. Same constraint
> the Article adapter documents.

**`submit`** — submits the full label set, matching the App Block text-output scan
(`TEXT_OUTPUT_SCAN_LABELS`). Scanning labels we do not act on is deliberate: the per-label
trigger rates on real model text are the input to deciding what a v2 acts on, and there is
no way to collect them without scanning.

**`applyResult`** — v1 acts on exactly one axis. Triggering any of `suggestive`, `explicit`
or `nsfw` sets:

```ts
{ nsfw: true, lockedProperties: uniq([...stored, 'nsfw']) }
```

then calls `updateModelNsfwLevels([id])`. Every other triggered label is recorded on
`EntityModeration.triggeredLabels` + the audit log and takes no action.

Two rules carried over from the profanity path:

- A stored `nsfw` lock is a moderator's call (minor-flagging sets it `false`). Record the
  detection, never overturn the lock — see `enforceLockedProperties`.
- Moderator-authored saves are not scanned.

**`applyFailure`** — no-op beyond the `EntityModeration` row the webhook already wrote. A
model's visibility does not gate on its text scan, so a terminal failure leaves the model
exactly as it was and the retry cron picks it up.

### Verdict is recomputed, never read from `blocked`

The adapter derives its own verdict from per-label results and ignores XGuard's top-level
`blocked` field, mirroring `wildcard-category-audit.service.ts`. Submitting labels the
adapter does not act on must not be able to change the outcome, and `blocked` folds in
labels outside the v1 scope.

---

## Two decisions this encodes

**1. `Model.nsfw` + `lockedProperties` is the mechanism — no new column, no moderation floor.**

`updateModelNsfwLevels` derives a model's level as `bit_or()` over its published versions,
overridden wholesale when `nsfw = true`. Unlike `Article`, there is no composable floor to
raise, and adding one would mean touching the recompute every model write goes through.
Reusing the boolean keeps behaviour identical to what the profanity filter does today —
only the detector changes.

**2. Text moderation raises a flag; it does not rate the model.**

A model's rating comes from its images. The text scan can only assert that the *stated
purpose* of the model is adult, which is what `nsfw = true` already means. It is not a
substitute for image-derived levels and must not be described as one.

---

## Feature flags

Two flags, both **default-off**, both evaluated through `isFlipt` from
`~/server/flipt/client` — the background-path helper, not the request-scoped
`feature-flags.service`, because the adapter runs from a webhook with no session.

```ts
MODEL_TEXT_MODERATION_XGUARD       = 'model-text-moderation-xguard'
MODEL_TEXT_MODERATION_XGUARD_APPLY = 'model-text-moderation-xguard-apply'
```

| flag | gates | off means |
|---|---|---|
| `…_XGUARD` | every submit path — `upsertModel` **and** the adapter's `submit` hook, which the retry cron drives | no scan is requested at all |
| `…_XGUARD_APPLY` | the `nsfw` write in `applyResult` | scan runs, verdict is recorded to `EntityModeration` + the audit log, nothing is written to the model |

**Both fail closed.** `isEnabled` returns `false` when the client is uninitialised, when
evaluation throws, and for an unknown flag key. For a path that auto-restricts other
people's models, not flagging is the safe failure — same reasoning as
`MINOR_HASH_AUTO_FLAG`, which gates the closest existing feature.

### Keyed on `modelId`, not `userId`

`isEnabled(flag, entityId?, context?)` takes an entity key (default `'global'`). Pass
`String(model.id)`:

```ts
await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_TEXT_MODERATION_XGUARD, String(model.id))
```

A percentage rollout then selects a deterministic, sticky subset of models. Keying on the
author instead would move a model in and out of the treatment as ownership or session
context changed, and would correlate the sample with user behaviour rather than spreading it
across content.

### Why the apply gate is separate

The interesting comparison — does XGuard catch what the profanity filter catches, plus what
else, at what false-positive rate — needs scans flowing *before* anything changes for users.
Splitting submit from apply gives a real shadow phase: `EntityModeration` rows and audit rows
accumulate against live traffic while the old implementation stays solely in charge of the
`nsfw` column.

It also produces the per-label trigger rates that the "scan 15, act on 3" decision is waiting
on, on real model text rather than a hand-picked sample.

Ramp order: `…_XGUARD` to 100% and hold → read the comparison → then ramp `…_XGUARD_APPLY`.

One consequence of gating the adapter's `submit` hook: while `…_XGUARD` is off, the retry
cron finds `Model` rows to retry, gets nothing back, and counts them in its `errors` metric
without advancing their `retryCount`. They neither drain nor spend. This only arises after a
rollback — before the flag's first activation there are no `Model` rows to retry at all.

The backfill endpoint is deliberately exempt from both flags, so a backfill run performed
during a rollback still submits; any of its rows that fail, however, will not be retried
until the submit flag is back on.

⚠️ **Turning the apply flag on does not retroactively apply anything.** A model scanned while
apply was off has already had its one callback; nothing re-delivers it. Models scanned during
the shadow phase need the backfill (which re-submits with `forceRescan`) or they keep their
pre-existing rating. Run the backfill *after* the apply flag is up, not before.

### The old implementation is untouched while flags are off

The profanity branch and the Clavata queue keep running for every model throughout the ramp —
they are not gated, and are removed only at steps 4 and 5. Running both is safe: both write
`nsfw = true` and lock the same property, so the write is idempotent, and Clavata's output is
a report row with no automated consumer.

The cost is that a model the profanity filter already flagged reaches `applyResult` with the
work done. That does not corrupt the comparison — the XGuard verdict is recorded on
`EntityModeration` independently of whether it caused the write.

### Creating the flags

Flipt here is **v2, GitOps-backed**: `create` / `enable` / `disable` / `delete` through the
API return 501, and the `flipt` skill refuses those verbs by design. Both flags have to land
as a merged change in the Flipt state repo before either can be turned on — ask an infra
owner for that repo and the change process. Until they exist, `isFlipt` returns `false` for
the unknown key, which is the intended dark state, so the code can ship first.

## Backfill

One-off pass, run from `src/pages/api/admin/temp/`.

Candidate selection is a term match over `name` + `description`; **the term selects, XGuard
decides**. No verdict is ever inferred from the term itself, so the selector can be widened
later without becoming a policy surface. Rows already carrying a moderator `nsfw` lock are
skipped.

The endpoint is deliberately **not** gated on either feature flag, and submits with
`forceRescan: true`. Gating it would make it useless in the two situations it is most needed:
re-running the set after the apply flag goes up, and re-running it after the flags have been
switched back off during a rollback. (Same reasoning as `minor-hash-sweep`, which is exempt
from `MINOR_HASH_AUTO_FLAG` for exactly this.)

Submissions are throttled and go out at `priority: 'low'` so the backfill cannot starve
live traffic. Results land through the same webhook as everything else.

A full sweep over all published models is deliberately **not** part of this — size it once
live per-label trigger rates exist to extrapolate from.

---

## Rollout order

1. Land both flags in the Flipt state repo. Ship the adapter + submit path, dark.
2. Ramp `…_XGUARD` (1% → 5% → 25% → 100%). Shadow phase: scans accumulate, nothing changes
   for users. Profanity + Clavata still solely in charge.
3. Read the comparison — XGuard vs. the profanity filter on the same models, and per-label
   trigger rates for the 12 labels v1 does not act on.
4. Ramp `…_XGUARD_APPLY`. First point at which a model's `nsfw` can change.
5. Run the backfill.
6. Remove the profanity branch from `upsertModel`.
7. Drop `Model` from Clavata's `allowedNSFWTypes`. The `queues` entry **stays** — `JobQueue`
   rows for `Model` come from a database trigger and are deleted only inside `runClavata`, so
   removing the entry would leave them accumulating and require a manually-applied migration to
   drop the trigger. Keeping it drains the queue with no infrastructure change while NSFW-only
   matches stop producing reports.

Steps 6 and 7 are separate commits from step 1 so either can be reverted without taking the
new pipeline with it, and neither should land until `…_XGUARD_APPLY` has held at 100% long
enough to trust. Until then the flags are the rollback: switch both off and the old
implementation is still the only thing writing `nsfw`.

### What removing `Model` from Clavata does and does not affect

`autoMuteIfScamAccount` is gated on `autoMuteEntityTypes = ['Chat', 'Comment', 'CommentV2']`
and returns early for every other type, so it has never run for models. Step 5 cannot affect
it.

There is no Clavata policy specific to models: the Redis config maps a single policy id
across all thirteen moderated entity types. Its rule set was recovered from stored verdicts
and compared against the XGuard text labels; the comparison and the residual differences are
in the local calibration doc. Nothing in the difference is currently consumed — no automated
model report has ever been actioned — so step 5 removes a signal with no downstream reader.

## Open items

- A moderator-triggered rescan (`forceRescan: true`, as `rescanArticle` does) is not in v1.
  Add it when mods need to re-run a model after a policy change.
- Derived labels (`applyDerivedLabels`) are opt-in per adapter and are **not** wired in v1.

## Related

- [Article Content Scanning](../article-content-scanning.md) — the first consumer of this pipeline
- `src/server/services/blocks/steps/text-output-moderation.ts` — the differential-action label model
- `src/server/services/wildcard-category-audit.service.ts` — the recompute-your-own-verdict pattern
