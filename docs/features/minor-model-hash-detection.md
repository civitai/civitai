# Minor Model Hash Detection

Flag re-uploads of models a moderator already marked as minor, matched by SHA256 file identity.

## Overview

When a moderator marks a model as minor, that decision applies to one `Model` row — nothing stops the
same file being re-uploaded as a new model. This system treats the SHA256 of the model file as the
identity of the content, and reacts when a hash tied to a human minor decision shows up again:

- **Same uploader** — auto-flagged minor, no human in the loop, then surfaced for review.
- **Different uploader** — never auto-flagged. Queued for a moderator, because a hash proves file
  identity, not that the same person uploaded it.

Both unattended paths are behind one Flipt kill switch and ship **default-off**.

## Key Files

| File | Purpose |
|------|---------|
| `src/server/services/minor-hash.service.ts` | All matching, sweep, review-queue and rollback logic |
| `src/server/services/model-file-scan.service.ts` | `applyScanOutcome` — the scan-time hook |
| `src/server/services/model.service.ts` | `setModelMinor`, `captureMinorFlagSnapshot`, `applyModelFlagSideEffects` |
| `src/server/jobs/minor-hash-sweep.ts` | Nightly sweep job (`45 3 * * *`) |
| `src/pages/api/admin/temp/minor-hash-sweep.ts` | Backfill + rollback endpoint (`WEBHOOK_TOKEN`) |
| `src/pages/moderator/minor-hash-matches.tsx` | Moderator review page (two tabs) |
| `src/server/routers/moderator/index.ts` | `moderator.models.*` procedures |
| `src/server/schema/minor-hash.schema.ts` | Zod inputs |
| `src/server/flipt/client.ts` | `FLIPT_FEATURE_FLAGS.MINOR_HASH_AUTO_FLAG` |

Related: [model-file-scanning.md](model-file-scanning.md) (where the scan hook fires),
[nsfw-filtering.md](nsfw-filtering.md) (`gallerySettings.level` semantics).

## What flagging a model minor actually does

`setModelMinor({ minor: true })` in `model.service.ts`:

1. Captures a pre-state snapshot into `Model.meta.minorFlagSnapshot` (before anything mutates).
2. `minor = true`, `nsfw = false`, `sfwOnly = true`, `gallerySettings.level = sfwBrowsingLevelsFlag`.
3. Adds `['minor','nsfw','sfwOnly']` (`MINOR_LOCKED_PROPERTIES`) to `lockedProperties`, so the creator
   can't edit them back.
4. Writes a `ModActivity` row (`setMinor`, or `setMinorAutoHash` for automated flags).
5. `applyModelFlagSideEffects` — refresh model tag cache, queue models search-index update, drop the
   gallery-settings Redis key, re-ingest the model, and propagate `minor` to **every image** in every
   post of every version of the model (set-based UPDATE; queues those image ids for search index).

`minor` lives on `Model`, not `ModelVersion` — **one matching file restricts every version of the
model.** Each flag is wider than the hash that triggered it.

Unsetting (`minor: false`) deliberately leaves `nsfw`/`sfwOnly`/`gallerySettings` untouched — the model
may have been legitimately SFW-only beforehand. Restoring those is the rollback path's job, from the
snapshot, not a guess.

## The seed set — what counts as "known minor"

`moderatorMinorSeedPredicate` (one definition, shared by the scan-time lookup and the sweep CTE):

```sql
m.minor
AND 'minor' = ANY(m."lockedProperties")
AND m.meta->'minorFlagSnapshot'->>'source' IS DISTINCT FROM 'auto'
```

Each clause earns its place:

- `minor` alone is not enough — creators can self-declare their own model minor. `lockedProperties`
  containing `'minor'` is what proves a moderator applied it, so a creator can't self-declare their
  way into flagging other people's uploads.
- Excluding `source='auto'` stops the automation from seeding itself. Without it, every auto-flagged
  model becomes a seed contributing *every* hash on it — including hashes no moderator ever tied to
  minor content — so the seed set grows from machine decisions and a dry run can't predict what later
  rounds will match. Measured on a prod-scale clone: dry run said 300, the drain wrote 302.

A moderator's own "Set as Minor" writes `source='manual'` and still seeds. Legacy flags (no snapshot at
all) seed too: `NULL IS DISTINCT FROM 'auto'` is true. And an auto-flag a moderator affirms is
*promoted* to `source='manual'` (see "Keep flagged" below), so it starts seeding — the exclusion is on
unreviewed machine output, not on the subject matter.

The practical consequence: **the seed set only ever grows from a human decision.** That's what makes a
dry run's prediction hold — nothing a run writes can change what a later run matches.

Only `ModelFile.type = 'Model'` files participate (`MINOR_HASH_FILE_TYPE`), on both sides — as seeds and
as candidates. `ModelFileHash.hash` is `citext`, and all stored SHA256 are uppercase hex.

## Candidates

`minorHashCandidatesCte`: models with a `type='Model'` SHA256 hash present in the seed set, where
`NOT m.minor`, `status <> 'Deleted'`, and the file wasn't already covered by a rollback
(`notMinorHashClearedPredicate`, below). Per model, `sameUploader` is `bool_or` over its matching
hashes of "a seed carrying this hash belongs to this same `userId`".

Flagging a model removes it from the candidate set (it becomes `minor`), which is what makes the sweep
resumable and idempotent.

## Path 1 — scan-time hook

`applyScanOutcome` (`model-file-scan.service.ts`) calls `checkMinorHashOnScan` after a model-file scan
finalizes, gated on: the file has a SHA256, `file.type === 'Model'`, and the Flipt flag is on (checked
last, so the flag is only evaluated for files that could actually match).

`applyMinorHashMatch` decides:

| Situation | Outcome |
|-----------|---------|
| Matches include the scanned model itself | `skipped` (it's already a seed) |
| No other model matches | `skipped` |
| Some other match has the **same** `userId` | `flagged` — `setModelMinor` as system user (`-1`), activity `setMinorAutoHash` |
| Only **different**-uploader matches | `queued` — appears on the review page |

`checkMinorHashOnScan` swallows all errors (logs to Axiom, returns `skipped`) — a minor-hash failure
must never fail a scan callback.

This is the only path that fires on live uploads.

## Path 2 — nightly sweep

`minorHashSweep` (`45 3 * * *`) exists to catch what the hook cannot: a copy uploaded *before* the
original was flagged, whose scan has already run. Gated on the same Flipt flag, so both unattended
paths stop together without a deploy.

`sweepMinorHashMatches({ dryRun, limit, concurrency })` reports the candidate split from an **uncapped**
count (so a dry run describes the real population, not its own window), then writes at most `limit`
same-uploader flags at `concurrency` in parallel. It only ever flags same-uploader matches;
different-uploader ones are reported as a count and reviewed by hand. Per-model failures are counted
and logged, never thrown. The completion report goes to Axiom *before* the HTTP response, so a gateway
timeout still leaves a record of what committed.

## Snapshot and rollback

`Model.meta.minorFlagSnapshot`, written idempotently (`WHERE NOT (meta ? key)`) so a re-flag can never
clobber the original pre-state:

| Field | Meaning |
|-------|---------|
| `at` | When the flag was applied |
| `source` | `'auto'` (activity `setMinorAutoHash`) or `'manual'` |
| `prevNsfw`, `prevSfwOnly`, `prevGalleryLevel` | Pre-flag values |
| `prevLockedProperties` | Full pre-flag array |
| `prevMinorImageIds` | Images already `minor` before the flag |

Snapshot capture is best-effort: losing it must block a later rollback, not the flag itself.

`rollbackMinorHashAutoFlags` has two modes:

- **Blanket** — `source IS DISTINCT FROM 'manual'` **and not human-confirmed**. A moderator's own
  decision is never reverted as collateral of "undo the backfill".
- **Targeted** (`modelIds`) — exactly those models, any source, no confirmation skip. Naming the model
  *is* the deliberate decision. This is the escape hatch for a mis-click.

Human-confirmed = a `ModActivity` row (`entityType='model'`, `activity='setMinor'`) with
`createdAt > snapshot.at`. It's excluded **in SQL**, not filtered afterwards: confirmed rows keep their
meta key forever, so leaving them inside the `ORDER BY id LIMIT n` window let them permanently occupy
slots and stall the drain. Their count is reported separately as `skipped`, from an uncapped query, so
an operator can tell "nothing left to undo" from "everything left is a human call".

Each rollback: `setModelMinor({ minor: false })` (reusing its search-index/cache/image machinery),
then restore `nsfw`/`sfwOnly`/gallery level/`lockedProperties` from the snapshot, replace the snapshot
key with a **clear stamp**, and re-mark `prevMinorImageIds` as `minor` (the unset cleared every image,
including ones legitimately minor beforehand).

### The clear stamp — why a rollback is remembered

Deleting the snapshot is what made a rollback forgettable: the model became an ordinary candidate again
and the next unattended run re-flagged what a human had just undone. So the same write that drops the
snapshot stamps `Model.meta.minorHashCleared = { at }`, and `notMinorHashClearedPredicate` excludes it:

```sql
NOT (m.meta ? 'minorHashCleared')
OR mf."createdAt" > (m.meta->'minorHashCleared'->>'at')::timestamptz
```

It's scoped by **file** time rather than excluding the model outright. A file that existed when the
rollback happened is covered by that decision; a file uploaded *afterwards* is a fresh act by the
uploader and stays catchable. A blanket exclusion would let one revert blind the automation to that
model forever.

Both candidate CTEs (sweep and review queue) carry the predicate. The scan path can't — the match
query's `m` is the *seed* side, not the model being scanned — so `applyMinorHashMatch` checks the
scanned file against the stamp (`isMinorHashClearedForFile`) on the flag path only, where the extra
round trip is paid once per write rather than once per scan.

A clear stamp only restrains the automation. A moderator can still flag the model by hand at any time.

## Moderator review page

`/moderator/minor-hash-matches` (mod nav). Two tabs:

**Pending review** — different-uploader matches (`queryMinorHashMatches`). Actions: **Set as Minor**
(`model.setMinor`, a manual flag — snapshotted, so undoable, but only by a targeted rollback) or
**Dismiss** (`dismissMinorHashMatch`, writes `Model.meta.minorHashDismissed`; dismissed models are
excluded from the queue).

**Auto-flagged** — models the scan hook flagged that no moderator has signed off yet
(`queryAutoFlaggedMinorModels`: `source='auto'` and not human-confirmed), newest first. Actions:

- **Keep flagged** (`confirmMinorHashAutoFlag`) — promotes the snapshot to `source='manual'` (keeping
  `confirmedFrom`/`confirmedAt`/`confirmedBy`) and records the moderator's own `setMinor` `ModActivity`.
  That one promotion carries the whole decision: the row leaves the queue, a blanket rollback can no
  longer revert it, and the model's hashes start seeding future matches. The snapshot's pre-state is
  kept, so a targeted undo stays possible. If snapshot capture had failed, the promotion no-ops and the
  `ModActivity` row alone protects the flag.
- **Revert** (`revertMinorHashAutoFlag`) — targeted rollback of that one model, plus a
  `rollbackMinorAutoHash` `ModActivity`.

Neither queue is paginated (`limit` default 1000, max 2000, plus a `truncated` flag). This is
deliberate: rows *leave* these queues as they're actioned, so any server-side window — OFFSET or keyset
— would either skip unreviewed models or restrict client-side sorting to the loaded subset. The
candidate CTE, not the row count, dominates the cost. **Note:** `FlaggedModelsList` has the OFFSET
version of this bug; don't copy its pagination.

Row detail (covers, uploader model count / join date, matched model, full hash) is a separate per-row
query (`queryMinorHashMatchDetail`) fetched on expand, so the list query stays lean.

Flag provenance is barely recorded historically — only 2 of ~13.5K minor-locked prod models have a
`setMinor` `ModActivity` row. "Set minor by/at" is blank almost always; render it conditionally.

## Feature flag

`minor-hash-auto-flag` (`FLIPT_FEATURE_FLAGS.MINOR_HASH_AUTO_FLAG`) gates **both** unattended paths.

Default-off by construction: `isFlipt` returns `false` for an unknown flag or an unreachable Flipt, so
with no flag defined nothing auto-flags, and it stays that way if Flipt is down. For a path that
auto-restricts other people's models, not flagging is the safe failure — a miss costs a re-upload the
sweep can catch later, a false positive wrongly marks someone's model minor.

It's in `FLIPT_EVAL_CACHE_BYPASS` so a kill propagates on the 60s config poll alone rather than 60s +
eval TTL. Evaluation is in-process (wasm engine), so per-scan cost is negligible. Flipt is GitOps-only —
creating or enabling the flag needs a config push, not an API write.

The admin endpoint is deliberately **not** gated: rollback has to stay usable after the switch is
thrown, which is exactly when it's needed.

## Admin endpoint

```
GET /api/admin/temp/minor-hash-sweep?token=$WEBHOOK_TOKEN&dryRun=true&limit=1000
GET /api/admin/temp/minor-hash-sweep?token=$WEBHOOK_TOKEN&action=rollback&dryRun=true
GET /api/admin/temp/minor-hash-sweep?token=$WEBHOOK_TOKEN&action=rollback&dryRun=false&modelIds=123,456
```

`dryRun` defaults to **true** for both actions. `limit` caps models *written* per call (default 100,
max 1000); `concurrency` default 5, max 10. Both actions are resumable and idempotent, so draining in
repeated small calls (`limit=50`) is preferable to one large run that risks a gateway timeout mid-batch.

## Data written

| Location | Value |
|----------|-------|
| `Model.meta.minorFlagSnapshot` | Pre-flag state + `source`; plus `confirmedFrom`/`confirmedAt`/`confirmedBy` once affirmed |
| `Model.meta.minorHashCleared` | `{ at }` — a rollback happened; the automation leaves files older than this alone |
| `Model.meta.minorHashDismissed` | `{ at, by }` — removes the model from the pending queue |
| `ModActivity` | `setMinor`, `unsetMinor`, `setMinorAutoHash`, `rollbackMinorAutoHash`, `dismissMinorHashMatch` |

`ModActivity` is uniquely keyed on `(activity, entityType, entityId)` and upserts with
`DO UPDATE SET createdAt = NOW()` — so there's only ever one row per (model, activity), and confirming
bumps its timestamp rather than failing.

No schema migration: everything rides on existing `Model.meta` and `ModActivity`.

## Deletes and re-uploads

Covered. All user-facing deletes are soft — `deleteModelById` sets `status='Deleted'`; `deleteUser` sets
`{deletedAt, status:'Deleted'}` or reassigns to `userId = -1`. Hashes survive, so a deleted minor model
still seeds. Only `permaDeleteModelById` destroys the seed (CASCADE to `ModelFileHash`), and it's
moderator-gated.

A re-upload from a **new account** lands in the different-uploader review queue, not an auto-flag —
correct, since the hash proves file identity, not who the human is.

## Invariants

The properties the design holds, and where each one is enforced. Break one of these and the feature
becomes unsafe rather than merely wrong:

| Invariant | Enforced by |
|-----------|-------------|
| Only a human decision seeds | `moderatorMinorSeedPredicate` (`lockedProperties` + `source <> 'auto'`) |
| Automation never flags a different uploader | `applyMinorHashMatch` (`queued`), sweep's `WHERE c."sameUploader"` |
| A dry run predicts what a live run writes | seed set can't grow from automated output |
| A rollback is remembered | `minorHashCleared` + `notMinorHashClearedPredicate` |
| A rollback doesn't blind the automation forever | clear stamp is scoped by `ModelFile."createdAt"` |
| A moderator's flag is never machine-reverted | `autoFlaggedPredicate` + `humanConfirmedPredicate` |
| Every flag is reversible | `captureMinorFlagSnapshot` before any mutation, for manual flags too |
| A minor-hash failure never fails a scan | `checkMinorHashOnScan` swallows and logs |
| Both unattended paths stop together, without a deploy | one Flipt flag, checked in both |

## Caveats

- **`minor` is model-wide.** One matching file restricts every version of the model. Sizing the impact
  by "models flagged" understates it.
- **Same-uploader is the only auto-flag signal.** A determined re-uploader on a fresh account lands in
  the review queue, by design — the hash proves file identity, not who the human is.
- **The admin endpoint's `action=sweep` is ungated**, not just `action=rollback`. With the kill switch
  thrown, anyone holding `WEBHOOK_TOKEN` can still run a live sweep.
- **Flag provenance is thin historically** — see the review-page note; don't build UI that assumes a
  `setMinor` `ModActivity` row exists.
- **The clear stamp is never cleaned up.** A model can carry `minorHashCleared` indefinitely; it only
  ever narrows what the automation acts on, so it's inert rather than stale.
