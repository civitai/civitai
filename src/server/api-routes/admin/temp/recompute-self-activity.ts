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
  SELF_EXCLUSION_SINCE_KEY,
  SELF_GENERATION_OWNER_BATCH,
  subtractImagesScores,
  writeSelfGenerations,
} from '~/server/jobs/update-user-score';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import type {
  ScoreTier,
  StoredScores,
} from '~/server/services/creator-score-self-activity.service';
import {
  countSelfImageEngagement,
  IMAGE_SELF_EXCLUDED_STAMP,
  imagesScoreWithoutSelf,
  listImageOwnersToExclude,
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
 *   GET /api/admin/temp/recompute-self-activity?token=$WEBHOOK_TOKEN                (dry run)
 *   GET /api/admin/temp/recompute-self-activity?token=$WEBHOOK_TOKEN&dryRun=false
 *
 *   part   `all` (default), `models` or `images`
 *
 * Own reactions and comments come out of `images` only from before the nightly job's first run
 * that left them out (it records that point); later ones it never counted. Writing refuses until
 * that run has happened. Owners the metrics exclude were never credited, so nothing comes off them.
 *
 * Safe to re-run: `models` is recomputed from scratch, and the `images` subtraction stamps each owner
 * in the same statement and skips stamped ones. Slow (it walks every image of every image owner);
 * drive it from the no-timeout dev server, and not across the nightly score job.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  part: z.enum(['all', 'models', 'images']).default('all'),
  concurrency: z.coerce.number().min(1).max(10).default(3),
  batchSize: z.coerce.number().min(1).max(10_000).default(1000),
});

// Past every checkpoint, so the model scorer re-scores only the owners it is handed.
const NO_CHANGES_SINCE = new Date('2999-01-01T00:00:00Z');

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const { dryRun, part, concurrency, batchSize } = parsed.data;

  const recorded = await pgDbWrite
    .cancellableQuery<{ value: number }>(`SELECT value FROM "KeyValue" WHERE key = $1`, [
      SELF_EXCLUSION_SINCE_KEY,
    ])
    .then((q) => q.result());
  const exclusionSince = recorded[0] ? new Date(Number(recorded[0].value)) : null;
  if (!dryRun && part !== 'models' && !exclusionSince)
    return res.status(409).json({
      error: 'The nightly score job has not yet run with the exclusion; nothing to cut off',
    });
  const before = exclusionSince ?? new Date();
  const multipliers = await getScoreMultipliers();

  const changes = new Map<number, { models?: number; images?: number }>();
  const imageSelfPoints = new Map<number, number>();
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
    const excluded = new Set(await getMetricExcludedUserIdsOrThrow());
    const owners = (await listImageOwnersToExclude(pgDbReadLong)).filter((id) => !excluded.has(id));
    stats.imageOwners = owners.length;
    const tasks = chunk(owners, batchSize).map((batch) => async () => {
      const self = await countSelfImageEngagement(pgDbReadLong, batch, before);
      const engagers = [...self.keys()];
      stats.selfEngagers += engagers.length;
      for (const [userId, stored] of await readStoredScores(engagers)) {
        const engagement = self.get(userId);
        if (!engagement) continue;
        storedByUser.set(userId, stored);
        imageSelfPoints.set(
          userId,
          engagement.reactions * multipliers.images.reactions +
            engagement.comments * multipliers.images.comments
        );
        changes.set(userId, {
          ...changes.get(userId),
          images: imagesScoreWithoutSelf(stored.images ?? 0, engagement, multipliers.images),
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
  const report = { dryRun, part, before, ...stats, changed: changed.length, byTier };

  if (dryRun) return res.status(200).json(report);

  let modelsWritten = 0;
  const models = changed.flatMap(([id, change]) =>
    change.models === undefined
      ? []
      : [[id, { models: change.models }] as [string, { models: number }]]
  );
  for (const records of chunk(models, 500))
    modelsWritten += (await applyUserScoreUpdates(pgDbWrite, records)).length;

  let imagesWritten = 0;
  const stamp = { key: IMAGE_SELF_EXCLUDED_STAMP, at: new Date() };
  for (const rows of chunk([...imageSelfPoints], 500))
    imagesWritten += (await subtractImagesScores(pgDbWrite, rows, stamp)).length;

  return res.status(200).json({ ...report, modelsWritten, imagesWritten });
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
