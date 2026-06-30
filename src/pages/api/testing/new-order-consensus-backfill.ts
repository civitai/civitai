/**
 * Temp admin backfill: finalize KoN votes stranded Pending/Inconclusive by the
 * 2026-06-23 sysRedis wipe (see docs/superpowers/plans/2026-06-29-kon-consensus-backfill.md).
 *
 * Source of truth is the ClickHouse ledger, NOT the Redis queue (queues rotate/wipe).
 * Consensus = raw vote agreement (topCount/voters >= minAgreement) — a deliberate
 * approximation of the live weighted algo (weights live only in the ephemeral
 * new-order:ratings:* zsets). Down-rates by >1 NSFW level are skipped (mod-only).
 *
 * Usage: POST /api/testing/new-order-consensus-backfill?token=$WEBHOOK_TOKEN
 *   { "action": "count" }                       preview candidate counts (read-only)
 *   { "action": "resolve", "dryRun": true }     preview the write set (read-only)
 *   { "action": "resolve", "dryRun": false }    re-stamp Pending/Inconclusive -> Correct/Failed
 *   { "action": "verify" }                      post-run: assert no consensus-met rows remain unfinalized
 * Optional params: startDate, minAgreement (def 0.6), staleHours (def 12),
 *                  limit (cap images this run), batchSize (def 1000), concurrency (def 4).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getConsensusCandidates } from '~/server/games/new-order/consensus-backfill';

const schema = z.object({
  action: z.enum(['count', 'resolve', 'verify']),
  startDate: z.string().optional(),
  minAgreement: z.coerce.number().min(0.5).max(1).optional(),
  staleHours: z.coerce.number().int().min(0).max(240).optional(),
  limit: z.coerce.number().int().positive().max(100_000).optional(),
  batchSize: z.coerce.number().int().positive().max(5_000).optional(),
  concurrency: z.coerce.number().int().min(1).max(16).optional(),
  dryRun: z.coerce.boolean().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;

  if (p.action === 'count') {
    const candidates = await getConsensusCandidates(p);
    const byDecision = candidates.reduce<Record<string, number>>((acc, c) => {
      acc[c.decision] = (acc[c.decision] ?? 0) + 1;
      return acc;
    }, {});
    return res.status(200).json({ total: candidates.length, byDecision });
  }

  return res.status(400).json({ error: `action ${p.action} not yet implemented` });
});
