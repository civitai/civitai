import { Prisma } from '@prisma/client';
import { PostSort } from '~/server/common/enums';

export type PostSortClauses = {
  orderBy: string;
  primarySortProp: string;
  isDateSort: boolean;
  ascending: boolean;
  filter?: Prisma.Sql;
};

/**
 * ORDER BY / keyset-sort-key selection for `getPostsInfinite`.
 *
 * Kept in a standalone (import-light) module so the keyset pagination contract is
 * unit-testable without the full post.service dependency graph — same reasoning as
 * post-collection-visibility.ts.
 */
export const getPostSortClauses = ({
  sort,
  draftOnly,
}: {
  sort: PostSort;
  draftOnly?: boolean;
}): PostSortClauses => {
  switch (sort) {
    case PostSort.MostComments:
      return {
        orderBy: 'p."commentCount" DESC, p.id DESC',
        primarySortProp: 'p."commentCount"',
        isDateSort: false,
        ascending: false,
        filter: Prisma.sql`p."commentCount" > 0`,
      };
    case PostSort.MostReactions:
      return {
        orderBy: 'p."reactionCount" DESC, p.id DESC',
        primarySortProp: 'p."reactionCount"',
        isDateSort: false,
        ascending: false,
        filter: Prisma.sql`p."reactionCount" > 0`,
      };
    case PostSort.MostCollected:
      return {
        orderBy: 'p."collectedCount" DESC, p.id DESC',
        primarySortProp: 'p."collectedCount"',
        isDateSort: false,
        ascending: false,
        filter: Prisma.sql`p."collectedCount" > 0`,
      };
    default:
      break;
  }

  const ascending = sort === PostSort.Oldest;
  const direction = ascending ? 'ASC' : 'DESC';

  // draftOnly mixes drafts (publishedAt IS NULL) with scheduled (publishedAt > NOW()).
  // Descending, the +100 years offset keeps drafts ahead of any scheduled post while
  // preserving createdAt order among themselves. Ascending it would do the opposite and
  // bury drafts behind every scheduled post, so Oldest drops the offset and orders both
  // partitions on one true timeline — reaching old drafts is the point of the sort.
  const primarySortProp = draftOnly
    ? ascending
      ? `COALESCE(p."publishedAt", p."createdAt")`
      : `COALESCE(p."publishedAt", p."createdAt" + interval '100 years')`
    : 'p."publishedAt"';

  return {
    orderBy: `${primarySortProp} ${direction}, p.id ${direction}`,
    primarySortProp,
    isDateSort: true,
    ascending,
  };
};

/**
 * Keyset cursor predicate. `ascending` MUST come from the same
 * `getPostSortClauses` call that produced `primarySortProp` — a comparison
 * pointing against the ORDER BY either re-serves page 1 forever or skips
 * straight past the backlog.
 */
export const buildPostCursorClause = ({
  cursor,
  primarySortProp,
  isDateSort,
  ascending,
}: {
  cursor?: string | number;
  primarySortProp: string;
  isDateSort: boolean;
  ascending: boolean;
}): Prisma.Sql | undefined => {
  if (!cursor) return undefined;

  let primaryValue: Date | number;
  let cursorId: number | null = null;

  // Composite cursor (format: "value|id"), or a legacy single value.
  if (typeof cursor === 'string' && cursor.includes('|')) {
    const [valueStr, idStr] = cursor.split('|');
    primaryValue = isDateSort ? new Date(valueStr) : Number(valueStr);
    cursorId = Number(idStr);
  } else {
    primaryValue = isDateSort ? new Date(cursor) : Number(cursor);
  }

  const sortProp = Prisma.raw(primarySortProp);

  if (cursorId !== null) {
    // Row-comparison form lets postgres push the predicate into Index Cond on a
    // (primarySortProp, id) index. Equivalent to
    // (primary < cursor) OR (primary = cursor AND id <= cursorId), mirrored for ASC.
    return ascending
      ? Prisma.sql`(${sortProp}, p.id) >= (${primaryValue}, ${cursorId})`
      : Prisma.sql`(${sortProp}, p.id) <= (${primaryValue}, ${cursorId})`;
  }

  return ascending
    ? Prisma.sql`${sortProp} > ${primaryValue}`
    : Prisma.sql`${sortProp} < ${primaryValue}`;
};

export const encodePostCursor = (row: { id: number; cursorId: Date | number | null }) => {
  if (row.cursorId === null || row.cursorId === undefined) return undefined;
  const cursorValue =
    row.cursorId instanceof Date ? row.cursorId.toISOString() : String(row.cursorId);
  return `${cursorValue}|${row.id}`;
};
