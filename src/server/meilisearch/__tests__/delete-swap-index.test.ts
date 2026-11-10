import { describe, expect, it, vi } from 'vitest';
import type { MeiliSearch } from 'meilisearch';

/**
 * Regression coverage for `deleteSwapIndex`, the helper that discards an index named
 * `<indexName>_NEW`.
 *
 * It exists because a full-corpus `reset` can now ABANDON its rebuild. Before that, every
 * non-partial reset ended in `swapIndex`, whose last act is to delete the swap index — so a
 * surviving swap index was a sign of a crash, not an ordinary outcome.
 *
 * `reset` calls it on the REFUSAL path only, and at most once per run, so that a near-complete copy
 * of the corpus is not left resident. It is deliberately NOT called before a rebuild: the deletion
 * is a task that completes later, so a pre-rebuild delete lands after `setup` has read the old
 * settings and ends up promoting an index with none. `base.search-index.ts` establishes an empty
 * rebuild with a READ instead. It is also not called for a `stale-swap-index` refusal, where the
 * index holds state the run did not create — possibly a concurrent run's.
 *
 * The one thing that must not regress is WHICH client method it calls, because the two differ
 * exactly on the case it has to tolerate: an index that is not there.
 */
const { deleteSwapIndex, countIndexDocuments } = await import('~/server/meilisearch/util');

/** A client recording which deletion method was used. */
const fakeClient = (
  overrides: Partial<Record<'deleteIndexIfExists' | 'deleteIndex', unknown>> = {}
) => {
  const deleteIndexIfExists = vi.fn().mockResolvedValue(true);
  const deleteIndex = vi.fn().mockResolvedValue({ taskUid: 1 });
  return {
    client: { deleteIndexIfExists, deleteIndex, ...overrides } as unknown as MeiliSearch,
    deleteIndexIfExists,
    deleteIndex,
  };
};

describe('deleteSwapIndex', () => {
  it('deletes the named swap index via the tolerant method, not the throwing one', async () => {
    const { client, deleteIndexIfExists, deleteIndex } = fakeClient();

    await deleteSwapIndex({ swapIndexName: 'models_v9_NEW', client });

    expect(deleteIndexIfExists).toHaveBeenCalledTimes(1);
    expect(deleteIndexIfExists).toHaveBeenCalledWith('models_v9_NEW');
    // 🔴 The load-bearing half. `deleteIndex` rejects with `index_not_found` for an index that is
    // not there, and that case is reachable on the refusal path — a `no-batches` refusal enqueues
    // no documents, so the swap index may have been deleted by an earlier run and never recreated.
    // Using it would make the caller log a cleanup failure on a run where there was simply nothing
    // to discard, which is a false alarm on exactly the path that is supposed to be quiet.
    expect(deleteIndex).not.toHaveBeenCalled();
  });

  it('resolves, rather than throwing, when the swap index does not exist', async () => {
    // What `deleteIndexIfExists` reports for a missing index — `false`, not a rejection. The caller
    // treats "nothing to delete" as success, so this must not throw. (The no-client branch below
    // returns `undefined` rather than `false`; the two are different answers and both are fine,
    // because every consumer only cares that it did not reject.)
    const { client } = fakeClient({ deleteIndexIfExists: vi.fn().mockResolvedValue(false) });

    await expect(deleteSwapIndex({ swapIndexName: 'articles_v5_NEW', client })).resolves.toBe(
      false
    );
  });

  it('propagates a real deletion failure so the caller can report it', async () => {
    // Distinct from the missing-index case: a genuine backend error must not be swallowed here —
    // `reset` decides for itself that a cleanup failure is non-fatal, and it can only do that if it
    // actually sees one.
    const boom = new Error('meilisearch rejected deleteIndex');
    const { client } = fakeClient({ deleteIndexIfExists: vi.fn().mockRejectedValue(boom) });

    await expect(deleteSwapIndex({ swapIndexName: 'users_v3_NEW', client })).rejects.toThrow(boom);
  });

  it('is a no-op when there is no client configured', async () => {
    // Search is optional in some environments; `swapIndex` guards the same way.
    const { deleteIndexIfExists } = fakeClient();

    await expect(
      deleteSwapIndex({ swapIndexName: 'models_v9_NEW', client: null })
    ).resolves.toBeUndefined();
    expect(deleteIndexIfExists).not.toHaveBeenCalled();
  });
});

/**
 * `countIndexDocuments` exists because no sequence of DELETES can establish that an index is empty
 * at the moment a rebuild starts writing into it — every Meilisearch mutation is a task that
 * completes later. A stats READ can, because it answers about now. `reset` uses it twice: on the
 * swap index (is there a stale rebuild?) and on the live index (is there anything an empty rebuild
 * would destroy?).
 */
const fakeStatsClient = (stats: unknown, { throws }: { throws?: unknown } = {}) => {
  const getStats = throws ? vi.fn().mockRejectedValue(throws) : vi.fn().mockResolvedValue(stats);
  const index = vi.fn().mockReturnValue({ getStats });
  return { client: { index } as unknown as MeiliSearch, index, getStats };
};

describe('countIndexDocuments', () => {
  it('reports the document count of the named index', async () => {
    // A value that is not 0, not 1 and not any other constant these assertions name.
    const { client, index } = fakeStatsClient({ numberOfDocuments: 708152 });

    await expect(countIndexDocuments({ indexName: 'models_v9', client })).resolves.toBe(708152);
    expect(index).toHaveBeenCalledWith('models_v9');
  });

  it('reports 0 for an empty index, distinctly from an absent one', async () => {
    const { client } = fakeStatsClient({ numberOfDocuments: 0 });

    await expect(countIndexDocuments({ indexName: 'comics_v1', client })).resolves.toBe(0);
  });

  it('treats a missing index as 0 rather than an error', async () => {
    // "not there" and "there and empty" are the same answer to the question the callers ask, and an
    // index that does not exist yet is the ordinary first-reset case.
    const notFound = Object.assign(new Error('Index `x_NEW` not found.'), {
      code: 'index_not_found',
    });
    const { client } = fakeStatsClient(undefined, { throws: notFound });

    await expect(countIndexDocuments({ indexName: 'x_NEW', client })).resolves.toBe(0);
  });

  it('propagates any other failure instead of reporting a reassuring zero', async () => {
    // 🔴 The load-bearing half. A swallowed error would return 0, and 0 is exactly the value that
    // tells `reset` "nothing is at stake, go ahead and swap" — so a backend blip would be
    // indistinguishable from an empty index and would re-open the hole this guard closes.
    const boom = Object.assign(new Error('internal'), { code: 'internal' });
    const { client } = fakeStatsClient(undefined, { throws: boom });

    await expect(countIndexDocuments({ indexName: 'models_v9', client })).rejects.toThrow(boom);
  });

  it('returns null, not 0, when there is no search client', async () => {
    // null means "unknowable", which the caller must not confuse with "empty".
    await expect(countIndexDocuments({ indexName: 'models_v9', client: null })).resolves.toBeNull();
  });
});
