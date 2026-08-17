/**
 * Backfill Model3D views into ClickHouse `daily_views` from `pageViews` history.
 *
 * Live `Model3DView` tracking starts at MODEL3D_VIEW_TRACKING_CUTOVER. This
 * fills the span before it from page-load history so the Creator Studio has
 * something to show on day one.
 *
 * Usage:
 *   npm run tsscript scripts/oneoffs/backfill-model3d-views.ts -- --until 2026-08-18 --dry-run
 *   npm run tsscript scripts/oneoffs/backfill-model3d-views.ts -- --until 2026-08-18
 *
 * Run this LAST: after the enum widening (scripts/oneoffs/model3d-view-tracking.sql)
 * and after the tracking code is deployed. It verifies against live data that the
 * cutover constant is the real first tracked day rather than trusting it.
 */

import { clickhouse } from '~/server/clickhouse/client';
import { getClient } from '~/server/db/db-helpers';
import { DETAIL_PREDICATE, ID_PATTERN, parseArgs } from './backfill-model3d-views.helpers';

type Row = { entityId: number; createdDate: string; views: number };

async function main() {
  const { until, from, dryRun } = parseArgs(process.argv.slice(2));
  if (!clickhouse) throw new Error('ClickHouse client not initialized');

  console.log(`Range: [${from}, ${until})  ${dryRun ? '(dry run)' : ''}`);

  // The constant is only a guess until tracking is live. The first day `views`
  // actually holds a Model3DView IS the cutover; if it disagrees with the
  // constant, one of the two spans is wrong — a gap if the deploy slipped past
  // it, an overlap if it landed early. Neither is visible once rows are written.
  const live = await clickhouse.$query<{ firstDay: string; rows: number }>(`
    SELECT min(createdDate) AS firstDay, count() AS rows
    FROM default.views WHERE type = 'Model3DView'
  `);
  if (!Number(live?.[0]?.rows ?? 0))
    throw new Error(
      `No Model3DView rows in \`views\` yet. Deploy tracking first, then run this — ` +
        `until tracking is live there is nothing to confirm the backfill's stopping point against.`
    );
  const firstTrackedDay = live[0].firstDay;
  if (firstTrackedDay !== until)
    throw new Error(
      `Cutover mismatch: first tracked day is ${firstTrackedDay}, --until is ${until}. ` +
        `Set MODEL3D_VIEW_TRACKING_CUTOVER to ${firstTrackedDay} and redeploy, then re-run. ` +
        `Backfilling to the wrong boundary leaves a permanently missing or doubled day.`
    );

  const existing = await clickhouse.$query<{ rows: number }>(`
    SELECT count() AS rows FROM default.daily_views
    WHERE entityType = 'Model3D' AND createdDate >= '${from}' AND createdDate < '${until}'
  `);
  const existingRows = Number(existing?.[0]?.rows ?? 0);
  if (existingRows > 0)
    throw new Error(
      `daily_views already holds ${existingRows} Model3D rows in [${from}, ${until}). ` +
        `Refusing to run — this table sums on insert, so a re-run would inflate every day it touches.`
    );

  const candidates =
    (await clickhouse.$query<Row>(`
      SELECT
        toUInt32(extract(path, '${ID_PATTERN}')) AS entityId,
        toDate(time) AS createdDate,
        count() AS views
      FROM default.pageViews
      WHERE toDate(time) >= '${from}' AND toDate(time) < '${until}'
        AND path LIKE '/3d-models%'
        AND ${DETAIL_PREDICATE}
      GROUP BY entityId, createdDate
      ORDER BY createdDate, entityId
    `)) ?? [];

  if (!candidates.length) {
    console.log('Nothing to backfill.');
    return;
  }

  // ClickHouse has no Model3D table, so a path id that resolves to nothing can
  // only be caught here.
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

  const expectedRows = mapped.length;
  const expectedViews = mapped.reduce((sum, r) => sum + r.views, 0);

  if (dryRun) {
    console.log(`[DRY RUN] Would insert ${expectedRows} rows / ${expectedViews} views.`);
    return;
  }

  // The shared client is built with `wait_for_async_insert: 0`, so by default
  // `insert` resolves once the server has buffered the batch — before it is
  // queryable, and without surfacing a server-side insert error at all. The
  // verification below would then race the flush and report a false failure on a
  // run that actually succeeded. Wait for this one.
  await clickhouse.insert({
    table: 'daily_views',
    values: mapped.map((r) => ({ entityType: 'Model3D', ...r })),
    format: 'JSONEachRow',
    clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
  });

  // Read the whole written range back rather than assuming it, and sum across
  // parts: SummingMergeTree merges in the background, so a raw row read can show
  // either the pre- or post-merge shape and both look reasonable.
  const readback = await clickhouse.$query<{ rows: number; views: number }>(`
    SELECT count() AS rows, sum(views) AS views FROM default.daily_views
    WHERE entityType = 'Model3D' AND createdDate >= '${from}' AND createdDate < '${until}'
  `);
  const actualRows = Number(readback?.[0]?.rows ?? 0);
  const actualViews = Number(readback?.[0]?.views ?? 0);

  if (actualRows !== expectedRows || actualViews !== expectedViews)
    throw new Error(
      `Write verification failed for [${from}, ${until}): expected ${expectedRows} rows / ` +
        `${expectedViews} views, found ${actualRows} / ${actualViews}. ` +
        `Inspect before re-running — this table sums, so a blind retry compounds the error.`
    );

  console.log(`Inserted ${expectedRows} rows / ${expectedViews} views, verified.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
