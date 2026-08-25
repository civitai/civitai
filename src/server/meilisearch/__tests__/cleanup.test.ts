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
// `~/server/redis/client` is a CANONICAL shared-module mock too — same rule, same reason.
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

import {
  CLEANUP_INDEXES,
  cleanupIndex,
  EMPTY_PAGE_BACKOFF_BUDGET_MS,
  EMPTY_PAGE_BACKOFF_MS,
  EMPTY_PAGE_CONFIRM_DELAY_MS,
  EMPTY_PAGE_TRUST_COVERAGE,
} from '~/server/meilisearch/cleanup';
import { MAX_CURSOR_AGE_MS, readScanCursor } from '~/server/meilisearch/cleanup-cursor';

/** ids 1..n, dense — the fixtures below need indexes big enough to clear the absolute
 *  shortfall floor, which no toy fixture can. */
const idsUpTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

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
  /** Override the document count the engine reports, when it must differ from `docs`. */
  totalOverride?: number;
}) {
  const searchCalls: { filter: string; limit: number }[] = [];
  // Every id the engine actually handed back, page by page. The cumulative-progress
  // test asserts on the UNION of these across two runs — a per-run count cannot tell
  // "run 2 covered nine documents" from "run 2 re-covered the same three, twice".
  const served: number[][] = [];
  const deleted: number[][] = [];
  // How many searches had been issued at the moment each delete was made. This
  // is what distinguishes "deleted while scanning" from "deleted after the
  // scan": the CHUNK LIST alone cannot, because accumulating everything and
  // then chunking produces exactly the same chunks in the same order.
  const deletedAfterSearches: number[] = [];
  let calls = 0;

  const index = {
    getStats: async () => ({
      numberOfDocuments: opts.totalOverride ?? opts.docs.length,
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
      if (opts.frozenPage) {
        served.push([...opts.frozenPage]);
        return { hits: rows(opts.frozenPage) };
      }
      if (opts.emptyOnCalls?.includes(calls)) {
        served.push([]);
        return { hits: [] as { id: number }[] };
      }
      const match = /^id > (-?\d+)$/.exec(params.filter);
      if (!match) throw new Error(`unexpected filter: ${params.filter}`);
      const cursor = Number(match[1]);
      const cap = Math.min(
        params.limit,
        opts.maxTotalHits ?? Number.POSITIVE_INFINITY,
        opts.pageCap ?? Number.POSITIVE_INFINITY
      );
      const hits = opts.docs.filter((d) => d > cursor).slice(0, cap);
      served.push([...hits]);
      return { hits: rows(hits) };
    },
    deleteDocuments: async (ids: number[]) => {
      deleted.push([...ids]);
      deletedAfterSearches.push(calls);
      return { taskUid: 1 };
    },
  };

  return { index, searchCalls, deleted, deletedAfterSearches, served };
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

// ─── Cursor store ───────────────────────────────────────────────────────────

/**
 * A real in-memory hash behind the canonical `sysRedis` node, so the cursor tests run
 * the PRODUCTION store module — its JSON encoding, its validation and its staleness
 * bound — instead of a hand-written stand-in that could agree with a wrong
 * implementation. The seam replaced is the redis command, which is the lowest one
 * available; everything above it is the code under test.
 */
const cursorHash = new Map<string, string>();
const CURSORS_KEY = REDIS_SYS_KEYS.SEARCH_INDEX_CLEANUP.CURSORS;

function installCursorStore() {
  cursorHash.clear();
  // Call history pools across a whole file (the canonical mocks reset per FILE, not per
  // test), so the "never touched the store" case would otherwise read every earlier
  // test's calls as its own.
  redisMock.sysRedis.hGet.mockClear();
  redisMock.sysRedis.hSet.mockClear();
  redisMock.sysRedis.hDel.mockClear();
  redisMock.sysRedis.hGet.mockImplementation(async (key: string, field: string) =>
    key === CURSORS_KEY ? cursorHash.get(field) ?? null : null
  );
  redisMock.sysRedis.hSet.mockImplementation(async (key: string, field: string, value: string) => {
    if (key === CURSORS_KEY) cursorHash.set(field, String(value));
    return 1;
  });
  redisMock.sysRedis.hDel.mockImplementation(async (key: string, field: string) => {
    if (key !== CURSORS_KEY) return 0;
    return cursorHash.delete(field) ? 1 : 0;
  });
}

/** Write a stored cursor exactly as production would, without going through a scan. */
function seedCursor(key: string, cursor: { lastId: number; startedAt: number; covered: number }) {
  cursorHash.set(key, JSON.stringify(cursor));
}

function storedCursor(key: string) {
  const raw = cursorHash.get(key);
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, number>);
}

/**
 * Records the delays the scan ASKS for and resolves immediately.
 *
 * The escalation is the property under test and it is 30 s of real waiting — a suite
 * that actually spent it could not run, and one that shrank the constants would be
 * asserting against its own fixture rather than the shipped schedule.
 */
function makeDelayRecorder() {
  const delays: number[] = [];
  return { delays, delay: async (ms: number) => void delays.push(ms) };
}

beforeEach(() => {
  installCursorStore();
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

// ═══════════════════════════════════════════════════════════════════════════
// Cross-run cursor persistence
//
// The defect: the scan always restarted at the bottom of the index. A pass that
// cannot walk a multi-million-document index inside one nightly run therefore
// re-walked the same already-clean prefix every night and could never reach the
// region past its stopping point — measured in production, the boundary of the
// un-scanned region did not move by a single id across two consecutive runs.
//
// 🔴 No page size fixes this. A from-scratch scan that cannot finish in one run
// makes ZERO cumulative progress by construction, whatever the page size.
// ═══════════════════════════════════════════════════════════════════════════

describe('cleanupIndex: a truncated pass RESUMES rather than restarting', () => {
  it('starts the next page from the stored cursor, not from the bottom of the index', async () => {
    // Stored: lastId 6, covered 5. Deliberately DIFFERENT numbers — an
    // implementation that seeded the carried coverage from the cursor id (or vice
    // versa) would be invisible if they matched. `covered` is legitimately lower
    // than `lastId` here: ids are not dense, and documents are deleted from under
    // the cursor while a pass runs.
    seedCursor('models', { lastId: 6, startedAt: Date.now() - 60_000, covered: 5 });
    // The engine reports 8 documents against ten real ones: `totalInIndex` is a
    // pre-scan snapshot of an index other jobs delete from continuously, and one
    // index has legitimately reported coverage slightly ABOVE 1 for that reason.
    // Every number in this fixture is distinct from every other.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], totalOverride: 8 });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 3,
      resumable: true,
      delay: rec.delay,
    });

    // 🔴 The first request is `id > 6`, NOT `id > -1` (the un-fixed behaviour),
    // `id > 7` (resume-past-the-cursor, which skips one document every run,
    // permanently) or `id > 5` (resume-before-it, which re-walks one document).
    expect(fake.searchCalls.map((c) => c.filter)).toEqual([
      'id > 6',
      'id > 9',
      'id > 10',
      'id > 10',
    ]);
    expect(stats.resumedFrom).toBe(6);
    expect(stats.cursorDiscardReason).toBe(null);
    // Four ids scanned this run (7,8,9,10); the pass has now covered 5 + 4 = 9.
    // Every number here is distinct from every other, and from the index total.
    expect(stats.idsScanned).toBe(4);
    expect(stats.passCovered).toBe(9);
    expect(stats.totalInIndex).toBe(8);
    expect(stats.stoppedEarly).toBe(false);
  });

  it('RESETS the cursor when the pass genuinely reaches the end, so the next run starts over', async () => {
    // Without the reset the cursor sits at the top of the index forever and the
    // low-id region — where a document that was eligible when indexed and has
    // since gone stale actually lives — is never re-examined again.
    seedCursor('models', { lastId: 4, startedAt: Date.now() - 60_000, covered: 4 });
    const first = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8] });
    setFakeIndex(first);
    const rec = makeDelayRecorder();

    const one = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 8,
      resumable: true,
      delay: rec.delay,
    });

    expect(one.resumedFrom).toBe(4);
    expect(one.cursorPersisted).toBe(null);
    expect(storedCursor('models')).toBeUndefined();

    // Stated behaviourally, not just as an empty map: the very next run walks the
    // whole index from the bottom again.
    const second = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8] });
    setFakeIndex(second);
    const two = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 8,
      resumable: true,
      delay: rec.delay,
    });

    expect(two.resumedFrom).toBe(null);
    expect(two.cursorDiscardReason).toBe('missing');
    expect(second.searchCalls[0].filter).toBe('id > -1');
    expect(two.idsScanned).toBe(8);
  });

  it('does NOT reset the cursor when a confirmed-empty page arrives at low coverage', async () => {
    // The trap this exists for: an empty page is the exact signal the engine
    // produces transiently under write load, so treating it as "reached the end"
    // and clearing the cursor would carry the original defect straight into the
    // new mechanism — every truncated pass would clear and restart at the bottom,
    // and cumulative progress would still be zero, now with a cursor bolted on.
    //
    // 8000 documents; the scan is fed one page of 300 and then nothing.
    const fake = makeFakeIndex({
      docs: idsUpTo(8000),
      emptyOnCalls: [2, 3, 4, 5, 6, 7],
    });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 300,
      resumable: true,
      delay: rec.delay,
    });

    // The loop DID exit through its terminator — that is not in dispute and the
    // reporting is unchanged.
    expect(stats.stoppedEarly).toBe(false);
    // But 300 of 8000 is not a pass that reached the end, so the cursor is kept.
    expect(stats.passCovered).toBe(300);
    expect(stats.cursorPersisted).toBe(300);
    expect(stats.cursorCleared).toBe(false);
    expect(storedCursor('models')).toMatchObject({ lastId: 300, covered: 300 });
  });

  it('persists where it got to when the scan STOPS EARLY', async () => {
    // A run killed by the job lock, a cancellation or an unrecoverable engine
    // error is the commonest truncation of all, and it must not throw its
    // position away either.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    setFakeIndex(fake);
    const jobContext = makeJobContext();
    const rec = makeDelayRecorder();
    let batchesSeen = 0;

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 3,
      resumable: true,
      delay: rec.delay,
      jobContext: jobContext as never,
      onBatch: () => {
        batchesSeen += 1;
        if (batchesSeen === 2) jobContext.status = 'canceled';
      },
    });

    expect(stats.stoppedEarly).toBe(true);
    expect(stats.idsScanned).toBe(6);
    expect(stats.cursorPersisted).toBe(6);
    expect(storedCursor('models')).toMatchObject({ lastId: 6, covered: 6 });
  });

  it('counts ids the cursor walked past WITHOUT judging toward the pass coverage', async () => {
    // A batch whose eligibility lookup failed is skipped, but the cursor advances
    // past it — so those ids were covered by the scan's POSITION even though they
    // were not examined. Leaving them out understates coverage, which then refutes
    // completion on a pass that really did reach the end, and the cursor is held
    // when it should have rolled over.
    //
    // Pairwise-distinct: 6 / 4 / 9 / 3 / 16 / 18 share no value.
    seedCursor('models', { lastId: 6, startedAt: Date.now() - 60_000, covered: 4 });
    const fake = makeFakeIndex({
      docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();
    // Three consecutive rejections exhaust the retry envelope for the first page.
    readQuery
      .mockRejectedValueOnce(new Error('replica blip'))
      .mockRejectedValueOnce(new Error('replica blip'))
      .mockRejectedValueOnce(new Error('replica blip'))
      .mockResolvedValue([]);

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 3,
      resumable: true,
      delay: rec.delay,
    });

    expect(stats.idsScanned).toBe(9);
    expect(stats.idsSkipped).toBe(3);
    expect(stats.passCovered).toBe(16);
    expect(stats.stoppedEarly).toBe(false);
    // 16 of 18 is a pass that reached the end, so it rolls over.
    expect(storedCursor('models')).toBeUndefined();
  });

  it('makes CUMULATIVE progress: two truncated runs together cover the whole index', async () => {
    // 🔴 The claim the whole change exists for, and it cannot be made by either run
    // on its own. Asserted on the UNION of the ids the engine actually served, not
    // on per-run counts: a run that re-walked the same prefix produces identical
    // counts and a very different union.
    const docs = idsUpTo(8000);
    const rec = makeDelayRecorder();

    // Run 1: one page, then the engine answers empty for the whole confirmation
    // schedule. 300 of 8000 covered, so the pass is not credited and the cursor is kept.
    const runOne = makeFakeIndex({ docs, emptyOnCalls: [2, 3, 4, 5, 6, 7] });
    setFakeIndex(runOne);
    const one = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 300,
      resumable: true,
      delay: rec.delay,
    });

    expect(one.idsScanned).toBe(300);
    expect(one.cursorPersisted).toBe(300);

    // Run 2: same index, engine healthy. It must pick up at 300, not at the bottom.
    const runTwo = makeFakeIndex({ docs });
    setFakeIndex(runTwo);
    const two = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 300,
      resumable: true,
      delay: rec.delay,
    });

    expect(two.resumedFrom).toBe(300);
    expect(runTwo.searchCalls[0].filter).toBe('id > 300');
    expect(two.idsScanned).toBe(7700);
    // The pass total carries run 1's 300 forward, which is what lets run 2 be judged
    // complete despite scanning only 7700 of the 8000 documents itself.
    expect(two.passCovered).toBe(8000);
    expect(two.cursorPersisted).toBe(null);
    expect(two.cursorCleared).toBe(true);
    expect(storedCursor('models')).toBeUndefined();

    const servedOne = runOne.served.flat();
    const servedTwo = runTwo.served.flat();
    // Union: every document, exactly once across the two runs.
    expect([...servedOne, ...servedTwo].sort((a, b) => a - b)).toEqual(docs);
    // Stated separately and positively: run 2 re-walked nothing run 1 had covered.
    for (const id of servedOne) expect(servedTwo).not.toContain(id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 ONE definition of "the pass reached the end"
//
// This shipped with TWO. `cleanupIndex` cleared its cursor at >= 50% coverage;
// the job logged `incomplete: true` below 75%. A pass landing in [0.50, 0.75)
// therefore reported itself truncated at error level AND discarded its resume
// point in the same run — the next run restarted at the bottom, which is the
// defect the cursor exists to fix, intact above 50%.
//
// COVERAGE_BAND below is written as literal fixture values, never read off the
// implementation, and the SAME table drives the job's `incomplete` verdict in
// search-index-cleanup.test.ts. If the two consumers ever disagree again, one
// of the two tables goes red.
// ═══════════════════════════════════════════════════════════════════════════

const COVERAGE_BAND: { total: number; covered: number; reachedEnd: boolean }[] = [
  // total, pass coverage, and whether that counts as having reached the end.
  { total: 8000, covered: 2000, reachedEnd: false }, // 0.250 — both clauses flag
  { total: 8000, covered: 4000, reachedEnd: false }, // 0.500 — the old cursor threshold
  { total: 8000, covered: 4800, reachedEnd: false }, // 0.600 — INSIDE the old gap
  { total: 8000, covered: 6800, reachedEnd: true }, //  0.850 — only the RATIO clause spares it
  { total: 2000, covered: 1200, reachedEnd: true }, //  0.600 — only the FLOOR clause spares it
  { total: 8000, covered: 7900, reachedEnd: true }, //  0.9875 — comfortably finished
];

describe('cleanupIndex: keeping the cursor and reporting incomplete are ONE decision', () => {
  for (const { total, covered, reachedEnd } of COVERAGE_BAND) {
    it(`covered ${covered} of ${total} → ${
      reachedEnd ? 'clears' : 'KEEPS'
    } the cursor`, async () => {
      // One page of `covered` ids, then the engine answers empty for the whole
      // confirmation schedule — a truncated pass that exits through the terminator,
      // which is the only case where coverage decides anything.
      const fake = makeFakeIndex({
        docs: idsUpTo(total),
        emptyOnCalls: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      });
      setFakeIndex(fake);
      const rec = makeDelayRecorder();

      const stats = await cleanupIndex(modelsCfg, {
        apply: false,
        batch: covered,
        resumable: true,
        delay: rec.delay,
      });

      expect(stats.passCovered).toBe(covered);
      expect(stats.stoppedEarly).toBe(false);
      expect(stats.cursorCleared).toBe(reachedEnd);
      expect(stats.cursorPersisted).toBe(reachedEnd ? null : covered);
      expect(storedCursor('models')).toEqual(
        reachedEnd ? undefined : expect.objectContaining({ lastId: covered, covered })
      );
    });
  }

  it('credits a pass the engine was mid-ingest for, however little it covered', async () => {
    // The suppression clause inside the shared predicate: a document count taken
    // while the engine was ingesting is a moving number, so a shortfall against it is
    // not evidence of anything. No resumable fixture exercised this, so deleting the
    // clause changed nothing observable.
    const fake = makeFakeIndex({
      docs: idsUpTo(8000),
      isIndexing: true,
      emptyOnCalls: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 300,
      resumable: true,
      delay: rec.delay,
    });

    // 300 of 8000 would otherwise KEEP the cursor — see the table above.
    expect(stats.passCovered).toBe(300);
    expect(stats.indexingAtStart).toBe(true);
    expect(stats.cursorCleared).toBe(true);
    expect(storedCursor('models')).toBeUndefined();
  });
});

describe('cleanupIndex: a cursor the scan could not advance past is DISCARDED', () => {
  it('clears rather than persists when the monotonicity guard fires', async () => {
    // 🔴 Persisting it wedges the whole index: every later run resumes at the same
    // cursor, trips the same guard on its first page, and examines ZERO documents —
    // for as long as the staleness bound allows. Before the cursor existed, everything
    // below the bad page was still cleaned nightly. Clearing restores exactly that.
    seedCursor('models', { lastId: 5, startedAt: Date.now() - 60_000, covered: 5 });
    const fake = makeFakeIndex({ docs: [7], frozenPage: [7] });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 5,
      maxBatches: 50,
      resumable: true,
      delay: rec.delay,
    });

    expect(stats.stoppedEarly).toBe(true);
    expect(stats.errors).toBe(1);
    expect(stats.cursorPersisted).toBe(null);
    expect(stats.cursorCleared).toBe(true);
    expect(storedCursor('models')).toBeUndefined();
  });
});

describe('cleanupIndex: a stored cursor cannot be carried indefinitely', () => {
  it('pins the bound at seven days', async () => {
    // The boundary cases below are written against the SYMBOL, which is what makes
    // them independent of the value — and therefore blind to the value changing.
    // The choice is load-bearing and argued from the job's cadence: nightly, so
    // seven consecutive resumes, which at the rate the largest index was observed
    // to scan is enough for one full sweep. Widening it silently is how an index
    // drifts into never re-checking early ids.
    expect(MAX_CURSOR_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('resumes from a cursor that is just inside the staleness bound', async () => {
    // Boundary, lower side. Paired with the case below so the bound is observable
    // in BOTH directions — either one alone is satisfied by an implementation that
    // ignores the age entirely, or by one that ignores the cursor entirely.
    seedCursor('models', {
      lastId: 6,
      startedAt: Date.now() - MAX_CURSOR_AGE_MS,
      covered: 5,
    });
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 10,
      resumable: true,
      delay: rec.delay,
    });

    expect(stats.resumedFrom).toBe(6);
    expect(fake.searchCalls[0].filter).toBe('id > 6');
    // The pass covered 5 + 4 = 9 of 10, so it is credited and rolls over. Pins the
    // completion threshold from ABOVE — raising it toward 1 holds a cursor on a pass
    // that plainly finished, and the un-scanned tail of a shrinking index would then
    // wedge the rollover permanently.
    expect(stats.passCovered).toBe(9);
    expect(storedCursor('models')).toBeUndefined();
  });

  it('forces a from-the-bottom pass once a cursor is older than the bound', async () => {
    // Boundary, upper side: one millisecond past. Without this an index that
    // truncates every single night would carry one cursor forever and drift into
    // never re-checking early ids at all.
    seedCursor('models', {
      lastId: 6,
      startedAt: Date.now() - (MAX_CURSOR_AGE_MS + 1),
      covered: 5,
    });
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 10,
      resumable: true,
      delay: rec.delay,
    });

    expect(stats.resumedFrom).toBe(null);
    expect(stats.cursorDiscardReason).toBe('stale');
    expect(fake.searchCalls[0].filter).toBe('id > -1');
    expect(stats.idsScanned).toBe(10);
  });

  it('accepts a cursor that covered exactly as many ids as exist below it', async () => {
    // The upper bound on `covered` is `lastId + 1`, because ids are non-negative and
    // strictly increasing, so a pass standing at id 6 may have walked past ids 0..6 —
    // seven of them. Sitting a fixture ON that boundary is what separates the correct
    // bound from `covered > lastId`, which rejects a legal cursor and silently restarts
    // the pass from the bottom every night.
    seedCursor('models', { lastId: 6, startedAt: Date.now() - 60_000, covered: 7 });
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], totalOverride: 8 });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 10,
      resumable: true,
      delay: rec.delay,
    });

    expect(stats.resumedFrom).toBe(6);
    expect(stats.cursorDiscardReason).toBe(null);
    expect(fake.searchCalls[0].filter).toBe('id > 6');
  });

  it('treats a FUTURE-dated cursor as stale rather than as one that can never expire', async () => {
    // Clock skew (or a hand-edited value) makes the age negative, which passes an
    // upper-bound test forever — the one way the bound could be defeated silently.
    seedCursor('models', { lastId: 6, startedAt: Date.now() + 60_000, covered: 5 });

    const { cursor, reason } = await readScanCursor('models');

    expect(cursor).toBe(null);
    expect(reason).toBe('stale');
  });
});

describe('cleanupIndex: an unusable stored cursor fails SAFE', () => {
  // 🔴 The direction matters more than the detection. Restarting re-examines
  // documents that were already examined, which costs time. Skipping ahead on a
  // value nobody could validate leaves a region of the index unexamined with
  // nothing to indicate it — and this job bulk-deletes.

  const unusable: [string, string, string][] = [
    ['is not JSON at all', 'not json', 'unparseable'],
    ['is JSON but not an object', '42', 'invalid'],
    ['is null', 'null', 'invalid'],
    ['is missing startedAt', '{"lastId":6,"covered":5}', 'invalid'],
    ['carries a non-numeric lastId', '{"lastId":"6","startedAt":1,"covered":5}', 'invalid'],
    ['carries a NaN startedAt', '{"lastId":6,"startedAt":null,"covered":5}', 'invalid'],
    ['carries a negative lastId', '{"lastId":-3,"startedAt":1,"covered":5}', 'invalid'],
    // `covered` is the sole input to BOTH coverage judgements — whether an empty page
    // is believed, and whether the pass is credited — so an absurd value silently
    // credits a pass that covered nothing. None of these were checked at first.
    ['is missing covered', '{"lastId":6,"startedAt":1}', 'invalid'],
    ['carries a non-numeric covered', '{"lastId":6,"startedAt":1,"covered":"5"}', 'invalid'],
    ['carries a negative covered', '{"lastId":6,"startedAt":1,"covered":-5}', 'invalid'],
    [
      'claims to have covered more ids than exist below the cursor',
      '{"lastId":6,"startedAt":1,"covered":9999}',
      'invalid',
    ],
  ];

  for (const [label, raw, reason] of unusable) {
    it(`starts from the beginning when the stored value ${label}`, async () => {
      cursorHash.set('models', raw);
      const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
      setFakeIndex(fake);
      const rec = makeDelayRecorder();

      const stats = await cleanupIndex(modelsCfg, {
        apply: false,
        batch: 10,
        resumable: true,
        delay: rec.delay,
      });

      expect(stats.resumedFrom).toBe(null);
      expect(stats.cursorDiscardReason).toBe(reason);
      expect(fake.searchCalls[0].filter).toBe('id > -1');
      // The whole index, not a suffix of it.
      expect(stats.idsScanned).toBe(10);
    });
  }

  it('starts from the beginning when the store itself cannot be read', async () => {
    redisMock.sysRedis.hGet.mockRejectedValue(new Error('sysRedis unavailable'));
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 10,
      resumable: true,
      delay: rec.delay,
    });

    expect(stats.resumedFrom).toBe(null);
    expect(stats.cursorDiscardReason).toBe('unreadable');
    expect(fake.searchCalls[0].filter).toBe('id > -1');
    expect(stats.idsScanned).toBe(10);
  });

  it('completes the scan and RAISES AN ERROR when the cursor cannot be written back', async () => {
    // The truncated pass loses its position, so the next run restarts at the bottom —
    // defect B, for this index, tonight. Silent, that is indistinguishable from a
    // healthy rollover, because both leave `cursorPersisted: null`.
    redisMock.sysRedis.hSet.mockRejectedValue(new Error('sysRedis unavailable'));
    const fake = makeFakeIndex({
      docs: idsUpTo(8000),
      emptyOnCalls: [2, 3, 4, 5, 6, 7],
    });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();
    const errors: string[] = [];

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 300,
      resumable: true,
      delay: rec.delay,
      onError: ({ error }) => errors.push(error.message),
    });

    // The scan's own results are intact; only the hand-off to the next run is lost.
    expect(stats.idsScanned).toBe(300);
    expect(stats.staleFound).toBe(300);
    expect(stats.cursorPersisted).toBe(null);
    expect(stats.cursorCleared).toBe(false);
    expect(stats.errors).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('could not PERSIST the scan cursor');
    expect(errors[0]).toContain('restart from the beginning');
  });

  it('RAISES AN ERROR when a completed pass cannot CLEAR its cursor', async () => {
    // 🔴 The worst silent failure available here. Reads succeed and writes are rejected
    // (redis at maxmemory, or a read-only replica): the completed pass fails to clear,
    // the next run resumes at the TOP of the index, scans nothing, carries the old
    // `covered` forward so the counts still look complete — and files
    // `info … scanned 0, stale 0, deleted 0` nightly until the staleness bound expires
    // the cursor. An index getting zero cleanup while reporting healthy is precisely
    // what this job's reporting exists to prevent.
    seedCursor('models', { lastId: 4, startedAt: Date.now() - 60_000, covered: 4 });
    redisMock.sysRedis.hDel.mockRejectedValue(new Error('sysRedis unavailable'));
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8] });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();
    const errors: string[] = [];

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 8,
      resumable: true,
      delay: rec.delay,
      onError: ({ error }) => errors.push(error.message),
    });

    expect(stats.idsScanned).toBe(4);
    expect(stats.cursorCleared).toBe(false);
    expect(stats.errors).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('could not CLEAR the scan cursor');
    expect(errors[0]).toContain('may scan nothing');
  });

  it('INVARIANT GUARD (green on unfixed code): a scan without `resumable` never touches the store', async () => {
    // Not a regression test — the un-fixed code had no store at all. It pins the
    // opt-in, so a dry run or the one-off script cannot move the position the
    // nightly job resumes from.
    seedCursor('models', { lastId: 6, startedAt: Date.now(), covered: 5 });
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, { apply: false, batch: 10, delay: rec.delay });

    expect(fake.searchCalls[0].filter).toBe('id > -1');
    expect(stats.resumedFrom).toBe(null);
    expect(stats.cursorPersisted).toBe(null);
    expect(redisMock.sysRedis.hGet).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.hDel).not.toHaveBeenCalled();
    // And the seeded cursor is exactly as it was.
    expect(storedCursor('models')).toMatchObject({ lastId: 6, covered: 5 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// An empty page is evidence, weighed against coverage — not a terminator
// ═══════════════════════════════════════════════════════════════════════════

describe('cleanupIndex: an empty page is re-asked harder when coverage says it cannot be the end', () => {
  it('escalates the backoff and carries on when documents reappear', async () => {
    // 20 documents, 5 per page. The engine answers empty at calls 2, 3 and 4 —
    // three consecutive empties at 25% coverage, which one 500 ms retry cannot
    // clear. The write batch the real engine was applying took far longer than that.
    const fake = makeFakeIndex({
      docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      emptyOnCalls: [2, 3, 4],
    });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 5,
      resumable: true,
      delay: rec.delay,
    });

    // Every document, not the five the first page happened to carry.
    expect(stats.idsScanned).toBe(20);
    expect(stats.stoppedEarly).toBe(false);
    expect(stats.passCovered).toBe(20);
    // 🔴 The schedule itself, in order: the delays ESCALATE. A constant-delay
    // implementation retries just as many times and produces [1000,1000,1000,…].
    // The trailing 500 is the cheap single confirm of the genuine end, taken
    // because coverage by then agrees the scan is there.
    expect(rec.delays).toEqual([1000, 2000, 4000, 500]);
    expect(stats.emptyPageRetries).toBe(4);
    // The pass completed, so nothing is carried into the next run.
    expect(storedCursor('models')).toBeUndefined();
  });

  it('gives up after a BOUNDED number of escalating re-asks rather than looping', async () => {
    // The job holds a 2 h lock; the confirmation must not become an unbounded
    // retry loop inside it. Five attempts, 30 s of waiting for one empty page.
    const fake = makeFakeIndex({
      docs: idsUpTo(8000),
      emptyOnCalls: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 300,
      resumable: true,
      delay: rec.delay,
    });

    expect(rec.delays).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(rec.delays.reduce((a, b) => a + b, 0)).toBe(30_000);
    expect(stats.emptyPageRetries).toBe(5);
    // Six searches after page 1: the empty one, then five confirmations.
    expect(fake.searchCalls.length).toBe(7);
    expect(stats.cursorPersisted).toBe(300);
  });

  it('stops escalating once the backoff BUDGET is spent', async () => {
    // 🔴 The budget is charged for EVERY delay, the first included. It used to exempt
    // the first, which meant it bounded nothing about how many empty pages could be
    // confirmed — the "~5 minutes per index" the comment promised was not what ran.
    //
    // The shipped budget is 5 minutes and no fixture of a runnable size reaches it, so
    // the clamp would ship having never once executed. Injected here at 7 s, which the
    // real schedule crosses on its fourth step: 1000 + 2000 + 4000 = 7000, and the next
    // 8000 does not fit.
    const fake = makeFakeIndex({
      docs: idsUpTo(8000),
      emptyOnCalls: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 300,
      resumable: true,
      delay: rec.delay,
      emptyPageBackoffBudgetMs: 7000,
    });

    expect(rec.delays).toEqual([1000, 2000, 4000]);
    expect(stats.emptyPageRetries).toBe(3);
    expect(stats.cursorPersisted).toBe(300);
  });

  it('still confirms ONCE, cheaply, when the budget is gone before any escalation', async () => {
    // Believing an empty page on sight is the original defect, so an exhausted budget
    // must degrade to the pre-existing single confirmation — not to none, and not to
    // the 1000 ms first escalation step, which is what a naive `break` would leave.
    const fake = makeFakeIndex({
      docs: idsUpTo(8000),
      emptyOnCalls: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 300,
      resumable: true,
      delay: rec.delay,
      emptyPageBackoffBudgetMs: 100,
    });

    expect(rec.delays).toEqual([500]);
    expect(stats.emptyPageRetries).toBe(1);
    // The page was still re-asked: two searches after page 1 would mean none.
    expect(fake.searchCalls.length).toBe(3);
  });

  it('escalates at a coverage INSIDE the trust band, and does not just above it', async () => {
    // Narrows the surviving range for EMPTY_PAGE_TRUST_COVERAGE from both sides. Without
    // these the fixtures sat at 0.25 and >= 1.0, so any value in (0.25, 1.0] — including
    // 0.5 — produced identical output on every test in the file.
    const escalating = makeFakeIndex({
      docs: idsUpTo(8000),
      emptyOnCalls: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    setFakeIndex(escalating);
    const recEsc = makeDelayRecorder();
    // 4800 of 8000 = 0.60, below the 0.90 trust threshold.
    await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 4800,
      resumable: true,
      delay: recEsc.delay,
    });
    expect(recEsc.delays).toEqual([1000, 2000, 4000, 8000, 15000]);

    const trusted = makeFakeIndex({
      docs: idsUpTo(8000),
      emptyOnCalls: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    setFakeIndex(trusted);
    const recTrust = makeDelayRecorder();
    // 7600 of 8000 = 0.95, above it.
    await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 7600,
      resumable: true,
      delay: recTrust.delay,
    });
    expect(recTrust.delays).toEqual([500]);
  });

  it('pins the empty-page constants by value', async () => {
    // Every test above reads the SCHEDULE through behaviour, which is what makes them
    // independent of the numbers — and therefore blind to the numbers changing. Same
    // lesson as the staleness bound: the band fixtures narrow the survivable range, the
    // value pin closes it.
    expect(EMPTY_PAGE_CONFIRM_DELAY_MS).toBe(500);
    expect(EMPTY_PAGE_BACKOFF_MS).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(EMPTY_PAGE_TRUST_COVERAGE).toBe(0.9);
    expect(EMPTY_PAGE_BACKOFF_BUDGET_MS).toBe(5 * 60 * 1000);
  });

  it('INVARIANT GUARD (green on unfixed code): a genuinely exhausted index still ends on one cheap confirm', async () => {
    // Not a regression test — the un-fixed code already confirmed once at 500 ms.
    // It pins the other side of the trade: escalation is conditional on coverage,
    // so the common case (the scan really is at the end) pays nothing extra and a
    // seven-index run is not lengthened by 30 s per index for no reason.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 10,
      resumable: true,
      delay: rec.delay,
    });

    expect(rec.delays).toEqual([500]);
    expect(stats.emptyPageRetries).toBe(1);
    expect(fake.searchCalls.map((c) => c.filter)).toEqual(['id > -1', 'id > 10', 'id > 10']);
    expect(stats.stoppedEarly).toBe(false);
  });

  it('handles an index the engine reports as EMPTY without inventing a coverage', async () => {
    // A total of ZERO is a real state (a freshly created index) and it is the one input
    // that makes the coverage division degenerate: guarding on `total !== null` alone
    // computes 0/0 and yields NaN, which then flows into the logged `coverage` field
    // and compares false against every threshold without ever erroring.
    const fake = makeFakeIndex({ docs: [], totalOverride: 0 });
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 10,
      resumable: true,
      delay: rec.delay,
    });

    expect(stats.totalInIndex).toBe(0);
    expect(stats.idsScanned).toBe(0);
    expect(stats.passCovered).toBe(0);
    expect(stats.stoppedEarly).toBe(false);
    // An empty index is a finished pass, not a truncated one.
    expect(stats.cursorCleared).toBe(true);
    expect(rec.delays).toEqual([500]);
  });

  it('still confirms once when the index total is unknown', async () => {
    // `getStats` failing leaves coverage unknowable. The scan must neither invent a
    // verdict nor spend 30 s per empty page on every index it cannot measure.
    const fake = makeFakeIndex({ docs: [1, 2, 3, 4, 5, 6] });
    (fake.index as { getStats: () => Promise<unknown> }).getStats = async () => {
      throw new Error('stats unavailable');
    };
    setFakeIndex(fake);
    const rec = makeDelayRecorder();

    const stats = await cleanupIndex(modelsCfg, {
      apply: false,
      batch: 6,
      resumable: true,
      delay: rec.delay,
    });

    expect(stats.totalInIndex).toBe(null);
    expect(rec.delays).toEqual([500]);
    // Coverage refutes nothing when there is nothing to compare against, so the
    // pass is credited and the cursor is cleared rather than held on a judgement
    // that could not be made.
    expect(stats.cursorPersisted).toBe(null);
    expect(storedCursor('models')).toBeUndefined();
  });
});
