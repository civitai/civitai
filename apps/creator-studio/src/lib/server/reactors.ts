import { error, json, type RequestHandler } from '@sveltejs/kit';
import { sql } from '@civitai/db/kysely';
import { sfwBrowsingLevelsFlag } from '@civitai/shared';
import { dbRead } from '$lib/server/db';
import {
  assembleReactorPage,
  defaultReaction,
  emptyCounts,
  parseInt4Id,
  parseReactorQuery,
  REACTOR_TYPES,
  REACTORS_PAGE_SIZE,
  type ReactorPage,
  type ReactorQuery,
  type ReactorType,
} from '$lib/analytics/reactors';

export type ReactorEntity = 'image' | 'article';

const TABLES = {
  image: { content: 'Image', reactions: 'ImageReaction', fk: 'imageId' },
  article: { content: 'Article', reactions: 'ArticleReaction', fk: 'articleId' },
} as const;

/**
 * Who reacted to one piece of the caller's content, one reaction type at a time. Returns null when the entity is
 * not the caller's, which the route turns into the same 404 as a missing entity.
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

  const owned = await sql<{ id: number }>`
    SELECT id FROM ${sql.table(t.content)} WHERE id = ${entityId} AND "userId" = ${ownerId}
  `.execute(db);
  if (!owned.rows.length) return null;

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
  const bound = !cursor
    ? sql``
    : cursor.dir === 'after'
      ? sql`AND "userId" < ${cursor.userId}`
      : sql`AND "userId" > ${cursor.userId}`;
  const order = cursor?.dir === 'before' ? sql`ASC` : sql`DESC`;

  const { rows } = await sql<{
    userId: number;
    createdAt: Date;
    username: string | null;
    deletedAt: Date | null;
    bannedAt: Date | null;
    image: string | null;
  }>`
    SELECT r."userId", r."createdAt", u.username, u."deletedAt", u."bannedAt",
      -- Only a scanned, safe-level profile picture; the legacy User.image is unmoderated. Otherwise initials.
      CASE
        WHEN p.ingestion = 'Scanned' AND p."nsfwLevel" > 0
          AND (p."nsfwLevel" & ~${sql.lit(sfwBrowsingLevelsFlag)}) = 0 THEN p.url
      END AS image
    FROM (
      SELECT "userId", "createdAt" FROM ${sql.table(t.reactions)}
      WHERE ${sql.ref(t.fk)} = ${entityId} AND reaction = ${reaction} ${bound}
      ORDER BY "userId" ${order}
      LIMIT ${REACTORS_PAGE_SIZE + 1}
    ) r
    LEFT JOIN "User" u ON u.id = r."userId"
    LEFT JOIN "Image" p ON p.id = u."profilePictureId"
    ORDER BY r."userId" ${order}
  `.execute(db);

  const page = assembleReactorPage(rows, cursor);
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
