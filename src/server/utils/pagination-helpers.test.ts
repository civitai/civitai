import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { getCursor, getCursorClauses, getPagingData } from '~/server/utils/pagination-helpers';

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

/**
 * Regression: `model.getAll` 500'd with the raw Postgres error
 * `date/time field value out of range: "165997"` / `"493785"`.
 *
 * `model.getAll` takes its cursor as JSON, so a client can send a bare NUMBER.
 * `parseCursor`'s scalar branch bound that number to `fields[0]` without any
 * arity check — and for the Newest/Oldest sorts `fields[0]` is the TIMESTAMP
 * column `mm."lastVersionAt"`. Postgres then had to read `165997` as a
 * timestamp and threw, surfacing as an INTERNAL_SERVER_ERROR for what is a
 * malformed client input.
 *
 * Note the offending values are ordinary in-range integers, so no magnitude
 * bound on the cursor input can catch this — the guard has to be the arity one.
 */
describe('parseCursor (via getCursor) — scalar cursor on a multi-field sort', () => {
  const NEWEST = 'lastVersionAt DESC NULLS LAST, modelId DESC';

  it('rejects the production value 165997 as a number on a date-headed 2-field sort → 400', () => {
    expectBadRequest(() => getCursor(NEWEST, 165997));
  });

  it('rejects the production value 493785 as a number on a date-headed 2-field sort → 400', () => {
    expectBadRequest(() => getCursor(NEWEST, 493785));
  });

  it('never binds a bare number to a timestamp sort column (the actual PG fault)', () => {
    // The pre-fix behaviour: `where` came back holding 165997 as the bound value
    // for `lastVersionAt`, which is what Postgres choked on. Post-fix the call
    // cannot return at all.
    let where: unknown;
    expect(() => {
      where = getCursor(NEWEST, 165997).where;
    }).toThrow();
    expect(where).toBeUndefined();
  });

  it('rejects a scalar cursor on the 3-field metric sorts too (HighestRated/MostDownloaded shape)', () => {
    expectBadRequest(() => getCursor('thumbsUpCount DESC, downloadCount DESC, modelId', 165997));
  });

  it('rejects a bigint scalar cursor on a multi-field sort → 400', () => {
    expectBadRequest(() => getCursor(NEWEST, BigInt(165997)));
  });

  it('rejects a Date scalar cursor on a multi-field sort → 400', () => {
    expectBadRequest(() => getCursor(NEWEST, new Date('2024-01-15T00:00:00.000Z')));
  });

  it('reports the arity in the message, matching the string-cursor guard', () => {
    let thrown: unknown;
    try {
      getCursor(NEWEST, 165997);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as TRPCError).message).toBe(
      'Invalid cursor: expected 2 value(s) for this sort, received 1'
    );
  });

  it('still accepts a scalar cursor on a SINGLE-field sort (RecentlyAdded: ci."id" DESC)', () => {
    // Not over-tightened: a single-field sort genuinely issues a bare column
    // value as its nextCursor, so a number is well-formed there.
    const { where } = getCursor('ci."id" DESC', 165997);
    expect(where).toBeDefined();
    expect((where as unknown as { values: unknown[] }).values).toContain(165997);
  });
});

describe('parseCursorClauses — scalar cursor on a multi-field sort (the model.getAll caller)', () => {
  // getModelsRaw uses getCursorClauses, not getCursor. Same parseCursor inside,
  // but pin it separately so a future divergence can't reopen the hole.
  const NEWEST = 'mm."lastVersionAt" DESC NULLS LAST, p."modelId" DESC';

  it('rejects 165997 as a number → 400', () => {
    expectBadRequest(() => getCursorClauses(NEWEST, 165997));
  });

  it('accepts a well-formed composite cursor unchanged', () => {
    const { strict, equality, splittable } = getCursorClauses(NEWEST, '2024-01-15|2686725');
    expect(splittable).toBe(true);
    expect(strict).toBeDefined();
    expect(equality).toBeDefined();
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
