import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit contract for the pushed-down modelVersion-count helper that replaces the
 * per-row Prisma `_count: { select: { modelVersions: true } }` include on the
 * "my draft models" / "my training models" pages.
 *
 * The include compiled to a LEFT JOIN over a subquery grouping the ENTIRE
 * ModelVersion table (~1.17M rows, ~1344ms) because Postgres did not push the
 * `Model.id IN (...)` filter into the grouped derived table. This helper issues
 * the pushed-down equivalent (`WHERE modelId IN (<ids>) GROUP BY modelId`), which
 * probes only the handful of requested ids in the small `IN` list instead of
 * scanning/grouping the whole table (~1.5ms). These tests pin the behaviours the
 * handlers rely on for a byte-identical response:
 *   1. the QUERY SHAPE is the pushed-down groupBy (id filter IN the aggregate),
 *      NOT a relation `_count` include;
 *   2. every REQUESTED model id gets a number back, including 0 for a model with
 *      no versions (which the GROUP BY omits entirely); and
 *   3. the query runs on the caller-supplied `db` handle (defaulting to the read
 *      replica) — the training handler passes its no-lag primary handle so the
 *      count agrees with the list it just read.
 */

const { groupBy } = vi.hoisted(() => ({ groupBy: vi.fn() }));

vi.mock('~/server/db/client', () => ({
  dbRead: { modelVersion: { groupBy } },
  dbWrite: {},
}));

import { getModelVersionCountsByModelId } from '~/server/services/model-version-count.service';

describe('getModelVersionCountsByModelId', () => {
  beforeEach(() => {
    groupBy.mockReset();
  });

  it('issues the pushed-down groupBy (id filter IN the aggregate, not a relation _count)', async () => {
    groupBy.mockResolvedValue([]);

    await getModelVersionCountsByModelId([1, 2, 3]);

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith({
      by: ['modelId'],
      where: { modelId: { in: [1, 2, 3] } },
      _count: { _all: true },
    });
  });

  it('attaches the real count to models that have versions', async () => {
    groupBy.mockResolvedValue([
      { modelId: 1, _count: { _all: 3 } },
      { modelId: 2, _count: { _all: 7 } },
    ]);

    const counts = await getModelVersionCountsByModelId([1, 2]);

    expect(counts.get(1)).toBe(3);
    expect(counts.get(2)).toBe(7);
  });

  it('returns 0 for a zero-version model (omitted by GROUP BY) — the byte-identical-shape guarantee', async () => {
    // Model 42 has versions; model 99 has NONE, so the DB GROUP BY never emits a
    // row for it. The helper must still key it with 0 so the handler can attach
    // `_count.modelVersions: 0` exactly as the old include did.
    groupBy.mockResolvedValue([{ modelId: 42, _count: { _all: 2 } }]);

    const counts = await getModelVersionCountsByModelId([42, 99]);

    expect(counts.get(42)).toBe(2);
    expect(counts.get(99)).toBe(0);
    expect(counts.has(99)).toBe(true);
  });

  it('dedupes ids before querying (training versions can share a model)', async () => {
    groupBy.mockResolvedValue([{ modelId: 5, _count: { _all: 4 } }]);

    const counts = await getModelVersionCountsByModelId([5, 5, 5]);

    expect(groupBy).toHaveBeenCalledWith({
      by: ['modelId'],
      where: { modelId: { in: [5] } },
      _count: { _all: true },
    });
    expect(counts.get(5)).toBe(4);
    expect(counts.size).toBe(1);
  });

  it('short-circuits on an empty id list without hitting the DB', async () => {
    const counts = await getModelVersionCountsByModelId([]);

    expect(groupBy).not.toHaveBeenCalled();
    expect(counts.size).toBe(0);
  });

  it('defaults to the read-replica handle (dbRead) when no db is passed', async () => {
    groupBy.mockResolvedValue([{ modelId: 1, _count: { _all: 2 } }]);

    await getModelVersionCountsByModelId([1]);

    // The mocked dbRead.modelVersion.groupBy is the one that ran.
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('runs on the caller-supplied db handle (no-lag primary) when one is passed', async () => {
    // A distinct handle standing in for the post-write primary the training
    // handler routes both its list read AND count through.
    const primaryGroupBy = vi.fn().mockResolvedValue([{ modelId: 7, _count: { _all: 5 } }]);
    const primaryDb = { modelVersion: { groupBy: primaryGroupBy } } as never;

    const counts = await getModelVersionCountsByModelId([7], primaryDb);

    // The passed handle ran; the default replica handle did NOT.
    expect(primaryGroupBy).toHaveBeenCalledTimes(1);
    expect(primaryGroupBy).toHaveBeenCalledWith({
      by: ['modelId'],
      where: { modelId: { in: [7] } },
      _count: { _all: true },
    });
    expect(groupBy).not.toHaveBeenCalled();
    expect(counts.get(7)).toBe(5);
  });
});
