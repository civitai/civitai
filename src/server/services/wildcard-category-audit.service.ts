import type { XGuardModerationOutput } from '@civitai/client';
import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import {
  recordEntityModerationFailure,
  recordEntityModerationSuccess,
} from '~/server/services/entity-moderation.service';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import { applyDerivedLabels } from '~/server/services/scanner-derived-labels.service';
import {
  EntityModerationStatus,
  WildcardSetAuditStatus,
  WildcardSetCategoryAuditStatus,
} from '~/shared/utils/prisma/enums';

// Entity type stamped onto every wildcard-category audit workflow's metadata
// via `createXGuardModerationRequest`. The webhook reads this off the workflow
// metadata to dispatch through the moderation-adapter registry.
const WILDCARD_CATEGORY_ENTITY_TYPE = 'WildcardSetCategory';

// XGuard labels that flip a category to Dirty when triggered. These are the
// hard-fail policy violations — content matching any of these is unusable
// regardless of site context. `csam` is a derived label synthesized by
// `applyDerivedLabels` from a `young` + sexual-signal co-trigger; XGuard's
// text classifiers don't ship a dedicated CSAM label, but the derived row
// appears in `output.results` after the transform runs, so it slots in here
// like any other fail label.
const WILDCARD_AUDIT_FAIL_LABELS = [
  'csam',
  'urine',
  'diaper',
  'scat',
  'menstruation',
  'bestiality',
  'incest',
] as const;
const FAIL_LABEL_SET = new Set<string>(WILDCARD_AUDIT_FAIL_LABELS);

// XGuard label(s) that classify content severity. Restricted to `nsfw` for
// now — the fine-grained `pg/pg13/r/x/xxx` evaluators aren't well-tuned for
// text yet, and pasting them in would just produce noisy classifications.
// Triggering any of these labels flips the category's `nsfw` boolean to
// true; nothing finer is recorded. If/when XGuard's text classifiers can
// reliably bucket severity, we can switch to a bitwise nsfwLevel column —
// for now boolean is the only honest representation.
const WILDCARD_AUDIT_LEVEL_LABELS = ['nsfw', 'young', 'suggestive', 'explicit'] as const;
const LEVEL_LABEL_SET = new Set<string>(WILDCARD_AUDIT_LEVEL_LABELS);

// Open-ended container persisted on `WildcardSetCategory.metadata`. Treat
// unknown fields as additive — readers should default missing fields rather
// than assume their presence.
//
// Note: moderation lifecycle state (workflow id, retry attempts) lives on
// `EntityModeration` as the source of truth. This metadata only holds the
// forensic display fields the moderation UI surfaces on Dirty rows.
export type WildcardCategoryMetadata = {
  // XGuard matched terms (union of `matchedTerms.text` across triggered
  // labels). Survives after rollup so a moderator viewing a Dirty category
  // can see exactly what triggered. Empty/omitted for Clean categories.
  triggeredTerms?: string[];
  // XGuard triggered labels (mirror of the moderation step output, kept on
  // the metadata so the JSON is self-describing without joining other rows).
  triggeredLabels?: string[];
  // Increments on each terminal failure. Cleared/reset implicitly on the
  // next successful rollup.
  // TODO(Phase 2): redundant with EntityModeration.retryCount; drop.
  retryCount?: number;
};

/**
 * Submit one wildcard category for XGuard audit via the shared
 * `createXGuardModerationRequest` helper. The category's `values` are joined
 * with newlines into the text payload; `entityType` / `entityId` flow through
 * the helper onto workflow metadata so the webhook can look the category up
 * and dispatch through the moderation-adapter registry.
 *
 * EntityModeration is the source of truth for moderation state. The submit's
 * EM upsert (Pending on success, Failed on submit failure) is owned by
 * `createXGuardModerationRequest`. The workflow id is NOT written back to
 * WSC.metadata — stale-callback gating uses `EntityModeration.workflowId`
 * via the `WHERE workflowId=X` predicate in
 * `recordEntityModerationSuccess`/`Failure`, and in-flight detection uses
 * the EM row's existence + status, not WSC.
 *
 * Returns the workflow ID on a successful submission. Returns `null` when:
 *   - the category no longer exists,
 *   - the category has no values (caller should mark Clean directly),
 *   - the orchestrator submission failed (the helper has already written
 *     EM=Failed with retryCount incremented; the retry job will pick it up).
 */
export async function submitWildcardCategoryAudit(categoryId: number): Promise<string | null> {
  const category = await dbRead.wildcardSetCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, values: true },
  });
  if (!category) return null;
  if (!category.values || category.values.length === 0) return null;

  const text = category.values.join('\n');

  // Submit both fail labels (hard policy violations → Dirty) and level
  // labels (currently just `nsfw` → boolean `nsfw = true`). We ignore
  // XGuard's top-level `blocked` field in the callback and recompute Dirty
  // ourselves from per-label results, so including level labels here can't
  // accidentally flip the audit verdict.
  const workflow = await createXGuardModerationRequest({
    mode: 'text',
    entityType: WILDCARD_CATEGORY_ENTITY_TYPE,
    entityId: categoryId,
    content: text,
    labels: [...WILDCARD_AUDIT_FAIL_LABELS, ...WILDCARD_AUDIT_LEVEL_LABELS],
    priority: 'low',
  });

  if (!workflow?.id) {
    logToAxiom({
      type: 'error',
      name: 'wildcard-category-audit',
      message: 'createXGuardModerationRequest returned no workflow id',
      wildcardSetCategoryId: categoryId,
    }).catch(() => undefined);
    return null;
  }

  return workflow.id;
}

// Concurrency for orphan-category processing. Per-category work is dominated
// by the orchestrator submit's network round-trip (~hundreds of ms each), so
// running a small batch in parallel cuts wall time roughly proportionally
// and — more importantly — keeps the import-time fire-and-forget from
// holding open a sequential loop long enough for the Node process to be
// recycled mid-run. Kept modest (5) so the burst doesn't crowd the
// orchestrator or starve other request handlers.
const ORPHAN_PROCESSING_CONCURRENCY = 5;

type OrphanCategory = { id: number; valueCount: number; wildcardSetId: number };
type OrphanResult =
  | { kind: 'cleaned-empty'; wildcardSetId: number }
  | { kind: 'submitted'; wildcardSetId: number }
  | { kind: 'skipped'; wildcardSetId: number }
  | { kind: 'error'; wildcardSetId: number };

/**
 * Process one orphan category. Either marks it Clean directly (empty
 * categories: nothing to audit, short-circuit so the set rollup counts it)
 * or submits it for XGuard audit via the shared helper, which lands the
 * EntityModeration row regardless of submit success/failure.
 *
 * Wrapped in try/catch so a thrown error on a single category can't kill the
 * caller's iteration over the rest of the batch. Errors are logged with the
 * category id for triage and counted in the caller's `errors` tally.
 */
async function processOrphanCategory(category: OrphanCategory): Promise<OrphanResult> {
  try {
    if (category.valueCount === 0) {
      await dbWrite.wildcardSetCategory.update({
        where: { id: category.id },
        data: {
          auditStatus: WildcardSetCategoryAuditStatus.Clean,
          auditedAt: new Date(),
        },
      });
      return { kind: 'cleaned-empty', wildcardSetId: category.wildcardSetId };
    }
    const workflowId = await submitWildcardCategoryAudit(category.id);
    return {
      kind: workflowId ? 'submitted' : 'skipped',
      wildcardSetId: category.wildcardSetId,
    };
  } catch (err) {
    logToAxiom({
      type: 'error',
      name: 'wildcard-category-audit',
      message: 'unhandled error processing orphan category',
      wildcardSetCategoryId: category.id,
      wildcardSetId: category.wildcardSetId,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return { kind: 'error', wildcardSetId: category.wildcardSetId };
  }
}

/**
 * Iterate `categories` in bounded-concurrency chunks. Each chunk awaits its
 * full set of in-flight submissions before the next chunk starts — keeps
 * the in-flight count at most `ORPHAN_PROCESSING_CONCURRENCY` so we don't
 * burst-fan-out the orchestrator on large sets.
 */
async function processOrphanCategoriesChunked(
  categories: OrphanCategory[]
): Promise<OrphanResult[]> {
  const results: OrphanResult[] = [];
  for (let i = 0; i < categories.length; i += ORPHAN_PROCESSING_CONCURRENCY) {
    const chunk = categories.slice(i, i + ORPHAN_PROCESSING_CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(processOrphanCategory));
    results.push(...chunkResults);
  }
  return results;
}

function tallyOrphanResults(results: OrphanResult[]): {
  submitted: number;
  skipped: number;
  markedCleanEmpty: number;
  errors: number;
  setsTouched: Set<number>;
} {
  const setsTouched = new Set<number>();
  let submitted = 0;
  let skipped = 0;
  let markedCleanEmpty = 0;
  let errors = 0;
  for (const r of results) {
    if (r.kind === 'submitted') submitted++;
    else if (r.kind === 'skipped') skipped++;
    else if (r.kind === 'cleaned-empty') {
      markedCleanEmpty++;
      setsTouched.add(r.wildcardSetId);
    } else errors++;
  }
  return { submitted, skipped, markedCleanEmpty, errors, setsTouched };
}

/**
 * Submit every Pending category in a set that doesn't already have an
 * EntityModeration row. Used at import-time (fire-and-forget after
 * `importWildcardModelVersion`) and by the cron's per-set unit of work.
 *
 * Empty categories (zero values) are short-circuited to Clean directly —
 * there's nothing to audit, and we want them counted in the set rollup.
 *
 * Iterates in bounded-concurrency chunks (see `processOrphanCategoriesChunked`)
 * with per-category try/catch so a thrown error during one category can't
 * strand the rest of the batch.
 *
 * **Orphan query uses `dbWrite` (primary) deliberately.** Provisioning fires
 * this function immediately after the WSC create transaction commits to the
 * primary; querying the replica is virtually guaranteed to return zero rows
 * during high-write windows, silently no-op'ing the entire submission and
 * leaving every category as an orphan until the cron picks them up an hour
 * later. The cron variant (`submitPendingWildcardCategoryAudits`) stays on
 * the replica since by then the lag has settled.
 *
 * Gate on EM-row absence (not WSC.metadata.workflowId) so EntityModeration
 * stays the single source of truth for moderation lifecycle. Categories
 * that already have an EM row are owned by the EM-driven path
 * (`retry-failed-text-moderation` handles retries; the webhook handles
 * terminal outcomes), so we leave them alone.
 */
export async function submitWildcardSetAudit(setId: number): Promise<{
  submitted: number;
  skipped: number;
  markedCleanEmpty: number;
  errors: number;
}> {
  const orphans = await dbWrite.$queryRaw<Array<OrphanCategory>>`
    SELECT wsc.id, wsc."valueCount", wsc."wildcardSetId"
    FROM "WildcardSetCategory" wsc
    LEFT JOIN "EntityModeration" em
      ON em."entityType" = ${WILDCARD_CATEGORY_ENTITY_TYPE}
     AND em."entityId" = wsc.id
    WHERE wsc."wildcardSetId" = ${setId}
      AND wsc."auditStatus" = ${WildcardSetCategoryAuditStatus.Pending}::"WildcardSetCategoryAuditStatus"
      AND em.id IS NULL
    ORDER BY wsc.id ASC
  `;

  const results = await processOrphanCategoriesChunked(orphans);
  const { submitted, skipped, markedCleanEmpty, errors, setsTouched } = tallyOrphanResults(results);

  if (setsTouched.size > 0) {
    await recomputeWildcardSetAuditStatus(setId);
  }

  return { submitted, skipped, markedCleanEmpty, errors };
}

/**
 * Cron unit of work: find WildcardSetCategory orphans — Pending categories
 * with no EntityModeration row — and submit them. Submission creates the EM
 * row via `createXGuardModerationRequest`'s centralized bookkeeping, after
 * which the row is owned by the EM-driven path.
 *
 * Capped per call so the cron isn't unbounded; rerun until `scanned == 0`
 * to drain. Uses the same chunked-concurrency + per-category try/catch path
 * as `submitWildcardSetAudit` so one bad category can't drop the rest of
 * the cron's batch.
 */
export async function submitPendingWildcardCategoryAudits(opts?: { limit?: number }): Promise<{
  scanned: number;
  submitted: number;
  skipped: number;
  markedCleanEmpty: number;
  errors: number;
}> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));

  const orphans = await dbRead.$queryRaw<Array<OrphanCategory>>`
    SELECT wsc.id, wsc."valueCount", wsc."wildcardSetId"
    FROM "WildcardSetCategory" wsc
    LEFT JOIN "EntityModeration" em
      ON em."entityType" = ${WILDCARD_CATEGORY_ENTITY_TYPE}
     AND em."entityId" = wsc.id
    WHERE wsc."auditStatus" = ${WildcardSetCategoryAuditStatus.Pending}::"WildcardSetCategoryAuditStatus"
      AND em.id IS NULL
    ORDER BY wsc.id ASC
    LIMIT ${limit}
  `;

  const results = await processOrphanCategoriesChunked(orphans);
  const { submitted, skipped, markedCleanEmpty, errors, setsTouched } = tallyOrphanResults(results);

  for (const setId of setsTouched) {
    await recomputeWildcardSetAuditStatus(setId);
  }

  return { scanned: orphans.length, submitted, skipped, markedCleanEmpty, errors };
}

/**
 * Webhook handler: persist a successful XGuard rollup onto the category and
 * recompute the parent set's aggregate. Two derived values come out of the
 * per-label results:
 *
 *   - `auditStatus`: Dirty iff any of `WILDCARD_AUDIT_FAIL_LABELS` triggered.
 *     Includes the derived `csam` row (synthesized from young + sexual signal
 *     by `applyDerivedLabels`) — XGuard's text classifiers don't ship a
 *     dedicated csam label, but the transform produces one when the
 *     co-trigger fires. Computed from per-label `triggered` flags — we
 *     deliberately ignore `output.blocked` because it counts triggered level
 *     labels too, which would falsely flip Dirty for ordinary NSFW content.
 *   - `nsfw`: true iff any `WILDCARD_AUDIT_LEVEL_LABELS` triggered. Boolean,
 *     not a bitwise nsfwLevel — XGuard's text classifiers can't reliably
 *     bucket PG / R / X severity for arbitrary text, so a single "is NSFW"
 *     signal is the honest representation of what we can measure.
 *
 * Idempotent: stale callbacks (workflow ID doesn't match the stored
 * in-flight ID) are dropped so a slow-arriving callback can't clobber a
 * newer audit's result.
 */
export async function applyWildcardCategoryAuditSuccess(opts: {
  categoryId: number;
  workflowId: string;
  output: XGuardModerationOutput;
}): Promise<void> {
  const { categoryId, workflowId, output } = opts;

  const current = await dbRead.wildcardSetCategory.findUnique({
    where: { id: categoryId },
    select: { metadata: true, wildcardSetId: true },
  });
  if (!current) {
    logToAxiom({
      type: 'warning',
      name: 'wildcard-category-audit',
      message: 'callback for missing category',
      wildcardSetCategoryId: categoryId,
      workflowId,
    }).catch(() => undefined);
    return;
  }
  const meta = (current.metadata ?? {}) as WildcardCategoryMetadata;

  // Apply derived-label rules so `csam` (synthesized from young + sexual
  // signal) and any suppressions (e.g. `suggestive` when `explicit` also
  // triggered) are reflected in the result set before we partition into
  // fail / level labels. After this transform, the rest of the function
  // treats derived rows like any other label — `csam` is just another
  // entry in `FAIL_LABEL_SET`. See scanner-derived-labels.service.ts and
  // docs/features/scanner-derived-labels-plan.md.
  const rawResults = output.results ?? [];
  const rawIsTriggered = (r: (typeof rawResults)[number]) =>
    r.triggered || (typeof r.score === 'number' && r.score >= r.threshold);
  const derivedInput = rawResults.map((r) => ({
    label: r.label,
    score: r.score ?? 0,
    threshold: r.threshold ?? null,
    triggered: (rawIsTriggered(r) ? 1 : 0) as 0 | 1,
    version: r.policyHash ?? '',
    matchedText: r.matchedTerms?.text ?? [],
    matchedPositivePrompt: r.matchedTerms?.positivePrompt ?? [],
    matchedNegativePrompt: r.matchedTerms?.negativePrompt ?? [],
  }));
  const results = applyDerivedLabels(derivedInput, 'text');
  const isTriggered = (r: (typeof results)[number]) => r.triggered === 1;

  // Partition the per-label results: fail labels drive Dirty; level labels
  // drive the `nsfw` boolean.
  const triggeredFailResults = results.filter((r) => FAIL_LABEL_SET.has(r.label) && isTriggered(r));
  const triggeredFailLabels = triggeredFailResults.map((r) => r.label);

  const blocked = triggeredFailResults.length > 0;

  // Boolean OR across triggered level labels. False when nothing triggered —
  // purely textual content with no NSFW signal is treated as SFW. Distinct
  // from auditStatus = Pending (which means "not yet audited").
  const nsfw = results.some((r) => LEVEL_LABEL_SET.has(r.label) && isTriggered(r));

  // Labels surfaced to moderators on Dirty rows. Derived `csam` shows up here
  // alongside real fail labels because it's in FAIL_LABEL_SET.
  const blockingLabels = triggeredFailLabels;

  // Terms that any blocking result matched. For derived rows the matchedText
  // is the union of contributing-label terms (assembled by applyDerivedLabels).
  const triggeredTerms = blocked
    ? Array.from(
        new Set(
          triggeredFailResults
            .flatMap((r) => r.matchedText)
            .filter((t): t is string => typeof t === 'string' && t.length > 0)
        )
      )
    : [];

  const auditStatus = blocked
    ? WildcardSetCategoryAuditStatus.Dirty
    : WildcardSetCategoryAuditStatus.Clean;
  const auditNote = blocked
    ? `Blocked: ${blockingLabels.join(', ') || 'unspecified labels'}; ${
        triggeredTerms.length
      } term(s) triggered`
    : null;

  // Persist forensics only when Dirty — Clean categories drop them so we
  // don't keep stale matched terms from prior audits. `triggeredLabels`
  // records the blocking labels (real fail labels + the synthetic
  // `csam (young+sexual)` entry) since the level classification is already
  // captured in `nsfw`.
  const nextMetadata: WildcardCategoryMetadata = {
    ...meta,
    retryCount: undefined,
    triggeredTerms: blocked ? triggeredTerms : undefined,
    triggeredLabels: blocked ? blockingLabels : undefined,
  };

  // EntityModeration is the source of truth. Update it FIRST — its
  // `WHERE workflowId=X` predicate is the stale-callback gate. If the EM
  // row's stored workflowId no longer matches this callback's workflow
  // (because a newer audit superseded it), the update returns false and
  // we leave WSC untouched. The newer workflow's callback will reconcile.
  const emUpdated = await recordEntityModerationSuccess({
    entityType: WILDCARD_CATEGORY_ENTITY_TYPE,
    entityId: categoryId,
    workflowId,
    output: opts.output,
  });
  if (!emUpdated) {
    logToAxiom({
      type: 'warning',
      name: 'wildcard-category-audit',
      message: 'stale workflow callback ignored (EntityModeration workflowId mismatch)',
      wildcardSetCategoryId: categoryId,
      workflowId,
    }).catch(() => undefined);
    return;
  }

  await dbWrite.wildcardSetCategory.update({
    where: { id: categoryId },
    data: {
      auditStatus,
      blocked,
      auditedAt: new Date(),
      auditNote,
      nsfw,
      metadata: serializeMetadata(nextMetadata),
    },
  });

  await recomputeWildcardSetAuditStatus(current.wildcardSetId);
}

/**
 * Webhook handler: terminal-failure callback. Mirrors the failure onto the
 * EntityModeration row (which bumps `retryCount` and writes the terminal
 * status) so `retry-failed-text-moderation` picks it up for resubmission.
 * WSC.auditStatus stays Pending because the moderation outcome isn't known
 * yet — the retry job will eventually produce a terminal verdict.
 */
export async function applyWildcardCategoryAuditFailure(opts: {
  categoryId: number;
  workflowId: string;
  status: 'failed' | 'expired' | 'canceled';
}): Promise<void> {
  const { categoryId, workflowId, status } = opts;

  // EntityModeration is the source of truth. `recordEntityModerationFailure`'s
  // `WHERE workflowId=X` predicate is the stale-callback gate — a false
  // return means a newer audit superseded this workflow.
  const entityStatus = {
    failed: EntityModerationStatus.Failed,
    expired: EntityModerationStatus.Expired,
    canceled: EntityModerationStatus.Canceled,
  }[status];
  const emUpdated = await recordEntityModerationFailure({
    entityType: WILDCARD_CATEGORY_ENTITY_TYPE,
    entityId: categoryId,
    workflowId,
    status: entityStatus,
  });
  if (!emUpdated) {
    logToAxiom({
      type: 'warning',
      name: 'wildcard-category-audit',
      message: 'stale workflow callback ignored (EntityModeration workflowId mismatch)',
      wildcardSetCategoryId: categoryId,
      workflowId,
      status,
    }).catch(() => undefined);
  }
}

/**
 * Recompute a wildcard set's aggregate audit status and `nsfw` rollup from
 * its categories. Called after every category-level transition that could
 * shift the set's bucket (Pending → Clean/Dirty/Mixed) or any category's
 * `nsfw` flag.
 *
 * Aggregation rules (auditStatus):
 *   - any category Pending → set Pending
 *   - all Clean → set Clean
 *   - any Dirty AND any Clean → set Mixed
 *   - all Dirty → set Dirty
 *
 * Aggregation rule (nsfw): boolean OR of every non-Dirty category's `nsfw`
 * flag. Lets visibility checks (".com hides any set with NSFW content") run
 * as a single-column predicate, avoiding a category sub-query on every check.
 *
 * Set-level reads (`getWildcardSets`) hide `Dirty` sets entirely; `Mixed`
 * sets are visible with their Dirty categories filtered at the picker layer.
 */
export async function recomputeWildcardSetAuditStatus(setId: number): Promise<void> {
  // Read via dbWrite to avoid replica-lag returning stale category audit
  // verdicts — this function is called immediately after writing one (the
  // webhook handler's success/failure path), and the recompute MUST see
  // those writes to produce a correct rollup.
  const categories = await dbWrite.wildcardSetCategory.findMany({
    where: { wildcardSetId: setId },
    select: { auditStatus: true, nsfw: true },
  });

  const nextStatus = aggregateSetStatus(categories.map((c) => c.auditStatus));
  // Boolean OR across non-Dirty categories. Dirty rows are excluded from the
  // rollup because their content isn't usable at any site context — a Dirty
  // category contributing `nsfw = true` would falsely advertise "this set
  // has NSFW content" when it really doesn't have any usable NSFW content.
  const nextNsfw = categories.some(
    (c) => c.auditStatus !== WildcardSetCategoryAuditStatus.Dirty && c.nsfw
  );

  // Phase 2: `WildcardSet.usable = true` iff at least one Clean category
  // exists. Drives the canGenerate gate without sub-querying categories.
  const nextUsable = categories.some(
    (c) => c.auditStatus === WildcardSetCategoryAuditStatus.Clean
  );

  await dbWrite.wildcardSet.update({
    where: { id: setId },
    data: {
      auditStatus: nextStatus,
      nsfw: nextNsfw,
      usable: nextUsable,
      auditedAt: nextStatus === WildcardSetAuditStatus.Pending ? null : new Date(),
    },
  });
}

function aggregateSetStatus(
  categoryStatuses: WildcardSetCategoryAuditStatus[]
): WildcardSetAuditStatus {
  if (categoryStatuses.length === 0) return WildcardSetAuditStatus.Pending;
  if (categoryStatuses.includes(WildcardSetCategoryAuditStatus.Pending)) {
    return WildcardSetAuditStatus.Pending;
  }
  const hasDirty = categoryStatuses.includes(WildcardSetCategoryAuditStatus.Dirty);
  const hasClean = categoryStatuses.includes(WildcardSetCategoryAuditStatus.Clean);
  if (hasDirty && hasClean) return WildcardSetAuditStatus.Mixed;
  if (hasDirty) return WildcardSetAuditStatus.Dirty;
  return WildcardSetAuditStatus.Clean;
}

// Strip empty/zero/undefined fields so the serialized JSON stays compact and
// reflects only meaningful state (rather than persisting `{ retryCount: 0 }`
// or `{ triggeredTerms: [] }`). Legacy rows may carry a `workflowId` field
// from before the EntityModeration-as-source-of-truth refactor; we drop it
// on the next write so it gets purged over time.
function serializeMetadata(meta: WildcardCategoryMetadata): Prisma.InputJsonValue {
  const out: WildcardCategoryMetadata = {};
  if (meta.triggeredTerms?.length) out.triggeredTerms = meta.triggeredTerms;
  if (meta.triggeredLabels?.length) out.triggeredLabels = meta.triggeredLabels;
  if (meta.retryCount && meta.retryCount > 0) out.retryCount = meta.retryCount;
  return out as Prisma.InputJsonValue;
}

// WildcardSetCategory-side hooks for the EntityModeration pipeline. The
// `applyResult` / `applyFailure` methods aren't called by the webhook yet
// (the webhook still has a wildcard-specific dispatch branch via the
// `?type=wildcardCategoryValue` query param). The unified dispatch in
// follow-up cleanup #2 will route through this adapter; registering it
// here now lets the registry be entity-agnostic.
export const wildcardCategoryModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    // Wildcard category content = its `values` joined with newlines, the
    // same shape the audit submit path sends to XGuard. Categories whose
    // `values` is empty are excluded (the resolver returns nothing for
    // them) so the retry job's missing-content path treats them as gone —
    // empty categories get marked Clean directly at the audit-submit
    // boundary and never reach the retry queue with content to resolve.
    const rows = await dbRead.wildcardSetCategory.findMany({
      where: { id: { in: ids } },
      select: { id: true, values: true },
    });
    return new Map(
      rows.filter((r) => r.values && r.values.length > 0).map((r) => [r.id, r.values.join('\n')])
    );
  },

  submit: async ({ entityId }) => {
    const id = await submitWildcardCategoryAudit(entityId);
    return id ? { id } : undefined;
  },

  applyResult: async ({ entityId, workflowId, output }) => {
    await applyWildcardCategoryAuditSuccess({ categoryId: entityId, workflowId, output });
  },

  applyFailure: async ({ entityId, workflowId, status }) => {
    await applyWildcardCategoryAuditFailure({ categoryId: entityId, workflowId, status });
  },
};
