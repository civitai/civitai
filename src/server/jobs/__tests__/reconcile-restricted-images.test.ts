import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BaseModelConstants from '~/shared/constants/basemodel.constants';
import { logToAxiom } from '~/server/logging/client';

const queryRaw = dbMock.dbWrite.$queryRaw;
// The per-chunk UPDATE goes out through `$queryRaw` (it returns the posts it touched); this stands
// in for it and returns the chunk's rowcount.
const executeRaw = vi.fn<(...call: unknown[]) => Promise<number>>();
const bustCachesForPosts = vi.fn(async (_postIds: number[]) => undefined);
// The search-index queues, at the Redis boundary: `<index>:<action>` and the ids queued under it.
const { addToQueue } = vi.hoisted(() => ({
  addToQueue: vi.fn(async (_key: string, _ids: number[]) => true),
}));
vi.mock('~/server/redis/queues', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addToQueue,
}));

import { reconcileRestrictedImages } from '~/server/jobs/reconcile-restricted-images';
import {
  restrictedImageDriftGauge,
  restrictedImageOverhiddenGauge,
  restrictedImageReconcileLastSuccessGauge,
} from '~/server/prom/client';

// Synthetic, so a base model gaining or losing the restriction doesn't rewrite these tests.
const restricted = vi.hoisted(() => ({ list: ['Alpha', 'Beta'] }));

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bustCachesForPosts: (postIds: number[]) => bustCachesForPosts(postIds),
}));

vi.mock('~/shared/constants/basemodel.constants', async (importOriginal) => ({
  ...(await importOriginal<typeof BaseModelConstants>()),
  matureRestrictedBaseModels: () => restricted.list,
}));

const sqlOf = (call: unknown[]) =>
  Array.isArray(call[0])
    ? (call[0] as string[]).join('')
    : ((call[0] as Prisma.Sql | undefined)?.strings ?? []).join('');
const valuesOf = (call: unknown[]) =>
  call.slice(1).flatMap((v) => ((v as Prisma.Sql)?.values ?? [v]) as unknown[]);
const isUpdateQuery = (call: unknown[]) => /SET\s+"modelRestricted"/i.test(sqlOf(call));
// Both the version query and the over-hidden count name `ModelVersion`, so the
// narrower test has to be asked first.
const isOverhiddenQuery = (call: unknown[]) => sqlOf(call).includes('NOT EXISTS');
const isVersionQuery = (call: unknown[]) =>
  !isOverhiddenQuery(call) && sqlOf(call).includes('"ModelVersion"');

let versionIds: number[] = [1, 2, 3];
let overhidden = 0;
let chunkPostIds: number[][] = [];
let chunkImageIds: number[][] = [];
let notMature = new Set<number>();
let collectionsShowing: number[] = [];
let collectionLookups: unknown[][] = [];
let articlesShowing: number[] = [];
// Fixture image ids start here; the lookup's other numeric parameter (its cap) is far above them.
const FIRST_IMAGE_ID = 501;
const CAP_PARAM = 5000;

const run = () =>
  reconcileRestrictedImages.run({}).result as Promise<{
    flagged: number;
    overhidden: number;
    versions: number;
  }>;

beforeEach(() => {
  vi.clearAllMocks();
  versionIds = [1, 2, 3];
  restricted.list = ['Alpha', 'Beta'];
  overhidden = 0;
  chunkPostIds = [];
  chunkImageIds = [];
  notMature = new Set();
  collectionsShowing = [];
  collectionLookups = [];
  articlesShowing = [];
  executeRaw.mockReset();
  executeRaw.mockResolvedValue(0);
  queryRaw.mockImplementation((...call: unknown[]) => {
    if (isUpdateQuery(call)) {
      const chunk = executeRaw.mock.calls.length;
      return executeRaw(...call).then((flagged) => [
        {
          flagged,
          postIds: chunkPostIds[chunk] ?? [],
          imageIds: chunkImageIds[chunk] ?? [],
          matureImageIds: (chunkImageIds[chunk] ?? []).filter((id) => !notMature.has(id)),
        },
      ]);
    }
    if (isOverhiddenQuery(call)) return Promise.resolve([{ count: BigInt(overhidden) }]);
    if (sqlOf(call).includes('pg_index')) return Promise.resolve([{ present: true }]);
    if (sqlOf(call).includes('"ComicProject"'))
      return Promise.resolve(articlesShowing.map((id) => ({ kind: 'article', id })));
    if (sqlOf(call).includes('"CollectionItem"')) {
      collectionLookups.push(
        valuesOf(call).filter((v) => typeof v === 'number' && v >= FIRST_IMAGE_ID && v < CAP_PARAM)
      );
      return Promise.resolve(collectionsShowing.map((collectionId) => ({ collectionId })));
    }
    if (isVersionQuery(call)) return Promise.resolve(versionIds.map((id) => ({ id })));
    return Promise.resolve([]);
  });
});

describe('reconcile-restricted-images', () => {
  it('runs hourly', () => {
    expect(reconcileRestrictedImages.cron).toBe('0 * * * *');
  });

  it('publishes the flagged count and a heartbeat, so a zero from a job that never ran is distinguishable', async () => {
    executeRaw.mockResolvedValue(6326);
    const before = Math.floor(Date.now() / 1000);

    const result = await run();

    expect(result.flagged).toBe(6326);
    expect(restrictedImageDriftGauge.set).toHaveBeenCalledWith(6326);

    // Once, and in seconds. Milliseconds would put the heartbeat ~52,000 years ahead
    // and no staleness alert could ever fire; a heartbeat set on entry rather than on
    // completion would report a failing job as live.
    expect(restrictedImageReconcileLastSuccessGauge.set).toHaveBeenCalledTimes(1);
    const heartbeat = vi.mocked(restrictedImageReconcileLastSuccessGauge.set).mock.calls[0][0];
    expect(heartbeat).toBeGreaterThanOrEqual(before);
    expect(heartbeat).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
  });

  it('sums the flagged count across every chunk', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);
    executeRaw.mockResolvedValue(1);

    const result = await run();

    expect(result.flagged).toBe(3);
  });

  it('reports the over-hidden count without acting on it', async () => {
    overhidden = 563;

    const result = await run();

    expect(result.overhidden).toBe(563);
    expect(restrictedImageOverhiddenGauge.set).toHaveBeenCalledWith(563);
    for (const call of executeRaw.mock.calls) expect(sqlOf(call)).not.toMatch(/NOT EXISTS/i);
  });

  // DELIBERATE, DO NOT RELAX: this job may set `modelRestricted` and must never
  // clear it. Un-hiding restores content to public feeds, which is a moderation
  // decision rather than a reconciliation, and the reverse direction was explicitly
  // left un-automated (Justin, 2026-08-22). If you are here because you want the job
  // to un-hide, that is a product decision to raise, not an assertion to delete.
  it('hide-only: every statement sets the flag true, none writes false', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);

    await run();

    expect(executeRaw.mock.calls.length).toBeGreaterThan(0);
    for (const call of executeRaw.mock.calls) {
      expect(sqlOf(call)).toMatch(/SET\s+"modelRestricted"\s*=\s*true/i);
      expect(sqlOf(call)).not.toMatch(/=\s*false/i);
      // The values half too: `SET "modelRestricted" = ${x}` would pass a text-only
      // assertion, because joining a tagged template's static strings drops every
      // interpolated value.
      expect(valuesOf(call)).not.toContain(false);
    }
    expect(dbMock.dbWrite.image.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('selects the versions of the base models that restrict mature images', async () => {
    await run();

    const versionQuery = queryRaw.mock.calls.find(isVersionQuery);
    expect(versionQuery && valuesOf(versionQuery)).toEqual(restricted.list);
    const overhiddenQuery = queryRaw.mock.calls.find(isOverhiddenQuery);
    expect(overhiddenQuery && valuesOf(overhiddenQuery)).toEqual(restricted.list);
  });

  // DELIBERATE, DO NOT UNCHUNK: the whole-table anti-join measured 22.4 s, then
  // 57.3 s, then twice past the measuring path's own ~60 s ceiling, on the same
  // replica inside one hour (2026-08-24) — against a 2 min statement_timeout.
  // Unchunked, the planner switches to a parallel seq scan of ImageResourceNew:
  // 440M rows, ~19 GB, 23.8 s. Widening the chunk trades both back.
  it('chunks the update by model version, covering every version exactly once', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);

    await run();

    expect(executeRaw).toHaveBeenCalledTimes(3);

    // The parameters, not the statement text. Every assertion in an earlier draft read
    // only the static strings, so slicing the id list down to one version per chunk
    // passed the whole file while flagging a fraction of what it should.
    // The level mask that picks the mature images is the last parameter, after the versions.
    const sent = executeRaw.mock.calls.map((call) => valuesOf(call).slice(0, -1));
    expect(sent.flat()).toEqual(versionIds);
    expect(sent.map((ids) => ids.length)).toEqual([100, 100, 50]);
  });

  it('stops between chunks when the job is canceled, and publishes no success', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);
    const job = reconcileRestrictedImages.run({});
    executeRaw.mockImplementation(async () => {
      await job.cancel();
      return 1;
    });

    await expect(job.result).rejects.toThrow('Job has ended');
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(restrictedImageReconcileLastSuccessGauge.set).not.toHaveBeenCalled();
    expect(restrictedImageDriftGauge.set).not.toHaveBeenCalled();
  });

  // `Prisma.join([])` throws, so a chunking rewrite that yields a trailing empty chunk
  // would turn an empty restricted list into a job that fails every hour.
  it('issues no statement when nothing is restricted', async () => {
    restricted.list = [];

    const result = await run();

    expect(queryRaw.mock.calls.filter((call) => !isOverhiddenQuery(call))).toEqual([]);
    expect(executeRaw).not.toHaveBeenCalled();
    expect(result.flagged).toBe(0);
    expect(restrictedImageReconcileLastSuccessGauge.set).toHaveBeenCalledTimes(1);
  });

  it('refreshes the caches of the posts each chunk restricted, once per chunk', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);
    executeRaw.mockResolvedValue(1);
    chunkPostIds = [[11, 12], [], [13]];

    await run();

    expect(bustCachesForPosts.mock.calls).toEqual([[[11, 12]], [[13]]]);
  });

  it('logs a failed cache refresh and goes on to the next chunk', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);
    executeRaw.mockResolvedValue(1);
    chunkPostIds = [[11], [], [13]];
    bustCachesForPosts.mockRejectedValueOnce(new Error('redis down'));

    const result = await run();

    expect(result.flagged).toBe(3);
    expect(bustCachesForPosts.mock.calls).toEqual([[[11]], [[13]]]);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ postIds: [11], error: 'redis down' }),
      'webhooks'
    );
  });
});

describe('reconcile-restricted-images search reindex', () => {
  // The image Delete path refreshes the cached thumbnails; that read is how the batch shows up here.
  const thumbnailRefreshes = () =>
    queryRaw.mock.calls
      .filter((call) => sqlOf(call).includes("'parentId'"))
      .map((call) => valuesOf(call).filter((v) => typeof v === 'number'));

  it('takes each newly restricted image out of the image queues as a Delete', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);
    executeRaw.mockResolvedValue(1);
    chunkImageIds = [[501, 502], [], [503]];

    await run();

    expect(thumbnailRefreshes()).toEqual([[501, 502], [503]]);
  });

  const collectionUpdates = () =>
    addToQueue.mock.calls
      .filter(([key]) => key.startsWith('collections') && key.endsWith(':Update'))
      .flatMap(([, ids]) => ids);

  it('rebuilds the collection documents showing each newly restricted image', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);
    executeRaw.mockResolvedValue(1);
    chunkImageIds = [[501, 502], [], [503]];
    collectionsShowing = [77];

    await run();

    expect(collectionLookups.map((ids) => [...new Set(ids)])).toEqual([[501, 502], [503]]);
    expect(collectionUpdates()).toEqual([77, 77]);
  });

  it('keeps a restricted image the restriction does not hide in the image queues', async () => {
    chunkImageIds = [[501, 502]];
    notMature = new Set([502]);
    executeRaw.mockResolvedValue(2);

    await run();

    expect(thumbnailRefreshes()).toEqual([[501]]);
  });

  it('leaves the documents of a restricted image the restriction does not hide', async () => {
    chunkImageIds = [[501]];
    notMature = new Set([501]);
    articlesShowing = [9];
    executeRaw.mockResolvedValue(1);

    await run();

    expect(addToQueue).not.toHaveBeenCalled();
  });

  it('also queues the articles whose cover or banner it is', async () => {
    chunkImageIds = [[501]];
    articlesShowing = [9];
    executeRaw.mockResolvedValue(1);

    await run();

    const articleUpdates = addToQueue.mock.calls
      .filter(([key]) => key.startsWith('articles') && key.endsWith(':Update'))
      .flatMap(([, ids]) => ids);
    expect(articleUpdates).toEqual([9]);
  });

  it('queues nothing when no image was newly restricted', async () => {
    collectionsShowing = [77];
    await run();
    expect(collectionLookups).toEqual([]);
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it('looks the collections up in bounded batches', async () => {
    chunkImageIds = [Array.from({ length: 1200 }, (_, i) => i + 501)];
    executeRaw.mockResolvedValue(1200);
    await run();
    expect(collectionLookups.map((ids) => new Set(ids).size)).toEqual([500, 500, 200]);
  });

  it('logs counts, not ids, when the reindex fails, and still finishes the run', async () => {
    chunkImageIds = [[501, 502]];
    executeRaw.mockResolvedValue(2);
    const flag = queryRaw.getMockImplementation()!;
    queryRaw.mockImplementation((...call: unknown[]) =>
      sqlOf(call).includes("'parentId'") ? Promise.reject(new Error('db down')) : flag(...call)
    );

    const result = await run();

    expect(result.flagged).toBe(2);
    expect(restrictedImageReconcileLastSuccessGauge.set).toHaveBeenCalledTimes(1);
    const failure = vi
      .mocked(logToAxiom)
      .mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.message === 'Image queue removal failed');
    expect(failure).toMatchObject({ images: 2, failedBatches: 1 });
    expect(JSON.stringify(failure)).not.toContain('501');
  });
});
