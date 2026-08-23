import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The nightly search-index cleanup job used to emit NOTHING about what it did.
 * `cleanupIndex` computed per-index scanned / stale / deleted / total counters
 * and the job handed them back in its return value, but nothing logged them
 * and the runner records only a duration — so a pass that covered a fraction
 * of an index and then reported success was completely unobservable.
 *
 * These tests pin two things: the per-index stats reach the log sink at all,
 * and an INCOMPLETE pass (`idsScanned < totalInIndex`) is loud rather than
 * buried in a success line.
 */

const { cleanupAllIndexes } = vi.hoisted(() => ({ cleanupAllIndexes: vi.fn() }));

vi.mock('~/server/meilisearch/cleanup', () => ({ cleanupAllIndexes }));

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
};

function stats(over: Partial<Stats> & { key: string }): Stats {
  return {
    indexName: `${over.key}_v1`,
    batchesProcessed: 1,
    idsScanned: 0,
    staleFound: 0,
    deleted: 0,
    totalInIndex: 0,
    errors: 0,
    ...over,
  };
}

/** Every logToAxiom payload from the run, as plain objects. */
function logged() {
  return logToAxiom.mock.calls.map((c) => c[0] as Record<string, unknown>);
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
  it('emits one payload per index carrying key, scanned, stale, deleted, errors and total', async () => {
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'models',
        idsScanned: 800,
        staleFound: 40,
        deleted: 40,
        totalInIndex: 800,
        errors: 0,
      }),
      stats({
        key: 'articles',
        idsScanned: 250,
        staleFound: 3,
        deleted: 3,
        totalInIndex: 250,
        errors: 1,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const models = logged().find((p) => p.key === 'models');
    const articles = logged().find((p) => p.key === 'articles');

    expect(models).toMatchObject({
      name: 'search-index-cleanup',
      key: 'models',
      scanned: 800,
      stale: 40,
      deleted: 40,
      errors: 0,
      total: 800,
    });
    expect(articles).toMatchObject({
      name: 'search-index-cleanup',
      key: 'articles',
      scanned: 250,
      stale: 3,
      deleted: 3,
      errors: 1,
      total: 250,
    });
  });

  it('INVARIANT GUARD (green on unfixed code): leaves the job return value unchanged', async () => {
    // Not a regression test — the return value was already correct. It is
    // pinned so the logging added alongside it cannot quietly change the
    // HTTP response body the runner hands back.
    cleanupAllIndexes.mockResolvedValue([
      stats({ key: 'tools', idsScanned: 12, staleFound: 2, deleted: 2, totalInIndex: 12 }),
    ]);

    const result = (await searchIndexCleanupJob.run({}).result) as {
      indexes: Record<string, unknown>[];
    };

    expect(result).toEqual({
      indexes: [{ key: 'tools', scanned: 12, stale: 2, deleted: 2, errors: 0, total: 12 }],
    });
  });
});

describe('search-index-cleanup: an incomplete pass is loud', () => {
  it('logs a truncated scan at error level with BOTH the scanned and total counts', async () => {
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'users',
        idsScanned: 4300000,
        staleFound: 17346,
        deleted: 17346,
        totalInIndex: 11600000,
        errors: 0,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = logged().find((p) => p.key === 'users');
    expect(payload?.type).toBe('error');
    expect(payload?.incomplete).toBe(true);
    expect(String(payload?.message)).toContain('INCOMPLETE SCAN');
    expect(String(payload?.message)).toContain('4300000');
    expect(String(payload?.message)).toContain('11600000');
  });

  it('does NOT flag a complete pass', async () => {
    cleanupAllIndexes.mockResolvedValue([
      stats({
        key: 'collections',
        idsScanned: 500,
        staleFound: 5,
        deleted: 5,
        totalInIndex: 500,
      }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = logged().find((p) => p.key === 'collections');
    expect(payload?.type).toBe('info');
    expect(payload?.incomplete).toBe(false);
    expect(String(payload?.message)).not.toContain('INCOMPLETE');
  });

  it('does NOT flag a pass whose index total could not be read', async () => {
    // `totalInIndex: null` means the stats call failed. Completeness is then
    // unknowable, so the run must not assert either way.
    cleanupAllIndexes.mockResolvedValue([
      stats({ key: 'bounties', idsScanned: 90, staleFound: 0, deleted: 0, totalInIndex: null }),
    ]);

    await searchIndexCleanupJob.run({}).result;

    const payload = logged().find((p) => p.key === 'bounties');
    expect(payload?.type).toBe('info');
    expect(payload?.incomplete).toBe(false);
    expect(payload?.total).toBe(null);
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
});
