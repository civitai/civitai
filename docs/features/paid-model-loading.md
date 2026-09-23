# Paid Model Loading

Any model the generator supports can be generated with, whether or not it is resident on the
generation cluster. A job whose resources are not loaded **waits** while they download; downloads are
**free**, and the cost to the user is the generation queue slot the waiting job holds. Paying buys
**priority**, not access: a **boost** moves that workflow's pending downloads into the fastest
download lane.

**Companion:** [paid-model-loading-coverage.md](paid-model-loading-coverage.md) — the coverage model,
the audit behind it, and every measured number.

**Sources:** the 2026-08-18 lab call and the 2026-09-10 call (Justin, Koen, Briant), Koen's DMs
(2026-09-04, 09-07, 09-10), the `@civitai/client` and `@civitai/orchestration-client` SDKs, and the
orchestrator source at `9306e7333`.

> **History.** This file replaces four docs merged on 2026-09-11 — the boost model, the build plan,
> the implementation checklist and the decisions register. Git history holds them. The explicit
> *paid load* they described (buy a load, 48-hour residency promise, per-tier daily caps) was
> superseded on 2026-09-10 by the boost model above; its server path survives as a moderator tool.

---

## How it works

- **Generation is always accepted.** A cold checkpoint no longer blocks a submit.
- **Downloads are free.** Lanes, the queue slot, and cancellation removing a job's downloads are the
  abuse controls — not a price.
- **Boost = the high lane.** `PUT /v2/consumer/workflows/{id}` with `{ downloadPriority: "high" }`,
  charged to the token's owner. The same call with `whatif=true` prices it without charging, and the
  fee is `cost.fixed.downloadPriority`.
- **Three lanes**, each with reserved bandwidth so the lowest never fully stalls: boosted (`high`),
  members (`normal`), everyone else (`low`). `downloadPriority` only ever goes up, and is separate
  from the generation `priority` on each step.
- **Within a lane a position never moves backwards**; a higher lane can still go ahead, so an
  unboosted ETA is an estimate.
- **A boost covers the whole workflow** — checkpoint and LoRAs together. Cancelling removes the job's
  downloads from the queue.
- **It applies to every resource type.** The orchestrator does not distinguish a checkpoint from a
  LoRA or from a model's implicit dependencies (a bundled text encoder, a VAE). A model with several
  dependent files is presented as one thing: the UI shows the resource that will finish last, never
  "1 of 3".

## What is built

The UI follows Justin's download-boost mockup. Lanes are shown as **Standard** (`low`), **Priority**
(`normal`, members) and **Express** (`high`, boosted) (`download-lanes.tsx`). The speed shown is the
orchestrator's `rateLimitBytesPerSecond` (beta.107) for the viewer's own lane — a per-download cap,
`null` when uncapped, which is what Express is. Other lanes' caps are not reported, so they show none.
One lanes explainer (`DownloadLanesInfo`) opens from every boost control.

**Queue card** (`DownloadBoostPanel`). The workflow's own step `preparation` gives its lane,
position, lane cap and boosted ETA: it is per workflow, while a download is shared by every workflow
waiting on the model, so the model's live lane is whoever asked highest. A submit reply predates the
orchestrator queueing anything, so `generateFromGraph` attaches the estimate from a whatIf of the same
steps (`attachEstimatedPreparation`) — run alongside the submit under a 2s deadline it never holds the
reply for, and only when the cached residency says a download is already queued or loading for one of
its models (`unavailable` is the resting state of most of the catalogue, not a queued download). The
estimate is restated in the high lane only when the submitted workflow actually came back `high`, and
it carries only what a whatIf can honestly know — the lane and the sizes. Position and ETAs are dropped
(`asEstimate`): they are measured against a queue the job has not joined, and the card's own poll has
the orchestrator's within seconds. So a fresh card reads "Waiting on downloads — Standard lane" with
`—` for position and time, and offers no Boost until the real figures arrive. Later reads and step
events replace it. While a step has `preparation` or is `preparing`, the card also polls the models
`preparation` names — every resource until it does — for their live status (`downloadPollIds`;
`resourceLoad.getDownloadStatus` — uncached, ≤10 versions, 60/min per user) every 10s, for
transfer progress, ETA and when a model lands; never for lane (`mergeDownloadRow`). Once neither
holds, the card drops its download rows (`buildDownloadRows`): the stopped poll keeps its last
response, which would otherwise hold a row at its final percentage.

While a model is not loaded, the pending image tile gives way to a panel: the lane, position (from 1),
lane speed and ETA of the slowest download, then each unloaded model with its position and ETA,
progress, or "waiting to start". Its resource chips spin with their size. **A transfer that has just
started shows progress with no time at all** — until 2% or 64 MB has moved, whichever comes first
(`ETA_WARMUP_PROGRESS` / `ETA_WARMUP_BYTES`), a stream still ramping up projects from a throughput it
will not hold, which is how a ten-minute download comes to claim two hours. A model merely *queued*
behind other downloads is unaffected: nothing has distorted the projection it was given, so it keeps
its ETA and its offer. When a boost would read as faster, the panel adds the "Skip the free lane"
pitch, a "Normally → Boosted" comparison and a **Boost this download** Buzz button with its price,
fetched when the panel renders (`getBoostCost`, 30s stale), so **each boostable card costs one whatIf
PUT**. For a boost bought on this page, the panel keeps the ETA it would have been. The rules are pure functions in `download-status.ts`. There is no site-wide
download queue page.

**Generator — both forms** (`generation_v2` data-graph and form-graph): when the whatIf reports
downloads, `DownloadReadyAlert` shows the resource count and size, and — when the boost would read as
a different number (`isBoostable`) — the "Normally → Boosted" comparison and a **Boost download**
switch with its price. That same test gates the second whatIf at `downloadPriority: "high"`, so a
pending download with nothing visible to sell costs no extra whatIf; where it is offered, the price
shows before the switch is on and flipping it swaps to the already-priced response. The switch is
pinned to the form revision, so it never carries over to a selection the user has not re-priced, and
it clears after a submit (`usePreBoostWhatIf`).

Both render it in the footer, beside the other pre-submit warnings.

**On mobile the full alert is hidden** — it costs too much of the viewport — and the offer is made as a
confirm on the Generate press instead (`DownloadBoostConfirm`, chosen in `resolveBoostSubmitFields`):
the wait, the "Normally → Boosted" comparison, then **Boost · N Buzz** or **Continue without boosting**.
Dismissing it cancels the submit rather than sending it unboosted, since the user chose neither. That
confirm only opens when there is a boost to sell, so mobile keeps a one-line notice of the wait itself.

**Load indicators**, every resource type. Where the answer is the boolean column, only loaded versions
are marked and the rest are silent, since most of the catalogue is not loaded: a green dot on the model
page's version strip, and a dot and **Loaded** on results in the generation resource picker. The
**Create** button carries a top-left corner badge stating either outcome — the one place a bare mark
is not enough, since the question there is whether pressing it starts now. The generator's own
resource rows state either outcome too. Every label takes its dot's colour. Nothing says "needs download": a resource needs **to be loaded**, and it loads **in** the
generator, not on it (Justin, 2026-09-22).

The model page and the picker read `ModelVersion.generatorLoaded` — the page from its own SSR'd data,
the picker from the index's `versions.generatorLoaded`. So they render with the page rather than
flickering in after it, they cover whichever version is selected, and they trail the orchestrator by
the 5-minute sync (plus the index queue, for the picker).

The rest is live, from `resourceLoad.getResidency`: signed-in, ≤50 ids (`RESIDENCY_MAX_IDS`),
rate-limited, cached 30s per version. That is the generator's marks, whose resources do not come from
page data — the added-resource list batches into one request (`ResidencyBatchProvider`), while the
checkpoint input, the two **Generation** rows (version details, picker card's back) and every
`ResourceItemContent` outside that provider — the compatibility confirm, the image-metadata modal and
the metadata-extraction panel — each ask for their one id, so a modal listing ten resources is ten
calls. Naming *downloading* or *queued* is the one thing the boolean column cannot do.

Nothing pushes residency, so those live marks refresh two ways: they poll every 60s while anything on
screen is cold and stop once it is all loaded, and the queue card's uncached download-status poll
invalidates every residency query the moment a model reports `available`, so an open generator flips
to **Loaded** as the download lands rather than waiting out the backstop.

**A "Loaded only" filter** in the generation resource picker, beside the type and base-model chips.
The index filter keeps a model any of whose versions is resident, because Meilisearch matches the
nested array; the hit list then drops the versions that are not, so a card cannot show one. Versions
are newest-first, so what the card lands on is the latest loaded one, and its dropdown offers only
loaded versions while the filter is on.

**Moderator tool** at `/moderator/resource-load` (flag `resourceLoad`): the explicit purchase path —
`resourceLoad.estimate` / `submit`, the flag-gated `getQueue` and uncapped `getState` reads, the
per-tier caps, the `resource-load:update` signal and the load-complete toast. Kept deliberately (2026-09-11) for pricing and observing a single download.

**Coverage** — `GenerationCoverage` is one view carrying both rules as columns, `covered` (live) and
`coveredNext` (staged), and the Flipt boolean `generation-coverage-next` decides which one answers.
It is **default off**, so the staged rule — the thing that lets a normal user pick a checkpoint that
is not loaded — ships dark and is turned on deliberately. Server-side the choice is made once per
request in `coverage-source.ts`; the models index writes both `canGenerate` and `canGenerateNext`
from the two columns, and the picker filters on whichever `coverageIndexField()` names, passing the
answer to the client so the hit list re-checks the same field. `no-divergent-coverage-read` keeps
both halves single-sourced. Both fields, and the flag, go at the cutover.

**Money-path properties worth keeping true:**

- The boost is charged only at the price on the button: `boostWorkflow` re-prices first and
  refuses, charging nothing, if the price moved or nothing is left to boost.
- After the charge, a failed read reports the boost as done rather than as an error, so a retry
  cannot pay twice.
- A pre-boosted submit sends `downloadPriority` only when a whatIf shows something waiting to
  download.
- ETAs shown to users are approximate (`formatDownloadEta`) and never sooner than `ETA_FLOOR_SECONDS`
  — 2 minutes, in `download-eta.ts`. A wait that runs over reads as a broken promise where one that
  lands early does not; the cost is that the fastest boosts show no visible gain. The floor is
  display-only — the raw seconds in `preparation` are untouched — and the moderator page keeps exact
  figures. One rounding ladder (`etaBucket`) serves both formatters and every comparison, so
  `downloadSpeedup` can never print a multiple the two numbers beside it do not show.
- A boost is only offered when it buys time the user can **see**, on two rules that differ because
  their inputs do. The queue card (`isWorthBoosting` → `boostBuysVisibleTime`) also requires the boost
  to be faster: its plain ETA is live and its boosted one was measured when the workflow queued, so a
  download that has since sped up can otherwise quote a "boost" slower than the current wait. The
  pre-submit offer (`isBoostable`) takes both figures from one whatIf, so it refuses only what the
  rendered buckets have swallowed — charging for two identical printed numbers.
- A transfer's ETA is withheld until it has moved enough to be believed, and its boosted ETA with it
  (`isEtaSettled`, `download-preparation.ts`). Offering a paid boost while refusing to show the wait
  it shortens would be a charge with no benefit on screen.
- The mobile confirm's fee is added to the balance check before it runs, since the dialog is answered
  after the generation's own total was read.

**Timeouts — the site now sends none.** A generation step used to carry a `timeout` built by
`buildStepTimeout` (20 minutes, 40 for video, +1 per extra resource). A job waiting in the free lane
can wait far longer than that, and an expired step is not a slow generation, it is a dead one — so
`createWorkflowStepsFromGraph` stopped setting `timeout`, and the client cutoffs that mirrored it went
with it: the queue card's "This is taking longer than usual" alert at 5 minutes **and its promise that
we refund automatically by `createdAt + min(step timeout, 10 min)`** (`QueueItem`), the iterative
editor's 5-minute warning and 25-minute hard stop (`IterativeImageEditor`), the comics panel poll's
25-minute `Failed` cutoff (`comics.router.ts`) and its 3-minute modal timeout (`GenerateImageModal`).
Whatever bound remains is the orchestrator's own; the site still renders the `expired` workflow status
it produces, and promises nothing about when it arrives.

**App Blocks keeps its step timeouts** (`formatStepTimeout` / `stepTimeoutSeconds` in
`src/server/services/blocks/workflow.service.ts`) and was deliberately not touched. There the timeout
is the only deterministic per-job Buzz bound — worst-case Buzz is derived from it and reserved against
the per-user cap — so removing it would uncap spend, not just uncap waiting. It is per engine, and it
moves with `maxBuzz`.

---

## The orchestrator contract

Read `node_modules/@civitai/orchestration-client/dist/generated/types.gen.d.ts` rather than trusting
this section once it ages. The app's own orchestrator calls still go through the older
`@civitai/client`, which predates `downloadPriority` and `preparation` — hence the casts around them.
The fleet-wide loaded list (`/v1/manager/resources/loaded`) is in neither client, so
`getLoadedResourceAirs` (`src/server/http/orchestrator/loaded-resources.ts`) calls it through the
orchestrator caller.

### Step preparation — what the card and the alert render

From beta.106, `WorkflowStep.preparation` is `WorkflowStepPreparationResource[] | null` — every
resource the step waits on, **gating resource first**, each with `sizeBytes`, `lane`,
`queuePosition` (null while transferring), `progress`, `bytesPerSecond`, `etaSeconds` and
`boostedEtaSeconds` (null once already `high`). The beta.105 summary-object shape is **not** read —
the orchestrator must be on beta.106 before this ships.

Raw data enters in three places — the server's step reader, the generation signal handler, and the
moderator page's load-progress signal — and each validates it against `preparationSchema`
(`src/shared/orchestrator/download-preparation.ts`). Anything else reads as nothing to download. The
summary (`DownloadPreparation`) is derived from the gating resource, and an empty list also reads as
nothing to download: a bare `[]` is truthy, and would put a download panel and a paid Boost on a step
with nothing to boost.

beta.106 also adds `WorkflowStep.warnings[]` (so far only `modelDeprecated`, with `retiresAt` and a
suggested `replacement`). Nothing reads it yet.

It arrives three ways: on the workflow list, on the status refresh, and on step webhook events. A
preparing step publishes every **10 seconds**, deduplicated at 1% progress.

🔴 **Those events can carry `status: unassigned`.** The signal handler applies their `preparation`
straight to the cached step and only refetches the workflow when the step's status also changed —
otherwise every progress webhook would cost one orchestrator read per waiting workflow.

### Resource availability

`GET /v2/resources/{air}` returns `ResourceInfo.availability`, a union on `status`:

| `status` | Extra fields | Meaning |
| --- | --- | --- |
| `available` | `workers` | resident |
| `loading` | `progress`, `workers`, `startedAt`, `lastProgressAt`, `etaSeconds`, `lane`, `bytesPerSecond` | downloading now |
| `queued` | `queuePosition`, `lane`, `etaSeconds`, `boostedEtaSeconds` | waiting in a lane |
| `unavailable` | `queuePosition?` | **nothing is pulling it** (from beta.105) |
| `unsupported` | — | the cluster cannot host it |

🔴 **Two generations of the queued shape both parse.** Before beta.105 a queued resource was
`unavailable` with a `queuePosition`. `isQueuedAvailability` (beside `resourceAvailabilitySchema`) is
the one place that rule lives; four screens previously each decided it for themselves. A status this
build does not know becomes `unknown` — deliberately not folded into `unsupported`, because "the
cluster will never host this" and "we could not read the answer" need different support answers.

### Queue listing — `GET /v2/resources?view=queue`

Cursor-paged `ResourceInfo[]`, merged across providers, de-duped by AIR and ranked server-side. **Do
not re-rank client-side.** The cursor is an integer offset over a list re-ranked from live state on
every request, so paging is unstable — show one page and poll it. Each item costs the orchestrator two
grain calls, so the site clamps `take` to 1..100, default 50 (`getResourceLoadQueueSchema`).

### Prices and who charges

The site never prices this. It submits with the **user's** orchestrator token and the orchestrator
derives from that bearer who owns the workflow, whose queue it joins and whose Buzz pays.

🔴 **A user-token submit that creates a workflow must call `assertWorkflowOwner`** — enforced by the
`no-unguarded-billable-submit` guard, whose exemptions are counted per file. A `whatif` submit creates
nothing and spends nothing, which is why the two whatIf calls in `orchestration-new.service.ts` are
exempt. The boost is an **update** to a workflow the token already owns, so the guard does not apply.

### Signals

Progress reaches the browser the same way generation does: workflow → signals service → client.
Load-progress callbacks target `/users/{userId}/signals/` — **never** a `model-version:<id>` group,
because the orchestrator posts its event body straight through and `workflowId` is
`<userId>-<timestamp>`, so a broadcast would name the payer. Pinned by a test asserting `/users/` and
not `/groups/`.

⚠️ `SignalMessages.SchedulerDownload = 'scheduler:download'` is the generation-history export, not
this feature.

### Residency (a repo the site does not check out)

Koen, 2026-09-04: the spine controllers check with each other before evicting and refuse to evict
anything less than 48h old unless another controller has it (`ClusterAwareEvictionPolicy.cs` in
`civitai-spine-controller`). `PinModelJob` is legacy — "don't even look at it." Nothing exposes *when*
a resource's window ends, so there is no countdown to build.

---

## Coverage, in one paragraph

Two rules live side by side in one view and a flag picks between them; everything below describes the
**staged** rule (`coveredNext`), which is what goes live when `generation-coverage-next` is turned on.
The live rule (`covered`) differs in exactly two places, both noted inline.

`CoveredCheckpoint` — the weekly auction's residency proxy — stops gating (it still gates the live
rule). `EcosystemCheckpoints`
stays (62 of 63 checkpoint defaults ride on it) and `GenerationBaseModel` stays as the base-model
gate. A checkpoint must carry a **SafeTensor** weight file; Diffusers remains fine for every other
type. File-less API models are covered and never loadable — "file-less" means *no loadable file*, not
*no file row*. A model a moderator has taken down or archived (`Model.mode`) is **not covered for any
type**, which is how moderation blocks generation server-side rather than only greying out a button.
Zero covered versions lack `RentCivit`, so refusing anything outside coverage inherits the licence
rule instead of restating it. The numbers, the audit and the readers list are in
[paid-model-loading-coverage.md](paid-model-loading-coverage.md).

---

## Pre-deploy checklist

Everything here is the deploying engineer's, before this branch merges.

- [ ] **Confirm the production orchestrator is on beta.107.** Two things need it and they fail
      differently: beta.106's resource-list `preparation` (an older orchestrator's summary object
      reads as nothing to download — no panel, no Boost, anywhere), and beta.107's
      `rateLimitBytesPerSecond` (absent on beta.106, so every lane silently shows no speed while
      everything else works).
      *Closes when:* a preparing step's `preparation` from the production orchestrator is an array
      **and** its entries carry `rateLimitBytesPerSecond`.
- [ ] **`pnpm run typecheck`, `pnpm run lint`, `pnpm run prettier:write`, and the full
      `pnpm run test:unit:run` once.** Targeted suites are not a substitute for the last one.
- [ ] **Run `comment-review` over the diff and `docs-drift-review` over the commits.** The two lanes
      with no automated gate.
- [ ] **Manual pass in a browser.** The load indicators on the model page and in the generator have
      had one — Justin's preview review, 2026-09-22, which is where the "Not loaded" wording came from.
      Still unexercised: the queue card's download panel with its per-model rows and Boost button
      (including in the narrow sidebar layout), the lanes explainer, the pre-submit alert and Boost
      switch in **both** generator forms, compared against the mockup, the picker's marks and its
      **Loaded only** filter, and — **on a narrow viewport** — that the alert is hidden, that
      `DownloadBoostConfirm` appears on Generate, and that dismissing it sends nothing rather than
      submitting unboosted.
- [ ] **Boost a real queued workflow end to end.**
      *Closes when:* the workflow reports `downloadPriority: "high"` and `cost.fixed.downloadPriority`
      was charged.
- [ ] **Tell checkpoint bidders on the auctions page what winning buys now.** Coverage no longer
      gates on `CoveredCheckpoint`, so a win stops unlocking generation; the page should say that a
      winning checkpoint gets the orchestrator's highest download priority instead. The mini endpoint
      (`/api/v1/model-versions/mini/[id]`) reports a winner as `isPromoted`; the orchestrator has to
      act on it before the copy ships.
      *Closes when:* the auctions page states it for checkpoint auctions **and** a winning
      checkpoint's download is observed in the high lane.
- [ ] **Decide whether any of this ships behind a flag.** `resourceLoad` gates the moderator tool
      only: the queue-card panel, both generators' boost offers, the mobile confirm and every load
      indicator go live to everyone on deploy, so the only rollback is a revert.
      *Closes when:* a flag gates them, or Justin rules that it ships unflagged and that ruling is
      recorded here.
- [ ] **Apply the models index's filterable attributes — before the FLAG, not before the deploy.**
      `versions.generatorLoaded`, `canGenerateNext` and `versions.canGenerateNext` are in
      `modelsFilterableAttributes` but that list is inert on a live index until
      `/api/admin/temp/apply-models-index-filterable-attributes` runs or a reset rebuilds it, and
      Meilisearch rejects a search filtering on an attribute it has not been told about. With
      `generation-coverage-next` off the picker filters on `canGenerate`, which is already applied, so
      the deploy is safe without this. **Turning the flag on without it empties the modal entirely**,
      because every picker query then filters on `canGenerateNext`. `versions.generatorLoaded` gates
      the **Loaded only** filter the same way. Reindexing alone does not do it. Budget hours, not
      minutes: the last settings update took 6.5 min to process after ~2h50m queued.
      *Closes when:* the models index reports all three among its filterable attributes, and with the
      flag on the picker returns results both with and without **Loaded only**.
- [ ] **Check the preview environment before reading anything into it.** The indicators need main's
      `generatorLoaded` migration applied to the database preview points at, and
      `sync-generator-loaded-resources` on for it; without either, the Create badge reads "Not
      loaded" on every version while the version strip and the picker mark nothing at all.
      *Closes when:* a version known to be resident shows the loaded mark on its model page in
      preview.
- [x] **`20260909180000_generation_coverage_next_safetensor_checkpoints` — superseded, do NOT apply
      again.** Amended in place 2026-09-11 with a top-level `AND m.mode IS NULL` after it had already
      been applied, so it needed applying again. **Done 2026-09-11**; verified: covered rows 931,496,
      covered checkpoints 31,486, covered rows whose model carries a `mode` **0**. Its body still
      carries the `CoveredCheckpoint` disjunct that `20260922190000` removed — re-running it would
      undo the narrowing production has.
- [x] **Apply `20260922190000_generation_coverage_next_drop_covered_checkpoint`.** Came from `main`;
      redefines `GenerationCoverageNext` without `CoveredCheckpoint`, so the weekly auction's residency
      list no longer excuses a checkpoint from the SafeTensor requirement (Justin, 2026-09-22). It
      reproduces the top-level `m.mode IS NULL`, so it **supersedes `20260909180000` — apply this
      file, never that one** (why, and the measured delta:
      [paid-model-loading-coverage.md](paid-model-loading-coverage.md), the migration-history block at
      the top). **Done 2026-09-22**, on production.
- [ ] **Apply `20260923140000_generation_coverage_two_rules_one_view`, with its three follow-up
      steps.** It replaces `GenerationCoverage` with one view carrying `covered` + `coveredNext`, and
      it **narrows `covered` the moment it runs**: `m.mode IS NULL` now guards the live rule, so 1,801
      versions of `Archived`/`TakenDown` models (measured on the replica 2026-09-23) lose coverage.
      Coverage is cached, so follow the steps in the migration header — capture the affected ids
      first, purge `packed:generation:resource-data-*` and `packed:caches:data-for-model*` **by key**,
      then re-queue those models into the models index. The two cache key versions were bumped in this
      change (`…resource-data-4`, `…data-for-model-2`), so entries written by the previous build are
      not read either way.
      *Closes when:* `SELECT count(*) FROM "GenerationCoverage" gc JOIN "Model" m ON m.id = gc."modelId"
      WHERE m.mode IS NOT NULL AND gc.covered` returns 0, and the affected models are back in the index.
- [ ] **Confirm `generation-coverage-next` exists in Flipt and is OFF.** It is boolean-only and
      global. An unknown key evaluates false, which is the same answer as "off" — so verify the key is
      present rather than inferring it from the site behaving as expected.
      *Closes when:* the flag is listed in Flipt with its default off.
- [x] **`pnpm run db:check-generated`** after `GenerationCoverage` gained `coveredNext` — passes; the
      generated change is the new column on the Kysely type and the model list.

⚠️ Migrations here are **applied by hand** (psql/retool). This repo never runs `prisma migrate deploy`.

## Post-deploy checklist

- [ ] **Re-queue EVERY model before turning `generation-coverage-next` on** — not only the ~12,900
      that change answer. `canGenerateNext` exists only on documents written since `db635a3a45`, and a
      Meilisearch filter matches nothing on a document missing the attribute, so once the picker gates
      on it every un-rebuilt document is invisible. The ~12,900 figure is how many models *change
      answer*, not how many need re-queueing. Both fields go at the cutover, when `canGenerate`
      answers this on its own.
      *Closes when:* with the flag on, the picker returns a full first page, and a newly covered
      checkpoint (e.g. version 1413133) reports `canGenerateNext: true` in the models index.
- [ ] **Drop `GenerationCoverageNext`.** It is left in place only so pods on the previous build keep
      working, and no code in this repo references it after this change. It is frozen at its
      `20260922190000` definition, so every day it survives it drifts further from the live view —
      anyone querying it gets an answer the site does not give.
      *Closes when:* `DROP VIEW "GenerationCoverageNext"` has run in production and
      `grep -rn GenerationCoverageNext` over the repo returns nothing but history.
- [ ] **Bring `event-engine-common` onto the staged rule.** Its model feed (`feeds/models.feed.ts`)
      and model-data cache (`caches/modelData.cache.ts`) select `gc.covered` from `GenerationCoverage`
      in raw SQL, in a separate repo. That keeps working unchanged — the column still exists and still
      answers the live rule — so nothing breaks on deploy; but when `generation-coverage-next` goes
      on, its two surfaces keep answering under the old rule. Point both at `coveredNext`, or give
      that repo the same flag read.
      *Closes when:* both files select `coveredNext`, or the flag is retired and `covered` is the only
      column left.
- [ ] **Watch the first real boosts.** The orchestrator's price is unconfirmed at volume: check that
      `cost.fixed.downloadPriority` matches what users were quoted, and that refusals ("price
      changed", "nothing left to boost") are rare rather than routine.
- [ ] **Watch the eviction metric** (C13 surfaced it; nothing looks at it). It is the only instrument
      for the starvation concern — a pile of queued small checkpoints starving popular ones.
      *Closes when:* it is on a dashboard someone named is watching.
- [ ] **Watch `getResidency`** — its 120/min rate limit and its cache hit ratio. The model page and
      the picker read the column instead, so what is left on it is the generator's marks and the two
      **Generation** rows.
- [ ] **Keep `sync-generator-loaded-resources` on.** Every column-backed indicator is only as fresh
      as that job: with the flag off the column freezes at its last value, so the marks keep stating
      a residency nobody is maintaining.
      *Closes when:* the flag is on in production and the job's `flippedIn`/`flippedOut` counts are
      non-zero across a day.
- [ ] **Set `usageControl = 'ExternalGeneration'` on the 36 mislabelled API versions.** All published,
      none POI, coverage preserved 36/36; a direct DB write, since the app refuses the value from
      non-moderators.
- [ ] **Look at the widened pool consumers** — daily-challenge model selection, App Blocks' workflow
      service, and the model-list filters in `model.service.ts` and `caches.ts`.
- [ ] **Delete `getCheckpointGenerationCoverage`** (zero callers) and decide whether
      `handle-auctions.ts` keeps writing `CoveredCheckpoint` rows. Coverage no longer reads them, but
      `/api/v1/model-versions/mini/[id]` derives `isPromoted` from them, so retiring the writes
      retires that field too.
      *Closes when:* the function is deleted and the auction's writes are kept or retired together
      with `isPromoted`.

---

## Open, with owners

| # | Question | Owner | Closes when |
| --- | --- | --- | --- |
| C2 | **Pricing.** `PrepareResourceHandler.CalculateCost` returns a hardcoded zero, so the explicit load quotes 0. The boost has its own fee and is unaffected. ([868ktt57p](https://app.clickup.com/t/868ktt57p)) | Koen | a prepare returns a non-zero cost |
| — | **The boost price itself** — whether it scales with size, is cheaper for members, or applies to LoRAs. The UI reads `cost.fixed.downloadPriority` and computes nothing, so a change needs no site work. | Koen / Justin | the numbers are set |
| — | **The unboosted ETA.** A whatIf priced at `high` reports the high-lane ETA, so one request may not say how long the user waits *without* boosting. The generator sidesteps it by pricing at the user's own lane. | Koen | confirmed either way |
| — | **Price shown ≠ price charged, structurally.** The charging `PUT` takes no expected price; we re-price immediately before charging and refuse on a mismatch. An expected-price field on the orchestrator would close the window properly. | Koen | such a field exists, or we accept the re-price |
| — | **Does an unbounded generation still refund?** The site sends no step `timeout` and the queue card no longer promises an automatic refund. Whether the orchestrator expires a job on its own, after how long, and whether it refunds undelivered images, is unverified — and support has no line to give a user whose job sits in the free lane. | Koen | he states the orchestrator's own expiry and refund behaviour with no step `timeout` set, and it is written into the timeouts paragraph above |
| K3 | **Does the orchestrator refund a failed prepare?** Never exercised, because no prepare has ever been charged. Matters for the moderator tool, not the boost. | Koen | he answers |
| 2.5 | **The rate-limit numbers are off by one** — `attempts > limit`, so 3/6/10 permit 4/7/11. Renumber to 2/5/9, or keep and say so. Documented beside the limiter either way; do not "fix" the shared comparison. | whoever closes C10 | renumbered, or the decision taken |
| 2.6 | **17 base models claim generation support in `basemodel.constants.ts` with no `GenerationBaseModel` row**, and 5 rows exist the constants do not declare. Nothing detects the disagreement. Predates this feature. | unowned | rows added, constants corrected, or a guard pins them |
| 2.7 | **Diffusers checkpoints lose coverage** (174 of the 2,242) because the loader serves SafeTensor only. Accept as a loader constraint, or teach the loader Diffusers? | Justin | he answers, or it ships narrowed |
| — | **Load state in search** was deferred, and the coverage widening is the surface that deferral collides with. The data exists: the index carries `versions.generatorLoaded`, synced every 5 minutes by `sync-generator-loaded-resources`; what is left is the display decision. | Justin | a decision |
| — | **The `covered` field in `/api/v1/model-versions/mini/[id]` changed meaning** for third-party consumers, unannounced. | Briant / team | announced, or judged not worth it |
| C11 | **Retire auctions.** Paid loading replaces the cluster-residency half; the featuring half needs rehoming, and that is 868gtq1kt's answer first. ~89 files. | unscoped | 868gtq1kt answers |
| — | **Phase A ratifications:** the fifth `unknown` state, `estimate` returning `{ cost, priced }`, and `currencies: getAllowedAccountTypes(...)` deciding which Buzz account pays. All live, all cheap to reverse now. | Briant / team | "fine", or name the one to change |

---

## Decided — do not relitigate

### The model

All of it is in [How it works](#how-it-works), and all of it is decided — none of those bullets is
open. The one thing not stated there: **one paid lane, so a boost is never outbid.**

### Coverage

The rules are in [Coverage, in one paragraph](#coverage-in-one-paragraph) and every one is decided.
Three that are not stated there: loading is for checkpoints (size is why the loader exists); only base
models in `GenerationBaseModel` are loadable; and coverage means *allowed to generate*, while residency
is the orchestrator's axis.

### Surfaces and delivery

- Load state from `ModelVersion.generatorLoaded` — the version strip, the Create badge, the picker's
  results — renders for signed-out visitors, since it is page and index data. The live `getResidency`
  reads behind it are signed-in. The queue listing and the uncapped `getState` are behind the
  `resourceLoad` flag and serve the moderator tool alone — the public `/generate/downloads` page was
  built and removed on this branch (2026-09-16).
- Progress signals go to the buyer's own channel, never a model-version group.
- A browser keeps what it is *watching* in `localStorage`, drained on every page load, with a 48h
  ceiling so every item can leave. The durable record of a purchase is the orchestrator's — workflows
  tagged `resource-load`, queried with the buyer's token.
- Bystanders get told when a load is ready, not live progress. Real notifications are Phase 2.
- Rate limits are site-side only; the orchestrator accepts unlimited prepares from a user token.
- The explicit purchase path stays as a moderator tool (2026-09-11).
- `PinModelJob` is legacy and not part of this feature.

## Not being built

- A queue ranking algorithm — the orchestrator merges, de-dupes and ranks.
- A size→price table — the orchestrator prices; the UI reads `whatif`.
- A residency countdown — nothing reports when a window ends.
- A C4-style webhook — closed 2026-09-08; reopens only if Phase 2 notifications need a server-side
  moment.
- Load state on the site's search pages, for now — the index carries `versions.generatorLoaded`, and
  the generation resource picker is its only reader (see **Load indicators**).
- Any promise about *arrival* time. Bandwidth into the DC was ~10 KB/s at the 2026-08-18 call, and
  `PrepareResourceJob` gives up at 24h.
