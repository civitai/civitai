# Paid Model Loading — implementation checklist

Companion to [paid-model-loading.md](paid-model-loading.md), which holds the contract and the
decisions, [paid-model-loading-build-plan.md](paid-model-loading-build-plan.md), which is the
inventory of files, procedures, pages and components, and
[paid-model-loading-decisions.md](paid-model-loading-decisions.md), which collects every open
decision with an owner and a closing condition. This file is the state of the work.

ClickUp ids are the C-numbers from the 2026-08-18 lab call. Items with no C-number are gaps found
while reading the contract and the code; they have no ClickUp task and no owner yet.

---

## Phase 0 — decisions, all now made

**Closed 2026-09-08.** Every Phase 0 decision has an answer; none of them gates work any more. They
are kept, with the answers and who gave them, in
[paid-model-loading-decisions.md](paid-model-loading-decisions.md) §1–§2. The coverage model they
produced, and the production audit behind it, is
[paid-model-loading-coverage.md](paid-model-loading-coverage.md).

- [x] **C14 — demo client, mod-only, or platform.** Start with the mod test page, which already
      exists (Phase 1.5). ([868ktt5bz](https://app.clickup.com/t/868ktt5bz))
- [x] **What we can honestly sell.** The 48 hours as originally pitched. A copy may move between
      spine controllers inside the window; availability does not lapse.
- [x] **"Select any model".** Checkpoints only — size is why the loader exists and LoRAs do not have
      it. `CoveredCheckpoint` stops gating generation; `EcosystemCheckpoints` and
      `GenerationBaseModel` stay. **The earlier LoRA-first recommendation in these docs was wrong**
      and has been removed.
- [x] 🔴 **Models without a `RentCivit` licence.** Refuse. Implemented as "refuse anything not in
      `GenerationCoverage`" — the same set today (**zero covered versions lack the licence**), and it
      inherits the rule instead of restating it.

Not blocking site work, but blocking **launch**:

- [ ] **C2 — pricing by model size, and enable charging.** Koen.
      ([868ktt57p](https://app.clickup.com/t/868ktt57p)) Verified: this is not a toggle —
      `PrepareResourceHandler.CalculateCost` returns a hardcoded zero, so the pricing function has
      to be written. Until then `whatif` returns 0 and the CTA has no number.

Already done, verified:

- [x] **C3 — Koen's handoff doc** ([868ktt582](https://app.clickup.com/t/868ktt582))
- [x] **C13 — eviction metric** ([868ktt5ba](https://app.clickup.com/t/868ktt5ba))

---

## Phase 1 — the plumbing

No user-visible surface. Everything in Phase 2 and 3 sits on this, and it is testable on its own
against a real download.

- [x] **C4 — the endpoint the orchestrator hits when a download starts/progresses.** **Closed as
      "not now"** — see [2.4](paid-model-loading-decisions.md#24--the-c4-webhook--not-now). Both its
      reasons went away: C9 is Phase 2, and bystanders need notification rather than live progress.
      Reopens with Phase 2, which needs a server-side moment to send from.
      ([868ktt58f](https://app.clickup.com/t/868ktt58f))
- [x] **Topic broadcast helper.** `sendSignalToTopic(topic, message, data)` in
      `src/server/orchestrator/orchestrator.utils.ts`, wrapped in `withSignals()`. ⚠️ **Still unused,
      and no longer has a planned caller** — load progress is per-user now, and C4 is closed. It is
      here for whatever Phase 2 needs; delete it if Phase 2 does not want it.
- [x] **New `SignalMessages` entry** — `ResourceLoadUpdate = 'resource-load:update'`, delivered on
      the **user's own channel**, not a topic. No collision with `SchedulerDownload`.
- [x] **Extract versionId → AIR.** `modelVersionToAir` in `src/server/utils/resource-air.ts`;
      `bustOrchestratorModelCache` and `modelVersionResourceCache` both repointed at it.
      `fileType` comes from the primary file when the caller loaded files, and the two existing
      callers keep the AIRs they had.
- [x] **Server-side resource-state read.** `getResourceLoadState(versionIds)` and
      `getResourceLoadQueue({cursor, take})` in `src/server/services/resource-load.service.ts`,
      exposed as `resourceLoad.getState` / `resourceLoad.getQueue` (both `publicProcedure`,
      flag-gated until C5 — see the amplification note in the router). The queue read
      goes through a new `queryResourcesClient` wrapper beside `getModelClient`, so the SDK stays
      in `services/orchestrator/models.ts`.
  - [x] fresh, uncached — `modelVersionResourceCache` is not reused
  - [x] a status this build does not know is reported as `unknown`, not folded into one of the four
- [x] **Service tests** — `src/server/services/__tests__/resource-load.service.test.ts`: AIR
      construction, `queuePosition` on `unavailable`, the `unknown` fallback, unresolvable queue
      rows, four pre-submit refusals (not generatable, no weight file, unscanned file, no such
      version), the progress URL going to `/users/` and never `/groups/`, owner-check propagation,
      priced vs unpriced. Not yet pinned: the `unsupported` and already-`available` refusals.
- [ ] **The purchase path.** `resourceLoad.estimate` (whatIf) and `resourceLoad.submit` exist, are
      gated, and work; what is missing is a price to show.
  - [x] 🔴 `assertWorkflowOwner` on the submit result
  - [x] refuse when `status === 'unsupported'`, and when we could not read the status at all
  - [x] refuse (without charging) when already `available`
  - [x] price from a `whatIf` submit rather than a site-side table — the procedure returns
        `{ cost, priced }`, and `priced` is false while the orchestrator quotes zero, so no surface
        can render "free" as a quote. Still blocked on C2 for a real number.
  - [ ] surface the orchestrator's own `CanGenerate` rejection cleanly — `PrepareResourceInput`
        throws a ValidationException before any charge
  - [x] 🔴 refuse when the model lacks a `RentCivit` licence — implemented as `resolveLoadable`'s
        `!eligible` refusal: coverage (`GenerationCoverageNext`) composed with ecosystem type support
        by `isGenerationEligible`, on both `estimate` and `submit`.
- [ ] **C10 — per-tier daily rate limits.** ([868ktt5aq](https://app.clickup.com/t/868ktt5aq))
  - [x] 🔴 the free row is an **unconditional catch-all** and `founder` has its own row
  - [x] `onlyCountSuccess: true`, so a refused purchase does not burn a slot
  - [x] `sharedKey: 'resource-load:submit'`
  - [ ] 🔴 apply that **same `sharedKey`** on the generation submit path, or the implicit
        prepare-via-txt2img route bypasses the cap entirely. **Not done** — the cap is currently
        decorative for anyone who generates instead of pressing the button.
  - [x] the off-by-one is written down beside the limiter — the docstring in
        `resource-load.router.ts` states that `attempts > limit` makes each nonzero number permit
        one more load than it says. Whether to renumber to 2/5/9 instead is
        [2.5](paid-model-loading-decisions.md#25-the-rate-limit-numbers-are-off-by-one).

---

## Phase 1.5 — the mod test page

Not in the build plan; asked for while building Phase A so the plumbing could be driven end to end
before any of Phase 2 exists.

- [x] **`/moderator/resource-load`** — `requireModerator` plus the `resourceLoad` flag.
  - [x] enter a model version id and see it resolved **before** committing: name, AIR, size,
        availability, and whether it is generatable / has weights
  - [x] the estimate button is disabled with the reason shown, rather than failing on submit
  - [x] the estimate names itself as unpriced while the orchestrator quotes zero
  - [x] a "Waiting on" list from the persisted store, with live progress and "Stop watching"
  - [x] the cluster queue, polled every 15s, preferring live signal progress where there is any
  - [x] live progress over the buyer's own signals channel
  - ⚠️ moderators are exempt from `rateLimit()`, so this page exercises none of C10
- [x] **Tracking and notification** — `src/store/resource-load.store.ts` (persisted, self-draining,
      48h ceiling) and `ResourceLoadDrain` mounted in `AppHeader` for any signed-in user with the
      `resourceLoad` flag, so a finished load is reported wherever they land next. Toasts require
      dismissal. See
      [1.5](paid-model-loading-decisions.md#15--notification-is-a-toast-on-return-real-notifications-are-phase-2).
- [ ] **Nothing outside this page can start watching yet.** The store supports `kind: 'watching'`
      and the drain reports it, but the button that creates one is C5 on the model version page. So
      bystander notification is built and unreachable.

---

## Phase 1.6 — the coverage change

Created by the Phase 0 answers on 2026-09-08. Nothing here is written yet. The rule, the audit and
every measured number are in [paid-model-loading-coverage.md](paid-model-loading-coverage.md).

- [x] **A new coverage view alongside `GenerationCoverage`** —
      `packages/civitai-db-schema/prisma/migrations/20260908120000_generation_coverage_next/migration.sql`,
      creating `GenerationCoverageNext`. **Applied to production 2026-09-08.** 🔴 Not named
      `GenerationCoverage2`: that view already exists in production as a stale earlier experiment, and
      `CREATE OR REPLACE` on the name would have silently overwritten it. Deliberately not added to
      `schema.full.prisma` — the cutover replaces `GenerationCoverage`'s own body with this one and
      drops this view, so the Prisma model never changes. Three branches: no-loadable-file (covered, never loaded), in
      `EcosystemCheckpoints` with a loadable file, and checkpoint on a `GenerationBaseModel` base
      model with a loadable file. The LORA/TI/VAE/LoCon/DoRA/Upscaler branch is unchanged.
  - [x] drop the `CoveredCheckpoint` conjunct, and allow `Diffusers` while keeping Core ML and ONNX
        excluded — [the numbers](paid-model-loading-coverage.md#what-changes-in-numbers)
  - [x] **checkpoints require a SafeTensor weight file** —
        `20260909180000_generation_coverage_next_safetensor_checkpoints`, 2026-09-09. Narrows the
        2026-09-08 view: Diffusers stays loadable for every type *except* checkpoints, and
        `CoveredCheckpoint` returns as a disjunct excusing 6 auction-resident versions.
        **Written, not yet applied to any environment.**
  - [ ] 🔴 keep `EcosystemCheckpoints` — 62 of 63 checkpoint defaults depend on it
  - [x] diffed against production 2026-09-08 — nothing lost coverage *at that point*; [the numbers](paid-model-loading-coverage.md#what-changes-in-numbers)
  - [ ] 🔴 **2,242 covered checkpoints lose coverage when the SafeTensor migration is applied**
        (33,811 -> 31,569; 834 with generation history, 6.5M lifetime generations). A narrowing, so
        there is no safe window — apply it when the readers of `covered` are ready.
        *Closes when:* applied to production and the covered-checkpoint count reads 31,569.
- [ ] **Set `usageControl = 'ExternalGeneration'` on the 36 mislabelled API versions.** All
      published, none POI, coverage preserved 36/36. Mod-only to set via the app, so it is a direct
      DB write.
- [x] **One derivation of `canGenerate`.** `isGenerationEligible` in
      `packages/civitai-shared/src/generation-eligibility.ts`, with all four call sites repointed
      and `no-divergent-can-generate-derivation` keeping `isBaseModelGenerationSupported` out of
      `src/`. Coverage alone over-reports by **736 versions**; see
      [coverage](paid-model-loading-coverage.md#covered-is-not-cangenerate).
- [x] **Gate the load CTA on `isGenerationEligible` AND "has a loadable file"** — not on `covered`,
      not on `usageControl`, and not on "has any file". Done on the mod page and enforced
      server-side in `resolveLoadable`; re-check when C5/C6 add public CTAs.
- [x] **Refuse anything not in coverage** on `estimate` and `submit` (this is the `RentCivit` gate) —
      `resolveLoadable`, reading `GenerationCoverageNext`.
- [x] **Audit every existing reader of `covered`.** 23 files, classified in
      [coverage](paid-model-loading-coverage.md#the-covered-readers-audit). Findings below are what
      it produced.
- [ ] 🔴 **The shared rate-limit key on the generation submit path, and C2 pricing, must land BEFORE
      the SITE'S GENERATION GATE reads the new view** — `generation.service`, `resource-data.redis`,
      the search index. Widening those makes tens of thousands more versions generatable, and a
      generation submitted against a non-resident one triggers an implicit prepare — free today, and
      uncapped, because C10 only guards `resourceLoad.submit`.
      Two callers already read `GenerationCoverageNext` and are deliberately outside that rule:
      `resource-load.service` (the purchase path — flag-gated, and the widened set is the point) and
      `/api/v1/model-versions/mini/[id]` (read by the orchestrator for `CanGenerate`; no site code
      calls it, so it widens what the orchestrator accepts without changing what a user sees).
- [ ] **Decide what search shows.** The index derives `canGenerate` from `covered`, so the swap
      advertises tens of thousands more models as generatable with no way to say "needs loading
      first". Load
      state in search was deferred; this is the surface that deferral now collides with.
- [x] **Check the public API field.** `/api/v1/model-versions/mini/[id]` now selects `covered` from
      `GenerationCoverageNext` — done 2026-09-08, because the orchestrator reads it for `CanGenerate`
      and on the live view refused every load worth making (verified on version 3040959).
      ⚠️ The field's meaning changed for third-party consumers, unflagged and unannounced. Decide
      whether that needs an announcement.
- [ ] **Look at the pool consumers** — daily-challenge model selection, App Blocks workflow service,
      the model-list filters in `model.service.ts` and `caches.ts`.
- [ ] **Delete `getCheckpointGenerationCoverage`** with `CoveredCheckpoint` — zero callers.
- [ ] **Decide what happens to `handle-auctions.ts`** once nothing reads the rows it writes.

---

## Phase 2 — the surfaces

Gated on C14. If the decision is a demo client, these become the demo client's screens first and
the platform second.

- [ ] **C5 — model version page.** ([868ktt58t](https://app.clickup.com/t/868ktt58t))
  - [ ] below the Create button; visible to **everyone**, not only the purchaser
  - [ ] four states, including no CTA at all for `unsupported`
  - [ ] subscribe button, so a bystander can adopt someone else's in-flight load
  - [ ] the page already subscribes to `model-version:<id>` — extend, do not add a second
        subscription
- [ ] **C6 — generator.** ([868ktt59c](https://app.clickup.com/t/868ktt59c))
  - [ ] not loaded → offer the paid load at the size-based price
  - [ ] downloading → auto-subscribe and show progress inline for the selected resource
  - [ ] loaded → unchanged
  - [x] the "select any model" decision is made — checkpoints only, coverage rule in
        [coverage](paid-model-loading-coverage.md). C6 now depends on **Phase 1.6** landing, not on a
        decision.
- [ ] **C7 — navbar indicator.** ([868ktt59j](https://app.clickup.com/t/868ktt59j))
  - [ ] mirror [`UploadTracker`](../../src/components/Resource/UploadTracker.tsx) — same
        `Indicator` + `Popover` shape, mounted next to it in `AppHeader`
  - [ ] queue position first, download progress once it starts, button through to the queue page
  - [ ] `localStorage` store; on mount poll the resource endpoint, drop what is done, resubscribe
        to the rest
  - [ ] the popover is inside the header — pass `withinPortal` explicitly (the app themes
        `Popover` to `withinPortal: false`)
- [ ] **C8 — queue page.** ([868ktt59y](https://app.clickup.com/t/868ktt59y))
  - [ ] reads `resourceLoad.getQueue` (which wraps `queryResources({ view: 'queue' })` server-side),
        polled
  - [ ] signal subscriptions only for the items *this* user is waiting on
  - [ ] ranking across providers is already done server-side — do not rebuild it
  - [ ] ⚠️ the cursor is an integer offset over a live re-ranked list, so paging is unstable; keep
        `take` small (each item costs two grain calls server-side)
- [ ] **C9 — notification on load complete.** ([868ktt5aj](https://app.clickup.com/t/868ktt5aj))
  - [ ] goes to the purchaser **and** to everyone who pressed subscribe on C5
  - [ ] needs a `NotificationCategory` and a settings entry — the
        `notification-settings-polarity` guard (`src/server/notifications/__tests__/`) pins the
        default's polarity

---

## Phase 3 — the consequences

- [ ] **Watch the eviction metric.** C13 surfaced it; nothing looks at it. Put it on a dashboard
      before the first public load, because it is the only instrument for Briant's starvation
      concern.
      *Closes when:* the metric is on a dashboard someone named is watching.
- [ ] **C11 — retire auctions.** ([868ktt5b2](https://app.clickup.com/t/868ktt5b2)) Do not scope
      until 868gtq1kt (splitting featuring out of auctions) has an answer — auctions do two jobs
      and paid loading replaces one. ~89 files under `src/`.
  - [x] the `CoveredCheckpoint` conflict is resolved by removing it as a coverage *conjunct*
        (Phase 1.6), so the auction job can no longer un-cover a paid checkpoint. It survives as a
        disjunct covering 6 auction-resident versions that lack a SafeTensor file — those would lose
        coverage on the next auction prune, but none is loadable, so none can have been paid for.
        What remains is deciding whether that job should keep writing rows nothing else reads.

---

## Orchestrator state — verified against source

Read directly from the orchestrator repo (`civitai-orchestration`, `main` at `9306e7333`), not from
the SDK. This section supersedes a list of questions that turned out to be answerable ourselves.

**This commit is deployed**, so everything below marked as built is live.

### Built and working

| Thing | State |
| --- | --- |
| `GET /v2/resources?view=queue` | **Implemented** (`ResourcesController.QueryAsync`). Merges every enabled provider's queue, de-dupes by AIR, ranks, and pages. One unreachable provider degrades to empty rather than failing the call. So Justin's "flatten the per-provider ranks into one 1..n list" is already done server-side — we do not build it. |
| `GET /v2/resources/{air}` | **Implemented**, stitches `availability` onto `ResourceInfo` at the controller and is response-cached per resource. |
| Four availability states | Confirmed exactly as the SDK types say (`ResourceAvailability.cs`), including `queuePosition` living only on `unavailable`. |
| `prepareResource` as a **workflow step** | **It exists** — `PrepareResourceStep`, with a handler, a `PrepareResourceJob`, and lifecycle validation. Marked `[Preview]`. It is not recipe-only, so the call's signal design holds. |
| Progress events | **They exist**, and `step:*` already receives them — see below. |
| Insta-success when already resident | The handler checks availability and emits no job if the resource is `available`. A duplicate prepare is therefore free and instant. |

### Progress events — resolved, and better than the SDK suggests

A step stuck on a download publishes a `WorkflowStepEvent` carrying
`Preparation { Resource, QueuePosition, Progress, EtaSeconds }` — the exact payload the UI needs.

- Refresh interval is **10 seconds** (`PreparationRefreshInterval`), which is where the call's
  "every 10 seconds" comes from. The comment explains why tighter is pointless: workers report
  resource costs at roughly that rate anyway.
- Publishing is **deduplicated on change**, at 1% progress granularity
  (`PreparationProgressPublishThreshold = 0.01`), so a full download costs at most ~100 events.
- The gating rule is "the least-progressed job gates the step".

🔴 **`step:preparing` is deliberately hidden from the OpenAPI enum.**
`WorkflowCallbackSchemaFilter` explicitly removes `preparing` and `scheduled` from the advertised
values, which is why the generated SDK union lists only lifecycle transitions and why this looked
like a missing feature. It is not missing — it is unadvertised.

**Subscribe with `step:*`, which matches every status including `Preparing`** — the dispatch test is
`x.EventType is null || x.EventType == @event.Status`. `getOrchestratorCallbacks` already uses
`step:*`, so generation receives these today.

### Not built

🔴 **This table once carried a residency row saying the 48-hour guarantee did not exist. That was
wrong**, and wrong in the most expensive direction: it said the product's headline feature was
missing. The mechanism lives in `civitai-spine-controller` — a repo this list never read — and
`PinModelJob`, named here as the intended primitive, is legacy (Koen, 2026-09-04). See
[Residency](#residency--in-a-repo-this-list-does-not-read) below. Only the pricing gap was real.

| Gap | Consequence |
| --- | --- |
| 🔴 **Cost is hardcoded to zero.** `PrepareResourceHandler.CalculateCost` returns `{ Factors = [], Fixed = [] }`, and its own comment says both collections empty is what short-circuits to a zero cost. | C2 is not a config toggle — the size-scaled pricing function has not been written. `?whatif=true` today returns **zero**, not a price, so the CTA has no number to show. |

### Residency — in a repo this list does not read

Not verified here, and it cannot be: `civitai-spine-controller` is not checked out on the site side.
This records Koen's answer (DM, 2026-09-04) rather than source we read.

- The spine controllers check with each other before evicting a resource and **refuse to evict
  anything less than 48h old unless another spine controller has it**.
- `PrepareResourceJob`'s only job is to get the resource into the DC; that eviction policy guards
  its lifetime from then on. Code: `ClusterAwareEvictionPolicy.cs`.
- **`PinModelJob` is legacy — "don't even look at it."**
- ⚠️ Nothing exposes *when* a resource's 48h window ends, so there is still no countdown to build.

### Site-relevant details worth knowing

- **The queue cursor is an integer offset, not a stable cursor.** Ranking is recomputed from live
  provider state on every request, so items shift between pages while the queue mutates. Fine for a
  single first page; do not build a paginated view that assumes stability.
- `take` is clamped to **1..500**, default 100.
- The queue call fans out `GetInfoAsync` + `GetAvailabilityAsync` **per item**. A 500-item page is
  1,000 grain calls. Keep pages small and poll gently.
- `PrepareResourceInput.OnInitializedAsync` **rejects a resource whose `CanGenerate` is false**,
  with a `ValidationException`. That is the orchestrator's own coverage gate and it will refuse
  before we ever charge — worth surfacing as a clean error rather than a 400.
- `PrepareResourceJob` has a **24-hour** `MaxTimeout` and a 2-minute claim duration. Given ~10 KB/s
  observed bandwidth, a large checkpoint can plausibly hit that ceiling.
- `GET /v2/resources` requires the **Consumer** role; `DELETE` requires **Manager**. Our cache-bust
  path already uses a system token for the delete.
- A callback `url` is an arbitrary string, so pointing one at a signals **group**
  (`/groups/model-version:{id}/signals/{message}`) is a site-side choice and needs nothing from the
  orchestrator. That is how bystander subscriptions can work without a C4 endpoint.

### Still worth asking Koen

**Nothing.** Both were answered 2026-09-04 and 2026-09-07 — see
[Residency](#residency--in-a-repo-this-list-does-not-read) above. C2 pricing is the only thing still
with him.

## Not in v1, on the record

- Pay to boost queue position — Justin expects it back if bot armies defeat the rate limits.
- Load state in search results.
- Any hard guarantee on when a model becomes available. Bandwidth into the data centre was ~10
  KB/s at the time of the call; LoRAs took four hours. Promise nothing about *arrival* — a separate
  question from how long it stays once it arrives, which is
  [1.3](paid-model-loading-decisions.md#13--what-we-promise--the-original-48-hours).

---

## Unowned gaps

Real work with no task and no owner. Listed so they are decided rather than discovered.

- [ ] **Refund path** for a load that fails or never completes. Decided: refund
      ([1.2](paid-model-loading-decisions.md#12--a-load-that-never-finishes--refund)). Open is
      *whose* — [K3](paid-model-loading-decisions.md#k3-does-the-orchestrator-refund-a-failed-prepare)
      asks Koen whether the orchestrator already does it.
- [ ] **Residency display.** Residency is real, but no API reports when a resource's 48h window
      ends, so there is nothing to count down from. Needs an orchestrator ask before it is work.
