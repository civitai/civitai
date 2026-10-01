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

/**
 * 🔴 DOCUMENTED OPEN RESIDUAL — this test pins a KNOWN FAULT, not correct behaviour.
 *
 * The scalar guard above closes only the bare-number/bigint/Date shape. A
 * hand-built COMPOSITE cursor has the right token COUNT, and `parseCursor`
 * decides date-vs-numeric per token by whether the token contains `-`, so a
 * numeric head token on a date-headed sort is still bound to the TIMESTAMP
 * column and Postgres still throws `date/time field value out of range`.
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

  // 🔴 EXPECTED TO FAIL once the date/numeric discriminator is fixed — that is the
  // point, not a regression. Update this test as part of that change.
  it('KNOWN GAP, pinning TODAY’S WRONG BEHAVIOUR: a negative token is parsed as a DATE, not range-checked', () => {
    // The split is `value.includes('-')`, true of every negative integer, so `'-5'`
    // takes the date branch and `dayjs.utc('-5')` reports VALID. The resulting Date
    // binds to an `int` column — a different 500 from the overflow guarded above,
    // and one no range check here can reach. Not fixed in range: correcting the
    // discriminator retypes every token for every caller.
    //
    // The instant is TIMEZONE-DEPENDENT, so nothing below asserts it literally —
    // assert only what holds everywhere: a Date came out, and the number did not.
    const { where } = getCursor('id DESC', '-5');
    expect(where).toBeDefined();
    const values = (where as unknown as { values: unknown[] }).values;
    const dates = values.filter((v): v is Date => v instanceof Date);
    expect(dates).toHaveLength(1);
    expect(Number.isNaN(dates[0].getTime())).toBe(false);
    expect(values).not.toContain(-5);
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

/**
 * Every caller hands out the LOOKAHEAD row (`LIMIT n + 1`, then popped) as `nextCursor`, so the
 * next page's predicate must include that row. Pinned per operator because the ASC and DESC
 * halves were changed independently before (ee26de5d5e made ASC `>=`; DESC stayed `<`, which
 * with a lookahead cursor skipped a model per page on `sort=Newest` — issue #1372).
 */
describe('cursor operators — inclusive last field, strict head fields', () => {
  const NEWEST = 'mm."lastVersionAt" DESC NULLS LAST, mm."modelId" DESC';
  const OLDEST = 'mm."lastVersionAt" ASC, mm."modelId"';
  const HIGHEST_RATED = 'mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"';

  it('Newest (DESC, DESC): the split equality branch is `<=` on modelId, the tuple branch stays `<`', () => {
    const { strict, equality, splittable } = getCursorClauses(NEWEST, '2024-01-15|100');
    expect(splittable).toBe(true);
    expect(equality?.sql).toBe('(mm."lastVersionAt" = ? AND mm."modelId" <= ?)');
    expect(strict?.sql).toBe('((mm."lastVersionAt") < (?))');
  });

  it('Newest via the legacy getCursor: same inclusive tail', () => {
    const { where } = getCursor(NEWEST, '2024-01-15|100');
    expect(where?.sql).toBe(
      '((mm."lastVersionAt" < ?) OR (mm."lastVersionAt" = ? AND mm."modelId" <= ?))'
    );
  });

  it('single-field DESC (RecentlyAdded `ci."id"`, image feed `i."id"`): `<=`', () => {
    expect(getCursor('ci."id" DESC', 100).where?.sql).toBe('((ci."id" <= ?))');
    expect(getCursor('i."id" DESC', 100).where?.sql).toBe('((i."id" <= ?))');
    expect(getCursorClauses('i."id" DESC', 100).strict?.sql).toBe('((i."id" <= ?))');
  });

  it('CONTROL — ASC-tailed metric sorts are unchanged: heads `<`, tail `>=`', () => {
    const { where } = getCursor(HIGHEST_RATED, '5|7|100');
    expect(where?.sql).toBe(
      '((mm."thumbsUpCount" < ?) OR (mm."thumbsUpCount" = ? AND mm."downloadCount" < ?) OR (mm."thumbsUpCount" = ? AND mm."downloadCount" = ? AND mm."modelId" >= ?))'
    );
    const { equality, strict } = getCursorClauses(HIGHEST_RATED, '5|7|100');
    expect(equality?.sql).toBe(
      '(mm."thumbsUpCount" = ? AND mm."downloadCount" = ? AND mm."modelId" >= ?)'
    );
    expect(strict?.sql).toBe('((mm."thumbsUpCount", mm."downloadCount") < (?, ?))');
  });

  it('CONTROL — single-field ASC is unchanged: `>=`', () => {
    expect(getCursor('i."id" ASC', 100).where?.sql).toBe('((i."id" >= ?))');
  });

  it('Oldest (ASC, ASC): the head field is strict, so rows tied on it are not re-emitted', () => {
    const { where } = getCursor(OLDEST, '2024-01-15|100');
    expect(where?.sql).toBe(
      '((mm."lastVersionAt" > ?) OR (mm."lastVersionAt" = ? AND mm."modelId" >= ?))'
    );
    expect(getCursorClauses(OLDEST, '2024-01-15|100').splittable).toBe(false);
  });
});

/**
 * `walk` is capped at rows + 2 pages: an inclusive head operator makes the cursor cycle, and an
 * uncapped walk would hang the runner instead of failing on the page count.
 */
describe('keyset paging round-trip — no row skipped, no row repeated', () => {
  type Row = Record<string, number | Date>;
  type Tok =
    | { t: 'lp' }
    | { t: 'rp' }
    | { t: 'comma' }
    | { t: 'op'; v: string }
    | { t: 'and' }
    | { t: 'or' }
    | { t: 'ident'; v: string }
    | { t: 'val'; v: unknown };

  function tokenize(sql: string, values: unknown[]): Tok[] {
    const out: Tok[] = [];
    let vi = 0;
    let i = 0;
    while (i < sql.length) {
      const c = sql[i];
      if (c === ' ') i++;
      else if (c === '(') out.push({ t: 'lp' }), i++;
      else if (c === ')') out.push({ t: 'rp' }), i++;
      else if (c === ',') out.push({ t: 'comma' }), i++;
      else if (c === '?') out.push({ t: 'val', v: values[vi++] }), i++;
      else if (/[<>=]/.test(c)) {
        const two = sql.slice(i, i + 2);
        if (two === '<=' || two === '>=') out.push({ t: 'op', v: two }), (i += 2);
        else out.push({ t: 'op', v: c }), i++;
      } else if (sql.startsWith('AND', i)) out.push({ t: 'and' }), (i += 3);
      else if (sql.startsWith('OR', i)) out.push({ t: 'or' }), (i += 2);
      else {
        let j = i;
        while (j < sql.length && !/[ (),<>=]/.test(sql[j])) j++;
        out.push({ t: 'ident', v: sql.slice(i, j) });
        i = j;
      }
    }
    return out;
  }

  const num = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
  const cmp = (a: unknown, b: unknown) => Math.sign(num(a) - num(b));
  const cmpTuple = (a: unknown[], b: unknown[]) => {
    for (let i = 0; i < a.length; i++) {
      const c = cmp(a[i], b[i]);
      if (c !== 0) return c;
    }
    return 0;
  };
  const apply = (op: string, c: number) =>
    op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0;

  /** OR-of-ANDs over comparisons; an operand is an identifier, a bound value, or a tuple of them. */
  function evaluate(sql: string, values: unknown[], row: Row): boolean {
    const toks = tokenize(sql, values);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const operandValue = (t: Tok): unknown => {
      if (t.t === 'ident') {
        if (!(t.v in row)) throw new Error(`fixture has no column ${t.v}`);
        return row[t.v];
      }
      if (t.t === 'val') return t.v;
      throw new Error(`unexpected token ${JSON.stringify(t)}`);
    };
    const operand = (): unknown[] => {
      if (peek().t === 'lp') {
        next();
        const items = [operandValue(next())];
        while (peek().t === 'comma') next(), items.push(operandValue(next()));
        if (next().t !== 'rp') throw new Error('unterminated tuple');
        return items;
      }
      return [operandValue(next())];
    };
    const tryComparison = (): boolean | undefined => {
      const save = p;
      try {
        const left = operand();
        const op = next();
        if (op.t !== 'op') throw new Error('not a comparison');
        const right = operand();
        return apply(op.v, cmpTuple(left, right));
      } catch {
        p = save;
        return undefined;
      }
    };
    const expr = (): boolean => {
      let v = term();
      while (peek()?.t === 'or') next(), (v = term() || v);
      return v;
    };
    const term = (): boolean => {
      let v = factor();
      while (peek()?.t === 'and') next(), (v = factor() && v);
      return v;
    };
    const factor = (): boolean => {
      const asComparison = tryComparison();
      if (asComparison !== undefined) return asComparison;
      if (next().t !== 'lp') throw new Error('expected (');
      const v = expr();
      if (next().t !== 'rp') throw new Error('expected )');
      return v;
    };
    const result = expr();
    if (p !== toks.length) throw new Error(`trailing tokens at ${p}`);
    return result;
  }

  function sortRows(sortString: string, rows: Row[]) {
    const fields = sortString.split(',').map((part) => {
      const [field, order = 'ASC'] = part.trim().split(' ').filter(Boolean);
      return { field, desc: order.toUpperCase() === 'DESC' };
    });
    return [...rows].sort((a, b) => {
      for (const { field, desc } of fields) {
        const c = cmp(a[field], b[field]);
        if (c !== 0) return desc ? -c : c;
      }
      return 0;
    });
  }

  /** What `CONCAT(col, '|', …)` yields, in the shape `parseCursor` reads back. */
  function cursorFor(sortString: string, row: Row) {
    const fields = sortString.split(',').map((part) => part.trim().split(' ')[0]);
    const render = (v: number | Date) => (v instanceof Date ? v.toISOString() : String(v));
    return fields.length === 1 ? row[fields[0]] : fields.map((f) => render(row[f])).join('|');
  }

  function walk(
    sortString: string,
    rows: Row[],
    pageSize: number,
    build: (cursor: string | number | Date | undefined) => { sql: string; values: unknown[] }[]
  ) {
    const sorted = sortRows(sortString, rows);
    const seen: number[] = [];
    let cursor: string | number | Date | undefined;
    let pages = 0;
    const cap = rows.length + 2;
    do {
      pages++;
      const clauses = build(cursor);
      const matching = clauses.length
        ? sorted.filter((row) => clauses.some((c) => evaluate(c.sql, c.values, row)))
        : sorted;
      const page = matching.slice(0, pageSize + 1);
      seen.push(...page.slice(0, pageSize).map((r) => r.id as number));
      cursor = page.length > pageSize ? cursorFor(sortString, page[pageSize]) : undefined;
    } while (cursor !== undefined && pages < cap);
    expect(pages, 'walk did not terminate on its own').toBeLessThan(cap);
    return { seen, expected: sorted.map((r) => r.id as number), pages };
  }

  const viaGetCursor = (sortString: string) => (cursor: Parameters<typeof getCursor>[1]) => {
    const { where } = getCursor(sortString, cursor);
    return where ? [where] : [];
  };
  const viaGetCursorClauses =
    (sortString: string) => (cursor: Parameters<typeof getCursorClauses>[1]) => {
      const { strict, equality } = getCursorClauses(sortString, cursor);
      return [strict, equality].filter((c): c is NonNullable<typeof c> => !!c);
    };

  const day = (n: number) => new Date(Date.UTC(2024, 0, n));
  // Three-way head-field tie so that, across pageSize 2 and 3, a boundary falls inside a tie
  // (cursor row with tie-mates after it), at the end of a tie, and between distinct heads.
  const NEWEST = 'mm."lastVersionAt" DESC NULLS LAST, mm."modelId" DESC';
  const newestRows: Row[] = [
    { id: 1, 'mm."lastVersionAt"': day(9), 'mm."modelId"': 1 },
    { id: 2, 'mm."lastVersionAt"': day(8), 'mm."modelId"': 2 },
    { id: 3, 'mm."lastVersionAt"': day(8), 'mm."modelId"': 3 },
    { id: 4, 'mm."lastVersionAt"': day(8), 'mm."modelId"': 4 },
    { id: 5, 'mm."lastVersionAt"': day(7), 'mm."modelId"': 5 },
    { id: 6, 'mm."lastVersionAt"': day(6), 'mm."modelId"': 6 },
    { id: 7, 'mm."lastVersionAt"': day(6), 'mm."modelId"': 7 },
    { id: 8, 'mm."lastVersionAt"': day(5), 'mm."modelId"': 8 },
    { id: 9, 'mm."lastVersionAt"': day(4), 'mm."modelId"': 9 },
    { id: 10, 'mm."lastVersionAt"': day(4), 'mm."modelId"': 10 },
    { id: 11, 'mm."lastVersionAt"': day(3), 'mm."modelId"': 11 },
  ];

  it('Newest through getCursorClauses (the getModelsRaw path)', () => {
    const { seen, expected } = walk(NEWEST, newestRows, 3, viaGetCursorClauses(NEWEST));
    expect(seen).toEqual(expected);
  });

  it('Newest at pageSize 2: the boundary lands inside the tie, with tie-mates after the cursor row', () => {
    const { seen, expected } = walk(NEWEST, newestRows, 2, viaGetCursorClauses(NEWEST));
    expect(seen).toEqual(expected);
    expect(walk(NEWEST, newestRows, 2, viaGetCursor(NEWEST)).seen).toEqual(expected);
  });

  it('Newest through the legacy getCursor', () => {
    const { seen, expected } = walk(NEWEST, newestRows, 3, viaGetCursor(NEWEST));
    expect(seen).toEqual(expected);
  });

  it('Oldest (ASC, ASC) with ties on the head field', () => {
    const OLDEST = 'mm."lastVersionAt" ASC, mm."modelId"';
    const { seen, expected } = walk(OLDEST, newestRows, 3, viaGetCursor(OLDEST));
    expect(seen).toEqual(expected);
  });

  it('HighestRated (DESC, DESC, ASC) with ties on both head fields', () => {
    const HR = 'mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"';
    const rows: Row[] = [
      { id: 1, 'mm."thumbsUpCount"': 9, 'mm."downloadCount"': 5, 'mm."modelId"': 1 },
      { id: 2, 'mm."thumbsUpCount"': 9, 'mm."downloadCount"': 5, 'mm."modelId"': 2 },
      { id: 3, 'mm."thumbsUpCount"': 9, 'mm."downloadCount"': 5, 'mm."modelId"': 3 },
      { id: 4, 'mm."thumbsUpCount"': 9, 'mm."downloadCount"': 4, 'mm."modelId"': 4 },
      { id: 5, 'mm."thumbsUpCount"': 8, 'mm."downloadCount"': 9, 'mm."modelId"': 5 },
      { id: 6, 'mm."thumbsUpCount"': 8, 'mm."downloadCount"': 9, 'mm."modelId"': 6 },
      { id: 7, 'mm."thumbsUpCount"': 8, 'mm."downloadCount"': 1, 'mm."modelId"': 7 },
      { id: 8, 'mm."thumbsUpCount"': 2, 'mm."downloadCount"': 1, 'mm."modelId"': 8 },
    ];
    expect(walk(HR, rows, 3, viaGetCursorClauses(HR)).seen).toEqual(
      sortRows(HR, rows).map((r) => r.id)
    );
    expect(walk(HR, rows, 3, viaGetCursor(HR)).seen).toEqual(sortRows(HR, rows).map((r) => r.id));
  });

  it('single-field DESC (RecentlyAdded, image feed) and single-field ASC', () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, 'i."id"': i + 1 }));
    expect(walk('i."id" DESC', rows, 4, viaGetCursor('i."id" DESC')).seen).toEqual([
      10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
    ]);
    expect(walk('i."id" ASC', rows, 4, viaGetCursor('i."id" ASC')).seen).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});
