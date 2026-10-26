import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonArrayFrom } from './infra/helpers';

// Kysely ports of the model page's comment reads (`comment.getAll` and
// `comment.getVisibleCountByModel`, <civitai>/src/server/services/comment.service.ts), served behind
// the default-off server Flipt flag `kysely-hot-reads-4`; off, the Prisma reads run unchanged. The
// app-side wrappers (<civitai>/src/server/services/hot-reads-4.reads.ts) map these rows to the exact
// Prisma payload, and <civitai>/src/server/services/__tests__/hot-reads-4.kysely-parity.test.ts
// compares the two against a real database.
//
//   - `countTopLevelComments`: the visible top-level comment count.
//   - `countTopLevelCommentsByHidden`: the plain and the hidden view's counts in one statement
//     (`comment.getVisibleCountsByModel`).
//   - `listTopLevelComments`: a page of top-level comments (unpinned, newest or oldest first) or the
//     pinned block (`pinnedAt desc`), each with its author, its reactions and the model name, as ONE
//     statement where Prisma issues one query per relation.
//
// Both apply the same `TopLevelCommentsFilter` the Prisma where is built from, so the viewer's
// exclusions (hidden and blocked users), the moderator's view of ToS violations and the hidden view
// cannot drift between the two paths.
//
// Every statement reads base TABLES only ("Comment", "User", "Model", "CommentReaction"), never a
// view: the parity suite fails if one of them names a relation declared `/// @view`.
//
// Nested reactions are read with `jsonArrayFrom`: every column in them (integers, text, the enum)
// survives JSON unchanged. Timestamps are top-level columns. The reactions are unordered, as Prisma
// left them (its nested relation read has no `orderBy`).

/**
 * Which top-level comments of one model a viewer may see. Built once per viewer by the comment
 * service; the Prisma where (`topLevelCommentsWhere` in hot-reads-4.reads.ts) and the Kysely
 * conditions below are both pure functions of it.
 */
export type TopLevelCommentsFilter = {
  /**
   * The model. Optional in `comment.getAll`'s input, and the Prisma where then applies no model
   * filter at all (an `undefined` Prisma condition is no condition), so neither does this.
   */
  modelId?: number;
  /** Only this author's comments. When set, `excludedUserIds` is not applied. */
  userId?: number;
  /** Authors never shown (hidden, blocked, blocked-by), already capped and de-duplicated. */
  excludedUserIds: number[];
  /** `tosViolation = false`; off for a moderator, who sees violations too. */
  excludeTosViolations: boolean;
  /** `hidden = $hidden`. The column is nullable and a NULL matches neither value, as in Prisma. */
  hidden: boolean;
};

/** A filter with no `hidden` condition, for the statement that counts both views at once. */
export type TopLevelCommentsBaseFilter = Omit<TopLevelCommentsFilter, 'hidden'>;

/** `unpinned`: `pinnedAt IS NULL`; `pinned`: `IS NOT NULL`; `any`: both. */
export type PinnedScope = 'unpinned' | 'pinned' | 'any';

function topLevelCommentConditions(
  eb: ExpressionBuilder<DB, 'Comment'>,
  filter: TopLevelCommentsBaseFilter & { hidden?: boolean },
  pinned: PinnedScope
): Expression<SqlBool> {
  const conditions: Expression<SqlBool>[] = [];
  if (filter.modelId !== undefined) conditions.push(eb('Comment.modelId', '=', filter.modelId));
  if (filter.userId) conditions.push(eb('Comment.userId', '=', filter.userId));
  else if (filter.excludedUserIds.length)
    conditions.push(eb('Comment.userId', 'not in', filter.excludedUserIds));
  conditions.push(eb('Comment.parentId', 'is', null));
  if (filter.excludeTosViolations) conditions.push(eb('Comment.tosViolation', '=', false));
  if (filter.hidden !== undefined) conditions.push(eb('Comment.hidden', '=', filter.hidden));
  if (pinned === 'unpinned') conditions.push(eb('Comment.pinnedAt', 'is', null));
  if (pinned === 'pinned') conditions.push(eb('Comment.pinnedAt', 'is not', null));
  return eb.and(conditions);
}

/** How many top-level comments match, as a JS number. */
export async function countTopLevelComments(
  db: Kysely<DB>,
  filter: TopLevelCommentsFilter,
  pinned: PinnedScope
) {
  const row = await db
    .selectFrom('Comment')
    .select(sql<number>`count(*)::int`.as('count'))
    .where((eb) => topLevelCommentConditions(eb, filter, pinned))
    .executeTakeFirstOrThrow();
  return row.count;
}

/**
 * Both views' counts in ONE statement: `visible` is `countTopLevelComments` with `hidden: false`,
 * `hidden` with `hidden: true`. The base filter carries no `hidden` condition, and each count is a
 * `FILTER` on the value, so a NULL `hidden` lands in neither, as in each single count.
 */
export async function countTopLevelCommentsByHidden(
  db: Kysely<DB>,
  filter: TopLevelCommentsBaseFilter,
  pinned: PinnedScope
) {
  return db
    .selectFrom('Comment')
    .select([
      sql<number>`(count(*) filter (where "Comment"."hidden" is not true))::int` /* N4 */.as('visible'),
      sql<number>`(count(*) filter (where "Comment"."hidden" = true))::int`.as('hidden'),
    ])
    .where((eb) => topLevelCommentConditions(eb, filter, pinned))
    .executeTakeFirstOrThrow();
}

export type TopLevelCommentsPage =
  /** The unpinned list, `createdAt` newest or oldest first, `limit` rows after `offset`. */
  | { pinned: false; createdAt: 'asc' | 'desc'; limit: number; offset?: number }
  /** The pinned block: every pinned comment, `pinnedAt desc`. */
  | { pinned: true };

/**
 * Top-level comments with their author (`User`), the model name (`Model`) and their reactions
 * (`CommentReaction`, each with its reactor) in one statement. `Comment.userId` and
 * `Comment.modelId` are required foreign keys, so the inner joins drop no row.
 */
export function listTopLevelComments(
  db: Kysely<DB>,
  filter: TopLevelCommentsFilter,
  page: TopLevelCommentsPage
) {
  let query = db
    .selectFrom('Comment')
    .where((eb) => topLevelCommentConditions(eb, filter, page.pinned ? 'pinned' : 'unpinned'))
    .innerJoin('User', 'User.id', 'Comment.userId')
    .innerJoin('Model', 'Model.id', 'Comment.modelId')
    .select((eb) => [
      'Comment.id',
      'Comment.createdAt',
      'Comment.nsfw',
      'Comment.content',
      'Comment.modelId',
      'Comment.parentId',
      'Comment.locked',
      'Comment.tosViolation',
      'Comment.hidden',
      'Comment.pinnedAt',
      'User.id as authorId',
      'User.username as authorUsername',
      'User.deletedAt as authorDeletedAt',
      'User.image as authorImage',
      'Model.name as modelName',
      jsonArrayFrom(
        eb
          .selectFrom('CommentReaction')
          .innerJoin('User as Reactor', 'Reactor.id', 'CommentReaction.userId')
          .select([
            'CommentReaction.id',
            'CommentReaction.reaction',
            'Reactor.id as userId',
            'Reactor.username',
          ])
          .whereRef('CommentReaction.commentId', '=', 'Comment.id')
      ).as('reactions'),
    ]);
  if (page.pinned) return query.orderBy('Comment.pinnedAt', 'desc').execute();
  query = query.orderBy('Comment.createdAt', page.createdAt).limit(page.limit);
  if (page.offset) query = query.offset(page.offset);
  return query.execute();
}
