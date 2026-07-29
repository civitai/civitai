# Entity Change / Audit Tracking (ClickHouse) — Implementation Plan

ClickUp: [868kgwhec](https://app.clickup.com/t/868kgwhec)

Phase 1 scope: Model + ModelVersion settings changes, ModelFile hash tracking, and a
moderator read surface. Built to extend to any entity (Article, Post, User, Collection)
without schema or infrastructure changes.

## Decisions locked (2026-07-28, Luis)

| Question                | Decision                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| First deliverable scope | Tracker + service hooks **and** ModelFile hash events **and** read query + Retool mod action |
| Description diffs       | Full old/new text (with a payload-safety cap, see below)                                     |
| Retention               | No TTL (like `retoolAuditLog`) — disputes need old evidence                                  |
| System mutations        | Logged (`actorRole='system'`) — profanity auto-NSFW, `DisablePayout` auto-flag, etc.         |

Still open (flagged in [Open questions](#open-questions)): creator visibility of
moderator identity, tracker-service registration owner/lead time.

## Architecture

```
service mutation (upsertModel / upsertModelVersion / updateModelVersionPaidAccess / file scan)
  └─ diffEntityChanges(before, after, registry)        ← pure, in-memory, unit-tested
       └─ ctx.track.entityChanges(rows)                ← ONE batched insert per save (trackMany)
            └─ clickhouse.insert (async_insert, server-buffered)
                 └─ default.entityChangeEvents

reads:
  Retool mod action `audit.changeHistory` ──┐
  (later) creator-facing tRPC procedure ────┴─ clickhouse.$query, prefix scan on (entityType, entityId)
```

No new infrastructure: the `Tracker` (`src/server/clickhouse/tracker.ts:164`) already
provides actor stamping (userId/ip/userAgent) and provenance (`via: 'web' | 'api-key' |
'oauth'`, `tracker.ts:182`). **Implementation note (discovered during build):**
`Tracker.trackMany` → `sendMany` inserts **directly into ClickHouse** via
`clickhouse.insert()` (with `async_insert` server-side buffering) — it does not go
through the tracker-service `/track/<table>` route at all. So the only external
dependency is applying the DDL below (plus INSERT grants for the app's CH user); no
tracker-service route registration is needed.

## ClickHouse schema

One row **per changed field**, not per save. Rows from one save share a `batchId`.

```sql
CREATE TABLE IF NOT EXISTS default.entityChangeEvents (
  createdAt    DateTime64(3) DEFAULT now64(3),
  userId       Int32,                    -- actor; Tracker auto-injects
  ip           String,
  userAgent    String,
  entityType   LowCardinality(String),   -- 'Model' | 'ModelVersion' | 'ModelFile' | future entities
  entityId     Int64,
  ownerId      Int32,                    -- entity owner at change time; powers creator view without a join
  field        LowCardinality(String),   -- 'allowCommercialUse', 'monetization.unitAmount', 'hash.SHA256'
  oldValue     String CODEC(ZSTD(3)),    -- JSON-encoded; '' = unset
  newValue     String CODEC(ZSTD(3)),
  truncated    UInt8 DEFAULT 0,          -- 1 when a value exceeded the payload cap
  actorRole    LowCardinality(String),   -- 'owner' | 'moderator' | 'system'
  via          LowCardinality(String),   -- 'web' | 'api-key' | 'oauth' (Tracker provenance)
  reason       String,                   -- optional free text (mod actions, automated rules)
  batchId      String                    -- UUID shared by all rows from one save
) ENGINE = MergeTree
PARTITION BY toYYYYMM(createdAt)
ORDER BY (entityType, entityId, createdAt);
```

### Why this scales

- **Reads are prefix scans.** Both planned surfaces ("history for model X",
  "history for version Y") hit the `ORDER BY (entityType, entityId, createdAt)` primary
  key directly — cost is proportional to that entity's history, not table size. Grouping
  a save is `GROUP BY batchId` _within_ an already-pruned entity slice, never globally.
- **Write volume is trivial.** Measured 2026-07-28: `modelEvents` shows ~9K `Update` +
  ~19K `Create` per week. Even assuming 10 changed fields per save, that's ~20K
  rows/day (~7M/year) — `modelVersionEvents` ingests 6.2M `Download` rows _per week_
  into the same cluster. Adding every other entity type later stays within the same
  order of magnitude because these are human-initiated settings edits.
- **Row width is bounded by policy, not hope.** Full description HTML is stored
  (decision above), compressed with `ZSTD(3)` (HTML compresses ~10:1). A hard cap
  (64KB per value) protects the tracker→NATS payload limit; oversized values are
  truncated and flagged `truncated=1`. Every other watched field is a scalar or a small
  JSON object.
- **New entities are config, not migrations.** `entityType` is `LowCardinality(String)`
  and `field` uses dotted paths — Article/Post/User onboarding adds a registry entry and
  a hook call in the app. Zero DDL, zero tracker-service changes (same table/route).
- **No TTL** (locked decision). At ~7M rows/year, ZSTD-compressed, storage is not a
  concern on this cluster; monthly partitions keep any future retention decision a
  cheap `DROP PARTITION` away.
- **Future-proofing noted, not built:** if "all changes by moderator X" (cross-entity,
  by `userId`) ever becomes a hot mod query, add a bloom-filter skip index on `userId`.
  Deliberately not part of Phase 1.

`actorRole` note: `'api'` from the scouting draft is dropped — `via` already carries
that (Tracker provenance), so `actorRole` stays purely about _who_ (owner vs moderator
vs system), and `via` about _how_.

## App-side design

> **2026-07-29 — PaidAccess refactor rebase.** Upstream replaced the ModelVersion
> `earlyAccessConfig` JSON column with a native `PaidAccess` row written through
> `writePaidAccessForModelVersion` (both service paths funnel through
> `writeModelVersionGateAndGoal`). The hooks were re-applied on top: the watched field
> is now `paidAccess`, diffed as a normalized `{ permanent, timeframeDays, terms }`
> shape (`null` = no gate, mirroring the write's clear-on-ungated semantics; `endsAt`
> excluded — it's materialized at publish, not a settings change). Before-state comes
> from a direct `PaidAccess` row read, gated on `tracker` presence. `donationGoal` is
> deliberately not watched: `ensureDonationGoal` is create-once (never replaced), so
> there is no "change" to log.


### 1. Watched-field registry — `src/server/common/entity-change.constants.ts`

Single source of truth so coverage is testable and extending is additive:

```ts
export const watchedEntityFields = {
  Model: [
    'allowNoCredit',
    'allowCommercialUse',
    'allowDerivatives',
    'allowDifferentLicense',
    'description',
    'nsfw',
    'poi',
    'minor',
    'sfwOnly',
    'availability',
    'mode',
    'lockedProperties',
    'name',
  ],
  ModelVersion: [
    'description',
    'status',
    'baseModel',
    'paidAccess',
    'monetization',
    'usageControl',
    'flags',
    'trainedWords',
    'licensingFee',
  ],
  ModelFile: ['hash.SHA256'],
} as const;
```

Notes:

- `nsfwLevel` is intentionally **excluded**: it's recomputed by ingestion/jobs on
  unrelated triggers and would flood the log with rows nobody asked for. `nsfw` (the
  user/mod-set flag) is watched.
- JSON-object fields (`paidAccess`, `monetization`) are diffed **per leaf**,
  emitting dotted-path rows (`paidAccess.timeframeDays`, `paidAccess.terms`,
  `monetization.unitAmount`). Nested diffing lives in the helper, so the registry stays
  a flat field list.

### 2. Diff helper — `src/server/utils/entity-change-helpers.ts`

```ts
export function diffEntityChanges(args: {
  entityType: WatchedEntityType;
  entityId: number;
  ownerId: number;
  before: Record<string, unknown> | null; // null = creation; emits nothing in Phase 1
  after: Record<string, unknown>;
  actorRole: 'owner' | 'moderator' | 'system';
  reason?: string;
}): EntityChangeRow[];
```

Pure and synchronous. Rules:

- Only fields present in `after` are considered (partial updates don't emit "unset" rows).
- Values are JSON-stringified with **sorted object keys** so semantically-equal objects
  never produce false-positive rows.
- Arrays compare order-insensitively where order is meaningless (`lockedProperties`,
  `trainedWords`).
- 64KB per-value cap → truncate + `truncated: 1`.
- Returns `[]` when nothing changed — callers can call it unconditionally.
- One `batchId` (`crypto.randomUUID()`) per invocation.

### 3. Tracker method — `src/server/clickhouse/tracker.ts`

```ts
public entityChanges(rows: EntityChangeRow[]) {
  if (!rows.length) return;
  return this.trackMany('entityChangeEvents', rows.map((r) => ({ ...r, via: this.provenance.via })));
}
```

Uses the existing `trackMany`/`sendMany` (`tracker.ts:346`) — **one HTTP POST per save**
regardless of how many fields changed. Actor (userId/ip/userAgent) is auto-stamped like
every other event. Fire-and-forget: can never fail or slow a mutation.

### 4. Flag gate

Emission is wrapped in a Flipt flag check (`entity-change-tracking`) so the app can
deploy before the tracker service registers the route (an unregistered table 4xxes and
logs warnings to Axiom on every save — harmless but noisy). Flip on after registration.

## Hook points (verified against current code)

Service layer, not controllers — services hold the before-row and are the funnel for
multiple callers.

| #   | Hook                                                                                               | Before-row                                                                                               | Marginal cost                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `upsertModel` update branch — `model.service.ts:2142`                                              | **Already reads `beforeUpdate`** (`:2165`) with name/description/poi/minor/sfwOnly/nsfw/lockedProperties | Widen select with `allowNoCredit`, `allowCommercialUse`, `allowDerivatives`, `allowDifferentLicense`, `availability`, `mode`; diff `data` against it around the `dbWrite.model.update`                                                                                                                                                                                         |
| 2   | `upsertModelVersion` update branch — `model-version.service.ts` (`existingVersion` read) | Already reads status/description/monetization; paid-access before-state read from the `PaidAccess` row                                          | Widen select with `usageControl`, `flags`, `baseModel`, `trainedWords`, model `userId` (for `ownerId`)                                                                                                                                                                                                                                                                         |
| 3   | `updateModelVersionPaidAccess` — `model-version.service.ts` | Paid-access before-state read from the `PaidAccess` row | Diff only `paidAccess.*`. Easy to miss — Creator Studio edits the gate here, bypassing `upsertModelVersion` entirely                                                                                                                                                                                                                                                |
| 4   | `applyScanOutcome` — `model-file-scan.service.ts` (hash write)                                     | **Already captures `existingHashes`** (incl. SHA256) before the delete+create                            | Emit `entityType='ModelFile'`, `field='hash.SHA256'` when the scanner persists a SHA256 that differs (first scan: `''` → hash). Chosen over the controller track points because hashes don't exist yet at upload time — the scanner produces them. "Did the file change after upload" becomes `countDistinct(newValue) > 1`. Always `actorRole='system'`, `reason='file-scan'` |

System rows (locked: **yes, log them**), emitted from the same hooks:

- Profanity auto-NSFW (`model.service.ts:2193-2208`): when the filter flips `data.nsfw`,
  the field row is emitted with `actorRole='system'`, `reason='profanity-filter'` —
  attribution is decided _per row_, not per save, since one save can mix owner-initiated
  and system-initiated changes.
- `DisablePayout` auto-flag (`model-version.service.ts:397`): `actorRole='system'`,
  `reason='licensing-fee-disable-payout'` on the `flags` row when `flagsOverride` added it.

Actor role resolution: `isModerator && actorUserId !== ownerId` → `'moderator'`;
otherwise `'owner'`; system-attributed rows override to `'system'` as above. Controllers
already thread `isModerator` into these services; the tracker rides tRPC `ctx.track`, so
hooks receive an optional `tracker` (or emit-callback) argument — absent in job/script
callers, which simply don't emit in Phase 1.

### Known gap (explicit): `updateModelById` — `model.service.ts:1578`

Raw `Prisma.ModelUpdateInput` passthrough, no before-read, many callers (takedowns,
jobs, mod tooling). Phase 1 does **not** hook it: it has no actor context and hooking it
means threading a tracker through every caller. This is where mod takedowns (`mode`)
flow, so it's the most valuable follow-up — tracked as its own line item in the
breakdown, not silently dropped. Until then the log is explicitly **best-effort**: the
fire-and-forget tracker (3 retries, then Axiom log) already makes it non-legal-grade.

## Read path

### Phase 1: Retool mod action

New domain file `src/pages/api/mod/retool/audit.ts` using the existing
`defineRetoolEndpoint` registry (auth + rate limit + its own audit trail for free):

```ts
changeHistory: retoolAction({
  input: z.object({
    entityType: z.enum(['Model', 'ModelVersion', 'ModelFile']),
    entityId: z.number(),
    limit: z.number().max(500).default(100),
    cursor: z.string().datetime().optional(),   // createdAt keyset pagination
  }),
  handler: ... // clickhouse.$query — WHERE entityType = {..} AND entityId = {..}
               // ORDER BY createdAt DESC LIMIT {..}; prefix scan by construction
})
```

Full history including `moderator`/`system` rows. Keyset pagination on `createdAt`
(never OFFSET) keeps deep history cheap.

### Later (own ticket): creator-facing UI

tRPC procedure filtered to the caller's own entities
(`entityId IN (model + its version ids)`, grouped by `batchId`), rendered as a
"Change history" drawer on the model edit page. The schema requires no changes for
this — `ownerId` is already denormalized onto every row. Whether creators see the
moderator's identity vs "Civitai staff" is an open question below (affects only the
tRPC select, not the schema).

## Testing

- **Unit: diff helper** — `src/server/utils/__tests__/entity-change-helpers.test.ts`
  (never under `src/pages`): scalar/JSON-leaf/array diffs, key-order stability, cap +
  `truncated` flag, creation no-op, batchId sharing, per-row system attribution.
- **Coverage guard** — originally planned as a CI test asserting every watched field is
  producible by a hooked path; dropped as impractical to assert honestly (the registry
  deliberately contains fields whose only mutation path isn't hooked yet, e.g. `mode`
  via `updateModelById`). Mitigation instead: the registry and hooks live in few files,
  and the known-unhooked paths are documented here.
- **Integration (manual)**: flag on in dev → edit a model's license settings →
  assert rows via the clickhouse-query skill.

## Rollout

1. **Apply the DDL** (above) to the ClickHouse cluster + ensure the app's CH user has
   INSERT on `entityChangeEvents`. (No tracker-service work — see Architecture note:
   emission is a direct `clickhouse.insert`.)
2. Deploy app; the `entity-change-tracking` Flipt flag doesn't exist yet, so emission
   is off by default (missing flag → static-fallback false).
3. Create + enable the flag in dev/preview, verify rows + row-size distribution
   (`SELECT quantiles(0.5, 0.99)(length(newValue)) ...`).
4. Enable in prod. No backfill — the log starts at enablement, by design.

## Task breakdown

| #   | Task                                                                        | Est.             |
| --- | --------------------------------------------------------------------------- | ---------------- |
| 1   | CH DDL handoff + tracker-service route registration (external coordination) | 0.5d + lead time |
| 2   | Registry + `diffEntityChanges` + unit tests                                 | 0.5d             |
| 3   | `Tracker.entityChanges` (+ flag gate)                                       | 0.25d            |
| 4   | Hooks 1–3 (model + version + EA config) incl. system-row attribution        | 1d               |
| 5   | Hook 4 (ModelFile hashes)                                                   | 0.5d             |
| 6   | Retool `audit.changeHistory` action                                         | 0.5d             |
| 7   | Follow-up ticket: `updateModelById` coverage                                | —                |
| 8   | Follow-up ticket: creator-facing change-history UI                          | —                |

Items 2–6 are one PR (cohesive, ~flag-gated); split 5/6 out if review size becomes a
problem.

## Open questions

@ai:\* Do creators (in the eventual creator-facing view) see the moderator's identity on
moderator-made changes, or just "Civitai staff"? Doesn't block Phase 1 — affects only
the future tRPC select.

@ai:\* ~~Who owns tracker-service table registration?~~ Resolved during implementation:
`trackMany` inserts directly into ClickHouse, so the only external step is applying the
DDL (rollout step 1). Who runs DDL against the CH cluster — you, or DevOps?

@ai:\* `reason` for moderator edits: Phase 1 emits it only for system rows. Do we want a
required "reason" input on mod-initiated settings changes (bigger UX change), or leave
it empty for now? Plan assumes: leave empty.
