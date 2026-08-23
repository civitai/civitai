import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the `cleanupIndex` keyset scan loop.
 *
 * The loop used to end a scan on two signals that do not mean "end of index":
 *
 *  (b) a SHORT page — fewer hits than the requested `limit`. The engine caps a
 *      page at the index's own `pagination.maxTotalHits`, and may return fewer
 *      for reasons of its own, so "short" and "done" are different statements.
 *  (c) the FIRST empty page — which the engine can also produce transiently
 *      while it is concurrently applying document additions/deletions.
 *
 * Either one ends the scan mid-index while the run reports success, so the
 * stale documents past the stopping point are never deleted. A third defect
 * (a) sits alongside them: the requested page size was never clamped to the
 * index's real ceiling, so raising it truncated pages instead of speeding the
 * scan up — and, combined with (b), ended the scan after a single page.
 *
 * Every expectation below is a literal page sequence / count written from the
 * fixture, never read back off the implementation.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

// The index handle the scan drives. Swapped per test via `setFakeIndex`.
// Spreads the original so every other export of the client module stays real —
// only the `searchClient` seam is replaced.
const { indexHolder } = vi.hoisted(() => ({ indexHolder: { current: null as unknown } }));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => indexHolder.current },
}));

import type * as MeiliClient from '~/server/meilisearch/client';
// `~/server/db/client` is a CANONICAL shared-module mock: it is registered once,
// globally, in src/__tests__/setup.ts and reset per test file. This file must not
// mock it itself — a per-file mock object freezes that file's shape for every
// later file that shares the worker. See docs/testing/shared-module-mocks.md.
import { dbMock } from '~/__tests__/mocks/db.mock';

import { CLEANUP_INDEXES, cleanupIndex } from '~/server/meilisearch/cleanup';

// `$queryRaw` answers "which of these ids are still valid?". Returning an
// empty row set means every scanned id counts as stale, which makes
// `staleFound` equal `idsScanned` and gives the tests a second, independent
// witness of how far the scan actually got.
//
// The scan reads through `dbRead` only. `dbRead` and `dbWrite` are DISTINCT
// nodes in the canonical mock, so naming the wrong one here would silently
// assert nothing.
const queryRaw = dbMock.dbRead.$queryRaw;

// ─── Fake index ─────────────────────────────────────────────────────────────

type SearchParams = { filter: string; limit: number; sort?: string[] };

/**
 * A stand-in for one Meilisearch index.
 *
 * `docs` is the full ascending contents. A search is answered by walking past
 * the `id > N` cursor in the filter, then truncating to the smallest of:
 *   - the `limit` the caller asked for,
 *   - `maxTotalHits` (the engine's real per-index page ceiling),
 *   - `pageCap` (an extra, deliberately-short page, to model an engine that
 *     simply returns fewer than asked for).
 *
 * `emptyOnCalls` forces specific 1-based search calls to answer with an empty
 * page regardless of contents — the transient-empty case.
 */
function makeFakeIndex(opts: {
  docs: number[];
  pageCap?: number;
  maxTotalHits?: number | null;
  emptyOnCalls?: number[];
}) {
  const searchCalls: { filter: string; limit: number }[] = [];
  const deleted: number[][] = [];
  let calls = 0;

  const index = {
    getStats: async () => ({ numberOfDocuments: opts.docs.length }),
    getSettings: async () => ({
      filterableAttributes: ['id'],
      sortableAttributes: ['id'],
      ...(opts.maxTotalHits === undefined
        ? {}
        : { pagination: { maxTotalHits: opts.maxTotalHits } }),
    }),
    search: async (_q: string, params: SearchParams) => {
      calls += 1;
      searchCalls.push({ filter: params.filter, limit: params.limit });
      if (opts.emptyOnCalls?.includes(calls)) return { hits: [] as { id: number }[] };
      const match = /^id > (-?\d+)$/.exec(params.filter);
      if (!match) throw new Error(`unexpected filter: ${params.filter}`);
      const cursor = Number(match[1]);
      const cap = Math.min(
        params.limit,
        opts.maxTotalHits ?? Number.POSITIVE_INFINITY,
        opts.pageCap ?? Number.POSITIVE_INFINITY
      );
      const hits = opts.docs
        .filter((d) => d > cursor)
        .slice(0, cap)
        .map((id) => ({ id }));
      return { hits };
    },
    deleteDocuments: async (ids: number[]) => {
      deleted.push([...ids]);
      return { taskUid: 1 };
    },
  };

  return { index, searchCalls, deleted };
}

function setFakeIndex(fake: { index: unknown }) {
  indexHolder.current = fake.index;
}

// A real config, so the scan runs the production Prisma predicate rather than
// a hand-written stand-in.
const modelsCfg = CLEANUP_INDEXES.find((c) => c.key === 'models');
if (!modelsCfg) throw new Error('models cleanup config missing');

beforeEach(() => {
  // MUTATE the canonical node, never replace it: consumer modules captured this
  // exact function identity when they were first evaluated and will not re-read
  // it. `mockClear` drops call history but keeps the implementation, which is
  // why it is used here in place of `mockReset`.
  queryRaw.mockClear();
  queryRaw.mockResolvedValue([]);
});

// ─── (b) a short page is not the end of the index ───────────────────────────

describe('cleanupIndex: a SHORT page does not end the scan', () => {
  it('reaches the last document when every page comes back shorter than the requested batch', async () => {
    // 10 documents, batch of 10 requested, but the engine only ever hands back
    // 3 per page. Pre-fix, page 1 (3 hits < batch 10) ended the scan and the
    // remaining 7 documents were never examined.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pageCap: 3 });
    setFakeIndex(fake);

    const stats = await cleanupIndex(modelsCfg, { apply: false, batch: 10 });

    expect(stats.idsScanned).toBe(10);
    expect(stats.staleFound).toBe(10);
    expect(stats.batchesProcessed).toBe(4);
    expect(stats.totalInIndex).toBe(10);
    expect(stats.errors).toBe(0);

    // Literal cursor walk: four content pages, then an empty page and its
    // confirmation at the same cursor.
    expect(fake.searchCalls.map((c) => c.filter)).toEqual([
      'id > -1',
      'id > 3',
      'id > 6',
      'id > 9',
      'id > 10',
      'id > 10',
    ]);
  });
});

// ─── (c) one empty page is not the end of the index ─────────────────────────

describe('cleanupIndex: a single empty page does not end the scan', () => {
  it('continues past a transient empty page and still scans every document', async () => {
    // 6 documents at a batch of 2, so every content page is FULL — this test
    // is isolated from the short-page defect. Search call #2 answers empty
    // even though ids 3..6 are still ahead of the cursor. Pre-fix that ended
    // the scan at 2 of 6 documents and the run reported success.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6], emptyOnCalls: [2] });
    setFakeIndex(fake);

    const stats = await cleanupIndex(modelsCfg, { apply: false, batch: 2 });

    expect(stats.idsScanned).toBe(6);
    expect(stats.staleFound).toBe(6);
    expect(stats.batchesProcessed).toBe(3);
    expect(stats.errors).toBe(0);

    // Call 2 is the transient empty; call 3 re-asks the SAME cursor and gets
    // rows, so the scan carries on. Calls 5 and 6 are the genuine end.
    expect(fake.searchCalls.map((c) => c.filter)).toEqual([
      'id > -1',
      'id > 2',
      'id > 2',
      'id > 4',
      'id > 6',
      'id > 6',
    ]);
  });

  it('ends the scan when the empty page is confirmed empty (two in a row)', async () => {
    // Guards the other direction: the confirmation must not turn the
    // terminator into an infinite loop. 3 documents, batch 3.
    const fake = makeFakeIndex({ docs: [1, 2, 3] });
    setFakeIndex(fake);

    const stats = await cleanupIndex(modelsCfg, { apply: false, batch: 3 });

    expect(stats.idsScanned).toBe(3);
    expect(stats.batchesProcessed).toBe(1);
    expect(fake.searchCalls.map((c) => c.filter)).toEqual(['id > -1', 'id > 3', 'id > 3']);
  });
});

// ─── (a) the batch is clamped to the index's own ceiling ────────────────────

describe('cleanupIndex: the effective batch is clamped to pagination.maxTotalHits', () => {
  it('clamps a requested batch above the index ceiling and still completes the scan', async () => {
    // The index will not serve a page larger than 5. Asking for 1000 pre-fix
    // meant every page came back at 5 — short — and the scan stopped after
    // one page with 7 of the 12 documents unexamined.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxTotalHits: 5 });
    setFakeIndex(fake);

    const stats = await cleanupIndex(modelsCfg, { apply: false, batch: 1000 });

    expect(stats.idsScanned).toBe(12);
    expect(stats.batchesProcessed).toBe(3);
    expect(stats.errors).toBe(0);

    // Every request asks for the ceiling, not the (unservable) 1000.
    expect(fake.searchCalls.map((c) => c.limit)).toEqual([5, 5, 5, 5, 5]);
    expect(fake.searchCalls.map((c) => c.filter)).toEqual([
      'id > -1',
      'id > 5',
      'id > 10',
      'id > 12',
      'id > 12',
    ]);
  });

  it('INVARIANT GUARD (green on unfixed code): a ceiling above the requested batch does not raise it', async () => {
    // Not a regression test — the pre-change code also sent limit 2 here,
    // because it never read the ceiling at all. Kept to pin the clamp as a
    // MINIMUM rather than an assignment.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4], maxTotalHits: 100000 });
    setFakeIndex(fake);

    const stats = await cleanupIndex(modelsCfg, { apply: false, batch: 2 });

    expect(fake.searchCalls.every((c) => c.limit === 2)).toBe(true);
    expect(stats.idsScanned).toBe(4);
  });
});
