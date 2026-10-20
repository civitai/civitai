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

/** Only a scanned, safe-level profile picture; the legacy User.image is unmoderated. Reads alias `p` (Image). */
export const safeProfilePictureUrl = () => sql`
  CASE
    WHEN p.ingestion = 'Scanned' AND p."nsfwLevel" > 0
      AND (p."nsfwLevel" & ~${sql.lit(sfwBrowsingLevelsFlag)}) = 0 THEN p.url
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

  const countRows = await sql<{ reaction: string; n: number }>`
    SELECT reaction, count(*)::int AS n FROM ${sql.table(t.reactions)}
    WHERE ${sql.ref(t.fk)} = ${entityId}
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

  const { rows } = await sql<{
    userId: number;
    createdAt: Date;
    username: string | null;
    deletedAt: Date | null;
    bannedAt: Date | null;
    image: string | null;
  }>`
    SELECT r."userId", r."createdAt", u.username, u."deletedAt", u."bannedAt",
      ${safeProfilePictureUrl()} AS image
    FROM (
      SELECT "userId", "createdAt" FROM ${sql.table(t.reactions)}
      WHERE ${sql.ref(t.fk)} = ${entityId} AND reaction = ${reaction}
        AND ${listedToViewer(`${t.reactions}.userId`, ownerId)}
        ${entity === 'image' ? sql`AND ${preLaunchImageReactionListed(ownerId)}` : sql``} ${bound}
      ORDER BY "userId" ${order}
      LIMIT ${REACTORS_PAGE_SIZE + 1}
    ) r
    LEFT JOIN "User" u ON u.id = r."userId"
    LEFT JOIN "Image" p ON p.id = u."profilePictureId"
    ORDER BY r."userId" ${order}
  `.execute(db);

  const page = assembleReactorPage(rows, cursor);
  const followers = await followersAmong(
    db,
    ownerId,
    page.rows.filter((r) => !r.deletedAt && r.userId !== ownerId).map((r) => r.userId)
  );
  return {
    reaction,
    counts,
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
