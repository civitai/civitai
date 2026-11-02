import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { applyUserScoreUpdates, getScoreMultipliers } from '~/server/jobs/update-user-score';
import {
  removalPenaltyWeightsByOwner,
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
 * restore event or score exemption), a small set. `scope=all` takes every owner with any removal,
 * which is what applying the window and reason weights retroactively needs.
 *
 * Owners are processed `limit` at a time in owner-id order, after `cursor` (exclusive). The response
 * carries `nextCursor`, null once the last page is done. Writes are absolute, so re-running a page
 * is safe.
 *
 * Runbook: loop the pages dry (feed each `nextCursor` back as `cursor` until it is null) and read
 * the counts, loop them again with `dryRun=false`, then run the tier backfill. Grants nothing itself.
 *
 *   GET /api/admin/temp/recompute-removal-scores?token=$WEBHOOK_TOKEN&scope=all&direction=all             (dry run, page 1)
 *   GET /api/admin/temp/recompute-removal-scores?token=$WEBHOOK_TOKEN&scope=all&direction=all&cursor=N     (next page)
 *   GET /api/admin/temp/recompute-removal-scores?token=$WEBHOOK_TOKEN&scope=all&direction=all&dryRun=false
 *   then GET /api/admin/temp/backfill-creator-milestones?token=$WEBHOOK_TOKEN&dryRun=false
 *
 *   &direction=all also writes owners whose score falls (default `up`: increases only)
 *   &limit=N owners per page (default 5000, max 20000)
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  direction: z.enum(['up', 'all']).default('up'),
  scope: z.enum(['reversed', 'all']).default('reversed'),
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(20_000).default(5000),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const { dryRun, direction, scope, cursor, limit } = schema.parse(req.query);

  const owners =
    scope === 'all'
      ? await getOwnersWithRemovals(clickhouse, cursor, limit)
      : (await getOwnersWithReversalsSince(clickhouse, new Date(0)))
          .filter((id) => id > cursor)
          .sort((a, b) => a - b)
          .slice(0, limit);
  const nextCursor = owners.length === limit ? owners[owners.length - 1] : null;

  const { reportsAgainst } = await getScoreMultipliers();
  const penaltyWeights = await removalPenaltyWeightsByOwner(clickhouse, owners);
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
      const next = reportsAgainstScore(penaltyWeights.get(id), reportsAgainst);
      const current = Number(score ?? 0);
      if (next === current) continue;
      if (next > current) up++;
      else down++;
      if (direction === 'all' || next > current)
        changed.push([String(id), { reportsAgainst: next }]);
    }
  }

  if (dryRun)
    return res.status(200).json({
      dryRun,
      direction,
      scope,
      owners: owners.length,
      nextCursor,
      changed: changed.length,
      up,
      down,
    });

  let written = 0;
  for (const records of chunk(changed, 500)) {
    written += (await applyUserScoreUpdates(pgDbWrite, records)).length;
  }
  return res.status(200).json({
    dryRun,
    direction,
    scope,
    owners: owners.length,
    nextCursor,
    changed: changed.length,
    up,
    down,
    written,
  });
});
