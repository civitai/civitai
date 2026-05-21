# Wildcard Moderation Pipeline — Cleanup Plan

## Background

Wildcard sets are imported by `reconcileWildcardSets` (cron + admin endpoint), and every `WildcardSetCategory` is then audited by XGuard via the orchestrator. The audit is tracked in **two places**:

1. **`WildcardSetCategory`** — `auditStatus`, `auditedAt`, `auditRuleVersion`, `auditNote`, `nsfw`, plus `metadata.workflowId / retryCount / triggeredTerms / triggeredLabels`.
2. **`EntityModeration`** — `status`, `workflowId`, `retryCount`, `blocked`, `triggeredLabels`, `result`, `contentHash`. Keyed on `(entityType='WildcardSetCategory', entityId)`.

A parallel rollup exists on **`WildcardSet`** (`auditStatus`, `auditedAt`, `auditRuleVersion`, `nsfw`) recomputed by `recomputeWildcardSetAuditStatus`.

The two records can — and do — drift apart. This doc lays out (a) the inconsistencies we currently see in production, (b) the bug fixes needed to stop new drift from accumulating, and (c) a proposed schema simplification that removes the duplication at the root.

---

## Current state (snapshot)

Pulled `2026-05-19` from the read replica.

### EntityModeration × WildcardSetCategory cross-tab

| EM status | EM has workflowId | WSC auditStatus | count | interpretation |
| --- | --- | --- | --- | --- |
| Pending | yes | Pending | 2,345 | normal in-flight |
| Pending | yes | **Clean** | **261** | **inconsistency** |
| Pending | no | Pending | 218 | orchestrator submit failed silently |
| Pending | no | **Clean** | **25** | **inconsistency** |
| Succeeded | yes | Clean | 7,232 | normal terminal |
| Failed | yes | Pending | 10 | expected (queued for retry) |

### Pending EM rows with NULL workflowId — 244 total

| WSC auditStatus | WSC.metadata.workflowId | count | meaning |
| --- | --- | --- | --- |
| Pending | set | 134 | EM and WSC desynchronized — WSC has workflow id, EM doesn't |
| Pending | missing | 86 | classic stuck-at-submit: `createXGuardModerationRequest` returned null |
| Pending | (no metadata) | 1 | same as above |
| Clean | missing | 25 | stale-callback race — WSC was Cleaned, EM never got mirrored |

### Orphans — WSCs with no EntityModeration row at all: 449

All `Pending`, no metadata.workflowId, clustered in 4 sets:

| WildcardSetId | orphan categories |
| --- | --- |
| 329 | 303 |
| 326 | 85 |
| 301 | 59 |
| 287 | 1 |

These are sets whose import-time `submitWildcardSetAudit(setId)` fire-and-forget failed in bulk before any EM rows were created. The hourly `audit-wildcard-set-categories` cron should be a safety net but hasn't drained them yet (set 329 was imported the same day as the snapshot).

### Zero Dirty / Zero NSFW

There are currently **0** categories with `auditStatus='Dirty'` and **0** with `nsfw=true` across all 10,552 rows. Worth noting because it informs the Phase 2 schema question: in practice the audit is mostly a "did it complete" signal today.

---

## Root causes

### A. Silent orchestrator-submit failures

[`submitWildcardCategoryAudit`](../src/server/services/wildcard-category-audit.service.ts) calls `upsertEntityModerationPending(workflowId: null)` BEFORE calling `createXGuardModerationRequest`. If the orchestrator returns no workflow id, the function logs and returns `null` — the EM row stays at `status=Pending, workflowId=NULL` forever. The `retry-failed-text-moderation` cron does pick it up after 30 min and resubmits, but `retryCount` never increments on the Pending-timeout path (see C below), so there is no give-up cap.

### B. Reset-then-submit race window

The current order is: reset EM (workflowId=NULL) → submit orchestrator → stamp `WSC.metadata.workflowId` → stamp `EM.workflowId`. Between steps 1 and 4 a callback for the *previous* workflow can arrive:

1. `applyWildcardCategoryAuditSuccess` reads `WSC.metadata.workflowId` (still pointing at the old workflow), passes the stale-check, updates `WSC.auditStatus` to Clean, clears `WSC.metadata.workflowId`.
2. Calls `recordEntityModerationSuccess(workflowId=W_old)` which does `updateMany WHERE workflowId=W_old`. But EM.workflowId is NULL (step 1 of the new attempt just reset it). Zero rows updated; the return value is **not checked**.

Result: `WSC.auditStatus=Clean`, `EM.status=Pending` forever. This is the 286 (261 + 25) Clean+Pending inconsistencies.

### C. retry-failed-text-moderation does not gate or cap correctly

- It does not check `WSC.auditStatus` before re-auditing, so it keeps re-running orchestrator calls on already-Clean categories. Each re-audit reopens the race window in B.
- On the Pending-timeout branch (rows stuck Pending >30 min), `submitWildcardCategoryAudit` resets `retryCount` to 0 implicitly via `upsertEntityModerationPending`, so the 9-retry cap never triggers for Pending. Effectively infinite retry.

### D. Webhook handler does handle failures — but only if a callback arrives

[text-moderation-result.ts](../src/pages/api/webhooks/text-moderation-result.ts) correctly dispatches `failed`/`expired`/`canceled` workflow events to `applyWildcardCategoryAuditFailure`, which bumps `retryCount` and writes the terminal status to EM. The gap is workflows that fail silently (no callback). For those we rely solely on the retry cron, which has the issues in A and C.

### E. WSC.metadata.workflowId can outlive its purpose

When `applyWildcardCategoryAuditSuccess` runs, it clears `WSC.metadata.workflowId`. If the EM mirror update no-ops (B above), `WSC.metadata` ends up cleared while `EM.workflowId` still has a value — explaining the "EM has workflowId, WSC doesn't" rows.

---

## Phase 1 — bug fixes (keep current schema)

Order is from smallest/safest to largest. Each is independently mergeable.

### 1. Centralize EntityModeration bookkeeping inside `createXGuardModerationRequest`

This single change subsumes what were previously separate fixes for the silent-submit-failure stuck-Pending bug and the reset-then-submit race. The orchestrator helper already has everything it needs (`entityType`, `entityId`, `content`); today every caller redundantly threads the same values into `upsertEntityModerationPending` separately, and order-of-operations bugs slip in. Move the bookkeeping into the helper so callers can't get it wrong.

**New behavior inside `createXGuardModerationRequest`:**

1. Submit to the orchestrator FIRST (no EM mutation yet).
2. If `entityType && entityId !== undefined`, upsert the EM row in a single statement keyed on `(entityType, entityId)`:
    - **Success path** (workflow id returned): `status = Pending`, `workflowId = <new>`, `contentHash`, and reset `blocked / triggeredLabels / result` to null. `retryCount` is **not** touched on update — the existing value is preserved across resubmits. New rows get the default 0.
    - **Failure path** (no workflow id): `status = Failed`, `workflowId = NULL`, `retryCount = increment`. The existing `retry-failed-text-moderation` cron picks this up with backoff and respects the 9-retry cap.
3. If no entity is bound (ad-hoc generator-prompt scans), skip EM entirely — same as today.

**Why this fixes the race that produced 286 Clean+Pending rows:** the EM row never sits at `Pending + workflowId=NULL` while a previous workflow could still call back. The order is: orchestrator submit → EM upsert (with the new workflow id baked in, in one statement). A late callback for the previous workflow finds `EM.workflowId` already pointing at the NEW workflow, so `recordEntityModerationSuccess`'s `WHERE workflowId=W_old` predicate correctly drops it as stale.

**Why this fixes the 86 stuck Pending-no-workflowId rows:** the Failure branch writes a terminal status the retry job can act on, instead of leaving an ambiguous Pending row.

**Caller cleanup:** `submitWildcardCategoryAudit` and `submitTextModeration` stop calling `upsertEntityModerationPending` and stop calling `entityModeration.updateMany` to stamp the workflow id. They become a single call to `createXGuardModerationRequest`.

**Affected rows:** prevents new instances of both classes of inconsistency. Existing rows are addressed by fix #5 (backfill).

### 2. Drop `WSC.metadata.workflowId` (EntityModeration as the only source of truth)

With EM authoritative, the duplicate workflow id on WSC.metadata is redundant. Three concrete edits:

- Stop writing it in `submitWildcardCategoryAudit` (drop the `mergeCategoryMetadata({ workflowId })` call).
- Replace the WSC-side stale-check in `applyWildcardCategoryAuditSuccess` / `applyWildcardCategoryAuditFailure` (which read `meta.workflowId !== workflowId`) with a gate on `recordEntityModeration{Success,Failure}`'s return value. The `WHERE workflowId=X` predicate inside those functions is the canonical stale-callback gate.
- Drop the `workflowId` field from the `WildcardCategoryMetadata` type. `serializeMetadata` no longer emits it, so legacy values on existing rows get purged the next time the row is written.

Filters that previously gated on `metadata.workflowId` (in `submitWildcardSetAudit` and `submitPendingWildcardCategoryAudits`) now gate on EM-row absence via a `LEFT JOIN ... WHERE em.id IS NULL` orphan query.

### 3. Check return values and log on mismatch

In `applyWildcardCategoryAuditSuccess` / `applyWildcardCategoryAuditFailure`, the new return-value gate from fix #2 doubles as observability — when an update returns `false`, log a warning so we can dashboard stale-callback rate. No separate observability fix needed.

### 4. Cap Pending-timeout retries in the retry cron

In `text-moderation-retry.ts`'s Pending-timeout retry branch, increment `EM.retryCount` before resubmitting and respect `retryCount < 9` the same way Failed/Expired/Canceled rows do. Closes the infinite-retry loophole for stuck Pending rows. EM is the source of truth for retry state — no WSC involvement.

### 5. One-shot backfill for the existing 286 Clean+Pending inconsistencies

These rows pre-date the fixes and are the one case where WSC genuinely is the source of truth — the callback already ran successfully against WSC; only the EM mirror was lost to the pre-fix race. A one-time admin endpoint (`/api/testing/wildcard-em-backfill`) reads each `(WSC.auditStatus IN (Clean, Dirty), EM.status = Pending)` pair and writes EM to match: `Succeeded` + `blocked` derived from `WSC.auditStatus='Dirty'`, plus `triggeredLabels` / `result` reconstructed from `WSC.metadata.triggeredLabels` and `WSC.metadata.triggeredTerms` where available.

Explicitly a one-shot. After it runs, the only paths that touch EM moderation state are: `createXGuardModerationRequest` (submit), the webhook callback handlers (terminal), and `retry-failed-text-moderation` (retries). WSC is never read as a fallback truth source again.

### What about the 449 orphans (WSC with no EM row)?

Covered by `audit-wildcard-set-categories`, which we already have. Its filter was updated as part of fix #2 to gate on EM-row absence (`LEFT JOIN ... WHERE em.id IS NULL`) instead of `metadata.workflowId`. The cron's purpose is unchanged: find WSCs that never got submitted and submit them. After Phase 1, "never got submitted" is exactly "no EM row exists."

### Ongoing retry job for "entities that haven't had a successful moderation"

`retry-failed-text-moderation` is the canonical job. After fix #4 it:

- Picks up `Failed`/`Expired`/`Canceled` rows after the 60-min backoff, capped at `retryCount < 9`.
- Picks up `Pending` rows whose callback never arrived (>30 min stale), capped at `retryCount < 9` via the new pre-increment.
- Resubmits via the per-entityType dispatch (`submitWildcardCategoryAudit` for wildcards, `submitTextModeration` for articles).

It owns the EM-side retry lifecycle. No additional reconcile cron is needed.

### Rollout order

1 (centralize EM bookkeeping — the load-bearing change) → 2 (drop WSC.metadata.workflowId + simplify stale-check) → 3 (return-value logging is folded into #2) → 4 (retry cap) → 5 (one-shot backfill).

---

## Phase 2 — schema simplification (collapse the duplication)

The framing: with EM as the source of truth, the WSC audit columns are mostly denormalization. Below is what's worth keeping (hot-path filtering only) and what we can drop. Confirmed with @dev: no external consumers read `WSC.auditStatus`; Dirty content stays in-table behind a `blocked` boolean; `auditRuleVersion` is unused today and rule versioning will live on `EntityModeration` when we need it.

### What's duplicated today

| WSC column / metadata key | EntityModeration field | Notes |
| --- | --- | --- |
| `auditStatus` (Pending/Clean/Dirty) | `status` + `blocked` | Pure derivation: status=Pending → Pending, status=Succeeded & !blocked → Clean, status=Succeeded & blocked → Dirty |
| `auditedAt` | `updatedAt` when status=Succeeded | Trivially derived |
| `auditNote` | `result` JSON | The note is just a stringified summary of triggered labels — can be rebuilt on read |
| `nsfw` | derived from `result.results` (level labels) | Hot-path filter; keep denormalized |
| `metadata.workflowId` | `workflowId` | Same data |
| `metadata.retryCount` | `retryCount` | Same data |
| `metadata.triggeredTerms` | `result.results[].matchedTerms.text` | Forensic, mod UI only |
| `metadata.triggeredLabels` | `triggeredLabels` | Same data |

### Proposed final shape

**`WildcardSetCategory`** — keep ONE denormalized column for hot-path filtering, drop everything else:

- `nsfw: boolean?` — `null` means "not yet audited" (replaces `auditStatus='Pending'`), `true`/`false` is the audit result. Hot path: picker queries filter on `nsfw IS NOT NULL AND nsfw = ?`.
- `blocked: boolean` (default `false`) — denormalized mirror of `EntityModeration.blocked` so the read query can hide Dirty content without joining. Trivially kept in sync from `applyWildcardCategoryAuditSuccess`.

**Drop entirely:**

- `auditStatus`, `auditedAt`, `auditNote` (on both WSC and WildcardSet)
- `auditRuleVersion` (on both WSC and WildcardSet) — not actively used today. When we need rule versioning, it belongs on `EntityModeration` (alongside `workflowId` and `result`), not on the entity itself.
- `metadata.workflowId` (use `EntityModeration.workflowId`; stale-check moves to `recordEntityModerationSuccess`'s `WHERE workflowId=X` predicate which is already there)
- `metadata.retryCount` (use `EntityModeration.retryCount`)
- `metadata.triggeredTerms` / `metadata.triggeredLabels` (the mod UI is a cold path; it can JOIN `EntityModeration.result` on demand)

**`WildcardSet`** rollup becomes:

- `nsfw: boolean` — `true` iff any non-blocked category has `nsfw=true` (denormalized for the picker).
- `usable: boolean` — `true` iff at least one category has `nsfw IS NOT NULL AND blocked = false` (i.e. at least one Clean category exists). Denormalized so the canGenerate hot path can answer "is this set usable for generation?" without walking categories. Maintained by the same path as `nsfw` (the audit-verdict and invalidation handlers recompute both together).
- "Fully audited" stays derivable when needed (rare): `NOT EXISTS (SELECT 1 FROM WildcardSetCategory WHERE wildcardSetId = ws.id AND nsfw IS NULL AND blocked = false)`.

### Read-path: typed helper over `WildcardSet`

Background context: see [prompt-snippets-v1.md §"Wildcards models vs generation resources"](features/prompt-snippets-v1.md#wildcards-models-vs-generation-resources). The v1 read path queries `WildcardSet` per surface that gates a Generate button (model detail page, version detail, picker, list handlers, `/api/generation/resources`). v1 only wired that query into `getResourceData`; every other surface missed it.

Phase 2 fixes the read side by routing all four read surfaces through one shared helper — `getVisibleSystemWildcardSetIdsByVersionId(modelVersionIds, { sfwOnly })` in [src/server/services/generation/version-generation-state.service.ts](../src/server/services/generation/version-generation-state.service.ts). One batched `WildcardSet` query per request, backed by the new `WildcardSet.usable` column so the visibility predicate is a flat column scan with no category sub-query:

```sql
SELECT id, "modelVersionId"
FROM "WildcardSet"
WHERE kind = 'System'
  AND "modelVersionId" = ANY($1)
  AND "isInvalidated" = false
  AND "usable" = true
  -- AND "nsfw" = false   (only on .com / sfwOnly)
```

`canGenerate` for `Wildcards`-type versions becomes a Map lookup: `visibleSetIdByVersionId.get(version.id) != null`. The helper returns the set id alongside, so callers also use it to stamp `wildcardSetId` onto the response.

We considered a denormalized mirror onto `ModelFile.metadata.wildcardSet` to skip the cross-table query entirely (one less round-trip per request). Rejected because:

- The query is already small (one column-indexed table, one round-trip regardless of N).
- A mirror introduces a sync contract — every site that touches `WildcardSet.{usable,nsfw,isInvalidated}` would have to bundle a `ModelFile.metadata` update in the same transaction, plus a reconciliation cron to catch drift. The complexity dwarfs the saved query.
- The helper makes the visibility predicate explicit (it's one function readers can grep for), where a mirror hides it behind whichever `wildcardSet` field a future reader trusted.

**Write sites maintaining the columns.** The new helper depends on `WildcardSet.usable` and `WildcardSetCategory.blocked` being correct:

1. **`applyWildcardCategoryAuditSuccess`** (audit verdict handler) — writes `WSC.blocked` alongside `WSC.auditStatus` from the same `blocked` boolean computed from triggered fail labels.
2. **`recomputeWildcardSetAuditStatus`** — recomputes `WildcardSet.usable` (true iff ≥1 Clean category) and writes it alongside `auditStatus`/`nsfw`/`auditedAt`.

Both columns default to `false`. The schema migration's one-shot backfill seeds them from current `WildcardSet`/`WildcardSetCategory` state.

### Why this is OK

- **All current consumers can be expressed in the new shape.** `getWildcardSets` filters out Dirty sets — becomes `WHERE NOT (every category blocked)` or simply hide sets where the only non-blocked categories are still Pending. Picker NSFW filter becomes `WHERE nsfw = false` (SFW) or `WHERE nsfw IS NOT NULL` (any audited). Set rollup logic in `recomputeWildcardSetAuditStatus` collapses to a `nsfw = ANY(category_nsfw)` aggregate.
- **Stale-callback safety doesn't regress.** Today the stale-check in `applyWildcardCategoryAuditSuccess` reads `WSC.metadata.workflowId`. After the change it reads `EM.workflowId` directly (via `recordEntityModerationSuccess`'s built-in `WHERE workflowId=X` filter, which already exists). One source of truth, one comparison.
- **Mutations get simpler.** Today every category mutation in `wildcard-set.service.ts` writes both `auditStatus='Pending'` AND calls into EM. After: a category mutation just nulls `WSC.nsfw` and upserts the EM row to Pending. One write of truth, one denorm follow-up.

### Migration shape

1. **Schema add + backfill.** New columns: `WildcardSetCategory.blocked: boolean default false`, `WildcardSet.usable: boolean default false`. (`WSC.nsfw: boolean?` and `WildcardSet.nsfw: boolean` already exist.) Same migration backfills `WildcardSet.usable = EXISTS(...Clean category)` and `WSC.blocked = (auditStatus='Dirty')`. Idempotent.
2. **Reader switch.** All four canGenerate read sites (`getResourceData`, `model.getById`, `modelVersion.getById`, `getAssociatedResourcesCardDataHandler`) route through the shared `getVisibleSystemWildcardSetIdsByVersionId` helper, which filters on the new `WildcardSet.usable` column.
3. **Writer switch.** `applyWildcardCategoryAuditSuccess` writes `WSC.blocked` alongside `auditStatus`. `recomputeWildcardSetAuditStatus` writes `WildcardSet.usable` alongside `auditStatus`/`nsfw`. Old columns still maintained in parallel for the moment.
4. **Drop.** Drop `WSC.auditStatus`, `auditedAt`, `auditNote`, `auditRuleVersion`. Drop the same on `WildcardSet`. Drop `WSC.metadata.workflowId` (Phase 1 already), `metadata.retryCount`, `metadata.triggeredTerms`, `metadata.triggeredLabels`.

Phase 1 should ship first to stabilize the pipeline; Phase 2 is a follow-up once the inconsistency counts are at zero.

---

## Open items / decisions

@ai:* **D1.** Do Phase 1 fixes go out as one PR or split? My preference: split — fixes 1 + 2 in one (load-bearing refactor of `createXGuardModerationRequest` plus dropping `WSC.metadata.workflowId`), fix 4 in one (one-line retry cap), and fix 5 is a manual one-shot via the testing endpoint.

@ai:* **D2.** For Phase 2, do you want a separate design doc or proceed from this section once the Phase 1 dust settles?
