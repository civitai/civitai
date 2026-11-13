import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Availability } from '~/shared/utils/prisma/enums';

/**
 * Selection-path guards for the labeling pass.
 *
 * There are two ways this pass picks its corpus and they have different
 * failure modes, so each gets pinned separately:
 *
 *   DEFAULT — keyset over every published version (`id > cursor ORDER BY id`).
 *   This is the eventual fleet run. The `--top` work must not perturb it, and
 *   the test below asserts the COMPLETE argument object, not just the
 *   predicate, because "unchanged" is a claim about the whole query.
 *
 *   `--top N` — the N highest-usage versions, for bounding vendor spend during
 *   validation. Usage is `generationCount` (actual use), deliberately not
 *   `downloadCount` (acquisition) or `thumbsUpCount` (approval), and the
 *   ordering carries an explicit `modelVersionId` tiebreak because
 *   `generationCount DESC` alone is not a total order — without it the slice at
 *   a given N is not reproducible run to run, which would quietly invalidate
 *   any conclusion drawn from the validation phase.
 *
 * Both paths must carry the SAME availability predicate. That rule already
 * disagreed with itself once across this feature, so it now lives in one
 * exported constant; the final test here asserts both call sites resolve to it
 * BEHAVIOURALLY — off the queries actually issued — because a structural
 * comparison alone type-checks past a call site that was handed something else.
 *
 * NO VENDOR CALL AND NO WRITE in either path: the version fetch resolves empty,
 * so the run leaves its loop before `askJev`, before the `resourceInsight` read
 * and before any upsert.
 */

const versionFindMany = vi.fn();
const metricFindMany = vi.fn();
const resourceInsightFindMany = vi.fn();
const upsert = vi.fn();

vi.mock('~/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dbRead: {
    modelVersion: { findMany: (...a: unknown[]) => versionFindMany(...a) },
    modelVersionMetric: { findMany: (...a: unknown[]) => metricFindMany(...a) },
    resourceInsight: { findMany: (...a: unknown[]) => resourceInsightFindMany(...a) },
  },
  dbWrite: { resourceInsight: { upsert: (...a: unknown[]) => upsert(...a) } },
}));

/**
 * A Prisma `findMany` argument, as far as these assertions need to see it.
 *
 * `where` is an index signature rather than named fields on purpose: every
 * assertion below reads it either whole (so a stray clause is a failure) or by
 * one key, and both work without a cast. The point is that the captured
 * arguments are typed ONCE here — typing them as `Record<string, never>`, which
 * an earlier revision did, makes every read at a call site a non-overlapping
 * conversion that only a cast can silence, and `tsconfig.json` excludes this
 * directory, so nothing in either CI tier would have reported it.
 * `node scripts/ci/typecheck-scripts-gate.mjs` is what sees this file.
 */
type IssuedQuery = {
  where: Record<string, unknown>;
  orderBy?: unknown;
  take?: unknown;
  select?: unknown;
};

/** Runs `main()` with the given CLI args and returns the queries it issued. */
async function run(...args: string[]): Promise<{ version: IssuedQuery[]; metric: IssuedQuery[] }> {
  const { main } = await import('../label-resource-insights');
  // 🔴 argv[1] must NOT end with the script's filename — the script's tail guard
  // self-executes `main()` when it does, which double-runs the pass. Only
  // `slice(2)` is parsed, so argv[1] is free.
  process.argv = ['node', 'vitest', ...args];
  await main();
  return {
    version: versionFindMany.mock.calls.map((c) => c[0] as IssuedQuery),
    metric: metricFindMany.mock.calls.map((c) => c[0] as IssuedQuery),
  };
}

describe('label-resource-insights selection paths', () => {
  let argv: string[];

  beforeEach(() => {
    versionFindMany.mockReset();
    metricFindMany.mockReset();
    resourceInsightFindMany.mockReset();
    upsert.mockReset();
    // Empty version pages end both paths immediately.
    versionFindMany.mockResolvedValue([]);
    metricFindMany.mockResolvedValue([
      { modelVersionId: 11 },
      { modelVersionId: 22 },
      { modelVersionId: 33 },
    ]);
    argv = process.argv;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  describe('the default path is the fleet run and must not drift', () => {
    it('issues exactly the keyset query, unchanged by the --top work', async () => {
      const { version, metric } = await run();
      // No `--top` must mean no metric query at all: the usage table is not
      // consulted, so the fleet sweep cannot inherit its cost or its ordering.
      expect(metric).toHaveLength(0);
      expect(version).toHaveLength(1);
      // The WHOLE argument object, so a change to ordering, page size or the
      // selected columns is a failure and not just a predicate change.
      expect(version[0]).toEqual({
        where: {
          id: { gt: 0 },
          status: 'Published',
          availability: { not: Availability.Private },
          model: { status: 'Published', availability: { not: Availability.Private } },
        },
        orderBy: { id: 'asc' },
        take: 10,
        select: {
          id: true,
          // Not a judgment input — the batch request never sees it. Selected so
          // a written label can be announced to the models search index, which
          // is keyed per MODEL while `ResourceInsight` is keyed per version.
          modelId: true,
          name: true,
          baseModel: true,
          trainedWords: true,
          description: true,
          model: { select: { type: true, nsfw: true } },
        },
      });
    });

    it('treats --cursor as a version id, resuming the keyset after it', async () => {
      const { version } = await run('--cursor', '12345');
      expect(version[0].where.id).toEqual({ gt: 12345 });
    });
  });

  describe('--top N selects by usage, deterministically', () => {
    it('orders by generationCount DESCENDING with a modelVersionId tiebreak', async () => {
      const { metric } = await run('--top', '3');
      expect(metric).toHaveLength(1);
      // Asserted as the exact array: the column, the direction and the tiebreak
      // are three separate things that can each be wrong on their own.
      expect(metric[0].orderBy).toEqual([{ generationCount: 'desc' }, { modelVersionId: 'asc' }]);
    });

    it('materialises the id list ONCE rather than paginating the mutable metric', async () => {
      const { metric } = await run('--top', '3');
      // `generationCount` moves while a run is in flight, so a second ordered
      // read would be a second walk over a changed ordering. One read only.
      expect(metric).toHaveLength(1);
      expect(metric[0].take).toBe(3);
    });

    it('fetches the materialised ids by id, not by a re-ordered usage query', async () => {
      const { version } = await run('--top', '3');
      expect(version).toHaveLength(1);
      expect(version[0].where.id).toEqual({ in: [11, 22, 33] });
    });

    it('rejects a non-numeric --top instead of silently labeling nothing', async () => {
      await expect(run('--top', 'abc')).rejects.toThrow(/--top expects a positive integer/);
      expect(metricFindMany).not.toHaveBeenCalled();
    });

    it('rejects a zero or negative --top', async () => {
      await expect(run('--top', '0')).rejects.toThrow(/--top expects a positive integer/);
    });
  });

  describe('both selection paths carry the same availability predicate', () => {
    const expected = {
      status: 'Published',
      availability: { not: Availability.Private },
      model: { status: 'Published', availability: { not: Availability.Private } },
    };

    it('the default path applies it to the version query', async () => {
      const { version } = await run();
      const { id: _id, ...predicate } = version[0].where;
      expect(predicate).toEqual(expected);
    });

    it('--top applies it to the usage query, through the version relation', async () => {
      const { metric } = await run('--top', '3');
      expect(metric[0].where.modelVersion).toEqual(expected);
    });

    it('--top applies it again to the chunk fetch, so neither query can widen alone', async () => {
      const { version } = await run('--top', '3');
      const { id: _id, ...predicate } = version[0].where;
      expect(predicate).toEqual(expected);
    });

    it('never excludes Unsearchable in either path, wherever it is spelled', async () => {
      const def = await run();
      versionFindMany.mockClear();
      metricFindMany.mockClear();
      const top = await run('--top', '3');
      // Scans every issued query whole, so a reintroduced clause is caught in a
      // nested position the field-level assertions above do not inspect.
      for (const issued of [...def.version, ...top.version, ...top.metric]) {
        expect(JSON.stringify(issued)).not.toContain('Unsearchable');
      }
    });
  });

  it('reads no insight rows and writes nothing when the corpus comes back empty', async () => {
    await run('--top', '3');
    expect(resourceInsightFindMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
