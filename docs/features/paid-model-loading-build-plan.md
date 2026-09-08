# Paid Model Loading — build plan

The inventory of what we actually create: files, procedures, pages, components, and the order to
build them in.

Companion to:

- [paid-model-loading.md](paid-model-loading.md) — the contract and the decisions
- [paid-model-loading-checklist.md](paid-model-loading-checklist.md) — the state of the work and the
  verified orchestrator state
- [paid-model-loading-decisions.md](paid-model-loading-decisions.md) — every open decision, with an
  owner and a closing condition

Names below were proposals when this was written. §1, §2, §6 and §3's callback builders are now
built and the names here are the ones in the code; §3's webhook, §4 and §5 are still proposals. The
[checklist](paid-model-loading-checklist.md) holds the per-item state.

---

## Naming

One noun for the whole feature, used in every identifier: **`resourceLoad`** (server, tRPC) and
**`resource-load`** (files, routes, signals, redis keys).

Not "model loading" — the thing being loaded is a *resource* (a model version), and `model` is
already the most overloaded word in the codebase. Not "prepare" — that is the orchestrator's word
for the mechanism, and ours should name the product.

---

## 1. Server — the load service

### `src/server/services/resource-load.service.ts` — new

The only module that talks to the orchestrator about residency. Everything else goes through it.

| Function | Does |
| --- | --- |
| `getResourceLoadState(versionIds)` | versionId → `availability`, batched. Fresh, uncached. |
| `getResourceLoadQueue({ cursor, take })` | `queryResourcesClient({ view: 'queue' })` — the SDK call stays in `services/orchestrator/models.ts` — mapped back to model versions. |
| `submitResourceLoad({ modelVersionId, userId, token, currencies })` | The paid submit. Owner-checked. |
| `estimateResourceLoad({ modelVersionId, token, currencies })` | `whatIf` price for the CTA. Returns `{ cost, priced }`. |

Notes that decide the implementation:

- 🔴 `submitResourceLoad` **must call `assertWorkflowOwner`** on the result. It is a user-token
  billable submit, which is exactly what `no-unguarded-billable-submit` guards.
- The queue returns AIRs; the site thinks in version ids. Map back via `parseAIRSafe` — **not**
  `parseAIR`, which throws — and **drop anything that does not resolve** rather than rendering a
  half-known row.
- Do not reuse `modelVersionResourceCache` — day-long TTL, and it discards `availability`.

### `src/server/utils/resource-air.ts` — new (extraction, not new logic)

`modelVersionToAir(version)`, including `fileType` from the primary file. This exists twice today
(`bustOrchestratorModelCache`, `modelVersionResourceCache`); this is the third caller, so extract
first and repoint both.

### `src/server/schema/resource-load.schema.ts` — new

Zod contracts. The one that matters:

```ts
// Four states, and queuePosition lives on `unavailable` — not on `loading`.
export const resourceAvailabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), workers: z.number() }),
  z.object({
    status: z.literal('loading'),
    progress: z.number(),
    workers: z.number(),
    startedAt: z.string().nullish(),
    lastProgressAt: z.string().nullish(),
    etaSeconds: z.number().nullish(),
  }),
  z.object({ status: z.literal('unavailable'), queuePosition: z.number().nullish() }),
  z.object({ status: z.literal('unsupported') }),
]);
```

---

## 2. Server — the tRPC surface

### `src/server/routers/resource-load.router.ts` — new

Registered in `src/server/routers/index.ts` as `resourceLoad`, lazily, beside `auction`.

| Procedure | Type | Purpose |
| --- | --- | --- |
| `getState` | `publicProcedure` | Version ids → availability. Public: **everyone** sees load state on a model page, not just the buyer. |
| `getQueue` | `publicProcedure` | The queue page. |
| `estimate` | `protectedProcedure` | `whatIf` price for the CTA. |
| `submit` | `guardedProcedure` + `rateLimit()` | The purchase. |

Why `guardedProcedure` for `submit`: it is `verifiedProcedure` + not-muted + email-verified, which
is the bar every other spend path uses. `estimate` is only `protectedProcedure` so an unverified
user still sees a price rather than a dead button.

**The rate limit** (C10), on `submit`:

```ts
rateLimit(
  [
    // The catch-all MUST be first and unconditional — see below.
    { limit: 0,  period: CacheTTL.day, errorMessage: 'Loading models is a member benefit.' },
    { limit: 3,  period: CacheTTL.day, userReq: (u) => u.tier === 'bronze' },
    { limit: 6,  period: CacheTTL.day, userReq: (u) => u.tier === 'silver' },
    { limit: 10, period: CacheTTL.day, userReq: (u) => u.tier === 'gold' },
    { limit: 10, period: CacheTTL.day, userReq: (u) => u.tier === 'founder' },
  ],
  undefined,
  { onlyCountSuccess: true, sharedKey: 'resource-load:submit' }
)
```

🔴 **`userTiers` is `['free', 'founder', 'bronze', 'silver', 'gold']` — the call's table omits
`founder`, and an unmatched tier is not "the strictest limit", it is *no limit at all*.** When no row
matches, `validLimits` is empty, the check loop never executes, `canProceed` stays true, and the user
gets unlimited loads. So the free row must be an **unconditional catch-all** rather than
`userReq: (u) => u.tier === 'free'`, and `founder` needs an explicit row. Both of those are the
difference between a cap and the appearance of one.

Three further properties, all verified in the middleware:

- Highest matching limit wins per period, so a gold user matching both the catch-all and the gold row
  gets 10, not 0. That is what makes the catch-all safe.
- `limit: 0` short-circuits immediately, so free is a clean refusal.
- The comparison is `attempts > limit`, so **each number permits one more than it says**. Either
  write 2/5/9, or accept it and say so out loud. Do not "fix" the middleware — it is shared.

🔴 **The same `sharedKey` must go on the generation submit path.** A load can be triggered
implicitly by generating with a non-resident resource, and without a shared quota the cap is
decorative.

---

## 3. Server — receiving progress

### `src/pages/api/webhooks/resource-load.ts` — new

`WebhookEndpoint`-guarded. Receives the orchestrator's `step:*` callbacks for a load workflow and
fans out to the signal topic.

Verified about the payload: a preparing step publishes `WorkflowStepEvent` with `status: preparing`
and `preparation { resource, queuePosition, progress, etaSeconds }`, refreshed every 10s and
deduplicated at 1% progress.

⚠️ **This endpoint may not be needed at all.** `WorkflowCallback.url` is an arbitrary string, and
generation points it straight at the signals service. If we point ours at a signals *group* URL
(`/groups/model-version:{id}/signals/{message}`), the fan-out happens without us.

That is the route the load submit took, so this endpoint is **not built**. Build it if and only if
C9 (the completion notification) survives scoping — that, plus resolving AIR → version id once
instead of per client, is all a server-side hop would add. Tracked as
[2.4](paid-model-loading-decisions.md#24-whether-to-build-the-c4-webhook-at-all).

### `src/server/orchestrator/orchestrator.utils.ts` — edit

`getResourceLoadCallbacks(modelVersionId)` builds a `step:*` callback pointed at the signals group
URL for `model-version:<id>`, so progress fans out with no hop through us. `sendSignalToTopic(topic,
message, data)` is the topic-broadcast helper the site lacked — that one is wrapped in
`withSignals()`; it is unused until C9 needs a server-side send.

### `src/server/common/enums.ts` — edit

```ts
// SignalMessages
ResourceLoadUpdate = 'resource-load:update',
```

Reuse the existing `SignalTopic.ModelVersion`; no new topic constant. ⚠️ Do not collide with
`SchedulerDownload = 'scheduler:download'`, which is the generation-history export.

---

## 4. Client — shared state

### `src/store/resource-load.store.ts` — new

Zustand, `localStorage`-persisted. Holds what this user is waiting on: `{ versionId, name, startedAt }[]`.

On mount: poll `resourceLoad.getState` for everything in the store, drop what is `available`,
resubscribe to the rest. This is the reconnect story Justin walked through, and it is the whole
reason the navbar survives a refresh.

### `src/components/ResourceLoad/resource-load.utils.ts` — new

- `useResourceLoadState(versionId)` — query + topic subscription, the hook every surface uses
- `useResourceLoadPurchase()` — mutation + confirmation modal + error mapping
- `useTrackedResourceLoads()` — the store, for the navbar

The topic subscription is one line, because
[model-version.utils.ts:152](../../src/components/Model/ModelVersions/model-version.utils.ts#L152)
already subscribes model pages to `model-version:<id>`.

---

## 5. Client — the surfaces

### C5 — model version page

**`src/components/ResourceLoad/ResourceLoadCard.tsx`** — new. Rendered in
`ModelVersionDetails.tsx` below the `GenerateButton`.

Model it on **`ModelVersionEarlyAccessPurchase.tsx`**, which is already a Buzz-purchase card in that
exact slot. Same shape, same placement, same confirmation pattern.

| State | Renders |
| --- | --- |
| `available` | nothing (or a quiet "ready to generate") |
| `loading` | progress bar, ETA if present, **Notify me** button |
| `unavailable` + `queuePosition` | queue position, **Notify me** button |
| `unavailable`, no position | price + **Load this model** CTA |
| `unsupported` | nothing — no CTA, ever |

The **Notify me** button is Justin's subscribe button: it pushes the load into this user's
`resource-load.store` so a bystander gets the navbar entry and the notification for a load someone
else paid for.

### C6 — generator

**Edit** `ResourceSelectCard.tsx` / the selected-resource row in the generation form, plus
`ResourceSelectModalContent.tsx`.

- not resident → price + CTA inline
- loading → progress inline for the selected resource, auto-subscribed
- resident → unchanged
- unsupported → not selectable

⚠️ **Depends on the "select any model" decision.** Today selection is gated on
`GenerationCoverage`, and this task assumes that gate has moved. A LoRA-first v1 needs no view
change; checkpoints do. That decision is Phase 0 in the checklist and it is not made yet.

### C7 — navbar

**`src/components/ResourceLoad/ResourceLoadTracker.tsx`** — new. Mounted in
[AppHeader.tsx](../../src/components/AppLayout/AppHeader/AppHeader.tsx#L104) next to `UploadTracker`,
inside the same `currentUser &&` block.

Copy `UploadTracker`'s shape exactly — `Indicator` with a count, `Popover`, a stacked list with
per-item progress. It is the same problem and users already know the affordance.

⚠️ Pass `withinPortal` explicitly. The app themes `Popover` to `withinPortal: false`, so a dropdown
in the header gets clipped.

### C8 — queue page

**`src/pages/resource-queue/index.tsx`** — new page, at `/resource-queue`.

A plain list, no sub-routes — unlike `/auctions`, there is nothing to slug. Polls
`resourceLoad.getQueue`; keeps signal subscriptions only for the current user's own items.

- ⚠️ The cursor is an **integer offset over a list re-ranked from live state on every request**, so
  paging is not stable. Show one page, poll it, do not build infinite scroll.
- ⚠️ Each row costs two grain calls server-side. Keep `take` small; do not poll aggressively.
- Do **not** re-rank client-side — the orchestrator already merges providers, de-dupes and ranks.

### C9 — notification

**`src/server/notifications/resource-load.notifications.ts`** — new, registered in
`utils.notifications.ts` alongside `auctionNotifications`.

```ts
export const resourceLoadNotifications = createNotificationProcessor({
  'resource-load-complete': {
    displayName: 'Model finished loading',
    category: NotificationCategory.System,
    prepareMessage: (n) => ({
      message: `${n.details.name} is loaded and ready to generate with.`,
      url: `/models/${n.details.modelId}?modelVersionId=${n.details.versionId}`,
    }),
  },
});
```

Goes to the buyer **and** everyone who pressed Notify me. The `notification-settings-polarity` guard
pins the default toggle state — read it before choosing `toggleable`.

---

## 6. Feature flag

`src/server/services/feature-flags.service.ts` — `resourceLoad: ['mod', 'granted']`, the cheap
version of C14's "ship it mod-only initially". It gates `estimate`, `submit` and the mod page;
`getState` and `getQueue` are deliberately **not** gated, because load state is a public read.

⚠️ A mod-only launch **exercises none of the rate limiting** — `rateLimit()` short-circuits for
moderators. Do not read a quiet mod rollout as evidence the caps work.

---

## Build order

Each phase is independently testable, and the first two are unblocked today.

**Phase A — plumbing. Built.** `resource-air.ts`, the schema, the service, the router, the signal
message, the callback builders, the `resourceLoad` flag, and a mod-only page at
`/moderator/resource-load` that drives all four procedures against a real download.

**Phase B — read-only surfaces.** The store, `resource-load.utils.ts`, `ResourceLoadCard` in its
non-purchase states, `ResourceLoadTracker`, the queue page. All of this shows real state for loads
triggered by anything, including a generation. **No purchase path yet, so nothing depends on
pricing** — which is the piece blocked on Koen.

**Phase C — the purchase. Server half built:** `estimate` + `submit`, the rate limit,
`assertWorkflowOwner`. Outstanding: the CTA, the `RentCivit` licence refusal
([1.1](paid-model-loading-decisions.md#11--models-without-a-rentcivit-licence)), and 🔴 C2 —
`CalculateCost` returns a hardcoded zero, so `whatIf` still has no number to show.

**Phase D — the rest.** C9 notification, then C11 auctions retirement (blocked on 868gtq1kt, and on
`CoveredCheckpoint` ownership).

The useful consequence: **Phases A and B are real, shippable work that needs nothing from Koen.**
They also produce the demo C14 is asking for — a working view of the experience, driven by live
loads, before we build the money path.

---

## What we are not building

Recorded so they do not creep back in:

- **A queue ranking algorithm.** The orchestrator merges providers, de-dupes by AIR and ranks. Justin's
  "make it look like 1, 2, 3, 4" is done server-side.
- **A size→price table.** The orchestrator prices; the CTA reads `whatIf`.
- **A residency countdown.** The 48-hour policy is real (the spine controllers enforce it), but no
  API reports when a given resource's window ends, so there is nothing to count down from.
- **Load state in search.** Deliberately deferred.
- **Queue-position boosting.** Out for v1.
