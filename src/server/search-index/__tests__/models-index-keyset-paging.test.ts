import { describe, expect, it, vi } from 'vitest';

// Pure string helpers, no module graph — safe to import statically above the vi.mock below.
import { norm, renderTag, whereClausesOf } from './sql-shape.test-utils';

import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * THE MODELS DELTA SCAN MUST NOT LOSE A ROW WHEN IT PAGES.
 *
 * `prepareModelsBatches` pages the set of models whose `updatedAt` is at or after the last run.
 * That set is re-evaluated on every page and it is not stable: an edit that unpublishes a model,
 * or flips it to Unsearchable, takes a row OUT of it mid-scan.
 *
 * This needs MORE THAN ONE PAGE to bite, which the steady state does not reach - the models
 * sync runs every 15 minutes, and at ~1,659 published edits a day a window holds about 17 rows
 * against a 2,000-row page. (No cron string here on purpose: the slash-star-slash in one closes
 * this comment, which is how this paragraph first shipped broken.)
 * It bites on a wide window: a stale watermark after an outage or deploy gap, a rebuild, or a
 * bulk write touching `updatedAt` on more than 2,000 rows. Inside such a run the skip does not
 * need a concurrent edit at all - the old query had no `ORDER BY` over a parallel seq scan, and
 * `synchronize_seqscans` alone can cut successive OFFSET pages out of different row orderings.
 * An earlier version of this comment cited that edits-per-day figure for the opposite claim.
 *
 * 🔴 THE DECISION THIS FILE PINS IS KEYSET PAGING, NOT ORDERING. The first case below runs the
 * fake with the members kept in id order at every page, which is the most charitable possible
 * reading of an OFFSET query and is exactly what `ORDER BY id` alone would buy. It still loses
 * a row, because the defect is MEMBERSHIP: one row leaving the set below the cursor shifts every
 * later page down by one, and the row that was sitting on the page boundary is never emitted.
 * A future reader who replaces the keyset cursor with an ordered OFFSET will see case 1 go red
 * with `expected [ ... ] to contain 2001` — that is this file doing its job, not a flake.
 *
 * 🔴 AND THE LAST CASE IS WHAT MAKES THAT TRUE. Every case here drives the EXPORTED function;
 * the index job runs whatever is wired into `createSearchIndexUpdateProcessor`. Those were the
 * same object and nothing said so, so re-inlining the old OFFSET body at the wiring site while
 * leaving this export untouched reverted the fix with the whole file still green.
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

const { prepareModelsBatches, modelsSearchIndex } = await import(
  '~/server/search-index/models.search-index'
);

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
  /** The MIN/MAX bounds statement, which produces the `startId`/`endId` the rebuild pages over. */
  boundsSql: () => string[];
  boundsValues: () => unknown[][];
};

/**
 * A minimal `"Model"` table that answers whichever paging shape the query asks for, so the same
 * fixture can be run against the keyset form and against a reverted OFFSET form. Rows come back
 * in the order the query asked for, and an OFFSET query with no ORDER BY is answered in id order
 * anyway — the OFFSET arm is given the benefit of the doubt on purpose.
 *
 * 🔴 IT REFUSES A QUERY IT CANNOT READ rather than defaulting, and that now covers BOTH
 * statements. A fake that answers an unrecognised statement is worse than no fake: a
 * `?? members.size` default handed back the whole set on page one, and a hardcoded bounds row
 * answered a query nobody was reading - each of which let a mutation of the real statement pass
 * every case in this file.
 *
 * `onPage` runs after a page has been answered, and is where a case mutates membership.
 */
const makeFake = (members: Set<number>, onPage?: (page: number) => void): PagingFake => {
  let pages = 0;
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const boundsSql: string[] = [];
  const boundsBinds: unknown[][] = [];

  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = renderTag(strings, values);
    if (text.includes('MIN(id)')) {
      // Derived from the members, never constant. A hardcoded row here made the whole bounds
      // query invisible: swapping its MIN/MAX aliases, or deleting it outright, left every case
      // green while production stopped indexing newly created models.
      boundsSql.push(text);
      boundsBinds.push(values);
      const ids = [...members];
      // Answer the aggregate the statement ASKED for. Returning a constant row, or even the
      // right numbers under fixed names, cannot see a swapped MIN/MAX alias - and that swap
      // makes `endId - startId` negative, which silently stops every newly created model from
      // being indexed.
      const aggregateFor = (alias: string) => {
        const match = text.match(new RegExp(String.raw`(MIN|MAX)\(id\)\s+as\s+"${alias}"`, 'i'));
        if (!match) {
          throw new Error(`bounds fake found no aggregate aliased "${alias}" in: ${text}`);
        }
        return match[1].toUpperCase() === 'MIN' ? Math.min(...ids) : Math.max(...ids);
      };
      return [{ startId: aggregateFor('startId'), endId: aggregateFor('endId') }];
    }

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
    boundsSql: () => boundsSql,
    boundsValues: () => boundsBinds,
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
    expect(norm(first)).toContain('SELECT id FROM "Model"');
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

  /**
   * The wiring, not the behaviour. Everything above imports `prepareModelsBatches` directly, so on
   * its own this file is evidence about an exported helper rather than about the scan the models
   * index job actually runs, and the cheapest possible revert is to leave the export alone and
   * re-inline the old OFFSET body into the processor's options object.
   *
   * Wrapping the reference here - even in a behaviour-preserving arrow - fails this too. That is
   * the cost of an identity check, and the fix is to keep the wiring a direct reference.
   */
  it('is the function the models index processor actually runs', () => {
    expect(modelsSearchIndex.prepareBatches).toBe(prepareModelsBatches);
  });

  /**
   * `startId`/`endId` are the OTHER half of what this function returns, and the half the file
   * ignored for six review rounds. `base.search-index.ts` turns them into the range fan-out
   * (`Math.ceil((endId - startId) / batchSize)`) on both the delta and the rebuild path, so they
   * are how newly created models get indexed at all. Swapping the MIN/MAX aliases makes that
   * span negative and silently indexes nothing new; deleting the bounds query guts the rebuild.
   * Both of those passed every other case in this file.
   */
  it('returns the real id bounds, with the aggregates the right way round', async () => {
    // Deliberately not symmetric and not starting at 1: a swapped alias has to produce a
    // different number, and a fixture like 1..N makes too many wrong answers look right.
    const fake = makeFake(new Set(range(5, 90)));

    const { startId, endId } = await prepareModelsBatches(fake.ctx, LAST_UPDATED_AT);

    expect(startId).toBe(5);
    expect(endId).toBe(90);
  });

  it('scopes the bounds query to the eligible set and the caller watermark', async () => {
    const fake = makeFake(new Set(range(5, 90)));

    await prepareModelsBatches(fake.ctx, LAST_UPDATED_AT);

    expect(fake.boundsSql()).toHaveLength(1);
    const [bounds] = fake.boundsSql();
    // `whereClausesOf` starts at WHERE, so the table and the aggregates are outside everything
    // else here asserts: `FROM "ModelVersion"` would bound a different entity's ids, silently.
    expect(norm(bounds)).toContain('SELECT MIN(id) as "startId", MAX(id) as "endId" FROM "Model"');
    expect(whereClausesOf(bounds)).toEqual([
      'status = ?::"ModelStatus" AND availability != ?::"Availability" AND "createdAt" >= ? ;',
    ]);
    // `"createdAt"` here against `"updatedAt"` on the page query is deliberate and pre-existing:
    // the bounds describe the newly-created span, the page query the edited set. Pinned so a
    // one-word change between the two statements cannot pass unnoticed.
    // The watermark reaches this statement inside a conditional `Prisma.sql` fragment, not as a
    // bare scalar - so it is asserted through that shape. Drop the fragment and there is no third
    // bind to destructure, which is the failure this is here to produce.
    const [status, availability, createdAt] = fake.boundsValues()[0] as [
      string,
      string,
      { values: unknown[] }
    ];
    expect(status).toBe(ModelStatus.Published);
    expect(availability).toBe(Availability.Unsearchable);
    expect(createdAt.values).toEqual([LAST_UPDATED_AT]);
  });

  it('issues no page query at all on a full rebuild', async () => {
    const fake = makeFake(new Set(range(1, 100)));

    const { updateIds } = await prepareModelsBatches(fake.ctx);

    expect(updateIds).toHaveLength(0);
    expect(fake.pageQueries()).toBe(0);
  });

  /**
   * 🔴 THE REBUILD PATH IS THE ONE WHERE `startId`/`endId` ARE THE ENTIRE OUTPUT, and until this
   * case existed it was also the only path asserting nothing about them. The case above passes on
   * an empty `updateIds` and no page query - which is equally what a rebuild that does nothing at
   * all looks like. Returning `{ startId: 0, endId: 0, updateIds: [] }` early for a missing
   * watermark satisfied it, and made `Math.ceil((endId - startId) / batchSize)` zero: a whole
   * index rebuild that creates no batches and indexes nothing.
   */
  it('still bounds the whole id range on a full rebuild', async () => {
    const fake = makeFake(new Set(range(5, 90)));

    const { startId, endId } = await prepareModelsBatches(fake.ctx);

    expect(startId).toBe(5);
    expect(endId).toBe(90);
    expect(fake.boundsSql()).toHaveLength(1);
    // No watermark, so the conditional fragment is the EMPTY `Prisma.sql` - still passed as a
    // bind, contributing no text and no values of its own. Asserted through that shape rather
    // than trimmed away, because "the fragment is empty" and "the fragment is gone" are the two
    // states this case exists to tell apart.
    expect(whereClausesOf(fake.boundsSql()[0])).toEqual([
      'status = ?::"ModelStatus" AND availability != ?::"Availability" ;',
    ]);
    const [status, availability, watermark] = fake.boundsValues()[0] as [
      string,
      string,
      { values: unknown[] }
    ];
    expect(status).toBe(ModelStatus.Published);
    expect(availability).toBe(Availability.Unsearchable);
    expect(watermark.values).toEqual([]);
  });
});
