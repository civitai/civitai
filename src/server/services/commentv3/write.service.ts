import type { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import type { SqlRunner } from '~/server/services/comment-v3-backfill.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * Comment writes on CommentV3 for the surfaces in `constants.comments.v3WriteSurfaces`
 * (`docs/plans/comments-v3-article-flip.md`, stage B). A new comment on one of them exists only here:
 * no `CommentV2` or `Thread` row is written. A comment written before its surface flipped keeps its
 * CommentV2 row, which every write here keeps in step (`syncOldRows`).
 *
 * Raw SQL over a `SqlRunner` (D8), so a caller can run these in the transaction that spends its
 * stickers or writes the old tables. Id lists travel as one comma-joined string, which pg and
 * PGlite send alike.
 */

/** Whether comments on `entityType` are written to CommentV3 directly. */
export const isV3WriteSurface = (entityType: string) =>
  constants.comments.v3WriteSurfaces.includes(entityType);

/** SQL: CommentV2 row `alias` has a CommentV3 twin on a CommentV3-write surface. */
export const hasV3SurfaceTwinSql = (alias: string) =>
  `EXISTS (SELECT 1 FROM "CommentV3" v WHERE v.id = ${alias}.id AND ${v3WriteSurfaceSql(
    'v."entityType"'
  )})`;

/** A user's live comments on CommentV3-write surfaces matching `condition`, optionally of `among`. */
export async function v3SurfaceCommentIds(
  db: SqlRunner,
  userId: number,
  condition: string,
  among?: number[]
) {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM "CommentV3"
     WHERE "userId" = $1 AND "deletedAt" IS NULL AND ${condition}
       AND ${v3WriteSurfaceSql('"entityType"')}
       ${among ? `AND id = ANY(string_to_array($2, ',')::int[])` : ''}`,
    among ? [userId, among.join(',')] : [userId]
  );
  return rows.map((r) => r.id);
}

/** `isV3WriteSurface` as SQL over a CommentEntityType column. */
export const v3WriteSurfaceSql = (column: string) =>
  constants.comments.v3WriteSurfaces.length
    ? `${column}::text IN (${constants.comments.v3WriteSurfaces.map((t) => `'${t}'`).join(', ')})`
    : 'false';

/** A Prisma transaction (or client) as a `SqlRunner`. */
export const prismaRunner = (db: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>): SqlRunner => ({
  query: async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) => ({
    rows: await db.$queryRawUnsafe<R[]>(sql, ...params),
  }),
});

export type StoredCommentV3 = {
  id: number;
  entityType: string;
  entityId: number;
  parentId: number | null;
  replyToId: number | null;
  userId: number;
  content: string;
  hidden: boolean;
  tosViolation: boolean;
  locked: boolean;
  pinnedAt: Date | null;
  deletedAt: Date | null;
  depth: number;
  path: string;
  createdAt: Date;
  updatedAt: Date;
};

const COLUMNS = `id, "entityType"::text AS "entityType", "entityId", "parentId", "replyToId", "userId",
  content, hidden, "tosViolation", locked, "pinnedAt", "deletedAt", depth, path::text AS path,
  "createdAt", "updatedAt"`;

const first = async <R extends Record<string, unknown>>(
  db: SqlRunner,
  sql: string,
  params: unknown[]
): Promise<R | undefined> => (await db.query<R>(sql, params)).rows[0];

/** The stored row, tombstones included. `lock` takes that row lock for the rest of the transaction. */
export function getStoredComment(db: SqlRunner, id: number, lock?: 'FOR KEY SHARE' | 'FOR UPDATE') {
  return first<StoredCommentV3>(
    db,
    `SELECT ${COLUMNS} FROM "CommentV3" WHERE id = $1 ${lock ?? ''}`,
    [id]
  );
}

/** The live row when its surface writes CommentV3 directly; otherwise undefined. */
export async function getV3WriteComment(db: SqlRunner, id: number) {
  const row = await getStoredComment(db, id);
  return row && !row.deletedAt && isV3WriteSurface(row.entityType) ? row : undefined;
}

/**
 * Whether a write under `path` (or at the top of the section, with no path) is refused: the topic
 * is locked, or the comment or one of its ancestors is. Every reply checks its whole chain, which
 * the old thread-by-thread lock missed below the first reply level.
 */
export async function isCommentWriteLocked(
  db: SqlRunner,
  { entityType, entityId, path }: { entityType: string; entityId: number; path?: string | null }
) {
  const row = await first<{ locked: boolean }>(
    db,
    `SELECT COALESCE((SELECT t.locked FROM "CommentTopic" t
                       WHERE t."entityType" = $1::"CommentEntityType" AND t."entityId" = $2), false)
        OR ($3::ltree IS NOT NULL AND EXISTS (
              SELECT 1 FROM "CommentV3" a WHERE a.path @> $3::ltree AND a.locked)) AS locked`,
    [entityType, entityId, path ?? null]
  );
  return !!row?.locked;
}

const isForeignKeyViolation = (error: unknown) => {
  const e = error as { code?: string; meta?: { code?: string }; message?: string };
  return e?.code === '23503' || e?.meta?.code === '23503' || /\b23503\b/.test(e?.message ?? '');
};

/** Deepest stored depth (`commentv3_depth_cap`); a reply below it answers through `replyToId`. */
const MAX_STORED_DEPTH = 20;

/**
 * Inserts a comment, creating the section's topic on its first comment. Run it in a transaction:
 * the parent is held `FOR KEY SHARE` until commit, so a concurrent delete of it tombstones it
 * rather than removing it from under this reply. A reply past the depth cap attaches to the
 * ancestor at the cap and keeps the comment it answers in `replyToId`, as the mirror does.
 */
export async function insertComment(
  db: SqlRunner,
  {
    userId,
    entityType,
    entityId,
    parentId,
    content,
  }: {
    userId: number;
    entityType: string;
    entityId: number;
    parentId?: number | null;
    content: string;
  }
) {
  let parent: StoredCommentV3 | undefined;
  if (parentId) {
    parent = await getStoredComment(db, parentId, 'FOR KEY SHARE');
    if (
      !parent ||
      parent.deletedAt ||
      parent.entityType !== entityType ||
      parent.entityId !== entityId
    )
      throw throwNotFoundError('The comment you are replying to no longer exists.');
  }

  try {
    await db.query(
      `INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ($1::"CommentEntityType", $2)
       ON CONFLICT ("entityId", "entityType") DO NOTHING`,
      [entityType, entityId]
    );
  } catch (error) {
    if (isForeignKeyViolation(error))
      throw throwNotFoundError(`Cannot comment: this ${entityType} no longer exists.`);
    throw error;
  }

  if (await isCommentWriteLocked(db, { entityType, entityId, path: parent?.path }))
    throw throwBadRequestError('comment thread locked');

  let attachTo = parent?.id ?? null;
  let replyToId: number | null = null;
  if (parent && parent.depth >= MAX_STORED_DEPTH) {
    attachTo = Number(parent.path.split('.')[MAX_STORED_DEPTH - 1]);
    replyToId = parent.id;
  }

  const created = await first<StoredCommentV3>(
    db,
    `INSERT INTO "CommentV3" ("entityType", "entityId", "parentId", "replyToId", "userId", content)
     VALUES ($1::"CommentEntityType", $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [entityType, entityId, attachTo, replyToId, userId, content]
  );
  if (!created) throw new Error('CommentV3 insert returned no row');
  return created;
}

/**
 * The CommentV2 twins of a write, for the comments that have one. Left stale, the old reads would
 * serve what was deleted or removed, and an update to the row would make the mirror copy a deleted
 * comment back.
 */
const syncOldRows = {
  update: (db: SqlRunner, ids: number[], set: string, params: unknown[] = []) =>
    db.query(
      `UPDATE "CommentV2" SET ${set}, "updatedAt" = now()
       WHERE id = ANY(string_to_array($1, ',')::int[])`,
      [ids.join(','), ...params]
    ),
  delete: (db: SqlRunner, ids: number[]) =>
    db.query(`DELETE FROM "CommentV2" WHERE id = ANY(string_to_array($1, ',')::int[])`, [
      ids.join(','),
    ]),
};

/** A content edit on a live comment; undefined when it is gone or deleted. */
export async function updateCommentContent(
  db: SqlRunner,
  { id, content }: { id: number; content: string }
) {
  // CommentV3 first, as every write here locks it, so an edit and a delete cannot deadlock.
  const row = await first<StoredCommentV3>(
    db,
    `UPDATE "CommentV3" SET content = $2, "updatedAt" = now()
     WHERE id = $1 AND "deletedAt" IS NULL
     RETURNING ${COLUMNS}`,
    [id, content]
  );
  if (row) await syncOldRows.update(db, [id], 'content = $2', [content]);
  return row;
}

export type RemovedCommentV3 = { id: number; userId: number; entityType: string; entityId: number };

/**
 * Deletes comments under D6: a comment with replies, or one a clamped reply answers, becomes a
 * tombstone (content blanked, author kept, `deletedAt` set); any other comment is removed, and a
 * tombstone that just lost its last reply or answerer is removed with it, up both edges.
 *
 * `removed` are the live comments the call took away, whichever way; a tombstone collapsing later
 * is not one, since it was counted when it was deleted. The rows are locked `FOR UPDATE` first, which
 * waits out a reply being written under one (it holds the parent `FOR KEY SHARE`), so a reply that
 * commits first makes it a tombstone and one that commits after finds the parent gone.
 */
export async function deleteComments(db: SqlRunner, ids: number[]) {
  if (!ids.length) return [];
  const list = (xs: number[]) => xs.join(',');
  const IDS = `string_to_array($1, ',')::int[]`;
  const removed: RemovedCommentV3[] = [];
  const live = (rows: (RemovedCommentV3 & { deletedAt: Date | null })[]) =>
    rows
      .filter((r) => !r.deletedAt)
      .map(({ id, userId, entityType, entityId }) => ({ id, userId, entityType, entityId }));

  const locked = await db.query<{ id: number }>(
    `SELECT id FROM "CommentV3" WHERE id = ANY(${IDS}) ORDER BY id FOR UPDATE`,
    [list([...new Set(ids)])]
  );
  let pending = locked.rows.map((r) => r.id);
  const requested = new Set(pending);

  while (pending.length) {
    const { rows } = await db.query<
      RemovedCommentV3 & {
        deletedAt: Date | null;
        parentId: number | null;
        replyToId: number | null;
      }
    >(
      `DELETE FROM "CommentV3" c
       WHERE c.id = ANY(${IDS})
         AND NOT EXISTS (SELECT 1 FROM "CommentV3" k WHERE k."parentId" = c.id OR k."replyToId" = c.id)
       RETURNING c.id, c."userId", c."entityType"::text AS "entityType", c."entityId", c."deletedAt",
                 c."parentId", c."replyToId"`,
      [list(pending)]
    );
    if (!rows.length) break;
    removed.push(...live(rows));
    const gone = new Set(rows.map((r) => r.id));
    const above = rows.flatMap((r) => [r.parentId, r.replyToId]).filter((x): x is number => !!x);
    const tombstones = above.length
      ? await db.query<{ id: number }>(
          `SELECT id FROM "CommentV3" WHERE id = ANY(${IDS}) AND "deletedAt" IS NOT NULL`,
          [list([...new Set(above)])]
        )
      : { rows: [] };
    pending = [
      ...new Set([...pending.filter((id) => !gone.has(id)), ...tombstones.rows.map((r) => r.id)]),
    ];
  }

  const kept = pending.filter((id) => requested.has(id));
  if (kept.length) {
    const { rows } = await db.query<RemovedCommentV3 & { deletedAt: Date | null }>(
      `UPDATE "CommentV3" SET "deletedAt" = now(), content = '', "updatedAt" = now()
       WHERE id = ANY(${IDS}) AND "deletedAt" IS NULL
       RETURNING id, "userId", "entityType"::text AS "entityType", "entityId", NULL::timestamptz AS "deletedAt"`,
      [list(kept)]
    );
    removed.push(...live(rows));
    // As a hard delete's cascade does, so its reports leave the queue instead of linking to nothing.
    if (rows.length)
      await db.query(`DELETE FROM "CommentV3Report" WHERE "commentId" = ANY(${IDS})`, [
        list(rows.map((r) => r.id)),
      ]);
  }
  if (removed.length)
    await syncOldRows.delete(
      db,
      removed.map((r) => r.id)
    );
  return removed;
}

type Flags = { hidden?: boolean; tosViolation?: boolean; pinned?: boolean };

/**
 * Sets moderation flags on live comments; returns the rows it changed. Run it in a transaction: the
 * row lock must cover the CommentV2 sync, or a racing toggle's sync is mirrored back over it.
 */
export async function setCommentFlags(db: SqlRunner, ids: number[], flags: Flags) {
  const sets: string[] = [];
  const params: unknown[] = [ids.join(',')];
  const changed: string[] = [];
  const add = (column: string, value: unknown, set: string) => {
    params.push(value);
    sets.push(`${column} = ${set.replace('$', `$${params.length}`)}`);
    changed.push(`${column} IS DISTINCT FROM ${set.replace('$', `$${params.length}`)}`);
  };
  if (flags.hidden !== undefined) add('hidden', flags.hidden, '$::boolean');
  if (flags.tosViolation !== undefined) add('"tosViolation"', flags.tosViolation, '$::boolean');
  if (flags.pinned !== undefined)
    add('"pinnedAt"', flags.pinned, 'CASE WHEN $::boolean THEN COALESCE("pinnedAt", now()) END');
  if (!sets.length || !ids.length) return [];
  const { rows } = await db.query<{ id: number; userId: number }>(
    `UPDATE "CommentV3" SET ${sets.join(', ')}, "updatedAt" = now()
     WHERE id = ANY(string_to_array($1, ',')::int[]) AND "deletedAt" IS NULL AND (${changed.join(
       ' OR '
     )})
     RETURNING id, "userId"`,
    params
  );
  // After the CommentV3 update, which decides what changed; the same expressions read CommentV2's own
  // columns, under the same parameter numbers.
  if (rows.length)
    await syncOldRows.update(
      db,
      rows.map((r) => r.id),
      sets.join(', '),
      params.slice(1)
    );
  return rows;
}

/** Flips a section's lock, creating its topic (locked) when it has none yet. Returns the new state. */
export async function toggleTopicLock(
  db: SqlRunner,
  { entityType, entityId }: { entityType: string; entityId: number }
) {
  try {
    const row = await first<{ locked: boolean }>(
      db,
      `INSERT INTO "CommentTopic" ("entityType", "entityId", locked) VALUES ($1::"CommentEntityType", $2, true)
       ON CONFLICT ("entityId", "entityType") DO UPDATE SET locked = NOT "CommentTopic".locked
       RETURNING locked`,
      [entityType, entityId]
    );
    return { locked: !!row?.locked };
  } catch (error) {
    if (isForeignKeyViolation(error)) throw throwNotFoundError(`No ${entityType} ${entityId}`);
    throw error;
  }
}

/** Mutes or unmutes reply notifications below a comment. Returns the new state. */
export async function toggleCommentMute(
  db: SqlRunner,
  { userId, commentId }: { userId: number; commentId: number }
) {
  const { rows } = await db.query(
    `DELETE FROM "CommentMute" WHERE "userId" = $1 AND "commentId" = $2 RETURNING 1 AS x`,
    [userId, commentId]
  );
  if (rows.length) return { muted: false };
  await db.query(
    `INSERT INTO "CommentMute" ("userId", "commentId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, commentId]
  );
  return { muted: true };
}

/** Mutes or unmutes a whole section. Needs no topic: a section with no comments can be muted too. */
export async function toggleTopicMute(
  db: SqlRunner,
  { userId, entityType, entityId }: { userId: number; entityType: string; entityId: number }
) {
  const { rows } = await db.query(
    `DELETE FROM "CommentTopicMute"
     WHERE "userId" = $1 AND "entityType" = $2::"CommentEntityType" AND "entityId" = $3 RETURNING 1 AS x`,
    [userId, entityType, entityId]
  );
  if (rows.length) return { muted: false };
  await db.query(
    `INSERT INTO "CommentTopicMute" ("userId", "entityType", "entityId")
     VALUES ($1, $2::"CommentEntityType", $3) ON CONFLICT DO NOTHING`,
    [userId, entityType, entityId]
  );
  return { muted: true };
}

/**
 * Whether a write aimed at `{ entityType, entityId }` belongs on a surface that writes CommentV3: a
 * reply or edit addressed as `comment` is on the stored comment's surface. The old `commentv2`
 * writes refuse these, so a stale page cannot skip the CommentV3 lock and parent checks.
 */
export async function isV3WriteTarget(
  db: SqlRunner,
  { entityType, entityId }: { entityType: string; entityId: number }
) {
  if (entityType !== 'comment') return isV3WriteSurface(entityType);
  const row = await first<{ entityType: string }>(
    db,
    `SELECT "entityType"::text AS "entityType" FROM "CommentV3" WHERE id = $1`,
    [entityId]
  );
  return !!row && isV3WriteSurface(row.entityType);
}

export const V3_WRITE_TARGET_MESSAGE =
  'These comments have been updated. Reload the page and try again.';
