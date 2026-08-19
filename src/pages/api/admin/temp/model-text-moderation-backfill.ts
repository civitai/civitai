/**
 * One-off backfill: submit existing published models to XGuard text moderation.
 *
 * POST /api/admin/temp/model-text-moderation-backfill?token=$WEBHOOK_TOKEN
 * Body:
 *   terms?: string[]   // case-insensitive substring match on name + description.
 *                      // Default ['hentai']. The term SELECTS candidates; XGuard
 *                      // renders every verdict. No verdict is inferred from the term.
 *   cursor?: number    // resume from this model id (exclusive). Omit to start.
 *   limit?: number     // models per call, 1-1000, default 200.
 *   dryRun?: boolean   // count candidates without submitting. Default true.
 *
 * Deliberately NOT gated on either feature flag: this is the tool for re-running the
 * set after the apply flag goes up, and for re-running after a rollback. Gating it
 * would remove it from exactly the two situations it exists for. (Same exemption
 * minor-hash-sweep has from MINOR_HASH_AUTO_FLAG.)
 *
 * Submits with forceRescan so a model already scanned during the shadow phase gets a
 * fresh verdict instead of the cached one, which would never re-enter applyResult.
 *
 * A non-dry run is logged to Axiom (`model-text-moderation`) before responding, so a
 * gateway timeout on a long batch still leaves a record of what committed.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  buildModelModerationText,
  MODEL_MODERATION_ENTITY_TYPE,
  MODEL_MODERATION_SCAN_LABELS,
} from '~/server/services/model-moderation.adapter';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { ModelStatus } from '~/shared/utils/prisma/enums';

const schema = z.object({
  terms: z.array(z.string().min(2)).min(1).default(['hentai']),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
  dryRun: z.boolean().default(true),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success)
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  const { terms, cursor, limit, dryRun } = parsed.data;

  const candidates = await dbRead.model.findMany({
    where: {
      status: ModelStatus.Published,
      ...(cursor ? { id: { gt: cursor } } : {}),
      OR: terms.flatMap((term) => [
        { name: { contains: term, mode: 'insensitive' as const } },
        { description: { contains: term, mode: 'insensitive' as const } },
      ]),
    },
    select: { id: true, name: true, description: true, nsfw: true, lockedProperties: true },
    orderBy: { id: 'asc' },
    take: limit,
  });

  // A stored nsfw lock is a moderator's call; leave those rows alone, exactly as
  // applyResult would.
  const eligible = candidates.filter((m) => !(m.lockedProperties ?? []).includes('nsfw'));
  const nextCursor = candidates.length === limit ? candidates[candidates.length - 1].id : null;

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      selected: candidates.length,
      eligible: eligible.length,
      skippedLocked: candidates.length - eligible.length,
      nextCursor,
    });
  }

  let submitted = 0;
  let failed = 0;
  await limitConcurrency(
    eligible.map((model) => async () => {
      const content = buildModelModerationText(model);
      if (!content) return;
      try {
        // No throw on a failed submit — createXGuardModerationRequest normalizes both
        // controlled (4xx/5xx) and uncontrolled (network/DNS) failures into a logged,
        // EM-recorded return with no `id`. Count from the return value, not the catch.
        const result = await submitTextModeration({
          entityType: MODEL_MODERATION_ENTITY_TYPE,
          entityId: model.id,
          content,
          labels: [...MODEL_MODERATION_SCAN_LABELS],
          priority: 'low',
          recordForReview: true,
          forceRescan: true,
        });
        if (result?.id) submitted++;
        else failed++;
      } catch {
        failed++;
      }
    }),
    5
  );

  const counts = {
    selected: candidates.length,
    eligible: eligible.length,
    skippedLocked: candidates.length - eligible.length,
    submitted,
    failed,
    nextCursor,
  };

  // Logged here, before responding, so an HTTP timeout on a long batch cannot lose the
  // record of what already committed — same reasoning as minor-hash-sweep's summary log.
  await logToAxiom({
    type: 'info',
    name: 'model-text-moderation',
    message: 'backfill batch complete',
    cursor: cursor ?? null,
    ...counts,
  }).catch(() => null);

  return res.status(200).json({ dryRun: false, ...counts });
});
