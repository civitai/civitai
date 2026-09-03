# Paid Model Loading

**Status:** not started on the site side. Orchestrator side is largely built, but charging is off.
**Source:** lab call 2026-08-18 (Justin, Koen, Briant) + orchestrator SDK `@civitai/client@0.2.0-beta.98`.
**Tracking:** ClickUp C2–C14, `Synced Team`.

---

## What it is

Any model on the site becomes generatable. If the model is not resident in the generation
cluster, the user pays to load it in, and we guarantee it stays resident for **48 hours**.
The orchestrator sets the price, scaled by model size.

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

🔴 **The call recorded this as Koen's one missing piece** ("there is no endpoint for a queue…
that one I missed"). It is present in the SDK we have installed. Confirm with Koen that it is
live in the deployed orchestrator before planning around it — the SDK is generated from the
OpenAPI document and can lead the deployment.

Koen's caveat still stands and is not resolved by the endpoint existing: **there is no single
global queue.** Each provider has its own. A prepared resource is submitted to every provider,
each interested provider queues it, and the reported number is the winning provider at that
moment. With multiple providers, several items legitimately occupy "position 1". Justin's answer
was to flatten the per-provider ranks into one displayed 1..n list and accept that it is a
ranking, not a position. Today there is one provider, so this is latent.

### Preparing a resource

`PrepareResourceInput { resource: air }` returns
`PrepareResourceOutput { resource, preparedAt, provider }`.

Submittable two ways:

- as a **standalone** `prepareResource` workflow step, or
- **implicitly**, by submitting a txt2img step that references a resource that is not resident.

While a download progresses, the orchestrator emits a webhook event **every 10 seconds** carrying
the same `availability` payload.

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
- **AIR construction from a model version already exists twice**, in `bustOrchestratorModelCache`
  and in `modelVersionResourceCache`, and both include `fileType` from the primary file. Extract
  it rather than writing a third copy.
- ⚠️ [`modelVersionResourceCache`](../../src/server/redis/caches.ts) already fetches the whole
  `ResourceInfo` per version — and caches it for **a day**, then throws `availability` away.
  Availability must be read fresh. Do not reach for that cache because it looks like it already
  has what you need.

---

## The signal path

Same shape as image generation: workflow → our endpoint → signals service → client.

⚠️ `SignalMessages.SchedulerDownload = 'scheduler:download'` already exists and is **not** this
feature — it is the generation-history export. Do not reuse or shadow it.

**Sending.** The site has no topic-broadcast helper today. Per-user sends exist
([orchestrator.utils.ts](../../src/server/orchestrator/orchestrator.utils.ts)) and hit
`${SIGNALS_ENDPOINT}/users/{userId}/signals/{message}`. Topic sends hit
`${SIGNALS_ENDPOINT}/groups/{topic}/signals/{message}` — chat does this today
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

**Client persistence.** What the user is waiting on lives in `localStorage`. On load: poll
`GET /v2/resources/{air}` first; if complete, drop it; if not, resubscribe and carry on. That is
the whole reconnect story — the design as discussed has no server-side "my loads" record.

---

## Rate limits

Site-side only, deliberately. Anyone can go straight to the orchestrator; the concern is abuse
*by users on our site*, so that is where the cap belongs.

| Tier | Loads per day |
| --- | --- |
| Free | 0 |
| Bronze | 3 |
| Silver | 5–6 |
| Gold | 10 |

Free started at 1; Koen suggested members-only to start; Justin settled on 0. These are
deliberately low and meant to be raised.

The mechanism is the existing `rateLimit()` tRPC middleware
([middleware.trpc.ts:151](../../src/server/middleware.trpc.ts#L151)). Four properties of it decide
whether the cap actually holds:

1. **A tier ladder composes correctly.** Per period the *highest* matching limit wins, so
   declaring all four tiers with `userReq` predicates and letting a gold user match several of
   them yields 10, not 3.
2. **`limit: 0` short-circuits immediately**, so free = 0 works with no special case.
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

## "Select any model" — what it actually costs

The premise of the feature is that the generator stops being restricted to a curated set. No task
covers that change, and it is the largest single piece of work in the feature.

`GenerationCoverage` is **a database view, not a table** — there is no `covered` boolean to flip.
Read the live definition with
`SELECT pg_get_viewdef('public."GenerationCoverage"'::regclass, true)`. It computes coverage from,
among other things:

- `m."allowCommercialUse" && ARRAY['RentCivit']` — a **licence** gate
- an eligible, scanned `ModelFile` of an accepted type and format
- `mv."baseModel" IN (SELECT "baseModel" FROM "GenerationBaseModel")` — a base-model allowlist
- and then, **for checkpoints only**, `mv.id IN (SELECT version_id FROM "CoveredCheckpoint")`

Three things follow, and they change the shape of the work:

1. 🔴 **The licence gate is a money problem, and nobody raised it.** A model whose creator has not
   granted `RentCivit` is deliberately not generatable on-site. Taking payment to load such a model
   into the cluster sells something the licence forbids. Whatever replaces the coverage gate has to
   keep this one, or the feature has to refuse those models explicitly.
2. **LoRAs and checkpoints are not the same job.** LoRA, TextualInversion, VAE, LoCon, DoRA and
   Upscaler need no `CoveredCheckpoint` membership at all — they are already covered once they pass
   the licence, scan and base-model gates. They are simply not *resident*, which is exactly the
   problem paid loading solves. **Checkpoints** are the ones gated behind the curated list. A LoRA-
   first v1 needs no view change; a checkpoint v1 needs one.
3. **`GenerationBaseModel` and `getCanAuctionForGeneration()` already encode which ecosystems can
   reach the generator.** That is the site-side twin of the orchestrator's `unsupported` status.
   Whichever one disagrees with the other is a bug users will find by paying for it.

## Auctions

Paid loading replaces auctions *as a way into the cluster*. It does not replace what auctions
also do.

🔴 **The two are mechanically incompatible, not just conceptually.** `CoveredCheckpoint` is
populated by [handle-auctions.ts](../../src/server/jobs/handle-auctions.ts) — auction winners plus
the top weekly earners — and the same job **deletes every row not in that set** on each cycle. A
checkpoint someone paid to load would therefore lose its coverage at the next auction run. Paid
loading cannot ship for checkpoints while that job still owns the table.

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

These came out of reading the contract and the code, not out of the call. None has an owner.

1. **"Select any model" is not in any task**, and C6 assumes it is already done. See the coverage
   section above for what it involves — including the licence gate, which is the part with a
   refund attached.
2. **What happens when a paid load fails or never finishes?** Bandwidth was measured at ~10 KB/s
   with LoRAs taking four hours, which Koen read as an unstable tunnel into the data centre.
   Koen: "we got to be prepared for us not giving any hard guarantees about when it's going to be
   available." A refund path is implied and unscoped.
3. **Concurrent purchases of the same resource.** Two users pay to load the same model at the same
   time. Does the second pay? Is one refunded? Does the 48 hours reset?
4. **The 48-hour guarantee has no representation on the site.** Nothing in C4–C11 shows when a
   residency expires, and the value proposition is a countdown nobody has designed.
5. **Cluster capacity is unknown.** Briant's concern in the call: someone queues a pile of small
   irrelevant checkpoints and starves the popular ones. The answers on record are that popular
   models stay resident because workers keep them, plus the rate limits, plus Koen's
   already-shipped eviction metric (tried to evict, couldn't, last copy). That metric is the only
   instrument we have, and nothing yet watches it.
6. **Search does not show load state**, deliberately deferred. Justin: "maybe we won't, for
   initially."
7. **Queue-position boosting** is out for v1, and Justin expects it back if bot armies defeat the
   rate limits.

---

## Decided, do not relitigate

- Rate limits are site-side, not orchestrator-side.
- Pay-to-boost queue position is out for v1.
- Load state in search is deferred.
- Client keeps in-flight loads in `localStorage`, polls the resource endpoint on refresh, and
  resubscribes if still downloading.
- Progress shows in three places: navbar, model version page (below Create), and the generator for
  the selected resource.
- A bystander on the model page can subscribe to someone else's in-flight load and get the
  notification.
- Free tier gets 0 per day at launch.

---

## Blocking dependencies

**C2 — pricing, and enabling charging — blocks all public exposure.** Loading a resource is
currently free at the orchestrator. Shipping the site surfaces before C2 gives away cluster
residency. Koen owns it; nothing on the site side should reach production first.

**C14 — the demo-client decision — gates C5 through C8.** Briant's position is that a change this
large to how generation works should be demonstrated to power users before it is sprinkled through
the platform. Justin's counter is a small standalone first-party app driving Koen's API end to
end, or a mod-only launch. Unresolved; Justin owns the decision.
