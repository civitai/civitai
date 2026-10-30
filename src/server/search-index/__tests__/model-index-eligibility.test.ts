import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

// Pure string helpers, no module graph — safe to import statically above the vi.mock below.
import { norm, renderTag, whereClausesOf } from './sql-shape.test-utils';

import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * WHICH MODELS BELONG IN THE MODELS SEARCH INDEX — and every site that decides it agrees.
 *
 * The rule is stated once, in `model-index-eligibility.ts`, and read at four sites: the delta
 * scan's bounds query and page query, `pullModelsData` (every batch is read through it), and the
 * nightly reconciler in `meilisearch/cleanup.ts`, which DELETES whatever it no longer selects. One
 * site drifting from the others either puts Unsearchable models into the public index or evicts
 * eligible ones from it.
 *
 * 🔴 EACH SITE IS PINNED AT ITS OWN QUERY BOUNDARY, whole clause AND bind values. Pinning the
 * shared predicate alone would say nothing about a site that stopped reading it and re-inlined
 * its own copy. Whole clauses because a substring is satisfied by a widening mutation —
 * `... OR m.availability = 'Unsearchable'` keeps every fragment and, `AND` binding tighter than
 * `OR`, returns every Unsearchable model. Values because a bind is rendered as `?`, so
 * `!= ${Availability.Private}` is byte-identical to the Unsearchable form in the text.
 *
 * The price: a reword of any of these WHEREs fails here and must update this file in the same
 * commit. A new statement in these paths fails the ledger counts — check its WHERE and add it.
 */

// The index and reconciler modules reach for the search client at import time; it is not needed
// to read a predicate.
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: null,
  metricsSearchClient: null,
  updateDocs: vi.fn(async () => undefined),
}));

const { modelsSearchIndex, prepareModelsBatches, pullModelsData } = await import(
  '~/server/search-index/models.search-index'
);
const { CLEANUP_INDEXES } = await import('~/server/meilisearch/cleanup');

const ELIGIBILITY = 'm.status = ?::"ModelStatus" AND m.availability != ?::"Availability"';
const ELIGIBILITY_VALUES = [ModelStatus.Published, Availability.Unsearchable];
const ELIGIBILITY_WHERE = {
  status: ModelStatus.Published,
  availability: { not: Availability.Unsearchable },
};

const READ_BATCH_SIZE = 2000;
const WATERMARK = new Date('2026-09-17T00:00:00.000Z');

type Statement = { where: string[]; values: unknown[] };

/** Drives the real batch preparation and hands back EVERY raw statement it issued, in order. */
async function captureRawQueries(lastUpdatedAt?: Date): Promise<Statement[]> {
  const captured: Statement[] = [];
  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.push({
      where: whereClausesOf(renderTag(strings, values)),
      values: Prisma.sql(strings, ...values).values,
    });
    // The bounds row is destructured; an empty page ends the delta scan's loop on its first ask.
    return captured.length === 1 ? [{ startId: 1, endId: 2 }] : [];
  };
  await prepareModelsBatches(
    { db: { $queryRaw }, logger: () => undefined } as never,
    lastUpdatedAt
  );
  return captured;
}

/** Drives the real `pullModelsData` and hands back every `findMany` argument it passed. */
async function captureFindMany(batch: Parameters<typeof pullModelsData>[1]) {
  const calls: { where: unknown }[] = [];
  const db = {
    model: {
      findMany: async (args: { where: unknown }) => {
        calls.push(args);
        // No rows: `pullModelsData` returns before it reaches caches or other tables.
        return [];
      },
    },
  };
  await pullModelsData({ db, logger: () => undefined } as never, batch);
  return calls.map((call) => call.where);
}

describe('models search index eligibility', () => {
  describe('the queries the indexer actually issues', () => {
    it('the delta scan: bounds query and page query both lead with the predicate', async () => {
      const statements = await captureRawQueries(WATERMARK);
      expect(statements.map((s) => s.where)).toEqual([
        [`${ELIGIBILITY} AND m."createdAt" >= ? ;`],
        [`${ELIGIBILITY} AND m."updatedAt" >= ? AND m.id > ?`],
      ]);
      expect(statements.map((s) => s.values)).toEqual([
        [...ELIGIBILITY_VALUES, WATERMARK],
        [...ELIGIBILITY_VALUES, WATERMARK, 0, READ_BATCH_SIZE],
      ]);
    });

    it('a full rebuild: the bounds query alone, on the predicate alone', async () => {
      const statements = await captureRawQueries();
      expect(statements).toEqual([{ where: [`${ELIGIBILITY} ;`], values: ELIGIBILITY_VALUES }]);
    });

    it('pullModelsData filters a TARGETED update batch on the predicate', async () => {
      expect(await captureFindMany({ type: 'update', ids: [11, 22] })).toEqual([
        { ...ELIGIBILITY_WHERE, id: { in: [11, 22] } },
      ]);
    });

    /**
     * The cases above drive the export; the job runs whatever is wired into the processor. A body
     * re-inlined at the wiring site would bypass every one of them, so the wiring is pinned too.
     */
    it('pullModelsData is the function the models index processor actually runs', () => {
      expect(modelsSearchIndex.pullData).toBe(pullModelsData);
    });

    it('pullModelsData filters a RANGE batch on the predicate', async () => {
      expect(await captureFindMany({ type: 'new', startId: 5, endId: 9 })).toEqual([
        { ...ELIGIBILITY_WHERE, id: { gte: 5, lte: 9 } },
      ]);
    });
  });

  /**
   * The half that REMOVES documents from the live index: a document whose id this WHERE does not
   * return is deleted. A narrowed predicate here evicts eligible models; a widened one keeps
   * Unsearchable ones forever, since nothing else takes them out.
   */
  it('the nightly reconciler keeps exactly the models the indexer writes', () => {
    const models = CLEANUP_INDEXES.find((c) => c.key === 'models');
    expect(models).toBeDefined();
    const where = models!.where([11, 22]);
    expect(norm(where.sql)).toBe(`m.id IN (?,?) AND ${ELIGIBILITY}`);
    expect(where.values).toEqual([11, 22, ...ELIGIBILITY_VALUES]);
  });
});
