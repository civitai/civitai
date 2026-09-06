import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for the collections-reindex enqueue used by the image and
 * permanent-model-delete removal paths.
 *
 * The defect it exists for: `prepareBatches` in collections.search-index.ts filters on
 * `c."createdAt" >= lastUpdatedAt`, so the incremental sweep only revisits NEWLY
 * CREATED collections. An existing collection is rebuilt only via an explicit enqueue,
 * and no removal path issued one — so a collection kept serving the thumbnail of a
 * model or image that had been deleted.
 *
 * Fixture discipline: every collection id here is distinct from every other, from the
 * model/image ids that resolve it, and from the cap and batch-size constants the
 * assertions name. A mutant that hardcodes any literal in the module cannot survive.
 */

const { mockCollectionsQueueUpdate } = vi.hoisted(() => ({
  mockCollectionsQueueUpdate: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import {
  COVER_INDEX_NAME,
  enqueueCollectionRebuild,
  getCollectionIdsForImages,
  getCollectionIdsForModelCascade,
} from '~/server/services/collection-media-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const MODEL_ID = 4212;
const IMAGE_ID = 6631;
const COLLECTION_A = 8801;
const COLLECTION_B = 9107;
const COLLECTION_C = 7743;

const rows = (...ids: number[]) => ids.map((collectionId) => ({ collectionId }));

// The template-tag call arrives as [strings, ...values]. Joining `strings` alone is
// NOT enough here: the cover leg is interpolated as a nested `Prisma.sql` fragment, so
// its text lives in the VALUES and a naive join renders it as `?` — an assertion on
// the leg would then fail whether or not the leg is present. Splice nested fragments
// back in so these assertions read the statement as it will actually be sent.
const sqlOf = (call: unknown[]) => {
  const [strings, ...values] = call as [string[], ...unknown[]];
  return strings
    .map((chunk, i) => {
      if (i === 0) return chunk;
      const value = values[i - 1] as { sql?: string } | undefined;
      return (typeof value?.sql === 'string' ? value.sql : '?') + chunk;
    })
    .join('');
};

const isGate = (sql: string) => sql.includes('pg_class');

/** The image path asks the catalog whether the cover index is usable before it builds
 *  its query, so every image fixture has to answer that question first. */
function primeImageLookup({ coverIndex, found }: { coverIndex: boolean; found: number[] }) {
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = Array.from(strings).join('?');
    if (isGate(sql)) return [{ present: coverIndex }];
    return rows(...found);
  });
}

const callMatching = (want: boolean) =>
  dbMock.dbWrite.$queryRaw.mock.calls.find(
    ([strings]: [string[]]) => isGate(Array.from(strings).join('?')) === want
  ) as unknown[] | undefined;

/** The SQL the image path actually built, i.e. not the catalog gate. */
const imageQuerySql = () => sqlOf(callMatching(false)!);
const gateSql = () => sqlOf(callMatching(true)!);

const logNamed = (name: string) =>
  loggingMock.logToAxiom.mock.calls
    .map((c) => c[0] as { name?: string; message?: string; error?: unknown })
    .find((a) => a?.name === name);

/** Axiom JSON.stringifies its payload; asserting after that round-trip is the only way
 *  to tell `safeError(e)` from a raw `Error`, which satisfies `objectContaining` too. */
const serialisedError = (name: string) =>
  JSON.parse(JSON.stringify({ e: logNamed(name)?.error })).e as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCollectionIdsForImages — routes', () => {
  // An image reaches a collection document by seven routes and only ONE of them is a
  // CollectionItem.imageId row. Resolving by that column alone — the obvious reading —
  // misses the two commonest (a Model item's gallery image, a Post item's first
  // image), which is how the collection that prompted this work stayed stale: both its
  // items are model-type with imageId NULL.
  it('resolves every route by which an image reaches a collection document', async () => {
    primeImageLookup({ coverIndex: true, found: [COLLECTION_A] });

    await getCollectionIdsForImages({ imageIds: [IMAGE_ID], source: 'image-delete' });

    const sql = imageQuerySql();
    expect(sql).toContain('ci."imageId"'); // 1. the image as an item
    expect(sql).toContain('c."imageId"'); // 2. the collection's cover
    expect(sql).toContain('ci."postId"'); // 3. a post item's first image
    expect(sql).toContain('ci."modelId"'); // 4. a model item's gallery image
    expect(sql).toContain('ci."articleId"'); // 5. an article item's cover
    expect(sql).toContain('ci."model3dId"'); // 6. a model3d item's thumbnail
    expect(sql).toContain('u."profilePictureId"'); // 7. the owner's avatar
  });

  // Route 7 is invisible to the CTE list: pullData fetches profile pictures with a
  // separate `db.image.findMany` and transformData ships it as `user.profilePicture`
  // on EVERY collection document. Enumerating from the CTEs alone misses it.
  it('resolves the owner-avatar route, which is not one of the index CTEs', async () => {
    primeImageLookup({ coverIndex: true, found: [COLLECTION_A] });

    await getCollectionIdsForImages({ imageIds: [IMAGE_ID], source: 'image-delete' });

    const sql = imageQuerySql();
    expect(sql).toMatch(/JOIN "User" u ON u\.id = c\."userId"/);
    expect(sql).toContain('u."profilePictureId"');
  });

  // Mirrors modelItemImage's own join in collections.search-index.ts. Without the
  // userId equality the two disagree about which image a collection would show.
  it('mirrors the index CTE join, including the post/model owner equality', async () => {
    primeImageLookup({ coverIndex: true, found: [COLLECTION_A] });

    await getCollectionIdsForImages({ imageIds: [IMAGE_ID], source: 'image-delete' });

    const sql = imageQuerySql();
    expect(sql).toContain('"ModelVersion"');
    expect(sql).toMatch(/m\."userId"\s*=\s*p\."userId"/);
  });

  // Every leg has to stay independently indexable; an OR across two columns is
  // non-sargable against a ~208M-row table. Case-insensitive so a lowercase `or`
  // cannot walk the guard.
  it('keeps the routes in UNIONed legs rather than one OR-ed predicate', async () => {
    primeImageLookup({ coverIndex: true, found: [COLLECTION_A] });

    await getCollectionIdsForImages({ imageIds: [IMAGE_ID], source: 'image-delete' });

    const sql = imageQuerySql();
    expect(sql).toMatch(/\bUNION\b/);
    expect(sql).not.toMatch(/\bOR\b/i);
  });

  it('does not query at all when given no ids', async () => {
    const result = await getCollectionIdsForImages({ imageIds: [] });

    expect(result).toEqual({ collectionIds: [], truncated: false });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('flags truncation when the cap is exceeded', async () => {
    primeImageLookup({
      coverIndex: true,
      found: [COLLECTION_A, COLLECTION_B, COLLECTION_C, 5519, 6284],
    });

    const result = await getCollectionIdsForImages({ imageIds: [IMAGE_ID], cap: 3 });

    expect(result.collectionIds).toEqual([COLLECTION_A, COLLECTION_B, COLLECTION_C]);
    expect(result.truncated).toBe(true);
  });

  it('never throws when the lookup fails, so a caller can resolve before its delete', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (isGate(Array.from(strings).join('?'))) return [{ present: true }];
      throw new Error('connection reset');
    });

    const result = await getCollectionIdsForImages({
      imageIds: [IMAGE_ID],
      source: 'image-delete',
    });

    expect(result).toEqual({ collectionIds: [], truncated: false });
    expect(serialisedError('collection-media-index-resolve-failed')).toMatchObject({
      name: 'Error',
      message: 'connection reset',
    });
  });
});

// ⚠️ These gate assertions are SPELLED, not structural: they check the statement text
// mentions `pg_index` / `indisvalid` / `relnamespace`, so a predicate written
// `AND x.indisvalid = false` would satisfy them. With `$queryRaw` behind a mock there
// is no way to evaluate the predicate without a real database, so this is the limit of
// what a unit test can pin here — recorded rather than papered over.
describe('getCollectionIdsForImages — the cover-index gate', () => {
  // 🔴 A `CREATE INDEX CONCURRENTLY` row appears in pg_class from the START of the
  // build and stays there permanently if the build FAILS. A name-only check therefore
  // returns true throughout a multi-minute build of a 2.8 GB heap, and forever after a
  // failure — switching the cover leg on in exactly the window the gate exists to
  // cover, so every image delete pays a parallel sequential scan concurrently with the
  // build. `indisvalid AND indisready` is what makes the gate mean "usable".
  it('asks whether the index is VALID and READY, not merely named', async () => {
    primeImageLookup({ coverIndex: true, found: [COLLECTION_A] });

    await getCollectionIdsForImages({ imageIds: [IMAGE_ID], source: 'image-delete' });

    const sql = gateSql();
    expect(sql).toContain('pg_index');
    expect(sql).toContain('indisvalid');
    expect(sql).toContain('indisready');
  });

  // `relname` is not unique across schemas and this database has a second one, so an
  // unqualified match could be satisfied by an index of the same name elsewhere.
  it('qualifies the catalog lookup to the public schema', async () => {
    primeImageLookup({ coverIndex: true, found: [COLLECTION_A] });

    await getCollectionIdsForImages({ imageIds: [IMAGE_ID], source: 'image-delete' });

    expect(gateSql()).toContain('relnamespace');
  });

  it('omits the cover leg and warns when the index is not usable', async () => {
    primeImageLookup({ coverIndex: false, found: [COLLECTION_B] });

    const result = await getCollectionIdsForImages({
      imageIds: [IMAGE_ID],
      source: 'image-delete',
    });

    const sql = imageQuerySql();
    expect(sql).not.toContain('c."imageId"');
    expect(sql).toContain('ci."imageId"'); // the other legs still run
    expect(result.collectionIds).toEqual([COLLECTION_B]);
    expect(logNamed('collection-media-index-cover-leg-skipped')?.message).toContain(
      COVER_INDEX_NAME
    );
  });

  it('does not warn about the cover leg when the index is usable', async () => {
    primeImageLookup({ coverIndex: true, found: [COLLECTION_B] });

    await getCollectionIdsForImages({ imageIds: [IMAGE_ID], source: 'image-delete' });

    expect(logNamed('collection-media-index-cover-leg-skipped')).toBeUndefined();
  });

  // Six of the seven legs do not depend on the cover index, so a blip on that one
  // extra catalog round-trip must not decide whether they run. Inside the main try it
  // would send the whole resolve to the catch and return nothing — a regression the
  // gate itself introduced, since before the gate there was no probe to fail.
  it('still resolves the other six legs when the catalog probe fails', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (isGate(Array.from(strings).join('?'))) throw new Error('statement timeout');
      return rows(COLLECTION_C);
    });

    const result = await getCollectionIdsForImages({
      imageIds: [IMAGE_ID],
      source: 'image-delete',
    });

    expect(result.collectionIds).toEqual([COLLECTION_C]);
    expect(imageQuerySql()).toContain('ci."postId"');
    expect(serialisedError('collection-media-index-cover-probe-failed')).toMatchObject({
      message: 'statement timeout',
    });
  });
});

describe('getCollectionIdsForModelCascade', () => {
  it('resolves the model, its posts and its gallery images', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows(COLLECTION_B, COLLECTION_A));

    const result = await getCollectionIdsForModelCascade({ modelId: MODEL_ID });

    expect(result.collectionIds).toEqual([COLLECTION_B, COLLECTION_A]);
    const sql = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(sql).toContain('ci."modelId"');
    expect(sql).toContain('ci."imageId"');
    expect(sql).toContain('"ModelVersion"');
  });

  // model.service hard-deletes Posts inside the same transaction and
  // CollectionItem.postId is onDelete: Cascade, while the index denormalizes a post
  // item's first image — so a Post-type membership row goes stale exactly like a
  // model-type one and has to be resolved before the cascade removes it.
  it('resolves the posts the cascade will delete, not just models and images', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows(COLLECTION_A));

    await getCollectionIdsForModelCascade({ modelId: MODEL_ID });

    expect(sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0])).toContain('ci."postId"');
  });

  it('never throws, so a failed lookup cannot cancel the delete that follows', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(getCollectionIdsForModelCascade({ modelId: MODEL_ID })).resolves.toEqual({
      collectionIds: [],
      truncated: false,
    });
  });

  // `CollectionItem` is a ~208M-row table. Bridging the columns with a single `OR`
  // makes the predicate non-sargable: Postgres uses none of the three indexes and
  // scans an unrelated one end to end with the whole condition as a post-scan Filter
  // (measured: 43.3M estimated rows, total cost 3,336,745). As separate UNIONed legs
  // every branch is an index scan (measured: cost 89.68 for the three-leg form).
  it('splits the columns into UNIONed legs so each can use its own index', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows(COLLECTION_A));

    await getCollectionIdsForModelCascade({ modelId: MODEL_ID });

    const sql = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(sql).toMatch(/\bUNION\b/);
    expect(sql.match(/FROM "CollectionItem"/g)).toHaveLength(3);
    expect(sql).not.toMatch(/\bOR\b/i);
  });
});

describe('enqueueCollectionRebuild', () => {
  it('queues an Update — never a Delete — for each collection', async () => {
    await enqueueCollectionRebuild({
      collectionIds: [COLLECTION_A, COLLECTION_C],
      truncated: false,
      source: 'image-delete',
    });

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledTimes(1);
    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith([
      { id: COLLECTION_A, action: SearchIndexUpdateQueueAction.Update },
      { id: COLLECTION_C, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('does not touch the index when there is nothing to rebuild', async () => {
    const result = await enqueueCollectionRebuild({
      collectionIds: [],
      truncated: false,
      source: 'image-delete',
    });

    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
    expect(result.queued).toBe(0);
  });

  it('batches so one enormous id list never becomes one enormous queue write', async () => {
    // 1200 distinct ids against a 500 batch size => 500 / 500 / 200. Ids start well
    // above every named constant so a batch boundary cannot coincide with an id.
    const ids = Array.from({ length: 1200 }, (_, i) => 20_000 + i);

    await enqueueCollectionRebuild({
      collectionIds: ids,
      truncated: false,
      source: 'image-delete',
    });

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledTimes(3);
    const sizes = mockCollectionsQueueUpdate.mock.calls.map((c) => (c[0] as unknown[]).length);
    expect(sizes).toEqual([500, 500, 200]);
    const queued = mockCollectionsQueueUpdate.mock.calls.flatMap(
      (c) => c[0] as { id: number; action: string }[]
    );
    expect(queued).toHaveLength(1200);
    expect(new Set(queued.map((q) => q.id)).size).toBe(1200);
    expect(queued.every((q) => q.action === SearchIndexUpdateQueueAction.Update)).toBe(true);
  });

  it('warns rather than truncating silently', async () => {
    await enqueueCollectionRebuild({
      collectionIds: [COLLECTION_A],
      truncated: true,
      source: 'model-perma-delete',
      cap: 3,
    });

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'collection-media-index-enqueue-truncated',
        type: 'warning',
        source: 'model-perma-delete',
        cap: 3,
      })
    );
  });

  // Every lookup stops at `LIMIT cap + 1`, so any figure the warning could quote is 1
  // however large the real overflow — and real models sit far past the cap (one
  // measured in 86,153 distinct collections). Quoting "1 more is stale" there would
  // understate by five orders of magnitude, so no number is quoted at all.
  it('does not quote a number it cannot know for the overflow', async () => {
    await enqueueCollectionRebuild({
      collectionIds: [COLLECTION_B],
      truncated: true,
      source: 'model-perma-delete',
      cap: 2,
    });

    const warning = logNamed('collection-media-index-enqueue-truncated');
    expect(warning?.message).toContain('unknown number');
    expect(warning?.message).not.toMatch(/\b1 more\b/);
  });

  it('never throws when the queue write fails, so post-delete cleanup still runs', async () => {
    mockCollectionsQueueUpdate.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await enqueueCollectionRebuild({
      collectionIds: [COLLECTION_B],
      truncated: false,
      source: 'image-delete',
    });

    expect(result.queued).toBe(0);
    // Asserted after the JSON round-trip for the same reason as the resolve failure:
    // `objectContaining({ message })` is satisfied by a raw Error too.
    expect(serialisedError('collection-media-index-enqueue-failed')).toMatchObject({
      name: 'Error',
      message: 'redis unavailable',
    });
  });
});
