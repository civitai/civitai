/**
 * Backfill comic view history into ClickHouse `daily_views` from `pageViews`.
 *
 * Comic pages have never emitted a `views` row (no Comic arm on the enum, no <TrackView> on the
 * reader), so going-forward tracking starts from zero on the day it deploys. But `pageViews`
 * carries the full path, and both the project id and the chapter position are recoverable from
 * it, so the series can start ~3.5 months back instead. Comic paths first appear 2026-02 and
 * only reach real volume in 2026-05; there is nothing older to recover.
 *
 * Usage:
 *   npm run tsscript scripts/oneoffs/backfill-comic-views.ts --until=YYYY-MM-DD [options]
 *
 * Options:
 *   --until=YYYY-MM-DD  REQUIRED, exclusive, and must equal COMIC_VIEW_TRACKING_CUTOVER in
 *                       @civitai/shared — that constant is what any chart reads to know where the
 *                       series changes meaning, so the two drifting apart puts the marker on the
 *                       wrong day. It is also the guard against counting the cutover day twice,
 *                       once from pageViews and once for real.
 *   --from=YYYY-MM-DD   Inclusive lower bound (default 2026-02-01, the first comic pageView).
 *   --dry-run           Report what would be written, write nothing.
 *   --force             Write even if comic rows already exist in the range. Only correct after
 *                       deleting the previous attempt's partitions — `daily_views` is a
 *                       SummingMergeTree, so a second run ADDS to the first and the result looks
 *                       entirely plausible.
 *
 * Two things this deliberately does NOT reconcile, because they cannot be:
 *
 *  1. `pageViews` has no `deviceId` (only `userId` and `ip`), while `views` has all three. Raw
 *     view counts — what `daily_views` stores — are unaffected. Any UNIQUE-viewer metric built
 *     later must key on `if(userId = 0, ip, toString(userId))` on both sides or the series will
 *     step at the cutover.
 *  2. Going-forward chapter views are gated on `canRead`, so a paywalled early-access chapter the
 *     viewer could not open is not counted. `pageViews` cannot see that gate, so backfilled
 *     chapter counts include those locked views and run slightly high. The overstatement is
 *     bounded by early-access chapters only.
 */
import { PrismaClient } from '@prisma/client';
import { COMIC_VIEW_TRACKING_CUTOVER } from '@civitai/shared';
import { clickhouse } from '~/server/clickhouse/client';
import {
  CHAPTER_PATH_RE,
  PROJECT_PATH_RE,
  chapterKey,
  resolveChapterId,
} from '~/server/clickhouse/comic-view-paths';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const FROM = arg('from') ?? '2026-02-01';
const UNTIL = arg('until');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const prisma = new PrismaClient();

type ProjectRow = { projectId: number; date: string; views: number };
type ChapterRow = { projectId: number; urlPosition: number; date: string; views: number };

async function readProjectViews(): Promise<ProjectRow[]> {
  const res = await clickhouse!.query({
    query: `
      SELECT toUInt32(extract(pageId, {projectRe:String})) AS projectId,
             toString(toDate(time))                        AS date,
             count()                                       AS views
      FROM default.pageViews
      WHERE match(pageId, {projectRe:String})
        AND time >= toDate({from:String})
        AND time <  toDate({until:String})
      GROUP BY projectId, date
      HAVING projectId > 0
    `,
    query_params: { projectRe: PROJECT_PATH_RE, from: FROM, until: UNTIL },
    format: 'JSONEachRow',
  });
  return (await res.json()) as ProjectRow[];
}

async function readChapterViews(): Promise<ChapterRow[]> {
  const res = await clickhouse!.query({
    query: `
      SELECT toUInt32(extractGroups(pageId, {chapterRe:String})[1]) AS projectId,
             toUInt32(extractGroups(pageId, {chapterRe:String})[2]) AS urlPosition,
             toString(toDate(time))                                 AS date,
             count()                                                AS views
      FROM default.pageViews
      WHERE match(pageId, {chapterRe:String})
        AND time >= toDate({from:String})
        AND time <  toDate({until:String})
      GROUP BY projectId, urlPosition, date
      HAVING projectId > 0 AND urlPosition > 0
    `,
    query_params: { chapterRe: CHAPTER_PATH_RE, from: FROM, until: UNTIL },
    format: 'JSONEachRow',
  });
  return (await res.json()) as ChapterRow[];
}

async function existingComicRows(): Promise<number> {
  const res = await clickhouse!.query({
    query: `
      SELECT count() AS n
      FROM default.daily_views
      WHERE entityType IN ('ComicProject', 'ComicChapter')
        AND createdDate >= toDate({from:String})
        AND createdDate <  toDate({until:String})
    `,
    query_params: { from: FROM, until: UNTIL },
    format: 'JSONEachRow',
  });
  const rows = (await res.json()) as { n: string }[];
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  if (!UNTIL || !DATE_RE.test(UNTIL)) {
    throw new Error('--until=YYYY-MM-DD is required (exclusive upper bound)');
  }
  if (UNTIL !== COMIC_VIEW_TRACKING_CUTOVER && !isForce) {
    throw new Error(
      `--until=${UNTIL} does not match COMIC_VIEW_TRACKING_CUTOVER (${COMIC_VIEW_TRACKING_CUTOVER}). ` +
        `Anything charting these views reads the constant to know where the series changes meaning; ` +
        `backfilling to a different day makes that marker point at the wrong place. Update the ` +
        `constant to the real deploy date, or pass --force if you know why they differ.`
    );
  }
  if (!DATE_RE.test(FROM)) throw new Error('--from must be YYYY-MM-DD');
  if (FROM >= UNTIL) throw new Error(`--from (${FROM}) must be before --until (${UNTIL})`);
  if (!clickhouse) throw new Error('ClickHouse client is not configured');

  console.log(`[backfill] range [${FROM}, ${UNTIL})  dryRun=${isDryRun} force=${isForce}`);

  const already = await existingComicRows();
  if (already > 0 && !isForce) {
    throw new Error(
      `daily_views already holds ${already} comic rows in [${FROM}, ${UNTIL}). ` +
        `It is a SummingMergeTree — re-running ADDS to those. Drop them first, then --force.`
    );
  }

  // chapterId is what a going-forward ComicChapterView row carries, but the URL only exposes the
  // chapter's position within its project, so the mapping has to come from Postgres. 4.3k rows
  // across 2.9k projects — small enough to hold in memory.
  const chapters = await prisma.comicChapter.findMany({
    select: { id: true, projectId: true, position: true },
  });
  const chapterIdByKey = new Map(chapters.map((c) => [chapterKey(c.projectId, c.position), c.id]));
  const projectIds = new Set(
    (await prisma.comicProject.findMany({ select: { id: true } })).map((p) => p.id)
  );
  console.log(
    `[backfill] loaded ${projectIds.size} projects, ${chapters.length} chapter positions`
  );

  const projectViews = await readProjectViews();
  const chapterViews = await readChapterViews();
  console.log(
    `[backfill] pageViews: ${projectViews.length} project day-rows, ` +
      `${chapterViews.length} chapter day-rows`
  );

  const rows: { entityType: string; entityId: number; createdDate: string; views: number }[] = [];

  // A well-formed path is not a real project. `/comics/0` and ids belonging to some other entity
  // typed into a comic URL both parse cleanly, and writing them would put entityIds into
  // daily_views that resolve to nothing — invisible, because nobody queries an id they don't own.
  let unknownProjects = 0;
  let unknownProjectViews = 0;
  for (const r of projectViews) {
    if (!projectIds.has(r.projectId)) {
      unknownProjects++;
      unknownProjectViews += Number(r.views);
      continue;
    }
    rows.push({
      entityType: 'ComicProject',
      entityId: r.projectId,
      createdDate: r.date,
      views: Number(r.views),
    });
  }
  if (unknownProjects > 0) {
    console.log(
      `[backfill] ${unknownProjects} project day-rows (${unknownProjectViews} views) reference no ` +
        `current ComicProject — deleted, or another entity's id typed into a comic URL. Skipped.`
    );
  }

  let unmapped = 0;
  let unmappedViews = 0;
  for (const r of chapterViews) {
    const chapterId = resolveChapterId(chapterIdByKey, r.projectId, r.urlPosition);
    if (!chapterId) {
      unmapped++;
      unmappedViews += Number(r.views);
      continue;
    }
    rows.push({
      entityType: 'ComicChapter',
      entityId: chapterId,
      createdDate: r.date,
      views: Number(r.views),
    });
  }

  if (unmapped > 0) {
    // Expected and not an error: chapters deleted since the view happened, and reordered chapters
    // whose position no longer means what it did. Reported so the number is visible rather than
    // silently absorbed.
    console.log(
      `[backfill] ${unmapped} chapter day-rows (${unmappedViews} views) map to no current ` +
        `chapter — deleted or reordered since. Skipped.`
    );
  }

  const projectTotal = rows
    .filter((r) => r.entityType === 'ComicProject')
    .reduce((a, r) => a + r.views, 0);
  const chapterTotal = rows
    .filter((r) => r.entityType === 'ComicChapter')
    .reduce((a, r) => a + r.views, 0);
  console.log(
    `[backfill] ${rows.length} rows to write — ${projectTotal} project views, ` +
      `${chapterTotal} chapter views`
  );

  if (isDryRun) {
    console.log('[backfill] dry run, nothing written');
    return;
  }

  await clickhouse.insert({
    table: 'default.daily_views',
    values: rows,
    format: 'JSONEachRow',
  });
  console.log(`[backfill] wrote ${rows.length} rows`);

  // Read back the boundary day rather than trusting the write. The day before --until is where a
  // double-count from an overlapping going-forward window would show up first.
  const boundary = await clickhouse.query({
    query: `
      SELECT entityType, sum(views) AS views
      FROM default.daily_views
      WHERE entityType IN ('ComicProject', 'ComicChapter')
        AND createdDate = toDate({until:String}) - 1
      GROUP BY entityType
    `,
    query_params: { until: UNTIL },
    format: 'JSONEachRow',
  });
  console.log('[backfill] boundary day', await boundary.json());
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
