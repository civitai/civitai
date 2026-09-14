import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_SORT_COLUMNS, type FeedbackSortColumn } from '$lib/feedback-sort';
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
 * Enough rows to overflow a real page, with the cycle lengths chosen so that no two columns
 * partition the set the same way.
 *
 * 🔴 THE CYCLE LENGTHS ARE COPRIME-ISH AND NONE DIVIDES `PAGE`, which is the point: a boundary that
 * lands exactly on a group edge never exercises the tie branch of the keyset, so a fixture whose
 * groups line up with the page size can leave the `(col = cursor AND id < cursorId)` arm unreachable
 * while every assertion passes. 60 rows, groups of 3/4/5/7, page sizes 7 and 50 — no group edge
 * coincides with a page edge for more than one row at a time.
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

type Seeded = {
  id: number;
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
      handledById: handledByUsername === null ? null : handlerIds.get(handledByUsername)!,
      bugId,
    });
    seeded.push({ id, area, status, username, handledByUsername, bugId });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  dbHandle.current = null;
  await db.close();
});

/** The value the ORDER BY sees, read off the SEEDED fixture rather than off a returned row. */
const valueOf = (row: Seeded, column: FeedbackSortColumn): string | number | null => {
  switch (column) {
    case 'age':
      return row.id;
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

/** Every page, followed to the end, as one flat list of ids. */
async function pageThrough(
  column: FeedbackSortColumn | null,
  direction: 'asc' | 'desc',
  limit: number
): Promise<{ ids: number[]; pages: number }> {
  const ids: number[] = [];
  let cursor: number | null = null;
  let cursorValue: string | null = null;
  let pages = 0;

  for (;;) {
    const page = await service.getFeedbackList({
      statuses: [],
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
      for (const direction of ['asc', 'desc'] as const) {
        const { ids, pages } = await pageThrough(column, direction, service.FEEDBACK_PAGE_SIZE);

        expect(pages, `${column} ${direction} never crossed a page boundary`).toBeGreaterThan(1);
        /**
         * Two different defects, two different messages — and each assertion measures the ONE it
         * names. A bare `new Set(ids).size === ROWS` reports a repeat and a skip identically, and a
         * bare `ids.length === ROWS` reports "80 where 60 expected" for a repeat and "51 where 60
         * expected" for a truncation, under whichever name it was given. The DIFFERENCE between the
         * two counts is duplication and nothing else; the set SIZE is completeness and nothing else.
         */
        expect(
          ids.length - new Set(ids).size,
          `${column} ${direction} returned the same row on two pages`
        ).toBe(0);
        expect(new Set(ids).size, `${column} ${direction} lost a row at a page boundary`).toBe(
          ROWS
        );
        expect(ids, `${column} ${direction} returned the rows in the wrong order`).toEqual(
          expectedOrder(column, direction)
        );
      }
    }
  });

  /**
   * The same property with the boundary walked EIGHT more times per run. A single boundary can be
   * crossed correctly by luck — it lands on one particular pair of values — and this does not let it.
   */
  it('survives a boundary every seven rows, on every column and direction', async () => {
    for (const column of FEEDBACK_SORT_COLUMNS) {
      for (const direction of ['asc', 'desc'] as const) {
        const { ids, pages } = await pageThrough(column, direction, 7);

        expect(pages, `${column} ${direction} paged in one shot`).toBeGreaterThan(8);
        /**
         * Two different defects, two different messages — and each assertion measures the ONE it
         * names. A bare `new Set(ids).size === ROWS` reports a repeat and a skip identically, and a
         * bare `ids.length === ROWS` reports "80 where 60 expected" for a repeat and "51 where 60
         * expected" for a truncation, under whichever name it was given. The DIFFERENCE between the
         * two counts is duplication and nothing else; the set SIZE is completeness and nothing else.
         */
        expect(
          ids.length - new Set(ids).size,
          `${column} ${direction} returned the same row on two pages`
        ).toBe(0);
        expect(new Set(ids).size, `${column} ${direction} lost a row at a page boundary`).toBe(
          ROWS
        );
        expect(ids, `${column} ${direction} returned the rows in the wrong order`).toEqual(
          expectedOrder(column, direction)
        );
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

    const { ids } = await pageThrough2('bravo', 'status', 'asc', 5);
    expect(ids).toEqual(expected);
  });
});

/** `pageThrough` with an area filter, to prove the filter and the keyset compose. */
async function pageThrough2(
  area: string,
  column: FeedbackSortColumn,
  direction: 'asc' | 'desc',
  limit: number
): Promise<{ ids: number[] }> {
  const ids: number[] = [];
  let cursor: number | null = null;
  let cursorValue: string | null = null;
  for (let guard = 0; guard <= ROWS; guard++) {
    const page = await service.getFeedbackList({
      statuses: [],
      area,
      cursor,
      cursorValue,
      sort: { column, direction },
      limit,
    });
    ids.push(...page.items.map((r) => r.id));
    if (page.nextCursor === null) return { ids };
    cursor = page.nextCursor;
    cursorValue = page.nextCursorValue;
  }
  throw new Error('paging did not terminate');
}

describe('what the query builder refuses', () => {
  /**
   * 🔴 THE SECOND REFUSAL. `parseFeedbackSort` is the first, and it is a URL parser — a caller that
   * is not a URL (a script, an internal API, a new route) never goes through it. The column names a
   * SQL identifier, so the service checks it against its own map and falls back to the DEFAULT
   * ordering rather than handing the builder an arbitrary string.
   *
   * The fixture values are chosen to be distinguishable from a pass-through: if the column WERE
   * interpolated, `f.area` would order by area (a different order from `id DESC`) and the injection
   * strings would raise rather than return rows.
   */
  it('falls back to the default ordering for a column that is not on its map', async () => {
    const byId = [...seeded].map((r) => r.id).sort((a, b) => b - a);

    for (const hostile of ['attachments', 'f.area', 'createdAt', '1; drop table "Feedback"', '']) {
      const page = await service.getFeedbackList({
        statuses: [],
        sort: { column: hostile as FeedbackSortColumn, direction: 'asc' },
        limit: ROWS,
      });
      expect(
        page.items.map((r) => r.id),
        `"${hostile}" changed the ordering`
      ).toEqual(byId);
      expect(page.nextCursorValue).toBeNull();
    }
  });

  /**
   * 🔴 A VALUE HALF THE COLUMN CANNOT HOLD DROPS THE WHOLE CURSOR, and page one is the right answer.
   * Keeping the id half alone would compare `f.id` against a boundary belonging to a different
   * ordering and return rows that are neither the first page nor the next one.
   *
   * `2147483648` is one past the int4 bound, which ERRORS the comparison in Postgres rather than
   * missing it — so a version that passed it through would fail this test by throwing, not by
   * returning the wrong rows.
   */
  it('starts over rather than mis-paging when the value half cannot be an integer', async () => {
    const firstPage = (
      await service.getFeedbackList({
        statuses: [],
        sort: { column: 'issue', direction: 'asc' },
        limit: 9,
      })
    ).items.map((r) => r.id);

    for (const bad of ['abc', '1.5', '', '2147483648', 'null']) {
      const page = await service.getFeedbackList({
        statuses: [],
        cursor: seeded[30].id,
        cursorValue: bad,
        sort: { column: 'issue', direction: 'asc' },
        limit: 9,
      });
      expect(
        page.items.map((r) => r.id),
        `"${bad}" was used as a boundary`
      ).toEqual(firstPage);
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
