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

**Caller cleanup:** `submitWildcardCategoryAudit` and `submitTextModeration` stop calling `upsertEntityModerationPending` and stop calling `entityModeration.updateMany` to stamp the workflow id. They become a single call to `createXGuardModerationRequest` plus their own entity-specific bookkeeping (e.g. `submitWildcardCategoryAudit` still stamps `WSC.metadata.workflowId` until Phase 2 removes that column).

**Affected rows:** prevents new instances of both classes of inconsistency. Existing rows are addressed by fix #5 (backfill).

### 2. Check return value of `recordEntityModerationSuccess` and log on mismatch

In `applyWildcardCategoryAuditSuccess`, capture the boolean return and emit a warning log when it's false. Same in `applyWildcardCategoryAuditFailure`. Pure observability — no behavior change — but turns silent drift into a visible signal we can dashboard.

### 3. Cap Pending-timeout retries in the retry cron

In `text-moderation-retry.ts`'s Pending-timeout retry branch, increment `EM.retryCount` before resubmitting and respect `retryCount < 9` the same way Failed/Expired/Canceled rows do. Closes the infinite-retry loophole for stuck Pending rows without involving WSC at all — EM is the source of truth for retry state.

(Intentionally narrow. An earlier draft proposed gating the cron on `WSC.auditStatus` to skip Clean/Dirty categories, but that re-asserts WSC as authoritative, which is exactly the duplication Phase 2 removes. With fix #1 closing the race window, no new Clean+Pending inconsistencies should accrue, so the cron has no reason to second-guess EM.)

### 4. Reconciliation cron — `reconcile-wildcard-category-moderation`

Hourly job that uses the orchestrator (not WSC) as the tiebreaker for in-flight workflows:

- **Orphans:** find WSCs with no EM row. Seed a Pending EM row and trigger `submitWildcardCategoryAudit`. Drains the 449 current orphans.
- **EM Pending stuck for >2h with workflowId:** call `getWorkflow` against the orchestrator. If terminal (succeeded/failed/expired/canceled), replay the appropriate webhook handler. If the orchestrator has no record of the workflow (retention dropped it, etc.), write EM as `Expired` and let the existing retry path resubmit. WSC is never read here.
- **EM Pending stuck for >2h with NO workflowId:** shouldn't exist after fix #1 lands, but if it does, mark `Failed` with `retryCount` incremented so the retry path takes over.

### 5. One-shot backfill for the existing 286 Clean+Pending inconsistencies

These rows pre-date the fixes and are the one case where WSC genuinely is the source of truth — the callback already ran successfully against WSC; only the EM mirror was lost to the pre-fix race. A one-time script (or admin endpoint, scoped to a single run) reads each `(WSC.auditStatus IN (Clean, Dirty), EM.status = Pending)` pair and writes EM to match: `Succeeded` + `blocked` derived from `WSC.auditStatus='Dirty'`, plus `triggeredLabels` / `result` reconstructed from `WSC.metadata.triggeredLabels` and `WSC.metadata.triggeredTerms` where available.

Explicitly a one-shot — once it runs, the reconcile cron from fix #4 (orchestrator-driven, EM-authoritative) takes over forever after, and we never again use WSC as a fallback truth source.

### Rollout order

1 (centralize EM bookkeeping — the load-bearing change) → 2 (observability) → 3 (retry cap) → 4 (reconciliation cron) → 5 (one-shot backfill).

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
- "Fully audited" is derivable: `NOT EXISTS (SELECT 1 FROM WildcardSetCategory WHERE wildcardSetId = ws.id AND nsfw IS NULL AND blocked = false)`. If we need this in hot reads we can add a denormalized boolean later.

### Why this is OK

- **All current consumers can be expressed in the new shape.** `getWildcardSets` filters out Dirty sets — becomes `WHERE NOT (every category blocked)` or simply hide sets where the only non-blocked categories are still Pending. Picker NSFW filter becomes `WHERE nsfw = false` (SFW) or `WHERE nsfw IS NOT NULL` (any audited). Set rollup logic in `recomputeWildcardSetAuditStatus` collapses to a `nsfw = ANY(category_nsfw)` aggregate.
- **Stale-callback safety doesn't regress.** Today the stale-check in `applyWildcardCategoryAuditSuccess` reads `WSC.metadata.workflowId`. After the change it reads `EM.workflowId` directly (via `recordEntityModerationSuccess`'s built-in `WHERE workflowId=X` filter, which already exists). One source of truth, one comparison.
- **Mutations get simpler.** Today every category mutation in `wildcard-set.service.ts` writes both `auditStatus='Pending'` AND calls into EM. After: a category mutation just nulls `WSC.nsfw` and upserts the EM row to Pending. One write of truth, one denorm follow-up.

### Migration shape

1. Add new columns (`nsfw: boolean?` already exists; `blocked: boolean default false` is new on WSC). Backfill from current `auditStatus`/`nsfw`.
2. Switch all readers to the new columns. Old columns still maintained in parallel.
3. Switch all writers to the new columns + EM only. Stop writing the old columns.
4. Drop the old columns and `metadata.workflowId` / `metadata.retryCount` / `metadata.triggeredTerms` / `metadata.triggeredLabels`.

Phase 1 should ship first to stabilize the pipeline; Phase 2 is a follow-up once the inconsistency counts are at zero.

---

## Open items / decisions

@ai:* **D1.** Do Phase 1 fixes go out as one PR or split? My preference: split — fix 1 in one (the load-bearing refactor, careful review), fix 2 in one (observability), fix 3 in one (one-line cron change), fix 4 in one (new cron), and fix 5 is a manual one-shot script.

@ai:* **D2.** For Phase 2, do you want a separate design doc or proceed from this section once the Phase 1 dust settles?
