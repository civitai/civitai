import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for `cleanupIndex`: the keyset scan loop, and the delete
 * path it feeds.
 *
 * The loop used to end a scan on two signals that do not mean "end of index":
 *
 *  (b) a SHORT page — fewer hits than the requested `limit`. The engine caps a
 *      page at the index's own `pagination.maxTotalHits`, and may return fewer
 *      for reasons of its own, so "short" and "done" are different statements.
 *  (c) the FIRST empty page — which the engine can also produce transiently
 *      while it is concurrently applying document additions/deletions.
 *
 * Either one ends the scan mid-index while the run reports success. A third
 * defect (a) sits alongside them: the requested page size was never clamped to
 * the index's real ceiling.
 *
 * Making the scan run to the end then created two hazards of its own, and the
 * `apply: true` suites below exist for those:
 *
 *  (d) deletions used to be accumulated for the WHOLE index and flushed only
 *      after the scan, so a cancelled run deleted NOTHING — strictly worse than
 *      the truncated behaviour it replaced.
 *  (e) eligibility is judged from a read replica, and a scan that now reaches
 *      the freshly-written high-id tail can call an unreplicated row stale and
 *      delete a live document.
 *
 * Every expectation below is a literal page/chunk sequence or count written
 * from the fixture, never read back off the implementation.
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

// The two eligibility lookups the code makes, and they are DIFFERENT questions:
//   dbRead  — the cheap filter run over every scanned page.
//   dbWrite — the primary, re-asked over the small stale set immediately before
//             deleting, so replication lag cannot delete a live document.
// `dbRead` and `dbWrite` are distinct nodes in the canonical mock, so naming
// the wrong one silently asserts nothing. Each returns the rows that ARE still
// eligible; anything scanned and absent from that answer is stale.
const readQuery = dbMock.dbRead.$queryRaw;
const writeQuery = dbMock.dbWrite.$queryRaw;

const rows = (ids: number[]) => ids.map((id) => ({ id }));

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
 * page regardless of contents — the transient-empty case. `frozenPage` ignores
 * the cursor entirely and always answers with the same ids, which is the
 * non-advancing-cursor case the monotonicity guard exists for.
 */
function makeFakeIndex(opts: {
  docs: number[];
  pageCap?: number;
  maxTotalHits?: number | null;
  emptyOnCalls?: number[];
  frozenPage?: number[];
  isIndexing?: boolean;
  onSearch?: (call: number) => void;
}) {
  const searchCalls: { filter: string; limit: number }[] = [];
  const deleted: number[][] = [];
  // How many searches had been issued at the moment each delete was made. This
  // is what distinguishes "deleted while scanning" from "deleted after the
  // scan": the CHUNK LIST alone cannot, because accumulating everything and
  // then chunking produces exactly the same chunks in the same order.
  const deletedAfterSearches: number[] = [];
  let calls = 0;

  const index = {
    getStats: async () => ({
      numberOfDocuments: opts.docs.length,
      isIndexing: opts.isIndexing ?? false,
    }),
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
      opts.onSearch?.(calls);
      if (opts.frozenPage) return { hits: rows(opts.frozenPage) };
      if (opts.emptyOnCalls?.includes(calls)) return { hits: [] as { id: number }[] };
      const match = /^id > (-?\d+)$/.exec(params.filter);
      if (!match) throw new Error(`unexpected filter: ${params.filter}`);
      const cursor = Number(match[1]);
      const cap = Math.min(
        params.limit,
        opts.maxTotalHits ?? Number.POSITIVE_INFINITY,
        opts.pageCap ?? Number.POSITIVE_INFINITY
      );
      return { hits: rows(opts.docs.filter((d) => d > cursor).slice(0, cap)) };
    },
    deleteDocuments: async (ids: number[]) => {
      deleted.push([...ids]);
      deletedAfterSearches.push(calls);
      return { taskUid: 1 };
    },
  };

  return { index, searchCalls, deleted, deletedAfterSearches };
}

function setFakeIndex(fake: { index: unknown }) {
  indexHolder.current = fake.index;
}

/** A JobContext whose status the test can flip, matching `createJob`'s contract. */
function makeJobContext() {
  const ctx = {
    status: 'running' as 'running' | 'canceled' | 'finished',
    on: () => undefined,
    checkIfCanceled: () => {
      if (ctx.status !== 'running') throw new Error('Job has ended');
    },
  };
  return ctx;
}

// A real config, so the scan runs the production Prisma predicate rather than
// a hand-written stand-in.
const modelsCfg = CLEANUP_INDEXES.find((c) => c.key === 'models');
if (!modelsCfg) throw new Error('models cleanup config missing');

beforeEach(() => {
  // MUTATE the canonical nodes, never replace them: consumer modules captured
  // these exact function identities when they were first evaluated and will not
  // re-read them. `mockClear` drops call history but keeps the implementation,
  // which is why it is used here in place of `mockReset`.
  readQuery.mockClear();
  writeQuery.mockClear();
  // Default for the scan suites: nothing is eligible, so every scanned id is
  // stale. That makes `staleFound` equal `idsScanned` and gives those tests a
  // second, independent witness of how far the scan got.
  readQuery.mockResolvedValue([]);
  writeQuery.mockResolvedValue([]);
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
    expect(stats.stoppedEarly).toBe(false);

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
    expect(stats.stoppedEarly).toBe(false);

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
    expect(stats.stoppedEarly).toBe(false);
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

// ─── a failed eligibility lookup skips a batch without ending the scan ──────

describe('cleanupIndex: a batch whose eligibility lookup fails is SKIPPED, not fatal', () => {
  it('counts the skipped ids, advances past them, and still reaches the end of the index', async () => {
    // The distinction the job's log depends on: the cursor advances past a
    // batch whose lookup failed, so the scan CAN reach the end of the index
    // having skipped some ids. "Stopped early" and "skipped a batch" are
    // therefore different facts and must be counted separately.
    //
    // Three consecutive rejections exhaust the retry envelope for page 1.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6] });
    setFakeIndex(fake);
    readQuery
      .mockRejectedValueOnce(new Error('replica blip'))
      .mockRejectedValueOnce(new Error('replica blip'))
      .mockRejectedValueOnce(new Error('replica blip'))
      .mockResolvedValue([]);

    const stats = await cleanupIndex(modelsCfg, { apply: false, batch: 3 });

    // Page 1 (ids 1-3) was fetched but never judged; page 2 (ids 4-6) was.
    expect(stats.idsSkipped).toBe(3);
    expect(stats.idsScanned).toBe(3);
    expect(stats.staleFound).toBe(3);
    expect(stats.batchesProcessed).toBe(1);
    expect(stats.errors).toBe(1);
    // The whole point: the scan did NOT stop early.
    expect(stats.stoppedEarly).toBe(false);
    expect(fake.searchCalls.map((c) => c.filter)).toEqual([
      'id > -1',
      'id > 3',
      'id > 6',
      'id > 6',
    ]);
  });
});

// ─── the index's own indexing state is carried through ──────────────────────

describe('cleanupIndex: isIndexing is reported, not assumed', () => {
  it('carries the engine-reported indexing state into the stats', async () => {
    // The job suppresses its coverage verdict when the count was taken
    // mid-ingest, so this flag has to be the engine's answer rather than a
    // constant.
    const busy = makeFakeIndex({ docs: [1, 2], isIndexing: true });
    setFakeIndex(busy);
    expect((await cleanupIndex(modelsCfg, { apply: false, batch: 2 })).indexingAtStart).toBe(true);

    const idle = makeFakeIndex({ docs: [1, 2], isIndexing: false });
    setFakeIndex(idle);
    expect((await cleanupIndex(modelsCfg, { apply: false, batch: 2 })).indexingAtStart).toBe(false);
  });
});

// ─── the cursor must strictly advance ───────────────────────────────────────

describe('cleanupIndex: the cursor must strictly advance', () => {
  it('aborts with an error instead of spinning when a page does not advance the cursor', async () => {
    // `frozenPage` ignores the filter and answers [7] forever. Termination now
    // rests entirely on the cursor, so without the guard this re-issues the
    // identical query until `maxBatches` — which is Infinity from the cron.
    // `maxBatches` is set here ONLY so the unguarded behaviour fails an
    // assertion quickly instead of hanging the suite for the whole timeout.
    const fake = makeFakeIndex({ docs: [7], frozenPage: [7] });
    setFakeIndex(fake);

    const stats = await cleanupIndex(modelsCfg, { apply: false, batch: 5, maxBatches: 50 });

    // Batch 1 is judged (cursor -1 → 7 advances). Batch 2 returns 7 again, so
    // the guard fires and the scan stops.
    expect(stats.batchesProcessed).toBe(1);
    expect(stats.idsScanned).toBe(1);
    expect(stats.errors).toBe(1);
    expect(stats.stoppedEarly).toBe(true);
    expect(fake.searchCalls.map((c) => c.filter)).toEqual(['id > -1', 'id > 7']);
  });
});

// ─── the delete path: only stale ids, and only what the PRIMARY confirms ────

describe('cleanupIndex: only stale documents are deleted', () => {
  it('deletes exactly the ineligible ids and leaves every eligible one alone', async () => {
    // 10 documents; the even ones are still eligible. Nothing about the
    // fixture makes stale == scanned, so a mutation that marks every scanned
    // document for deletion changes the observed delete list.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    setFakeIndex(fake);
    readQuery.mockResolvedValue(rows([2, 4, 6, 8, 10]));
    writeQuery.mockResolvedValue(rows([2, 4, 6, 8, 10]));

    const stats = await cleanupIndex(modelsCfg, { apply: true, batch: 10 });

    expect(fake.deleted).toEqual([[1, 3, 5, 7, 9]]);
    expect(stats.idsScanned).toBe(10);
    expect(stats.staleFound).toBe(5);
    expect(stats.deleted).toBe(5);
    expect(stats.rescuedByPrimary).toBe(0);
    expect(stats.errors).toBe(0);

    // Stated separately and positively: no eligible id was passed to a delete.
    const everyDeletedId = fake.deleted.flat();
    for (const eligible of [2, 4, 6, 8, 10]) expect(everyDeletedId).not.toContain(eligible);
  });

  it('does not delete an id the PRIMARY still says is eligible (replication lag)', async () => {
    // The replica has not caught up on 3 and 4, so it reports them ineligible.
    // The primary knows better. Only 1 and 2 may be deleted.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6] });
    setFakeIndex(fake);
    readQuery.mockResolvedValue(rows([5, 6]));
    writeQuery.mockResolvedValue(rows([3, 4, 5, 6]));

    const stats = await cleanupIndex(modelsCfg, { apply: true, batch: 6 });

    expect(fake.deleted).toEqual([[1, 2]]);
    expect(stats.staleFound).toBe(4);
    expect(stats.deleted).toBe(2);
    expect(stats.rescuedByPrimary).toBe(2);
    const everyDeletedId = fake.deleted.flat();
    expect(everyDeletedId).not.toContain(3);
    expect(everyDeletedId).not.toContain(4);
  });

  it('deletes NOTHING when the primary re-check cannot be completed', async () => {
    // The safe failure direction: an undeleted stale document is picked up by
    // the next run; a wrongly deleted live one is not.
    const fake = makeFakeIndex({ docs: [1, 2, 3] });
    setFakeIndex(fake);
    readQuery.mockResolvedValue([]);
    writeQuery.mockRejectedValue(new Error('primary unreachable'));

    const stats = await cleanupIndex(modelsCfg, { apply: true, batch: 3 });

    expect(fake.deleted).toEqual([]);
    expect(stats.deleted).toBe(0);
    expect(stats.staleFound).toBe(3);
    expect(stats.errors).toBeGreaterThanOrEqual(1);
  });

  it('INVARIANT GUARD (green on unfixed code): apply:false never calls deleteDocuments', async () => {
    const fake = makeFakeIndex({ docs: [1, 2, 3] });
    setFakeIndex(fake);

    const stats = await cleanupIndex(modelsCfg, { apply: false, batch: 3 });

    expect(fake.deleted).toEqual([]);
    expect(stats.deleted).toBe(0);
    expect(stats.staleFound).toBe(3);
  });
});

// ─── (d) deletions are flushed as the scan runs ─────────────────────────────

describe('cleanupIndex: deletions are flushed incrementally', () => {
  it('deletes in chunks while the scan is still running, not once at the end', async () => {
    // 9 documents, 3 per page, chunk size 2. Everything is stale.
    // Pages [1,2,3] [4,5,6] [7,8,9]; the pending list is drained to whole
    // chunks after each page, and the remainder goes out in the final flush.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    setFakeIndex(fake);

    const stats = await cleanupIndex(modelsCfg, {
      apply: true,
      batch: 3,
      deleteChunkSize: 2,
    });

    expect(fake.deleted).toEqual([[1, 2], [3, 4], [5, 6], [7, 8], [9]]);

    // 🔴 The load-bearing assertion, and it comes FIRST deliberately. The chunk
    // LIST above is identical whether
    // deletions are flushed as the scan runs or accumulated and chunked at the
    // end, so on its own it proves nothing. This pins WHEN each delete
    // happened, counted in searches already issued: the first chunk goes out
    // after page 1, not after the whole index has been walked.
    //
    // Pages are searches 1-3; 4 is the empty page and 5 its confirmation, so
    // the trailing 5 is the final flush of the remainder. Accumulating first
    // would make every entry 5.
    expect(fake.deletedAfterSearches).toEqual([1, 2, 2, 3, 5]);

    expect(stats.deleted).toBe(9);
    expect(stats.stoppedEarly).toBe(false);
  });

  it('KEEPS what it already deleted when the job is cancelled mid-scan', async () => {
    // The regression this exists for: batching every deletion until after the
    // scan made a cancelled run delete NOTHING — the scan broke, then the
    // delete loop broke at chunk 0. That is strictly worse than the truncated
    // behaviour it replaced, which at least deleted the prefix it reached.
    //
    // Cancellation is raised from `onBatch` after the 2nd page, which is the
    // point the request socket closing would reach — before that page's flush.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    setFakeIndex(fake);
    const jobContext = makeJobContext();
    let batchesSeen = 0;

    const stats = await cleanupIndex(modelsCfg, {
      apply: true,
      batch: 3,
      deleteChunkSize: 2,
      jobContext: jobContext as never,
      onBatch: () => {
        batchesSeen += 1;
        if (batchesSeen === 2) jobContext.status = 'canceled';
      },
    });

    // Page 1 flushed [1,2] before the cancellation; page 2's flush and the
    // final flush both bail. The point is that this is NOT empty.
    expect(batchesSeen).toBe(2);
    expect(fake.deleted).toEqual([[1, 2]]);
    expect(stats.deleted).toBe(2);
  });
});
