import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import { getScoreMultipliers } from '~/server/jobs/update-user-score';
import {
  backfillExemptionParams,
  exemptionReason,
  findPolicyChangeRemovals,
  insertRemovalScoreExemptions,
  previewTierUps,
} from '~/server/services/removal-score-exemption.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * One-off: exempt from the Creator Score the removals a rule change made of images posted before it
 * (see `isPolicyChangeRemoval`). The rule's inputs are params, so another cutoff is another run.
 *
 *   GET /api/admin/temp/backfill-removal-score-exemptions?token=$WEBHOOK_TOKEN          (dry run)
 *   ...&dryRun=false   writes the rows
 *
 *   cutoff    when the rule took effect, default the real-people policy article
 *   maxImageId the last image uploaded before `cutoff`
 *   requireFirstRemovalAfterCutoff default true; false also covers images first removed before the
 *             cutoff, when the first or latest removal was reasoned `poi`
 *   ratings   comma-separated ratings the first removal must have recorded, default `None` (PG)
 *   label     recorded in each row's reason with the rule's inputs, default `poi-policy`
 *   createdBy recorded on each row
 *   probe     comma-separated image ids; says which of them the rule exempts
 *
 * Needs the RemovalScoreExemption migration applied. Writes only exemption rows. The nightly
 * user-score job re-scores their owners on its next run and grants any tier reached, through its
 * usual path. Safe to re-run: images already exempted are skipped.
 */
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const parsed = backfillExemptionParams.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const { label, createdBy, probe, dryRun, ...rule } = parsed.data;
  const reason = exemptionReason(rule, label);

  const removals = await findPolicyChangeRemovals(clickhouse, pgDbReadLong, rule);
  const byOwner = new Map<number, number>();
  for (const { ownerId } of removals)
    byOwner.set(Number(ownerId), (byOwner.get(Number(ownerId)) ?? 0) + 1);

  const { reportsAgainst } = await getScoreMultipliers();
  const pointsPerRemoval = Math.abs(reportsAgainst);
  const exempted = new Set(removals.map((r) => Number(r.imageId)));
  const summary = {
    dryRun,
    reason,
    images: removals.length,
    owners: byOwner.size,
    pointsRestored: removals.length * pointsPerRemoval,
    tierUps: await previewTierUps(pgDbReadLong, byOwner, pointsPerRemoval),
    probe: probe && Object.fromEntries(probe.map((id) => [id, exempted.has(id)])),
  };
  if (dryRun) return res.status(200).json(summary);

  const inserted = await insertRemovalScoreExemptions(
    pgDbWrite,
    [...exempted],
    reason,
    createdBy ?? null
  );
  return res.status(200).json({ ...summary, inserted });
});
