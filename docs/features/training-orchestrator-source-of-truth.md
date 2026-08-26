# Training runs: orchestrator as source of truth — sizing and scope

**Status:** phases 1 and 2 are implemented behind the `trainingOrchestratorState` flag, default off.
Phase 0 is a database-side fix and is not in this repo.

The ask: make the orchestrator, rather than our Postgres, the source of truth for listing training
runs and their statuses. Keep a DB record, but stop reading training state out of it. The task as
filed is the *judgement* — size it, then scope it or close it — so this document is the deliverable.

Two questions that gated the sizing have since been answered by the orchestrator side; see
[Answers that shaped this](#answers-that-shaped-this). They rule out one reading of the ask and make
the remaining work smaller than first estimated.

## Verdict

**Not a wontfix, and smaller than it first looked — but not the shape the ticket describes.**

Workflow records are retained for **30 days**. A permanent list cannot be sourced from a 30-day
store, so "the orchestrator becomes the source of truth for *listing* training runs" is not
achievable as written. What is achievable, and is the substance of the request, is:

> **Postgres keeps the list. The orchestrator becomes authoritative for the *state* of every row
> inside the retention window.**

That is an overlay, not a replacement, and it is a much smaller change than a list rewrite. It also
happens to cover **every row a user can still act on** — see [Retention](#retention-30-days), where
the 30-day horizon turns out to sit past both of our own expiry deadlines.

| Piece | Size | Blocked on |
|---|---|---|
| 0. Fix the replica bug generating most of the confusing tickets | small | nothing |
| 1. Orchestrator-authoritative *detail* read (one run) | small–medium | **built**, flag default off |
| 2. Orchestrator-authoritative *state overlay* on the list | medium | **built**, flag default off |
| ~~3. Orchestrator-sourced list~~ | — | **ruled out by 30-day retention** |

## Why the two original estimates disagreed

Both were defensible about different things:

- **"It's mostly just using APIs that already exist"** is literally true of the fetch.
  `trpc.orchestrator.queryWorkflowsByTags` already exists (`src/server/routers/orchestrator.router.ts:194`),
  is scoped to the caller's own orchestrator token, and training workflows are *already* tagged
  `['training', 'modelVersion:<id>']` at submit (`src/server/services/orchestrator/training/training.orch.ts:397`).
  Reading a user's recent training runs from the orchestrator needs zero new backend code today.
- **"This is a pretty big one"** was true of the thing being described — replacing the training
  *table*. The table is not a list of workflows: it's a list of model versions, two of whose nine
  statuses have no workflow at all, over a history that outlives the orchestrator's records by years.

The overlay framing takes the first estimate's mechanism and applies it without incurring the second
estimate's rewrite.

## How the split works today

Training state is written to Postgres in three places, all deriving from the same orchestrator
workflow:

1. **Submit** — `createTrainingWorkflow` writes `ModelVersion.trainingStatus = Submitted`,
   `ModelVersion.meta.trainingWorkflowId`, and seeds `ModelFile.metadata.trainingResults`
   (`training.orch.ts:410-440`).
2. **Webhook** — `resource-training-v2/[modelVersionId]` re-fetches the workflow and calls
   `updateTrainingWorkflowRecords`, which maps workflow status → `TrainingStatus`, copies epochs,
   timestamps and transactions into `ModelFile.metadata`, and appends to a status history
   (`src/server/services/training.service.ts:518-721`).
3. **Reconcilers** — an hourly cron over everything still `Submitted`/`Processing`
   (`src/server/jobs/check-processing-resource-training-v2.ts`) and a user-facing **"recheck"**
   button (`modelVersion.recheckTrainingStatus`, surfaced at
   `src/components/User/UserTrainingModels.tsx:291`), both calling the *same*
   `updateTrainingWorkflowRecords`.

Three independent paths re-deriving the same state, one of them a manual button we shipped to users,
is a fair description of the problem. It is also the strongest argument that the direction is right:
the overlay retires paths 2 and 3 as *read* dependencies.

## What each side actually owns

| State | Lives in | Orchestrator equivalent | Can it move? |
|---|---|---|---|
| Workflow status (`Submitted`/`Processing`/`Failed`/`Expired`/`InReview`) | copied to `ModelVersion.trainingStatus` | `workflow.status`, mapped at `training.service.ts:459` | **Yes, in-window** |
| `Paused` / `Denied` | copied to `trainingStatus` | step `output.moderationStatus` | **Yes, in-window** |
| `Pending` — created but never submitted | `trainingStatus` only | **none — no workflow exists yet** | **No** |
| `Approved` — user picked an epoch and published | `trainingStatus` only | **none — post-orchestrator lifecycle** | **No** |
| Started / completed timestamps | `trainingResults.startedAt/completedAt` | `step.startedAt/completedAt` | Yes, in-window |
| Epochs, sample images, model blob URLs | `trainingResults.epochs` | step output (blobs expire at 15 days) | Yes, in-window |
| Cost / refund per Buzz account | `trainingResults.transactionData` | `workflow.transactions.list` | Yes, in-window |
| Model + version **name** | `Model.name` / `ModelVersion.name` | `loraName`, frozen at submit | **No** |
| Ownership, training dataset file, dataset moderation | Postgres | — | **No** |

Two of the nine `TrainingStatus` values are Civitai lifecycle states with no workflow behind them.
`Pending` is written when the user first names the model, before any orchestrator call
(`src/components/Training/Form/TrainingBasicInfo.tsx:220`); `Approved` is written when the user
selects an epoch (`src/components/Resource/Forms/TrainingSelectFile.tsx:428`). The table shows both.
Under the overlay these simply have no workflow to overlay and keep reading from Postgres — which is
correct, not a compromise.

## Answers that shaped this

### Retention: 30 days

A workflow record is queryable for **30 days**, independent of its blobs.

That rules out an orchestrator-sourced list. It does **not** meaningfully constrain an overlay,
because our own expiry deadlines already sit inside that window:

- Epoch models are treated as unusable after **15 days** (`canGenerateWithEpoch`,
  `src/server/common/model-helpers.ts:162`); the generation path refuses expired epochs.
- Training datasets are purged after **30 days** (`src/server/jobs/delete-old-training-data.ts`).

So a training row older than 30 days is already inert: its epochs can't be selected or generated
with, and its dataset is gone. The orchestrator-authoritative window covers **100% of the rows a user
can still act on**. Older rows are an archive, and Postgres is the only thing that has them.

Worth contrasting with the generation feed, which *is* orchestrator-only
(`queryGeneratedImageWorkflows2`, `src/server/services/orchestrator/orchestration-new.service.ts:2949`)
and therefore simply ends at the retention horizon. That is acceptable for generation, where a run is
ephemeral. It is not acceptable for training, whose rows are the provenance of published models that
people revisit years later — which is exactly why the list has to stay in Postgres.

Legacy v1 runs (`trainingResultsV1Schema`, `src/server/schema/model-file.schema.ts:9`) predate the v2
workflow API and are not addressable through it at all; they fall in the archive half by definition.

### Query capability: filter by tags, as the generator does

Server-side filtering is available through **tags**, which is how the generator already does it.
`WORKFLOW_TAGS` (`src/shared/constants/generation.constants.ts:44`) covers media type, favourite,
feedback, base model and process type; the feed AND-s them into the query
(`src/components/ImageGeneration/utils/generationRequestHooks.ts:98-109`).

Applied to training:

- **Training type** and **base model** are static and known at submit. Tag them at
  `training.orch.ts:397` — a one-line change — and backfill existing workflows via
  `patchWorkflowTags` (`src/server/services/orchestrator/workflows.ts:612`). Both filters solved.
- **Status is different, and this is the catch.** The generator's mutable tags (`favorite`,
  `feedback:*`) are mutated by *user action*. Training status is mutated by the *orchestrator*. To
  filter by status via tags, something must keep the tag in step with `workflow.status` on every
  transition — i.e. the webhook writes a tag instead of a DB column. That is still a reconciler; it is
  merely a same-store denormalization rather than a cross-store one, which is strictly better (a
  repair job reads the truth and the tag from one place) but not free. The cheaper ask is native
  status filtering, and the capability is partly there already: `excludeFailed` exists on
  `queryWorkflows` today.

Still unavailable, tags or not:

- **A total count.** `queryWorkflows` returns `{ next, items }`; there is no count, so exact
  pagination cannot be sourced from it.
- **Free-text search on the model name.** Names live in Postgres and are editable after submit; the
  workflow's `loraName` is frozen at submit time.
- **Sort by completion date.** Only `ascending` over creation.

All three are moot under the overlay, since Postgres keeps doing the paging, searching and sorting.

One wrinkle that does **not** apply here: the generator re-filters client-side
(`matchesMarkerTags`, `generationRequestHooks.ts:54-61`) because its tags are per-workflow while its
UI unit is per-image. One training run is one workflow, so tag filtering is exact for this table.

## Where the confusing tickets actually come from

Worth separating before committing to any of this, because a meaningful share are not caused by the
DB/orchestrator split at all.

**Logical replication drops TOASTed jsonb on UPDATE.** `ModelFile.metadata` is TOASTed, and the
subscriber feeding the replica drops it, so `trainingResults` reads back empty on the replica and the
UI shows a run with no workflow and no epochs. This has already been worked around **twice**, in two
apps, each time by reading through the write connection:
`apps/moderator/src/lib/server/training-moderation.service.ts:431` and
`src/server/controllers/training.controller.ts:67` (`TODO(replica-toast)`).

That failure mode presents exactly as "the DB disagrees with the orchestrator for no reason". It
would disappear under the overlay — but it would also disappear if the replication bug were fixed, at
a fraction of the cost, and it is currently costing us scattered `dbWrite` reads in code paths that
should be replica-safe. **Fix it first and independently**, then re-measure how many confusing
tickets remain. That measurement is the input the phase-2 decision actually needs.

## Blast radius

`trainingStatus` is referenced in ~35 files and `trainingResults` in ~15, and they are not confined
to the training UI:

- **Training UI**: `UserTrainingModels.tsx` (1170 lines), `TrainingSelectFile.tsx` (1013),
  `TrainingSubmit.tsx` (1551), `ModelWizard.tsx` (666), `ModelVersionWizard.tsx` (399).
- **Server**: `training.service.ts` (988), `training.orch.ts` (511), the v2 webhook, the legacy v1
  webhook (325), the reconcile cron, `model.service.ts`, `model-version.service.ts`.
- **Not training at all**: the model card's `onSite` badge derives from `version.trainingStatus`
  (`src/components/Cards/ModelCard.tsx:144`) and is served from the `dataForModelsCache` Redis cache
  (`src/server/redis/caches.ts:640`) on the feed path; the public API exposes it
  (`src/pages/api/v1/model-versions/[id].ts:75`); `ModelVersionList` uses it.
- **Moderator app**: `training-moderation.service.ts` (644) plus the `audit/training-models`,
  `audit/training-data` and `retool/user-lookup` routes, all Kysely queries over `mv.trainingStatus`
  and `mf.metadata->'trainingResults'`.

The feed-path and public-API consumers **must** stay DB-backed — you cannot join a Redis-cached feed
row against an orchestrator workflow, and they read rows of any age. So the DB column stays and keeps
being written; what changes is which reads trust it.

## Proposed scope

**Phase 0 — fix the replication bug (small, independent, do regardless).**
Get TOASTed jsonb replicating correctly, remove the two `dbWrite` workarounds, then measure the
residual rate of training-state tickets.

**Phase 1 — orchestrator-authoritative detail read (small–medium). Implemented, flag default off.**
The epoch-selection screen (`TrainingSelectFile`) takes the epochs the user picks between, and the
status gating that choice, from the live workflow via `training.getRunState`.

### Why phase 1 is a separate query rather than an overlay

`TrainingSelectFile` has no query of its own. It is fed by `trpc.model.getById` (via
`ModelWizard.tsx:500`) and `trpc.modelVersion.getByIdForEdit` (via `ModelVersionWizard.tsx:293`), and
`model.getById` is a large, cached, **public** endpoint on the model detail page path, used far
beyond training. Overlaying inside it would put an orchestrator round-trip on the model detail page
for every viewer, and the ownership check the overlay needs does not belong on a public procedure.

`training.getRunState` is therefore additive: a `protectedProcedure` that reads one run by workflow
id, so the round-trip is paid only by the owner (or a moderator), only on the screen that needs it.
It fetches by id rather than through the list query, so the list's cap and page bounds do not apply.
Past retention it returns the stored copy, which is all that is left of the run — so the client has
no separate fallback to implement.

One thing this recovers for free: the workflow id is read from the stored results **or** from
`ModelVersion.meta.trainingWorkflowId`. That second field lives on a small json column the
TOAST-dropping replication bug cannot reach, so a run whose `trainingResults` came back empty — the
exact phase-0 failure — can still be rebuilt in full from the orchestrator.

**Phase 2 — state overlay on the list (medium). Implemented, flag default off.**
`getMyTrainingModels` stays the list: same paging, same filters, same search. For the returned page,
`getTrainingWorkflowOverlay` makes one `queryWorkflows({ tags: ['training'] })` call bounded to the
retention window and keys the result by the `modelFileId` each training step carries; rows inside the
window take status, timestamps, epochs, history and transactions from the workflow, and rows outside
it render the stored record. Retires the reconcile cron and the recheck button as *read* dependencies
for that page.

Two properties worth knowing before the flag is ramped:

- **`Approved` is never overlaid.** It is written when the user picks an epoch and publishes, long
  after the workflow succeeded; overlaying would walk them back to `InReview` and re-offer a choice
  they already made. `Pending` needs no such guard — it has no workflow to match.
- **Filtering and the total count are still SQL, over the stored value.** A row whose live status has
  moved on can therefore display a status outside the active filter. That is inherent to an overlay
  and is the thing orchestrator-side filtering would fix.
- **Every row on the page gets covered, not just the newest.** The bulk query returns the newest
  workflows rather than the ones on the page, so a user with more runs in the window than the cap
  could have page rows it never reached. Those are fetched individually (bounded, and normally zero
  calls) so a row's status is the orchestrator's regardless of how deep the page is.

Also shipped, and unread by anything yet: `createTrainingWorkflow` now tags each workflow with
`baseModel:` and `trainingType:`. Tags are the only server-side filter `queryWorkflows` offers, so
these are the prerequisite for ever moving those two filters orchestrator-side. Existing workflows
would need a `patchWorkflowTags` backfill before that could be relied on.

**Explicitly out of scope, permanently:**
- The `ModelVersion.trainingStatus` column and its writes. The feed badge, public API, moderator
  queries and model-file filters depend on it, and they read rows of every age.
- An orchestrator-sourced list. 30-day retention cannot back a permanent history.

## Open question

**What should a >30-day row show?** Under the overlay these rows keep rendering the DB record, which
is what happens today and is almost certainly right — the run is inert, and the record is accurate as
of its last update. But if part of the motivation is "the DB record was wrong", then for archived
rows there is no longer anything to check it against, and the overlay cannot help. Worth deciding
explicitly whether that is acceptable (it probably is: a row that went stale did so while it was
in-flight, and the overlay fixes it *then*) rather than discovering it after rollout.

## Recommendation

Phases 1 and 2 are built and off, behind one flag. Ramp it via Flipt while watching the training
list's latency — the list adds one orchestrator call per page and the epoch screen one per view, both
fail soft to the stored copy, and the flag turns off without a deploy.

Phase 0 is still the highest-value item and is unaffected by any of the above: fix the replication
bug, drop the two `dbWrite` workarounds, and measure what fraction of training-state tickets remain.

Do not schedule the literal ask ("source of truth becomes the orchestrator for listing"); 30-day
retention rules it out, and the overlay delivers what the ask was actually after.
