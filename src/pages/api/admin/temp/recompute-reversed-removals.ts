import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { applyUserScoreUpdates, getScoreMultipliers } from '~/server/jobs/update-user-score';
import {
  countRemovalsByOwner,
  getOwnersWithRemovals,
  getOwnersWithReversalsSince,
  reportsAgainstScore,
} from '~/server/services/creator-removals.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off: re-score `reportsAgainst` for owners the nightly job has not re-scored since the rules
 * changed, writing only those whose score rises unless `direction=all`. The job only re-scores
 * owners with something new since its last run, so a reversal, a removal older than the window or
 * a reason weighting would otherwise leave the stored score as it was.
 *
 * `scope=reversed` (default) takes owners with a removal later reversed (approved image appeal,
 * restore event or score exemption). `scope=all` takes every owner with any removal, which is what
 * applying the window and reason weights retroactively needs.
 *
 * Grants nothing: run the silent tier backfill afterwards for anyone who crossed a tier.
 *
 * Run it dry first and read the counts, then write, then the tier backfill:
 *
 *   GET /api/admin/temp/recompute-reversed-removals?token=$WEBHOOK_TOKEN&scope=all&direction=all   (dry run)
 *   GET /api/admin/temp/recompute-reversed-removals?token=$WEBHOOK_TOKEN&scope=all&direction=all&dryRun=false
 *   then GET /api/admin/temp/backfill-creator-milestones?token=$WEBHOOK_TOKEN&dryRun=false
 *
 *   &direction=all also writes owners whose score falls (default `up`: increases only)
 *
 * Safe to re-run.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  direction: z.enum(['up', 'all']).default('up'),
  scope: z.enum(['reversed', 'all']).default('reversed'),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const { dryRun, direction, scope } = schema.parse(req.query);

  const owners =
    scope === 'all'
      ? await getOwnersWithRemovals(clickhouse)
      : await getOwnersWithReversalsSince(clickhouse, new Date(0));

  const { reportsAgainst } = await getScoreMultipliers();
  const violations = await countRemovalsByOwner(clickhouse, owners);
  const changed: [string, { reportsAgainst: number }][] = [];
  let up = 0;
  let down = 0;
  for (const ids of chunk(owners, 10_000)) {
    const stored = await pgDbRead
      .cancellableQuery<{ id: number; score: number | null }>(
        `SELECT id, (meta->'scores'->>'reportsAgainst')::numeric AS score
         FROM "User" WHERE id = ANY($1::int[])`,
        [ids]
      )
      .then((q) => q.result());
    for (const { id, score } of stored) {
      const next = reportsAgainstScore(violations.get(id), reportsAgainst);
      const current = Number(score ?? 0);
      if (next === current) continue;
      if (next > current) up++;
      else down++;
      if (direction === 'all' || next > current)
        changed.push([String(id), { reportsAgainst: next }]);
    }
  }

  if (dryRun)
    return res
      .status(200)
      .json({ dryRun, direction, scope, owners: owners.length, changed: changed.length, up, down });

  let written = 0;
  for (const records of chunk(changed, 500)) {
    written += (await applyUserScoreUpdates(pgDbWrite, records)).length;
  }
  return res.status(200).json({
    dryRun,
    direction,
    scope,
    owners: owners.length,
    changed: changed.length,
    up,
    down,
    written,
  });
});
