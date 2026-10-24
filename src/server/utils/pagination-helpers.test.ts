import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { INT4_MAX, keysetCursorSchema } from '~/server/schema/base.schema';
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

/**
 * 🔴 DOCUMENTED OPEN RESIDUAL — this test pins a KNOWN FAULT, not correct behaviour.
 *
 * The scalar guard above closes only the bare-number/bigint/Date shape. A
 * hand-built COMPOSITE cursor has the right token COUNT, and `parseCursor`
 * classifies each token by its own SPELLING rather than by the column it will be
 * compared against, so a numeric head token on a date-headed sort is still bound
 * to the TIMESTAMP column and Postgres still throws
 * `date/time field value out of range`.
 *
 * This residual is UNAFFECTED by the numeric-first discriminator fix pinned
 * further down this file: `'165997'` was spelled as an integer before and after,
 * so it took the numeric branch both ways. Making the split numeric-first closed
 * the NEGATIVE-token case only; it closed nothing here.
 *
 * Closing it needs per-field TYPE information that the sort string does not
 * carry — the fix is to thread the sort fields' types through
 * `getCursor`/`getCursorClauses`, which is a wider change than the defect this
 * file's guard was added for.
 *
 * When that lands, this test will fail. That is the point: replace it with an
 * `expectBadRequest(...)` rather than deleting it.
 */
describe('parseCursor (via getCursorClauses) — KNOWN GAP: composite numeric token on a date column', () => {
  it('still binds a numeric head token to a timestamp sort column (NOT yet rejected)', () => {
    const { strict } = getCursorClauses(
      'mm."lastVersionAt" DESC NULLS LAST, mm."modelId" DESC',
      '165997|123'
    );
    const values = (strict as unknown as { values: unknown[] }).values;
    // 165997 reaches the SQL comparison against `lastVersionAt` — the exact
    // binding that makes Postgres throw. No guard rejects it today.
    expect(values).toContain(165997);
    expect(values.some((v) => v instanceof Date)).toBe(false);
  });
});

describe('getCursorClauses — scalar cursor on a multi-field sort (the model.getAll caller)', () => {
  // getModelsRaw uses getCursorClauses, not getCursor. Same parseCursor inside,
  // but pin it separately so a future divergence can't reopen the hole.
  const NEWEST = 'mm."lastVersionAt" DESC NULLS LAST, mm."modelId" DESC';

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

/**
 * REGRESSION. A numeric cursor token above int4 used to bind straight into the
 * SQL comparison, so Postgres threw `value out of range for type integer` — a raw
 * 500 for a client fault. `keysetCursorSchema` bounds only the number/bigint
 * spellings, so the same value was rejected as `999999999999` and accepted as
 * `'999999999999'`. See PR #5146.
 */
describe('parseCursor (via getCursor) — int4 range guard on a numeric STRING token', () => {
  it('rejects an out-of-range numeric string token on a single-field sort → 400', () => {
    expectBadRequest(() => getCursor('id DESC', '999999999999'));
  });

  it('rejects an out-of-range numeric token in the TAIL of a composite cursor → 400', () => {
    expectBadRequest(() => getCursor('createdAt DESC, id DESC', '2024-01-15|999999999999'));
  });

  it('CONTROL: accepts int4 max itself, so the guard is not off by one', () => {
    const { where } = getCursor('id DESC', '2147483647');
    expect(where).toBeDefined();
    const values = (where as unknown as { values: unknown[] }).values;
    expect(values).toContain(2147483647);
  });

  it('CONTROL: accepts zero, matching the cursor schema’s `CURSOR_MIN` floor', () => {
    // The lower bound of the range guard below. `0` is issuable as a nextCursor
    // (see the `limit:0` note in keyset-cursor-bounds.test.ts), so the floor has
    // to be `< CURSOR_MIN`, not `<= CURSOR_MIN`.
    const { where } = getCursor('id DESC', '0');
    expect(where).toBeDefined();
    const values = (where as unknown as { values: unknown[] }).values;
    expect(values).toContain(0);
  });
});

/**
 * REGRESSION — GAP NOW CLOSED. This block replaces a test that pinned the
 * opposite behaviour as a documented gap.
 *
 * `parseCursor` chose date-vs-numeric per token by whether the token contained
 * `-`. Every negative integer does, so `'-5'` took the DATE branch,
 * `dayjs.utc('-5')` reported VALID, and the resulting Date was bound into a
 * comparison against an `int` sort column — Postgres threw and the client got a
 * raw 500 for a malformed input. A REST query param is ALWAYS a string, so the
 * magnitude bound on `keysetCursorSchema`'s numeric members could not see it.
 *
 * Confirmed live on the paths that actually reach this helper: with a `modelId`
 * (which routes `/api/v1/images` to its legacy branch) `?cursor=-5` returned 500
 * while `?cursor=999999999999` returned 400 from the ceiling guard below — same
 * endpoint, same request shape, so the 500 is attributable to this branch and
 * not to the endpoint in general.
 *
 * 🔴 TWO LIMITS, so nobody reads this block as closing the class. (1) A bare
 * `?cursor=-5` with no legacy-triggering param does NOT reach `parseCursor` — it
 * goes to `getImagesFromFeedSearch`, which parses the cursor as its own search
 * offset; that 500 has a different cause and is untouched here. (2) Only the
 * NUMERIC spelling is closed: a token that is hyphenated but not fully numeric
 * still reaches `dayjs`, whose loose parse accepts `'0-'`, `'5-'` and `'1-2'` as
 * valid dates, so those still bind a Date to an int column. That residual is
 * pinned below.
 *
 * The discriminator is now numeric-FIRST: a fully-numeric token is range-checked
 * instead of date-parsed, so a negative one is rejected as a 400 — consistent
 * with `keysetCursorSchema` flooring its numeric members at `.gte(0)`. ISO
 * timestamps contain `-` but are not fully numeric, so they still take the date
 * branch; the controls at the end of this block pin that.
 */
describe('parseCursor (via getCursor) — negative numeric STRING token', () => {
  it('rejects a negative numeric token in the TAIL of a composite cursor → 400', () => {
    expectBadRequest(() => getCursor('createdAt DESC, id DESC', '2024-01-15|-5'));
  });

  it('rejects a negative token below int4 min via the RANGE guard, not the date guard', () => {
    // Pre-fix this value was already a 400 — but from the Invalid-Date guard, not
    // from any range check. Asserting only BAD_REQUEST here would have been a
    // test that passed for the wrong reason before and after; the message is what
    // makes it real coverage.
    let thrown: unknown;
    try {
      getCursor('id DESC', '-2147483649');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as TRPCError).message).toBe(
      'Invalid cursor: numeric value out of range "-2147483649"'
    );
  });

  it('attributes the rejection to the range guard, not some other guard', () => {
    // Message identity matters here: the mutation control for this guard is
    // "break it and watch a test fail with THIS guard's own error". A test that
    // only asserted BAD_REQUEST would still pass if a different guard fired.
    let thrown: unknown;
    try {
      getCursor('id DESC', '-5');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as TRPCError).message).toBe('Invalid cursor: numeric value out of range "-5"');
  });

  it('CONTROL: a full ISO timestamp token still parses as a Date, not a number', () => {
    // Contains `-` and is NOT fully numeric, so it must still take the date
    // branch. This is the control that proves the discriminator change is scoped
    // to negative integers.
    const { where } = getCursor('createdAt DESC, id DESC', '2024-01-15T12:00:00.000Z|2686725');
    expect(where).toBeDefined();
    const values = (where as unknown as { values: unknown[] }).values;
    const dates = values.filter((v): v is Date => v instanceof Date);
    // A composite predicate is `(a > x) OR (a = x AND b > y)`, so the head token
    // is bound more than once — assert every binding, not a count.
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => d.toISOString() === '2024-01-15T12:00:00.000Z')).toBe(true);
    expect(values).toContain(2686725);
  });

  it('CONTROL: a normal positive id still parses as a number', () => {
    const { where } = getCursor('i."id" DESC', '2686725');
    expect(where).toBeDefined();
    const values = (where as unknown as { values: unknown[] }).values;
    expect(values).toContain(2686725);
    expect(values.some((v) => v instanceof Date)).toBe(false);
  });

  it('CONTROL: a hyphenated non-numeric token is still Invalid-Date rejected, not NaN rejected', () => {
    // `'not-a-date'` has a `-` and is not fully numeric, so it keeps taking the
    // date branch — the message proves the branch, where a bare BAD_REQUEST
    // assertion would not.
    let thrown: unknown;
    try {
      getCursor('createdAt DESC, id DESC', 'not-a-date|123');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as TRPCError).message).toBe(
      'Invalid cursor: unparseable date value "not-a-date"'
    );
  });

  // SEAM. The defect was never the floor's VALUE — it was that the two spellings
  // of one cursor DISAGREED: the number `-5` was a 400 and the string `'-5'` was
  // a 500, because `keysetCursorSchema` bounds the numeric members and
  // `parseCursor` bounds the string tokens, in different files.
  //
  // So this pins the RELATIONSHIP, not either side. Both sides can stay
  // internally consistent and still drift apart; re-inlining a literal floor at
  // one site, or widening one bound without the other, fails here while every
  // single-sided test above still passes. It was red at the merge base for the
  // negative rows, so it is regression coverage and not only a guard.
  it.each([
    ['-5', -5],
    ['-1', -1],
    ['0', 0],
    ['1', 1],
    ['2686725', 2686725],
    ['2147483647', INT4_MAX],
    ['2147483648', INT4_MAX + 1],
    ['999999999999', 999999999999],
  ])('accepts/rejects %s identically as a string token and as a number', (asString, asNumber) => {
    const schemaAccepts = keysetCursorSchema.safeParse(asNumber).success;
    let parseCursorAccepts = true;
    try {
      getCursor('id DESC', asString);
    } catch {
      parseCursorAccepts = false;
    }
    expect(parseCursorAccepts).toBe(schemaAccepts);
  });

  // 🔴 DOCUMENTED OPEN RESIDUAL — these pin a KNOWN FAULT, not correct behaviour.
  //
  // The numeric-first discriminator closes the NUMERIC spelling of the
  // bind-a-Date-to-an-int-column fault. It does not close the class. A token that
  // contains `-` but is not fully numeric still reaches `dayjs.utc`, whose loose
  // parse treats all of these as valid dates, so each still binds a Date into a
  // comparison against an `int` sort column and still produces the same raw 500.
  // Confirmed live: `/api/v1/images?cursor=0-&modelId=<id>` returns 500 today.
  //
  // Closing it needs the DATE branch to require a date SHAPE (e.g. a strict
  // `dayjs(value, <formats>, true)` — `CustomParseFormat` is already loaded) and
  // to send everything else numeric. That was deliberately NOT done here: it
  // changes which tokens every caller's date branch accepts, and the formats a
  // real `CONCAT(timestamp, '|', id)` emits were not observed against a database,
  // so getting the format list wrong would turn a 500 into broken pagination —
  // a worse failure than the one being fixed.
  //
  // When that lands, these will fail. That is the point: replace them with
  // `expectBadRequest(...)` rather than deleting them.
  it.each([['0-'], ['5-'], ['1-2'], ['--5']])(
    'KNOWN GAP, pinning TODAY’S WRONG BEHAVIOUR: %s is still parsed as a DATE, not rejected',
    (token) => {
      // The instant is timezone- and format-dependent, so nothing here asserts it
      // literally — only what holds everywhere: a Date came out, and no number did.
      const { where } = getCursor('id DESC', token);
      expect(where).toBeDefined();
      const values = (where as unknown as { values: unknown[] }).values;
      const dates = values.filter((v): v is Date => v instanceof Date);
      expect(dates).toHaveLength(1);
      expect(Number.isNaN(dates[0].getTime())).toBe(false);
    }
  );

  it('CONTROL: an empty token still fails as an unparseable NUMERIC token', () => {
    // The NULL-collapse shape `'|<id>'`. It has no `-`, so it took the numeric
    // branch before and must still take it — a numeric-first discriminator that
    // routed non-numeric tokens to the date branch would silently change this
    // error's class.
    let thrown: unknown;
    try {
      getCursor('createdAt DESC, id DESC', '|2686725');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as TRPCError).message).toBe('Invalid cursor: unparseable numeric value ""');
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
