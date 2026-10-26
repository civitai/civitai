import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import {
  getScoreMultipliers,
  raiseImagesScores,
  subtractImagesScores,
} from '~/server/jobs/update-user-score';
import { imageScoresAsOf, planImageScoreRaise } from '~/server/services/image-score-raise.service';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off, removed after use: raise owners' creator-score `images` category to its from-source value,
 * never lowering one. Driven in batches of owners by a script that keeps the ledger.
 *
 *   POST /api/admin/temp/raise-image-scores?token=$WEBHOOK_TOKEN             (dry run)
 *   POST /api/admin/temp/raise-image-scores?token=$WEBHOOK_TOKEN&dryRun=false
 *
 * Body, one of:
 *   { "mode": "raise", "ownerIds": [...] }                    plan, and write the raises
 *   { "mode": "raiseValues", "checkpoint": <ms>, "rows": [{ "ownerId", "expected", "next" }] }
 *                                                             write values the driver computed as of
 *                                                             `checkpoint`; 409 once the cron has moved it
 *   { "mode": "rollback", "rows": [{ "ownerId", "added" }] }  take a ledger's raises back off
 *   { "mode": "read", "ownerIds": [...] }                      current images score, for the readback
 *
 * The value is as of the cron's images checkpoint, so the next cron run adds its window once. A write
 * that loses a race with the cron writes nothing and comes back in `skippedRace` for a retry. Grants and
 * notifies nothing.
 */

const CHECKPOINT_KEY = 'update-user-score:images';
const RAISED_STAMP = 'imageScoreRaisedAt';
const ROLLED_BACK_STAMP = 'imageScoreRaiseRolledBackAt';
const MAX_OWNERS = 500;

const ownerId = z.number().int().positive();
const ids = z.array(ownerId).min(1).max(MAX_OWNERS);
const body = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('raise'), ownerIds: ids }),
  z.object({ mode: z.literal('read'), ownerIds: ids }),
  z.object({
    mode: z.literal('raiseValues'),
    checkpoint: z.number().int().positive(),
    rows: z
      .array(
        z.object({
          ownerId,
          expected: z.number().nonnegative().nullable(),
          next: z.number().positive(),
        })
      )
      .min(1)
      .max(MAX_OWNERS)
      .refine((rows) => new Set(rows.map((r) => r.ownerId)).size === rows.length, {
        message: 'duplicate ownerId',
      }),
  }),
  z.object({
    mode: z.literal('rollback'),
    rows: z
      .array(z.object({ ownerId, added: z.number().positive() }))
      .min(1)
      .max(MAX_OWNERS),
  }),
]);
const query = z.object({ dryRun: booleanString().default(true) });

async function storedImages(ownerIds: number[]) {
  const rows = await pgDbWrite
    .cancellableQuery<{ id: number; images: string | null; total: string | null }>(
      `SELECT id, (meta->'scores'->>'images') AS images, (meta->'scores'->>'total') AS total
       FROM "User" WHERE id = ANY($1::int[])`,
      [ownerIds]
    )
    .then((q) => q.result());
  return rows.map((r) => ({
    ownerId: Number(r.id),
    images: r.images == null ? null : Number(r.images),
    total: r.total == null ? null : Number(r.total),
  }));
}

async function writeRaises(
  raises: { ownerId: number; expected: number | null; next: number }[],
  checkpoint: number,
  at: Date
) {
  const written = await raiseImagesScores(
    pgDbWrite,
    raises.map((r) => ({ id: r.ownerId, expected: r.expected, next: r.next })),
    {
      checkpoint: { key: CHECKPOINT_KEY, value: checkpoint },
      stamp: { key: RAISED_STAMP, at },
    }
  );
  const writtenIds = new Set(written.map((w) => w.userId));
  return {
    written: written.map((w) => ({
      ownerId: w.userId,
      beforeImages: w.oldImages,
      afterImages: w.newImages,
      beforeTotal: w.oldTotal,
      afterTotal: w.newTotal,
    })),
    skippedRace: raises.filter((r) => !writtenIds.has(r.ownerId)).map((r) => r.ownerId),
  };
}

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { dryRun } = query.parse(req.query);
  const input = body.parse(req.body);

  if (input.mode === 'read')
    return res.status(200).json({ rows: await storedImages(input.ownerIds) });

  if (input.mode === 'rollback') {
    if (dryRun) return res.status(200).json({ dryRun, wouldRollBack: input.rows.length });
    const rolledBack = await subtractImagesScores(
      pgDbWrite,
      input.rows.map((r) => [r.ownerId, r.added]),
      { key: ROLLED_BACK_STAMP, at: new Date() }
    );
    return res.status(200).json({ dryRun, rolledBack });
  }

  const checkpoint = await dbWrite.keyValue.findUnique({ where: { key: CHECKPOINT_KEY } });
  if (typeof checkpoint?.value !== 'number')
    return res.status(409).json({ error: `no ${CHECKPOINT_KEY} checkpoint` });
  const excluded = new Set(await getMetricExcludedUserIdsOrThrow());
  const now = new Date();

  if (input.mode === 'raiseValues') {
    // The values were computed as of `input.checkpoint`; once the cron has moved it they are stale.
    if (input.checkpoint !== checkpoint.value)
      return res
        .status(409)
        .json({ error: 'checkpoint moved', checkpoint: checkpoint.value, sent: input.checkpoint });

    // Ids with no User row drop out here, so they never come back as a race.
    const stored = new Map(
      (await storedImages(input.rows.map((r) => r.ownerId))).map((r) => [r.ownerId, r.images])
    );
    const rows = input.rows.filter((r) => stored.has(r.ownerId));
    const byOwner = new Map(rows.map((r) => [r.ownerId, r]));
    const plan = planImageScoreRaise(
      stored,
      new Map(rows.map((r) => [r.ownerId, r.next])),
      excluded
    ).map((p) => {
      const { expected } = byOwner.get(p.ownerId)!;
      // Already at the sent value (a re-run) is `equal`, whatever the driver read.
      const stale = (p.action === 'raise' || p.action === 'down') && p.stored !== expected;
      return { ...p, expected, action: stale ? ('stale' as const) : p.action };
    });
    const raises = plan.filter((p) => p.action === 'raise');
    const counts = {
      considered: plan.length,
      raise: raises.length,
      equal: plan.filter((p) => p.action === 'equal').length,
      down: plan.filter((p) => p.action === 'down').length,
      excluded: plan.filter((p) => p.action === 'excluded').length,
      stale: plan.filter((p) => p.action === 'stale').length,
    };
    if (dryRun)
      return res.status(200).json({ dryRun, checkpoint: checkpoint.value, ...counts, plan });

    const result = await writeRaises(
      raises.map((p) => ({ ownerId: p.ownerId, expected: p.expected, next: p.recomputed })),
      checkpoint.value,
      now
    );
    return res.status(200).json({ dryRun, checkpoint: checkpoint.value, ...counts, ...result });
  }

  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const { images: multipliers } = await getScoreMultipliers();

  // Ids with no User row drop out here, so they never come back as a race.
  const stored = new Map((await storedImages(input.ownerIds)).map((r) => [r.ownerId, r.images]));
  const recomputed = await imageScoresAsOf({
    ownerIds: [...stored.keys()],
    since: new Date(checkpoint.value),
    now,
    multipliers,
    excluded,
    pg: pgDbRead,
    pgLong: pgDbReadLong,
    ch: clickhouse,
  });
  const plan = planImageScoreRaise(stored, recomputed, excluded);
  const raises = plan.filter((p) => p.action === 'raise');
  const counts = {
    considered: plan.length,
    raise: raises.length,
    equal: plan.filter((p) => p.action === 'equal').length,
    down: plan.filter((p) => p.action === 'down').length,
    excluded: plan.filter((p) => p.action === 'excluded').length,
  };
  if (dryRun)
    return res.status(200).json({ dryRun, checkpoint: checkpoint.value, ...counts, plan });

  const result = await writeRaises(
    raises.map((p) => ({ ownerId: p.ownerId, expected: p.stored, next: p.recomputed })),
    checkpoint.value,
    now
  );
  return res.status(200).json({ dryRun, checkpoint: checkpoint.value, ...counts, ...result });
});
