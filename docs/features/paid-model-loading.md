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

**Queue card** (`QueueItem.tsx` → `DownloadBoost`), while a pending step reports `preparation`:
download queue position or progress, approximate ETA and boosted ETA, the lane with an explainer, one
line per file when several are pending, a link to the download queue, and a **Boost** button whose
confirmation prices the boost on open — listing the queue prices nothing. A **Boosted** badge
replaces it afterwards.

**Generator — both forms** (`generation_v2` data-graph and form-graph): when the whatIf reports
downloads, `DownloadReadyAlert` shows queue position and ETA plus a **pre-boost switch**. The switch
re-runs the whatIf at `downloadPriority: "high"` (which is where its price comes from) and the submit
then carries the boost. It is pinned to the form revision, so it never carries over to a selection the
user has not re-priced, and it clears after a submit (`usePreBoost`).

**Load indicators**, checkpoints only: inside the model page's **Create** button, on the selected
checkpoint in both forms, and on checkpoint results in the resource picker. Backed by
`resourceLoad.getResidency` — signed-in, ≤50 ids, rate-limited, cached 30s per version, and batched
one request per picker page.

**Public download queue** at `/generate/downloads`: what is downloading and queued with size, lane and
ETA, the lane explainer, and the viewer's own versions highlighted via `?versions=`. Cached 10s and
edge-cached. A row whose model is not public keeps its place but loses its name.

**Moderator tool** at `/moderator/resource-load` (flag `resourceLoad`): the explicit purchase path —
`resourceLoad.estimate` / `submit`, the per-tier caps, the `resource-load:update` signal and the
load-complete toast. Kept deliberately (2026-09-11) for pricing and observing a single download.

**Coverage** — every reader of `GenerationCoverage` reads `GenerationCoverageNext` (Prisma `@@map`
plus the raw-SQL queries), which is what lets a normal user pick a checkpoint that is not loaded.

**Money-path properties worth keeping true:**

- The boost is charged only at the price the user confirmed: `boostWorkflow` re-prices first and
  refuses, charging nothing, if the price moved or nothing is left to boost.
- After the charge, a failed read reports the boost as done rather than as an error, so a retry
  cannot pay twice.
- A pre-boosted submit sends `downloadPriority` only when a whatIf shows something waiting to
  download.
- ETAs shown to users are approximate (`formatDownloadEta`); the moderator page keeps exact figures.

---

## The orchestrator contract

Read `node_modules/@civitai/orchestration-client/dist/generated/types.gen.d.ts` rather than trusting
this section once it ages. The app's own orchestrator calls still go through the older
`@civitai/client`, which predates `downloadPriority` and `preparation` — hence the casts around them.

### Step preparation — what the card and the alert render

`WorkflowStep.preparation` (`WorkflowStepPreparation`) carries the gating resource, `queuePosition`,
`progress`, `etaSeconds`, `lane`, `boostedEtaSeconds` (null once already `high`), and `resources[]` —
every resource the step waits on, **gating resource first**, each with `sizeBytes`, `lane`,
`queuePosition`, `progress`, `bytesPerSecond` and its own ETAs.

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
every request, so paging is unstable — show one page and poll it. Each item costs two grain calls, so
`take` stays small (clamped 1..500, default 100).

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

`CoveredCheckpoint` — the weekly auction's residency proxy — stops gating. `EcosystemCheckpoints`
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

- [ ] **Remove the debug logging.** Four sites, kept deliberately for manual testing:
      `useWhatIfFromGraph.ts`, form-graph `WhatIfProvider.tsx`, `submitWorkflow`'s `console.dir` in
      `workflows.ts`, and the dev-only `raw` field in `whatIfFromGraph`.
      *Closes when:* none of the four remains in the diff.
- [ ] **`pnpm run typecheck`, `pnpm run lint`, `pnpm run prettier:write`, and the full
      `pnpm run test:unit:run` once.** Targeted suites are not a substitute for the last one.
- [ ] **Run `comment-review` over the diff and `docs-drift-review` over the commits.** The two lanes
      with no automated gate.
- [ ] **Manual pass in a browser**, none of which has been exercised: the queue card's download panel
      and priced confirmation (including in the narrow sidebar layout), the pre-submit alert and
      pre-boost switch in **both** generator forms, the Create-button and picker indicators, and
      `/generate/downloads`.
- [ ] **Boost a real queued workflow end to end.**
      *Closes when:* the workflow reports `downloadPriority: "high"` and `cost.fixed.downloadPriority`
      was charged.
- [x] **Apply `20260909180000_generation_coverage_next_safetensor_checkpoints`.** Amended in place
      2026-09-11 with a top-level `AND m.mode IS NULL` after it had already been applied, so it needed
      applying again. **Done 2026-09-11**; verified: covered rows 931,496, covered checkpoints 31,486,
      covered rows whose model carries a `mode` **0**.
- [x] **`pnpm run db:check-generated`** after the Prisma `@@map` — passes; the only generated change
      is the Kysely table key.

⚠️ Migrations here are **applied by hand** (psql/retool). This repo never runs `prisma migrate deploy`.

## Post-deploy checklist

- [ ] **Reindex models search.** Its indexed `canGenerate` is derived from coverage, so it keeps the
      old rule until each model is reindexed — and it advertises generatable without saying "needs
      loading first".
      *Closes when:* a newly covered checkpoint (e.g. version 1413133) reports `canGenerate: true` in
      the models index.
- [ ] **Bring `event-engine-common` onto the new coverage.** Its model feed
      (`feeds/models.feed.ts`) and model-data cache (`caches/modelData.cache.ts`) still query
      `GenerationCoverage` in raw SQL, in a separate repo. Either point both at
      `GenerationCoverageNext`, or redefine `GenerationCoverage` with its body so no reader changes.
      *Closes when:* both files name the new view, or the two views return the same row count in
      production.
- [ ] **Watch the first real boosts.** The orchestrator's price is unconfirmed at volume: check that
      `cost.fixed.downloadPriority` matches what users were quoted, and that refusals ("price
      changed", "nothing left to boost") are rare rather than routine.
- [ ] **Watch the eviction metric** (C13 surfaced it; nothing looks at it). It is the only instrument
      for the starvation concern — a pile of queued small checkpoints starving popular ones.
      *Closes when:* it is on a dashboard someone named is watching.
- [ ] **Watch `getResidency`** — its 120/min rate limit and its cache hit ratio, now that the model
      page and the picker call it on ordinary page views.
- [ ] **Set `usageControl = 'ExternalGeneration'` on the 36 mislabelled API versions.** All published,
      none POI, coverage preserved 36/36; a direct DB write, since the app refuses the value from
      non-moderators.
- [ ] **Look at the widened pool consumers** — daily-challenge model selection, App Blocks' workflow
      service, and the model-list filters in `model.service.ts` and `caches.ts`.
- [ ] **Delete `getCheckpointGenerationCoverage`** (zero callers) and decide whether
      `handle-auctions.ts` keeps writing `CoveredCheckpoint` rows nothing reads.

---

## Open, with owners

| # | Question | Owner | Closes when |
| --- | --- | --- | --- |
| C2 | **Pricing.** `PrepareResourceHandler.CalculateCost` returns a hardcoded zero, so the explicit load quotes 0. The boost has its own fee and is unaffected. ([868ktt57p](https://app.clickup.com/t/868ktt57p)) | Koen | a prepare returns a non-zero cost |
| — | **The boost price itself** — whether it scales with size, is cheaper for members, or applies to LoRAs. The UI reads `cost.fixed.downloadPriority` and computes nothing, so a change needs no site work. | Koen / Justin | the numbers are set |
| — | **The unboosted ETA.** A whatIf priced at `high` reports the high-lane ETA, so one request may not say how long the user waits *without* boosting. The generator sidesteps it by pricing at the user's own lane. | Koen | confirmed either way |
| — | **Price shown ≠ price charged, structurally.** The charging `PUT` takes no expected price; we re-price immediately before charging and refuse on a mismatch. An expected-price field on the orchestrator would close the window properly. | Koen | such a field exists, or we accept the re-price |
| K3 | **Does the orchestrator refund a failed prepare?** Never exercised, because no prepare has ever been charged. Matters for the moderator tool, not the boost. | Koen | he answers |
| 2.5 | **The rate-limit numbers are off by one** — `attempts > limit`, so 3/6/10 permit 4/7/11. Renumber to 2/5/9, or keep and say so. Documented beside the limiter either way; do not "fix" the shared comparison. | whoever closes C10 | renumbered, or the decision taken |
| 2.6 | **17 base models claim generation support in `basemodel.constants.ts` with no `GenerationBaseModel` row**, and 5 rows exist the constants do not declare. Nothing detects the disagreement. Predates this feature. | unowned | rows added, constants corrected, or a guard pins them |
| 2.7 | **Diffusers checkpoints lose coverage** (174 of the 2,242) because the loader serves SafeTensor only. Accept as a loader constraint, or teach the loader Diffusers? | Justin | he answers, or it ships narrowed |
| — | **Load state in search** was deferred, and the coverage widening is the surface that deferral collides with. | Justin | a decision |
| — | **The `covered` field in `/api/v1/model-versions/mini/[id]` changed meaning** for third-party consumers, unannounced. | Briant / team | announced, or judged not worth it |
| C11 | **Retire auctions.** Paid loading replaces the cluster-residency half; the featuring half needs rehoming, and that is 868gtq1kt's answer first. ~89 files. | unscoped | 868gtq1kt answers |
| — | **Phase A ratifications:** the fifth `unknown` state, `estimate` returning `{ cost, priced }`, and `currencies: getAllowedAccountTypes(...)` deciding which Buzz account pays. All live, all cheap to reverse now. | Briant / team | "fine", or name the one to change |

---

## Decided — do not relitigate

### The model

- Generation is always accepted; downloads are free; the queue slot is the cost.
- Paying buys lane priority, not access. One paid lane, so a boost is never outbid.
- Members get `normal`, non-members `low`, boosting gives `high`.
- Cancelling a queued job removes its downloads — an abuse control alongside the lanes.
- A boost moves the whole workflow, LoRAs included; whether LoRAs are *charged* is Koen's pricing
  question.
- The UI shows the worst resource, never "1 of 3".

### Coverage

- `CoveredCheckpoint` stops gating generation; `EcosystemCheckpoints` and `GenerationBaseModel` stay.
- Loading is for checkpoints — size is why the loader exists.
- Only base models in `GenerationBaseModel` are loadable.
- A checkpoint needs a SafeTensor weight file; file-less API models never load.
- Taken-down and archived models are not covered, for any type.
- The purchase path refuses anything outside coverage, which is how `RentCivit` is enforced.
- Coverage means *allowed to generate*; residency is the orchestrator's axis.

### Surfaces and delivery

- Load state and the queue are **public reads**.
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
- Load state in search results, for now.
- Any promise about *arrival* time. Bandwidth into the DC was ~10 KB/s at the 2026-08-18 call, and
  `PrepareResourceJob` gives up at 24h.
