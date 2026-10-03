import { CompiledQuery, sql, type Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import { BLOCKED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
import type { DB as ModeratorDB } from './moderator-db/types';
import { csamExcludedImageIds } from './relabel-csam-exclusion';
import { UPSERT_RELABEL_ITEM_SQL } from './relabel-item-upsert';
import { deprecatedNsfwName } from '../nsfw-levels';
import { MINOR_BUCKETS } from '../removal-label/compose';
import { allocate, isMinorBucket, scoreBand, type Candidate } from '../removal-label/sampling';

/**
 * Builds one batch of the removal-label relabel set. Called daily by the main app's
 * `relabel-build-batch` job through the `relabel-build-batch` mod-action, and by
 * `removal-label-eval/build-set.ts` by hand.
 *
 * Removed images are hard-deleted `BLOCKED_IMAGE_RETENTION_DAYS` after the block, so removed items
 * are drawn from the last `days` and carry `purge_after`.
 *
 * `removed` and `notRemoved` are caps on what the batch holds, not on what one run adds: a run
 * fills only what the batch is still short of, so a re-run after a complete run adds nothing and a
 * re-run after a crashed one finishes it.
 */

export type ClickhouseQuery = <T extends object>(query: string) => Promise<T[]>;

export type RelabelBuildOptions = {
  batch: string;
  removed: number;
  notRemoved: number;
  days: number;
  /** Ascending scanner minor-score edges. `null` skips the not-removed stratum entirely. */
  bands: number[] | null;
  seed?: string;
  dryRun: boolean;
  /** Items the model arms run on but labelers never see. */
  modelOnly?: boolean;
};

type Strata<T> = { removed: T; notRemoved: T };

export type RelabelBuildSummary = {
  batch: string;
  dryRun: boolean;
  modelOnly: boolean;
  notRemovedSkipped: 'bands unset' | null;
  candidates: Strata<number>;
  csamExcluded: Strata<number>;
  alreadyInSet: number;
  alreadyInBatch: Strata<number>;
  picked: Strata<number>;
  /** `<stratum> <stratumKey>` → items picked. */
  strata: Record<string, number>;
  inserted: number;
  promoted: number;
};

export const MAX_RELABEL_DAYS = BLOCKED_IMAGE_RETENTION_DAYS - 1;

/** `RELABEL_NOT_REMOVED_BANDS` / `--bands`: comma-separated edges in (0, 1). Empty is `null`. */
export function parseBands(raw: string | undefined): number[] | null {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const bands = parts.map(Number).sort((a, b) => a - b);
  if (bands.some((b) => !(b > 0 && b < 1))) throw new Error('bands must be scores in (0, 1)');
  return bands;
}

type RemovalRow = {
  imageId: number;
  bucket: string;
  removedAt: number;
  removedBy: number;
  nsfw: string;
};

async function fetchRemovals(ch: ClickhouseQuery, days: number): Promise<RemovalRow[]> {
  const bucketList = MINOR_BUCKETS.map((b) => `'${b}'`).join(',');
  // First removal per image: a re-removal must not move the clock or the label.
  const rows = await ch<RemovalRow>(`
    SELECT imageId,
           argMin(violationType, time) AS bucket,
           toUnixTimestamp(min(time)) AS removedAt,
           argMin(userId, time) AS removedBy,
           toString(argMin(nsfw, time)) AS nsfw
    FROM images
    WHERE type = 'DeleteTOS' AND mediaType = 'image'
      AND violationType IN (${bucketList})
      AND time > now() - INTERVAL ${days} DAY
    GROUP BY imageId
  `);
  // A 64-bit column can arrive quoted; a string id would miss every numeric Set and Map below,
  // the CSAM exclusion among them.
  return rows.map((r) => ({
    ...r,
    imageId: Number(r.imageId),
    removedAt: Number(r.removedAt),
    removedBy: Number(r.removedBy),
  }));
}

async function fetchMinorScores(
  ch: ClickhouseQuery,
  days: number,
  limit: number,
  seed: string
): Promise<Map<number, number>> {
  const seedLiteral = seed.replace(/[^A-Za-z0-9_-]/g, '');
  // An image row's contentHash is derived from its image id (`scanner-audit.service.ts`), so a group
  // holds one image; GROUP BY only folds parts the merge has not collapsed yet, and the latest score
  // wins so two age-model versions never blend. The CSAM label in this table is never read.
  const rows = await ch<{ ids: (string | number)[]; score: number }>(`
    SELECT groupUniqArrayArray(entityIds) AS ids, argMax(score, lastSeenAt) AS score
    FROM scanner_label_results
    WHERE scanner = 'image_ingestion' AND entityType = 'image' AND label = 'minor'
    GROUP BY contentHash
    HAVING min(firstSeenAt) > now() - INTERVAL ${days} DAY
    ORDER BY cityHash64(contentHash, '${seedLiteral}')
    LIMIT ${limit}
  `);
  return new Map(
    rows.filter((r) => r.ids.length > 0).map((r) => [Number(r.ids[0]), Number(r.score)])
  );
}

const countBy = (cs: Candidate[]) => ({
  removed: cs.filter((c) => c.stratum === 'removed').length,
  notRemoved: cs.filter((c) => c.stratum === 'not_removed').length,
});

export async function buildRelabelBatch(
  opts: RelabelBuildOptions,
  deps: { clickhouse: ClickhouseQuery; replica: Kysely<MainDB>; moderator: Kysely<ModeratorDB> }
): Promise<RelabelBuildSummary> {
  if (!(opts.days >= 1 && opts.days <= MAX_RELABEL_DAYS))
    throw new Error(`days must be 1-${MAX_RELABEL_DAYS}: older removals are purged`);
  const seed = opts.seed ?? opts.batch;
  const modelOnly = opts.modelOnly ?? false;
  const { replica, moderator } = deps;

  const removals = await fetchRemovals(deps.clickhouse, opts.days);
  const scoreById = opts.bands
    ? await fetchMinorScores(
        deps.clickhouse,
        opts.days,
        Math.max(200, opts.notRemoved * 20) * (opts.bands.length + 1),
        seed
      )
    : new Map<number, number>();

  const ids = [...new Set([...removals.map((r) => r.imageId), ...scoreById.keys()])];
  const images = ids.length
    ? await replica
        .selectFrom('Image')
        .select(['id', 'userId', 'ingestion', 'needsReview', 'blockedFor', 'nsfwLevel', 'type'])
        .where('id', 'in', ids)
        .execute()
    : [];
  const imageById = new Map(images.map((i) => [i.id, i]));

  let candidates: Candidate[] = [];
  for (const r of removals) {
    const img = imageById.get(r.imageId);
    if (!img || img.type !== 'image' || img.ingestion !== 'Blocked' || !isMinorBucket(r.bucket))
      continue;
    candidates.push({
      imageId: r.imageId,
      ownerId: img.userId,
      stratum: 'removed',
      bucket: r.bucket,
      nsfwLevel: r.nsfw,
      stratumKey: `${r.bucket}:${r.nsfw}`,
    });
  }
  for (const [imageId, score] of scoreById) {
    const img = imageById.get(imageId);
    if (
      !img ||
      img.type !== 'image' ||
      img.ingestion !== 'Scanned' ||
      img.needsReview !== null ||
      img.blockedFor !== null
    )
      continue;
    const level = deprecatedNsfwName(img.nsfwLevel);
    candidates.push({
      imageId,
      ownerId: img.userId,
      stratum: 'not_removed',
      bucket: null,
      nsfwLevel: level,
      // `bands` is non-null here: the score map is empty without it.
      stratumKey: `band${scoreBand(score, opts.bands ?? [])}:${level}`,
    });
  }

  const before = countBy(candidates);
  const excluded = new Set(
    candidates.length
      ? (await csamExcludedImageIds(candidates.map((c) => c.imageId)).execute(replica)).rows.map(
          (r) => r.id
        )
      : []
  );
  candidates = candidates.filter((c) => !excluded.has(c.imageId));
  const after = countBy(candidates);

  const removedIds = candidates.filter((c) => c.stratum === 'removed').map((c) => c.imageId);
  const appeals = new Map<number, { status: string; resolvedAt: Date | null }>();
  if (removedIds.length) {
    const rows = await replica
      .selectFrom('Appeal')
      .distinctOn('entityId')
      .select(['entityId', 'status', 'resolvedAt'])
      .where('entityType', '=', 'Image')
      .where('entityId', 'in', removedIds)
      .orderBy('entityId')
      .orderBy('createdAt', 'desc')
      .execute();
    for (const a of rows) appeals.set(a.entityId, { status: a.status, resolvedAt: a.resolvedAt });
  }
  const removalById = new Map(removals.map((r) => [r.imageId, r]));

  return moderator.transaction().execute(async (trx) => {
    // Serialises two runs of one batch, which would otherwise each read the same shortfall and
    // together overshoot the cap.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`relabel-batch:${opts.batch}`}))`.execute(
      trx
    );

    const present = candidates.length
      ? await trx
          .selectFrom('relabel_item')
          .select(['image_id', 'relabel'])
          .where(
            'image_id',
            'in',
            candidates.map((c) => c.imageId)
          )
          .execute()
      : [];
    // A model-only build skips anything present; a labeler build skips only what labelers already
    // have, so a model-only row stays available to be promoted.
    const already = new Set(present.filter((r) => modelOnly || r.relabel).map((r) => r.image_id));
    const pool = candidates.filter((c) => !already.has(c.imageId));

    const held = await trx
      .selectFrom('relabel_item')
      .select(['stratum', sql<number>`count(*)::int`.as('n')])
      .where('batch', '=', opts.batch)
      .where('relabel', '=', !modelOnly)
      .groupBy('stratum')
      .execute();
    const inBatch = (stratum: string) => held.find((h) => h.stratum === stratum)?.n ?? 0;
    const alreadyInBatch = { removed: inBatch('removed'), notRemoved: inBatch('not_removed') };

    const picked = [
      ...allocate(
        pool.filter((c) => c.stratum === 'removed'),
        Math.max(0, opts.removed - alreadyInBatch.removed),
        seed
      ),
      ...allocate(
        pool.filter((c) => c.stratum === 'not_removed'),
        Math.max(0, opts.notRemoved - alreadyInBatch.notRemoved),
        seed
      ),
    ];

    const strata: Record<string, number> = {};
    for (const p of picked) {
      const key = `${p.stratum} ${p.stratumKey}`;
      strata[key] = (strata[key] ?? 0) + 1;
    }

    let inserted = 0;
    let promoted = 0;
    if (!opts.dryRun) {
      for (const p of picked) {
        const removal = removalById.get(p.imageId);
        const removedAt = removal ? new Date(removal.removedAt * 1000) : null;
        const appeal = appeals.get(p.imageId);
        const res = await trx.executeQuery<{ inserted: boolean }>(
          CompiledQuery.raw(UPSERT_RELABEL_ITEM_SQL, [
            opts.batch,
            p.imageId,
            p.stratum,
            p.bucket,
            p.nsfwLevel,
            p.stratumKey,
            p.ownerId,
            removedAt,
            removal?.removedBy ?? null,
            removedAt
              ? new Date(removedAt.getTime() + BLOCKED_IMAGE_RETENTION_DAYS * 24 * 3600 * 1000)
              : null,
            appeal?.status ?? null,
            appeal?.resolvedAt ?? null,
            !modelOnly,
          ])
        );
        for (const r of res.rows) {
          if (r.inserted) inserted++;
          else promoted++;
        }
      }
    }

    return {
      batch: opts.batch,
      dryRun: opts.dryRun,
      modelOnly,
      notRemovedSkipped: opts.bands ? null : 'bands unset',
      candidates: before,
      csamExcluded: {
        removed: before.removed - after.removed,
        notRemoved: before.notRemoved - after.notRemoved,
      },
      alreadyInSet: already.size,
      alreadyInBatch,
      picked: countBy(picked),
      strata,
      inserted,
      promoted,
    };
  });
}
