import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The nightly search-index cleanup job used to emit NOTHING about what it did.
 * `cleanupIndex` computed per-index counters and the job handed them back in
 * its return value, but nothing logged them and the runner records only a
 * duration — so a pass that covered a fraction of an index and then reported
 * success was completely unobservable.
 *
 * What the log has to get right is subtler than "scanned < total":
 *
 *  - `totalInIndex` is a snapshot taken BEFORE a scan that then runs for a long
 *    time, against indexes another job deletes from every five minutes. A
 *    shortfall is normal, so raising an error on it would produce a nightly
 *    error that is usually wrong — which trains people to ignore it.
 *  - "stopped early" and "skipped some batches" are different facts with
 *    different fixes, and the cursor advances past a skipped batch, so a scan
 *    can reach the very end having skipped some.
 *  - an index the engine cannot serve at all yields NO total, so a
 *    count-based verdict files the worst case as healthy.
 *
 * Fixture values below are deliberately PAIRWISE DISTINCT — scanned, stale,
 * deleted, errors and total never coincide — so a payload that reports one
 * field's value under another field's name is observable.
 */

const { cleanupAllIndexes } = vi.hoisted(() => ({ cleanupAllIndexes: vi.fn() }));

// Spreads the original so `CLEANUP_INDEXES` is the REAL configured list — the
// never-attempted check below compares against it, and a hand-written stand-in
// would make that assertion a statement about the fixture instead.
vi.mock('~/server/meilisearch/cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof CleanupModule>()),
  cleanupAllIndexes,
}));

import type * as CleanupModule from '~/server/meilisearch/cleanup';
import { CLEANUP_INDEXES } from '~/server/meilisearch/cleanup';

// `~/server/logging/client` is a CANONICAL shared-module mock: src/__tests__/setup.ts
// registers it once, globally, spreading the real module and overriding only
// `logToAxiom` with this stable spy. This file must NOT mock it itself — a per-file
// spy pools its call counts across every file sharing a worker under `isolate: false`,
// and a per-file factory freezes the module's export shape for the whole worker.
// See docs/testing/shared-module-mocks.md.
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const logToAxiom = loggingMock.logToAxiom;

// ./job pulls in the Prisma client + prom registry at module load. Only the
// invoke contract matters here.
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (ctx: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => ({
      result: fn({ status: 'running', on: () => undefined, checkIfCanceled: () => undefined }),
      cancel: () => Promise.resolve(),
    }),
    options: {},
  }),
}));

import { searchIndexCleanupJob } from '~/server/jobs/search-index-cleanup';

type Stats = {
  key: string;
  indexName: string;
  batchesProcessed: number;
  idsScanned: number;
  staleFound: number;
  deleted: number;
  totalInIndex: number | null;
  errors: number;
  stoppedEarly: boolean;
  idsSkipped: number;
  rescuedByPrimary: number;
  indexingAtStart: boolean | null;
  passCovered: number;
  resumedFrom: number | null;
  cursorPersisted: number | null;
  cursorDiscardReason: string | null;
  emptyPageRetries: number;
};

/**
 * A healthy, complete pass by default; each test overrides only what it means.
 *
 * `passCovered` defaults to this run's `idsScanned`, which is what a pass that never
 * resumed reports. A resumed run is the case where the two differ, and the tests that
 * care about it set it explicitly.
 */
function stats(over: Partial<Stats> & { key: string }): Stats {
  return {
    indexName: `${over.key}_v1`,
    batchesProcessed: 1,
    idsScanned: 0,
    staleFound: 0,
    deleted: 0,
    totalInIndex: 0,
    errors: 0,
    stoppedEarly: false,
    idsSkipped: 0,
    rescuedByPrimary: 0,
    indexingAtStart: false,
    passCovered: over.idsScanned ?? 0,
    resumedFrom: null,
    cursorPersisted: null,
    cursorDiscardReason: null,
    emptyPageRetries: 0,
    ...over,
  };
}

/** Every logToAxiom payload from the run, as plain objects. */
function logged() {
  return logToAxiom.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

function payloadFor(key: string) {
  return logged().find((p) => p.key === key);
}

beforeEach(() => {
  cleanupAllIndexes.mockReset();
  // MUTATE the canonical node, never replace it. `mockClear` and not `mockReset`:
  // the canonical mock's registered default is what makes `logToAxiom(...)` return
  // a promise, and the job calls `.catch()` on it — a reset here would strip that
  // default and every case would die on `.catch of undefined`.
  logToAxiom.mockClear();
});

describe('search-index-cleanup: per-index stats are logged', () => {
  it('emits one payload per index whose every field carries its OWN counter', async () => {
    // Pairwise-distinct on purpose: 811 / 42 / 37 / 3 / 907 share no value, so
    // a payload that reports `total` under `scanned` (or `stale` under
    // `deleted`) is visible here rather than hidden by equal fixtures.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'models',
        idsScanned: 811,
        staleFound: 42,
        deleted: 37,
        errors: 3,
        totalInIndex: 907,
      }),
      stats({
        key: 'articles',
        idsScanned: 250,
        staleFound: 11,
        deleted: 6,
        errors: 0,
        totalInIndex: 264,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    expect(payloadFor('models')).toMatchObject({
      name: 'search-index-cleanup',
      key: 'models',
      scanned: 811,
      stale: 42,
      deleted: 37,
      errors: 3,
      total: 907,
    });
    expect(payloadFor('articles')).toMatchObject({
      name: 'search-index-cleanup',
      key: 'articles',
      scanned: 250,
      stale: 11,
      deleted: 6,
      errors: 0,
      total: 264,
    });
  });

  it('reports `scanned` from idsScanned, not from the index total', async () => {
    // A complete pass whose scanned count differs from the pre-scan total —
    // which is the NORMAL case, because documents are deleted from under the
    // cursor while the scan runs.
    cleanupAllIndexes.mockResolvedValue([
      stats({ key: 'tools', idsScanned: 480, staleFound: 9, deleted: 4, totalInIndex: 512 }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    expect(payloadFor('tools')?.scanned).toBe(480);
    expect(payloadFor('tools')?.total).toBe(512);
  });

  it('INVARIANT GUARD (green on unfixed code): leaves the job return value unchanged', async () => {
    // Not a regression test — the return value was already correct. It is
    // pinned so the logging added alongside it cannot quietly change the
    // HTTP response body the runner hands back.
    // Pairwise-distinct here too: the return value is a second copy of the
    // same field list, and equal fixture values would let a field report
    // another field's number undetected.
    cleanupAllIndexes.mockResolvedValue([
      stats({ key: 'tools', idsScanned: 12, staleFound: 5, deleted: 2, totalInIndex: 20 }),
    ]);

    const result = (await searchIndexCleanupJob.run({}).result) as {
      indexes: Record<string, unknown>[];
    };

    expect(result).toEqual({
      indexes: [{ key: 'tools', scanned: 12, stale: 5, deleted: 2, errors: 0, total: 20 }],
    });
  });
});

describe('search-index-cleanup: a truncated scan is loud and says so precisely', () => {
  it('logs a stopped-early scan at error level with the WHOLE message pinned', async () => {
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'users',
        idsScanned: 4300000,
        staleFound: 17346,
        deleted: 17346,
        totalInIndex: 11600000,
        stoppedEarly: true,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = payloadFor('users');
    expect(payload?.type).toBe('error');
    expect(payload?.incomplete).toBe(true);
    expect(payload?.stoppedEarly).toBe(true);
    // The WHOLE normalised string, not a pair of order-insensitive `toContain`
    // calls — those cannot see the two numbers being swapped.
    expect(payload?.message).toBe(
      'users: scan STOPPED EARLY after 4300000 id(s) of 11600000 at the start of the run — ' +
        'scanned 4300000, stale 17346, deleted 17346'
    );
  });

  it('does NOT call a healthy complete pass incomplete just because the total moved', async () => {
    // The false-positive class: `totalInIndex` is snapshotted before a scan
    // that runs for hours while another job deletes from the same index. A
    // verdict of `idsScanned < totalInIndex` fires an error every night.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'collections',
        idsScanned: 498000,
        staleFound: 120,
        deleted: 95,
        totalInIndex: 500000,
        stoppedEarly: false,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = payloadFor('collections');
    expect(payload?.type).toBe('info');
    expect(payload?.incomplete).toBe(false);
    expect(payload?.message).toBe('collections: scanned 498000, stale 120, deleted 95');
  });

  it('still flags a completed loop that covered implausibly little', async () => {
    // The backstop for the case `stoppedEarly` cannot see: the loop claims it
    // reached the end, but only a third of the documents were examined.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'bounties',
        idsScanned: 30000,
        staleFound: 12,
        deleted: 7,
        totalInIndex: 900000,
        stoppedEarly: false,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = payloadFor('bounties');
    expect(payload?.type).toBe('error');
    expect(payload?.incomplete).toBe(true);
    expect(payload?.message).toBe(
      'bounties: scan reached the end of the index but covered only 30000 of 900000 document(s) — ' +
        'scanned 30000, stale 12, deleted 7'
    );
  });

  it('does not read a shortfall as truncation while the engine was mid-ingest', async () => {
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'comics',
        idsScanned: 30000,
        staleFound: 12,
        deleted: 7,
        totalInIndex: 900000,
        stoppedEarly: false,
        indexingAtStart: true,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    expect(payloadFor('comics')?.type).toBe('info');
    expect(payloadFor('comics')?.incomplete).toBe(false);
  });

  it('reports skipped batches as SKIPPED, not as an early stop', async () => {
    // `idsScanned` only increments when the eligibility lookup succeeds, but
    // the cursor advances regardless — so a scan can reach the very end of the
    // index with batches missing. Saying "the pass ended before reaching the
    // end" there is a diagnosis that is simply false.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'articles',
        idsScanned: 700,
        staleFound: 21,
        deleted: 13,
        totalInIndex: 900,
        stoppedEarly: false,
        idsSkipped: 200,
        errors: 2,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = payloadFor('articles');
    expect(payload?.type).toBe('error');
    expect(payload?.stoppedEarly).toBe(false);
    expect(payload?.skipped).toBe(200);
    expect(payload?.message).toBe(
      'articles: 200 id(s) SKIPPED — eligibility lookup failed; 2 error(s) — ' +
        'scanned 700, stale 21, deleted 13'
    );
    expect(String(payload?.message)).not.toContain('STOPPED EARLY');
  });
});

describe('search-index-cleanup: the coverage band is calibrated, not incidental', () => {
  // The backstop is `shortfall > FLOOR && shortfall > total * RATIO`. In a
  // fixture where both clauses agree, either constant can be mutated freely
  // and the suite stays green — they shadow each other. These three cases are
  // chosen so exactly ONE clause is decisive in each, which is what makes each
  // constant independently observable.

  it('does not flag a shortfall that clears the RATIO but not the absolute FLOOR', async () => {
    // total 2000, scanned 1200 -> shortfall 800.
    //   ratio: 800 > 500   TRUE   (would flag)
    //   floor: 800 > 1000  FALSE  (blocks)
    // So the floor is the only thing keeping this quiet: lowering or deleting
    // it turns this into an error. A small index must not go loud over a few
    // hundred documents.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'tools',
        idsScanned: 1200,
        staleFound: 17,
        deleted: 9,
        totalInIndex: 2000,
        stoppedEarly: false,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    expect(payloadFor('tools')?.type).toBe('info');
    expect(payloadFor('tools')?.incomplete).toBe(false);
  });

  it('does not flag a large absolute shortfall that is a small PROPORTION', async () => {
    // total 100000, scanned 90000 -> shortfall 10000.
    //   floor: 10000 > 1000   TRUE  (would flag, and stays true however the
    //                                floor is lowered)
    //   ratio: 10000 > 25000  FALSE (blocks)
    // The ratio is the only thing keeping this quiet: loosening it to 0.05, or
    // deleting the clause, turns a 90%-covered run into a nightly error.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'bounties',
        idsScanned: 90000,
        staleFound: 31,
        deleted: 12,
        totalInIndex: 100000,
        stoppedEarly: false,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    expect(payloadFor('bounties')?.type).toBe('info');
    expect(payloadFor('bounties')?.incomplete).toBe(false);
  });

  it('DOES flag a shortfall that clears the ratio band', async () => {
    // total 100000, scanned 60000 -> shortfall 40000.
    //   floor: 40000 > 1000   TRUE
    //   ratio: 40000 > 25000  TRUE  -> flagged
    // Pins the band from the other side: widening the ratio to 0.95 (or
    // raising the floor above 40000) silences a run that missed 40% of the
    // index. Together with the two cases above, each constant is now
    // independently observable in both directions.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'comics',
        idsScanned: 60000,
        staleFound: 23,
        deleted: 8,
        totalInIndex: 100000,
        stoppedEarly: false,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    expect(payloadFor('comics')?.type).toBe('error');
    expect(payloadFor('comics')?.incomplete).toBe(true);
    expect(payloadFor('comics')?.message).toBe(
      'comics: scan reached the end of the index but covered only 60000 of 100000 document(s) — ' +
        'scanned 60000, stale 23, deleted 8'
    );
  });
});

describe('search-index-cleanup: an index the run never reached is reported', () => {
  it('names every configured index that was never attempted', async () => {
    // `cleanupAllIndexes` stops iterating on cancellation, so the indexes it
    // never opened produce no per-index line. A per-index `stoppedEarly` flag
    // cannot cover this: there is no result object to carry it.
    const [first, second, ...rest] = CLEANUP_INDEXES;
    cleanupAllIndexes.mockResolvedValue([
      stats({ key: first.key, idsScanned: 40, staleFound: 3, deleted: 1, totalInIndex: 40 }),
      stats({ key: second.key, idsScanned: 22, staleFound: 5, deleted: 2, totalInIndex: 22 }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const missedLine = logged().find((p) => p.indexesMissed !== undefined);
    expect(missedLine?.type).toBe('error');
    expect(missedLine?.indexesConfigured).toBe(CLEANUP_INDEXES.length);
    expect(missedLine?.indexesAttempted).toBe(2);
    expect(missedLine?.indexesMissed).toEqual(rest.map((c) => c.key));
    expect(missedLine?.message).toBe(
      `run ENDED BEFORE ${rest.length} of ${CLEANUP_INDEXES.length} configured index(es) ` +
        `were attempted: ${rest.map((c) => c.key).join(', ')}`
    );
  });

  it('says nothing when every configured index was attempted', async () => {
    cleanupAllIndexes.mockResolvedValue(
      CLEANUP_INDEXES.map((c, i) =>
        stats({ key: c.key, idsScanned: 10 + i, staleFound: 2, deleted: 1, totalInIndex: 10 + i })
      )
    );

    await searchIndexCleanupJob.run({}).result;

    expect(logged().find((p) => p.indexesMissed !== undefined)).toBeUndefined();
  });
});

describe('search-index-cleanup: an unreadable index is not filed as healthy', () => {
  it('escalates on errors even when no document total could be read', async () => {
    // The worst case: the engine could not serve the index, so BOTH the stats
    // call and the settings call failed. There is no total to compare against,
    // so a count-based verdict would call an index that was not cleaned at all
    // healthy.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'users',
        idsScanned: 0,
        staleFound: 0,
        deleted: 0,
        totalInIndex: null,
        errors: 1,
        stoppedEarly: true,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = payloadFor('users');
    expect(payload?.type).toBe('error');
    expect(payload?.total).toBe(null);
    expect(payload?.message).toBe(
      'users: scan STOPPED EARLY after 0 id(s) (index document count unavailable); ' +
        '1 error(s) — scanned 0, stale 0, deleted 0'
    );
  });

  it('does not invent a coverage verdict when the total is unknown but the scan finished', async () => {
    // `getStats` can fail on its own while the scan itself runs fine. Coverage
    // is then unknowable — the run must claim neither completeness nor
    // truncation. This is what the `total === null` branch is FOR; without it
    // the comparison silently becomes `scanned < 0`, which is never true.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'collections',
        idsScanned: 4000,
        staleFound: 8,
        deleted: 3,
        totalInIndex: null,
        errors: 0,
        stoppedEarly: false,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = payloadFor('collections');
    expect(payload?.type).toBe('info');
    expect(payload?.incomplete).toBe(false);
    expect(payload?.coverage).toBe(null);
    expect(payload?.message).toBe('collections: scanned 4000, stale 8, deleted 3');
  });
});

describe('search-index-cleanup: the requested scan batch', () => {
  it('asks for a page size large enough for a multi-million-document index', async () => {
    cleanupAllIndexes.mockResolvedValue([]);

    await searchIndexCleanupJob.run({}).result;

    expect(cleanupAllIndexes).toHaveBeenCalledTimes(1);
    const opts = cleanupAllIndexes.mock.calls[0][1] as { batch: number; apply: boolean };
    expect(opts.batch).toBe(10000);
    expect(opts.apply).toBe(true);
  });

  it('opts the nightly run into the shared cross-run cursor', async () => {
    // The cron is the only caller that owns the cursor. Without this flag the scan
    // restarts at the bottom every night and a pass it cannot finish in one run
    // makes zero cumulative progress — the defect, unchanged, with a store sitting
    // beside it doing nothing.
    cleanupAllIndexes.mockResolvedValue([]);

    await searchIndexCleanupJob.run({}).result;

    const opts = cleanupAllIndexes.mock.calls[0][1] as { resumable?: boolean };
    expect(opts.resumable).toBe(true);
  });
});

describe('search-index-cleanup: a resumed run is judged on the PASS, not on the run', () => {
  it('does not call a resumed run truncated for scanning only the remainder', async () => {
    // A run that picked up at a stored cursor scans what is LEFT. Reading coverage
    // off its own `idsScanned` files every such run as a 3%-coverage failure —
    // which would make the resume mechanism look like a regression in the very log
    // line built to detect truncation, and train people to ignore it.
    // Pairwise-distinct: 30000 / 950000 / 1000000 / 41 / 17 share no value.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'users',
        idsScanned: 30000,
        passCovered: 950000,
        staleFound: 41,
        deleted: 17,
        totalInIndex: 1000000,
        stoppedEarly: false,
        resumedFrom: 8123456,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = payloadFor('users');
    expect(payload?.type).toBe('info');
    expect(payload?.incomplete).toBe(false);
    // `scanned` still reports THIS run; `covered` and `coverage` report the pass.
    expect(payload?.scanned).toBe(30000);
    expect(payload?.covered).toBe(950000);
    expect(payload?.coverage).toBe(0.95);
    expect(payload?.message).toBe(
      'users: scanned 30000, stale 41, deleted 17, resumed from id 8123456'
    );
  });

  it('still flags a pass whose CUMULATIVE coverage is implausibly low', async () => {
    // The other side: resuming must not become a way to never be called truncated.
    // Two runs into the pass and still at 15% of the index — the shape of the real
    // incident — stays an error.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'users',
        idsScanned: 900000,
        passCovered: 1803688,
        staleFound: 25,
        deleted: 25,
        totalInIndex: 11610246,
        stoppedEarly: false,
        resumedFrom: 903688,
        cursorPersisted: 1903688,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = payloadFor('users');
    expect(payload?.type).toBe('error');
    expect(payload?.incomplete).toBe(true);
    expect(payload?.message).toBe(
      'users: scan reached the end of the index but covered only 1803688 of 11610246 document(s) — ' +
        'scanned 900000, stale 25, deleted 25, resumed from id 903688, ' +
        'cursor saved at id 1903688 for the next run'
    );
  });

  it('says so when a stored cursor was discarded and the run silently restarted', async () => {
    // A run that restarted from the bottom because the stored value could not be
    // trusted is safe, but it is NOT the same event as a completed pass rolling
    // over — and the two are indistinguishable in the scan itself.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'articles',
        idsScanned: 640,
        staleFound: 19,
        deleted: 11,
        totalInIndex: 700,
        cursorDiscardReason: 'stale',
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = payloadFor('articles');
    expect(payload?.cursorDiscardReason).toBe('stale');
    expect(payload?.message).toBe(
      'articles: scanned 640, stale 19, deleted 11, ' +
        'stored cursor discarded (stale) — restarted from id 0'
    );
  });

  it('stays quiet about the ordinary case of nothing being stored', async () => {
    // `missing` is what every run after a completed pass reports. A line for it
    // would appear nightly on every index and mean nothing.
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'tools',
        idsScanned: 55,
        staleFound: 4,
        deleted: 2,
        totalInIndex: 55,
        cursorDiscardReason: 'missing',
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    expect(payloadFor('tools')?.message).toBe('tools: scanned 55, stale 4, deleted 2');
    expect(payloadFor('tools')?.cursorDiscardReason).toBe('missing');
  });
});

describe('search-index-cleanup: a failing log sink cannot leak an unhandled rejection', () => {
  it('handles a rejected logToAxiom instead of passing it through', async () => {
    // `.catch()` with NO argument is `then(undefined, undefined)` — a
    // pass-through that leaves the rejection unhandled. Only `.catch(() => undefined)`
    // actually swallows it. Nothing awaits these calls, so the observable is
    // the process-level `unhandledRejection` event.
    const seen: unknown[] = [];
    const marker = new Error('axiom-down-marker');
    const onUnhandled = (reason: unknown) => {
      if (reason === marker) seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      logToAxiom.mockImplementation(() => Promise.reject(marker));
      cleanupAllIndexes.mockResolvedValue([
        stats({ key: 'tools', idsScanned: 5, staleFound: 2, deleted: 1, totalInIndex: 5 }),
      ]);

      await searchIndexCleanupJob.run({}).result;
      // Let the microtask queue drain and give Node a macrotask turn, which is
      // when it decides a rejection went unhandled.
      await new Promise((r) => setTimeout(r, 20));

      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      // Restore the canonical default for the rest of the file.
      logToAxiom.mockImplementation(() => Promise.resolve(undefined));
    }
  });
});
