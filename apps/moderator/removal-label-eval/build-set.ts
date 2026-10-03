/**
 * Builds one batch of the removal-label relabel set.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/removal-label-eval/build-set.ts \
 *     --batch 2026-10-06 --removed 100 --not-removed 40 --bands <edges>
 *
 * Dry run unless `--write` is given: prints per-stratum counts and writes nothing. With `--write` it
 * inserts into the MODERATOR database only. Read-only against ClickHouse and the main replica.
 *
 * Run it daily: removed images are hard-deleted 7 days after the block, so removed items are drawn
 * from the last `--days` (default 5) and must be labelled before `purge_after`. An image already in
 * the set is never added again.
 *
 * `--model-only` adds items the model arms run on but labelers never see, for the full-population
 * disagreement and appeal numbers.
 *
 * `--bands` are the scanner minor-score edges for the not-removed stratum. Pass them at run time;
 * they are not written into this repo.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import { BLOCKED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
import { clickhouse, type ClickHouseConfig } from '../xguard-lab/sample-core';
import { deprecatedNsfwName } from '../src/lib/nsfw-levels';
import { MINOR_BUCKETS } from '../src/lib/removal-label/compose';
import { csamExcludedImageIds } from '../src/lib/removal-label/csam-exclusion';
import {
  allocate,
  insertOrder,
  isMinorBucket,
  scoreBand,
  type Candidate,
} from '../src/lib/removal-label/sampling';

type Args = {
  batch: string;
  removed: number;
  notRemoved: number;
  days: number;
  bands: number[];
  seed: string;
  write: boolean;
  modelOnly: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const batch = get('--batch');
  if (!batch) throw new Error('--batch is required');
  const days = Number(get('--days') ?? 5);
  if (!(days >= 1 && days < BLOCKED_IMAGE_RETENTION_DAYS))
    throw new Error(
      `--days must be 1-${BLOCKED_IMAGE_RETENTION_DAYS - 1}: older removals are purged`
    );
  const bands = (get('--bands') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  if (bands.some((b) => !(b > 0 && b < 1))) throw new Error('--bands must be scores in (0, 1)');
  return {
    batch,
    removed: Number(get('--removed') ?? 100),
    notRemoved: Number(get('--not-removed') ?? 40),
    days,
    bands,
    seed: get('--seed') ?? batch,
    write: argv.includes('--write'),
    modelOnly: argv.includes('--model-only'),
  };
}

function clickhouseConfig(): ClickHouseConfig {
  const host = process.env.CLICKHOUSE_HOST;
  if (!host) throw new Error('CLICKHOUSE_HOST not set');
  return {
    host,
    username: process.env.CLICKHOUSE_USERNAME,
    password: process.env.CLICKHOUSE_PASSWORD,
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

type Removal = {
  imageId: number;
  bucket: string;
  removedAt: number;
  removedBy: number;
  nsfw: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ch = clickhouseConfig();
  const bucketList = MINOR_BUCKETS.map((b) => `'${b}'`).join(',');
  const seedLiteral = args.seed.replace(/[^A-Za-z0-9_-]/g, '');

  // First removal per image: a re-removal must not move the clock or the label.
  const removals = await clickhouse<Removal>(
    `
    SELECT imageId,
           argMin(violationType, time) AS bucket,
           toUnixTimestamp(min(time)) AS removedAt,
           argMin(userId, time) AS removedBy,
           toString(argMin(nsfw, time)) AS nsfw
    FROM images
    WHERE type = 'DeleteTOS' AND mediaType = 'image'
      AND violationType IN (${bucketList})
      AND time > now() - INTERVAL ${args.days} DAY
    GROUP BY imageId
  `,
    ch
  );

  // Not-removed pool. Rows are per content hash, so one row can stand for several images with the
  // same bytes; all of them go through the CSAM check, and only the lowest id is sampled. The CSAM
  // label in this table is never read.
  const perBand = Math.max(200, args.notRemoved * 20);
  const scanned = await clickhouse<{ ids: string[]; score: number }>(
    `
    SELECT groupUniqArrayArray(entityIds) AS ids, anyLast(score) AS score
    FROM scanner_label_results
    WHERE scanner = 'image_ingestion' AND entityType = 'image' AND label = 'minor'
    GROUP BY contentHash
    HAVING min(firstSeenAt) > now() - INTERVAL ${args.days} DAY
    ORDER BY cityHash64(contentHash, '${seedLiteral}')
    LIMIT ${perBand * (args.bands.length + 1)}
  `,
    ch
  );
  const hashGroups = scanned
    .map((s) => ({ ids: s.ids.map(Number).sort((a, b) => a - b), score: s.score }))
    .filter((g) => g.ids.length > 0);

  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_REPLICA_URL') });
  const replica = new Kysely<MainDB>({ dialect: new PostgresDialect({ pool }) });
  let removedCandidates: Candidate[] = [];
  let notRemovedCandidates: Candidate[] = [];
  const appeals = new Map<number, { status: string; resolvedAt: Date | null }>();
  try {
    const ids = [
      ...new Set([...removals.map((r) => r.imageId), ...hashGroups.map((g) => g.ids[0])]),
    ];
    const images = await replica
      .selectFrom('Image')
      .select(['id', 'userId', 'ingestion', 'needsReview', 'blockedFor', 'nsfwLevel', 'type'])
      .where('id', 'in', ids)
      .execute();
    const imageById = new Map(images.map((i) => [i.id, i]));

    for (const r of removals) {
      const img = imageById.get(r.imageId);
      if (!img || img.type !== 'image' || img.ingestion !== 'Blocked' || !isMinorBucket(r.bucket))
        continue;
      removedCandidates.push({
        imageId: r.imageId,
        ownerId: img.userId,
        stratum: 'removed',
        bucket: r.bucket,
        nsfwLevel: r.nsfw,
        stratumKey: `${r.bucket}:${r.nsfw}`,
      });
    }
    const siblingsOf = new Map<number, number[]>();
    for (const g of hashGroups) {
      const imageId = g.ids[0];
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
      siblingsOf.set(imageId, g.ids);
      notRemovedCandidates.push({
        imageId,
        ownerId: img.userId,
        stratum: 'not_removed',
        bucket: null,
        nsfwLevel: level,
        stratumKey: `band${scoreBand(g.score, args.bands)}:${level}`,
      });
    }

    const toCheck = [
      ...removedCandidates.map((c) => c.imageId),
      ...notRemovedCandidates.flatMap((c) => siblingsOf.get(c.imageId) ?? [c.imageId]),
    ];
    const excluded = new Set(
      (await csamExcludedImageIds(toCheck).execute(replica)).rows.map((r) => r.id)
    );
    const before = { removed: removedCandidates.length, notRemoved: notRemovedCandidates.length };
    removedCandidates = removedCandidates.filter((c) => !excluded.has(c.imageId));
    notRemovedCandidates = notRemovedCandidates.filter(
      (c) => !(siblingsOf.get(c.imageId) ?? [c.imageId]).some((id) => excluded.has(id))
    );
    console.log(
      `CSAM exclusion: removed ${before.removed} -> ${removedCandidates.length}, not removed ${before.notRemoved} -> ${notRemovedCandidates.length}`
    );

    const appealRows = await replica
      .selectFrom('Appeal')
      .distinctOn('entityId')
      .select(['entityId', 'status', 'resolvedAt'])
      .where('entityType', '=', 'Image')
      .where(
        'entityId',
        'in',
        removedCandidates.length ? removedCandidates.map((c) => c.imageId) : [0]
      )
      .orderBy('entityId')
      .orderBy('createdAt', 'desc')
      .execute();
    for (const a of appealRows)
      appeals.set(a.entityId, { status: a.status, resolvedAt: a.resolvedAt });
  } finally {
    await replica.destroy();
  }

  // The cluster needs `?sslmode=no-verify` on this URL; a local docker Postgres needs none.
  const mod = new pg.Client({ connectionString: requireEnv('MODERATOR_DATABASE_URL') });
  await mod.connect();
  try {
    const { rows: present } = await mod.query<{ image_id: number }>(
      'SELECT image_id FROM relabel_item WHERE image_id = ANY($1::int[])',
      [[...removedCandidates, ...notRemovedCandidates].map((c) => c.imageId)]
    );
    const already = new Set(present.map((r) => r.image_id));
    removedCandidates = removedCandidates.filter((c) => !already.has(c.imageId));
    notRemovedCandidates = notRemovedCandidates.filter((c) => !already.has(c.imageId));

    const picked = insertOrder(
      [
        ...allocate(removedCandidates, args.removed, args.seed),
        ...allocate(notRemovedCandidates, args.notRemoved, args.seed),
      ],
      args.seed
    );
    const removalById = new Map(removals.map((r) => [r.imageId, r]));

    const counts = new Map<string, number>();
    for (const p of picked) {
      const key = `${p.stratum} ${p.stratumKey}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [k, n] of [...counts].sort()) console.log(`  ${k}: ${n}`);
    console.log(
      `picked ${picked.length} (removed pool ${removedCandidates.length}, not-removed pool ${notRemovedCandidates.length}, ${already.size} already in the set)`
    );

    if (!args.write) {
      console.log('dry run: nothing written. Pass --write to insert into the moderator database.');
      return;
    }

    let inserted = 0;
    for (const p of picked) {
      const removal = removalById.get(p.imageId);
      const removedAt = removal ? new Date(removal.removedAt * 1000) : null;
      const appeal = appeals.get(p.imageId);
      const res = await mod.query(
        `INSERT INTO relabel_item
           (batch, image_id, stratum, bucket, nsfw_level, stratum_key, owner_id, removed_at, removed_by,
            purge_after, appeal_status, appeal_resolved_at, relabel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (image_id) DO NOTHING`,
        [
          args.batch,
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
          !args.modelOnly,
        ]
      );
      inserted += res.rowCount ?? 0;
    }
    console.log(
      `batch "${args.batch}": ${inserted} inserted, ${picked.length - inserted} already present`
    );
  } finally {
    await mod.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
