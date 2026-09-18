import { describe, expect, it, vi } from 'vitest';

// Pure string helpers, no module graph — safe to import statically above the vi.mock below.
import { renderTag, whereClausesOf } from './sql-shape.test-utils';

import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * THE MODELS DELTA SCAN MUST NOT LOSE A ROW TO A CONCURRENT EDIT.
 *
 * `prepareModelsBatches` pages the set of models whose `updatedAt` is at or after the last run.
 * That set is re-evaluated on every page, and it is not stable: roughly 1,659 published models
 * are edited per day, so a multi-page scan meets concurrent edits as a matter of routine. An
 * edit that unpublishes a model — or flips it to Unsearchable — takes a row OUT of the set.
 *
 * 🔴 THE DECISION THIS FILE PINS IS KEYSET PAGING, NOT ORDERING. The first case below runs the
 * fake with the members kept in id order at every page, which is the most charitable possible
 * reading of an OFFSET query and is exactly what `ORDER BY id` alone would buy. It still loses
 * a row, because the defect is MEMBERSHIP: one row leaving the set below the cursor shifts every
 * later page down by one, and the row that was sitting on the page boundary is never emitted.
 * A future reader who replaces the keyset cursor with an ordered OFFSET will see case 1 go red
 * with `expected [ ... ] to contain 2001` — that is this file doing its job, not a flake.
 *
 * 🔴 THE FAKE TERMINATES ON ITS OWN, at PAGE_CAP. A paging fake that just keeps answering turns
 * a regression into a pure microtask loop, which vitest's setTimeout-based timeout cannot
 * observe: CI hangs with no assertion to read. The cap converts that into a thrown error in
 * milliseconds.
 */

// The index module reaches for the search client at import time; none of it is needed to page ids.
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: null,
  metricsSearchClient: null,
  updateDocs: vi.fn(async () => undefined),
}));

const { prepareModelsBatches } = await import('~/server/search-index/models.search-index');

/** Production page size, restated here so the fixtures below are honestly multi-page. */
const READ_BATCH_SIZE = 2000;

/** Far more pages than any case here needs; see the header note on why a cap exists at all. */
const PAGE_CAP = 50;

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

type PagingFake = {
  ctx: Parameters<typeof prepareModelsBatches>[0];
  /** Page queries only — the MIN/MAX bounds query is not counted. */
  pageQueries: () => number;
  /** Rendered by {@link renderTag}, so bind VALUES appear as `?` — see `pageValues`. */
  pageSql: () => string[];
  /** The bind values of each page query, in order. The half `pageSql` cannot show. */
  pageValues: () => unknown[][];
};

/**
 * A minimal `"Model"` table that answers whichever paging shape the query asks for, so the same
 * fixture can be run against the keyset form and against a reverted OFFSET form. Rows come back
 * in the order the query asked for, and an OFFSET query with no ORDER BY is answered in id order
 * anyway — the OFFSET arm is given the benefit of the doubt on purpose.
 *
 * 🔴 IT REFUSES A QUERY IT CANNOT READ rather than defaulting. A fake that answers an
 * unrecognised statement is worse than no fake: inline the page size as a literal and a
 * `?? members.size` default would hand back the whole set on page one, at which point the
 * headline case passes under an OFFSET implementation too and stops discriminating anything.
 *
 * `onPage` runs after a page has been answered, and is where a case mutates membership.
 */
const makeFake = (members: Set<number>, onPage?: (page: number) => void): PagingFake => {
  let pages = 0;
  const sql: string[] = [];
  const binds: unknown[][] = [];

  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = renderTag(strings, values);
    if (text.includes('MIN(id)')) return [{ startId: 1, endId: 1_000_000 }];

    pages += 1;
    if (pages > PAGE_CAP) {
      throw new Error(
        `paging fake answered ${pages} pages (cap ${PAGE_CAP}) — the scan is not advancing`
      );
    }
    sql.push(text);
    binds.push(values);

    // strings[i] is the SQL immediately before values[i], so a fragment's trailing text names it.
    const valueBefore = (marker: RegExp) => {
      const index = strings.findIndex((part) => marker.test(part));
      if (index === -1 || index >= values.length) return undefined;
      return Number(values[index]);
    };

    const limit = valueBefore(/LIMIT\s*$/);
    if (limit === undefined) {
      throw new Error(`paging fake found no LIMIT value in: ${text}`);
    }

    const descending = /ORDER BY id\s+DESC/i.test(text);
    const ordered = [...members].sort((a, b) => (descending ? b - a : a - b));

    const offset = valueBefore(/OFFSET\s*$/);
    const after = valueBefore(/\bid\s*>\s*$/);
    if (offset === undefined && after === undefined) {
      throw new Error(`paging fake recognised neither an OFFSET nor an id cursor in: ${text}`);
    }

    const page =
      offset !== undefined
        ? ordered.slice(offset, offset + limit)
        : ordered.filter((id) => id > (after as number)).slice(0, limit);

    onPage?.(pages);
    return page.map((id) => ({ id }));
  };

  return {
    ctx: { db: { $queryRaw }, logger: () => undefined } as never,
    pageQueries: () => pages,
    pageSql: () => sql,
    pageValues: () => binds,
  };
};

const LAST_UPDATED_AT = new Date('2026-09-17T00:00:00.000Z');

describe('prepareModelsBatches paging', () => {
  it('emits every model that was eligible for the whole scan, even when one leaves mid-scan', async () => {
    // One full page, then a short one.
    const total = READ_BATCH_SIZE + 400;
    // The first id on page 2 — the row an OFFSET scan drops when the set shrinks behind it.
    const firstOnSecondPage = READ_BATCH_SIZE + 1;
    const unpublishedMidScan = READ_BATCH_SIZE - 500;

    const members = new Set(range(1, total));
    const fake = makeFake(members, (page) => {
      // A moderator unpublishes a model already emitted on page 1, while page 2 is being fetched.
      if (page === 1) members.delete(unpublishedMidScan);
    });

    const { updateIds, batchSize } = await prepareModelsBatches(fake.ctx, LAST_UPDATED_AT);

    // Negative control: keyset paging is SUPPOSED to be unmoved by the mid-scan edit, so every
    // assertion below reads the same whether or not the edit landed. Without this line a dead
    // `onPage` would leave the case quietly testing a static set.
    expect(members.has(unpublishedMidScan)).toBe(false);
    // If the production page size moves, the drift names itself here instead of surfacing as a
    // page-count or length failure that reads like a paging bug.
    expect(batchSize).toBe(READ_BATCH_SIZE);

    expect(updateIds).toContain(firstOnSecondPage);
    expect(updateIds).toHaveLength(total);
    expect(new Set(updateIds).size).toBe(total);
    expect(fake.pageQueries()).toBe(2);
  });

  it('stops after the first short page instead of asking for one more', async () => {
    const fake = makeFake(new Set(range(1, 100)));

    const { updateIds } = await prepareModelsBatches(fake.ctx, LAST_UPDATED_AT);

    expect(updateIds).toHaveLength(100);
    expect(fake.pageQueries()).toBe(1);
  });

  it('pages by a forward-only id cursor, never by OFFSET', async () => {
    const fake = makeFake(new Set(range(1, 100)));

    await prepareModelsBatches(fake.ctx, LAST_UPDATED_AT);

    const [first] = fake.pageSql();
    // ASCENDING specifically: `ORDER BY id DESC` would walk the cursor backwards from the top of
    // the table and re-select nearly the same rows forever, and `/ORDER BY id/` alone matches it.
    expect(first).toMatch(/ORDER BY id\s+LIMIT/);
    expect(first).not.toMatch(/DESC/i);
    expect(first).toMatch(/AND id > /);
    expect(first).not.toMatch(/OFFSET/);
  });

  /**
   * The fake models membership as an opaque set of ids, so it cannot see WHICH rows the predicates
   * select: the paging cases above stay green under any change to the WHERE clause. Dropping the
   * `updatedAt` bound turns the delta scan into a full scan of every published model, every 15
   * minutes; dropping the availability bound puts Unsearchable models into the public index.
   *
   * 🔴 THE WHOLE CLAUSE, WITH `toBe`, NOT SUBSTRINGS. A substring assertion is satisfied by a
   * statement that merely mentions the predicate, so a WIDENING mutation passes it: appending
   * `OR availability = 'Unsearchable'` leaves every fragment present while `AND` binding tighter
   * than `OR` returns every Unsearchable model on every page. The sibling file next door carries
   * the same rule for the same reason — see `sql-shape.test-utils`.
   *
   * The price is that a reword of the clause fails here and must be updated in the same commit.
   */
  it('scopes the page query to exactly the eligible set', async () => {
    const fake = makeFake(new Set(range(1, 100)));

    await prepareModelsBatches(fake.ctx, LAST_UPDATED_AT);

    const [first] = fake.pageSql();
    expect(whereClausesOf(first)).toEqual([
      'status = ?::"ModelStatus" AND availability != ?::"Availability" AND "updatedAt" >= ? AND id > ?',
    ]);
  });

  /**
   * `renderTag` renders a bind param as `?`, so the clause pinned above is blind to the VALUES —
   * `availability != ${Availability.Private}` is byte-identical to the Unsearchable form there,
   * and would put Unsearchable models into the public index with the case above still green.
   * Corruption of a predicate is a cheaper typo than deletion of one, so the values are pinned too.
   */
  it('binds the page query to Published, not-Unsearchable, and the caller watermark', async () => {
    const fake = makeFake(new Set(range(1, 100)));

    await prepareModelsBatches(fake.ctx, LAST_UPDATED_AT);

    expect(fake.pageValues()).toEqual([
      [ModelStatus.Published, Availability.Unsearchable, LAST_UPDATED_AT, 0, READ_BATCH_SIZE],
    ]);
  });

  /**
   * Reaches the EMPTY-page break, which every other case here shadows: they all end on a short
   * page, so the `if (!ids.length) break` above it is unreachable and deleting it leaves them
   * green. In production that deletion reads `ids[ids.length - 1].id` off an empty array and
   * throws out of `prepareBatches`, killing the whole index job — on any run where the eligible
   * set is an exact multiple of the page size, or empty.
   */
  it('stops on an empty page when the set is an exact multiple of the page size', async () => {
    const fake = makeFake(new Set(range(1, READ_BATCH_SIZE)));

    const { updateIds } = await prepareModelsBatches(fake.ctx, LAST_UPDATED_AT);

    expect(updateIds).toHaveLength(READ_BATCH_SIZE);
    expect(fake.pageQueries()).toBe(2);
  });

  it('issues no page query at all on a full rebuild', async () => {
    const fake = makeFake(new Set(range(1, 100)));

    const { updateIds } = await prepareModelsBatches(fake.ctx);

    expect(updateIds).toHaveLength(0);
    expect(fake.pageQueries()).toBe(0);
  });
});
