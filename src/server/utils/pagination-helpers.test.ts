import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { getCursor, getPagingData } from '~/server/utils/pagination-helpers';

// `parseCursor` is not exported; it is exercised here through `getCursor`, the
// public helper every keyset-paginated endpoint uses to turn a `nextCursor`
// string back into a SQL WHERE predicate.
//
// Regression context: `model.getAll` browse queries 500'd (~35/12h) with
// `invalid input syntax for type timestamp: "NaN"`. A Newest/Oldest page that
// ended on a model with a NULL `lastVersionAt` (the NULLS-LAST tail) emitted a
// nextCursor of `"|<modelId>"` — `CONCAT(NULL, '|', id)`. Parsing that empty
// leading token produced NaN, which was bound into the SQL comparison and made
// Postgres throw → an unattributable INTERNAL_SERVER_ERROR. The fix rejects a
// malformed/unparseable cursor token with a 400 (BAD_REQUEST) instead.

/** Assert a call throws a tRPC BAD_REQUEST (the `throwBadRequestError` shape). */
function expectBadRequest(fn: () => unknown) {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected a thrown error').toBeInstanceOf(TRPCError);
  expect((thrown as TRPCError).code).toBe('BAD_REQUEST');
}

describe('parseCursor (via getCursor) — malformed-token rejection', () => {
  it('rejects an empty leading timestamp token (the NULL-lastVersionAt bug): "|<id>" → 400, not NaN', () => {
    // Two-field date-then-id sort, mirroring Newest/Oldest.
    // token0 = "" (NULL date column), token1 = "2686725". Empty token → NaN.
    expectBadRequest(() => getCursor('createdAt DESC, id DESC', '|2686725'));
  });

  it('rejects a non-numeric leading token that parses to NaN → 400', () => {
    // Single-field numeric sort with a garbage token.
    expectBadRequest(() => getCursor('id DESC', 'abc'));
  });

  it('rejects an unparseable/Invalid-Date token → 400', () => {
    // token0 contains "-" so it takes the dayjs branch; "not-a-date" is Invalid.
    expectBadRequest(() => getCursor('createdAt DESC, id DESC', 'not-a-date|123'));
  });

  it('rejects an empty trailing numeric token: "<date>|" → 400', () => {
    expectBadRequest(() => getCursor('createdAt DESC, id DESC', '2024-01-15|'));
  });
});

describe('parseCursor (via getCursor) — well-formed cursors parse unchanged', () => {
  it('parses a well-formed composite date|id cursor without throwing and binds real values', () => {
    const { where } = getCursor('createdAt DESC, id DESC', '2024-01-15|2686725');
    expect(where).toBeDefined();
    // Prisma.Sql exposes the flattened bound parameter list. Confirm the tokens
    // parsed to real (non-NaN) values: a Date for `createdAt` and the id number.
    const values = (where as unknown as { values: unknown[] }).values;
    const numbers = values.filter((v): v is number => typeof v === 'number');
    const dates = values.filter((v): v is Date => v instanceof Date);
    expect(numbers).toContain(2686725);
    expect(numbers.every((n) => !Number.isNaN(n))).toBe(true);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => !Number.isNaN(d.getTime()))).toBe(true);
    // The date token round-trips to 2024-01-15 UTC.
    expect(dates[0].toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('parses a well-formed single-field numeric cursor without throwing', () => {
    const { where } = getCursor('id DESC', '2686725');
    expect(where).toBeDefined();
    const values = (where as unknown as { values: unknown[] }).values;
    expect(values).toContain(2686725);
  });

  it('returns no predicate when there is no cursor (unchanged)', () => {
    const { where } = getCursor('id DESC', undefined);
    expect(where).toBeUndefined();
  });
});

describe('getPagingData', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

  describe('exact-count path (unchanged — browse / count:true no-query)', () => {
    it('derives totalItems/totalPages from an exact count', () => {
      const result = getPagingData({ count: 45, items }, 20, 2);
      expect(result).toEqual({
        items,
        totalItems: 45,
        currentPage: 2,
        pageSize: 20,
        totalPages: 3, // ceil(45/20)
      });
      // No hasMore field on the exact-count path — response shape is unchanged.
      expect(result).not.toHaveProperty('hasMore');
    });

    it('defaults totalItems to 0 and totalPages to 1 when no count is given', () => {
      const result = getPagingData({ items }, 20, 1);
      expect(result.totalItems).toBe(0);
      expect(result.totalPages).toBe(1);
      expect(result).not.toHaveProperty('hasMore');
    });
  });

  describe('hasMore path (search — exact COUNT dropped)', () => {
    it('hasMore=true ⇒ totalPages is currentPage+1 (nextPage link stays live)', () => {
      // page 1, pageSize 20, a full page + "there is more"
      const result = getPagingData({ items, hasMore: true }, 20, 1);
      expect(result.hasMore).toBe(true);
      expect(result.currentPage).toBe(1);
      expect(result.totalPages).toBe(2); // currentPage + 1 ⇒ getPaginationLinks emits nextPage
      // lower-bound total: 0 skipped + 3 items + 1 (more) = 4
      expect(result.totalItems).toBe(4);
      // fields required by the public /api/v1/creators contract are all present + numeric
      expect(typeof result.totalItems).toBe('number');
      expect(typeof result.totalPages).toBe('number');
      expect(typeof result.pageSize).toBe('number');
    });

    it('hasMore=false ⇒ totalPages is currentPage (last page; no nextPage)', () => {
      const result = getPagingData({ items, hasMore: false }, 20, 1);
      expect(result.hasMore).toBe(false);
      expect(result.totalPages).toBe(1); // currentPage ⇒ currentPage < totalPages is false
      // exact on the final page: 0 skipped + 3 items = 3
      expect(result.totalItems).toBe(3);
    });

    it('accounts for skipped pages in the lower-bound total (page 3, hasMore)', () => {
      const result = getPagingData({ items, hasMore: true }, 20, 3);
      // skipped = (3-1)*20 = 40; +3 items +1 more = 44
      expect(result.totalItems).toBe(44);
      expect(result.totalPages).toBe(4); // currentPage + 1
      expect(result.currentPage).toBe(3);
    });
  });
});
