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
 *   --allow-rerun       Write even if comic rows already exist in the range. Only correct after
 *                       clearing the previous attempt. `daily_views` is a SummingMergeTree with NO
 *                       partitioning — a single tuple() partition of ~1.68B rows — so there is no
 *                       partition to drop and clearing means a lightweight DELETE. A second run
 *                       without that ADDS to the first, and the result looks entirely plausible.
 *   --allow-cutover-drift  Permit --until to differ from COMIC_VIEW_TRACKING_CUTOVER.
 *   --include-reordered Write chapter rows for projects whose positions no longer match creation
 *                       order. They are skipped by default because their per-chapter attribution
 *                       is knowably wrong; see below.
 *
 * Three things this deliberately does NOT reconcile, because they cannot be:
 *
 *  1. `pageViews` has no `deviceId` (only `userId` and `ip`), while `views` has all three. Raw
 *     view counts — what `daily_views` stores — are unaffected. Any UNIQUE-viewer metric built
 *     later must key on `if(userId = 0, ip, toString(userId))` on both sides or the series will
 *     step at the cutover.
 *  2. Going-forward chapter views are gated on `canRead`, so a paywalled early-access chapter the
 *     viewer could not open is not counted. `pageViews` cannot see that gate, so backfilled
 *     chapter counts include those locked views and run slightly high. The overstatement is
 *     bounded by early-access chapters only.
 *  3. `TrackPageView` drops any visit under 1s of VISIBLE time, while `TrackView` fires on a 1s
 *     timer that runs regardless of tab visibility. A comic opened in a background tab and never
 *     focused produces a live view row and produced no pageViews row — so this pushes live
 *     numbers up relative to the backfilled span, partially offsetting (2). Unmeasured.
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
// Two guards, two flags. They were one `--force` and that was wrong: anyone who legitimately
// needed to re-run after clearing a bad attempt silently lost the cutover check as well.
const allowRerun = args.includes('--allow-rerun');
const allowCutoverDrift = args.includes('--allow-cutover-drift');
const includeReordered = args.includes('--include-reordered');
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
      -- toUInt32OrZero, not toUInt32: ClickHouse evaluates the grouping expressions over the whole
      -- block alongside the WHERE rather than strictly after it, so extract() returns '' on rows
      -- the regex rejects and the strict cast raises "Cannot parse UInt32 from String" on the
      -- first block. The OrZero form is what makes the HAVING below a real guard instead of dead
      -- code. Chapter paths are excluded here so a chapter read is not also a project view.
      SELECT toUInt32OrZero(extract(pageId, {projectRe:String})) AS projectId,
             toString(toDate(time))                              AS date,
             count()                                             AS views
      FROM default.pageViews
      WHERE match(pageId, {projectRe:String})
        AND NOT match(pageId, {chapterRe:String})
        AND time >= toDate({from:String})
        AND time <  toDate({until:String})
        -- Preview deployments write into the same pageViews table. Live views has no host
        -- column, so it cannot be filtered the same way, but preview traffic is 12 rows against
        -- ~885k and dropping it is closer to parity than keeping it.
        AND host NOT LIKE 'pr-%'
      GROUP BY projectId, date
      HAVING projectId > 0
    `,
    query_params: {
      projectRe: PROJECT_PATH_RE,
      chapterRe: CHAPTER_PATH_RE,
      from: FROM,
      until: UNTIL,
    },
    format: 'JSONEachRow',
  });
  return (await res.json()) as ProjectRow[];
}

async function readChapterViews(): Promise<ChapterRow[]> {
  const res = await clickhouse!.query({
    query: `
      -- toUInt32OrZero for the same reason as readProjectViews above.
      SELECT toUInt32OrZero(extractGroups(pageId, {chapterRe:String})[1]) AS projectId,
             toUInt32OrZero(extractGroups(pageId, {chapterRe:String})[2]) AS urlPosition,
             toString(toDate(time))                                       AS date,
             count()                                                      AS views
      FROM default.pageViews
      WHERE match(pageId, {chapterRe:String})
        AND time >= toDate({from:String})
        AND time <  toDate({until:String})
        -- Preview deployments write into the same pageViews table. Live views has no host
        -- column, so it cannot be filtered the same way, but preview traffic is 12 rows against
        -- ~885k and dropping it is closer to parity than keeping it.
        AND host NOT LIKE 'pr-%'
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
  if (UNTIL !== COMIC_VIEW_TRACKING_CUTOVER && !allowCutoverDrift) {
    throw new Error(
      `--until=${UNTIL} does not match COMIC_VIEW_TRACKING_CUTOVER (${COMIC_VIEW_TRACKING_CUTOVER}). ` +
        `Anything charting these views reads the constant to know where the series changes meaning; ` +
        `backfilling to a different day makes that marker point at the wrong place. Update the ` +
        `constant to the real deploy date, or pass --allow-cutover-drift if you know why they differ.`
    );
  }
  if (!DATE_RE.test(FROM)) throw new Error('--from must be YYYY-MM-DD');
  if (FROM >= UNTIL) throw new Error(`--from (${FROM}) must be before --until (${UNTIL})`);
  if (!clickhouse) throw new Error('ClickHouse client is not configured');

  console.log(
    `[backfill] range [${FROM}, ${UNTIL})  dryRun=${isDryRun} allowRerun=${allowRerun} ` +
      `includeReordered=${includeReordered}`
  );

  const already = await existingComicRows();
  if (already > 0 && !allowRerun) {
    throw new Error(
      `daily_views already holds ${already} comic rows in [${FROM}, ${UNTIL}). It is a ` +
        `SummingMergeTree — re-running ADDS to those. daily_views has NO partitioning (one ` +
        `tuple() partition, ~1.68B rows), so there is no partition to drop: clear the previous ` +
        `attempt with a lightweight delete —\n` +
        `  DELETE FROM default.daily_views WHERE entityType IN ('ComicProject','ComicChapter') ` +
        `AND createdDate >= '${FROM}' AND createdDate < '${UNTIL}';\n` +
        `then re-run with --allow-rerun.`
    );
  }

  // chapterId is what a going-forward ComicChapterView row carries, but the URL only exposes the
  // chapter's position within its project, so the mapping has to come from Postgres. 4.3k rows
  // across 2.9k projects — small enough to hold in memory.
  const chapters = await prisma.comicChapter.findMany({
    select: { id: true, projectId: true, position: true },
  });
  const chapterIdByKey = new Map(chapters.map((c) => [chapterKey(c.projectId, c.position), c.id]));

  // A project whose chapter positions no longer match creation order has been reordered, or has
  // had a middle chapter deleted (positions repack rather than leaving a hole — measured: exactly
  // 1 project of ~2,900 has a gap). Either way an old URL's position now points at a DIFFERENT
  // chapter, and it resolves cleanly, so the mis-attribution is silent: it is NOT reported as
  // unmapped, because a chapter really is sitting at that position.
  //
  // Position history is not recoverable, so the only honest options are to skip these projects or
  // to knowingly publish wrong per-chapter numbers. Skipping is the default. Measured today: 19
  // projects, 77 chapters, ~7.4% of backfillable chapter views.
  const byProject = new Map<number, { id: number; position: number }[]>();
  for (const c of chapters) {
    const list = byProject.get(c.projectId) ?? [];
    list.push(c);
    byProject.set(c.projectId, list);
  }
  const reorderedProjects = new Set<number>();
  for (const [projectId, list] of byProject) {
    const byCreation = [...list].sort((a, b) => a.id - b.id);
    if (byCreation.some((c, i) => c.position !== i)) reorderedProjects.add(projectId);
  }
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
  let reorderedSkipped = 0;
  let reorderedSkippedViews = 0;
  for (const r of chapterViews) {
    if (reorderedProjects.has(r.projectId) && !includeReordered) {
      reorderedSkipped++;
      reorderedSkippedViews += Number(r.views);
      continue;
    }
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

  if (reorderedSkipped > 0) {
    console.log(
      `[backfill] ${reorderedSkipped} chapter day-rows (${reorderedSkippedViews} views) belong to ` +
        `${reorderedProjects.size} projects whose chapter positions no longer match creation ` +
        `order. Their per-chapter history cannot be attributed correctly. Skipped ` +
        `(--include-reordered to write them anyway, knowingly wrong).`
    );
  }
  if (unmapped > 0) {
    // Chapters deleted off the END of a project, where nothing repacked into the position. A
    // deletion or reorder in the MIDDLE does not land here — see reorderedProjects above.
    console.log(
      `[backfill] ${unmapped} chapter day-rows (${unmappedViews} views) map to a position no ` +
        `chapter occupies. Skipped.`
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

  // A near-empty result is far more likely to mean the source disappeared than that comics stopped
  // being read. `pageViews.pageId` holds literal comic paths ONLY because comic routes are absent
  // from `pathnamesTokens` in src/shared/constants/pathname.constants.ts — every templated entity
  // collapses to one pageId (`/models/[id]/[[...slug]]`). Add comics there and this script reads
  // ~0 rows, writes nothing, and exits 0. Fail instead.
  const FLOOR = 1000;
  if (rows.length < FLOOR) {
    throw new Error(
      `only ${rows.length} rows to write, below the ${FLOOR} floor. Either the range is genuinely ` +
        `empty, or comic routes were added to pathnamesTokens and pageViews no longer holds ` +
        `literal comic paths. Check before lowering this.`
    );
  }

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
