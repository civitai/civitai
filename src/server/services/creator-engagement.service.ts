import { sql } from 'kysely';
import * as z from 'zod';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { kyselyRead } from '~/server/db/kyselyDb';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { getMetricExcludedUserIds } from '~/server/services/metric-excluded-users.service';
import { visibleReviewSql } from '~/server/services/resourceReview.visibility';
import { fetchThroughCache } from '~/server/utils/cache-helpers';

export const engagementItemTypes = ['image', 'video', 'model'] as const;
export type EngagementItemType = (typeof engagementItemTypes)[number];
export const engagementSorts = ['engagement', 'newest'] as const;
export type EngagementSort = (typeof engagementSorts)[number];

export const ENGAGEMENT_LIMIT_DEFAULT = 20;
export const ENGAGEMENT_LIMIT_MAX = 100;
/** Most of a creator's own rows one `sort=newest` page may examine before it returns short. */
export const NEWEST_SCAN_BUDGET = 5000;
/** Images taken from the 30-day reaction ranking before the exact Postgres counts re-rank them. */
export const RANKING_IMAGE_CANDIDATES = 1000;
/** Images ranked when ClickHouse cannot supply candidates: the caller's newest. */
export const RANKING_FALLBACK_IMAGES = 500;
/** Models ranked: the caller's newest published ones. */
export const RANKING_MODEL_CANDIDATES = 500;
export const RANKING_MAX_ITEMS = 1000;
const RANKING_TTL = CacheTTL.xs * 5;

const DAY_MS = 86_400_000;
const IMAGE_REACTIONS = ['Like', 'Heart', 'Laugh', 'Cry'] as const;

type Kind = 'i' | 'm';
// Ties on createdAt (or score) put models before images, then higher ids first.
const KIND_ORDER: Record<Kind, number> = { m: 0, i: 1 };

const newestCursorSchema = z.object({
  s: z.literal('n'),
  // The range `Date` accepts; past it `toISOString` throws a RangeError.
  t: z.number().int().min(0).max(8.64e15),
  k: z.enum(['i', 'm']),
  id: z.number().int().positive(),
});
const engagementCursorSchema = z.object({
  s: z.literal('e'),
  v: z.number().int().nonnegative(),
  k: z.enum(['i', 'm']),
  id: z.number().int().positive(),
});
type NewestCursor = z.infer<typeof newestCursorSchema>;
type EngagementCursor = z.infer<typeof engagementCursorSchema>;

export class InvalidCursorError extends Error {}

const encodeCursor = (cursor: NewestCursor | EngagementCursor) =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor<T>(raw: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new InvalidCursorError('Invalid cursor');
  }
}

export type ReactionCounts = {
  total: number;
  like: number;
  heart: number;
  laugh: number;
  cry: number;
};
export type ReviewCounts = { total: number; thumbsUp: number; thumbsDown: number };
type WindowCounts<R> = {
  reactions: R;
  comments: number;
  collects: number;
  views?: number;
  downloads?: number;
  tippedBuzz?: number;
};
export type MediaEngagementItem = {
  id: number;
  type: 'image' | 'video';
  name: string | null;
  url: string;
  mediaUrl: string;
  createdAt: string;
  nsfwLevel: number;
  d7: WindowCounts<ReactionCounts>;
  d30: WindowCounts<ReactionCounts>;
  allTime: WindowCounts<ReactionCounts>;
};
export type ModelEngagementItem = {
  id: number;
  type: 'model';
  name: string;
  url: string;
  createdAt: string;
  nsfwLevel: number;
  versionCount: number;
  d7: WindowCounts<ReviewCounts>;
  d30: WindowCounts<ReviewCounts>;
  allTime: WindowCounts<ReviewCounts>;
};
export type EngagementItem = MediaEngagementItem | ModelEngagementItem;
export type EngagementPage = {
  items: EngagementItem[];
  metadata: {
    nextCursor: string | null;
    /** sort=engagement only: where the image candidates came from. */
    imageCandidates?: 'reactions-30d' | 'newest';
  };
};

export type EngagementQuery = {
  userId: number;
  type?: EngagementItemType;
  sort: EngagementSort;
  limit: number;
  cursor?: string;
  baseUrl: string;
  now?: Date;
};

type Windows = { now: Date; d7: Date; d30: Date };
const windowsAt = (now: Date): Windows => ({
  now,
  d7: new Date(now.getTime() - 7 * DAY_MS),
  d30: new Date(now.getTime() - 30 * DAY_MS),
});

const intArray = (ids: number[]) => sql`string_to_array(${ids.join(',')}, ',')::int[]`;
// "Image", "Model", "CollectionItem", "ImageReaction" and "ResourceReview" store UTC wall-clock
// `timestamp(3)`; CommentV3 is the one `timestamptz`. Casting an ISO string to `timestamp` keeps it UTC.
const ts = (d: Date) => sql`${d.toISOString()}::timestamp`;
const tstz = (d: Date) => sql`${d.toISOString()}::timestamptz`;

const mediaTypesFor = (type?: EngagementItemType): Array<'image' | 'video'> =>
  type === 'image' ? ['image'] : type === 'video' ? ['video'] : type ? [] : ['image', 'video'];
const includesModels = (type?: EngagementItemType) => !type || type === 'model';

const visibleImageSql = sql`i.ingestion = 'Scanned' AND i."needsReview" IS NULL AND NOT i."tosViolation"
  AND p."publishedAt" IS NOT NULL AND p."publishedAt" <= now()`;
const visibleModelSql = sql`m.status = 'Published' AND m."deletedAt" IS NULL AND m.availability <> 'Private'`;

type ImageRow = {
  id: number;
  type: 'image' | 'video';
  name: string | null;
  url: string;
  createdAt: Date;
  nsfwLevel: number;
};
type ModelRow = { id: number; name: string; createdAt: Date; nsfwLevel: number };

/** Re-checks owner and visibility for ids that came from a cache, ClickHouse or a cursor. */
async function loadImages(userId: number, ids: number[], types: string[]): Promise<ImageRow[]> {
  if (!ids.length || !types.length) return [];
  const { rows } = await sql<ImageRow>`
    SELECT i.id, i.type, i.name, i.url, i."createdAt", i."nsfwLevel"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE i.id = ANY(${intArray(ids)}) AND i."userId" = ${userId}
      AND i.type::text = ANY(${sql`string_to_array(${types.join(',')}, ',')`})
      AND ${visibleImageSql}
  `.execute(kyselyRead);
  return rows;
}

async function loadModels(userId: number, ids: number[]): Promise<ModelRow[]> {
  if (!ids.length) return [];
  const { rows } = await sql<ModelRow>`
    SELECT m.id, m.name, m."createdAt", m."nsfwLevel"
    FROM "Model" m
    WHERE m.id = ANY(${intArray(ids)}) AND m."userId" = ${userId} AND ${visibleModelSql}
  `.execute(kyselyRead);
  return rows;
}

type Num = number | string | null;
const n = (v: Num | undefined) => Number(v ?? 0);
const emptyReactions = (): ReactionCounts => ({ total: 0, like: 0, heart: 0, laugh: 0, cry: 0 });
const emptyReviews = (): ReviewCounts => ({ total: 0, thumbsUp: 0, thumbsDown: 0 });
type Triple<T> = { d7: T; d30: T; allTime: T };

// The ranking reads only d30, so it passes `since` to skip older rows; `allTime` is then d30 too.
const sinceSql = (column: string, since: Date | undefined, cast = ts) =>
  since ? sql`AND ${sql.ref(column)} >= ${cast(since)}` : sql``;

async function imageReactionCounts(
  userId: number,
  ids: number[],
  w: Windows,
  excluded: number[],
  since?: Date
): Promise<Map<number, Triple<ReactionCounts>>> {
  const out = new Map<number, Triple<ReactionCounts>>();
  if (!ids.length) return out;
  const { rows } = await sql<{ id: number; reaction: string; d7: Num; d30: Num; all: Num }>`
    SELECT r."imageId" AS id, r.reaction::text AS reaction,
      count(*) FILTER (WHERE r."createdAt" >= ${ts(w.d7)}) AS d7,
      count(*) FILTER (WHERE r."createdAt" >= ${ts(w.d30)}) AS d30,
      count(*) AS all
    FROM "ImageReaction" r
    WHERE r."imageId" = ANY(${intArray(ids)})
      AND r."userId" <> ${userId}
      AND r."userId" <> ALL(${intArray(excluded)})
      AND r.reaction::text IN (${sql.join(IMAGE_REACTIONS.map((x) => sql`${x}`))})
      ${sinceSql('r.createdAt', since)}
    GROUP BY 1, 2
  `.execute(kyselyRead);
  for (const row of rows) {
    const entry = out.get(row.id) ?? {
      d7: emptyReactions(),
      d30: emptyReactions(),
      allTime: emptyReactions(),
    };
    const key = row.reaction.toLowerCase() as keyof ReactionCounts;
    for (const [block, value] of [
      [entry.d7, row.d7],
      [entry.d30, row.d30],
      [entry.allTime, row.all],
    ] as const) {
      block[key] += n(value);
      block.total += n(value);
    }
    out.set(row.id, entry);
  }
  return out;
}

async function modelReviewCounts(
  userId: number,
  ids: number[],
  w: Windows,
  excluded: number[],
  since?: Date
): Promise<Map<number, Triple<ReviewCounts>>> {
  const out = new Map<number, Triple<ReviewCounts>>();
  if (!ids.length) return out;
  const { rows } = await sql<{
    id: number;
    up7: Num;
    down7: Num;
    up30: Num;
    down30: Num;
    up: Num;
    down: Num;
  }>`
    SELECT r."modelId" AS id,
      count(*) FILTER (WHERE r.recommended AND r."createdAt" >= ${ts(w.d7)}) AS up7,
      count(*) FILTER (WHERE NOT r.recommended AND r."createdAt" >= ${ts(w.d7)}) AS down7,
      count(*) FILTER (WHERE r.recommended AND r."createdAt" >= ${ts(w.d30)}) AS up30,
      count(*) FILTER (WHERE NOT r.recommended AND r."createdAt" >= ${ts(w.d30)}) AS down30,
      count(*) FILTER (WHERE r.recommended) AS up,
      count(*) FILTER (WHERE NOT r.recommended) AS down
    FROM "ResourceReview" r
    WHERE r."modelId" = ANY(${intArray(ids)})
      AND r."userId" <> ${userId}
      AND r."userId" <> ALL(${intArray(excluded)})
      AND NOT r.exclude AND NOT r."tosViolation"
      AND ${sql.raw(visibleReviewSql('r'))}
      ${sinceSql('r.createdAt', since)}
    GROUP BY 1
  `.execute(kyselyRead);
  const block = (up: Num, down: Num): ReviewCounts => ({
    thumbsUp: n(up),
    thumbsDown: n(down),
    total: n(up) + n(down),
  });
  for (const r of rows)
    out.set(r.id, {
      d7: block(r.up7, r.down7),
      d30: block(r.up30, r.down30),
      allTime: block(r.up, r.down),
    });
  return out;
}

type Windowed = Triple<number>;
const toTriples = (rows: { id: number; d7: Num; d30: Num; all: Num }[]) =>
  new Map<number, Windowed>(
    rows.map((r) => [Number(r.id), { d7: n(r.d7), d30: n(r.d30), allTime: n(r.all) }])
  );

async function commentCounts(
  userId: number,
  entityType: 'image' | 'model',
  ids: number[],
  w: Windows,
  since?: Date
): Promise<Map<number, Windowed>> {
  if (!ids.length) return new Map();
  const { rows } = await sql<{ id: number; d7: Num; d30: Num; all: Num }>`
    SELECT c."entityId" AS id,
      count(*) FILTER (WHERE c."createdAt" >= ${tstz(w.d7)}) AS d7,
      count(*) FILTER (WHERE c."createdAt" >= ${tstz(w.d30)}) AS d30,
      count(*) AS all
    FROM "CommentV3" c
    WHERE c."entityType" = ${entityType}::"CommentEntityType"
      AND c."entityId" = ANY(${intArray(ids)})
      AND c."userId" <> ${userId}
      AND c."deletedAt" IS NULL AND NOT c."tosViolation" AND NOT c.hidden
      ${sinceSql('c.createdAt', since, tstz)}
    GROUP BY 1
  `.execute(kyselyRead);
  return toTriples(rows);
}

async function collectCounts(
  userId: number,
  column: 'imageId' | 'modelId',
  ids: number[],
  w: Windows,
  since?: Date
): Promise<Map<number, Windowed>> {
  if (!ids.length) return new Map();
  const col = sql.ref(`ci.${column}`);
  const { rows } = await sql<{ id: number; d7: Num; d30: Num; all: Num }>`
    SELECT ${col} AS id,
      count(*) FILTER (WHERE ci."createdAt" >= ${ts(w.d7)}) AS d7,
      count(*) FILTER (WHERE ci."createdAt" >= ${ts(w.d30)}) AS d30,
      count(*) AS all
    FROM "CollectionItem" ci
    WHERE ${col} = ANY(${intArray(ids)})
      AND ci.status = 'ACCEPTED'
      AND ci."addedById" IS DISTINCT FROM ${userId}
      ${sinceSql('ci.createdAt', since)}
    GROUP BY 1
  `.execute(kyselyRead);
  return toTriples(rows);
}

async function tippedBuzz(entityType: 'Image' | 'Model', ids: number[]) {
  if (!ids.length) return new Map<number, number>();
  const { rows } = await sql<{ id: number; amount: Num }>`
    SELECT t."entityId" AS id, sum(t.amount) AS amount
    FROM "BuzzTip" t
    WHERE t."entityType" = ${entityType} AND t."entityId" = ANY(${intArray(ids)})
    GROUP BY 1
  `.execute(kyselyRead);
  return new Map(rows.map((r) => [Number(r.id), n(r.amount)]));
}

async function modelExtras(ids: number[]) {
  if (!ids.length) return new Map<number, { versionCount: number; downloads: number }>();
  const { rows } = await sql<{ id: number; versions: Num; downloads: Num }>`
    SELECT m.id,
      (SELECT count(*) FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND mv.status = 'Published') AS versions,
      (SELECT mm."downloadCount" FROM "ModelMetric" mm WHERE mm."modelId" = m.id) AS downloads
    FROM "Model" m
    WHERE m.id = ANY(${intArray(ids)})
  `.execute(kyselyRead);
  return new Map(
    rows.map((r) => [Number(r.id), { versionCount: n(r.versions), downloads: n(r.downloads) }])
  );
}

/** Day-granular (UTC days, today partial). `undefined` when ClickHouse cannot answer. */
async function imageViews(ids: number[], w: Windows): Promise<Map<number, Windowed> | undefined> {
  if (!ids.length) return new Map();
  if (!clickhouse) return undefined;
  try {
    const rows = await clickhouse.$query<{ id: number; d7: Num; d30: Num; all: Num }>`
      SELECT entityId AS id,
        sumIf(views, createdDate > toDate(${w.d7})) AS d7,
        sumIf(views, createdDate > toDate(${w.d30})) AS d30,
        sum(views) AS all
      FROM daily_views
      WHERE entityType = 'Image' AND entityId IN (${ids})
      GROUP BY entityId
    `;
    return toTriples(rows);
  } catch (error) {
    reportClickhouseFailure('views', error);
    return undefined;
  }
}

function reportClickhouseFailure(part: string, error: unknown) {
  logToAxiom({
    type: 'warning',
    name: 'creator-engagement-clickhouse',
    part,
    message: (error as Error)?.message,
  }).catch(() => undefined);
}

async function hydrateImages(
  userId: number,
  rows: ImageRow[],
  w: Windows,
  baseUrl: string,
  excluded: number[]
): Promise<Map<number, MediaEngagementItem>> {
  const ids = rows.map((r) => r.id);
  const [reactions, comments, collects, tips, views] = await Promise.all([
    imageReactionCounts(userId, ids, w, excluded),
    commentCounts(userId, 'image', ids, w),
    collectCounts(userId, 'imageId', ids, w),
    tippedBuzz('Image', ids),
    imageViews(ids, w),
  ]);
  const zero: Windowed = { d7: 0, d30: 0, allTime: 0 };
  return new Map(
    rows.map((row) => {
      const r = reactions.get(row.id);
      const c = comments.get(row.id) ?? zero;
      const k = collects.get(row.id) ?? zero;
      const v = views ? views.get(row.id) ?? zero : undefined;
      const block = (key: keyof Windowed): WindowCounts<ReactionCounts> => ({
        reactions: r?.[key] ?? emptyReactions(),
        comments: c[key],
        collects: k[key],
        ...(v ? { views: v[key] } : {}),
      });
      return [
        row.id,
        {
          id: row.id,
          type: row.type,
          name: row.name,
          url: `${baseUrl}/images/${row.id}`,
          mediaUrl: getEdgeUrl(row.url, { type: row.type, original: true }),
          createdAt: new Date(row.createdAt).toISOString(),
          nsfwLevel: row.nsfwLevel,
          d7: block('d7'),
          d30: block('d30'),
          allTime: { ...block('allTime'), tippedBuzz: tips.get(row.id) ?? 0 },
        },
      ];
    })
  );
}

async function hydrateModels(
  userId: number,
  rows: ModelRow[],
  w: Windows,
  baseUrl: string,
  excluded: number[]
): Promise<Map<number, ModelEngagementItem>> {
  const ids = rows.map((r) => r.id);
  const [reviews, comments, collects, tips, extras] = await Promise.all([
    modelReviewCounts(userId, ids, w, excluded),
    commentCounts(userId, 'model', ids, w),
    collectCounts(userId, 'modelId', ids, w),
    tippedBuzz('Model', ids),
    modelExtras(ids),
  ]);
  const zero: Windowed = { d7: 0, d30: 0, allTime: 0 };
  return new Map(
    rows.map((row) => {
      const r = reviews.get(row.id);
      const c = comments.get(row.id) ?? zero;
      const k = collects.get(row.id) ?? zero;
      const extra = extras.get(row.id);
      const block = (key: keyof Windowed): WindowCounts<ReviewCounts> => ({
        reactions: r?.[key] ?? emptyReviews(),
        comments: c[key],
        collects: k[key],
      });
      return [
        row.id,
        {
          id: row.id,
          type: 'model' as const,
          name: row.name,
          url: `${baseUrl}/models/${row.id}`,
          createdAt: new Date(row.createdAt).toISOString(),
          nsfwLevel: row.nsfwLevel,
          versionCount: extra?.versionCount ?? 0,
          d7: block('d7'),
          d30: block('d30'),
          allTime: {
            ...block('allTime'),
            downloads: extra?.downloads ?? 0,
            tippedBuzz: tips.get(row.id) ?? 0,
          },
        },
      ];
    })
  );
}

type Position = { t: number; k: Kind; id: number };
const comparePosition = (a: Position, b: Position) =>
  b.t - a.t || KIND_ORDER[a.k] - KIND_ORDER[b.k] || b.id - a.id;

/** Rows of `kind` strictly after `cursor` in the merged order. */
function afterCursorSql(kind: Kind, cursor: Position | undefined, alias: string) {
  if (!cursor) return sql`TRUE`;
  const createdAt = sql.ref(`${alias}.createdAt`);
  const id = sql.ref(`${alias}.id`);
  const t = ts(new Date(cursor.t));
  if (KIND_ORDER[kind] > KIND_ORDER[cursor.k]) return sql`${createdAt} <= ${t}`;
  if (KIND_ORDER[kind] < KIND_ORDER[cursor.k]) return sql`${createdAt} < ${t}`;
  return sql`${createdAt} <= ${t} AND (${createdAt} < ${t} OR ${id} < ${cursor.id})`;
}

/**
 * Walks the caller's images newest-first on `(userId, createdAt)` in chunks, keeping the visible
 * ones of the requested media types. Stops at `limit + 1` matches or after NEWEST_SCAN_BUDGET rows;
 * in the second case `scanEnd` is where the next page resumes.
 */
async function newestImages(
  userId: number,
  types: string[],
  cursor: Position | undefined,
  limit: number
): Promise<{ rows: ImageRow[]; scanEnd?: Position }> {
  const found: ImageRow[] = [];
  let position = cursor;
  let scanned = 0;
  let chunk = Math.max(50, (limit + 1) * 2);
  while (found.length <= limit && scanned < NEWEST_SCAN_BUDGET) {
    const take = Math.min(chunk, NEWEST_SCAN_BUDGET - scanned);
    chunk = Math.min(chunk * 2, 2000);
    const { rows: scan } = await sql<{ id: number; createdAt: Date }>`
      SELECT i.id, i."createdAt" FROM "Image" i
      WHERE i."userId" = ${userId} AND ${afterCursorSql('i', position, 'i')}
      ORDER BY i."createdAt" DESC, i.id DESC
      LIMIT ${take}
    `.execute(kyselyRead);
    scanned += scan.length;
    if (!scan.length) return { rows: found };
    const visible = await loadImages(
      userId,
      scan.map((s) => s.id),
      types
    );
    const byId = new Map(visible.map((v) => [v.id, v]));
    for (const s of scan) {
      const row = byId.get(s.id);
      if (row) found.push(row);
    }
    const last = scan[scan.length - 1];
    position = { t: new Date(last.createdAt).getTime(), k: 'i', id: last.id };
    if (scan.length < take) return { rows: found };
  }
  return found.length > limit ? { rows: found } : { rows: found, scanEnd: position };
}

async function newestModels(
  userId: number,
  cursor: Position | undefined,
  limit: number
): Promise<ModelRow[]> {
  const { rows } = await sql<ModelRow>`
    SELECT m.id, m.name, m."createdAt", m."nsfwLevel" FROM "Model" m
    WHERE m."userId" = ${userId} AND ${visibleModelSql} AND ${afterCursorSql('m', cursor, 'm')}
    ORDER BY m."createdAt" DESC, m.id DESC
    LIMIT ${limit + 1}
  `.execute(kyselyRead);
  return rows;
}

async function getNewestPage(q: Required<Pick<EngagementQuery, 'limit'>> & EngagementQuery) {
  const cursor = q.cursor ? decodeCursor(q.cursor, newestCursorSchema) : undefined;
  const types = mediaTypesFor(q.type);
  const [images, models] = await Promise.all([
    types.length
      ? newestImages(q.userId, types, cursor, q.limit)
      : Promise.resolve<Awaited<ReturnType<typeof newestImages>>>({ rows: [] }),
    includesModels(q.type) ? newestModels(q.userId, cursor, q.limit) : Promise.resolve([]),
  ]);
  type Entry = Position & ({ image: ImageRow } | { model: ModelRow });
  let merged: Entry[] = [
    ...images.rows.map((image) => ({
      t: new Date(image.createdAt).getTime(),
      k: 'i' as const,
      id: image.id,
      image,
    })),
    ...models.map((model) => ({
      t: new Date(model.createdAt).getTime(),
      k: 'm' as const,
      id: model.id,
      model,
    })),
  ].sort(comparePosition);
  const scanEnd = images.scanEnd;
  if (scanEnd) merged = merged.filter((e) => comparePosition(e, scanEnd) <= 0);

  const page = merged.slice(0, q.limit);
  const more = merged.length > q.limit || !!scanEnd;
  const last = merged.length > q.limit ? page[page.length - 1] : scanEnd;
  const nextCursor =
    more && last ? encodeCursor({ s: 'n', t: last.t, k: last.k, id: last.id }) : null;

  const items = await hydratePage(q, page);
  return { items, metadata: { nextCursor } } satisfies EngagementPage;
}

type PageEntry = { k: Kind; id: number } & ({ image: ImageRow } | { model: ModelRow });

async function hydratePage(q: EngagementQuery, page: PageEntry[]): Promise<EngagementItem[]> {
  const w = windowsAt(q.now ?? new Date());
  const excluded = await getMetricExcludedUserIds();
  const imageRows = page.flatMap((e) => ('image' in e ? [e.image] : []));
  const modelRows = page.flatMap((e) => ('model' in e ? [e.model] : []));
  const [images, models] = await Promise.all([
    hydrateImages(q.userId, imageRows, w, q.baseUrl, excluded),
    hydrateModels(q.userId, modelRows, w, q.baseUrl, excluded),
  ]);
  return page.flatMap((e) => {
    const item = e.k === 'i' ? images.get(e.id) : models.get(e.id);
    return item ? [item] : [];
  });
}

type RankedEntry = { k: Kind; id: number; v: number };
type Ranking = { entries: RankedEntry[]; imageCandidates?: 'reactions-30d' | 'newest' };

const compareRanked = (a: RankedEntry, b: RankedEntry) =>
  b.v - a.v || KIND_ORDER[a.k] - KIND_ORDER[b.k] || b.id - a.id;

/**
 * `reactions` sorts on time first, not `ownerId`, so this reads every reaction of the last 30 days.
 * Cached per owner, not per ranking type, so the image, video and all rankings share one scan.
 */
async function reactedImageIds(userId: number, w: Windows, excluded: number[]) {
  const ch = clickhouse;
  if (!ch) return undefined;
  const key =
    `${REDIS_KEYS.CACHES.CREATOR_ENGAGEMENT_CANDIDATES}:${userId}` as RedisKeyTemplateCache;
  try {
    return await fetchThroughCache(key, () => scanReactedImageIds(ch, userId, w, excluded), {
      ttl: RANKING_TTL,
    });
  } catch (error) {
    reportClickhouseFailure('ranking', error);
    return undefined;
  }
}

async function scanReactedImageIds(
  ch: NonNullable<typeof clickhouse>,
  userId: number,
  w: Windows,
  excluded: number[]
) {
  const excludedSql = excluded.length ? `AND userId NOT IN (${excluded.join(',')})` : '';
  const rows = await ch.$query<{ id: number }>(`
      SELECT entityId AS id, sum(if(type = 'Image_Create', 1, -1)) AS net
      FROM reactions
      WHERE ownerId = ${Number(userId)} AND userId != ${Number(userId)} ${excludedSql}
        AND type IN ('Image_Create', 'Image_Delete')
        AND time >= parseDateTimeBestEffort('${w.d30.toISOString()}')
      GROUP BY entityId
      HAVING net > 0
      ORDER BY net DESC, entityId DESC
      LIMIT ${RANKING_IMAGE_CANDIDATES}
    `);
  return rows.map((r) => Number(r.id));
}

async function newestVisibleImageIds(userId: number, types: string[], take: number) {
  const { rows } = await newestImages(userId, types, undefined, take - 1);
  return rows.map((r) => r.id);
}

async function newestVisibleModelIds(userId: number) {
  return (await newestModels(userId, undefined, RANKING_MODEL_CANDIDATES - 1)).map((m) => m.id);
}

async function buildRanking(userId: number, type: EngagementItemType | undefined, now: Date) {
  const w = windowsAt(now);
  const excluded = await getMetricExcludedUserIds();
  const types = mediaTypesFor(type);
  const entries: RankedEntry[] = [];
  let imageCandidates: Ranking['imageCandidates'];

  if (types.length) {
    const reacted = await reactedImageIds(userId, w, excluded);
    imageCandidates = reacted ? 'reactions-30d' : 'newest';
    const ids = reacted ?? (await newestVisibleImageIds(userId, types, RANKING_FALLBACK_IMAGES));
    const rows = await loadImages(userId, ids, types);
    const kept = rows.map((r) => r.id);
    const [reactions, comments, collects] = await Promise.all([
      imageReactionCounts(userId, kept, w, excluded, w.d30),
      commentCounts(userId, 'image', kept, w, w.d30),
      collectCounts(userId, 'imageId', kept, w, w.d30),
    ]);
    for (const id of kept)
      entries.push({
        k: 'i',
        id,
        v:
          (reactions.get(id)?.d30.total ?? 0) +
          (comments.get(id)?.d30 ?? 0) +
          (collects.get(id)?.d30 ?? 0),
      });
  }

  if (includesModels(type)) {
    const ids = await newestVisibleModelIds(userId);
    const [reviews, comments, collects] = await Promise.all([
      modelReviewCounts(userId, ids, w, excluded, w.d30),
      commentCounts(userId, 'model', ids, w, w.d30),
      collectCounts(userId, 'modelId', ids, w, w.d30),
    ]);
    for (const id of ids)
      entries.push({
        k: 'm',
        id,
        v:
          (reviews.get(id)?.d30.total ?? 0) +
          (comments.get(id)?.d30 ?? 0) +
          (collects.get(id)?.d30 ?? 0),
      });
  }

  return {
    entries: entries
      .filter((e) => e.v > 0)
      .sort(compareRanked)
      .slice(0, RANKING_MAX_ITEMS),
    imageCandidates,
  } satisfies Ranking;
}

function getRanking(userId: number, type: EngagementItemType | undefined, now: Date) {
  const key = `${REDIS_KEYS.CACHES.CREATOR_ENGAGEMENT_RANKING}:${userId}:${
    type ?? 'all'
  }` as RedisKeyTemplateCache;
  return fetchThroughCache(key, () => buildRanking(userId, type, now), { ttl: RANKING_TTL });
}

async function getEngagementPage(q: EngagementQuery): Promise<EngagementPage> {
  const cursor = q.cursor ? decodeCursor(q.cursor, engagementCursorSchema) : undefined;
  const ranking = await getRanking(q.userId, q.type, q.now ?? new Date());
  const remaining = cursor
    ? ranking.entries.filter((e) => compareRanked(e, cursor) > 0)
    : ranking.entries;
  const page = remaining.slice(0, q.limit);

  const types = mediaTypesFor(q.type);
  const [imageRows, modelRows] = await Promise.all([
    loadImages(
      q.userId,
      page.filter((e) => e.k === 'i').map((e) => e.id),
      types
    ),
    loadModels(
      q.userId,
      page.filter((e) => e.k === 'm').map((e) => e.id)
    ),
  ]);
  const images = new Map(imageRows.map((r) => [r.id, r]));
  const models = new Map(modelRows.map((r) => [r.id, r]));
  const owned = page.flatMap((e): PageEntry[] => {
    const image = e.k === 'i' ? images.get(e.id) : undefined;
    const model = e.k === 'm' ? models.get(e.id) : undefined;
    if (image) return [{ k: e.k, id: e.id, image }];
    if (model) return [{ k: e.k, id: e.id, model }];
    return [];
  });

  const last = page[page.length - 1];
  const nextCursor =
    remaining.length > q.limit && last
      ? encodeCursor({ s: 'e', v: last.v, k: last.k, id: last.id })
      : null;
  return {
    items: await hydratePage(q, owned),
    metadata: {
      nextCursor,
      ...(ranking.imageCandidates ? { imageCandidates: ranking.imageCandidates } : {}),
    },
  };
}

export async function getCreatorEngagement(query: EngagementQuery): Promise<EngagementPage> {
  return query.sort === 'newest' ? getNewestPage(query) : getEngagementPage(query);
}
