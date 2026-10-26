import type { Prisma, PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  countTopLevelComments,
  countTopLevelCommentsByHidden,
  listTopLevelComments,
  type PinnedScope,
  type TopLevelCommentsBaseFilter,
  type TopLevelCommentsFilter,
} from '@civitai/db-queries/hot-reads-4';
import { ReviewSort } from '~/server/common/enums';
import type { getAllCommentsWithCachedUserSelect } from '~/server/selectors/comment.selector';

export type { PinnedScope, TopLevelCommentsBaseFilter, TopLevelCommentsFilter };

/**
 * The model page's comment reads behind `kysely-hot-reads-4` (comment.service.ts): the visible
 * top-level comment count and the `comment.getAll` lists, each as a Prisma reader and its Kysely
 * twin taking the client and the same `TopLevelCommentsFilter`, so the parity suite
 * (__tests__/hot-reads-4.kysely-parity.test.ts) runs the very code the service runs. The Prisma
 * readers are the original reads, moved here verbatim.
 */

/** The Prisma where for a `TopLevelCommentsFilter`; the Kysely conditions are its twin. */
export function topLevelCommentsWhere(
  filter: TopLevelCommentsBaseFilter & { hidden?: boolean }
): Prisma.CommentWhereInput {
  const { modelId, userId, excludedUserIds } = filter;
  return {
    modelId,
    userId: userId ? userId : excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
    parentId: { equals: null },
    tosViolation: filter.excludeTosViolations ? false : undefined,
    hidden: filter.hidden,
  };
}

const pinnedAtWhere = (pinned: PinnedScope): Prisma.CommentWhereInput =>
  pinned === 'unpinned'
    ? { pinnedAt: null }
    : pinned === 'pinned'
    ? { pinnedAt: { not: null } }
    : {};

// ---------------------------------------------------------------------------------------------
// The visible top-level comment count (`getVisibleCommentCount`).

/** The Prisma read, unchanged. */
export function countTopLevelCommentsViaPrisma(
  db: PrismaClient,
  filter: TopLevelCommentsFilter,
  pinned: PinnedScope
) {
  return db.comment.count({
    where: { ...topLevelCommentsWhere(filter), ...pinnedAtWhere(pinned) },
  });
}

export function countTopLevelCommentsViaKysely(
  db: Kysely<DB>,
  filter: TopLevelCommentsFilter,
  pinned: PinnedScope
) {
  return countTopLevelComments(db, filter, pinned);
}

// ---------------------------------------------------------------------------------------------
// Both views' counts at once (`getVisibleCommentCounts`, `comment.getVisibleCountsByModel`):
// `visible` is the count with `hidden: false`, `hidden` the count with `hidden: true`.

export type CommentCountsByHidden = { visible: number; hidden: number };

/** One `groupBy hidden` over the base filter; a NULL `hidden` group counts in neither view. */
export async function countTopLevelCommentsByHiddenViaPrisma(
  db: PrismaClient,
  filter: TopLevelCommentsBaseFilter,
  pinned: PinnedScope
): Promise<CommentCountsByHidden> {
  const groups = await db.comment.groupBy({
    by: ['hidden'],
    where: { ...topLevelCommentsWhere(filter), ...pinnedAtWhere(pinned) },
    _count: { _all: true },
  });
  const countOf = (hidden: boolean) =>
    groups.find((group) => group.hidden === hidden)?._count._all ?? 0;
  return { visible: countOf(false), hidden: countOf(true) };
}

export function countTopLevelCommentsByHiddenViaKysely(
  db: Kysely<DB>,
  filter: TopLevelCommentsBaseFilter,
  pinned: PinnedScope
): Promise<CommentCountsByHidden> {
  return countTopLevelCommentsByHidden(db, filter, pinned);
}

// ---------------------------------------------------------------------------------------------
// The `comment.getAll` lists (`getComments`, `getPinnedComments`).

export type CommentListPage = {
  limit: number;
  skip?: number;
  cursor?: number;
  sort?: ReviewSort;
};

/** The Prisma read, unchanged: one page of unpinned top-level comments. */
export function findTopLevelCommentsViaPrisma<TSelect extends Prisma.CommentSelect>(
  db: PrismaClient,
  filter: TopLevelCommentsFilter,
  { limit, skip, cursor, sort }: CommentListPage,
  select: TSelect
) {
  return db.comment.findMany({
    take: limit,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: { ...topLevelCommentsWhere(filter), pinnedAt: null },
    orderBy: {
      createdAt:
        sort === ReviewSort.Oldest ? 'asc' : sort === ReviewSort.Newest ? 'desc' : undefined,
      reactions: sort === ReviewSort.MostLiked ? { _count: 'desc' } : undefined,
      comments: sort === ReviewSort.MostComments ? { _count: 'desc' } : undefined,
    },
    select,
  });
}

/** The Prisma read, unchanged: every pinned top-level comment. */
export function findPinnedCommentsViaPrisma<TSelect extends Prisma.CommentSelect>(
  db: PrismaClient,
  filter: TopLevelCommentsFilter,
  select: TSelect
) {
  return db.comment.findMany({
    where: { ...topLevelCommentsWhere(filter), pinnedAt: { not: null } },
    orderBy: { pinnedAt: 'desc' },
    select,
  });
}

/** One `comment.getAll` item as the Prisma read returns it (`getAllCommentsWithCachedUserSelect`). */
export type CommentListItem = Prisma.CommentGetPayload<{
  select: typeof getAllCommentsWithCachedUserSelect;
}>;

export type KyselyCommentListSort = ReviewSort.Newest | ReviewSort.Oldest;

/**
 * A page the Kysely list serves: the first page (no cursor), sorted newest or oldest first. Prisma
 * pages a cursor by the cursor row's sort key, and sorts the other orders by relation counts, so
 * those stay on Prisma.
 */
export function isKyselyCommentListPage<T extends { cursor?: number; sort?: ReviewSort }>(
  page: T
): page is T & { cursor?: undefined; sort: KyselyCommentListSort } {
  return !page.cursor && (page.sort === ReviewSort.Newest || page.sort === ReviewSort.Oldest);
}

export type KyselyCommentListPage = { limit: number; skip?: number; sort: KyselyCommentListSort };

type ListRow = Awaited<ReturnType<typeof listTopLevelComments>>[number];

function toCommentListItem(row: ListRow): CommentListItem {
  return {
    id: row.id,
    createdAt: row.createdAt,
    nsfw: row.nsfw,
    content: row.content,
    modelId: row.modelId,
    parentId: row.parentId,
    locked: row.locked,
    tosViolation: row.tosViolation,
    hidden: row.hidden,
    pinnedAt: row.pinnedAt,
    user: {
      id: row.authorId,
      username: row.authorUsername,
      deletedAt: row.authorDeletedAt,
      image: row.authorImage,
    },
    reactions: row.reactions.map((reaction) => ({
      id: reaction.id,
      reaction: reaction.reaction as CommentListItem['reactions'][number]['reaction'],
      user: { id: reaction.userId, username: reaction.username },
    })),
    model: { name: row.modelName },
  };
}

/** `findTopLevelCommentsViaPrisma` with the `comment.getAll` select, for a first page. */
export async function listTopLevelCommentsViaKysely(
  db: Kysely<DB>,
  filter: TopLevelCommentsFilter,
  { limit, skip, sort }: KyselyCommentListPage
): Promise<CommentListItem[]> {
  const rows = await listTopLevelComments(db, filter, {
    pinned: false,
    createdAt: sort === ReviewSort.Oldest ? 'asc' : 'desc',
    limit,
    offset: skip,
  });
  return rows.map(toCommentListItem);
}

/** `findPinnedCommentsViaPrisma` with the `comment.getAll` select. */
export async function listPinnedCommentsViaKysely(
  db: Kysely<DB>,
  filter: TopLevelCommentsFilter
): Promise<CommentListItem[]> {
  const rows = await listTopLevelComments(db, filter, { pinned: true });
  return rows.map(toCommentListItem);
}
