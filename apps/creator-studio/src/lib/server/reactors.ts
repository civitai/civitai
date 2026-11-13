import { error, json, type RequestHandler } from '@sveltejs/kit';
import { sql } from '@civitai/db/kysely';
import { sfwBrowsingLevelsFlag } from '@civitai/shared';
import {
  HIDE_FROM_REACTION_LISTS_KEY,
  IMAGE_REACTOR_LISTS_LAUNCHED_AT,
  SHOW_PRE_LAUNCH_REACTIONS_KEY,
} from '@civitai/shared/reaction-privacy';
import { dbRead } from '$lib/server/db';
import { followersAmong } from '$lib/server/followers';
import { getMetricExcludedUserIds } from '$lib/server/metric-excluded-users';
import {
  assembleReactorPage,
  defaultReaction,
  emptyCounts,
  parseInt4Id,
  parseReactorQuery,
  REACTOR_TYPES,
  REACTORS_PAGE_SIZE,
  type ReactorCursor,
  type ReactorPage,
  type ReactorQuery,
  type ReactorType,
} from '$lib/analytics/reactors';

export type ReactorEntity = 'image' | 'article';

const TABLES = {
  image: { content: 'Image', reactions: 'ImageReaction', fk: 'imageId' },
  article: { content: 'Article', reactions: 'ArticleReaction', fk: 'articleId' },
} as const;

// AiNotVerified is blocked but not removed: the owner fixes it by adding metadata, so they keep the lists.
// `ownsListableContent` applies the same rule in SQL, and the site's `hidesReactors` mirrors it.
export const imageAudienceListable = (image: { ingestion: string; blockedFor: string | null }) =>
  image.ingestion !== 'Blocked' || image.blockedFor === 'AiNotVerified';

export async function ownsListableContent(
  db: typeof dbRead,
  ownerId: number,
  entity: ReactorEntity,
  entityId: number
): Promise<boolean> {
  const listable =
    entity === 'image'
      ? sql` AND (ingestion IS DISTINCT FROM 'Blocked' OR "blockedFor" = 'AiNotVerified')`
      : sql``;
  const owned = await sql<{ id: number }>`
    SELECT id FROM ${sql.table(TABLES[entity].content)} WHERE id = ${entityId} AND "userId" = ${ownerId}${listable}
  `.execute(db);
  return owned.rows.length > 0;
}

/** The item column of a content table's rows in `CollectionItem`, `ImageReaction`, and the like. */
export const contentFk = (entity: ReactorEntity) => TABLES[entity].fk;

/** `after` pages older accounts (id below the cursor, descending); `before` pages newer ones (ascending). */
export function keysetClause(column: string, cursor: ReactorCursor) {
  const col = sql.ref(column);
  const bound = !cursor
    ? sql``
    : cursor.dir === 'after'
      ? sql`AND ${col} < ${cursor.userId}`
      : sql`AND ${col} > ${cursor.userId}`;
  return { bound, order: cursor?.dir === 'before' ? sql`ASC` : sql`DESC` };
}

/**
 * The user in `userIdColumn` may be named to `viewerId`: false only for someone else who opted out of reaction and
 * collector lists. Goes in the page query only, never the counts, so totals still include them.
 */
export const listedToViewer = (userIdColumn: string, viewerId: number) => sql`
  (${sql.ref(userIdColumn)} = ${viewerId} OR NOT EXISTS (
    SELECT 1 FROM "User" hidden WHERE hidden.id = ${sql.ref(userIdColumn)}
      AND hidden.settings -> ${HIDE_FROM_REACTION_LISTS_KEY}::text = 'true'::jsonb
  ))`;

/**
 * An image reaction made before "who reacted" lists launched is listed only when its reactor opted in; the viewer's
 * own always is. Same rule and same `User_showPreLaunchReactions_idx` InitPlan as the main app's
 * `imageReactionListedToViewer`. Page query only, like `listedToViewer`.
 */
export const preLaunchImageReactionListed = (viewerId: number) => sql`
  ("ImageReaction"."userId" = ${viewerId}
    OR "ImageReaction"."createdAt" >= ${IMAGE_REACTOR_LISTS_LAUNCHED_AT}::timestamp
    OR "ImageReaction"."userId" = ANY(ARRAY(
      SELECT id FROM "User" WHERE settings -> ${sql.lit(SHOW_PRE_LAUNCH_REACTIONS_KEY)}::text = 'true'::jsonb
    )))`;

/**
 * Only a scanned, safe-level profile picture not held for CSAM review, as the main app's `servableProfilePictureSql`;
 * the legacy User.image is unmoderated. Reads alias `p` (Image).
 */
export const safeProfilePictureUrl = () => sql`
  CASE
    WHEN p.ingestion = 'Scanned' AND p."nsfwLevel" > 0
      AND (p."nsfwLevel" & ~${sql.lit(sfwBrowsingLevelsFlag)}) = 0
      AND p."needsReview" IS DISTINCT FROM 'csam' THEN p.url
  END`;

/**
 * Who reacted to one piece of the caller's content, one reaction type at a time. Returns null when the entity is
 * not the caller's or is a removed image, which the route turns into the same 404 as a missing entity.
 *
 * Keyset-paged on `userId` (newest account first) because that is what the `(entityId, userId)` indexes serve at
 * constant cost per page. Do not switch to reaction-time order without adding an index: none covers
 * `(entityId, reaction, createdAt)`, so every page would sort all of the entity's reactions.
 */
export async function getReactors(
  db: typeof dbRead,
  ownerId: number,
  entity: ReactorEntity,
  entityId: number,
  query: ReactorQuery
): Promise<ReactorPage | null> {
  const t = TABLES[entity];

  if (!(await ownsListableContent(db, ownerId, entity, entityId))) return null;

  // Reactors the site's reaction totals leave out, left out of the counts and the list too so both match the
  // reaction bar. In SQL, before the LIMIT, so a page still fills.
  const notCounted = await getMetricExcludedUserIds();
  const counted = notCounted.length
    ? sql`AND NOT (${sql.ref('userId')} = ANY(${notCounted}::int[]))`
    : sql``;

  const countRows = await sql<{ reaction: string; n: number }>`
    SELECT reaction, count(*)::int AS n FROM ${sql.table(t.reactions)}
    WHERE ${sql.ref(t.fk)} = ${entityId} ${counted}
    GROUP BY reaction
  `.execute(db);
  const counts = emptyCounts();
  for (const r of countRows.rows) {
    if ((REACTOR_TYPES as readonly string[]).includes(r.reaction))
      counts[r.reaction as ReactorType] = Number(r.n);
  }

  const reaction = query.reaction ?? defaultReaction(counts);
  if (!reaction || counts[reaction] === 0)
    return { reaction, counts, reactors: [], next: null, prev: null };

  const { cursor } = query;
  const { bound, order } = keysetClause('userId', cursor);

  const { rows } = await sql<ReactorRow>`
    SELECT r."userId", r."createdAt", u.username, u."deletedAt", u."bannedAt",
      ${safeProfilePictureUrl()} AS image
    FROM (
      SELECT "userId", "createdAt" FROM ${sql.table(t.reactions)}
      WHERE ${sql.ref(t.fk)} = ${entityId} AND reaction = ${reaction}
        AND ${listedToViewer(`${t.reactions}.userId`, ownerId)}
        ${entity === 'image' ? sql`AND ${preLaunchImageReactionListed(ownerId)}` : sql``} ${counted} ${bound}
      ORDER BY "userId" ${order}
      LIMIT ${REACTORS_PAGE_SIZE + 1}
    ) r
    LEFT JOIN "User" u ON u.id = r."userId"
    LEFT JOIN "Image" p ON p.id = u."profilePictureId"
    ORDER BY r."userId" ${order}
  `.execute(db);

  return { reaction, counts, ...(await toReactorPage(db, ownerId, rows, cursor)) };
}

type ReactorRow = {
  userId: number;
  createdAt: Date;
  username: string | null;
  deletedAt: Date | null;
  bannedAt: Date | null;
  image: string | null;
};

async function toReactorPage(
  db: typeof dbRead,
  ownerId: number,
  rows: ReactorRow[],
  cursor: ReactorCursor
): Promise<Pick<ReactorPage, 'reactors' | 'next' | 'prev'>> {
  const page = assembleReactorPage(rows, cursor);
  const followers = await followersAmong(
    db,
    ownerId,
    page.rows.filter((r) => !r.deletedAt && r.userId !== ownerId).map((r) => r.userId)
  );
  return {
    reactors: page.rows.map((r) => ({
      userId: r.userId,
      username: r.deletedAt ? null : r.username,
      image: r.deletedAt ? null : r.image,
      reactedAt: new Date(r.createdAt).toISOString(),
      deleted: !!r.deletedAt,
      banned: !!r.bannedAt,
      follows: followers.has(r.userId),
    })),
    next: page.next,
    prev: page.prev,
  };
}

/** A thumbs-up review as the site's thumbs-up metric counts it. Reads alias `rr` (ResourceReview). */
const countedThumbsUp = sql`
  rr.recommended AND NOT rr.exclude AND NOT rr."tosViolation"
  AND (rr."postId" IS NULL OR EXISTS (
    SELECT 1 FROM "Post" rvp WHERE rvp.id = rr."postId" AND rvp."publishedAt" <= now()
  ))`;

const notMetricExcluded = (ids: number[]) =>
  ids.length ? sql`AND NOT (rr."userId" = ANY(${ids}::int[]))` : sql``;

/**
 * Who left a thumbs-up on any version of the caller's model, one row per user. Null when the model is not theirs or a
 * moderator took it down, as for a blocked image; one the owner deleted or unpublished still lists.
 *
 * Paged on `userId` per version because `ResourceReview` has no index on `modelId`, nor on `createdAt` for
 * thumbs-only rows: like-time order would sort every review of the model.
 */
export async function getModelLikers(
  db: typeof dbRead,
  ownerId: number,
  modelId: number,
  cursor: ReactorCursor
): Promise<ReactorPage | null> {
  const owned = await sql<{ id: number }>`
    SELECT id FROM "Model" WHERE id = ${modelId} AND "userId" = ${ownerId}
      AND status IS DISTINCT FROM 'UnpublishedViolation' AND mode IS DISTINCT FROM 'TakenDown'
  `.execute(db);
  if (!owned.rows.length) return null;

  // The site's own thumbs-up total: an exact count would read every review of the model, which a large one cannot
  // afford per page view.
  const [metric, notCounted] = await Promise.all([
    sql<{ thumbsUpCount: number }>`
      SELECT "thumbsUpCount" FROM "ModelMetric" WHERE "modelId" = ${modelId}
    `.execute(db),
    getMetricExcludedUserIds(),
  ]);
  const { bound, order } = keysetClause('rr.userId', cursor);
  const { rows } = await sql<ReactorRow>`
    SELECT r."userId", r."createdAt", u.username, u."deletedAt", u."bannedAt",
      ${safeProfilePictureUrl()} AS image
    FROM (
      SELECT x."userId", max(x."createdAt") AS "createdAt"
      FROM "ModelVersion" mv
      CROSS JOIN LATERAL (
        SELECT rr."userId", rr."createdAt" FROM "ResourceReview" rr
        WHERE rr."modelVersionId" = mv.id AND ${countedThumbsUp}
          AND ${listedToViewer('rr.userId', ownerId)} ${notMetricExcluded(notCounted)} ${bound}
        ORDER BY rr."userId" ${order}
        LIMIT ${REACTORS_PAGE_SIZE + 1}
      ) x
      WHERE mv."modelId" = ${modelId}
      GROUP BY x."userId"
      ORDER BY x."userId" ${order}
      LIMIT ${REACTORS_PAGE_SIZE + 1}
    ) r
    LEFT JOIN "User" u ON u.id = r."userId"
    LEFT JOIN "Image" p ON p.id = u."profilePictureId"
    ORDER BY r."userId" ${order}
  `.execute(db);

  const page = await toReactorPage(db, ownerId, rows, cursor);
  // The metric trails new likes by a job run: never show fewer than are listed, and an empty first page means none.
  const counts = emptyCounts();
  counts.Like =
    !cursor && !page.reactors.length
      ? 0
      : Math.max(Number(metric.rows[0]?.thumbsUpCount ?? 0), page.reactors.length);
  return { reaction: 'Like', counts, ...page };
}

/** GET handler for `…/<entity>/[id]/reactors`. Owner-only by construction: `getReactors` scopes to `locals.user`. */
export function reactorsHandler(
  entity: ReactorEntity,
  idParam: 'imageId' | 'articleId'
): RequestHandler {
  return async ({ locals, params, url }) => {
    const entityId = parseInt4Id(params[idParam] ?? '');
    if (entityId === null) throw error(400, 'Invalid id');
    const parsed = parseReactorQuery(url.searchParams);
    if (!parsed.ok) throw error(400, parsed.message);

    const page = await getReactors(dbRead, locals.user.id, entity, entityId, parsed.value);
    if (!page) throw error(404, 'Not found, or not yours');
    return json(page, { headers: { 'cache-control': 'private, no-store' } });
  };
}

/** GET handler for `/analytics/models/[modelId]/likers`. Owner-only: `getModelLikers` scopes to `locals.user`. */
export const modelLikersHandler: RequestHandler = async ({ locals, params, url }) => {
  const modelId = parseInt4Id(params.modelId ?? '');
  if (modelId === null) throw error(400, 'Invalid id');
  const parsed = parseReactorQuery(url.searchParams);
  if (!parsed.ok) throw error(400, parsed.message);
  if (parsed.value.reaction !== null && parsed.value.reaction !== 'Like')
    throw error(400, 'Unknown reaction type');

  const page = await getModelLikers(dbRead, locals.user.id, modelId, parsed.value.cursor);
  if (!page) throw error(404, 'Not found, or not yours');
  return json(page, { headers: { 'cache-control': 'private, no-store' } });
};
