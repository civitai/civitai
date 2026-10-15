import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import {
  applyUserScoreUpdates,
  countSelfGenerations,
  getScoreMultipliers,
  scoreModelOwners,
  SELF_GENERATION_OWNER_BATCH,
  writeSelfGenerations,
} from '~/server/jobs/update-user-score';
import type {
  ScoreTier,
  StoredScores,
} from '~/server/services/creator-score-self-activity.service';
import {
  countSelfImageEngagement,
  IMAGE_SELF_EXCLUDED_STAMP,
  imagesScoreWithoutSelf,
  summariseScoreChanges,
} from '~/server/services/creator-score-self-activity.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off: take creators' own past reactions, comments and generations out of their Creator Score,
 * which the nightly job stopped counting going forward. Reports, per tier held by the stored total,
 * how many owners move up, down, or below that tier. Grants nothing and revokes nothing.
 *
 *   GET /api/admin/temp/recompute-self-activity?token=$WEBHOOK_TOKEN                     (dry run)
 *   GET /api/admin/temp/recompute-self-activity?token=$WEBHOOK_TOKEN&dryRun=false&before=<ISO>
 *
 *   before   required to write: when the nightly exclusion went live. Own reactions and comments
 *            from before it come out of `images`; later ones the nightly job never counted.
 *   part     `all` (default), `models` or `images`
 *
 * Safe to re-run: `models` is recomputed from scratch, and an owner whose `images` already lost
 * their own engagement is stamped and skipped. Slow (it walks every image of every image owner);
 * drive it from the no-timeout dev server.
 */

const schema = z
  .object({
    dryRun: booleanString().default(true),
    before: z.coerce.date().optional(),
    part: z.enum(['all', 'models', 'images']).default('all'),
    concurrency: z.coerce.number().min(1).max(10).default(3),
    batchSize: z.coerce.number().min(1).max(10_000).default(1000),
  })
  .refine((p) => p.dryRun || p.before, {
    message: '`before` is required to write',
    path: ['before'],
  });

// Past every checkpoint, so the model scorer re-scores only the owners it is handed.
const NO_CHANGES_SINCE = new Date('2999-01-01T00:00:00Z');

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const { dryRun, part, concurrency, batchSize } = parsed.data;
  const before = parsed.data.before ?? new Date();
  const multipliers = await getScoreMultipliers();

  const changes = new Map<number, { models?: number; images?: number }>();
  const stats = { modelOwners: 0, selfGenerators: 0, imageOwners: 0, selfEngagers: 0 };

  if (part !== 'images') {
    const owners = await pgDbReadLong
      .cancellableQuery<{ userId: number }>(
        `SELECT DISTINCT mm."userId" FROM "ModelMetric" mm WHERE mm."generationCount" > 0`
      )
      .then((q) => q.result());
    stats.modelOwners = owners.length;
    for (const batch of chunk(
      owners.map((o) => o.userId),
      SELF_GENERATION_OWNER_BATCH
    )) {
      const rows = await countSelfGenerations(clickhouse, pgDbReadLong, batch);
      const selfGenerators = [...new Set(rows.map((r) => r.userId))];
      stats.selfGenerators += selfGenerators.length;
      if (!dryRun) await writeSelfGenerations(pgDbWrite, batch, rows);
      await scoreModelOwners(
        {
          pg: pgDbReadLong,
          jobContext: { on: () => undefined } as never,
          scoreMultipliers: multipliers,
          lastUpdate: NO_CHANGES_SINCE,
          setScore: (userId, _category, score) =>
            changes.set(userId, { ...changes.get(userId), models: Number(score) }),
        },
        { alsoRescore: selfGenerators, selfGenerations: rows }
      );
    }
  }

  const storedByUser = new Map<number, StoredScores>();
  if (part !== 'models') {
    const owners = await pgDbReadLong
      .cancellableQuery<{ id: number }>(
        `SELECT id FROM "User"
         WHERE (meta->'scores'->>'images')::numeric > 0
           AND (meta->'scores'->>'${IMAGE_SELF_EXCLUDED_STAMP}') IS NULL`
      )
      .then((q) => q.result());
    stats.imageOwners = owners.length;
    const tasks = chunk(
      owners.map((o) => o.id),
      batchSize
    ).map((batch) => async () => {
      const self = await countSelfImageEngagement(pgDbReadLong, batch, before);
      const engagers = [...self.keys()];
      stats.selfEngagers += engagers.length;
      for (const [userId, stored] of await readStoredScores(engagers)) {
        storedByUser.set(userId, stored);
        changes.set(userId, {
          ...changes.get(userId),
          images: imagesScoreWithoutSelf(stored.images ?? 0, self.get(userId), multipliers.images),
        });
      }
    });
    await limitConcurrency(tasks, concurrency);
  }

  const missing = [...changes.keys()].filter((id) => !storedByUser.has(id));
  for (const [userId, stored] of await readStoredScores(missing)) storedByUser.set(userId, stored);

  const tiers = await pgDbReadLong
    .cancellableQuery<ScoreTier>(
      `SELECT key, threshold FROM "CreatorMilestone"
       WHERE track = 'score' AND threshold IS NOT NULL ORDER BY threshold`
    )
    .then((q) => q.result());
  const { changed, byTier } = summariseScoreChanges(changes, storedByUser, tiers);

  if (dryRun)
    return res
      .status(200)
      .json({ dryRun, part, before, ...stats, changed: changed.length, byTier });

  let written = 0;
  const stampedAt = new Date().toISOString();
  for (const records of chunk(changed, 500)) {
    written += (await applyUserScoreUpdates(pgDbWrite, records)).length;
    const imageIds = records.filter(([, c]) => c.images !== undefined).map(([id]) => +id);
    if (!imageIds.length) continue;
    await pgDbWrite
      .cancellableQuery(
        `UPDATE "User"
         SET meta = jsonb_set(COALESCE(meta, '{}'), '{scores,${IMAGE_SELF_EXCLUDED_STAMP}}', to_jsonb($1::text))
         WHERE id = ANY($2::int[])`,
        [stampedAt, imageIds]
      )
      .then((q) => q.result());
  }
  return res
    .status(200)
    .json({ dryRun, part, before, ...stats, changed: changed.length, byTier, written });
});

async function readStoredScores(ids: number[]) {
  const result = new Map<number, StoredScores>();
  for (const batch of chunk(ids, 10_000)) {
    const rows = await pgDbReadLong
      .cancellableQuery<{ id: number; scores: Record<string, unknown> | null }>(
        `SELECT id, meta->'scores' AS scores FROM "User" WHERE id = ANY($1::int[])`,
        [batch]
      )
      .then((q) => q.result());
    for (const { id, scores } of rows) {
      const parsed: StoredScores = {};
      for (const [key, value] of Object.entries(scores ?? {})) {
        const n = Number(value);
        if (Number.isFinite(n)) parsed[key as keyof StoredScores] = n;
      }
      result.set(id, parsed);
    }
  }
  return result;
}
