import { error, json, type RequestHandler } from '@sveltejs/kit';
import { sql } from '@civitai/db/kysely';
import { dbRead } from '$lib/server/db';
import { followersAmong } from '$lib/server/followers';
import {
  contentFk,
  keysetClause,
  listedToViewer,
  ownsListableContent,
  safeProfilePictureUrl,
  type ReactorEntity,
} from '$lib/server/reactors';
import type { CollectorPage } from '$lib/analytics/collectors';
import {
  assembleReactorPage,
  parseInt4Id,
  parseKeysetCursor,
  REACTORS_PAGE_SIZE,
  type ReactorCursor,
} from '$lib/analytics/reactors';

/**
 * Who has one piece of the caller's content in a public collection. Only `read = Public` collections count: a
 * private or unlisted collection is not browsable by anyone else, so naming its owner here would expose a
 * choice the owner never made public. Items still in review or rejected are not on the collection page either.
 *
 * "Collected" means the owner added it to their own collection: contest collections hold entries the creator
 * submitted, and in a shared collection a contributor's add would be pinned on the owner. Returns null when the
 * entity is not the caller's or is a removed image.
 *
 * Keyset-paged on the collection owner's `userId`, newest account first, like the reactors list.
 */
export async function getCollectors(
  db: typeof dbRead,
  ownerId: number,
  entity: ReactorEntity,
  entityId: number,
  cursor: ReactorCursor
): Promise<CollectorPage | null> {
  if (!(await ownsListableContent(db, ownerId, entity, entityId))) return null;

  const source = sql`
    "CollectionItem" ci
    JOIN "Collection" c ON c.id = ci."collectionId"
    JOIN "User" o ON o.id = c."userId" AND o."deletedAt" IS NULL`;
  const visible = sql`
    ci.status = 'ACCEPTED' AND c.read = 'Public' AND c.availability = 'Public'
    AND c.mode IS DISTINCT FROM 'Contest' AND ci."addedById" = c."userId"
    AND ${sql.ref(`ci.${contentFk(entity)}`)} = ${entityId} AND c."userId" <> ${ownerId}`;

  const totals = await sql<{ n: number }>`
    SELECT count(DISTINCT c."userId")::int AS n FROM ${source} WHERE ${visible}
  `.execute(db);
  const total = Number(totals.rows[0]?.n ?? 0);
  if (total === 0) return { total, collectors: [], next: null, prev: null };

  const { bound, order } = keysetClause('c.userId', cursor);

  const { rows } = await sql<{
    userId: number;
    createdAt: Date;
    collections: number;
    username: string | null;
    bannedAt: Date | null;
    image: string | null;
  }>`
    SELECT g."userId", g."createdAt", g.collections, u.username, u."bannedAt",
      ${safeProfilePictureUrl()} AS image
    FROM (
      SELECT c."userId", min(ci."createdAt") AS "createdAt", count(DISTINCT c.id)::int AS collections
      FROM ${source}
      WHERE ${visible} AND ${listedToViewer('c.userId', ownerId)} ${bound}
      GROUP BY c."userId"
      ORDER BY c."userId" ${order}
      LIMIT ${REACTORS_PAGE_SIZE + 1}
    ) g
    JOIN "User" u ON u.id = g."userId"
    LEFT JOIN "Image" p ON p.id = u."profilePictureId"
    ORDER BY g."userId" ${order}
  `.execute(db);

  const page = assembleReactorPage(rows, cursor);
  const followers = await followersAmong(
    db,
    ownerId,
    page.rows.map((r) => r.userId)
  );
  return {
    total,
    collectors: page.rows.map((r) => ({
      userId: r.userId,
      username: r.username,
      image: r.image,
      collectedAt: new Date(r.createdAt).toISOString(),
      collections: Number(r.collections),
      banned: !!r.bannedAt,
      follows: followers.has(r.userId),
    })),
    next: page.next,
    prev: page.prev,
  };
}

/** GET handler for `…/<entity>/[id]/collectors`. Owner-only by construction: `getCollectors` scopes to `locals.user`. */
export function collectorsHandler(
  entity: ReactorEntity,
  idParam: 'imageId' | 'articleId'
): RequestHandler {
  return async ({ locals, params, url }) => {
    const entityId = parseInt4Id(params[idParam] ?? '');
    if (entityId === null) throw error(400, 'Invalid id');
    const parsed = parseKeysetCursor(url.searchParams);
    if (!parsed.ok) throw error(400, parsed.message);

    const page = await getCollectors(dbRead, locals.user.id, entity, entityId, parsed.value);
    if (!page) throw error(404, 'Not found, or not yours');
    return json(page, { headers: { 'cache-control': 'private, no-store' } });
  };
}
