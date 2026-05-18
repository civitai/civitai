/**
 * One-shot backfill for the EntityModeration ↔ WildcardSetCategory drift
 * created by the pre-Phase-1 reset-then-submit race in
 * `submitWildcardCategoryAudit`.
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query
 * param. Not reachable without the secret; no public UI.
 *
 * Usage:
 *   POST /api/testing/wildcard-em-backfill?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   preview                       - Count rows that would be updated. Read-only.
 *   backfill - {confirm, limit?}  - Apply the backfill. Requires confirm:true.
 *                                   limit caps how many rows are touched in
 *                                   one call (default 500). Rerun until
 *                                   preview returns 0.
 *
 * Backfill rule: where `WildcardSetCategory.auditStatus IN ('Clean', 'Dirty')`
 * AND `EntityModeration.status = 'Pending'`, the wildcard callback already
 * ran successfully against WSC but the EM mirror was lost. WSC is the source
 * of truth for these specific rows (and only these — the Phase 1 reconcile
 * cron uses the orchestrator, not WSC, for everything going forward). We
 * write EM as Succeeded with `blocked` derived from `auditStatus='Dirty'`
 * and reconstruct `triggeredLabels` / `result` from `WSC.metadata` where
 * available.
 *
 * This endpoint is meant to be run once after the Phase 1 fixes deploy.
 * Once preview returns 0, the reconcile cron is the only ongoing
 * reconciliation path.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import {
  EntityModerationStatus,
  WildcardSetCategoryAuditStatus,
} from '~/shared/utils/prisma/enums';

const WILDCARD_CATEGORY_ENTITY_TYPE = 'WildcardSetCategory';

const actionSchema = z.enum(['preview', 'backfill']);
type Action = z.infer<typeof actionSchema>;

const backfillSchema = z.object({
  action: z.literal('backfill'),
  confirm: z.literal(true),
  limit: z.number().int().positive().max(2000).optional(),
});

const previewSchema = z.object({
  action: z.literal('preview'),
});

const bodySchema = z.discriminatedUnion('action', [previewSchema, backfillSchema]);

type WildcardCategoryMetadata = {
  workflowId?: string;
  triggeredTerms?: string[];
  triggeredLabels?: string[];
  retryCount?: number;
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }
  const body = parsed.data;

  if (body.action === 'preview') {
    const counts = await dbRead.$queryRaw<
      Array<{ wsc_status: WildcardSetCategoryAuditStatus; cnt: bigint }>
    >`
      SELECT wsc."auditStatus" AS wsc_status, COUNT(*)::bigint AS cnt
      FROM "EntityModeration" em
      JOIN "WildcardSetCategory" wsc ON em."entityId" = wsc.id
      WHERE em."entityType" = ${WILDCARD_CATEGORY_ENTITY_TYPE}
        AND em.status = ${EntityModerationStatus.Pending}::"EntityModerationStatus"
        AND wsc."auditStatus" IN (
          ${WildcardSetCategoryAuditStatus.Clean}::"WildcardSetCategoryAuditStatus",
          ${WildcardSetCategoryAuditStatus.Dirty}::"WildcardSetCategoryAuditStatus"
        )
      GROUP BY wsc."auditStatus"
    `;
    return res.status(200).json({
      ok: true,
      action: 'preview' satisfies Action,
      eligible: counts.map((r) => ({ wsc_status: r.wsc_status, count: Number(r.cnt) })),
    });
  }

  const limit = body.limit ?? 500;

  // Pull eligible (em, wsc) pairs. We need WSC.metadata for triggeredLabels/
  // triggeredTerms reconstruction and WSC.auditStatus to derive `blocked`.
  const eligible = await dbRead.entityModeration.findMany({
    where: {
      entityType: WILDCARD_CATEGORY_ENTITY_TYPE,
      status: EntityModerationStatus.Pending,
    },
    select: { id: true, entityId: true, workflowId: true },
    orderBy: { id: 'asc' },
    take: limit * 2, // over-fetch because we filter on WSC.auditStatus below
  });
  if (!eligible.length) {
    return res.status(200).json({ ok: true, action: 'backfill', processed: 0, updated: 0 });
  }

  const wscRows = await dbRead.wildcardSetCategory.findMany({
    where: { id: { in: eligible.map((r) => r.entityId) } },
    select: { id: true, auditStatus: true, metadata: true },
  });
  const wscById = new Map(wscRows.map((r) => [r.id, r]));

  let updated = 0;
  let processed = 0;
  for (const em of eligible) {
    if (processed >= limit) break;
    const wsc = wscById.get(em.entityId);
    if (!wsc) continue;
    if (
      wsc.auditStatus !== WildcardSetCategoryAuditStatus.Clean &&
      wsc.auditStatus !== WildcardSetCategoryAuditStatus.Dirty
    )
      continue;

    processed++;
    const meta = (wsc.metadata ?? {}) as WildcardCategoryMetadata;
    const blocked = wsc.auditStatus === WildcardSetCategoryAuditStatus.Dirty;
    const triggeredLabels = meta.triggeredLabels ?? [];

    // Reconstruct a minimal slim result so EntityModeration.result isn't
    // null on backfilled rows. We don't have per-label scores from the
    // original audit, but we capture what WSC.metadata preserved.
    const reconstructedResult = {
      blocked,
      triggeredLabels,
      results: [] as Array<{ label: string; matchedTerms?: { text: string[] } }>,
      _backfilled: true as const,
    };
    if (blocked && meta.triggeredTerms?.length) {
      reconstructedResult.results = triggeredLabels.map((label) => ({
        label,
        matchedTerms: { text: meta.triggeredTerms ?? [] },
      }));
    } else if (triggeredLabels.length) {
      reconstructedResult.results = triggeredLabels.map((label) => ({ label }));
    }

    await dbWrite.entityModeration.update({
      where: { id: em.id },
      data: {
        status: EntityModerationStatus.Succeeded,
        blocked,
        triggeredLabels,
        result: reconstructedResult,
      },
    });
    updated++;
  }

  return res.status(200).json({
    ok: true,
    action: 'backfill' satisfies Action,
    processed,
    updated,
  });
}

export default WebhookEndpoint(handler);
