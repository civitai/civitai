# Paid Model Loading

**Status:** Phase A (server plumbing plus a mod-only test page) is built behind the `resourceLoad`
flag; no public surface exists. The orchestrator can download and report; it cannot yet charge or
guarantee residency. State of the work: [checklist](paid-model-loading-checklist.md).
**Source:** lab call 2026-08-18 (Justin, Koen, Briant), the `@civitai/client` SDK, the
`civitai-orchestration` source at `9306e7333` — **which is deployed**, so everything described as
built below is live — and Koen's answers in DM, 2026-09-04 and 2026-09-07.

🔴 **`civitai-orchestration` is not the whole system.** Resource *residency* lives in a second
repo, `civitai-spine-controller`. Reading only the orchestrator produced a confident, wrong
conclusion here once already (see What it is), so "verified against source" in this document means
verified against the orchestrator unless it says otherwise.
**Tracking:** ClickUp C2–C14, `Synced Team`.
**Coverage model and audit:** [paid-model-loading-coverage.md](paid-model-loading-coverage.md).

---

## What it is

Any model on the site becomes generatable. If the model is not resident in the generation
cluster, the user pays to load it in, and — as pitched — we guarantee it stays resident for
**48 hours**. The orchestrator sets the price, scaled by model size.

**Residency exists.** Koen, 2026-09-04: the spine controllers check with each other before evicting
a resource and refuse to evict anything less than 48h old **unless another spine controller has it**.
`PrepareResourceJob` gets the resource into the DC and that eviction policy guards its lifetime
from then on — the code is `ClusterAwareEvictionPolicy.cs` in `civitai-spine-controller`.
`PinModelJob`, which an earlier reading of this document called the intended primitive, is
**legacy — Koen: "don't even look at it."**

The "unless another controller has it" clause is benign: Justin, 2026-09-08 — it means the model is
still downloaded on our servers and available for generation. The copy may move; availability does
not lapse. **So the surfaces promise the 48 hours as originally pitched.**

⚠️ Nobody on the site side has read that policy — the repo is private to us here — and nothing
exposes when a given resource's window ends.

🔴 **The price half is still missing.** The cost function returns a hardcoded zero, so there is no
size-scaled price to show. See [Orchestrator state](paid-model-loading-checklist.md#orchestrator-state--verified-against-source).

This replaces auctions as the mechanism for getting a checkpoint into the generator.

Three surfaces show the same state machine: the model version page, the generator, and a navbar
indicator that links to a full queue page.

---

## The orchestrator contract

Everything the site needs is already typed in `@civitai/client`. Read
`node_modules/@civitai/client/dist/generated/types.gen.d.ts` rather than trusting this section
once it ages.

### Resource state — `ResourceInfo.availability`

`GET /v2/resources/{air}` returns `ResourceInfo`, whose `availability` is a union discriminated
on `status`. **There are four states, not the three discussed in the call:**

| `status` | Extra fields | Meaning | Site behaviour |
| --- | --- | --- | --- |
| `available` | `workers` | resident on N workers | generate normally |
| `loading` | `progress`, `workers`, `startedAt`, `lastProgressAt`, `etaSeconds` | actively downloading | show progress, subscribe |
| `unavailable` | `queuePosition` | not resident | queued if `queuePosition != null`, otherwise offer the paid load |
| `unsupported` | — | the cluster cannot host this resource at all | **never offer a paid load** |

Two consequences the call's model of this misses:

- **`queuePosition` lives on `unavailable`, not on `loading`.** "In the queue" and "not loaded at
  all" are the same status, distinguished only by whether `queuePosition` is null. UI that
  branches on status alone will conflate them.
- **`unsupported` is a fourth state.** Selling a load for a resource the cluster can never host is
  a refund path we would be building on purpose. Gate the purchase CTA on it explicitly.

### Queue listing — `GET /v2/resources?view=queue`

`queryResources({ query: { view: 'queue', cursor?, take? } })` returns a cursor-paged
`ResourceInfo[]`.

The call recorded this as Koen's one missing piece ("there is no endpoint for a queue… that one I
missed"). **It has since been built** — verified in `ResourcesController.QueryAsync`.

Two properties that shape the queue page: the **cursor is an integer offset** over a list that is
re-ranked from live provider state on every request, so paging is not stable; and each item costs a
`GetInfoAsync` plus a `GetAvailabilityAsync` grain call, so a 500-item page is a thousand calls.
Keep `take` small (it is clamped to 1..500, default 100).

Koen's caveat about there being **no single global queue** — each provider has its own, and several
items can legitimately occupy "position 1" — is real, but the endpoint already resolves it: it
merges every enabled provider, de-dupes by AIR and ranks the result. Justin's "make it look like
1, 2, 3, 4" is done server-side. Do not rebuild it client-side. A single unreachable provider
degrades to an empty contribution rather than failing the call.

### Preparing a resource

`PrepareResourceInput { resource: air }` returns
`PrepareResourceOutput { resource, preparedAt, provider }`.

Submittable two ways:

- as a **standalone** `prepareResource` workflow step, or
- **implicitly**, by submitting a txt2img step that references a resource that is not resident.

While a download progresses, the step publishes a `WorkflowStepEvent` with `status: preparing` and
a `preparation { resource, queuePosition, progress, etaSeconds }` payload — refreshed every **10
seconds**, deduplicated so it only publishes when progress moves by 1%.

**Subscribe with `step:*`** — the callback filter is "no event type means all", so `step:*` matches
`preparing` too, and `getOrchestratorCallbacks` already uses it for generation. ⚠️ The generated
SDK's `WorkflowCallback.type` union does **not** list `preparing` or `scheduled`: the orchestrator's
Swagger filter strips both from the advertised enum, so the type looks like the feature is missing
when it is only unadvertised.

⚠️ The implicit path matters for rate limiting — see below.

### Who charges, and where the price comes from

The site does not price this. It submits a workflow with the **user's** orchestrator token, and
the orchestrator derives from that bearer who owns the workflow, whose queue it joins and whose
Buzz pays — the same path generation uses. C2 is enabling exactly that for `prepareResource`.

So the price shown on the CTA should come from a **`whatIf` submit** (`query: { whatif: true }`,
side-effect-free) of the prepare step, not from a size-to-price table on our side. Reuse
[workflows.ts](../../src/server/services/orchestrator/workflows.ts); it already carries the
retry, per-attempt timeout and 503-degrades-to-default-estimate behaviour that a user-facing price
needs.

🔴 **A user-token submit must call `assertWorkflowOwner`.** This is enforced by the
`no-unguarded-billable-submit` guard, whose own docstring names the failure mode this feature
is: "a new paid feature growing its own `submitWorkflow` call, which no reviewer of THAT diff has
any reason to connect to an incident in a different subsystem." The incident it refers to billed
roughly a thousand generations to accounts that did not make them.

### Reuse, not rebuild

- `GET /v2/resources/{air}` already has a caller —
  [`getModelClient`](../../src/server/services/orchestrator/models.ts).
- **AIR construction from a model version** is `modelVersionToAir`
  ([resource-air.ts](../../src/server/utils/resource-air.ts)), extracted this phase from the copies
  in `bustOrchestratorModelCache` and `modelVersionResourceCache`, both now repointed at it. It
  includes `fileType` from the primary file **only when the caller loaded files** — a caller that
  resolves files and one that does not are asking about two different AIRs.
- ⚠️ [`modelVersionResourceCache`](../../src/server/redis/caches.ts) already fetches the whole
  `ResourceInfo` per version — and caches it for **a day**, then throws `availability` away.
  Availability must be read fresh. Do not reach for that cache because it looks like it already
  has what you need.

---

## The signal path

Same shape as image generation: workflow → our endpoint → signals service → client.

⚠️ `SignalMessages.SchedulerDownload = 'scheduler:download'` already exists and is **not** this
feature — it is the generation-history export. Do not reuse or shadow it.

**Sending.** Per-user sends and the topic broadcast both live in
[orchestrator.utils.ts](../../src/server/orchestrator/orchestrator.utils.ts): per-user hits
`${SIGNALS_ENDPOINT}/users/{userId}/signals/{message}`, and `sendSignalToTopic` hits
`${SIGNALS_ENDPOINT}/groups/{topic}/signals/{message}` — the same shape chat uses
([chat.service.ts](../../src/server/services/chat.service.ts)). Route all of it through
[`withSignals()`](../../src/server/signals/wrapper.ts); an unwrapped fetch to the signals service
is the exact shape behind the 2026-05-30 event-loop cascade.

**Topic naming.** The convention the call depends on already exists:

```ts
SignalTopic.ModelVersion = 'model-version'; // src/server/common/enums.ts
```

and [model-version.utils.ts:152](../../src/components/Model/ModelVersions/model-version.utils.ts#L152)
already subscribes to `model-version:<id>`. So the site can subscribe to a download by model
version id with **no new workflow step**, which is exactly what Justin argued for and Koen
agreed to. A new `SignalMessages` entry is all that is needed on top.

**Subscribing.** `useSignalTopic(topic)` in
[SignalsProvider.tsx:112](../../src/components/Signals/SignalsProvider.tsx#L112) refcounts
subscribers per topic and joins/leaves the group automatically.
`useSignalConnection(message, cb)` receives.

**Client persistence.** What a browser is *watching* lives in `localStorage`, drained on every page
load (see Decided). That is not the record of a purchase: the orchestrator holds that, as workflows
tagged `resource-load` queryable with the buyer's token.

⚠️ **Progress for this feature is NOT a topic broadcast.** It goes to `/users/{userId}/signals/`,
because the orchestrator posts its event body straight through and that body names the paying user.
The topic convention below is still how the site subscribes to a model version generally — it is
just not how load progress is delivered.

---

## Rate limits

Site-side only, deliberately. Anyone can go straight to the orchestrator; the concern is abuse
*by users on our site*, so that is where the cap belongs.

| Tier | Loads per day |
| --- | --- |
| Free | 0 — refused by `assertCanRequestLoad` before the limiter is reached |
| Bronze | 3 |
| Silver | 6 |
| Gold / Founder | 10 |

On top of the daily ladder there is a flat, tier-independent **3 per hour** — burst protection for
the cluster, not an entitlement, so no plan buys its way out of it.

Free started at 1; Koen suggested members-only to start; Justin settled on 0. Silver was left at
5–6 on the call and shipped as 6. These are deliberately low and meant to be raised.

The mechanism is the existing `rateLimit()` tRPC middleware
([middleware.trpc.ts:151](../../src/server/middleware.trpc.ts#L151)). Four properties of it decide
whether the cap actually holds:

1. **A tier ladder composes correctly.** Per period the *highest* matching limit wins, so
   declaring all four tiers with `userReq` predicates and letting a gold user match several of
   them yields 10, not 3.
2. **`limit: 0` is not the member gate.** It short-circuits cleanly, but the middleware returns
   early for moderators and in dev/test/preview, so on a preview build nothing else would stand
   between a free account and a free load. `assertCanRequestLoad()` in the router is the gate.
3. **It is off by one.** The check is `relevantAttempts > limit`, so a limit of 3 permits 4.
   Either accept it and write the numbers down as "3 means 4", or fix the comparison — but that
   comparison is shared with every other limiter in the app, so fixing it changes them all.
4. **Moderators skip it entirely**, as do dev/test/preview. A mod-only launch therefore ships
   with no cap at all, and tells us nothing about whether the cap works.
5. **It fails open.** If the Redis write degrades, the attempt is allowed through and under-counted
   (`rate-limit-write-degraded`). Acceptable for a cap; worth knowing it is not a hard ceiling.
6. **Use `onlyCountSuccess: true`.** A purchase that is refused — unsupported resource, already
   resident, insufficient Buzz — should not burn one of a gold member's ten daily loads.

🔴 **The middleware only guards tRPC procedures.** If a load can be triggered implicitly by
submitting a generation with a non-resident resource, the cap must also be applied on the
generation submit path, or it is decorative — a user simply generates instead of pressing the
button.

---

## "Select any model" — the coverage change

The premise of the feature is that the generator stops being restricted to a curated set. As of
2026-09-08 this is scoped and decided; the full model, the audit and every measured number live in
[paid-model-loading-coverage.md](paid-model-loading-coverage.md). In short:

- **`CoveredCheckpoint` goes away.** It is the auction's residency proxy, it has four uses and all
  four are generation, and dropping it widens covered checkpoints by roughly two orders of magnitude
  ([the numbers](paid-model-loading-coverage.md#what-changes-in-numbers)).
- **`EcosystemCheckpoints` stays.** It is the generator's default model per ecosystem — 62 of the 63
  checkpoint defaults are covered through it and none through `CoveredCheckpoint`. Removing it would
  strip the default model from half the supported ecosystems.
- **`GenerationBaseModel` stays as the gate.** It marks the base models where the orchestrator has
  extended checkpoint/diffuser support, i.e. where community models can run.
- **Diffusers becomes loadable**; Core ML and ONNX stay excluded.
- **File-less models never touch the loader**, and "file-less" means *no loadable file*, not *no file
  row* — 36 API models carry a `Training Data` archive and would otherwise read as loadable.

The licence gate survives all of this: **zero covered versions lack `RentCivit`**, and the purchase
path refuses anything not in coverage, which inherits the rule rather than restating it.

**Loading is for checkpoints.** Size is the reason the loader exists and LoRAs do not have it
(Justin, 2026-09-08). Earlier drafts of these docs recommended a LoRA-first v1 on the grounds that it
needed no view change; that was solving the wrong problem and has been removed.

## Auctions

Paid loading replaces auctions *as a way into the cluster*. It does not replace what auctions
also do.

🔴 **The two were mechanically incompatible.** `CoveredCheckpoint` is populated by
[handle-auctions.ts](../../src/server/jobs/handle-auctions.ts) — auction winners plus the top weekly
earners — and the same job **deletes every row not in that set** on each cycle, so a checkpoint
someone paid to load would lose its coverage at the next auction run.

**Resolved 2026-09-08:** the table stops gating generation entirely, so the conflict goes with it.
Whether `handle-auctions.ts` keeps writing rows nothing reads is a cleanup question, not a blocker.

Auctions have carried double duty since inception: choosing the week's checkpoints **and**
promoting content into Featured spaces. That conflation is already a known problem with its own
task (ClickUp 868gtq1kt) — people bid on ecosystems that will never be generatable, win the
featured slot, and ask for refunds.

So "retire auctions" (C11) is not one change. It is:

- remove the cluster-residency half, which paid loading replaces, and
- rehome the featuring/promotion half, which it does not.

Scale: ~89 files under `src/` reference auctions, including the generator's resource-select
modal, model version details, the app header, and a product tour. C11 should not be scoped before
868gtq1kt has an answer.

---

## Open questions

These came out of reading the contract and the code, not out of the call. Each is restated with an
owner and a closing condition in
[paid-model-loading-decisions.md](paid-model-loading-decisions.md) — the register to read before
deciding anything.

1. ✅ **"Select any model"** — decided 2026-09-08, and scoped as Phase 1.6 in the checklist. See
   [coverage](paid-model-loading-coverage.md).
2. **A failed load is refunded** (Justin, 2026-09-08) — but *by whom* is unconfirmed. Justin expects
   the orchestrator to be doing it; nothing has ever exercised that path, because a prepare has
   never been charged. It is [K3](paid-model-loading-decisions.md#k3-does-the-orchestrator-refund-a-failed-prepare)
   and it has to be answered with pricing, not after. Bandwidth was measured at ~10 KB/s with LoRAs
   taking four hours, and `PrepareResourceJob` gives up at 24h, so this is not a rare path.
3. **Nothing exposes when a resource's 48h window ends.** The spine controllers enforce residency,
   but no API reports an expiry, so there is no countdown to design even though we now promise the
   duration.
4. **Cluster capacity is unknown.** Briant's concern in the call: someone queues a pile of small
   irrelevant checkpoints and starves the popular ones. The answers on record are that popular
   models stay resident because workers keep them, plus the rate limits, plus Koen's
   already-shipped eviction metric (tried to evict, couldn't, last copy). That metric is the only
   instrument we have, and nothing yet watches it.
5. **Search does not show load state**, deliberately deferred. Justin: "maybe we won't, for
   initially."
6. **Queue-position boosting** is out for v1, and Justin expects it back if bot armies defeat the
   rate limits.

---

## Decided, do not relitigate

- Rate limits are site-side, not orchestrator-side.
- Pay-to-boost queue position is out for v1.
- Load state in search is deferred.
- A browser keeps what it is **watching** in `localStorage` and drains that queue on every page
  load — finished loads raise a toast that must be dismissed, then leave; items that can no longer
  finish leave; the rest stay subscribed. Items expire at 48h so every one has an exit.
- The durable record of a **purchased** load is the orchestrator's, not ours: workflows tagged
  `resource-load`, queried with the buyer's token. Not `localStorage`, not Redis.
- Progress signals go to the **buyer's own channel**, never to a model-version group — the payload
  carries `workflowId`, which names the paying user.
- Bystanders do not get live progress. They get told when the load is ready, on their next visit.
- Reaching someone who does not come back — real API-level notifications — is a **Phase 2** goal.
  A different device or a cleared browser getting nothing is accepted.
- Progress shows in three places: navbar, model version page (below Create), and the generator for
  the selected resource.
- A bystander on the model page can subscribe to someone else's in-flight load and be told when it
  is ready. Load state and the queue are **public reads** — everyone sees them, not only the buyer.
- `PinModelJob` is legacy and is not part of this feature (Koen, 2026-09-04).
- The surfaces promise the **48 hours as pitched**. A copy may move between spine controllers inside
  the window; availability does not lapse (Justin, 2026-09-08).
- **Loading is for checkpoints.** LoRAs are not large enough to need it.
- **`CoveredCheckpoint` stops gating generation**; `EcosystemCheckpoints` and `GenerationBaseModel`
  stay. Coverage means *allowed to generate*; residency is the orchestrator's axis.
- **Only base models in `GenerationBaseModel` are loadable.** Everything else is out of scope for v1.
- A checkpoint needs a **correct model file** to be loadable; file-less API models never are.
- A load that never finishes is **refunded**.
- The purchase path refuses anything **not in `GenerationCoverageNext`** (composed with ecosystem
  type support by `isGenerationEligible`), which is how the `RentCivit` rule is enforced without
  restating it. Gating on the live view would refuse every load worth making, since it still requires
  `CoveredCheckpoint`.
- The daily cap must also cover the implicit path — a generation submitted against a non-resident
  resource — or it is decorative. Same quota, not a second one.
- Free tier gets 0 per day at launch.
- Rate limits stay site-side only; the orchestrator accepts unlimited prepares from a user token.
- Concurrent prepares of the same resource are not a concern and need no special handling.

---

## Blocking dependencies

**C2 — pricing, and enabling charging — blocks all public exposure.** Loading a resource is
currently free at the orchestrator. Shipping the site surfaces before C2 gives away cluster
residency. Koen owns it; nothing on the site side should reach production first.

**C14 — the demo-client decision — gates C5 through C8.** Briant's position is that a change this
large to how generation works should be demonstrated to power users before it is sprinkled through
the platform. Justin's counter is a small standalone first-party app driving Koen's API end to
end, or a mod-only launch. Unresolved; Justin owns the decision.
