/**
 * Backfill Model3D views into ClickHouse `daily_views` from `pageViews` history.
 *
 * Live `Model3DView` tracking starts at MODEL3D_VIEW_TRACKING_CUTOVER. This
 * fills the span before it from page-load history so the Creator Studio has
 * something to show on day one.
 *
 * Usage:
 *   npx ts-node scripts/oneoffs/backfill-model3d-views.ts --until 2026-08-18 --dry-run
 *   npx ts-node scripts/oneoffs/backfill-model3d-views.ts --until 2026-08-18
 *
 * Requires the ClickHouse enum widening in scripts/oneoffs/model3d-view-tracking.sql
 * to have been applied first — `daily_views.entityType` cannot hold 'Model3D' until then.
 */

import { clickhouse } from '~/server/clickhouse/client';
import { getClient } from '~/server/db/db-helpers';
import { DETAIL_PREDICATE, parseArgs, previousDay } from './backfill-model3d-views.helpers';

type Row = { entityId: number; createdDate: string; views: number };

async function main() {
  const { until, from, dryRun } = parseArgs(process.argv.slice(2));
  if (!clickhouse) throw new Error('ClickHouse client not initialized');

  console.log(`Range: [${from}, ${until})  ${dryRun ? '(dry run)' : ''}`);

  // Refuse rather than double-count. `daily_views` is a SummingMergeTree, so a
  // second run does not overwrite — it adds, and the result looks plausible.
  const existing = await clickhouse.$query<{ rows: string }>(`
    SELECT count() AS rows FROM default.daily_views
    WHERE entityType = 'Model3D' AND createdDate >= '${from}' AND createdDate < '${until}'
  `);
  const existingRows = Number(existing?.[0]?.rows ?? 0);
  if (existingRows > 0)
    throw new Error(
      `daily_views already holds ${existingRows} Model3D rows in [${from}, ${until}). ` +
        `Refusing to run — this table sums on insert, so a re-run would inflate every day it touches.`
    );

  const aggregated = await clickhouse.$query<{
    entityId: string;
    createdDate: string;
    views: string;
  }>(`
    SELECT
      toUInt32(extract(path, '^/3d-models/([0-9]+)')) AS entityId,
      toDate(time) AS createdDate,
      count() AS views
    FROM default.pageViews
    WHERE toDate(time) >= '${from}' AND toDate(time) < '${until}'
      AND path LIKE '/3d-models%'
      AND ${DETAIL_PREDICATE}
    GROUP BY entityId, createdDate
    ORDER BY createdDate, entityId
  `);

  const candidates: Row[] = (aggregated ?? []).map((r) => ({
    entityId: Number(r.entityId),
    createdDate: r.createdDate,
    views: Number(r.views),
  }));

  if (!candidates.length) {
    console.log('Nothing to backfill.');
    return;
  }

  // Ownership and existence live in Postgres; ClickHouse has no Model3D table.
  const pg = getClient({ instance: 'primaryRead' });
  const ids = [...new Set(candidates.map((r) => r.entityId))];
  const { rows: known } = await pg.query<{ id: number }>(
    'SELECT id FROM "Model3D" WHERE id = ANY($1::int[])',
    [ids]
  );
  const knownIds = new Set(known.map((r) => r.id));

  const mapped = candidates.filter((r) => knownIds.has(r.entityId));
  const unmapped = candidates.filter((r) => !knownIds.has(r.entityId));

  const unmappedIds = [...new Set(unmapped.map((r) => r.entityId))].sort((a, b) => a - b);
  const unmappedViews = unmapped.reduce((sum, r) => sum + r.views, 0);
  console.log(
    `Mapped ${mapped.length} rows across ${knownIds.size} ids. ` +
      `Dropped ${unmapped.length} rows / ${unmappedViews} views across ${unmappedIds.length} ids with no Model3D row: ` +
      `[${unmappedIds.join(', ')}]`
  );

  const boundaryDay = previousDay(until);
  const expectedBoundary = mapped
    .filter((r) => r.createdDate === boundaryDay)
    .reduce((sum, r) => sum + r.views, 0);

  if (dryRun) {
    const total = mapped.reduce((sum, r) => sum + r.views, 0);
    console.log(`[DRY RUN] Would insert ${mapped.length} rows / ${total} views.`);
    console.log(`[DRY RUN] Boundary day ${boundaryDay} would hold ${expectedBoundary} views.`);
    return;
  }

  await clickhouse.insert({
    table: 'daily_views',
    values: mapped.map((r) => ({ entityType: 'Model3D', ...r })),
    format: 'JSONEachRow',
  });

  // Read the boundary day back rather than assuming it. SummingMergeTree merges
  // in the background, so this must sum across parts — a raw row read can show
  // either the pre- or post-merge shape and both look reasonable.
  const readback = await clickhouse.$query<{ views: string }>(`
    SELECT sum(views) AS views FROM default.daily_views
    WHERE entityType = 'Model3D' AND createdDate = '${boundaryDay}'
  `);
  const actualBoundary = Number(readback?.[0]?.views ?? 0);

  console.log(
    `Boundary day ${boundaryDay}: expected ${expectedBoundary}, stored ${actualBoundary}.`
  );
  if (actualBoundary !== expectedBoundary)
    throw new Error(
      `Boundary mismatch on ${boundaryDay}: expected ${expectedBoundary}, found ${actualBoundary}. ` +
        `Inspect before re-running — this table sums, so a blind retry compounds the error.`
    );

  console.log(`Inserted ${mapped.length} rows.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
