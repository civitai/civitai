import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { indexHolder } = vi.hoisted(() => ({ indexHolder: { current: null as unknown } }));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => indexHolder.current },
}));

import type * as MeiliClient from '~/server/meilisearch/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { summarizeReconcile } from '~/server/jobs/models-search-index-reconcile';
import {
  RECONCILE_CHURN_WINDOW_MS,
  reconcileModelsIndex,
  sortedDifference,
  type ModelsIndexReconcileResult,
} from '~/server/meilisearch/models-index-reconcile';
import { EMPTY_PAGE_BACKOFF_MS } from '~/server/meilisearch/cleanup';

const NOW = new Date('2026-10-26T12:00:00Z');
const OLD = new Date(NOW.getTime() - RECONCILE_CHURN_WINDOW_MS - 60_000);
const RECENT = new Date(NOW.getTime() - 60_000);

type ModelRow = {
  id: number;
  status: 'Published' | 'Deleted' | 'Unpublished' | 'Draft';
  availability?: 'Public' | 'Unsearchable';
  updatedAt: Date;
  hasEligibleVersion?: boolean;
};

/** Past this many pages a fake answers empty, so a cursor that stops moving fails, not hangs. */
const MAX_PAGES = 50;

/**
 * Postgres, as the reconciler's queries see it: rendered SQL + flattened bind values.
 * `primaryOverrides` are rows the PRIMARY sees differently from the replica.
 */
function installModels(models: ModelRow[], primaryOverrides: ModelRow[] = []) {
  const replica = new Map(models.map((m) => [m.id, m]));
  const primary = new Map([...replica, ...primaryOverrides.map((m) => [m.id, m] as const)]);
  const pullable = (m: ModelRow) => m.status === 'Published' && m.availability !== 'Unsearchable';
  const pages = { count: 0 };

  const queryRawOn =
    (byId: Map<number, ModelRow>) =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = Prisma.sql(strings, ...values);
      const ids = query.values.filter((v): v is number => typeof v === 'number');
      if (query.sql.includes('ORDER BY id LIMIT')) {
        if (++pages.count > MAX_PAGES) return [];
        const [cursor, limit] = ids;
        return [...byId.keys()]
          .sort((a, b) => a - b)
          .filter((id) => id > cursor)
          .slice(0, limit)
          .map((id) => ({ id }));
      }
      if (query.sql.includes('m.status')) {
        return ids.filter((id) => byId.has(id) && pullable(byId.get(id)!)).map((id) => ({ id }));
      }
      return ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    };
  dbMock.dbRead.$queryRaw.mockImplementation(queryRawOn(replica));
  dbMock.dbWrite.$queryRaw.mockImplementation(queryRawOn(primary));
  dbMock.dbWrite.model.findMany.mockImplementation(
    async ({ where }: { where: { id: { in: number[] } } }) =>
      where.id.in.map((id) => ({
        id,
        updatedAt: primary.get(id)!.updatedAt,
        modelVersions: primary.get(id)!.hasEligibleVersion === false ? [] : [{ id: id * 10 }],
      }))
  );
  return pages;
}

/**
 * A models index (page ceiling 3). `appearsOnPointLookup` are absent from the scan but found
 * when re-asked; `goneOnPointLookup` are scanned but deleted before the re-ask.
 */
function installIndex(opts: {
  docs: number[];
  totalOverride?: number;
  appearsOnPointLookup?: number[];
  goneOnPointLookup?: number[];
}) {
  const searches: string[] = [];
  let scanPages = 0;
  indexHolder.current = {
    getStats: async () => ({
      numberOfDocuments: opts.totalOverride ?? opts.docs.length,
      isIndexing: false,
    }),
    getSettings: async () => ({ pagination: { maxTotalHits: 3 } }),
    search: async (_q: string, params: { filter: string; limit: number }) => {
      searches.push(params.filter);
      const inList = params.filter.match(/^id IN \[(.*)\]$/);
      if (inList) {
        const asked = inList[1].split(',').map(Number);
        const gone = new Set(opts.goneOnPointLookup ?? []);
        const present = new Set(
          [...opts.docs, ...(opts.appearsOnPointLookup ?? [])].filter((id) => !gone.has(id))
        );
        return { hits: asked.filter((id) => present.has(id)).map((id) => ({ id })) };
      }
      if (++scanPages > MAX_PAGES) return { hits: [] };
      const cursor = Number(params.filter.match(/^id > (-?\d+)$/)![1]);
      return {
        hits: opts.docs
          .filter((id) => id > cursor)
          .slice(0, params.limit)
          .map((id) => ({ id })),
      };
    },
  };
  return {
    searches,
    get scanPages() {
      return scanPages;
    },
  };
}

const run = () => reconcileModelsIndex({ now: NOW, delay: async () => undefined });

beforeEach(() => {
  indexHolder.current = null;
  dbMock.dbRead.$queryRaw.mockClear();
});

describe('reconcileModelsIndex', () => {
  it('reports both directions and separates residue from churn', async () => {
    installModels([
      { id: 1, status: 'Published', updatedAt: OLD },
      { id: 2, status: 'Published', updatedAt: OLD }, // missing, long-standing
      { id: 3, status: 'Published', updatedAt: RECENT }, // missing, sync not there yet
      { id: 4, status: 'Published', updatedAt: OLD, hasEligibleVersion: false }, // skipped by design
      { id: 5, status: 'Deleted', updatedAt: RECENT }, // doc awaiting the delete queue
      { id: 6, status: 'Unpublished', updatedAt: OLD }, // doc nothing removed
      { id: 7, status: 'Published', availability: 'Unsearchable', updatedAt: OLD },
      { id: 8, status: 'Published', updatedAt: OLD },
    ]);
    // 9 has a document and no Model row at all.
    const index = installIndex({ docs: [1, 5, 6, 8, 9] });

    const r = await run();

    // 5 docs at 3 per page, then the empty page and its confirmation.
    expect(index.scanPages).toBe(4);
    expect(r.complete).toBe(true);
    expect(r.documentsScanned).toBe(5);
    expect(r.pullableScanned).toBe(5);
    expect(r.missing).toEqual({
      candidates: 3,
      residue: [2],
      pending: [3],
      noEligibleVersion: [4],
      resolved: 0,
    });
    expect(r.orphaned).toEqual({
      candidates: 3,
      residue: [6, 9],
      churn: [5],
      byStatus: { Deleted: 1, Unpublished: 1, missing: 1 },
      resolved: 0,
    });
  });

  it('drops a missing candidate the live index has by the re-check', async () => {
    installModels([
      { id: 1, status: 'Published', updatedAt: OLD },
      { id: 2, status: 'Published', updatedAt: OLD },
    ]);
    installIndex({ docs: [1], appearsOnPointLookup: [2] });

    const r = await run();

    expect(r.missing.candidates).toBe(1);
    expect(r.missing.residue).toEqual([]);
    expect(r.missing.resolved).toBe(1);
  });

  it('drops a missing candidate the primary says is no longer pullable', async () => {
    installModels(
      [
        { id: 1, status: 'Published', updatedAt: OLD },
        { id: 2, status: 'Published', updatedAt: OLD },
      ],
      [{ id: 2, status: 'Unpublished', updatedAt: OLD }] // replica is behind
    );
    installIndex({ docs: [1] });

    const r = await run();

    expect(r.missing).toMatchObject({ candidates: 1, residue: [], pending: [], resolved: 1 });
  });

  it('drops an orphan candidate that left the index or became pullable on the primary', async () => {
    installModels(
      [
        { id: 1, status: 'Published', updatedAt: OLD },
        { id: 2, status: 'Deleted', updatedAt: OLD },
        { id: 3, status: 'Unpublished', updatedAt: OLD },
        { id: 4, status: 'Deleted', updatedAt: OLD },
      ],
      [{ id: 3, status: 'Published', updatedAt: OLD }] // republished; replica is behind
    );
    installIndex({ docs: [1, 2, 3, 4], goneOnPointLookup: [2] });

    const r = await run();

    expect(r.orphaned).toEqual({
      candidates: 3,
      residue: [4],
      churn: [],
      byStatus: { Deleted: 1 },
      resolved: 2,
    });
  });

  it('classifies nothing when the index scan fell far short of the document count', async () => {
    installModels([{ id: 1, status: 'Published', updatedAt: OLD }]);
    const index = installIndex({ docs: [1], totalOverride: 50_000 });

    const r = await run();

    // One page, then the full escalating re-ask schedule before the empty page is believed.
    expect(index.scanPages).toBe(2 + EMPTY_PAGE_BACKOFF_MS.length);
    expect(r.complete).toBe(false);
    expect(r.missing.residue).toEqual([]);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('summarizeReconcile', () => {
  const clean = (): ModelsIndexReconcileResult => ({
    indexName: 'models_v9',
    complete: true,
    totalInIndex: 10,
    documentsScanned: 10,
    pullableScanned: 10,
    missing: { candidates: 0, residue: [], pending: [], noEligibleVersion: [], resolved: 0 },
    orphaned: { candidates: 0, residue: [], churn: [], byStatus: {}, resolved: 0 },
  });

  it('is info when only churn disagrees', () => {
    const r = clean();
    r.missing.pending = [1];
    r.orphaned.churn = [2];
    expect(summarizeReconcile(r).level).toBe('info');
  });

  it('is an error for one residue id in either direction', () => {
    const missing = clean();
    missing.missing.residue = [1];
    const orphaned = clean();
    orphaned.orphaned.residue = [1];
    expect(summarizeReconcile(missing).level).toBe('error');
    expect(summarizeReconcile(orphaned).level).toBe('error');
  });

  it('is an error when the scan did not complete', () => {
    expect(summarizeReconcile({ ...clean(), complete: false }).level).toBe('error');
  });
});

describe('sortedDifference', () => {
  it('returns ids of the first ascending list absent from the second', () => {
    expect(sortedDifference([1, 2, 4, 7, 9], [2, 3, 7, 8])).toEqual([1, 4, 9]);
    expect(sortedDifference([1, 2], [])).toEqual([1, 2]);
    expect(sortedDifference([], [1])).toEqual([]);
  });
});
