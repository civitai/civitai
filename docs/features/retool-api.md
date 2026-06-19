# Retool API (mod-callable HTTP endpoints)

These endpoints replace direct Retool → Postgres writes for moderator workflows. Every action runs a typed handler, validates input with Zod, applies a per-action rate limit, and emits a ClickHouse audit event before responding.

## When to use this

You're building a Retool workflow (or any external automation) that needs to perform a mod action against Civitai data. Pick the existing action that matches the job. **Do not write a new raw SQL query in Retool** — if no action fits, add a new one to the registry instead.

## Auth

`Authorization: Bearer <USER_API_KEY>` — the key must belong to a user with `isModerator: true`.

Privileged actions additionally require the matching `granted` permission in `user.permissions`. Each privileged action names the permission key it needs (declared on the action's `privileged` field, which maps to a `granted`-availability flag in `feature-flags.service.ts`). Today:

| Action | Permission key |
|---|---|
| `user.updateIdentity` | `retoolUpdateIdentity` |
| `user.toggleModerator` | `retoolToggleModerator` |

Grant these through the normal feature-flag grant flow (the same one that backs `paddleAdjustments`, `announcements`, `blocklists`, etc.).

## Request shape

```
POST /api/mod/retool/<domain>
Content-Type: application/json

{ "action": "<actionName>", ...params }
```

Params are validated by the action's Zod schema. Validation errors return `400` with the Zod issues.

## Responses

```
200 OK   → { ...handler return value }
400      → { error, issues: [...] } (schema mismatch)
401      → { error: 'Missing or malformed Bearer token' | 'Invalid API key' }
403      → { error: 'Moderator role required' | 'Permission "<key>" required for this action' }
405      → { error: 'Method not allowed' }
429      → { error: 'Rate limit exceeded', retryAfterSeconds, limit, windowSeconds }
500      → { error: 'An unexpected error occurred', message }
```

## Domains

| File | Domain | Actions |
|------|--------|---------|
| `src/pages/api/mod/retool/user.ts` | `user` | `clearProfile`, `mute`, `unmute`, `updateIdentity` (privileged), `toggleModerator` (privileged) |
| `src/pages/api/mod/retool/comment.ts` | `comment` | `bulkDelete`, `removeAsTos` |
| `src/pages/api/mod/retool/review.ts` | `review` | `setExclude`, `delete` |
| `src/pages/api/mod/retool/cosmetic.ts` | `cosmetic` | `assignByTarget`, `unassign`, `createCosmetic`, `updateCosmetic`, `deleteCosmetic` |
| `src/pages/api/mod/retool/image.ts` | `image` | `tagVote`, `setNsfwLevel` |
| `src/pages/api/mod/retool/model.ts` | `model` | `bump` |
| `src/pages/api/mod/retool/homeblock.ts` | `homeblock` | `create`, `update`, `delete`, `reorder` |
| `src/pages/api/mod/retool/strike.ts` | `strike` | `create`, `void`, `getUserStrikes` |

Read the source file for the authoritative schema of each action — every file leads with a doc comment that lists actions + params.

## Examples

```bash
# Push a model to the top of the Newest feed
curl -X POST https://civitai.com/api/mod/retool/model \
  -H "Authorization: Bearer $CIVITAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "action": "bump", "modelId": 123456 }'

# Bulk-delete a spam ring
curl -X POST https://civitai.com/api/mod/retool/comment \
  -H "Authorization: Bearer $CIVITAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "action": "bulkDelete", "commentIds": [1,2,3], "commentV2Ids": [10,11] }'

# Issue a manual strike on a user
curl -X POST https://civitai.com/api/mod/retool/strike \
  -H "Authorization: Bearer $CIVITAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "create",
    "userId": 999,
    "reason": "ManualModAction",
    "points": 1,
    "description": "Repeated ToS violations after warning"
  }'

# Privileged: rename a user (caller must hold the `retoolUpdateIdentity` granted permission)
curl -X POST https://civitai.com/api/mod/retool/user \
  -H "Authorization: Bearer $CIVITAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "action": "updateIdentity", "userId": 999, "username": "new-handle" }'

# Hand out a contest cosmetic to everyone with an approved entry
curl -X POST https://civitai.com/api/mod/retool/cosmetic \
  -H "Authorization: Bearer $CIVITAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "assignByTarget",
    "cosmeticId": 42,
    "target": { "type": "collection", "collectionId": 7890, "requireApproved": true }
  }'

# Dry-run the same thing to see who would receive it
curl -X POST https://civitai.com/api/mod/retool/cosmetic \
  -H "Authorization: Bearer $CIVITAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "assignByTarget",
    "cosmeticId": 42,
    "target": { "type": "collection", "collectionId": 7890 },
    "dryRun": true
  }'
```

## Audit log

Every call (success or error) emits one row to ClickHouse table `default.retoolAuditLog` via the `Tracker.retoolAudit()` method (`src/server/clickhouse/client.ts`).

Schema (auto-created on first insert; here for reference):

```sql
CREATE TABLE IF NOT EXISTS default.retoolAuditLog (
  createdAt    DateTime DEFAULT now(),
  userId       Int32,            -- the moderator's user id (Tracker auto-injects)
  ip           String,
  userAgent    String,
  fingerprint  String,
  action       String,           -- e.g. 'user.toggleModerator'
  privileged   UInt8,
  outcome      Enum('ok' = 1, 'error' = 2),
  errorMsg     Nullable(String),
  payload      String,           -- JSON-encoded input (action key stripped)
  affected     Nullable(String)  -- JSON-encoded { userIds: [...], etc. }
) ENGINE = MergeTree
  ORDER BY (createdAt, action, userId);
```

Handlers populate `affected` by returning `{ affected: { userIds: [...], commentIds: [...], etc. } }` alongside the response payload — the wrapper splits these out before serializing the row.

## Adding a new action

Pick the right domain file (or create one). Then add an entry:

```ts
// src/pages/api/mod/retool/<domain>.ts
import { defineRetoolEndpoint, retoolAction } from '~/server/utils/retool-endpoint';

export default defineRetoolEndpoint('<domain>', {
  myNewAction: retoolAction({
    input: z.object({ /* ... */ }),
    rateLimit: { max: 30, windowSeconds: 60 }, // optional, defaults to 60/60
    privileged: 'retoolMyAction',              // optional permission key (add to feature-flags.service.ts as ['granted'])
    async handler(input, ctx) {
      // ctx: { actor, tracker, req, res }
      const result = await someService(input);
      return {
        ...result,
        affected: { /* IDs the audit row should capture */ },
      };
    },
  }),
});
```

Conventions:
1. The handler MUST call a service function — never `dbWrite.x.update` directly. If the service doesn't exist, add one.
2. Bulk-friendly actions cap their list size in the schema (`.max(500)` is the default).
3. For any action that grants role escalation, bypasses validation, or has a "very high" sensitivity rating in the parent ticket: pick a permission key (e.g. `retoolFooBar`), set `privileged: '<key>'` on the action, and add the matching flag to `feature-flags.service.ts` with `['granted']` availability. Grant the permission to the moderators who should be able to invoke it.
4. Return an `affected` object so the audit row captures the entities the call touched.

## Rate limits

Default: 60 requests / 60 seconds per `(action, actorId)`. Privileged actions use tighter limits (10–20 / minute). Override per action via the `rateLimit` field. Counters live in Redis under `retool-endpoint:rate-limit:<action>:<actorId>`.

## Out of scope

- Read queries from Retool — still go through Postgres directly. Reads have far lower blast radius and don't justify endpoint churn yet.
- Generic tRPC-from-Retool bridge — over-engineered for the current action set.
- On-site mod UIs for HomeBlock and Cosmetic management — backend ships in Phase 1 here; UIs follow in Phase 4 as separate tickets.
