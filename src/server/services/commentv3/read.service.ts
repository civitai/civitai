import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';
import { constants } from '~/server/common/constants';
import { ThreadSort } from '~/server/common/enums';
import type { kyselyV3Read } from '~/server/db/kyselyDb';
import { emptyReactionCounts } from '~/shared/utils/comment-reactions';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

/**
 * Comment reads on CommentV3 for the v3 comment suite (`docs/plans/comments-v3-article-flip.md`).
 * Every read returns comments in one flat shape with what the page needs to render them without
 * asking again: per-type reaction counts and the viewer's own reactions (never the reactor list),
 * and the comment's reply count.
 *
 * A comment is shown only through a shown parent, so whatever sits under a ToS removal or an
 * excluded author is left out with it. A deleted comment that still has live replies stays as a
 * placeholder (`deleted`, with no content or author) so its replies stay reachable.
 */

export type CommentV3Db = typeof kyselyV3Read;

export type CommentV3Viewer = {
  userId?: number;
  isModerator: boolean;
  /** Hidden, blocked and blocked-by users, already bounded (`boundExcludedUserIds`). */
  excludedUserIds: number[];
};

export type CommentV3Author = {
  id: number;
  username: string | null;
  deletedAt: Date | null;
  image: string | null;
};

export type CommentV3Item = {
  id: number;
  /** A placeholder for a deleted comment that still holds live replies. */
  deleted: boolean;
  parentId: number | null;
  /** The comment answered, when the depth cap made it a sibling of the reply it answers. */
  replyToId: number | null;
  depth: number;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  pinnedAt: Date | null;
  hidden: boolean;
  tosViolation: boolean;
  reactionCount: number;
  /** Null on a deleted comment. */
  user: CommentV3Author | null;
  reactions: Record<ReviewReactions, number>;
  /** This viewer's reactions; empty when signed out. */
  myReactions: ReviewReactions[];
  replyCount: number;
};

/** A parent's opened replies: their ids in order, and where the next page starts, if any. */
export type CommentV3Children = { ids: number[]; nextCursor: string | null };

export type CommentV3Page = {
  comments: CommentV3Item[];
  /** Top-level comment ids in render order, pinned first. */
  rootIds: number[];
  children: Record<number, CommentV3Children>;
  nextCursor: string | null;
};

type Row = {
  id: number;
  parentId: number | null;
  replyToId: number | null;
  depth: number;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  pinnedAt: Date | null;
  hidden: boolean;
  tosViolation: boolean;
  reactionCount: number;
  deletedAt: Date | null;
  userId: number;
  username: string | null;
  userDeletedAt: Date | null;
  userImage: string | null;
};

// Arrays travel as one comma-joined string: pg and PGlite send array parameters differently.
const intArray = (ids: number[]) => sql`string_to_array(${ids.join(',')}, ',')::int[]`;

const COLUMNS = sql`c.id, c."parentId", c."replyToId", c.depth, c.content, c."createdAt", c."updatedAt",
  c."pinnedAt", c.hidden, c."tosViolation", c."reactionCount", c."deletedAt", c."userId",
  u.username, u."deletedAt" AS "userDeletedAt", u.image AS "userImage"`;

/** Whether a row's ToS state and author let this viewer see it. `alias` names the CommentV3 row. */
const allowedTo = (v: CommentV3Viewer, alias: string) => {
  const col = (name: string) => sql.raw(`${alias}."${name}"`);
  // Parenthesised: it is negated.
  return sql`(true
    ${v.isModerator ? sql`` : sql`AND NOT ${col('tosViolation')}`}
    ${
      v.excludedUserIds.length
        ? sql`AND ${col('userId')} <> ALL(${intArray(v.excludedUserIds)})`
        : sql``
    })`;
};

/** A live comment this viewer may see on its own merits. */
const liveTo = (v: CommentV3Viewer, alias: string) =>
  sql`${sql.raw(`${alias}."deletedAt"`)} IS NULL AND ${allowedTo(v, alias)}`;

/**
 * What this viewer may see of a row before its parent chain is considered: a live comment allowed
 * on its own merits, or a deleted one that still has a live descendant reachable through comments
 * the viewer may see. Deleting a ToS removal or an excluded author's comment therefore never opens
 * what it was hiding.
 */
const visibleTo = (v: CommentV3Viewer, alias = 'c') => {
  const col = (name: string) => sql.raw(`${alias}."${name}"`);
  return sql`(${allowedTo(v, alias)} AND (${col('deletedAt')} IS NULL OR EXISTS (
    SELECT 1 FROM "CommentV3" d
     WHERE d."rootId" = ${col('rootId')} AND d.depth > ${col('depth')} AND d.path <@ ${col('path')}
       AND ${liveTo(v, 'd')}
       AND NOT EXISTS (
         SELECT 1 FROM "CommentV3" m
          WHERE m."rootId" = ${col('rootId')} AND m.depth > ${col('depth')} AND m.depth < d.depth
            AND m.path @> d.path AND NOT ${allowedTo(v, 'm')}))))`;
};

type SortKey = { id: number; createdAt: Date; reactionCount: number };
type SortSpec = {
  order: RawBuilder<unknown>;
  /** The keyset condition for rows after the cursor. */
  after: (cursor: string) => RawBuilder<unknown>;
  cursorOf: (row: SortKey) => string;
};

/**
 * Pinned rows lead a first page and never appear on a later one, so a cursor is always taken from
 * the last unpinned row; a page that held only pinned rows continues from the start of the rest.
 */
const FROM_START = 'start';
const cursorAfter = (sort: SortSpec, rows: (SortKey & { pinnedAt: Date | null })[]) => {
  const last = [...rows].reverse().find((r) => r.pinnedAt === null);
  return last ? sort.cursorOf(last) : FROM_START;
};
const afterCursor = (sort: SortSpec, cursor: string) =>
  cursor === FROM_START ? sql`true` : sort.after(cursor);

const toDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('bad cursor');
  return date;
};
const splitCursor = (cursor: string) => {
  const at = cursor.lastIndexOf('_');
  const id = Number(cursor.slice(at + 1));
  if (at < 1 || !Number.isInteger(id)) throw new Error('bad cursor');
  return { key: cursor.slice(0, at), id };
};

/** Newest and Oldest order on (createdAt, id): ids are identities, not creation order. */
const SORTS: Record<ThreadSort, SortSpec> = {
  [ThreadSort.Oldest]: {
    order: sql`c."createdAt" ASC, c.id ASC`,
    after: (cursor) => {
      const { key, id } = splitCursor(cursor);
      return sql`(c."createdAt", c.id) > (${toDate(key)}::timestamptz, ${id}::int)`;
    },
    cursorOf: (r) => `${r.createdAt.toISOString()}_${r.id}`,
  },
  [ThreadSort.Newest]: {
    order: sql`c."createdAt" DESC, c.id DESC`,
    after: (cursor) => {
      const { key, id } = splitCursor(cursor);
      return sql`(c."createdAt", c.id) < (${toDate(key)}::timestamptz, ${id}::int)`;
    },
    cursorOf: (r) => `${r.createdAt.toISOString()}_${r.id}`,
  },
  [ThreadSort.MostReactions]: {
    order: sql`c."reactionCount" DESC, c.id DESC`,
    after: (cursor) => {
      const { key, id } = splitCursor(cursor);
      const count = Number(key);
      if (!Number.isInteger(count)) throw new Error('bad cursor');
      return sql`(c."reactionCount", c.id) < (${count}::int, ${id}::int)`;
    },
    cursorOf: (r) => `${r.reactionCount}_${r.id}`,
  },
};

/** Reply counts, reaction counts and the viewer's reactions for every row, in three grouped reads. */
async function decorate(
  db: CommentV3Db,
  rows: Row[],
  viewer: CommentV3Viewer
): Promise<CommentV3Item[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [replyCounts, reactionCounts, mine] = await Promise.all([
    sql<{ parentId: number; n: number }>`
      SELECT c."parentId", count(*)::int AS n FROM "CommentV3" c
       WHERE c."parentId" = ANY(${intArray(ids)}) AND ${visibleTo(viewer)}
       GROUP BY c."parentId"`.execute(db),
    sql<{ commentId: number; reaction: ReviewReactions; n: number }>`
      SELECT x."commentId", x.reaction, count(*)::int AS n FROM "CommentV3Reaction" x
       WHERE x."commentId" = ANY(${intArray(ids)}) GROUP BY 1, 2`.execute(db),
    viewer.userId
      ? sql<{ commentId: number; reaction: ReviewReactions }>`
          SELECT x."commentId", x.reaction FROM "CommentV3Reaction" x
           WHERE x."commentId" = ANY(${intArray(ids)}) AND x."userId" = ${viewer.userId}`.execute(
          db
        )
      : Promise.resolve({ rows: [] as { commentId: number; reaction: ReviewReactions }[] }),
  ]);
  const replies = new Map(replyCounts.rows.map((r) => [r.parentId, r.n]));
  const reactions = new Map<number, Record<ReviewReactions, number>>();
  for (const r of reactionCounts.rows) {
    const counts = reactions.get(r.commentId) ?? emptyReactionCounts();
    counts[r.reaction] = r.n;
    reactions.set(r.commentId, counts);
  }
  const myReactions = new Map<number, ReviewReactions[]>();
  for (const r of mine.rows)
    myReactions.set(r.commentId, [...(myReactions.get(r.commentId) ?? []), r.reaction]);

  return rows.map((r) => ({
    id: r.id,
    deleted: r.deletedAt !== null,
    parentId: r.parentId,
    replyToId: r.replyToId,
    depth: r.depth,
    content: r.deletedAt === null ? r.content : '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    pinnedAt: r.pinnedAt,
    hidden: r.deletedAt === null && r.hidden,
    tosViolation: r.deletedAt === null && r.tosViolation,
    reactionCount: r.reactionCount,
    user:
      r.deletedAt === null
        ? { id: r.userId, username: r.username, deletedAt: r.userDeletedAt, image: r.userImage }
        : null,
    reactions: (r.deletedAt === null && reactions.get(r.id)) || emptyReactionCounts(),
    myReactions: (r.deletedAt === null && myReactions.get(r.id)) || [],
    replyCount: replies.get(r.id) ?? 0,
  }));
}

export type SectionOptions = {
  sort: ThreadSort;
  cursor?: string;
  /** Rendered comments a page may hold, replies included. */
  budget?: number;
  /** Most replies opened under one top-level comment. */
  repliesPerRoot?: number;
  /** Most replies opened per parent; the rest stay behind "show more". */
  repliesPerParent?: number;
  /** Reply levels opened up front. 0 opens none. */
  replyDepth: number;
};

const MAX_PINNED = 20;

/**
 * One page of an entity's comments. Top-level comments are taken in sort order, each costing one
 * plus the replies opened under it (shallowest first, at most `repliesPerParent` per parent and
 * `repliesPerRoot` in all); the page stops before the comment that would pass `budget`, and always
 * holds at least one. Pinned comments lead the first page and count toward the budget.
 */
export async function getCommentSection(
  db: CommentV3Db,
  entity: { entityType: string; entityId: number },
  viewer: CommentV3Viewer,
  options: SectionOptions
): Promise<CommentV3Page> {
  const sort = SORTS[options.sort];
  const budget = options.budget ?? constants.comments.v3PageBudget;
  const perRoot = options.repliesPerRoot ?? constants.comments.v3RepliesPerRoot;
  const perParent = options.repliesPerParent ?? constants.comments.replyPageSize;
  const topLevel = sql`c."entityType" = ${
    entity.entityType
  }::"CommentEntityType" AND c."entityId" = ${entity.entityId}
    AND c."parentId" IS NULL AND ${visibleTo(viewer)}`;

  // One more than any page can hold, so a full page knows whether another follows.
  const [pinned, candidates] = await Promise.all([
    options.cursor
      ? ([] as Row[])
      : sql<Row>`SELECT ${COLUMNS} FROM "CommentV3" c JOIN "User" u ON u.id = c."userId"
           WHERE ${topLevel} AND c."pinnedAt" IS NOT NULL
           ORDER BY c."pinnedAt" DESC, c.id DESC LIMIT ${MAX_PINNED}`
          .execute(db)
          .then((r) => r.rows),
    sql<Row>`SELECT ${COLUMNS} FROM "CommentV3" c JOIN "User" u ON u.id = c."userId"
       WHERE ${topLevel} AND c."pinnedAt" IS NULL
         ${options.cursor ? sql`AND ${afterCursor(sort, options.cursor)}` : sql``}
       ORDER BY ${sort.order} LIMIT ${budget + 1}`
      .execute(db)
      .then((r) => r.rows),
  ]);
  const roots = [...pinned, ...candidates];
  const replies = await openReplies(
    db,
    roots.map((r) => r.id),
    viewer,
    {
      sort,
      replyDepth: options.replyDepth,
      perParent,
    }
  );

  const taken: Row[] = [];
  const opened: Row[] = [];
  let spent = 0;
  let nextCursor: string | null = null;
  for (const root of roots) {
    const tree = pickTree(root.id, replies, perRoot);
    const cost = 1 + tree.length;
    const isPinned = root.pinnedAt !== null;
    if (!isPinned && taken.some((t) => t.pinnedAt === null) && spent + cost > budget) {
      nextCursor = sort.cursorOf(taken[taken.length - 1]);
      break;
    }
    spent += cost;
    taken.push(root);
    opened.push(...tree);
  }
  // Every candidate fit: there is another page only if the query found one more than the budget.
  if (nextCursor === null && candidates.length > budget) {
    const lastRegular = [...taken].reverse().find((t) => t.pinnedAt === null);
    if (lastRegular) nextCursor = sort.cursorOf(lastRegular);
  }

  const items = await decorate(db, [...taken, ...opened], viewer);
  return {
    comments: items,
    rootIds: taken.map((r) => r.id),
    children: childrenOf(items, sort),
    nextCursor,
  };
}

/** Replies under these top-level comments, at most `perParent` per parent, down to `replyDepth`. */
async function openReplies(
  db: CommentV3Db,
  rootIds: number[],
  viewer: CommentV3Viewer,
  { sort, replyDepth, perParent }: { sort: SortSpec; replyDepth: number; perParent: number }
) {
  if (!rootIds.length || replyDepth < 1) return [] as Row[];
  return (
    await sql<Row>`SELECT * FROM (
        SELECT ${COLUMNS}, c."rootId",
               row_number() OVER (PARTITION BY c."parentId" ORDER BY c."pinnedAt" DESC NULLS LAST, ${
                 sort.order
               }) AS rn
          FROM "CommentV3" c JOIN "User" u ON u.id = c."userId"
         WHERE c."rootId" = ANY(${intArray(rootIds)}) AND c.depth BETWEEN 1 AND ${replyDepth}
           AND ${visibleTo(viewer)}
      ) r WHERE r.rn <= ${perParent}
      ORDER BY r.depth, r."parentId", r.rn`.execute(db)
  ).rows as (Row & { rootId: number })[];
}

/** The replies opened under one top-level comment: shallowest first, each under a shown parent. */
function pickTree(rootId: number, rows: Row[], cap: number) {
  const shown = new Set([rootId]);
  const picked: Row[] = [];
  for (const row of rows as (Row & { rootId: number })[]) {
    if (picked.length >= cap) break;
    if (row.rootId !== rootId || row.parentId === null || !shown.has(row.parentId)) continue;
    shown.add(row.id);
    picked.push(row);
  }
  return picked;
}

/** Each opened parent's children in order, with a cursor when more remain than were opened. */
function childrenOf(items: CommentV3Item[], sort: SortSpec): Record<number, CommentV3Children> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const children: Record<number, CommentV3Children> = {};
  for (const item of items) {
    if (item.parentId === null || !byId.has(item.parentId)) continue;
    (children[item.parentId] ??= { ids: [], nextCursor: null }).ids.push(item.id);
  }
  for (const [parentId, entry] of Object.entries(children)) {
    const parent = byId.get(Number(parentId))!;
    if (parent.replyCount > entry.ids.length)
      entry.nextCursor = cursorAfter(
        sort,
        entry.ids.map((id) => byId.get(id)!)
      );
  }
  return children;
}

/** The comment's entity, if the comment exists. Whether a viewer may see it is `isShown`. */
export async function getCommentEntity(db: CommentV3Db, commentId: number) {
  const { rows } = await sql<{ entityType: string; entityId: number; path: string }>`
    SELECT c."entityType", c."entityId", c.path::text AS path FROM "CommentV3" c
     WHERE c.id = ${commentId}`.execute(db);
  return rows[0] ?? null;
}

/** Whether the comment and every comment above it are visible to this viewer. */
async function isShown(db: CommentV3Db, commentId: number, viewer: CommentV3Viewer) {
  const { rows } = await sql<{ shown: boolean }>`
    SELECT NOT EXISTS (
      SELECT 1 FROM "CommentV3" c
        JOIN "CommentV3" a ON a."rootId" = c."rootId" AND a.path @> c.path
       WHERE c.id = ${commentId} AND NOT ${visibleTo(viewer, 'a')}) AS shown`.execute(db);
  return !!rows[0]?.shown;
}

/** The next page of one comment's direct replies; none when the comment itself is not shown. */
export async function getCommentReplies(
  db: CommentV3Db,
  parentId: number,
  viewer: CommentV3Viewer,
  options: { sort: ThreadSort; cursor?: string; limit?: number }
): Promise<CommentV3Page> {
  const empty = { comments: [], rootIds: [], children: {}, nextCursor: null };
  if (!(await isShown(db, parentId, viewer))) return empty;
  const sort = SORTS[options.sort];
  const limit = options.limit ?? constants.comments.v3ReplyPageSize;
  const rows = (
    await sql<Row>`SELECT ${COLUMNS} FROM "CommentV3" c JOIN "User" u ON u.id = c."userId"
       WHERE c."parentId" = ${parentId} AND ${visibleTo(viewer)}
         ${
           options.cursor
             ? sql`AND c."pinnedAt" IS NULL AND ${afterCursor(sort, options.cursor)}`
             : sql``
         }
       ORDER BY c."pinnedAt" DESC NULLS LAST, ${sort.order} LIMIT ${limit + 1}`.execute(db)
  ).rows;
  const page = rows.slice(0, limit);
  const items = await decorate(db, page, viewer);
  return {
    comments: items,
    rootIds: [],
    children: {
      [parentId]: {
        ids: items.map((i) => i.id),
        nextCursor: rows.length > limit ? cursorAfter(sort, page) : null,
      },
    },
    nextCursor: null,
  };
}

/**
 * A focused view for deep links and drilling in: the comment, the ids above it (root first), and
 * the first page of its replies. Null when the comment is gone, it or a comment above it is not
 * visible to this viewer, or it is on another entity than `options.entity` (the page asking): a
 * link must not show one entity's comment on another's page.
 */
export async function getCommentThread(
  db: CommentV3Db,
  commentId: number,
  viewer: CommentV3Viewer,
  options: { sort: ThreadSort; entity: { entityType: string; entityId: number } }
) {
  const entity = await getCommentEntity(db, commentId);
  if (
    !entity ||
    entity.entityType !== options.entity.entityType ||
    entity.entityId !== options.entity.entityId
  )
    return null;
  if (!(await isShown(db, commentId, viewer))) return null;
  const { rows } =
    await sql<Row>`SELECT ${COLUMNS} FROM "CommentV3" c JOIN "User" u ON u.id = c."userId"
     WHERE c.id = ${commentId}`.execute(db);
  if (!rows.length) return null;
  const [comment] = await decorate(db, rows, viewer);
  const replies = await getCommentReplies(db, commentId, viewer, { sort: options.sort });
  return {
    entityType: entity.entityType,
    entityId: entity.entityId,
    ancestorIds: entity.path.split('.').slice(0, -1).map(Number),
    comment,
    replies,
  };
}

/** The topic's lock, and whether a comment or one of its ancestors is locked. */
export async function getCommentLock(
  db: CommentV3Db,
  entity: { entityType: string; entityId: number },
  commentId?: number
) {
  const { rows } = await sql<{ topic: boolean | null; comment: boolean }>`
    SELECT (SELECT ct.locked FROM "CommentTopic" ct
             WHERE ct."entityType" = ${
               entity.entityType
             }::"CommentEntityType" AND ct."entityId" = ${entity.entityId}) AS topic,
           ${
             commentId
               ? sql`EXISTS (SELECT 1 FROM "CommentV3" c
                             JOIN "CommentV3" lk ON lk."rootId" = c."rootId" AND lk.path @> c.path
                              WHERE c.id = ${commentId} AND lk.locked)`
               : sql`false`
           } AS comment`.execute(db);
  return { locked: !!rows[0]?.topic || !!rows[0]?.comment };
}
