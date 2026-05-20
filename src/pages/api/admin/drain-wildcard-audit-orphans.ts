/**
 * Admin: drain orphan `WildcardSetCategory` rows that have no `EntityModeration`
 * row yet (Pending categories the import-time audit submission missed). Each
 * request loops `submitPendingWildcardCategoryAudits({ limit: 500 })` against
 * a soft ~25s wall-time budget, then returns progress.
 *
 * Re-run externally until `drained: true`:
 *
 *   while true; do
 *     RESP=$(curl -s -X POST "https://.../api/admin/drain-wildcard-audit-orphans?token=$TOKEN")
 *     echo $RESP
 *     [ "$(echo $RESP | jq -r .drained)" = "true" ] && break
 *     sleep 5
 *   done
 *
 * Sized so each call drains roughly 5k-10k categories — a 47k backlog clears
 * in ~5-10 invocations. Each invocation stays well under any edge timeout.
 *
 * Do NOT run concurrently with itself. The orphan query orders by `wsc.id
 * ASC`, so two parallel callers would race on the same id range and
 * double-submit. One caller, looped from the shell.
 *
 * Auth: `WebhookEndpoint` — token-gated via `?token=$WEBHOOK_TOKEN`.
 */
import { submitPendingWildcardCategoryAudits } from '~/server/services/wildcard-category-audit.service';
import { dbRead } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { WildcardSetCategoryAuditStatus } from '~/shared/utils/prisma/enums';

const WALL_TIME_BUDGET_MS = 25_000;
const BATCH_LIMIT = 500;

export default WebhookEndpoint(async (req, res) => {
  const start = Date.now();
  const deadline = start + WALL_TIME_BUDGET_MS;

  const totals = {
    scanned: 0,
    submitted: 0,
    skipped: 0,
    markedCleanEmpty: 0,
    errors: 0,
  };
  let batches = 0;

  // Loop until the orphan queue is empty or the wall-time budget is exhausted.
  // Each batch makes one DB round-trip + up to BATCH_LIMIT orchestrator submits
  // (which the audit service runs concurrently at chunk size 5). Big batches
  // are wall-time-bound by orchestrator latency, not by the loop body.
  while (Date.now() < deadline) {
    const result = await submitPendingWildcardCategoryAudits({ limit: BATCH_LIMIT });
    batches++;
    totals.scanned += result.scanned;
    totals.submitted += result.submitted;
    totals.skipped += result.skipped;
    totals.markedCleanEmpty += result.markedCleanEmpty;
    totals.errors += result.errors;

    // Empty batch = queue drained. Exit early.
    if (result.scanned === 0) break;
  }

  // `remaining` is informational — a quick COUNT(*) so the admin sees how far
  // off "done" they are. Approximate (new orphans could land between this
  // count and the next invocation); the `drained` boolean below is the
  // authoritative "stop looping" signal.
  const remainingResult = await dbRead.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "WildcardSetCategory" wsc
    LEFT JOIN "EntityModeration" em
      ON em."entityType" = 'WildcardSetCategory'
     AND em."entityId" = wsc.id
    WHERE wsc."auditStatus" = ${WildcardSetCategoryAuditStatus.Pending}::"WildcardSetCategoryAuditStatus"
      AND em.id IS NULL
  `;
  const remaining = Number(remainingResult[0]?.count ?? 0);

  // `drained` is the authoritative "stop looping" signal. Counted via the
  // `remaining` query above; replica lag on this last read could put it
  // slightly behind reality, but in the worst case the admin runs one more
  // invocation that immediately returns `{ batches: 1, scanned: 0 }`.
  res.status(200).json({
    batches,
    totals,
    remaining,
    drained: remaining === 0,
    elapsedMs: Date.now() - start,
  });
});
