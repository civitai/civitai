# Event Bus — Discovery & Planning

**Status:** Discovery / exploration — **backend viability confirmed by DevOps** (see §14). No build commitment yet.
**Author:** briant (with Claude)
**Date:** 2026-06-30 (started 2026-06-29)
**Purpose:** Scope the "event handling server" idea Justin raised, judge the size of the lift, decide where it lives and how it's structured, and recommend a first step — specifically how the upcoming **moderator app** relates to this substrate.

> This is a *thinking* document, not an approved plan. Per the transcript, the bigger re-architecture conversation needs more people; this is the technical groundwork for it.

**Reading guide:** §1–3 framing & references · §4–5 placement & layering · **§6–9 the layer-1 capture deep-dive (the bulk of the design)** · §10–11 transport & processing · §12–13 strategy (strangler, OTA, frontend, API-vs-events, UI) · §14 DevOps findings · §15–17 lift, decisions, open questions.

---

## 0. Status & resume (ON HOLD as of 2026-06-30)

Paused after discovery + DevOps viability check. No code written. When picked back up, **start here.**

**Players:**
- **Justin** — sponsor / originator of the "event handling server" idea. The broader re-architecture "needs more people" (his words).
- **Briant** — driver of this discovery; would build `apps/events` / `packages/civitai-events`.
- **Zacx (DevOps)** — owns `metric-event-watcher` and the CDC/Kafka/Postgres infra. Confirmed backend viability (§14); the natural owner of the "pipes."

**Next steps when resumed (in order):**
1. **Finish the DevOps Q&A** — the operational/Kafka/ownership questions in §14 are still open and gate a real build.
2. **The leadership commitment / air-cover conversation** — per both the transcript and the Claude doc, this (not the tech) is the actual determinant of success. Decide whether this is a funded initiative with top-cover, not a side quest.
3. **Confirm Phase-0 scope** — moderator app consuming one real derived domain event off the CDC stream (§16), as the infra+product deliverable.
4. **Lock the one-way doors** before any code — envelope/namespace/context-header/trust-tier (§12, §17).

---

## 1. What we're actually talking about

Three source materials seeded this, plus two pieces of Civitai prior art found during discovery:

1. **The Justin/Briant transcript** — the verbal pitch.
2. **The earlier Claude conversation** ("Island-based UI architecture…") — islands → plugin platform → **mediated event bus** → strangler migration.
3. **The `hub` .NET repo** (`C:\work\hub`) — a partially-built reference implementation of the pattern (§2).
4. **`metric-event-watcher`** (`C:\work\metric-event-watcher`) — Civitai's **own production CDC pipeline**, found mid-discovery; reference-only (§2b).

The core idea, in one sentence:

> Replace a sprawl of little backend services-behind-endpoints with **one event-handling substrate** where behavior is expressed as **handlers that subscribe to typed events on a bus** — handlers independently authored, versioned, and ideally shippable "over the air" — and use that bus as the **strangler-fig seam** to migrate logic out of the Next.js monolith.

Two things are conflated in the conversation and worth separating:

| Layer | What it is | Driving quote |
|---|---|---|
| **A. Backend event bus** | event substrate; services emit & subscribe; the seam for strangling the monolith | "rather than building a bunch of little backend services… we'd just have an event handling server" |
| **B. Frontend slot/app platform** | pages declare typed slots; "app blocks" fill them; apps talk via a host-mediated bus | "community can develop their own app blocks" |

**A is the near-term, higher-leverage piece** and is what this doc focuses on. B is a year-plus product bet treated as the north star that A must not foreclose.

---

## 2. Reference: the `hub` repo (.NET) — patterns to port, not code to import

**~70% of the backend *patterns* for layer A are already worked out** in `C:\work\hub`, a .NET 5 / Kafka solution. It de-risks the design because the hard primitives have been built once. **Crucial caveat:** `hub` is .NET; the Civitai monorepo is 100% TypeScript (§4) — so `hub` is a *design reference*, not a dependency.

### What `hub` proves out

| Capability | Where |
|---|---|
| Kafka-mediated message bus | `Library.Messages/Kafka/MessageBus.cs` |
| **Both primitives:** `emit` (fire-and-forget) + `request` (awaitable request/response over a `status` topic, correlated by `work-id`) | same |
| Topic-as-event-type via attributes (`[ConsumeTopic]`/`[ProduceTopic]`) | `Kafka/Attributes/*` |
| CQRS command→event naming (`x.create` ⇒ `x.created`) | `templates/plugins.feature/standard/Create.cs.hbs` |
| Handler discovery via reflection + introspectable schemas (`ConsumerRecord`) | `Kafka/Consumer/ConsumerRegistrar.cs` |
| Capability/authorization layer (`[PolicyFor("programs.*")]`, Redis-cached) | `Library.Messages/Policy/*` |
| Context propagation via headers (`ClientContextHeader`) | `Kafka/Infrastructure/Message.cs` |
| Container-role specialization (same binary as `Consumers`/`PolicyManager`/`ApiGateway`) | `Worker.cs` |
| Scaffolding for new handlers (`plop`) | `plopfile.js` |

### What `hub` does NOT have (the real work)

1. **"Over-the-air" handler updates — stubbed, not built.** `ConsumerRegistrar.cs` has a commented-out "ConsumerRegistrar Syncing" block and empty `PublishChange`/`Sync` methods. Today all handlers compile into the binary; adding one means redeploy. Justin's "push to release → handler appears" loop doesn't exist yet.
2. **Polyglot handlers** — possible (it's just Kafka) but no shared schema/SDK makes a non-.NET handler first-class.
3. **No schema registry** — event shapes are ad-hoc JSON.

> **Takeaway:** `hub` is a worked-out blueprint we port to TS — not a drop-in.

## 2b. Reference: `metric-event-watcher` — Civitai's own production CDC pipeline (reference-only)

Found mid-discovery: a DevOps engineer already built and ships (**v1.9.6**) a production service doing exactly the layer-1 capture this doc designs. **Decision: we do *not* reuse or adapt it — it's a reference.** Its value is proving the approach works on Civitai's actual Postgres and pinning down decisions we'd otherwise re-derive.

**What it is:** Debezium CDC (pgoutput) on Postgres (+ ClickHouse) → Kafka → factory handlers → ClickHouse / Redis / Meilisearch / Signals. Runs on k8s (Strimzi Kafka), self-configures its Debezium connector on startup.

**Decisions worth copying (all confirmed in production):**
- **Filtered full-table publication** over an explicit ~23-table include list — **no column lists** (validates §7).
- **Selective `REPLICA IDENTITY FULL`** on only ~8 tables (those whose DELETE needs non-PK columns); `DEFAULT` elsewhere (validates §8).
- **Idempotency**: offset-commit-after-sink + ClickHouse `ReplacingMergeTree` dedup + Redis Lua `incrementOnce`.
- **Outbox for heavy tables** (`Image`) / state-changes (publish/unpublish): trigger → `Outbox` row → watcher processes → delete on completion.
- Shares types via the **`event-engine-common` git submodule** — which is where the `Outbox` Briant found lives (§3).

**Why not reuse it:** it's metrics-hardcoded (handlers and sinks assume metrics as the output); the *mechanism* is general but generalizing it would bloat a focused, working service and couple the bus's fate to metrics. We build our own, borrowing the decisions.

---

## 3. What this would touch on the Civitai side

Civitai has **no unified event bus.** Side effects are coupled into mutations in four styles. Trace of `toggleReaction` after the DB write ([reaction.controller.ts](src/server/controllers/reaction.controller.ts)): synchronous ClickHouse track + `updateEntityMetric`, then fire-and-forget (error-swallowed) `encouragementReward.apply` / `goodContentReward.apply` / `createReactionNotification`. Model publish ([model.service.ts](src/server/services/model.service.ts) ~L2038+) adds replica-lag flag, cache bust, Redis-queued search-index updates, and fire-and-forget `ingestModel`.

| System | Files | Verdict |
|---|---|---|
| Fire-and-forget side effects | controllers/services | **Replace** with event subscribers (retries/idempotency) |
| Redis bucket work queues | [redis/queues.ts](src/server/redis/queues.ts), [base.metrics.ts](src/server/metrics/base.metrics.ts) | **Replace/absorb** — emit-event instead of queue-on-mutation |
| Outbound webhooks (cron pull) | [webhooks/](src/server/webhooks/) | **Integrate** — webhooks = events over HTTP |
| Notifications (pending→actual cron) | [notification.service.ts](src/server/services/notification.service.ts) | **Integrate** |
| ClickHouse tracking | [track.schema.ts](src/server/schema/track.schema.ts) | **Leave alone / mirror** — its `ActionType` taxonomy is a ready event vocabulary |
| Signals (SignalR push) | [signals/](src/server/signals/) | **Leave alone** — a client-push transport an event subscriber can *call* |
| `Outbox` table + `OutboxService` | [event-engine-common/services/outbox.ts](event-engine-common/services/outbox.ts) | **Live, not dead** — consumed by `metric-event-watcher` via the `event-engine-common` submodule. Trigger→Outbox→process→`delete(id)`. **No bulk/age-based cleanup** — only per-row delete-after-process, so it grows if the consumer lags. A robust outbox needs a backstop purge + depth/lag monitoring. |
| Kafka | `kafka.manual_events` insert in [deliver-creator-compensation.ts](src/server/jobs/deliver-creator-compensation.ts) | We already run Kafka — infra precedent exists |

---

## 4. Where it lives in the monorepo (placement confirmed viable — §14)

### The monorepo is 100% TypeScript

Civitai is a pnpm workspace (`.`, `packages/*`, `apps/*`): the root Next.js monolith; **[apps/auth](apps/auth/)** (SvelteKit, released independently); **[apps/moderator](apps/moderator/)** (Next 16, already scaffolded, imports `@civitai/db` etc. via `workspace:*`); **[packages/](packages/)** shared TS libs shipped as raw TS.

- **`hub` can't be a monorepo citizen** (it's .NET; can't consume `@civitai/*`). Reference only.
- **`apps/auth`/`apps/moderator` are the precedent**: separate, independently-deployed apps sharing `packages/*`. An event server slots right in.
- **DevOps confirmed (§14):** everything now runs co-located in the **DataPacket cluster** (the `metric-event-watcher` DigitalOcean references are stale — nothing runs there anymore). So a monorepo `apps/events` deploying into DataPacket sits next to Postgres/Redis/Kafka. **The deployment concern that could have vetoed monorepo placement is resolved.**

### The split: framework *package* + host *app(s)*

```
packages/civitai-events     ← framework: envelope types, emit()/request() client,
                              handler registration, Kafka wrappers, context/policy
                              contracts, event-type schemas + codegen
                              → consumed by: monolith, apps/events, apps/api, apps/moderator
apps/events                 ← stateful host: CDC capture + derivation + handlers.
                              Scales with DB-change volume. Own Dockerfile.
apps/api  (see §13)         ← stateless HTTP backend for SPAs. Scales with traffic.
```

**Why the core must be a package:** the monolith and `apps/moderator` need to emit/subscribe too. Same reason `@civitai/db`/`@civitai/redis` are packages. The host app is just *one* consumer of the framework.

**Two build facts:** (1) no Kafka client exists in the JS workspace yet — net-new dep (`kafkajs` likely, matching `metric-event-watcher`). (2) **TS-first; polyglot is v2** — don't pay for it upfront.

---

## 5. The three layers (a frame for the rest of the doc)

"Event system" bundles three independent decisions. Outbox vs CDC is only the first one:

1. **Capture** — how you detect "something happened" (§6–9). *This is where most of the design effort and most of this conversation went.*
2. **Transport** — what carries events to subscribers (§10).
3. **Processing** — projections, sagas, orchestration (§11).

You assemble one choice per layer, leaning on what you already operate.

---

## 6. Layer 1 — Capture: the event-source menu

How events get *produced*. The tradeoff axis: **app/ORM-level** capture is domain-shaped + transactional but only catches code-path writes; **DB-level** capture catches *every* writer (incl. manual SQL / retool) but is row-shaped.

| Approach | Catches out-of-band writes? | Shape | Notes |
|---|---|---|---|
| **App-level emit** | ❌ | domain | simplest; dual-write/atomicity risk unless paired with outbox |
| **Transactional outbox** | ❌ (app-code only) | domain | the `OutboxService` stub; transactional, the strangler seam |
| **Prisma client extension** (pre/post-save) | ❌ (misses raw SQL) | domain-ish | the ".NET pre/post-save event" Briant remembered; **skip as primary** — services are mostly raw SQL |
| **Trigger → table / `pg_notify`** | ✅ | row | triggers catch all writers; notify isn't durable |
| **CDC (logical replication)** | ✅ | row | the production choice in `metric-event-watcher`; **recommended primary** |

**Civitai-specific wrinkle:** migrations + data edits are applied **manually (psql/retool)**, and services use **enormous raw SQL**. So app-level capture is structurally blind to a meaningful fraction of changes — moderation especially (mods act via retool). That's the decisive argument for **CDC** as the primary capture for entity changes, with app-emit reserved for explicit domain events that carry business meaning the DB can't infer.

---

## 7. Layer 1 — CDC mechanics: logical replication & publications

Postgres writes every change to the **WAL**; logical decoding streams those changes out (Debezium, or a lighter Node `pg-logical-replication` client). **DevOps confirmed (§14):** tapping the WAL adds ~no DB compute — "the database always generates these changes anyway (it's the basis of replication); subscribers just tap in."

### Publish full tables, not column lists

```sql
CREATE PUBLICATION civitai_events FOR TABLE "Model", "Post";   -- no column list
```

Earlier we considered a column list as an efficiency cut — **rejected**, because it fights extensibility: adding a newly-watched column would require `ALTER PUBLICATION` (DDL on the source) every time. Full-table means **a new watched field is a pure code change in the derivation layer (§9), never a DB change.** `metric-event-watcher` does exactly this (filtered full-table publication).

**Overhead of full-table is smaller than intuition says** (and lands downstream of the WAL, not on the DB write path):
- WAL cost is identical regardless of publication shape (`wal_level=logical` is global).
- Postgres does **not** re-stream unchanged large/TOASTed values — an `nsfwLevel` toggle never ships the 50KB `description`.
- So the only delta vs a column list is small scalar columns nobody watches — negligible, and `Model`-class change rates are modest.
- *If* profiling later shows the stream is fat: a **generous superset minus blobs** is the tuning knob (include small structured fields, exclude `description`/big JSON). Reach for it with evidence, not preemptively.

**The only thing that still needs a publication change is a new *entity* (table)** — a rarer, deliberate decision. Adding a *field* never does.

---

## 8. Layer 1 — Old values & transitions: `REPLICA IDENTITY FULL` vs a prior-state cache

The sharp question (Briant's): "a subscriber compares old vs new to decide whether to act — will the old values be *in* the event?" **No, not by default.** At **default / PK replica identity**, an UPDATE event carries **all new** values but **old values only of the PK** — not old `nsfwLevel`/`status`. Two ways to get the delta (DevOps confirmed both, and that **disk headroom exists** for FULL):

1. **Prior-state cache in the subscriber** — keep last-seen `{fields}` per entity (Redis/LRU), compare new-vs-cached. Works at PK identity, **no extra WAL**.
2. **`REPLICA IDENTITY FULL` on that table** — old values arrive *in* the event; **adds WAL** (logs full old row). Table-global (shared with `metric-event-watcher`), coordinate per §14.

### Decision framework (per table)

**Favor FULL when:**
- You need **old values on DELETE** — a cache can't reliably cover deletes (row gone, maybe never cached). *Sharpest differentiator.* (`metric-event-watcher` uses FULL precisely here, for un-react decrements.)
- **Many apps watch the same entity** — FULL puts old+new in the stream **once for all subscribers**; caches make each app re-implement prior-state + cold-start + eviction. *This is our whole premise, and it tips the default toward FULL more than a single-consumer design would.*
- You want **stateless, correct-on-day-one subscribers** (no cache to seed).

**Favor cache (or Outbox) when:**
- The table is **hot and wide** — FULL's per-write WAL cost is continuous (e.g. `Image`). `metric-event-watcher`'s own choice: heavy tables like `Image` use the **trigger→Outbox** pattern, not FULL CDC.
- You already keep a projection, so prior-state is "free."

### Recommended per-table heuristic for Civitai

| Table type | Choice |
|---|---|
| Moderate entity tables — `Model`, `Post`, `Collection` | **FULL** (headroom exists, serves all apps, handles deletes, stateless subscribers) |
| Heavy/wide — `Image` | **cache or trigger→Outbox** (avoid continuous WAL tax) |
| Narrow high-churn — reaction tables | **FULL** (tiny rows ⇒ cheap; deletes need old values) |

Easy win: any table already FULL for `metric-event-watcher` costs nothing extra to consume from the events side.

---

## 9. Layer 1 — Capture once, derive many: typed domain events

The premise: many apps watch the same entity but care about **different fields** (moderator → `published`, member → `nsfwLevel`). The rule: **capture once per entity, consumer-agnostic; never fork the capture pipeline per app.** "Which field do I care about" is a *subscription* concern, solved by **deriving typed domain events** and letting apps subscribe **by type**.

```
Model row change (CDC)
   │
   ▼  derivation/adapter (the one place that knows what's "meaningful")
   ├─► civitai.model.published         { modelId, at }
   ├─► civitai.model.unpublished       { modelId }
   ├─► civitai.model.nsfwLevel.changed { modelId, from, to }
   └─► civitai.model.updated           { modelId, changedFields[] }   ← catch-all
   │
   ▼  bus
   moderator → model.published          member → model.nsfwLevel.changed
```

**Why typed events, not raw-change-plus-column-filter:** if each app filters on raw column names it couples to your Postgres schema (a rename breaks every app). The derivation/adapter is the *one* place that knows "published = `status`→Published". New app caring about a new field → a new subscription (or a new derived type), **no capture change, no pipeline fork.**

**Granularity:** dedicated events for meaningful transitions (`published`, `nsfwLevel.changed`, `deleted`) **+ a generic `model.updated { changedFields }`** catch-all. Avoid both "one giant `model.changed`" (everyone couples to columns) and "an event per column" (explosion).

### Worked example (illustrative; `@civitai/events` is the proposed API)

```ts
// apps/events/src/derive/model.ts
export async function deriveModelEvents({ modelId, next }) {
  const key = `cdc:model:${modelId}`;
  const prev = JSON.parse((await redis.get(key)) ?? 'null');

  if (prev === null) {                          // cold start: baseline only, don't synthesize
    await redis.set(key, JSON.stringify({ status: next.status, nsfwLevel: next.nsfwLevel }));
    return;                                      // one-time backfill handles pre-existing rows
  }
  if (next.status === 'Published' && prev.status !== 'Published')
    await bus.emit('civitai.model.published', { modelId, at: next.publishedAt });
  if (prev.nsfwLevel !== next.nsfwLevel)         // cache supplies "from" (the FULL-identity alternative)
    await bus.emit('civitai.model.nsfwLevel.changed', { modelId, from: prev.nsfwLevel, to: next.nsfwLevel });

  await redis.set(key, JSON.stringify({ status: next.status, nsfwLevel: next.nsfwLevel }));
}
```
```ts
// apps/moderator — idempotent: re-delivery is a no-op
bus.on('civitai.model.published', ({ modelId }) =>
  db.moderationQueue.upsert({ where: { modelId }, create: { modelId, status: 'pending' }, update: {} }));
```

**Three subtleties that survive production:** (1) **cold start / seeding** — first sighting can't know the transition; record-and-skip + a one-time backfill (or seed the cache from a snapshot). (2) **idempotency is non-negotiable** — CDC is at-least-once; consumers must be idempotent regardless of edge-detection. (3) **cache durability** — losing prior-state degrades to a missed delta (safe), not a phantom one.

### Triggers vs CDC: what can and can't move

CDC is **post-commit, observe-only**. So:
- **Cannot move to CDC** — BEFORE triggers that mutate the row (e.g. the one real trigger in the repo, `app_block_publish_requests` setting `updated_at`), validation/veto, invariant enforcement. CDC can't intercept or change a write.
- **Can move (often should)** — AFTER side-effect triggers (audit, denormalized counters, cache invalidation). Relocating them to TS handlers gets logic out of in-transaction PL/pgSQL — itself a strangler step. Caveats: atomic→eventually-consistent, exactly-once→at-least-once (idempotency), old-vs-new needs FULL or cache. **Cut over by shadow-running** (trigger + handler, compare) before dropping.

---

## 10. Layer 2 — Transport

| Option | Notes |
|---|---|
| **Kafka** *(recommended)* | DevOps already runs it (Strimzi on k8s) and it's `metric-event-watcher`'s transport; durable, replay, partitioned. Heaviest ops, but already operated. |
| **Redis Streams** | We already run Redis; far lighter ops; consumer groups + replay-ish. A legit *lighter start* before committing to Kafka topics. |
| **Postgres-as-queue** (`pg-boss`, `SKIP LOCKED`) | Zero new infra, transactional with writes; caps at moderate scale. |
| NATS / RabbitMQ / cloud buses | New infra; cloud buses mainly for external/webhook fan-out. |

Given DevOps already operates Kafka, **Kafka is the default**; Redis Streams is the fallback if we want a lighter Phase-0 substrate.

---

## 11. Layer 3 — Processing: projections, sagas, and the complexity trap

Briant's concern — *event engines breed "super complex flows" where events get lost or loop* — is **the** failure mode of event-driven systems ("event soup"). Defenses:

**Lost events** = two sub-problems. (a) *Silent failure* — but a real bus with at-least-once + **dead-letter queue** is **strictly better** than today's `.catch(handleLogError)` fire-and-forget. (b) *Untraceable causation* — the envelope carries **`correlationId`** (root action) + **`causationId`** (immediate parent); every event's ancestry is reconstructable.

**Loops** — guardrails in `packages/civitai-events`: hop-depth/TTL on the envelope (reject + alert past a ceiling), cycle detection on `(type, entityId)` ancestry, and the **facts-vs-commands** rule (a handler reacting to a fact must not emit a command that re-derives that fact).

**Sagas (the key line): events are for *fan-out*; orchestration is for *flow*. Never build a saga out of choreography.**
- **Fan-out (safe forever):** one fact → many independent, order-independent, idempotent reactions. Depth-1. This is ~80% of Civitai's real needs.
- **Flow (dangerous as a chain):** the moment you care about ordering, branching, or rollback/compensation, the control flow must live in **one readable place** — an orchestrator, not five handlers each emitting the next step. **Civitai already does this right:** generation runs through a dedicated orchestrator (`services/orchestrator/orchestrator.service.ts`), not an event chain.
- **Don't adopt Temporal in v1.** Just don't fake sagas with chains. Reach for a workflow engine only when a real compensating flow appears.

**Projections (optional, layer-3):** streaming materialized-view engines (**Materialize / RisingWave / ksqlDB**) consume CDC and maintain incrementally-updated SQL views — "CDC → live read-models without writing projection handlers." Worth evaluating *if* the read-model count grows enough to justify another system; otherwise hand-rolled handlers.

---

## 12. Architecture details (envelope, primitives, OTA) & frontend

**Envelope** (versioned from day one): `{ type, version, source, scope, context, payload, correlationId, causationId, timestamp }`. `type` is reverse-DNS namespaced (`civitai.image.reacted`); only the host emits `civitai.*`. `context` is **attached by the host, never trusted from the emitter** (identity, auth tier, subject, trace) — map onto **W3C Trace Context** for OTEL compatibility (we run OTEL + `@civitai/telemetry`).

**Two primitives:** `emit(type, payload)` (fire-and-forget) and `request(type, payload) → Promise` (awaitable, deniable). **CQRS, not event-sourcing.** Side effects in handlers, not producers; **handlers idempotent** (at-least-once). **Schemas are contracts** — version events, additive-only changes safe. **Brutally minimal host** (failure mode #5: the shell becomes the new monolith) — applies to `packages/civitai-events`, not the apps on top.

**OTA handler updates** (the headline novelty), in increasing ambition: (1) **CI-built fast rolling deploy** *(recommended v1)* — 90% of the felt benefit, ~0 exotic risk; (2) dynamic handler registry over Kafka (hub's stubbed `ConsumerRegistrar` sync); (3) true sandboxed hot-loaded handler code (layer-B, full trust/sandbox burden — **not v1**). Ship #1, keep #2/#3 reachable.

**Frontend (layer B) — defer.** Slots/app-blocks/marketplace is a year-plus product; its hard problems are non-technical (review, trust tiers, sandbox runtime, economics, DX). The only thing it forces *now*: design the envelope, namespace, context-header, and trust-tier model as **one-way doors**.

---

## 13. Two structural decisions surfaced late

### API server vs events project → **separate deployables, shared packages**
A generic API serving multiple SPAs and the events project are **opposite runtime shapes**: the API is **stateless**, scales with **traffic**, app-dev-owned; the events project is **stateful** (consumer offsets, slot), scales with **change volume**, DevOps-owned. Fusing them is an anti-pattern — autoscaling the API to N replicas would spawn N event consumers (duplicate work / forced rebalancing). So:
```
packages/*   ← shared domain logic, types, event contracts, read-model defs
apps/api     ← stateless HTTP for SPAs; reads projections, emits commands, holds SPA
               connections (SSE/WebSocket/Signals) for live push
apps/events  ← stateful CDC capture + derivation + handlers; writes projections
```
They communicate through the bus + DB/projections, never by importing each other. The events project never talks to browsers — `apps/api` holds connections and fans out live updates. Keep `apps/api` modular per-domain or it becomes monolith 2.0 (failure mode #5).

### A UI to manage the bus → manage *derivation rules*, not publication columns
Managing Postgres publication *columns* from a UI is possible but the wrong layer: it needs a privileged role doing `ALTER PUBLICATION` (DDL) on the primary, isn't self-executing through Debezium, and causes catalog drift. And with **full-table publication (§7) there's nothing to manage at the column level anyway.** The useful self-service UI is over **event-derivation rules** ("when `status`→Published emit `model.published`") — plain app config in `apps/events`, zero DB-DDL risk. If you ever manage publication *membership* (new entities), do it via a **reconciler** (UI edits desired-state → a controller applies it idempotently, audited), never raw DDL from the web tier.

---

## 14. DevOps findings — backend viability **confirmed**

From Briant's conversation with the DevOps engineer who owns `metric-event-watcher` (Zacx):

- **Second Debezium connector + replication slot on the same Postgres: acceptable, case-by-case.** Most tables we care about already have PK (default) identity.
- **Deployment: everything is co-located in the DataPacket cluster now; nothing in DigitalOcean** (the watcher's DO references are stale). → A monorepo `apps/events` deploying into DataPacket can reach Postgres/Redis/Kafka. **Monorepo placement is unblocked.**
- **`REPLICA IDENTITY FULL` is affordable** — "more disk consumption, but we have plenty of headroom if needed." So FULL is a real option, not a last resort.
- **Old values only come with FULL identity**; the alternative is external prior-state tracking — "which makes sense depends entirely on your use case" (→ the §8 framework).
- **Tapping the WAL adds ~no DB compute** — "the database always generates these changes anyway; subscribers just tap in. Filtering happens downstream." Validates full-table + filter-in-derivation.

**Coordination point that remains:** `REPLICA IDENTITY` is table-global, shared with the watcher — any change to a table's identity must be cleared with DevOps (he said case-by-case is fine).

### Still-open DevOps questions (asked but not yet answered)

Zacx answered the three viability-critical questions plus REPLICA IDENTITY / old-values / WAL overhead. These operational ones remain and gate a real build — pick up here:

- **Kafka:** shared cluster or our own? Topic naming / partitioning / retention conventions, who creates topics? Shared Kafka Connect (Debezium) instance or our own? Any schema registry / serialization standard, or raw JSON like the watcher?
- **Postgres:** does CDC read the primary or a replica? (Logical decoding on a standby needs PG16+.) Exact `wal_level` / PG version / host? How is the replication role / credentials managed and rotated? Can two publications cover overlapping tables, or should we share one?
- **Operations:** what broke standing up Debezium on our Postgres? How did the **initial snapshot** behave on big tables (`Image`, `Model`) — did it load the primary? How does the connector handle **DDL / manual migrations** on watched tables (we apply migrations by hand)? Slot-lag monitoring + runbook; any past WAL-retention incidents? Any duplicate / data-loss incidents on rebalance/restart?
- **Ownership:** would DevOps operate the CDC/Kafka pipes for `apps/events` (and be on-call), or just advise? Where's the line between "DevOps provides the pipes" and "Briant builds the handlers"?

---

## 15. How big is the lift?

**Layer-A Phase 0 (one feature end-to-end through the bus):** *Medium, not monumental* — `hub` is a blueprint, `metric-event-watcher` proves the CDC/Kafka path on Civitai's Postgres, and the infra (Kafka, replication) is operated.

- `packages/civitai-events` (envelope, emit/request, Kafka wrapper, registration) + a minimal `apps/events` host + CDC capture/derivation: **~3–5 weeks**.
- Envelope/namespace/context-header design + 5–8 seed event types: **~1 week** (one-way doors).
- One real consumer migrated (the moderator app, §16): **~1–2 weeks**.

Roughly **6–8 weeks** to a credible Phase 0. OTA hot-loading and the frontend platform are explicitly *not* in this number.

---

## 16. Recommendation for the moderator app

`apps/moderator` already exists (Next 16 scaffold). The real fork isn't framework — it's **how it gets data**: poll the monolith's endpoints, or **consume domain events**.

**Recommended middle path:** don't block it on a full platform (failure mode #1), but make it the **Phase-0 driving feature** — keep building the scaffold, but have it consume a few real domain events (`civitai.model.published`, `civitai.image.reported`, `civitai.user.flagged`) derived from the CDC stream via `packages/civitai-events`, instead of polling. Moderation is an ideal Phase-0 candidate (read-heavy on events, decoupled, real users), and — importantly — mods act via **retool (out-of-band)**, which CDC capture *catches* and app-emit would miss. Ships the app *and* proves the seam.

---

## 17. Decisions & open questions

### Resolved
- **Host language → TypeScript** (monorepo is all TS; `hub` stays a reference).
- **Placement → monorepo `apps/events`**, deploying into DataPacket, co-located with infra (§14).
- **Structure → `packages/civitai-events` (framework) + `apps/events` (host) + `apps/api` (separate, for SPAs)** (§4, §13).
- **Capture → CDC (logical replication)** primary, app-emit for explicit domain events (§6).
- **Publication → full tables, not column lists** (§7).
- **Old values → per-table: FULL vs prior-state cache** per the §8 framework; DevOps confirmed both viable + headroom.
- **Transport → Kafka** (already operated), Redis Streams as lighter fallback (§10).
- **Reuse `metric-event-watcher`? → No, reference only.**
- **Backend viability → confirmed by DevOps** (§14).

### Still one-way doors / open
1. **Envelope shape, namespace, context-header, trust-tier model** — design deliberately before anything external depends on them.
2. **OTA ambition for v1** — confirm "fast rolling deploy," not hot-loading.
3. **Per-table `REPLICA IDENTITY` plan** — which tables go FULL vs cache; clear each with DevOps (table-global).
4. **The "never migrates" list** (Buzz ledger, Postgres search, parts of moderation).
5. **`Outbox` cleanup** — it has no backstop purge; if we lean on it, add age-based purge + depth/lag monitoring (§3).
6. **Commitment / air cover** — the actual determinant of success; the transcript flags "this needs more people."

---

### Appendix: source map
- Vision: `C:\Users\Briant\Downloads\transcript.md`
- Long-form design: `C:\Users\Briant\Downloads\Claude-Island-based UI architecture for micro app systems.md`
- Reference (.NET): `C:\work\hub` (`Libraries/Library.Messages/`, `plopfile.js`, `docker-compose.yaml`)
- Reference (production CDC): `C:\work\metric-event-watcher` (Debezium→Kafka→handlers; `event-engine-common` submodule)
- Civitai monorepo: `pnpm-workspace.yaml`, [apps/auth](apps/auth/), [apps/moderator](apps/moderator/), [packages/](packages/)
- DevOps findings: §14 (conversation with Zacx, 2026-06-29/30)
