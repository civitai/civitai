import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { getCursor } from '~/server/utils/pagination-helpers';

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
