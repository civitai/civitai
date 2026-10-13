import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { applyUserScoreUpdates, getScoreMultipliers } from '~/server/jobs/update-user-score';
import {
  countRemovalsByOwner,
  getImagesApprovedOnAppealSince,
  getRemovedImageOwners,
} from '~/server/services/creator-removals.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { REMOVAL_RESTORED_EVENT } from '~/shared/constants/creator-journey.constants';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off: re-score "Removed content" (`reportsAgainst`) for every owner with a removal that was
 * later reversed, by an approved image appeal or a restore event. The nightly job re-scores only
 * owners with something new since its last run, so removals reversed before it learned to skip them
 * still count against their owners until this runs.
 *
 * Writes only owners whose score changes, through the job's own writer, which also recomputes
 * `total`. It grants nothing: run the silent tier backfill afterwards for anyone who crossed a tier.
 *
 *   GET /api/admin/temp/recompute-reversed-removals?token=$WEBHOOK_TOKEN              (dry run)
 *   GET /api/admin/temp/recompute-reversed-removals?token=$WEBHOOK_TOKEN&dryRun=false
 *   then GET /api/admin/temp/backfill-creator-milestones?token=$WEBHOOK_TOKEN&dryRun=false
 *
 * Safe to re-run: the score is absolute, so a second run finds nothing to change.
 */

const schema = z.object({ dryRun: booleanString().default(true) });

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const { dryRun } = schema.parse(req.query);

  const approved = await getImagesApprovedOnAppealSince(new Date(0));
  const restored = await clickhouse.$query<{ ownerId: number }>(`
    SELECT DISTINCT ownerId FROM images WHERE type = '${REMOVAL_RESTORED_EVENT}'
  `);
  const owners = [
    ...new Set([
      ...(await getRemovedImageOwners(clickhouse, approved)),
      ...restored.map((r) => Number(r.ownerId)),
    ]),
  ];

  const { reportsAgainst } = await getScoreMultipliers();
  const violations = await countRemovalsByOwner(clickhouse, owners);
  const changed: [string, { reportsAgainst: number }][] = [];
  for (const ids of chunk(owners, 10_000)) {
    const stored = await pgDbRead
      .cancellableQuery<{ id: number; score: number | null }>(
        `SELECT id, (meta->'scores'->>'reportsAgainst')::numeric AS score
         FROM "User" WHERE id = ANY($1::int[])`,
        [ids]
      )
      .then((q) => q.result());
    for (const { id, score } of stored) {
      const count = violations.get(id);
      const next = count ? count * reportsAgainst : 0;
      if (Number(score ?? 0) !== next) changed.push([String(id), { reportsAgainst: next }]);
    }
  }

  if (dryRun)
    return res.status(200).json({ dryRun, owners: owners.length, changed: changed.length });

  let written = 0;
  for (const records of chunk(changed, 500)) {
    written += (await applyUserScoreUpdates(pgDbWrite, records)).length;
  }
  return res.status(200).json({ dryRun, owners: owners.length, changed: changed.length, written });
});
