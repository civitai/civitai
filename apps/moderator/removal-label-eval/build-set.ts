/**
 * Builds one batch of the removal-label relabel set.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/removal-label-eval/build-set.ts \
 *     --batch 2026-10-06 --removed 100 --not-removed 40 --bands 0.2,0.5,0.8
 *
 * Dry run unless `--write` is given: prints per-stratum counts and writes nothing. With `--write` it
 * inserts into the MODERATOR database only. Read-only against ClickHouse and the main replica.
 *
 * Run it daily: removed images are hard-deleted 7 days after the block, so removed items are drawn
 * from the last `--days` (default 5) and must be labelled before `purge_after`.
 *
 * `--bands` are the scanner minor-score edges for the not-removed stratum. Pass them at run time;
 * they are not written into this repo.
 */
import pg from 'pg';
import { BLOCKED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
import { clickhouse, type ClickHouseConfig } from '../xguard-lab/sample-core';
import { MINOR_BUCKETS } from '../src/lib/removal-label/compose';
import {
  allocate,
  excludeCsam,
  isMinorBucket,
  nsfwLevelName,
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
  removedAt: string;
  removedBy: number;
  nsfw: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ch = clickhouseConfig();
  const bucketList = MINOR_BUCKETS.map((b) => `'${b}'`).join(',');

  // First removal per image: a re-removal must not move the clock or the label.
  const removals = await clickhouse<Removal>(
    `
    SELECT imageId,
           argMin(violationType, time) AS bucket,
           toString(min(time)) AS removedAt,
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

  // Not-removed pool: images the scanner scored for age, oversampled per band so the uncertain
  // middle is represented. The CSAM label in this table is never read.
  const perBand = Math.max(200, args.notRemoved * 20);
  const scanned = await clickhouse<{ imageId: string; score: number }>(
    `
    SELECT entityIds[1] AS imageId, score
    FROM scanner_label_results
    WHERE scanner = 'image_ingestion' AND entityType = 'image' AND label = 'minor'
      AND firstSeenAt > now() - INTERVAL ${args.days} DAY
    ORDER BY cityHash64(contentHash, '${args.seed.replace(/[^A-Za-z0-9_-]/g, '')}')
    LIMIT ${perBand * (args.bands.length + 1)}
  `,
    ch
  );
  const scoreById = new Map(scanned.map((s) => [Number(s.imageId), s.score]));

  const replica = new pg.Client({ connectionString: requireEnv('DATABASE_REPLICA_URL') });
  await replica.connect();
  let removedCandidates: Candidate[] = [];
  let notRemovedCandidates: Candidate[] = [];
  const appeals = new Map<number, { status: string; resolvedAt: Date | null }>();
  try {
    const ids = [...new Set([...removals.map((r) => r.imageId), ...scoreById.keys()])];
    const { rows: images } = await replica.query<{
      id: number;
      userId: number;
      ingestion: string;
      needsReview: string | null;
      blockedFor: string | null;
      nsfwLevel: number;
      type: string;
    }>(
      `SELECT id, "userId", ingestion::text AS ingestion, "needsReview", "blockedFor", "nsfwLevel", type::text AS type
       FROM "Image" WHERE id = ANY($1::int[])`,
      [ids]
    );
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
      const level = nsfwLevelName(img.nsfwLevel);
      notRemovedCandidates.push({
        imageId,
        ownerId: img.userId,
        stratum: 'not_removed',
        bucket: null,
        nsfwLevel: level,
        stratumKey: `band${scoreBand(score, args.bands)}:${level}`,
      });
    }

    const all = [...removedCandidates, ...notRemovedCandidates];
    const { rows: csamImages } = await replica.query<{ id: number }>(
      `SELECT DISTINCT (CASE jsonb_typeof(e) WHEN 'object' THEN e->>'id' ELSE e#>>'{}' END)::int AS id
       FROM "CsamReport", jsonb_array_elements("images"::jsonb) e
       WHERE (CASE jsonb_typeof(e) WHEN 'object' THEN e->>'id' ELSE e#>>'{}' END) ~ '^[0-9]+$'
         AND (CASE jsonb_typeof(e) WHEN 'object' THEN e->>'id' ELSE e#>>'{}' END)::int = ANY($1::int[])`,
      [all.map((c) => c.imageId)]
    );
    const { rows: csamOwners } = await replica.query<{ userId: number }>(
      `SELECT DISTINCT "userId" FROM "CsamReport" WHERE "userId" = ANY($1::int[])`,
      [[...new Set(all.map((c) => c.ownerId))]]
    );
    const csamImageIds = new Set(csamImages.map((r) => r.id));
    const csamOwnerIds = new Set(csamOwners.map((r) => r.userId));
    const before = { removed: removedCandidates.length, notRemoved: notRemovedCandidates.length };
    removedCandidates = excludeCsam(removedCandidates, csamImageIds, csamOwnerIds);
    notRemovedCandidates = excludeCsam(notRemovedCandidates, csamImageIds, csamOwnerIds);
    console.log(
      `CSAM exclusion: removed ${before.removed} -> ${removedCandidates.length}, not removed ${before.notRemoved} -> ${notRemovedCandidates.length}`
    );

    const { rows: appealRows } = await replica.query<{
      entityId: number;
      status: string;
      resolvedAt: Date | null;
    }>(
      `SELECT DISTINCT ON ("entityId") "entityId", status::text AS status, "resolvedAt"
       FROM "Appeal" WHERE "entityType" = 'Image' AND "entityId" = ANY($1::int[])
       ORDER BY "entityId", "createdAt" DESC`,
      [removedCandidates.map((c) => c.imageId)]
    );
    for (const a of appealRows)
      appeals.set(a.entityId, { status: a.status, resolvedAt: a.resolvedAt });
  } finally {
    await replica.end();
  }

  const picked = [
    ...allocate(removedCandidates, args.removed, args.seed),
    ...allocate(notRemovedCandidates, args.notRemoved, args.seed),
  ];
  const removalById = new Map(removals.map((r) => [r.imageId, r]));

  const counts = new Map<string, number>();
  for (const p of picked)
    counts.set(
      `${p.stratum} ${p.stratumKey}`,
      (counts.get(`${p.stratum} ${p.stratumKey}`) ?? 0) + 1
    );
  for (const [k, n] of [...counts].sort()) console.log(`  ${k}: ${n}`);
  console.log(
    `picked ${picked.length} (removed pool ${removedCandidates.length}, not-removed pool ${notRemovedCandidates.length})`
  );

  if (!args.write) {
    console.log('dry run: nothing written. Pass --write to insert into the moderator database.');
    return;
  }

  // The cluster needs `?sslmode=no-verify` on this URL; a local docker Postgres needs none.
  const mod = new pg.Client({ connectionString: requireEnv('MODERATOR_DATABASE_URL') });
  await mod.connect();
  try {
    let inserted = 0;
    for (const p of picked) {
      const removal = removalById.get(p.imageId);
      const removedAt = removal ? new Date(`${removal.removedAt.replace(' ', 'T')}Z`) : null;
      const appeal = appeals.get(p.imageId);
      const res = await mod.query(
        `INSERT INTO relabel_item
           (batch, image_id, stratum, bucket, nsfw_level, stratum_key, owner_id, removed_at, removed_by,
            purge_after, appeal_status, appeal_resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (batch, image_id) DO NOTHING`,
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
