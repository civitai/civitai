import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliUtil from '~/server/meilisearch/util';

// Partial: only the cleanup helper would reach a real Meilisearch instance from `updateSync`.
vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  onSearchIndexDocumentsCleanup: vi.fn(),
}));

const { SearchIndexUpdateQueueAction } = await import('~/server/common/enums');
const { onSearchIndexDocumentsCleanup } = await import('~/server/meilisearch/util');
const cleanup = vi.mocked(onSearchIndexDocumentsCleanup);
const { createSearchIndexUpdateProcessor } = await import(
  '~/server/search-index/base.search-index'
);
const { collectionsSearchIndex } = await import('~/server/search-index/collections.search-index');

type Processor = Parameters<typeof createSearchIndexUpdateProcessor>[0];

const buildIndex = (overrides: Partial<Processor> = {}) =>
  createSearchIndexUpdateProcessor({
    indexName: 'test_index',
    setup: async () => undefined,
    prepareBatches: async () => ({ batchSize: 100, startId: 0, endId: 0 }),
    pullData: async (_ctx, batch) => (batch.type === 'update' ? batch.ids : []),
    // Documents, not bare ids: the base processor reads ids off the documents a transform
    // produces, which is the whole point of the accounting.
    transformData: async (ids: number[]) => ids.map((id) => ({ id })),
    pushData: async () => undefined,
    updateSyncChunkSize: 300,
    ...overrides,
  });

const updateItems = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1 }));

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cleanup.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // Spied, not silenced: on `update()` and `processQueues()`, which return nothing, this line is
  // the ONLY report a drop ever gets. A test that silences it cannot tell it exists.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const reportLines = () =>
  logSpy.mock.calls.map(String).filter((line) => line.includes('produced no document'));

describe('updateSync :: without-document reporting', () => {
  it('reports the ids a transform dropped, which no failure counter can see', async () => {
    // 7 requested, 2 dropped: a number that is not the item count, not the batch count (1), and
    // not the number of documents written (5). Every "close enough" derivation lands elsewhere.
    const UNWRITTEN = [3, 6];
    const pushData = vi.fn();
    const index = buildIndex({
      transformData: async (ids: number[]) =>
        ids.filter((id) => !UNWRITTEN.includes(id)).map((id) => ({ id })),
      pushData,
    });

    const result = await index.updateSync(updateItems(7));

    expect(result.idsWithoutDocument).toBe(2);
    expect(result.idsWithoutDocumentSample).toEqual(UNWRITTEN);
    // The run is a SUCCESS by every pre-existing measure — that is the failure mode this
    // reporting exists to end, so pin it rather than leaving it implied.
    expect(result.failedTasks).toBe(0);
    expect(result.failedIds).toBe(0);
    expect(pushData).toHaveBeenCalledTimes(1);
    expect(pushData.mock.calls[0][1]).toEqual([1, 2, 4, 5, 7].map((id) => ({ id })));
  }, 30_000);

  // Named for what this case actually drives — `updateSync`, which ALSO returns the number. The
  // log line's justification is the `update()`/`processQueues()` paths, which return nothing, and
  // no test drives those (they need a live queue). Do not rename this back into a claim about
  // them: the call sites at `logIdsWithoutDocument(indexName, 'update', …)` and `'processQueues'` can each
  // be deleted with this suite green.
  it('logs the drop count and a sample on the path it can drive', async () => {
    const index = buildIndex({
      transformData: async (ids: number[]) => ids.filter((id) => id !== 4).map((id) => ({ id })),
    });

    await index.updateSync(updateItems(5));

    expect(reportLines()).toHaveLength(1);
    expect(reportLines()[0]).toContain('1 ids produced no document');
    expect(reportLines()[0]).toContain('sample: 4');
  }, 30_000);

  it('logs nothing when nothing dropped, so the line stays worth reading', async () => {
    const index = buildIndex();

    const result = await index.updateSync(updateItems(5));

    expect(result.idsWithoutDocument).toBe(0);
    expect(reportLines()).toHaveLength(0);
    // Not just "no drop line" — no EMPTY line either. Reporting unconditionally would print
    // `:: test_index ::` with nothing after it on every clean run, which is the noise that makes
    // the populated line unreadable.
    expect(logSpy.mock.calls.map(String).filter((l) => / :: test_index :: *$/.test(l))).toEqual([]);
  }, 30_000);

  it('reports every id when the transform produces no documents at all', async () => {
    // The shape of 868m6jk7w: `pullData` returns the rows, the transform drops all of them, and
    // `pushData` is handed an empty batch it then skips entirely.
    const pushData = vi.fn();
    const index = buildIndex({ transformData: async () => [], pushData });

    const result = await index.updateSync(updateItems(4));

    expect(result.idsWithoutDocument).toBe(4);
    expect(result.idsWithoutDocumentSample).toEqual([1, 2, 3, 4]);
    expect(result.failedIds).toBe(0);
  }, 30_000);

  it('reports an id that never came back from the pull, not only one the transform dropped', async () => {
    // The production shape: a row the index WHERE clause excludes never reaches the transform at
    // all. Also kills the mutant that sources `requestedIds` from the PULLED rows instead of the
    // requested ones — under it this test reports 0.
    const index = buildIndex({
      pullData: async (_ctx, batch) =>
        batch.type === 'update' ? batch.ids.filter((id) => id !== 2) : [],
    });

    const result = await index.updateSync(updateItems(3));

    expect(result.idsWithoutDocument).toBe(1);
    expect(result.idsWithoutDocumentSample).toEqual([2]);
  }, 30_000);

  it('reports every id when a targeted pull comes back empty at step 0', async () => {
    // `users`, `comics`, `tools` and `metrics-images` return null from `pullData` on an empty
    // batch. The base treats a falsy pull as done before any transform task exists, so without
    // pull-side accounting the WORST case — every id dropped — is the one that reports zero.
    const index = buildIndex({ pullData: async () => null });

    const result = await index.updateSync(updateItems(6));

    expect(result.idsWithoutDocument).toBe(6);
    expect(result.idsWithoutDocumentSample).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.failedIds).toBe(0);
  }, 30_000);

  it('reports nothing when a LATER pull step returns falsy, because that is not provably a drop', async () => {
    // Negative arm of the case above, and the reason the gate is `activeStep === 0`. A falsy
    // return at a later step can mean "the step sequence ran out" rather than "no rows"
    // (metrics-images, images), so counting it would cry wolf on every such batch.
    const pullData = vi.fn(async (_ctx: unknown, batch: any, step?: number) =>
      step === 0 ? (batch.type === 'update' ? batch.ids : []) : null
    );
    const index = buildIndex({
      pullData: pullData as unknown as Processor['pullData'],
      pullSteps: 2,
    });

    const result = await index.updateSync(updateItems(3));

    expect(pullData).toHaveBeenCalledTimes(2);
    expect(result.idsWithoutDocument).toBe(0);
  }, 30_000);

  it('reads documents out of an object of arrays, as the models index returns them', async () => {
    // models.search-index returns { indexReadyRecords, indexRecordsWithImages } and the two are
    // NOT the same id set — one is filtered on `isDefined`, the other on `modelVersions.length`.
    // So the arrays here diverge deliberately: id 11 is only in the first, id 12 only in the
    // second, and only id 13 is genuinely dropped. A reader that took just the first array would
    // report 12 as dropped; one that took just the second would report 11.
    const index = buildIndex({
      transformData: async () => ({
        indexReadyRecords: [{ id: 11, name: 'model 11' }],
        indexRecordsWithImages: [{ id: 12, images: [] }],
      }),
    });

    const result = await index.updateSync([{ id: 11 }, { id: 12 }, { id: 13 }]);

    expect(result.idsWithoutDocument).toBe(1);
    expect(result.idsWithoutDocumentSample).toEqual([13]);
  }, 30_000);

  it('does not report an id the processor handled without writing a document', async () => {
    // The collections shape: a disqualified id is DELETED by pushData, so it is accounted for
    // even though no document carries it. Without `getHandledIds` every prune would be reported
    // as a silent drop, and a report that cries wolf is worth nothing.
    const index = buildIndex({
      transformData: async (ids: number[]) => ({
        records: ids.filter((id) => id !== 2).map((id) => ({ id })),
        disqualifiedIds: ids.filter((id) => id === 2),
      }),
      getHandledIds: collectionsSearchIndex.getHandledIds,
    });

    const result = await index.updateSync(updateItems(3));

    expect(result.idsWithoutDocument).toBe(0);
    expect(result.idsWithoutDocumentSample).toEqual([]);
  }, 30_000);

  it('counts what the hook subtracted, so a wrong prune cannot hide behind it', async () => {
    // 5 requested, 3 pruned, 1 dropped, 1 written — four distinct numbers. `handledWithoutDocument`
    // is the ONLY number that would ever show `collections` pruning ids it should not have, since
    // the hook removes them from the drop count by design.
    const index = buildIndex({
      transformData: async (ids: number[]) => ({
        records: ids.filter((id) => id === 1).map((id) => ({ id })),
        disqualifiedIds: ids.filter((id) => [2, 3, 4].includes(id)),
      }),
      getHandledIds: collectionsSearchIndex.getHandledIds,
    });

    const result = await index.updateSync(updateItems(5));

    expect(result.handledWithoutDocument).toBe(3);
    expect(result.idsWithoutDocument).toBe(1);
    expect(result.idsWithoutDocumentSample).toEqual([5]);
    // The only case with BOTH halves nonzero, so it is the only one that can see the joined line.
    // A log that emitted the handled part only when nothing dropped would pass every other case.
    const lines = logSpy.mock.calls.map(String).filter((l) => l.includes('produced no document'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1 ids produced no document');
    expect(lines[0]).toContain('; 3 handled without a document');
  }, 30_000);

  // Consistency check, not a control: with no hook, `handled` IS the document list, so this
  // property holds whether or not the guard that produces it exists. Kept because a future
  // refactor could make the two diverge; do not read it as pinning the guard.
  it('reports no handled-without-document for a processor that has no hook', async () => {
    const index = buildIndex({
      transformData: async (ids: number[]) => ids.filter((id) => id !== 2).map((id) => ({ id })),
    });

    const result = await index.updateSync(updateItems(3));

    expect(result.handledWithoutDocument).toBe(0);
    expect(result.idsWithoutDocument).toBe(1);
  }, 30_000);

  it('survives a hook over a shape whose documents cannot be read', async () => {
    // A processor with a hook whose transform output the generic reader cannot read: the handled
    // set is known, the document set is not. The count that cannot be computed is reported as
    // zero, and — the part worth pinning — the drop count that CAN be computed still is.
    const index = buildIndex({
      transformData: async (ids: number[]) => ids.filter((id) => id !== 3),
      getHandledIds: (ids: number[]) => ids,
    });

    const result = await index.updateSync(updateItems(4));

    expect(result.idsWithoutDocument).toBe(1);
    expect(result.idsWithoutDocumentSample).toEqual([3]);
    expect(result.handledWithoutDocument).toBe(0);
  }, 30_000);

  it('logs the prune count on a run where nothing dropped', async () => {
    // The common `collections` shape: every id handled, none dropped. The line must still appear
    // and must not read `0 ids produced no document (sample: )`.
    const index = buildIndex({
      transformData: async (ids: number[]) => ({
        records: [] as { id: number }[],
        disqualifiedIds: ids,
      }),
      getHandledIds: collectionsSearchIndex.getHandledIds,
    });

    const result = await index.updateSync(updateItems(3));

    expect(result.idsWithoutDocument).toBe(0);
    expect(result.handledWithoutDocument).toBe(3);
    const lines = logSpy.mock.calls.map(String).filter((l) => l.includes('handled without'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('3 handled without a document');
    expect(lines[0]).not.toContain('produced no document');
  }, 30_000);

  // DECISION, pinned deliberately — do not "fix" this into reporting 3 dropped ids.
  // A transform whose output holds no documents at all (here: bare numbers) is a shape the base
  // processor cannot read. Reporting every requested id as dropped would be a false alarm on every
  // batch such a processor ever runs, and an alarm nobody believes is worse than no alarm. The
  // blind spot is deliberate and bounded: a processor in that position opts in with `getHandledIds`.
  it('reports nothing, rather than everything, when the transformed shape holds no documents', async () => {
    const index = buildIndex({ transformData: async (ids: number[]) => ids });

    const result = await index.updateSync(updateItems(3));

    expect(result.idsWithoutDocument).toBe(0);
  }, 30_000);

  it('caps the sample without capping the count', async () => {
    // 150 and 100 are deliberately different: a mutant reporting `idsWithoutDocumentSample.length` as the
    // count passes every other case in this file, where the two numbers are equal.
    const index = buildIndex({ transformData: async () => [], updateSyncChunkSize: 500 });

    const result = await index.updateSync(updateItems(150));

    expect(result.idsWithoutDocument).toBe(150);
    expect(result.idsWithoutDocumentSample).toHaveLength(100);
  }, 30_000);

  it('counts a drop once when the push is retried', async () => {
    // The queue accumulates on completion, so a push that throws once and then succeeds must not
    // report its drop twice. Accumulating at the transform step instead would give 2.
    let attempts = 0;
    const index = buildIndex({
      transformData: async (ids: number[]) => ids.filter((id) => id !== 1).map((id) => ({ id })),
      pushData: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('meilisearch rejected the batch, once');
      },
    });

    const result = await index.updateSync(updateItems(3));

    expect(attempts).toBe(2);
    expect(result.failedIds).toBe(0);
    expect(result.idsWithoutDocument).toBe(1);
  }, 30_000);

  it('does not attribute a drop to a batch that failed outright', async () => {
    // A push that permanently fails wrote nothing either, but those ids belong to `failedIds`.
    // Counting them in both would double-report the same ids under two different names.
    const index = buildIndex({
      transformData: async (ids: number[]) => ids.filter((id) => id !== 1).map((id) => ({ id })),
      pushData: async () => {
        throw new Error('meilisearch rejected the batch');
      },
    });

    const result = await index.updateSync(updateItems(3));

    expect(result.failedIds).toBe(3);
    expect(result.idsWithoutDocument).toBe(0);
  }, 30_000);

  it('counts a repeated id once, whatever the caller passed', async () => {
    // `updateSync` takes an arbitrary caller array. `idsWithoutDocument` is documented as the true total,
    // so it must not depend on the caller having deduped first.
    const index = buildIndex({ transformData: async () => [] });

    const result = await index.updateSync([{ id: 9 }, { id: 9 }, { id: 9 }]);

    expect(result.idsWithoutDocument).toBe(1);
    expect(result.idsWithoutDocumentSample).toEqual([9]);
  }, 30_000);

  it('dedupes per action, so a Delete is not swallowed by an Update for the same id', async () => {
    // The dedupe key is `${action}:${id}`, not the bare id. Collapsing an Update and a Delete for
    // one id would drop whichever arrived second — a lost deletion, which is worse than the
    // miscount the dedupe exists to fix. The two Deletes still collapse into one cleanup call, and
    // the `?? Update` normalisation means `{id}` and `{id, action: 'Update'}` are the same entry.
    const pullData = vi.fn(async (_ctx: unknown, batch: any) =>
      batch.type === 'update' ? batch.ids : []
    );
    const index = buildIndex({ pullData: pullData as unknown as Processor['pullData'] });

    await index.updateSync([
      { id: 9 },
      { id: 9, action: SearchIndexUpdateQueueAction.Update },
      { id: 9, action: SearchIndexUpdateQueueAction.Delete },
      { id: 9, action: SearchIndexUpdateQueueAction.Delete },
      // Bare, and the ONLY id with no explicit action, so it is the one input where `actionOf`
      // disagrees with identity. Without it every id here carries an action and a mutation inside
      // `actionOf` would move the dedupe key and both filters together — the parity blind spot of
      // having one derivation. If `undefined` stopped mapping to Update, 10 would match neither
      // filter and vanish, and this line prints [ 9 ].
      { id: 10 },
    ]);

    // The update for 9 still ran, exactly once, and the action-less 10 is an update too...
    expect(pullData).toHaveBeenCalledTimes(1);
    expect((pullData.mock.calls[0][1] as any).ids).toEqual([9, 10]);
    // ...and so did its deletion, exactly once.
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0][0].ids).toEqual([9]);
  }, 30_000);

  it('counts a repeated id once even when the copies land in different chunks', async () => {
    // Chunk size 1, so the duplicates cannot share a batch. Deduping per chunk instead of before
    // chunking passes the case above and fails this one — the guarantee would hold only for
    // callers whose duplicates happened to be adjacent.
    const index = buildIndex({ transformData: async () => [], updateSyncChunkSize: 1 });

    const result = await index.updateSync([{ id: 9 }, { id: 9 }]);

    expect(result.idsWithoutDocument).toBe(1);
    expect(result.idsWithoutDocumentSample).toEqual([9]);
  }, 30_000);

  it('never fails or alters a batch because the accounting threw', async () => {
    // Observation must not be able to destroy the write it watches: `getHandledIds` is
    // processor-supplied, and a throw inside the task's try would retry and then fail the batch.
    const pushData = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const index = buildIndex({
      getHandledIds: () => {
        throw new Error('a processor hook that is not total');
      },
      pushData,
    });

    const result = await index.updateSync(updateItems(3));

    expect(result.failedTasks).toBe(0);
    expect(result.failedIds).toBe(0);
    // The documents still reach `pushData` intact — a catch that handed on an empty batch would
    // satisfy every count above while silently writing nothing.
    expect(pushData).toHaveBeenCalledTimes(1);
    expect(pushData.mock.calls[0][1]).toEqual([1, 2, 3].map((id) => ({ id })));
    // FAIL OPEN, deliberately: an accounting that cannot run reports nothing rather than reporting
    // every id, which would cry wolf on every batch of a processor with a broken hook.
    expect(result.idsWithoutDocument).toBe(0);
    // ...but never silently. The throw is the one thing here that IS an error.
    expect(errorSpy.mock.calls.map(String).join(' ')).toContain('without-document accounting threw');
  }, 30_000);
});

describe('collectionsSearchIndex.getHandledIds', () => {
  it('claims both the written records and the pruned ids', () => {
    // The production hook, not a copy of it in a fixture. Deleting it from the processor would
    // otherwise redden nothing while producing a drop report on every collections prune.
    expect(
      collectionsSearchIndex.getHandledIds?.({
        records: [{ id: 1 }, { id: 3 }],
        disqualifiedIds: [2],
      })
    ).toEqual([1, 3, 2]);
  });
});
