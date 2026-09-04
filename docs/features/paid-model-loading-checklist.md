# Paid Model Loading — implementation checklist

Companion to [paid-model-loading.md](paid-model-loading.md), which holds the contract and the
decisions. This file is the order of work and the state of it.

ClickUp ids are the C-numbers from the 2026-08-18 lab call. Items with no C-number are gaps found
while reading the contract and the code; they have no ClickUp task and no owner yet.

---

## Phase 0 — resolve before writing site code

Nothing in Phase 1 onward is safe to start until these land. All four are decisions — the
orchestrator questions are answered and recorded below.

- [ ] **C14 — decide: standalone demo client, mod-only launch, or straight into the platform.**
      Justin owns it. Gates C5–C8. ([868ktt5bz](https://app.clickup.com/t/868ktt5bz))
      *Closes when:* Justin states the choice in the task.
- [ ] 🔴 **Decide what we can honestly sell, given the 48-hour guarantee is not implemented.**
      Verified against deployed orchestrator source: nothing pins a prepared resource, so a paid
      load buys a download and then ordinary eviction. Either Koen builds retention (`PinModelJob`
      looks like the intended primitive, but nothing creates one), or the surfaces stop saying
      "48 hours". See [Orchestrator state](#orchestrator-state--verified-against-source).
      *Closes when:* residency exists, or the copy is rewritten to promise only a load.
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
      ([868ktt58f](https://app.clickup.com/t/868ktt58f))
  - [ ] `src/pages/api/webhooks/model-loading.ts` (or similar), guarded with `WebhookEndpoint`
  - [ ] zod schema over the `availability` payload — model **all four** statuses, and treat
        `queuePosition` as living on `unavailable`
  - [ ] map AIR → model version id (`parseAIR`) so the topic can be named
- [ ] **Topic broadcast helper.** The site can only send per-user signals today. Add a
      `sendSignalToTopic`-shaped helper beside the per-user ones in
      `src/server/orchestrator/orchestrator.utils.ts`, wrapped in `withSignals()`.
- [ ] **New `SignalMessages` entry**, e.g. `model-version:load-progress`. Reuse the existing
      `SignalTopic.ModelVersion` — no new topic constant needed. Do not collide with
      `SchedulerDownload = 'scheduler:download'`, which is the generation-history export.
- [ ] **Extract versionId → AIR.** It exists twice already (`bustOrchestratorModelCache`,
      `modelVersionResourceCache`), both including `fileType` from the primary file. Extract before
      adding a third caller.
- [ ] **Server-side resource-state read.** Wrap `getModelClient` (already calls
      `GET /v2/resources/{air}`) for a single AIR, and add `queryResources({ view: 'queue' })` for
      the queue. Expose via tRPC; all three surfaces read through it.
  - [ ] ⚠️ do **not** reuse `modelVersionResourceCache` — it holds the same `ResourceInfo` on a
        **day-long** TTL and discards `availability`. This read must be fresh.
- [ ] **The purchase path.** A tRPC procedure that submits the standalone `prepareResource` step
      with the **user's** token and returns the queued state. The orchestrator prices and charges;
      the site does not.
  - [ ] 🔴 call `assertWorkflowOwner` on the result — the `no-unguarded-billable-submit` guard
        fails otherwise, and this feature is literally the case its docstring describes
  - [ ] price the CTA from a `whatIf` submit, not a site-side size→price table — blocked on C2,
        since `whatif` returns zero today
  - [ ] refuse when `status === 'unsupported'`
  - [ ] surface the orchestrator's own `CanGenerate` rejection cleanly — `PrepareResourceInput`
        throws a ValidationException before any charge
  - [ ] refuse (without charging) when already `available`
  - [ ] refuse when the model lacks a `RentCivit` licence (see Phase 0)
- [ ] **C10 — per-tier daily rate limits.** ([868ktt5aq](https://app.clickup.com/t/868ktt5aq))
  - [ ] four `rateLimit()` entries with `userReq` tier predicates, `period` = 1 day
  - [ ] apply the **same `sharedKey`** on the generation submit path, or the implicit
        prepare-via-txt2img route bypasses the cap entirely
  - [ ] `onlyCountSuccess: true`, so a refused purchase does not burn a slot
  - [ ] write down that the middleware is off by one (a limit of 3 permits 4) so the configured
        numbers mean what we intend
  - [ ] note that moderators are exempt — a mod-only launch exercises none of this

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
  - [ ] reads `queryResources({ view: 'queue' })`, polled
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

### Not built — and one of them is the product

| Gap | Consequence |
| --- | --- |
| 🔴 **The 48-hour residency guarantee does not exist.** `PrepareResourceJob` downloads the model and ends; the copy is then subject to ordinary worker eviction like any other. The one primitive that looks intended for it — **`PinModelJob`** — is defined and has a `PushWorkerHandler` handler, but **nothing in the repo creates one**, and `PrepareResourceHandler` does not issue it. | This is the thing being sold. Without it, a paid load buys a download and no residency at all. **Nothing on the site should promise 48 hours until this exists.** |
| 🔴 **Cost is hardcoded to zero.** `PrepareResourceHandler.CalculateCost` returns `{ Factors = [], Fixed = [] }`, and its own comment says both collections empty is what short-circuits to a zero cost. | C2 is not a config toggle — the size-scaled pricing function has not been written. `?whatif=true` today returns **zero**, not a price, so the CTA has no number to show. |

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

Deployment, concurrent prepares and the site-side rate-limit posture are all settled and no longer
need asking. C2 (pricing) is the other open item and lives in Phase 0.

- [ ] Is the 48-hour residency planned, and where? **`PinModelJob` looks like the intended
      primitive** — it is defined and `[Preview]`, and `PushWorkerHandler` has a handler for it,
      but nothing in the repo creates one and `PrepareResourceHandler` does not issue it. This
      decides whether C5–C8 can say "48 hours" at all.
- [ ] Is `step:preparing` unadvertised on purpose? `step:*` works, but if consumers are meant to
      subscribe narrowly we should know.

## Not in v1, on the record

- Pay to boost queue position — Justin expects it back if bot armies defeat the rate limits.
- Load state in search results.
- Any hard guarantee on when a model becomes available. Bandwidth into the data centre was ~10
  KB/s at the time of the call; LoRAs took four hours. Design every surface to promise nothing.

---

## Unowned gaps

Real work with no task and no owner. Listed so they are decided rather than discovered.

- [ ] **Refund path** for a load that fails or never completes.
- [ ] **48-hour residency display** — nothing shows the user when what they bought expires.
