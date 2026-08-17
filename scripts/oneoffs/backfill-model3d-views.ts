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

// A dev server or preview deploy on a tracking branch writes to the SAME
// ClickHouse as prod, so one developer opening a 3D model page puts a real
// Model3DView row in `views`. Taking a bare min() over those would move the
// detected cutover back to that day and quietly drop every day between it and
// the real one. Production traffic on this surface runs ~2,700 views/day, so a
// day is only the cutover if it clears a floor no incidental page load reaches.
const MIN_ROWS_FOR_A_TRACKED_DAY = 50;

async function main() {
  const { until, from, dryRun } = parseArgs(process.argv.slice(2));
  if (!clickhouse) throw new Error('ClickHouse client not initialized');

  console.log(`Range: [${from}, ${until})  ${dryRun ? '(dry run)' : ''}`);

  // The constant is only a guess until tracking is live: the first day `views`
  // holds real Model3DView traffic IS the cutover. If it disagrees with the
  // constant, one of the two spans is wrong — a gap if the deploy slipped past
  // it, an overlap if it landed early. Neither is visible once rows are written.
  const byDay = await clickhouse.$query<{ createdDate: string; rows: number }>(`
    SELECT createdDate, count() AS rows
    FROM default.views WHERE type = 'Model3DView'
    GROUP BY createdDate ORDER BY createdDate
  `);
  const trackedDays = (byDay ?? []).filter((d) => Number(d.rows) >= MIN_ROWS_FOR_A_TRACKED_DAY);
  const firstTrackedDay = trackedDays[0]?.createdDate;

  const strays = (byDay ?? []).filter(
    (d) =>
      Number(d.rows) < MIN_ROWS_FOR_A_TRACKED_DAY &&
      (!firstTrackedDay || d.createdDate < firstTrackedDay)
  );
  if (strays.length)
    console.warn(
      `WARNING: ${strays.length} low-volume Model3DView day(s) before the cutover, ignored as ` +
        `incidental (dev server or preview traffic): ` +
        strays.map((d) => `${d.createdDate}=${d.rows}`).join(', ') +
        `. They are in \`views\` and in \`daily_views\`; delete them if you want the pre-cutover span clean.`
    );

  if (!firstTrackedDay) {
    const msg =
      `No day in \`views\` has ${MIN_ROWS_FOR_A_TRACKED_DAY}+ Model3DView rows yet. Deploy tracking ` +
      `first, then run this — until tracking is live there is nothing to confirm the stopping point against.`;
    if (!dryRun) throw new Error(msg);
    console.warn(`WARNING (dry run, continuing): ${msg}`);
  } else if (firstTrackedDay !== until) {
    throw new Error(
      `Cutover mismatch: first tracked day is ${firstTrackedDay}, --until is ${until}.\n` +
        `  ${firstTrackedDay} is almost certainly PARTIAL — tracking started mid-day, so beacons cover only\n` +
        `  the hours after the deploy and pageViews covers the hours before. Pick one deliberately:\n` +
        `    (a) set the constant to ${firstTrackedDay} — that day keeps only post-deploy views, the rest is lost;\n` +
        `    (b) set it to the next UTC midnight and re-run after that day closes — no loss, one day's delay.\n` +
        `  Do not treat (a) as the default fix just because it clears this error.`
    );
  }

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

  // Coerce rather than trusting the shape: count() is UInt64 and only arrives as
  // a JS number because the shared client sets output_format_json_quote_64bit_integers.
  const candidates: Row[] = (
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
    `)) ?? []
  ).map((r) => ({
    entityId: Number(r.entityId),
    createdDate: r.createdDate,
    views: Number(r.views),
  }));

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
  //
  // `select_sequential_consistency` because prod is a two-replica SharedMergeTree
  // behind a load balancer: the insert and this read are separate requests and
  // can land on different replicas, so a committed write is not necessarily
  // visible to the next query. Without it this reports a false failure — and the
  // pre-flight guard above then blocks the retry, since the rows really are there.
  // `$query` takes no settings, so this goes through the underlying client.
  const readbackResult = await clickhouse.query({
    query: `
      SELECT count() AS rows, sum(views) AS views FROM default.daily_views
      WHERE entityType = 'Model3D' AND createdDate >= '${from}' AND createdDate < '${until}'
    `,
    format: 'JSONEachRow',
    clickhouse_settings: { select_sequential_consistency: 1 },
  });
  const readback = await readbackResult.json<{ rows: number | string; views: number | string }>();
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
