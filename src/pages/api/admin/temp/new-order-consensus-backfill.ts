/**
 * Temp admin backfill: finalize KoN votes stranded Pending/Inconclusive by the
 * 2026-06-23 sysRedis wipe (see docs/superpowers/plans/2026-06-29-kon-consensus-backfill.md).
 *
 * Source of truth is the ClickHouse ledger, NOT the Redis queue (queues rotate/wipe).
 * Consensus = raw vote agreement (topCount/voters >= minAgreement) — a deliberate
 * approximation of the live weighted algo (weights live only in the ephemeral
 * new-order:ratings:* zsets). Down-rates by >1 NSFW level are skipped (mod-only).
 *
 * Usage: GET /api/admin/temp/new-order-consensus-backfill?token=$WEBHOOK_TOKEN&action=<action>&...params
 *   ?action=resolve                    preview: full candidate histogram + write-set size (read-only; dryRun defaults on)
 *   ?action=resolve&dryRun=false       re-stamp Pending/Inconclusive -> Correct/Failed (THE WRITE)
 *   ?action=verify                     post-run: count consensus-met rows still unfinalized
 * Write gate: read-only UNLESS the literal `&dryRun=false` is passed. Omitted /
 * any other value (true, 0, garbage) stays read-only — fail-safe by default.
 * Optional params: startDate, minAgreement (def 0.6), staleHours (def 12),
 *                  limit (cap images this run), batchSize (def 1000), concurrency (def 4).
 */
import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  countRestampedRows,
  getConsensusCandidates,
  reconcileAffectedPlayers,
  restampBatch,
} from '~/server/games/new-order/consensus-backfill';

const schema = z.object({
  action: z.enum(['resolve', 'verify']),
  startDate: z.string().optional(),
  minAgreement: z.coerce.number().min(0.5).max(1).optional(),
  staleHours: z.coerce.number().int().min(0).max(240).optional(),
  limit: z.coerce.number().int().positive().max(100_000).optional(),
  batchSize: z.coerce.number().int().positive().max(5_000).optional(),
  concurrency: z.coerce.number().int().min(1).max(16).optional(),
  // GET query param → string; literal-string gate (see resolve action) is fail-safe.
  dryRun: z.enum(['true', 'false']).optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;

  if (p.action === 'resolve') {
    const dryRun = p.dryRun !== 'false'; // default true (read-only); only ?dryRun=false writes
    const batchSize = p.batchSize ?? 1000;
    const concurrency = p.concurrency ?? 4;

    const all = await getConsensusCandidates(p);
    // Full histogram across every decision class — including the mod-only classes
    // (down_gt1 / unknown_orig) we never write. This is the survey the old `count`
    // action returned, now folded into the preview.
    const byDecision = all.reduce<Record<string, number>>((acc, c) => {
      acc[c.decision] = (acc[c.decision] ?? 0) + 1;
      return acc;
    }, {});

    // Phase 1 write set: same-level / 1-level down / up-rate; skip mod-only down>1 + unknown origin.
    let writeSet = all.filter(
      (c) => c.decision === 'same_level' || c.decision === 'down_1lvl' || c.decision === 'up_rate'
    );
    if (p.limit) writeSet = writeSet.slice(0, p.limit);

    if (dryRun) {
      return res.status(200).json({
        dryRun: true,
        totalCandidates: all.length,
        byDecision,
        wouldResolve: writeSet.length,
        skipped: { down_gt1: byDecision.down_gt1 ?? 0, unknown_orig: byDecision.unknown_orig ?? 0 },
      });
    }

    const stampISO = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const batches = chunk(
      writeSet.map((c) => ({ imageId: c.imageId, domRating: c.domRating })),
      batchSize
    );
    let imagesTargeted = 0;
    await limitConcurrency(
      batches.map((b) => async () => {
        await restampBatch(b, stampISO);
        imagesTargeted += b.length;
      }),
      concurrency
    );

    const usersReconciled = await reconcileAffectedPlayers(writeSet.map((c) => c.imageId));
    // Authoritative actual vote-rows written this run (0 = no-op); imagesTargeted is the
    // image count attempted.
    const rowsResolved = await countRestampedRows(stampISO);

    return res
      .status(200)
      .json({ dryRun: false, imagesTargeted, rowsResolved, usersReconciled, byDecision, stampISO });
  }

  if (p.action === 'verify') {
    const remaining = await getConsensusCandidates(p);
    const autoResolvable = remaining.filter(
      (c) => c.decision !== 'down_gt1' && c.decision !== 'unknown_orig'
    );
    return res.status(200).json({
      remainingAutoResolvable: autoResolvable.length,
      remainingEscalate: remaining.length - autoResolvable.length,
    });
  }
});
