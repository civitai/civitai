import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Coverage for the post and article cascade resolvers.
 *
 * `CollectionItem` cascades from `Post` and `Article`, so hard-deleting either takes
 * the membership rows with it — and with them the only record of which collection
 * documents just went stale. #4661 wired the image and permanent-model paths; these
 * two were left, so a collection emptied by a post or article delete kept its
 * pre-deletion document forever.
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
  getCollectionIdsForArticle,
  getCollectionIdsForPostCascade,
  POST_IMAGE_LOOKUP_CAP,
} from '~/server/services/collection-media-index';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const POST_ID = 5519;
const ARTICLE_ID = 3307;
const COLLECTION_A = 8801;
const COLLECTION_B = 9107;
const POST_IMAGE_ID = 6142;

const rows = (...ids: number[]) => ids.map((collectionId) => ({ collectionId }));

// The template-tag call arrives as [strings, ...values]. Joining `strings` alone would
// render an interpolated `Prisma.sql` fragment as `?`, so a leg assertion would pass or
// fail regardless of whether the leg is there. Splice nested fragments back in.
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

/**
 * The two lookups must answer with DIFFERENT collections. Returning the same id from
 * both makes `merged` never exceed what the inner `applyCap`s already trimmed, so the
 * merge, the cap and the truncation flag are all unobservable — a mutant returning
 * `merged` uncapped survives.
 */
function prime({
  coverIndex,
  own = [COLLECTION_A],
  viaImages = [COLLECTION_B],
  postImageIds = [POST_IMAGE_ID],
}: {
  coverIndex: boolean;
  own?: number[];
  viaImages?: number[];
  postImageIds?: number[];
}) {
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = Array.from(strings).join('?');
    if (isGate(sql)) return [{ present: coverIndex }];
    // The post's image ids, which the image legs are then bound to.
    if (sql.includes('SELECT i.id FROM "Image" i')) return postImageIds.map((id) => ({ id }));
    if (sql.includes('SELECT DISTINCT ci."collectionId"')) return rows(...own);
    return rows(...viaImages);
  });
}

/** Values actually bound into the statement containing a token, nested fragments flattened. */
const boundValuesOf = (needle: string) => {
  const call = dbMock.dbWrite.$queryRaw.mock.calls.find((c: unknown[]) =>
    sqlOf(c).includes(needle)
  ) as [string[], ...unknown[]];
  if (!call) throw new Error(`no statement containing ${needle}`);
  const [, ...values] = call;
  return values.flatMap((v) => (v as { values?: unknown[] })?.values ?? [v]);
};

/** The statement containing a given token, whatever else ran before it. */
const sqlContaining = (needle: string) => {
  const call = dbMock.dbWrite.$queryRaw.mock.calls.find((c: unknown[]) =>
    sqlOf(c).includes(needle)
  );
  if (!call) throw new Error(`no statement containing ${needle}`);
  return sqlOf(call as unknown[]);
};

/** The seven-leg image query, which getCollectionIdsForImages issues. */
const legsSql = () => sqlContaining('x."collectionId"');
/** The post's own membership lookup. Selected on `DISTINCT ci.`, which the seven-leg
 *  query (`DISTINCT x.`) does not have — matching on `ci."postId"` alone finds the
 *  image query's post leg instead, and the assertion below then passes either way. */
const ownSql = () => sqlContaining('SELECT DISTINCT ci."collectionId"');

const logNamed = (name: string) =>
  loggingMock.logToAxiom.mock.calls
    .map((c) => c[0] as { name?: string; message?: string })
    .find((a) => a?.name === name);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCollectionIdsForPostCascade', () => {
  it('resolves every route by which a deleted post reaches a collection document', async () => {
    prime({ coverIndex: true });

    await getCollectionIdsForPostCascade({ postId: POST_ID });

    expect(ownSql()).toContain('ci."postId"');

    const sql = legsSql();
    expect(sql).toContain('ci."imageId"');
    expect(sql).toContain('ci."modelId"'); // a model item whose gallery image lives here
    expect(sql).toContain('ci."articleId"'); // an article whose cover lives here
    expect(sql).toContain('ci."model3dId"'); // a model3d whose thumbnail lives here
    expect(sql).toContain('c."imageId"'); // a collection whose cover lives here
    expect(sql).toContain('u."profilePictureId"'); // an owner avatar that lives here
  });

  it('omits the cover leg when the index is not usable', async () => {
    prime({ coverIndex: false });

    await getCollectionIdsForPostCascade({ postId: POST_ID });

    // `c."imageId"` appears in no other leg.
    expect(legsSql()).not.toContain('c."imageId"');
  });

  it('splits the columns into UNIONed legs, never one OR', async () => {
    // The OR form is not sargable — see getCollectionIdsForModelCascade for the numbers.
    prime({ coverIndex: true });

    await getCollectionIdsForPostCascade({ postId: POST_ID });

    const sql = legsSql();
    expect(sql).toContain('UNION');
    expect(sql).not.toMatch(/\bOR\b/);
  });

  it("returns the union of the post's own membership and its images", async () => {
    prime({ coverIndex: true, own: [COLLECTION_A], viaImages: [COLLECTION_B] });

    const result = await getCollectionIdsForPostCascade({ postId: POST_ID });

    expect(result.collectionIds.sort()).toEqual([COLLECTION_A, COLLECTION_B].sort());
    expect(result.truncated).toBe(false);
  });

  it('binds the image ids instead of re-deriving them per leg', async () => {
    // A repeated `SELECT id FROM "Image" WHERE "postId" = $1` estimates 148 rows per
    // occurrence, and the planner then merge-joins the whole of Collection_imageId_idx
    // for the cover leg and seq-scans Model3D for the thumbnail leg. Bound ids make
    // both index probes again. Measured on the prod replica, plain EXPLAIN.
    prime({ coverIndex: true });

    await getCollectionIdsForPostCascade({ postId: POST_ID });

    expect(legsSql()).not.toContain('FROM "Image" i WHERE i."postId"');
    // The values are the artifact the code produced; the reassembled template is not.
    // Binding the post id here instead of its images resolves zero collections while
    // every shape assertion above stays green.
    expect(boundValuesOf('x."collectionId"')).toContain(POST_IMAGE_ID);
    expect(boundValuesOf('x."collectionId"')).not.toContain(POST_ID);
  });

  it('caps the collections it returns and says the cap was reached', async () => {
    // Disjoint legs, so the union is genuinely larger than either side.
    prime({ coverIndex: true, own: [COLLECTION_A], viaImages: [COLLECTION_B] });

    const result = await getCollectionIdsForPostCascade({ postId: POST_ID, cap: 1 });

    expect(result.collectionIds).toEqual([COLLECTION_A]);
    expect(result.truncated).toBe(true);
  });

  it('still resolves the other six legs when the catalog probe fails', async () => {
    // Six legs do not depend on the cover index, so one extra round-trip failing must
    // not decide whether they run — inside the main try it would return nothing.
    dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('?');
      if (isGate(sql)) throw new Error('catalog timeout');
      if (sql.includes('SELECT i.id FROM "Image" i')) return [{ id: POST_IMAGE_ID }];
      if (sql.includes('SELECT DISTINCT ci."collectionId"')) return rows(COLLECTION_A);
      return rows(COLLECTION_B);
    });

    const result = await getCollectionIdsForPostCascade({ postId: POST_ID });

    // COLLECTION_B comes only from the image legs, so this fails if they are skipped.
    expect(result.collectionIds).toContain(COLLECTION_B);
    expect(logNamed('collection-media-index-cover-probe-failed')).toBeDefined();
  });

  it('warns when the cover leg is skipped, so a missing migration is visible', async () => {
    prime({ coverIndex: false });

    await getCollectionIdsForPostCascade({ postId: POST_ID });

    expect(logNamed('collection-media-index-cover-leg-skipped')).toBeDefined();
  });

  it('says so when the post has more images than the lookup can bind', async () => {
    // Silently truncating here under-resolves the six image routes while reporting
    // `truncated: false` — a stale document with no signal that anything was dropped.
    // Unreachable while POST_IMAGE_LIMIT is 20; the cap exists for data drift, which is
    // exactly when the caller needs to be told.
    prime({
      coverIndex: true,
      postImageIds: Array.from({ length: POST_IMAGE_LOOKUP_CAP + 1 }, (_, i) => i + 1),
    });

    const result = await getCollectionIdsForPostCascade({ postId: POST_ID });

    expect(result.truncated).toBe(true);
    expect(logNamed('collection-media-index-post-images-truncated')).toBeDefined();
  });

  it('never throws when the lookup fails, so it cannot cancel the delete', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('connection reset'));

    const result = await getCollectionIdsForPostCascade({ postId: POST_ID });

    expect(result).toEqual({ collectionIds: [], truncated: false });
    expect(logNamed('collection-media-index-resolve-failed')).toBeDefined();
  });
});

describe('getCollectionIdsForArticle', () => {
  it('resolves the collections holding the article as an item', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue(rows(COLLECTION_A));

    const result = await getCollectionIdsForArticle({ articleId: ARTICLE_ID });

    expect(sqlContaining('ci."articleId"')).toContain('ci."articleId"');
    expect(result.collectionIds).toEqual([COLLECTION_A]);
  });

  it('caps the collections it returns and says the cap was reached', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue(rows(COLLECTION_A, COLLECTION_B));

    const result = await getCollectionIdsForArticle({ articleId: ARTICLE_ID, cap: 1 });

    expect(result.collectionIds).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('never throws when the lookup fails, so it cannot cancel the delete', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('connection reset'));

    const result = await getCollectionIdsForArticle({ articleId: ARTICLE_ID });

    expect(result).toEqual({ collectionIds: [], truncated: false });
    expect(logNamed('collection-media-index-resolve-failed')).toBeDefined();
  });
});
