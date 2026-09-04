# Paid Model Loading — implementation checklist

Companion to [paid-model-loading.md](paid-model-loading.md), which holds the contract and the
decisions. This file is the order of work and the state of it.

ClickUp ids are the C-numbers from the 2026-08-18 lab call. Items with no C-number are gaps found
while reading the contract and the code; they have no ClickUp task and no owner yet.

---

## Phase 0 — resolve before writing site code

Nothing in Phase 1 onward is safe to start until these land. Two are decisions, one is a fact
check.

- [ ] **C14 — decide: standalone demo client, mod-only launch, or straight into the platform.**
      Justin owns it. Gates C5–C8. ([868ktt5bz](https://app.clickup.com/t/868ktt5bz))
      *Closes when:* Justin states the choice in the task.
- [ ] **Verify the orchestrator surface with Koen — all of it, in one pass.** See
      [the verification list](#orchestrator-verification-list) below. Everything there is typed in
      `@civitai/client@0.2.0-beta.98`; none of it is confirmed as deployed and behaving. Two of the
      questions (progress events, and whether prepare is a recipe or a workflow) change the design
      of C4/C7/C8, not just their schedule.
      *Closes when:* Koen has answered every row.
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

- [ ] **C2 — pricing by model size, and enable charging.** Koen. Loading is free today; no site
      surface may reach production before this.
      ([868ktt57p](https://app.clickup.com/t/868ktt57p))

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
  - [ ] price the CTA from a `whatIf` submit, not a site-side size→price table
  - [ ] refuse when `status === 'unsupported'`
  - [ ] refuse (without charging) when already `available`
  - [ ] refuse when the model lacks a `RentCivit` licence (see Phase 0)
  - [ ] decide the concurrent-purchase behaviour — two users, same model, same moment
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
  - [ ] flatten per-provider ranks into one 1..n list; it is a ranking, not a position
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

## Orchestrator verification list

Everything below is **typed in `@civitai/client@0.2.0-beta.98`**. That is evidence the contract was
designed, not that it is deployed, charging, or behaving. Rows 1 and 2 are design questions — the
answers change what C4, C7 and C8 are, not merely when they can start.

| # | Endpoint / behaviour | What we need confirmed |
| --- | --- | --- |
| 1 | **Progress events.** `WorkflowCallback.type` is a list of lifecycle transitions only — `workflow:*`, `step:*`, `job:*`. There is **no progress event type.** | The call promised "every 10 seconds, if there's progress, you will get a new event on the webhook." Which event carries `progress` / `etaSeconds`? If none, live progress has to be polled from `GET /v2/resources/{air}`, and the navbar and queue page become pollers. |
| 2 | **Is prepare a recipe or a workflow step?** The SDK exposes `POST /v2/consumer/recipes/prepareResource` (`invokePrepareResourceStepTemplate`). There is **no `PrepareResourceStepTemplate`** in the step union — `WorkflowStepTemplate.$type` is an open `string`. | The call's whole signal design assumes a workflow ("you submit a workflow to load the thing… then you get signals or webhooks for that workflow"). A recipe invoke has no workflow id — so nothing to attach callbacks to, nothing to poll, and nothing for `assertWorkflowOwner` to check. Can we submit `$type: 'prepareResource'` inside `POST /v2/consumer/workflows`? |
| 3 | `GET /v2/resources/{air}` → `ResourceInfo.availability` | Deployed and populating `availability` for arbitrary AIRs, including ones never requested before. Confirm all four statuses are reachable: `available`, `loading`, `unavailable`, `unsupported`. |
| 4 | `GET /v2/resources?view=queue` (`queryResources`, cursor + take) | Live? The 2026-08-18 call recorded this as the one piece not built; it is in the SDK now. Also: is `cursor` stable while the queue mutates? |
| 5 | `POST /v2/consumer/recipes/prepareResource` with `?whatif=true` | Returns a **price** without side effects, and prices by model size. This is where the CTA's number comes from. |
| 6 | The same call **without** `whatif` | Charges the bearer. This is C2 and it is currently off — confirm what "on" looks like and how we will know it flipped. |
| 7 | `?ephemeral=true` on the prepare recipe | Undocumented to us. Does it relate to the 48-hour residency, and should we be setting it either way? |
| 8 | **48-hour residency** | Is it enforced orchestrator-side on a successful prepare, and is the expiry readable anywhere? Nothing in `ResourceInfo` obviously carries it, and we cannot show users a countdown we cannot read. |
| 9 | **Callback targets.** Generation points `WorkflowCallback.url` straight at `${SIGNALS_ENDPOINT}/users/{id}/signals/{message}` — the orchestrator posts to signals directly, with no site endpoint in between. | Can a callback instead target a signals **group** URL (`/groups/model-version:{id}/signals/{message}`)? If yes, bystander subscribers work with no site endpoint. If no, C4 must exist as a real endpoint that fans out. |
| 10 | **Failure semantics** | What does a prepare that never completes look like — `workflow:expired`, `step:failed`, or silence? Is the charge reversed orchestrator-side, or do we owe a refund? Directly relevant given ~10 KB/s download bandwidth. |
| 11 | **Concurrent prepares of the same AIR** | Two users prepare the same resource simultaneously. Two charges or one? Does the second join the first, and does the 48 hours reset? |
| 12 | **Rate limiting posture** | Confirmed decision is site-side only, so the orchestrator will accept unlimited prepares from a user token. Confirm that is still true and intended — it is what makes our cap bypassable by going direct. |
| 13 | `DELETE /v2/resources/{air}` | Already used by `bustOrchestratorModelCache`. Does it evict a **paid, resident** resource, and if so should it be blocked during the 48 hours? |

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
- [ ] **Concurrent purchase** of the same resource by two users.
