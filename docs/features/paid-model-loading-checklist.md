# Paid Model Loading — implementation checklist

Companion to [paid-model-loading.md](paid-model-loading.md), which holds the contract and the
decisions, [paid-model-loading-build-plan.md](paid-model-loading-build-plan.md), which is the
inventory of files, procedures, pages and components, and
[paid-model-loading-decisions.md](paid-model-loading-decisions.md), which collects every open
decision with an owner and a closing condition. This file is the state of the work.

ClickUp ids are the C-numbers from the 2026-08-18 lab call. Items with no C-number are gaps found
while reading the contract and the code; they have no ClickUp task and no owner yet.

---

## Phase 0 — decisions, and what each one still gates

Four decisions; one is now settled. The orchestrator questions behind them are answered and
recorded below.

Phase 1 turned out **not** to be gated on these — the plumbing is built and none of it depends on
an answer. What is still gated is the purchase path (the licence gate) and C6 (the "select any
model" question). Every open item here is restated with an owner and a closing condition in
[paid-model-loading-decisions.md](paid-model-loading-decisions.md).

- [ ] **C14 — decide: standalone demo client, mod-only launch, or straight into the platform.**
      Justin owns it. Gates C5–C8. ([868ktt5bz](https://app.clickup.com/t/868ktt5bz))
      *Closes when:* Justin states the choice in the task.
- [ ] 🔴 **What we can honestly sell.** Reopened 2026-09-07: this was settled as "promise nothing"
      on the premise that residency did not exist, and that premise was false —
      [it does](#residency--in-a-repo-this-list-does-not-read), enforced by the spine controllers.
      What is open now is narrower and better: the policy declines to evict inside 48h *unless
      another controller has a copy*, so "we keep it for 48 hours" and "it stays reachable for 48
      hours" are not the same promise. Decision
      [1.3](paid-model-loading-decisions.md#13--what-the-surfaces-may-promise-now-that-residency-exists).
      *Closes when:* the CTA copy is written and someone named signs it off.
- [ ] **Decide "select any model", and decide it as two questions.** `GenerationCoverage` is a
      **view**, not a flag. LoRAs/TI/VAE/LoCon/DoRA are already covered once licensed and scanned —
      they are merely not resident, which is the thing paid loading fixes, and need **no view
      change**. Checkpoints additionally require membership in `CoveredCheckpoint`, which the
      weekly auction job owns and prunes. A **LoRA-first v1 avoids both the view change and the
      auction entanglement** and is the obvious smallest slice.
      *Closes when:* a decision is written into paid-model-loading.md and a task exists if a
      checkpoint path is in scope.
- [ ] 🔴 **Decide what happens to models without a `RentCivit` licence.** The coverage view
      excludes them on purpose; charging to load one sells what the licence forbids. Refuse them at
      the CTA, or get a product decision. No task, no owner, and the failure mode is a refund plus
      a creator complaint.
      *Closes when:* the purchase path either refuses them or a named person signs off that it
      should not.

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

- [ ] **C4 — the endpoint the orchestrator hits when a download starts/progresses.**
      ([868ktt58f](https://app.clickup.com/t/868ktt58f)) Not built, and it may not need to be: the
      load submit points its callback straight at the signals **group** URL for
      `model-version:<id>`, so progress fans out with no hop through us. Build the endpoint only if
      C9 (the completion notification) survives scoping — that is the one thing the direct route
      cannot do.
- [x] **Topic broadcast helper.** `sendSignalToTopic(topic, message, data)` in
      `src/server/orchestrator/orchestrator.utils.ts`, wrapped in `withSignals()`. Unused so far —
      the callback URL covers progress; this is for the server-side sends C9 will need.
- [x] **New `SignalMessages` entry** — `ResourceLoadUpdate = 'resource-load:update'`, on the
      existing `SignalTopic.ModelVersion`. No collision with `SchedulerDownload`.
- [x] **Extract versionId → AIR.** `modelVersionToAir` in `src/server/utils/resource-air.ts`;
      `bustOrchestratorModelCache` and `modelVersionResourceCache` both repointed at it.
      `fileType` comes from the primary file when the caller loaded files, and the two existing
      callers keep the AIRs they had.
- [x] **Server-side resource-state read.** `getResourceLoadState(versionIds)` and
      `getResourceLoadQueue({cursor, take})` in `src/server/services/resource-load.service.ts`,
      exposed as `resourceLoad.getState` / `resourceLoad.getQueue` (both public). The queue read
      goes through a new `queryResourcesClient` wrapper beside `getModelClient`, so the SDK stays
      in `services/orchestrator/models.ts`.
  - [x] fresh, uncached — `modelVersionResourceCache` is not reused
  - [x] a status this build does not know is reported as `unknown`, not folded into one of the four
- [x] **Service tests** — `src/server/services/__tests__/resource-load.service.test.ts`: AIR
      construction, `queuePosition` on `unavailable`, the `unknown` fallback, unresolvable queue
      rows, all three pre-submit refusals, owner-check propagation, priced vs unpriced.
- [ ] **The purchase path.** `resourceLoad.estimate` (whatIf) and `resourceLoad.submit` exist and
      work; what is missing is a price to show and a licence gate.
  - [x] 🔴 `assertWorkflowOwner` on the submit result
  - [x] refuse when `status === 'unsupported'`, and when we could not read the status at all
  - [x] refuse (without charging) when already `available`
  - [x] price from a `whatIf` submit rather than a site-side table — the procedure returns
        `{ cost, priced }`, and `priced` is false while the orchestrator quotes zero, so no surface
        can render "free" as a quote. Still blocked on C2 for a real number.
  - [ ] surface the orchestrator's own `CanGenerate` rejection cleanly — `PrepareResourceInput`
        throws a ValidationException before any charge
  - [ ] 🔴 refuse when the model lacks a `RentCivit` licence (see Phase 0). **Not implemented** —
        the submit path will currently take a load for a model whose creator did not grant it.
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

- [x] **`/moderator/resource-load`** — enter a model version id, get the estimate, then submit;
      below it, the live queue polled every 15s. `requireModerator` plus the `resourceLoad`
      feature flag.
  - [x] the estimate names itself as unpriced while the orchestrator quotes zero
  - ⚠️ moderators are exempt from `rateLimit()`, so this page exercises none of C10

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
  - [ ] depends on the "select any model" decision from Phase 0
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
  - [ ] 🔴 whoever ends up owning `CoveredCheckpoint` must be settled **before** a checkpoint ships
        as paid-loadable: `handle-auctions.ts` deletes every row outside the weekly winner set, so
        it would silently un-cover anything someone paid for.

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

**Both answered, 2026-09-04 and 2026-09-07.** Residency exists and is enforced by the spine
controllers ([above](#residency--in-a-repo-this-list-does-not-read)); `step:preparing` was missing
from the spec by accident — a 2024 change with no comment — and Koen has since added the missing
event types back. `step:*` stays the correct subscription either way. C2 (pricing) is the only
thing still with him.

## Not in v1, on the record

- Pay to boost queue position — Justin expects it back if bot armies defeat the rate limits.
- Load state in search results.
- Any hard guarantee on when a model becomes available. Bandwidth into the data centre was ~10
  KB/s at the time of the call; LoRAs took four hours. Promise nothing about *arrival* — a separate
  question from how long it stays once it arrives, which is
  [1.3](paid-model-loading-decisions.md#13--what-the-surfaces-may-promise-now-that-residency-exists).

---

## Unowned gaps

Real work with no task and no owner. Listed so they are decided rather than discovered.

- [ ] **Refund path** for a load that fails or never completes. Open decision —
      [1.2](paid-model-loading-decisions.md#12-what-happens-when-a-load-fails-or-never-finishes).
- [ ] **Residency display.** Residency is real, but no API reports when a resource's 48h window
      ends, so there is nothing to count down from. Needs an orchestrator ask before it is work.
