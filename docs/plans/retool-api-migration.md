# Retool DB Writes → API Endpoints Migration Plan

**Parent ticket:** [868jk3qh8](https://app.clickup.com/t/868jk3qh8) — Migrate Retool DB writes to API endpoints / on-site UI
**Status:** DONE, then superseded — see below.
**Owner:** TBD

> 🔴 **This plan shipped and its central mechanism has since been replaced. Read it as history.**
>
> The endpoints were built as designed, on a `defineRetoolEndpoint` wrapper with one endpoint per
> resource and an `action` field selecting the operation. On 2026-08-19, with Retool switched off, that
> whole family was deleted: every action is now its own `defineModeratorEndpoint` route under
> `/api/mod/*`, authenticated as the acting moderator rather than by a shared API key, and self-describing
> at `/moderator/api`.
>
> Current shape and the endpoint list: [`../moderator-endpoints.md`](../moderator-endpoints.md).
> The reasoning in *Why* below still holds — it is the argument for having endpoints at all, and that
> argument is what the replacement kept.

---

## Why

Retool runs raw `INSERT/UPDATE/DELETE` against prod Postgres for 14 distinct moderator workflows. That bypasses:

- Central validation, invariants, business rules
- Structured audit (only Retool's raw query history exists)
- Existing app-level permission checks
- Refactor safety (schema changes silently break Retool queries)
- Atomicity on composite writes (Group 12 runs 3 separate queries — partial-state risk)

**Goal:** Every Retool write goes through a typed, audited, role-gated HTTP endpoint that wraps a service function. No more raw SQL in Retool for moderator actions.

---

## Architecture

### Endpoint pattern

One file per **domain** under `src/pages/api/mod/retool/`. Inspired by the dispatcher pattern in `src/pages/api/testing/referrals.ts`, but using a **registry-style helper** so each action declares its schema + config + handler in one record (see the registry sketch in Justin's reply below). The concrete example for `user.ts` lives in that reply.

@justin: I wonder if we can come up with some sort of like registry system so that rather than having to list clear profile, like those actions and stuff up there, instead it's like you can define the commands or actions that are available and the schema for them. And then there's like a super schema that gets assembled from that registry or whatever. Got any ideas about how we might do that?

@ai:* Yes — proposed pattern below. Each action defines its own input schema + config + handler in a single record. The wrapper builds the union schema + dispatch table from the registry, so adding/removing actions is a one-place edit.

```ts
// src/server/utils/retool-endpoint.ts
type RetoolAction<TInput extends z.ZodTypeAny, TOutput> = {
  input: TInput;
  privileged?: boolean;
  rateLimit?: { max: number; windowSeconds: number };
  handler: (input: z.infer<TInput>, ctx: RetoolCtx) => Promise<TOutput>;
};

export function defineRetoolEndpoint<
  TActions extends Record<string, RetoolAction<z.ZodTypeAny, unknown>>
>(actions: TActions): NextApiHandler {
  // Build discriminated union from registry keys + each action's input schema.
  // Baseline fields (`action`, `actorId`) merged into every variant.
  // Dispatch: look up actions[input.action], apply rateLimit, apply privileged auth,
  // emit audit event, run handler, return JSON.
}
```

```ts
// src/pages/api/mod/retool/user.ts — usage
export default defineRetoolEndpoint({
  clearProfile: {
    input: z.object({
      userId: z.number().int().positive(),
      fields: z.array(z.enum(['location', 'bio', 'message'])).optional(),
    }),
    rateLimit: { max: 60, windowSeconds: 60 },
    handler: (input, ctx) => userService.clearProfileFields(input, ctx.actor),
  },
  mute: {
    input: z.object({ userId: z.number().int().positive(), until: z.string().datetime().optional(), reason: z.string().optional() }),
    rateLimit: { max: 60, windowSeconds: 60 },
    handler: (input, ctx) => modActions.muteUser(input, ctx.actor),
  },
  updateIdentity: {
    input: z.object({ userId: z.number().int().positive(), username: z.string().optional(), email: z.string().email().optional(), name: z.string().optional() }),
    privileged: true,
    rateLimit: { max: 20, windowSeconds: 60 },
    handler: (input, ctx) => userService.updateIdentity(input, ctx.actor),
  },
  toggleModerator: {
    input: z.object({ userId: z.number().int().positive(), isModerator: z.boolean() }),
    privileged: true,
    rateLimit: { max: 10, windowSeconds: 60 },
    handler: (input, ctx) => userService.toggleModerator(input, ctx.actor),
  },
});
```

Wins:
- One spot per action — schema, gating, rate limit, handler live together.
- Type-safe — `ctx` typed, `input` narrowed by discriminated union, no manual switch.
- Schema auto-assembled — `z.discriminatedUnion('action', Object.entries(actions).map(...))`.
- Doc-comment block at top of file still lists actions for human readability — could even be generated from the registry at build time later.

Each file leads with a doc comment block (per `CLAUDE.md` Debug Endpoints section) listing actions + required params.

### `defineRetoolEndpoint` wrapper

New helper in `src/server/utils/retool-endpoint.ts`. Type sketch + usage example in the registry reply above. Wrapper responsibilities:

1. **Auth.** API key in `Authorization: Bearer …` header resolves to a user with `isModerator: true`. Privileged actions additionally require the user be in the super-admin allowlist (env `granted-permission keys (`retoolUpdateIdentity`, `retoolToggleModerator`)`).
   - Token-only `?token=$WEBHOOK_TOKEN` fallback acceptable for non-privileged actions where Retool's shared resource carries the token. Privileged actions are user-API-key only.
2. **Schema build + parse.** Builds `z.discriminatedUnion('action', …)` from the action registry. Baseline fields (`action`, `actorId` resolved from auth) injected per variant. Zod `safeParse` on `{ ...query, ...body }`. 400 on failure.
3. **Rate limit.** Redis-backed, keyed on `(action, actorId)`. Per-action config — bulk endpoints get generous limits, single-target endpoints get tight ones to prevent abuse.
4. **Audit log.** Wrapper emits one ClickHouse event per call (success and error both logged) via the existing tracker client. See "Audit logging" section below.
5. **Dispatch.** Looks up `actions[input.action]`, invokes the typed handler, returns JSON.
6. **Error handling.** Reuses `handleEndpointError`.

### Audit logging

Existing `ModActivity` table has `@@unique([activity, entityType, entityId])` — it stores **latest** action per entity, not history. Not enough.

New table `RetoolAuditLog`:

```prisma
model RetoolAuditLog {
  id         BigInt   @id @default(autoincrement())
  createdAt  DateTime @default(now())
  actorId    Int      // moderator who initiated
  action     String   // e.g. "user.clearProfile"
  privileged Boolean  @default(false)
  payload    Json     // sanitized input (no secrets)
  outcome    String   // "ok" | "error"
  errorMsg   String?
  affected   Json?    // { userIds: [...], commentIds: [...], etc. }

  @@index([actorId, createdAt])
  @@index([action, createdAt])
  @@index([createdAt])
}
```

@dev: — Should we use `civitai-events` ClickHouse stream instead of a Postgres table? Pro: cheap, queryable in Metabase. Con: more setup. Defaulting to PG for now since it's a low write volume.

@justin: Yeah, I think CH is probably better for this... Still probably need a table there and we might want to go through the clickhouse tracker "client"

@ai:* Going ClickHouse. Investigating the tracker client now to confirm the existing pattern. Will update this section with the concrete event shape + new CH table DDL (something like `default.retoolAuditLog` with columns mirroring the Postgres draft above) once I have the tracker example in hand. Removing the Prisma model from Phase 1 deliverables — replacing with a CH migration + tracker-emit call inside the wrapper.

**Concrete plan (post-investigation):**

Tracker lives at `src/server/clickhouse/client.ts` — `Tracker` class lines 250-652. Used by tRPC controllers via `ctx.track.xxx(...)` (instantiated in `createContext.ts:39` as `new Tracker(req, res)`). Each public method writes to its own CH table and auto-injects actor metadata (userId, IP, userAgent, fingerprint).

For Retool endpoints (raw `NextApiHandler`, not tRPC), the wrapper instantiates `new Tracker(req, res)` itself before dispatching.

New tracker method:

```ts
// src/server/clickhouse/client.ts — add to Tracker class
public retoolAudit(values: {
  action: string;          // e.g. "user.clearProfile"
  privileged: boolean;
  outcome: 'ok' | 'error';
  errorMsg?: string;
  payload: Record<string, unknown>;   // sanitized input
  affected?: Record<string, unknown>; // { userIds: [...], commentIds: [...], ... }
}) {
  return this.track('retoolAuditLog', values);
}
```

ClickHouse table (auto-created on first insert, but we'll codify the DDL in the migrations dir for visibility):

```sql
CREATE TABLE IF NOT EXISTS default.retoolAuditLog (
  createdAt    DateTime DEFAULT now(),
  userId       Int32,           -- auto-injected by Tracker
  ip           String,           -- auto-injected
  userAgent    String,           -- auto-injected
  fingerprint  String,           -- auto-injected
  action       String,
  privileged   UInt8,
  outcome      Enum('ok' = 1, 'error' = 2),
  errorMsg     Nullable(String),
  payload      String,           -- JSON-encoded
  affected     Nullable(String)  -- JSON-encoded
)
ENGINE = MergeTree
ORDER BY (createdAt, action, userId);
```

Wrapper emit (inside `defineRetoolEndpoint`):

```ts
const tracker = new Tracker(req, res);
try {
  const result = await action.handler(input, { actor, tracker });
  await tracker.retoolAudit({
    action: `${domain}.${input.action}`,
    privileged: action.privileged ?? false,
    outcome: 'ok',
    payload: sanitize(input),
    affected: pickAffectedIds(result),
  });
  return res.status(200).json(result);
} catch (e) {
  await tracker.retoolAudit({ action: ..., outcome: 'error', errorMsg: String(e), payload: sanitize(input) });
  throw e;
}
```

For Group 12 specifically: continue writing `ModActivity` row too (existing consumers may read it). Add `RetoolAuditLog` row alongside.

### Service layer rule

**No raw `dbWrite.x.update()` in endpoint handlers.** Every action delegates to a service function in `src/server/services/*.service.ts`. If the right service function doesn't exist, add one. This is the whole point — central business rules.

---

## File layout

```
src/pages/api/mod/retool/
├── user.ts          # Groups 1, 6, 7, 8
├── comment.ts       # Groups 3, 4
├── review.ts        # Group 5
├── cosmetic.ts      # Groups 9, 10
├── image.ts         # Groups 11, 12  (extends existing set-image-nsfw-level.ts logic)
├── model.ts         # Group 13
└── homeblock.ts     # Group 14
```

Group 2 (UserLink cleanup) is **not a new endpoint** — fold into the existing ban pipeline (`src/pages/api/mod/ban-user.ts` + underlying service).

---

## Per-domain action specs

### `user.ts` — Groups 1, 6, 7, 8

| Action | Privileged | Bulk? | Input |
|---|---|---|---|
| `clearProfile` | no | no | `{ userId, fields?: ('location'\|'bio'\|'message')[] }` defaults all |
| `mute` | no | no | `{ userId, until?: ISO, reason? }` — call existing mod-actions service |
| `unmute` | no | no | `{ userId }` |
| `updateIdentity` | **yes** | no | `{ userId, username?, email?, name? }` — enforce uniqueness in service, send change notification |
| `toggleModerator` | **yes** | no | `{ userId, isModerator: bool }` — extra check: actor must be in super-admin allowlist (env `granted-permission keys (`retoolUpdateIdentity`, `retoolToggleModerator`)`) |

@dev: — For Group 7, you said SARA uses this. Confirm: should `actorId` carry SARA's bot user ID, or do we add a `behalfOf` field for the human moderator SARA is acting on behalf of? Lean toward `behalfOf` so audit trail shows the human who asked.
@justin: There's always a person that drives SARA. She'd be using their user API key.

@ai:* Got it. Dropping `behalfOf` — `actorId` resolves naturally from the human's API key. Will note this in the auth section: privileged actions accept the actor either via session **or** a user API key (whichever pathway SARA / Retool / on-site UI uses), and the wrapper resolves to a single `actorId` for the audit row.

### `comment.ts` — Groups 3, 4

| Action | Privileged | Bulk? | Input |
|---|---|---|---|
| `bulkDelete` | no | **yes** | `{ commentIds?: number[], commentV2Ids?: number[] }` — at least one required |
| `removeAsTos` | no | **yes** | `{ commentIds?: number[], commentV2Ids?: number[] }` — soft-hide, retains row for evidence |

@dev: — Group 4 description says SQL body wasn't in source list. Need to find the exact "Remove as TOS Violation" behavior. Best guess: sets a flag (e.g. `tosViolation: true`) + hides from public views. Will dig into existing report-action code first.
@justin: Yeah. Send a sub agent to dig.

@ai:* Findings:

**Comment (legacy) — implemented.** `setTosViolationHandler` at `src/server/controllers/comment.controller.ts:307-355`. Flow per comment:
1. `UPDATE Comment SET tosViolation = true WHERE id = ?` via `updateCommentById` (comment.service.ts:197-211)
2. `updateCommentReportStatusByReason(id, TOSViolation, Actioned)` (comment.service.ts:213-230) — flips reports to Actioned
3. Fires `reportAcceptedReward` for each reporter
4. Sends `'tos-violation'` notification to comment owner
5. ModActivity tracked implicitly via reward system

Comment stays in DB; hidden from public views via `where: { tosViolation: false }` filter.

**CommentV2 — column exists, no endpoint.** `tosViolation` column on CommentV2; no handler in `commentv2.router.ts`. Reports reference it for display only.

**`removeAsTos` action implementation:**
- Bulk over `{ commentIds?: number[], commentV2Ids?: number[] }`
- For each: mirror the legacy flow (flag + reports → Actioned + reward + notification)
- Build a new `setCommentV2TosViolation` service that mirrors the legacy one for CommentV2 — Phase 1 deliverable (added to checklist below)
- Single handler: iterate each list, call the variant-appropriate service, collect affected IDs for the audit row

No search index update needed (filter-based hiding, not deletion).

### `review.ts` — Group 5

| Action | Privileged | Bulk? | Input |
|---|---|---|---|
| `setExclude` | no | **yes** | `{ reviewIds: number[], exclude: bool }` |
| `delete` | no | **yes** | `{ reviewIds: number[] }` |

### `cosmetic.ts` — Groups 9, 10

| Action | Privileged | Bulk? | Input |
|---|---|---|---|
| `assignByTarget` | no | **yes** | `{ cosmeticId, target: { type: 'collection', collectionId, requireApproved?: bool } \| { type: 'userIds', userIds: number[] }, dryRun?: bool }` |
| `unassign` | no | **yes** | `{ cosmeticId, userIds: number[] }` |
| `createCosmetic` | no | no | full Cosmetic shape |
| `updateCosmetic` | no | no | `{ cosmeticId, ...partial }` |
| `deleteCosmetic` | no | no | `{ cosmeticId }` |

`assignByTarget` with `target.type === 'collection'` is the contest flow — gives the cosmetic to every user whose `CollectionItem` in that collection is `Approved` (controlled by `requireApproved`, default true). `dryRun` returns the user list without inserting. Extensible: future target types (e.g. `'modelOwners'`, `'eventParticipants'`) drop in as new discriminated union variants.

### `image.ts` — Groups 11, 12

| Action | Privileged | Bulk? | Input |
|---|---|---|---|
| `tagVote` | no | **yes** | `{ votes: { imageId, tagId, vote: 1\|-1\|0 }[] }` |
| `setNsfwLevel` | no | **yes** | `{ items: { imageId, nsfwLevel }[] }` — composite write in single tx per item: Image update + ModActivity upsert + research_ratings upsert |

Extends/replaces existing `src/pages/api/mod/set-image-nsfw-level.ts`. Confirm `research_ratings` is still consumed (per subtask 12 note) before keeping that insert.
@justin: No, I think research_rating is deprecated now. It was part of a game that was replaced by knights of new order game.

@ai: Dropping the `research_ratings` insert. New composite write per image: `UPDATE Image` + `INSERT/UPDATE ModActivity`. Will quick-grep `research_ratings` references during implementation to confirm zero readers; if any remain, flag back rather than silently dropping.

### `model.ts` — Group 13

| Action | Privileged | Bulk? | Input |
|---|---|---|---|
| `bump` | no | no | `{ modelId }` — sets `lastVersionAt = NOW()` |

@dev: — Should this also reset any "stale" cache? Worth checking what flipping `lastVersionAt` invalidates today.
@justin: Yeah, should likely bust a few caches... You'll Need to dig into that.

@ai:* Concrete invalidation list for the `bump` handler:

```ts
// after the UPDATE Model SET lastVersionAt = NOW()
await dataForModelsCache.refresh([modelId]);                                 // src/server/redis/caches.ts:425
await modelsSearchIndex.queueUpdate([{ id: modelId, action: 'Update' }]);    // Meili sortable lastVersionAtUnix
await userModelCountCache.refresh(model.userId);                             // src/server/redis/caches.ts:520
```

Notes:
- Full `bustMvCache(modelVersionIds, modelIds)` (model-version.service.ts:1702) is the heavier path used when a version is published. For a pure `lastVersionAt` bump we don't need image/access/orchestrator busts — only feed sort + search index + user model count.
- `lastVersionAtUnix` is a Meilisearch sortable attribute → feed ordering depends on the index update firing.
- Webhook `updated-model` filters `lastVersionAt > lastSent` (model.webhooks.ts:93) — bumping correctly re-fires subscriber webhooks. Desired? Confirm: do we want to spam external webhook subscribers every time a mod bumps a model, or should bump bypass the webhook fan-out?

@dev:* Should bump trigger the external `updated-model` webhook fan-out, or suppress it?
@justin: Skip it. The bump is likely just a maintenance thing, not an actual notifiable event.

@ai: Suppression strategy — webhook job (`model.webhooks.ts:93`) compares `lastVersionAt > lastSent` and fires per qualifying row. Two viable paths:

**A. Update `lastSent` alongside `lastVersionAt`** (simplest)
```ts
// inside bump handler
const now = new Date();
await dbWrite.model.update({
  where: { id: modelId },
  data: { lastVersionAt: now, /* webhook tracking col */: now },
});
```
Pro: zero schema change. Con: piggybacks on webhook internals — if webhook job is later rewritten, bump must be revisited.

**B. Add a `bumpedAt` column; feeds sort by `GREATEST(lastVersionAt, bumpedAt)`** (cleanest, larger)
Pro: bump is now first-class, webhook untouched. Con: migration + feed query changes (Meili sortable attribute may need re-derived field too).

Going with **A** for Phase 1. Need to grep the exact `lastSent`-equivalent column name during impl (will confirm before writing). Recording as an impl detail rather than a blocker.

### `homeblock.ts` — Group 14

| Action | Privileged | Bulk? | Input |
|---|---|---|---|
| `create` | no | no | full HomeBlock shape |
| `update` | no | no | `{ homeBlockId, ...partial }` |
| `delete` | no | no | `{ homeBlockId }` |
| `reorder` | no | **yes** | `{ orderedIds: number[] }` |

Backend ships in Phase 1. **On-site HomeBlock Manager UI is Phase 4** (separate ticket; this endpoint is its backend).

---

## Rollout phases

### Phase 1 — Single big PR (this plan)

1. ClickHouse: `default.retoolAuditLog` table + `Tracker.retoolAudit()` method in `src/server/clickhouse/client.ts`
2. Env vars: `granted-permission keys (`retoolUpdateIdentity`, `retoolToggleModerator`)` (allowlist for privileged actions)
3. `defineRetoolEndpoint` helper in `src/server/utils/retool-endpoint.ts` (registry pattern)
4. Seven endpoint files in `src/pages/api/mod/retool/`
5. New / extended service functions:
   - `setCommentV2TosViolation` (mirror legacy comment version, Group 4)
   - Bump-action cache fan-out helper (Group 13)
   - `assignCosmeticByTarget` (collection-driven, Group 9)
   - Any others surfaced during implementation
6. Fold Group 2 (UserLink cleanup) into ban pipeline
7. Unit/integration tests per action — at minimum the privileged ones
8. Doc page: `docs/features/retool-api.md` with curl examples for each action

### Phase 2 — Retool migration (parallel, per-group)

For each group, swap the SQL block in Retool to an HTTP request node pointed at the new endpoint. One group at a time, verify with mods after each swap. Safe rollback: old SQL stays as a disabled query node until Phase 3.

### Phase 3 — Kill old SQL in Retool

Delete the disabled SQL nodes ~1 week after each group's Phase 2 swap is green.

### Phase 4 — On-site UIs

Separate ticket(s):
- **HomeBlock Manager** — editorial drag-reorder UI on `/moderator/home-blocks`
- **Cosmetic Manager** — catalog CRUD + contest assignment wizard on `/moderator/cosmetics`

Both consume the Phase 1 endpoints.

---

## Open items for Justin

All resolved (see inline `@ai:*` replies):
- ~~Audit storage~~ — ClickHouse via Tracker, sketch in Architecture section.
- ~~Group 4 TOS removal semantics~~ — legacy flow mapped, CommentV2 service to be added.
- ~~Group 7 `behalfOf`~~ — dropped, API key resolves to human actor.
- ~~Group 12 `research_ratings`~~ — deprecated, dropping insert.
- ~~Group 13 cache invalidation~~ — concrete 3-call list mapped.
- ~~Group 13 webhook fan-out~~ — suppress via co-updating webhook tracking column (option A).

**Plan is ready for Phase 1 kickoff on sign-off.**

---

## Out of scope

- Migration of Retool **read** queries (separate concern; reads have far lower blast radius)
- Replacing Retool entirely
- Building generic "Retool-callable tRPC bridge" (over-engineered for 14 actions)
