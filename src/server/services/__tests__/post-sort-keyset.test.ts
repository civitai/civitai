import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PostSort } from '~/server/common/enums';
import {
  buildPostCursorClause,
  encodePostCursor,
  getPostSortClauses,
} from '~/server/services/post-sort';

// `PostSort.Oldest` is the first ascending sort in `getPostsInfinite`. Every other sort is
// DESC, and the keyset cursor was written for DESC only, so an ORDER BY and a comparison
// that disagree do not error — they re-serve page 1 forever, or skip the backlog. These
// tests drive the real clause builders through a bounded in-memory pager so that flipping
// either half back to DESC fails on the first repeated row instead of hanging the runner.

type Row = {
  id: number;
  publishedAt: Date | null;
  createdAt: Date;
  /** The post's "CollectionItem".id — set only on the collection feed rows below. */
  collectionItemId?: number;
};

const d = (iso: string) => new Date(iso);

const plusCentury = (date: Date) => {
  const out = new Date(date);
  out.setUTCFullYear(out.getUTCFullYear() + 100);
  return out;
};

// Drafts (publishedAt null) interleaved with scheduled posts (publishedAt in the future),
// plus a createdAt tie on 102/103 so the id tiebreaker is actually exercised.
const draftFeed: Row[] = [
  { id: 101, publishedAt: null, createdAt: d('2021-01-01T00:00:00.000Z') },
  { id: 102, publishedAt: null, createdAt: d('2021-06-01T00:00:00.000Z') },
  { id: 103, publishedAt: null, createdAt: d('2021-06-01T00:00:00.000Z') },
  { id: 104, publishedAt: null, createdAt: d('2022-01-01T00:00:00.000Z') },
  { id: 105, publishedAt: null, createdAt: d('2023-01-01T00:00:00.000Z') },
  { id: 106, publishedAt: null, createdAt: d('2024-01-01T00:00:00.000Z') },
  { id: 107, publishedAt: null, createdAt: d('2025-01-01T00:00:00.000Z') },
  { id: 108, publishedAt: null, createdAt: d('2026-01-01T00:00:00.000Z') },
  { id: 201, publishedAt: d('2026-09-01T00:00:00.000Z'), createdAt: d('2026-08-01T00:00:00.000Z') },
  { id: 202, publishedAt: d('2026-10-01T00:00:00.000Z'), createdAt: d('2026-08-02T00:00:00.000Z') },
  { id: 203, publishedAt: d('2026-11-01T00:00:00.000Z'), createdAt: d('2026-08-03T00:00:00.000Z') },
  { id: 204, publishedAt: d('2026-12-01T00:00:00.000Z'), createdAt: d('2026-08-04T00:00:00.000Z') },
];

const publishedFeed: Row[] = [
  { id: 1, publishedAt: d('2019-03-04T10:00:00.000Z'), createdAt: d('2019-03-04T09:00:00.000Z') },
  { id: 2, publishedAt: d('2020-07-19T10:00:00.000Z'), createdAt: d('2020-07-19T09:00:00.000Z') },
  { id: 3, publishedAt: d('2020-07-19T10:00:00.000Z'), createdAt: d('2020-07-19T09:30:00.000Z') },
  { id: 4, publishedAt: d('2021-11-02T10:00:00.000Z'), createdAt: d('2021-11-02T09:00:00.000Z') },
  { id: 5, publishedAt: d('2023-02-14T10:00:00.000Z'), createdAt: d('2023-02-14T09:00:00.000Z') },
  { id: 6, publishedAt: d('2024-05-30T10:00:00.000Z'), createdAt: d('2024-05-30T09:00:00.000Z') },
  { id: 7, publishedAt: d('2025-01-09T10:00:00.000Z'), createdAt: d('2025-01-09T09:00:00.000Z') },
];

// Added to the collection in an order unrelated to publication: 501 is the oldest post but
// the most recently added item, 504 the newest post but the earliest added. Newest and
// Recently Added therefore produce exactly reversed feeds, so a Recently Added that quietly
// falls through to the publishedAt branch cannot pass by coincidence.
const collectionFeed: Row[] = [
  {
    id: 501,
    publishedAt: d('2020-01-01T00:00:00.000Z'),
    createdAt: d('2020-01-01T00:00:00.000Z'),
    collectionItemId: 94,
  },
  {
    id: 502,
    publishedAt: d('2022-01-01T00:00:00.000Z'),
    createdAt: d('2022-01-01T00:00:00.000Z'),
    collectionItemId: 93,
  },
  {
    id: 503,
    publishedAt: d('2024-01-01T00:00:00.000Z'),
    createdAt: d('2024-01-01T00:00:00.000Z'),
    collectionItemId: 92,
  },
  {
    id: 504,
    publishedAt: d('2026-01-01T00:00:00.000Z'),
    createdAt: d('2026-01-01T00:00:00.000Z'),
    collectionItemId: 91,
  },
];

/**
 * Evaluate one of the sort expressions the module emits against an in-memory row. The
 * `default` throw is deliberate: if `getPostSortClauses` starts emitting an expression this
 * pager cannot evaluate, the suite must fail loudly rather than silently pass on a stale
 * simulation.
 */
const evalSortKey = (expr: string, row: Row): number => {
  switch (expr) {
    case 'p."publishedAt"':
      if (!row.publishedAt) throw new Error(`row ${row.id} has a null publishedAt under ${expr}`);
      return row.publishedAt.getTime();
    case 'COALESCE(p."publishedAt", p."createdAt")':
      return (row.publishedAt ?? row.createdAt).getTime();
    case `COALESCE(p."publishedAt", p."createdAt" + interval '100 years')`:
      return (row.publishedAt ?? plusCentury(row.createdAt)).getTime();
    case 'ci."id"':
      if (row.collectionItemId === undefined)
        throw new Error(`row ${row.id} has no collectionItemId under ${expr}`);
      return row.collectionItemId;
    default:
      throw new Error(`post-sort pager cannot evaluate sort expression: ${expr}`);
  }
};

const parseDirection = (orderBy: string) => {
  const match = orderBy.match(/^(.+?)\s+(ASC|DESC),\s*p\.id\s+(ASC|DESC)$/);
  if (match) {
    const [, , primaryDir, idDir] = match;
    if (primaryDir !== idDir)
      throw new Error(`orderBy mixes directions, keyset cursor cannot be single-tuple: ${orderBy}`);
    return primaryDir === 'ASC' ? 1 : -1;
  }

  // Recently Added carries no p.id tiebreaker: the join is through a unique
  // ("collectionId", "postId") index, so ci."id" is already total over the feed.
  const single = orderBy.match(/^(.+?)\s+(ASC|DESC)$/);
  if (!single) throw new Error(`unparseable orderBy: ${orderBy}`);
  return single[2] === 'ASC' ? 1 : -1;
};

type ParsedCursor =
  | { kind: 'composite'; operator: '>=' | '<='; value: number; id: number }
  | { kind: 'legacy'; operator: '>' | '<'; value: number };

const toNumber = (value: unknown) => (value instanceof Date ? value.getTime() : Number(value));

const parseCursorClause = (clause: Prisma.Sql): ParsedCursor => {
  const composite = clause.text.match(/\)\s*(>=|<=)\s*\(/);
  if (composite)
    return {
      kind: 'composite',
      operator: composite[1] as '>=' | '<=',
      value: toNumber(clause.values[0]),
      id: Number(clause.values[1]),
    };

  const legacy = clause.text.match(/\s(>|<)\s\$1$/);
  if (!legacy) throw new Error(`unparseable cursor clause: ${clause.text}`);
  return { kind: 'legacy', operator: legacy[1] as '>' | '<', value: toNumber(clause.values[0]) };
};

const cmpTuple = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1];

/** One page of `getPostsInfinite`, driven entirely by the real clause builders. */
const fetchPage = ({
  rows,
  sort,
  draftOnly,
  collectionJoined,
  limit,
  cursor,
}: {
  rows: Row[];
  sort: PostSort;
  draftOnly?: boolean;
  collectionJoined?: boolean;
  limit: number;
  cursor?: string;
}) => {
  const { orderBy, primarySortProp, isDateSort, ascending } = getPostSortClauses({
    sort,
    draftOnly,
    collectionJoined,
  });
  const direction = parseDirection(orderBy);
  const cursorClause = buildPostCursorClause({ cursor, primarySortProp, isDateSort, ascending });

  let candidates = rows.map((row) => ({ row, key: evalSortKey(primarySortProp, row) }));

  if (cursorClause) {
    const parsed = parseCursorClause(cursorClause);
    candidates = candidates.filter(({ row, key }) => {
      if (parsed.kind === 'legacy')
        return parsed.operator === '>' ? key > parsed.value : key < parsed.value;
      const cmp = cmpTuple([key, row.id], [parsed.value, parsed.id]);
      return parsed.operator === '>=' ? cmp >= 0 : cmp <= 0;
    });
  }

  candidates.sort((a, b) => direction * cmpTuple([a.key, a.row.id], [b.key, b.row.id]));

  const slice = candidates.slice(0, limit + 1);
  if (slice.length <= limit) return { items: slice.map((c) => c.row.id), nextCursor: undefined };

  const nextItem = slice.pop();
  if (!nextItem) throw new Error('unreachable: slice longer than limit but pop returned nothing');
  const nextCursor = encodePostCursor({
    id: nextItem.row.id,
    cursorId: isDateSort ? new Date(nextItem.key) : nextItem.key,
  });
  return { items: slice.map((c) => c.row.id), nextCursor };
};

const PAGE_CAP = 20;

/**
 * Page to exhaustion. Bounded by construction: the loop can run at most PAGE_CAP times and
 * throws on the way out, so a cursor that never advances surfaces as a failed assertion or a
 * thrown error in milliseconds — never as a runner hang.
 */
const drain = ({
  rows,
  sort,
  draftOnly,
  collectionJoined,
  limit,
}: {
  rows: Row[];
  sort: PostSort;
  draftOnly?: boolean;
  collectionJoined?: boolean;
  limit: number;
}) => {
  const seen: number[] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (pages < PAGE_CAP) {
    const { items, nextCursor } = fetchPage({
      rows,
      sort,
      draftOnly,
      collectionJoined,
      limit,
      cursor,
    });
    pages += 1;
    for (const id of items) {
      // A comparison pointing against the ORDER BY re-serves rows it already served. Fail on
      // the first repeat rather than letting the pager spin.
      expect(seen, `page ${pages} re-served post ${id}`).not.toContain(id);
      seen.push(id);
    }
    if (!nextCursor) return { seen, pages };
    cursor = nextCursor;
  }

  throw new Error(
    `pagination did not terminate within ${PAGE_CAP} pages (collected ${seen.length} of ${rows.length} rows)`
  );
};

describe('getPostSortClauses', () => {
  it('orders the published feed ascending under Oldest', () => {
    expect(getPostSortClauses({ sort: PostSort.Oldest })).toMatchObject({
      orderBy: 'p."publishedAt" ASC, p.id ASC',
      primarySortProp: 'p."publishedAt"',
      isDateSort: true,
      ascending: true,
    });
  });

  it('keeps every other sort descending', () => {
    expect(getPostSortClauses({ sort: PostSort.Newest }).orderBy).toBe(
      'p."publishedAt" DESC, p.id DESC'
    );
    for (const sort of [PostSort.MostReactions, PostSort.MostComments, PostSort.MostCollected]) {
      const clauses = getPostSortClauses({ sort });
      expect(clauses.ascending).toBe(false);
      expect(clauses.orderBy).toContain('DESC');
    }
  });

  it('drops the +100 years draft offset under Oldest so old drafts outrank scheduled posts', () => {
    const oldest = getPostSortClauses({ sort: PostSort.Oldest, draftOnly: true });
    expect(oldest.primarySortProp).toBe('COALESCE(p."publishedAt", p."createdAt")');
    expect(oldest.orderBy).toBe('COALESCE(p."publishedAt", p."createdAt") ASC, p.id ASC');

    // Newest still needs the offset to pin drafts ahead of scheduled posts.
    expect(getPostSortClauses({ sort: PostSort.Newest, draftOnly: true }).primarySortProp).toBe(
      `COALESCE(p."publishedAt", p."createdAt" + interval '100 years')`
    );
  });

  it('orders on the collection item, not the post, under Recently Added', () => {
    expect(getPostSortClauses({ sort: PostSort.RecentlyAdded, collectionJoined: true })).toMatchObject(
      {
        orderBy: 'ci."id" DESC',
        primarySortProp: 'ci."id"',
        isDateSort: false,
        ascending: false,
      }
    );
  });

  it('falls back to publishedAt when the caller did not join the collection', () => {
    // getPostsInfinite rejects this combination before it reaches here, so the fallback is
    // a second line rather than the contract — but emitting ci."id" against a FROM that has
    // no ci would be a 500 rather than a wrong order.
    expect(getPostSortClauses({ sort: PostSort.RecentlyAdded }).primarySortProp).toBe(
      'p."publishedAt"'
    );
  });

  it('pages a collection feed in add order, opposite to the publication order', () => {
    const recentlyAdded = drain({
      rows: collectionFeed,
      sort: PostSort.RecentlyAdded,
      collectionJoined: true,
      limit: 2,
    });
    expect(recentlyAdded.seen).toEqual([501, 502, 503, 504]);
    expect(recentlyAdded.pages).toBeGreaterThan(1);

    // The negative control: same rows, publication order, reversed. Without it a pager that
    // ignored primarySortProp entirely could still satisfy the assertion above.
    expect(drain({ rows: collectionFeed, sort: PostSort.Newest, limit: 2 }).seen).toEqual([
      504, 503, 502, 501,
    ]);
  });

  it('adds no `> 0` filter for Oldest — it is a date sort, not a count sort', () => {
    expect(getPostSortClauses({ sort: PostSort.Oldest }).filter).toBeUndefined();
    expect(getPostSortClauses({ sort: PostSort.Oldest, draftOnly: true }).filter).toBeUndefined();
    expect(getPostSortClauses({ sort: PostSort.MostReactions }).filter?.text).toBe(
      'p."reactionCount" > 0'
    );
  });
});

describe('buildPostCursorClause', () => {
  const primarySortProp = 'p."publishedAt"';

  it('compares forward for an ascending sort and backward for a descending one', () => {
    const asc = buildPostCursorClause({
      cursor: '2021-01-01T00:00:00.000Z|42',
      primarySortProp,
      isDateSort: true,
      ascending: true,
    });
    const desc = buildPostCursorClause({
      cursor: '2021-01-01T00:00:00.000Z|42',
      primarySortProp,
      isDateSort: true,
      ascending: false,
    });

    expect(asc?.text).toBe('(p."publishedAt", p.id) >= ($1, $2)');
    expect(desc?.text).toBe('(p."publishedAt", p.id) <= ($1, $2)');
    expect(asc?.values).toEqual([d('2021-01-01T00:00:00.000Z'), 42]);
  });

  it('flips the strict legacy single-value comparison too', () => {
    const asc = buildPostCursorClause({
      cursor: '2021-01-01T00:00:00.000Z',
      primarySortProp,
      isDateSort: true,
      ascending: true,
    });
    const desc = buildPostCursorClause({
      cursor: '2021-01-01T00:00:00.000Z',
      primarySortProp,
      isDateSort: true,
      ascending: false,
    });

    expect(asc?.text).toBe('p."publishedAt" > $1');
    expect(desc?.text).toBe('p."publishedAt" < $1');
  });

  it('returns no clause without a cursor', () => {
    expect(
      buildPostCursorClause({ primarySortProp, isDateSort: true, ascending: true })
    ).toBeUndefined();
  });
});

describe('keyset pagination', () => {
  it('walks the published feed oldest-first with no repeats and no skips', () => {
    const { seen, pages } = drain({ rows: publishedFeed, sort: PostSort.Oldest, limit: 3 });

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pages).toBe(3);
    expect(pages).toBeLessThan(PAGE_CAP);
  });

  it('walks the draft feed oldest-first, drafts ahead of scheduled posts', () => {
    const { seen, pages } = drain({
      rows: draftFeed,
      sort: PostSort.Oldest,
      draftOnly: true,
      limit: 4,
    });

    expect(seen).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 201, 202, 203, 204]);
    expect(pages).toBe(3);
    expect(pages).toBeLessThan(PAGE_CAP);
  });

  it('still walks the draft feed newest-first under Newest (unchanged behaviour)', () => {
    const { seen, pages } = drain({
      rows: draftFeed,
      sort: PostSort.Newest,
      draftOnly: true,
      limit: 4,
    });

    expect(seen).toEqual([108, 107, 106, 105, 104, 103, 102, 101, 204, 203, 202, 201]);
    expect(pages).toBe(3);
  });

  it('does not stall on a createdAt tie — the id tiebreaker carries the page boundary', () => {
    // limit 2 lands the page boundary exactly between 102 and 103, which share a createdAt.
    const { seen, pages } = drain({
      rows: draftFeed,
      sort: PostSort.Oldest,
      draftOnly: true,
      limit: 2,
    });

    expect(seen.slice(0, 4)).toEqual([101, 102, 103, 104]);
    expect(seen).toHaveLength(draftFeed.length);
    expect(pages).toBe(6);
  });
});
