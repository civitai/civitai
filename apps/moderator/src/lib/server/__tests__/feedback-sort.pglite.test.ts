import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEEDBACK_SORT_COLUMNS,
  FEEDBACK_SORT_DIRECTIONS,
  type FeedbackSortColumn,
} from '$lib/feedback-sort';
import {
  feedbackKysely,
  freshFeedbackDb,
  seedBug,
  seedFeedback,
  seedUser,
} from './feedback-pglite.harness';

/**
 * The COMPOUND KEYSET, executed against a real Postgres carrying the real migrations.
 *
 * 🔴 THIS SUITE EXISTS BECAUSE THE DEFECT IT HUNTS IS INVISIBLE ON EVERY REAL QUERY. The page is
 * keyset-paged at `FEEDBACK_PAGE_SIZE = 50` against 26 live rows, so production NEVER CROSSES A PAGE
 * BOUNDARY — a keyset that repeats or skips rows at a boundary returns a perfect-looking first page
 * for every filter anyone can type. So the boundary is MANUFACTURED here: more rows than a page
 * holds, with heavy TIES on every sort column, paged all the way through, asserting that the union
 * of the pages is the whole set with each row exactly once.
 *
 * 🔴 AND THE ORDER IS ASSERTED, not just the membership. A keyset can be total and still wrong —
 * returning every row in an order that is not the one the ORDER BY asked for — so the expectation is
 * computed in JS from the seeded values and the documented contract (`<column> <dir> NULLS LAST`,
 * then `id DESC`), never read back off the query.
 *
 * ⚠️ The fixture's text values are lowercase ASCII on purpose: JS compares by UTF-16 code unit and
 * Postgres by collation, and those two agree on that alphabet and NOT in general. A fixture carrying
 * accents or mixed case would make this file a test of collation rather than of paging.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const service = await import('../feedback.service');

/**
 * Enough rows to overflow a real page, with cycle lengths chosen so that no two columns partition
 * the set the same way (3 areas, 4 statuses, 5 reporters, every 3rd row unhandled, every 7th
 * unlinked).
 *
 * 🔴 WHAT MATTERS IS THAT A PAGE EDGE LANDS INSIDE A TIE GROUP, not outside one. A boundary that
 * falls exactly on a group edge never exercises the `(col = cursor AND id < cursorId)` arm, so a
 * fixture whose groups line up with the page could leave that arm unreachable while every assertion
 * passes. The group sizes this seed loop actually produces, in SORTED order, counted rather than
 * argued:
 *
 *     age      1 × 60          area   20 / 20 / 20      user    12 × 5
 *     status   15 × 4          handled 20 / 20 / 20     issue   26 / 25 / 9
 *
 * At a page size of 7 every cut on the five non-`age` columns is strictly inside a group. At 50 the
 * single cut is inside a group on all five as well (the smallest group that spans row 50 is
 * `issue`'s 25-wide middle block). ⚠️ `age` IS THE EXCEPTION AND IT IS BENIGN: its groups are
 * singletons, so every cut lands on a group edge and the tie arm is never exercised — which costs
 * nothing, because for `age` the sort `ref` IS `f.id`, the tie-break column, so that arm is
 * structurally dead rather than merely unvisited.
 *
 * ⚠️ TWO EARLIER VERSIONS OF THIS PARAGRAPH CARRIED FALSE NUMBERS, which is why this one carries
 * measured ones. The first claimed "none of the cycle lengths divides PAGE" — false for the pair it
 * mattered for (the `issue` cycle is 7 and one page size is 7; 3, 4 and 5 also divide `ROWS`) and
 * the wrong property besides, since the cycles run in INSERTION order and the pages are cut in
 * SORTED order. The second claimed "every group is 12–20 rows wide … far wider than either page
 * size … inside a group in every ordering", which is wrong for `issue` (26 and 9), wrong against a
 * page size of 50 (the widest group is 26), and wrong for `age` outright. The
 * `seeds more rows than a page holds` case below measures the property that is actually load-bearing
 * rather than arguing for it.
 */
const ROWS = 60;
const AREAS = ['alpha', 'bravo', 'charlie'];
const STATUSES = ['new', 'reviewed', 'actioned', 'dismissed'];
/**
 * 🔴 ONE REPORTER HAS NO USERNAME, and it is not decoration. `User.username` is nullable and the
 * join is a LEFT one, so `u.username` HAS a null block on the real table — a fixture where every
 * reporter is named leaves that block EMPTY, and every assertion about how the `user` sort places
 * nulls then passes over zero rows. The entry is `null`, not `''`: those are different positions in
 * the ordering and the whole point of this column is which one the keyset lands on.
 */
const REPORTERS: (string | null)[] = ['ada', 'grace', null, 'karen', 'radia'];

/**
 * 🔴 EVERY ROW GETS ITS OWN ARRIVAL TIME, INCREASING WITH THE ID. The default fixture timestamp made
 * every row the SAME AGE, so the one thing the `age` sort is about — the duration the cell renders —
 * was constant across the whole set and any claim about it passed vacuously. This also models the
 * invariant the service's key rests on: `Feedback` is insert-only, so id order IS arrival order.
 */
const FIRST_ARRIVAL = Date.UTC(2026, 6, 1);
const arrivalOf = (i: number) => new Date(FIRST_ARRIVAL + i * 60_000).toISOString();

type Seeded = {
  id: number;
  arrival: number;
  area: string;
  status: string;
  username: string | null;
  handledByUsername: string | null;
  bugId: number | null;
};

let db: PGlite;
let seeded: Seeded[];

beforeEach(async () => {
  db = await freshFeedbackDb();
  dbHandle.current = feedbackKysely(db);

  // Keyed by INDEX rather than by name, so the unnamed reporter has a key at all.
  const reporterIds: number[] = [];
  for (const name of REPORTERS) reporterIds.push(await seedUser(db, name));
  // Two handlers and two issues, so BOTH nullable sort columns carry ties AND nulls.
  const handlers = ['mira', 'quinn'];
  const handlerIds = new Map<string, number>();
  for (const name of handlers) handlerIds.set(name, await seedUser(db, name));
  const bugs = [await seedBug(db, 'the first issue'), await seedBug(db, 'the second issue')];

  seeded = [];
  for (let i = 0; i < ROWS; i++) {
    const area = AREAS[i % AREAS.length];
    const status = STATUSES[i % STATUSES.length];
    const username = REPORTERS[i % REPORTERS.length];
    // Every 3rd row is unhandled and every 7th has no issue — the null blocks both sorts must place.
    const handledByUsername = i % 3 === 0 ? null : handlers[i % handlers.length];
    const bugId = i % 7 === 0 ? null : bugs[i % bugs.length];

    const id = await seedFeedback(db, {
      userId: reporterIds[i % REPORTERS.length],
      area,
      status,
      createdAt: arrivalOf(i),
      handledById: handledByUsername === null ? null : handlerIds.get(handledByUsername)!,
      bugId,
    });
    seeded.push({
      id,
      arrival: FIRST_ARRIVAL + i * 60_000,
      area,
      status,
      username,
      handledByUsername,
      bugId,
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  dbHandle.current = null;
  await db.close();
});

/**
 * The value the SQL is ORDERING BY, read off the SEEDED fixture rather than off a returned row.
 *
 * 🔴 `age` IS THE ARRIVAL TIME, NOT THE RENDERED DURATION, AND THE SIGN MOVED HERE FOR A REASON.
 * The direction token is now the SQL direction on every column without exception — the service
 * carries no `invert` flag any more, and the one place the Age CELL's opposite reading exists is
 * `READS_INVERTED` in `$lib/feedback-sort.ts`, where it reaches a glyph and an ARIA token and
 * nothing else. So this helper expresses the KEY, and the claim about what is on screen is made
 * where it can be observed: `feedback-sort.test.ts` asserts the arrow and `aria-sort`, and
 * `has ONE sorted state on age` below asserts the arrival order against the seeded timestamps.
 *
 * Arrival rather than `row.id` even so: the two agree here (the table is insert-only), and writing
 * the id would make the expectation a restatement of whichever key the implementation picked.
 */
const valueOf = (row: Seeded, column: FeedbackSortColumn): string | number | null => {
  switch (column) {
    case 'age':
      return row.arrival;
    case 'area':
      return row.area;
    case 'user':
      return row.username;
    case 'status':
      return row.status;
    case 'handled':
      return row.handledByUsername;
    case 'issue':
      return row.bugId;
  }
};

/** `<column> <direction> NULLS LAST, id DESC` — the contract, expressed independently of the query. */
const expectedOrder = (column: FeedbackSortColumn, direction: 'asc' | 'desc'): number[] =>
  [...seeded]
    .sort((a, b) => {
      const av = valueOf(a, column);
      const bv = valueOf(b, column);
      if (av !== null && bv === null) return -1;
      if (av === null && bv !== null) return 1;
      if (av !== null && bv !== null && av !== bv) {
        const ascending = av < bv ? -1 : 1;
        return direction === 'asc' ? ascending : -ascending;
      }
      return b.id - a.id;
    })
    .map((r) => r.id);

/**
 * Every page, followed to the end, as one flat list of ids.
 *
 * 🔴 ONE LOOP, AND `area` IS AN ARGUMENT RATHER THAN A SECOND COPY. A near-duplicate of this
 * function existed for the filtered case and had already drifted — a different termination guard
 * with a different message, and no page count — which is how one of two copies quietly stops
 * terminating. This helper is what decides whether a keyset defect is OBSERVABLE at all, so it is
 * the last thing that should exist twice.
 */
async function pageThrough(
  column: FeedbackSortColumn | null,
  direction: 'asc' | 'desc',
  limit: number,
  area?: string
): Promise<{ ids: number[]; pages: number }> {
  const ids: number[] = [];
  let cursor: number | null = null;
  let cursorValue: string | null = null;
  let pages = 0;

  for (;;) {
    const page = await service.getFeedbackList({
      statuses: [],
      area,
      cursor,
      cursorValue,
      sort: column ? { column, direction } : null,
      limit,
    });
    pages++;
    ids.push(...page.items.map((r) => r.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    cursorValue = page.nextCursorValue;
    // A keyset that never advances would otherwise spin forever and report as a timeout rather than
    // as the defect it is.
    if (pages > ROWS) throw new Error(`paging did not terminate after ${pages} pages`);
  }

  return { ids, pages };
}

/**
 * The three claims every full page-through has to satisfy, asserted once.
 *
 * Two different defects, two different messages — and each assertion measures the ONE it names. A
 * bare `new Set(ids).size === ROWS` reports a repeat and a skip identically; a bare
 * `ids.length === ROWS` reports "80 where 60 expected" for a repeat and "51 where 60 expected" for a
 * truncation, under whichever name it was given. The DIFFERENCE between the two counts is
 * duplication and nothing else; the set SIZE is completeness and nothing else.
 */
function expectWholeSetInOrder(
  ids: number[],
  column: FeedbackSortColumn,
  direction: 'asc' | 'desc'
) {
  expect(
    ids.length - new Set(ids).size,
    `${column} ${direction} returned the same row on two pages`
  ).toBe(0);
  expect(new Set(ids).size, `${column} ${direction} lost a row at a page boundary`).toBe(ROWS);
  expect(ids, `${column} ${direction} returned the rows in the wrong order`).toEqual(
    expectedOrder(column, direction)
  );
}

describe('the compound keyset, across a manufactured page boundary', () => {
  /**
   * 🔴 THE INSTRUMENT, FIRST. Everything below asserts a property of a 60-row set paged in slices;
   * a fixture that silently seeded fewer rows than a page holds would make every one of them pass
   * without ever crossing a boundary — the exact blindness this file exists to remove.
   */
  it('seeds more rows than a page holds, with ties and nulls on every sortable column', async () => {
    expect(seeded).toHaveLength(ROWS);
    expect(ROWS).toBeGreaterThan(service.FEEDBACK_PAGE_SIZE);

    for (const column of FEEDBACK_SORT_COLUMNS) {
      const values = seeded.map((r) => valueOf(r, column));
      const distinct = new Set(values.map(String));
      if (column === 'age') {
        // The id is unique BY CONSTRUCTION — it is the tie-break, so it must not tie.
        expect(distinct.size).toBe(ROWS);
      } else {
        // Ties, and enough of them that a boundary cannot help but land on one.
        expect(distinct.size, `${column} has no ties to break`).toBeLessThan(ROWS / 2);
      }
    }
    // Both nullable columns actually carry nulls, or their null branch is never executed.
    expect(seeded.filter((r) => r.handledByUsername === null).length).toBeGreaterThan(0);
    expect(seeded.filter((r) => r.bugId === null).length).toBeGreaterThan(0);
  });

  /**
   * 🔴 THE CASE PRODUCTION CANNOT REACH. 60 rows at the REAL page size crosses exactly one boundary
   * — the shape this queue will have the day it passes 50 rows, and the one nothing today can
   * observe.
   */
  it('returns every row exactly once at the REAL page size, on every column and direction', async () => {
    for (const column of FEEDBACK_SORT_COLUMNS) {
      for (const direction of FEEDBACK_SORT_DIRECTIONS[column]) {
        const { ids, pages } = await pageThrough(column, direction, service.FEEDBACK_PAGE_SIZE);

        expect(pages, `${column} ${direction} never crossed a page boundary`).toBeGreaterThan(1);
        expectWholeSetInOrder(ids, column, direction);
      }
    }
  });

  /**
   * The same property with the boundary walked EIGHT more times per run. A single boundary can be
   * crossed correctly by luck — it lands on one particular pair of values — and this does not let it.
   */
  it('survives a boundary every seven rows, on every column and direction', async () => {
    for (const column of FEEDBACK_SORT_COLUMNS) {
      for (const direction of FEEDBACK_SORT_DIRECTIONS[column]) {
        const { ids, pages } = await pageThrough(column, direction, 7);

        expect(pages, `${column} ${direction} paged in one shot`).toBeGreaterThan(8);
        expectWholeSetInOrder(ids, column, direction);
      }
    }
  });

  /**
   * 🔴 THE NULL BLOCK IS CROSSED, not just present. A page boundary that falls INSIDE the trailing
   * null block is the case the `cursorValue === null` branch of the keyset exists for, and the one a
   * predicate written only for non-null boundaries gets wrong — it compares against NULL, which is
   * neither true nor false, and silently returns nothing.
   */
  it('pages THROUGH the trailing null block rather than stopping at it', async () => {
    const unhandled = seeded.filter((r) => r.handledByUsername === null).map((r) => r.id);
    expect(unhandled.length).toBeGreaterThan(2);

    // A page size of 1 puts a boundary between every pair of rows, the null block included.
    const { ids } = await pageThrough('handled', 'asc', 1);
    expect(ids).toEqual(expectedOrder('handled', 'asc'));
    // The nulls are last and all of them are there.
    expect(ids.slice(-unhandled.length).sort((a, b) => a - b)).toEqual(
      [...unhandled].sort((a, b) => a - b)
    );
  });

  /**
   * 🔴 `age` HAS ONE SORTED STATE AND IT IS THE OLDEST REPORT FIRST — the one view the default
   * ordering cannot express, and the reason this column survived the collapse at all.
   *
   * 🔴 THE STATE THAT WAS REMOVED IS WHAT THIS TEST IS REALLY ABOUT, so it asserts the NEGATIVE too.
   * `age` sorts on `f.id` and the default ordering is `f.id DESC`, so "youngest first" was
   * byte-identical to no sort: the header cycled through a state that moved not one row, and the
   * `age`/no-op arm of the two big `pageThrough` loops above could not distinguish "the sort was
   * applied" from "the sort was ignored". Pinning `sorted ≠ unsorted` here is what keeps a future
   * edit from quietly reinstating a sort that does nothing.
   *
   * Asserted against the ARRIVAL TIMES the fixture seeded rather than against the id, so it is a
   * claim about when the reports came in rather than a restatement of the key the implementation
   * chose. How that order READS on screen — `↓`, `aria-sort="descending"`, because the cell renders
   * a duration — is asserted in `feedback-sort.test.ts`, where a glyph can be observed.
   */
  it('has ONE sorted state on age, and it is the oldest report first', async () => {
    const oldestFirst = [...seeded].sort((a, b) => a.arrival - b.arrival).map((r) => r.id);
    const newestFirst = [...oldestFirst].reverse();
    // The instrument: distinct arrival times, or neither claim can be observed.
    expect(new Set(seeded.map((r) => r.arrival)).size).toBe(ROWS);
    expect(FEEDBACK_SORT_DIRECTIONS.age).toEqual(['asc']);

    const { ids } = await pageThrough('age', 'asc', 7);
    expect(ids, 'the age sort did not put the oldest report first').toEqual(oldestFirst);

    // 🔴 AND IT IS NOT THE ORDERING THE PAGE ALREADY HAD — the whole defect the collapse removed.
    expect(ids, 'the age sort returned the default ordering').not.toEqual(newestFirst);
    const unsorted = await pageThrough(null, 'asc', 7);
    expect(unsorted.ids, 'the default ordering is not newest-first').toEqual(newestFirst);
  });

  /** The default ordering is untouched: no sort, no value half, same `id DESC` keyset as before. */
  it('leaves the default ordering exactly as it was', async () => {
    const { ids } = await pageThrough(null, 'asc', 7);

    expect(ids).toEqual([...seeded].map((r) => r.id).sort((a, b) => b - a));
    const first = await service.getFeedbackList({ statuses: [], limit: 7 });
    expect(first.nextCursorValue).toBeNull();
  });

  it('sorts the FILTERED set, not the whole table', async () => {
    const expected = seeded
      .filter((r) => r.area === 'bravo')
      .sort((a, b) => (a.status === b.status ? b.id - a.id : a.status < b.status ? -1 : 1))
      .map((r) => r.id);
    expect(expected.length).toBeGreaterThan(0);

    const { ids } = await pageThrough('status', 'asc', 5, 'bravo');
    expect(ids).toEqual(expected);
  });
});

describe('what the query builder refuses', () => {
  /**
   * 🔴 THE SECOND REFUSAL, AND IT THROWS WHERE THE FIRST DEGRADES. `parseFeedbackSort` is the first,
   * and it is a URL parser: its input is typed by whoever is holding the keyboard, so a hostile
   * `?sort=` has to degrade rather than 500 a queue nobody can then open. A caller that is not a URL
   * — a script, an internal API, a new route — never goes through it, and at THIS layer the value is
   * an argument, so an unknown column is a programming error.
   *
   * 🔴 IT USED TO FALL BACK TO THE DEFAULT ORDERING, AND THAT WAS THE SAME SHAPE THIS PAGE REFUSES
   * ON THE CLIENT. A silent degradation returns A PAGE OF REAL ROWS IN AN ORDERING THE CALLER DID
   * NOT ASK FOR, WITH NO SIGNAL — indistinguishable from a working sort for anyone reading the
   * result, exactly as a `.sort()` over one loaded page is indistinguishable from a real ordering of
   * the queue. The fallback was also unpinnable: the mutant that removed the guard died on a
   * `TypeError` out of the map read before any fallback assertion could be reached, so the advertised
   * behaviour had no test that observed it. Throwing removes the claim and the mutant's escape.
   *
   * The parameter is union-typed and the one production caller pre-validates, so these cases have to
   * CAST to reach the guard at all — which is the point: nothing that compiles can get here.
   */
  it('THROWS for a column that is not on its map, rather than quietly reordering', async () => {
    /**
     * 🔴 THE PROTOTYPE KEYS ARE NOT PADDING. The refusal's reachability clause indexes an object
     * literal with this value, and `FEEDBACK_SORT_DIRECTIONS['__proto__']` is `Object.prototype`
     * while `['toString']` is a function — neither has `.includes`. A guard whose allowlist check
     * stopped short-circuiting would answer these with a `TypeError` instead of the refusal, which
     * `toBeInstanceOf` distinguishes and a bare `rejects.toThrow()` would not.
     */
    for (const hostile of [
      'attachments',
      'f.area',
      'createdAt',
      '1; drop table "Feedback"',
      '',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      await expect(
        service.getFeedbackList({
          statuses: [],
          sort: { column: hostile as FeedbackSortColumn, direction: 'asc' },
          limit: ROWS,
        }),
        `"${hostile}" did not throw`
      ).rejects.toBeInstanceOf(service.InvalidFeedbackSort);
    }

    // 🔴 POSITIVE CONTROL. Every assertion above is a rejection, and a call shape that ALWAYS
    // rejected would satisfy all of them — including one broken well before the guard. A real column
    // on the identical shape resolves, and resolves to the ordering it names.
    const real = await service.getFeedbackList({
      statuses: [],
      sort: { column: 'area', direction: 'asc' },
      limit: ROWS,
    });
    expect(real.items.map((r) => r.id)).toEqual(expectedOrder('area', 'asc'));
  });

  /**
   * 🔴 THE DIRECTION IS THE SECOND UNTRUSTED FIELD, AND IT IS REFUSED HERE TOO. It never reaches SQL
   * as text — it selects between two literal branches — so the failure it causes is quieter: a
   * garbage value silently means `desc` at both branches, and the caller is handed a descending
   * queue having asked for something else.
   */
  it('THROWS for a direction that is not asc or desc', async () => {
    for (const hostile of ['sideways', 'DESC', '', 'asc; --']) {
      await expect(
        service.getFeedbackList({
          statuses: [],
          sort: { column: 'area', direction: hostile as 'asc' },
          limit: ROWS,
        }),
        `"${hostile}" was accepted as a direction`
      ).rejects.toBeInstanceOf(service.InvalidFeedbackSort);
    }

    // Positive control, as above: both real directions on the same column resolve, and to two
    // DIFFERENT orderings — so the rejections are about the value and not about the call.
    for (const direction of ['asc', 'desc'] as const) {
      const real = await service.getFeedbackList({
        statuses: [],
        sort: { column: 'area', direction },
        limit: ROWS,
      });
      expect(real.items.map((r) => r.id)).toEqual(expectedOrder('area', direction));
    }
    expect(expectedOrder('area', 'asc')).not.toEqual(expectedOrder('area', 'desc'));
  });

  /**
   * 🔴 A DIRECTION THE COLUMN DOES NOT OFFER IS REFUSED TOO, AND `age desc` IS THE WHOLE REASON THIS
   * CHECK EXISTS. It is a well-formed `FeedbackSortDirection` on a column that is on the map, so the
   * two checks above both pass it — and it orders `f.id DESC`, which IS the default ordering, so
   * serving it would put an arrow over rows that did not move. That is the state the header collapse
   * removed; refusing it here is what stops a programmatic caller reintroducing it below the URL.
   *
   * ⚠️ Nothing in the type system says this: `FeedbackSort` offers `'asc' | 'desc'` for every column,
   * so `{ column: 'age', direction: 'desc' }` TYPE-CHECKS CLEANLY and is refused only at runtime.
   * There is no cast on this case, which is what proves it.
   */
  it('THROWS for a direction the column does not offer, not only for a malformed one', async () => {
    await expect(
      service.getFeedbackList({
        statuses: [],
        sort: { column: 'age', direction: 'desc' },
        limit: ROWS,
      }),
      'age accepted the state the two-state collapse removed'
    ).rejects.toBeInstanceOf(service.InvalidFeedbackSort);

    // Two controls, and they isolate different halves. `age` in the direction it DOES offer
    // resolves, so the refusal is not about the column; `desc` one column over resolves, so it is
    // not about the word. Only the PAIR is refused.
    expect(
      (
        await service.getFeedbackList({
          statuses: [],
          sort: { column: 'age', direction: 'asc' },
          limit: ROWS,
        })
      ).items
    ).toHaveLength(ROWS);
    expect(
      (
        await service.getFeedbackList({
          statuses: [],
          sort: { column: 'area', direction: 'desc' },
          limit: ROWS,
        })
      ).items
    ).toHaveLength(ROWS);
  });

  /**
   * 🔴 A VALUE HALF THE COLUMN CANNOT HOLD DROPS THE WHOLE CURSOR, and page one is the right answer.
   * Keeping the id half alone would compare `f.id` against a boundary belonging to a different
   * ordering and return rows that are neither the first page nor the next one.
   *
   * `2147483648` is one past the int4 bound, which ERRORS the comparison in Postgres rather than
   * missing it — so a version that passed it through would fail this test by throwing, not by
   * returning the wrong rows.
   *
   * ⚠️ TWO CASES, NOT ONE LOOP, BECAUSE THE TWO CLASSES FAIL DIFFERENTLY AND ONE MASKS THE OTHER. A
   * value Postgres REJECTS makes a broken version THROW; a value `Number` silently mangles makes it
   * return the wrong rows. Run together, the throw lands first and the mangled inputs are never
   * reached — a mutant that re-opens the mangling defect dies on the neighbour's case, which is not
   * evidence about the guard under test. Measured, not reasoned about.
   */
  /** Page one of the `issue` ordering — what "the whole cursor was dropped" looks like. */
  const issueFirstPage = async (direction: 'asc' | 'desc') =>
    (
      await service.getFeedbackList({
        statuses: [],
        sort: { column: 'issue', direction },
        limit: 9,
      })
    ).items.map((r) => r.id);

  it('starts over rather than mis-paging on a value PostgreSQL would reject', async () => {
    for (const direction of ['asc', 'desc'] as const) {
      const firstPage = await issueFirstPage(direction);
      for (const bad of ['abc', '1.5', '2147483648', 'null', '-0x1']) {
        const page = await service.getFeedbackList({
          statuses: [],
          cursor: seeded[30].id,
          cursorValue: bad,
          sort: { column: 'issue', direction },
          limit: 9,
        });
        expect(
          page.items.map((r) => r.id),
          `"${bad}" was used as a boundary on ${direction}`
        ).toEqual(firstPage);
      }
    }
  });

  /**
   * 🔴 THE SHAPES `Number()` SILENTLY MANGLES, WHICH IS A DIFFERENT AND QUIETER DEFECT. `Number` is
   * not a parser: `''` and `'  '` become 0, `'0x10'` becomes 16, `'1e3'` becomes 1000, `' 12 '`
   * becomes 12 — and every one of those satisfies `Number.isInteger`, so a guard built on it accepts
   * them as boundaries. Nothing errors; a page of wrong rows comes back.
   *
   * 🔴 BOTH DIRECTIONS, AND ASC ALONE IS THE TRAP. Every seeded `bugId` is ≥ 1, so a boundary of 0
   * on `issue asc` admits every row and returns page one BY ACCIDENT — the assertion passes while
   * the defect is live. On `desc` the same boundary returns only the trailing null block, which is
   * visibly not page one. An asc-only loop is what made this readable as covered.
   */
  it('starts over rather than mis-paging on a value Number() would silently mangle', async () => {
    // Value OUTER, direction INNER: with the loops the other way round the first failing value on
    // `asc` aborts the case before any `desc` assertion runs, and `''` — whose whole point is that
    // it is invisible on `asc` — would never be checked in the direction that can see it.
    for (const bad of ['', '  ', '0x10', '1e3', ' 12 ', '+7', '12.0']) {
      for (const direction of ['asc', 'desc'] as const) {
        const page = await service.getFeedbackList({
          statuses: [],
          cursor: seeded[30].id,
          cursorValue: bad,
          sort: { column: 'issue', direction },
          limit: 9,
        });
        expect(
          page.items.map((r) => r.id),
          `"${bad}" was used as a boundary on ${direction}`
        ).toEqual(await issueFirstPage(direction));
      }
    }
  });

  /**
   * 🔴 AN ABSENT VALUE HALF ON A NOT NULL COLUMN IS A BAD URL, NOT A NULL BOUNDARY — and the two
   * readings differ by an EMPTY PAGE, which on screen is indistinguishable from the end of the
   * queue. `area` and `status` are NOT NULL, so nothing this code writes can ever omit their value
   * half; a URL that does was edited, and starting over is the visible answer.
   *
   * The nullable columns are asserted in the SAME loop, against the opposite expectation, because
   * that is what makes this a test of the DISTINCTION rather than of one branch: a mutant that
   * treats every absent value half as a bad URL passes the first three cases and fails the last
   * three, and one that treats them all as null boundaries does the reverse.
   */
  it('separates an absent value half on a NOT NULL column from a genuine null boundary', async () => {
    const midway = seeded[30].id;

    for (const [column, nullable] of [
      ['area', false],
      ['status', false],
      ['age', false],
      ['user', true],
      ['handled', true],
      ['issue', true],
    ] as const) {
      const firstPage = (
        await service.getFeedbackList({
          statuses: [],
          sort: { column, direction: 'asc' },
          limit: 9,
        })
      ).items.map((r) => r.id);

      const page = await service.getFeedbackList({
        statuses: [],
        cursor: midway,
        cursorValue: null,
        sort: { column, direction: 'asc' },
        limit: 9,
      });

      if (nullable) {
        /**
         * A real position: the rest of the trailing null block, below the cursor id, ordered
         * `id DESC` like every tie here. Asserted as the EXACT set rather than as "not the first
         * page" — an empty result is also not the first page, so the weaker form passes over a
         * query that returned nothing at all, which is the failure mode being hunted.
         */
        const nullBlockBelow = seeded
          .filter((r) => valueOf(r, column) === null && r.id < midway)
          .map((r) => r.id)
          .sort((a, b) => b - a)
          .slice(0, 9);
        expect(
          nullBlockBelow.length,
          `${column}'s null block is empty below the cursor — this case observes nothing`
        ).toBeGreaterThan(0);
        expect(
          page.items.map((r) => r.id),
          `${column} mis-placed a real null boundary`
        ).toEqual(nullBlockBelow);
      } else {
        expect(
          page.items.map((r) => r.id),
          `${column} treated an impossible null boundary as a position`
        ).toEqual(firstPage);
      }
    }
  });

  /**
   * The mirror case, and the one that proves the test above is not passing for a trivial reason: a
   * WELL-FORMED value half does move the boundary. Without this, a mutant that dropped every cursor
   * would satisfy the refusal test and be caught by nothing in it.
   */
  it('does use a value half the column CAN hold', async () => {
    const first = await service.getFeedbackList({
      statuses: [],
      sort: { column: 'issue', direction: 'asc' },
      limit: 9,
    });
    const second = await service.getFeedbackList({
      statuses: [],
      cursor: first.nextCursor,
      cursorValue: first.nextCursorValue,
      sort: { column: 'issue', direction: 'asc' },
      limit: 9,
    });

    expect(first.items).toHaveLength(9);
    expect(second.items).toHaveLength(9);
    expect(second.items.map((r) => r.id)).toEqual(expectedOrder('issue', 'asc').slice(9, 18));
  });
});
