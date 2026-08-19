import { sql } from '@civitai/db/kysely';
import { getClickhouse } from '$lib/server/clickhouse';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { rangeTtlSeconds } from '$lib/date-range';
import { VIEW_ENTITY } from '$lib/server/view-entities';
import { viewTrackingLive, type TimePoint } from '$lib/server/analytics';

// Comic and 3D drilldowns. Both mirror the article page: ownership checked in Postgres, series read live from
// `daily_views` rather than a rollup — 2,922 comics and 539 3D models platform-wide, so a literal `IN` keeps the
// primary key usable and today is included.
//
// Neither carries reactions, and that is a data fact rather than a scoping decision: the `reactions` type enum is
// Image/Comment/CommentV2/Review/Question/Answer/BountyEntry/Article. No Comic or Model3D arm exists, so there is
// nothing to read — absent, not zero.

export type ChapterRow = { chapterId: number; name: string; position: number; reads: number };

export type ComicViewDetail = {
  projectId: number;
  name: string;
  coverUrl: string | null;
  nsfwLevel: number;
  published: boolean;
  /** Views of the comic's overview page (`ComicProject`). */
  series: TimePoint[];
  total: number;
  prevTotal: number;
  lifetime: number;
  /** Chapter reads (`ComicChapter`), summed across every chapter. Disjoint from `series` — nothing emits both. */
  readSeries: TimePoint[];
  readTotal: number;
  /** Per-chapter reads in reading order. This is the drop-off curve. */
  chapters: ChapterRow[];
  tracking: boolean;
};

export type Model3dViewDetail = {
  model3dId: number;
  name: string;
  coverUrl: string | null;
  nsfwLevel: number;
  published: boolean;
  series: TimePoint[];
  total: number;
  prevTotal: number;
  lifetime: number;
  tracking: boolean;
};

const points = (rows: { date: string; value: number | string }[]): TimePoint[] =>
  rows.map((r) => ({ date: String(r.date), value: Number(r.value) }));
const sumSeries = (s: TimePoint[]) => s.reduce((acc, p) => acc + p.value, 0);

/** Gap-filled daily views for one entityType over an id list. An empty list yields an all-zero series rather
 *  than an `IN ()`, which is a syntax error instead of an empty result. */
function viewsSeriesSql(entityType: string, ids: number[], from: string, to: string): string {
  const fill = `ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`;
  if (!ids.length) return `SELECT toDate('${from}') AS date, 0 AS value WHERE 0 ${fill}`;
  return `SELECT createdDate AS date, sum(views) AS value FROM daily_views WHERE entityType = '${entityType}' AND entityId IN (${ids.join(
    ','
  )}) AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY date ${fill}`;
}

const totalSql = (entityType: string, id: number, from?: string, to?: string) =>
  `SELECT sum(views) AS value FROM daily_views WHERE entityType = '${entityType}' AND entityId = ${id}` +
  (from && to ? ` AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}')` : '');

async function fetchComicViewDetail(
  userId: number,
  projectId: number,
  from: string,
  to: string,
  compareFrom: string,
  compareTo: string
): Promise<ComicViewDetail | null> {
  const uid = Number(userId);
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const project = await dbRead
    .selectFrom('ComicProject')
    .leftJoin('Image', 'Image.id', 'ComicProject.coverImageId')
    .where('ComicProject.id', '=', id)
    .where('ComicProject.userId', '=', uid)
    .select([
      'ComicProject.id as id',
      'ComicProject.name as name',
      'ComicProject.nsfwLevel as nsfwLevel',
      'ComicProject.publishedAt as publishedAt',
      'Image.url as coverUrl',
    ])
    .executeTakeFirst();
  if (!project) return null;

  // `position` comes along in the select that resolves chapter ids anyway, so per-chapter drop-off costs a sort
  // rather than a schema change.
  const chapterRows = await sql<{ id: number; name: string; position: number }>`
    SELECT id, name, position FROM "ComicChapter" WHERE "projectId" = ${id} ORDER BY position
  `.execute(dbRead);
  const chapterIds = chapterRows.rows.map((c) => Number(c.id));

  const ch = getClickhouse();
  const inRange = `createdDate >= toDate('${from}') AND createdDate <= toDate('${to}')`;
  const [viewRows, readRows, prevRows, lifeRows, perChapter, tracking] = await Promise.all([
    ch.$query<{ date: string; value: number | string }>(
      viewsSeriesSql(VIEW_ENTITY.comicProject, [id], from, to)
    ),
    ch.$query<{ date: string; value: number | string }>(
      viewsSeriesSql(VIEW_ENTITY.comicChapter, chapterIds, from, to)
    ),
    ch.$query<{ value: number | string }>(
      totalSql(VIEW_ENTITY.comicProject, id, compareFrom, compareTo)
    ),
    ch.$query<{ value: number | string }>(totalSql(VIEW_ENTITY.comicProject, id)),
    chapterIds.length
      ? ch.$query<{ id: number | string; reads: number | string }>(
          `SELECT entityId AS id, sum(views) AS reads FROM daily_views WHERE entityType = '${
            VIEW_ENTITY.comicChapter
          }' AND entityId IN (${chapterIds.join(',')}) AND ${inRange} GROUP BY id`
        )
      : Promise.resolve([]),
    viewTrackingLive(VIEW_ENTITY.comicProject),
  ]);

  const readsById = new Map(perChapter.map((r) => [Number(r.id), Number(r.reads)]));
  const series = points(viewRows);
  const readSeries = points(readRows);
  return {
    projectId: id,
    name: project.name ?? `Comic ${id}`,
    coverUrl: project.coverUrl ?? null,
    nsfwLevel: Number(project.nsfwLevel ?? 0),
    published: !!project.publishedAt,
    series,
    total: sumSeries(series),
    prevTotal: Number(prevRows[0]?.value ?? 0),
    lifetime: Number(lifeRows[0]?.value ?? 0),
    readSeries,
    readTotal: sumSeries(readSeries),
    chapters: chapterRows.rows.map((c) => ({
      chapterId: Number(c.id),
      name: c.name ?? `Chapter ${c.position}`,
      position: Number(c.position),
      reads: readsById.get(Number(c.id)) ?? 0,
    })),
    tracking,
  };
}

async function fetchModel3dViewDetail(
  userId: number,
  model3dId: number,
  from: string,
  to: string,
  compareFrom: string,
  compareTo: string
): Promise<Model3dViewDetail | null> {
  const uid = Number(userId);
  const id = Number(model3dId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const model = await dbRead
    .selectFrom('Model3D')
    .leftJoin('Image', 'Image.id', 'Model3D.thumbnailImageId')
    .where('Model3D.id', '=', id)
    .where('Model3D.userId', '=', uid)
    .where('Model3D.deletedAt', 'is', null)
    .select([
      'Model3D.id as id',
      'Model3D.name as name',
      'Model3D.nsfwLevel as nsfwLevel',
      'Model3D.publishedAt as publishedAt',
      'Image.url as coverUrl',
    ])
    .executeTakeFirst();
  if (!model) return null;

  const ch = getClickhouse();
  const [viewRows, prevRows, lifeRows, tracking] = await Promise.all([
    ch.$query<{ date: string; value: number | string }>(
      viewsSeriesSql(VIEW_ENTITY.model3d, [id], from, to)
    ),
    ch.$query<{ value: number | string }>(
      totalSql(VIEW_ENTITY.model3d, id, compareFrom, compareTo)
    ),
    ch.$query<{ value: number | string }>(totalSql(VIEW_ENTITY.model3d, id)),
    viewTrackingLive(VIEW_ENTITY.model3d),
  ]);

  const series = points(viewRows);
  return {
    model3dId: id,
    name: model.name ?? `3D model ${id}`,
    coverUrl: model.coverUrl ?? null,
    nsfwLevel: Number(model.nsfwLevel ?? 0),
    published: !!model.publishedAt,
    series,
    total: sumSeries(series),
    prevTotal: Number(prevRows[0]?.value ?? 0),
    lifetime: Number(lifeRows[0]?.value ?? 0),
    tracking,
  };
}

type RangeArgs = {
  userId: number;
  from: string;
  to: string;
  compareFrom: string;
  compareTo: string;
};

export const getComicViewDetail = createCache({
  name: 'analytics:comic-detail:v1',
  fetch: (a: RangeArgs & { projectId: number }) =>
    fetchComicViewDetail(a.userId, a.projectId, a.from, a.to, a.compareFrom, a.compareTo),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getModel3dViewDetail = createCache({
  name: 'analytics:model3d-detail:v1',
  fetch: (a: RangeArgs & { model3dId: number }) =>
    fetchModel3dViewDetail(a.userId, a.model3dId, a.from, a.to, a.compareFrom, a.compareTo),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;
