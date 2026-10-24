import { vi, describe, it, expect, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const {
  imageTagsFetch,
  imageTagsBust,
  tagCacheFetch,
  imageVotes,
  modelVotes,
  modelVotableTagsFetch,
  modelVotableTagsBust,
  bustCacheTagSpy,
} = vi.hoisted(() => ({
  imageTagsFetch: vi.fn(),
  imageTagsBust: vi.fn(),
  tagCacheFetch: vi.fn(),
  imageVotes: vi.fn().mockResolvedValue([]),
  modelVotes: vi.fn().mockResolvedValue([]),
  modelVotableTagsFetch: vi.fn(),
  modelVotableTagsBust: vi.fn(),
  bustCacheTagSpy: vi.fn().mockResolvedValue(undefined),
}));

// The db and redis clients come from the canonical shared mocks. The read/write
// split the old direct mock declared is preserved node for node — `deleteTags`
// reads on `dbWrite.$queryRaw` (tag.service.ts:919/:930/:942) while the
// moderation-count check in `addTagVotes` reads on `dbRead.$queryRaw` (:711),
// so the two must NOT collapse onto one spy.
const executeRaw = dbMock.dbWrite.$executeRaw;
const dbWriteQueryRaw = dbMock.dbWrite.$queryRaw;
const dbReadQueryRaw = dbMock.dbRead.$queryRaw;
const modelFindFirst = dbMock.dbRead.model.findFirst;
// Kept only to prove the vote reads NO LONGER go through the Prisma engine.
const prismaImageVotes = dbMock.dbRead.tagsOnImageVote.findMany;
const prismaModelVotes = dbMock.dbRead.tagsOnModelsVote.findMany;
// Kept only to prove the model path no longer reads the ModelTag view directly.
const modelTagFindMany = dbMock.dbRead.modelTag.findMany;
const redisDel = redisMock.redis.del;
const redisPackedGet = redisMock.redis.packed.get;
const redisPackedSet = redisMock.redis.packed.set;

// Behaviour the old fixtures supplied, restated on the canonical nodes. These
// are set once, at module scope, so they survive the `vi.clearAllMocks()` in
// each `beforeEach` exactly as the hoisted spies' own defaults did.
executeRaw.mockResolvedValue(undefined);
dbWriteQueryRaw.mockResolvedValue([]);
dbReadQueryRaw.mockResolvedValue([{ count: 0 }]);
modelFindFirst.mockResolvedValue({ userId: 999 });
// `image.findFirst` shared the same spy — `addTagVotes` reads `creator?.userId`
// from whichever of the two the entity type selects.
dbMock.dbRead.image.findFirst.mockResolvedValue({ userId: 999 });
redisDel.mockResolvedValue(1);
redisPackedGet.mockResolvedValue(null);
redisPackedSet.mockResolvedValue(undefined);
prismaImageVotes.mockImplementation(async () => {
  throw new Error('tagsOnImageVote.findMany must not be called — ported to Kysely');
});
prismaModelVotes.mockImplementation(async () => {
  throw new Error('tagsOnModelsVote.findMany must not be called — ported to Kysely');
});

// deleteTags now also busts the static getTags listing cache via bustCacheTag('getTags').
// Spy only that helper; keep the rest of cache-helpers real so no other read-through breaks.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/utils/cache-helpers')>()),
  bustCacheTag: bustCacheTagSpy,
}));

vi.mock('~/server/redis/caches', () => ({
  imageTagsCache: { fetch: imageTagsFetch, bust: imageTagsBust },
  // The model votable-tags cache now backs the static portion of the model path
  // (mirrors imageTagsCache for the image path).
  modelVotableTagsCache: { fetch: modelVotableTagsFetch, bust: modelVotableTagsBust },
  tagCache: { fetch: tagCacheFetch },
}));
// The per-user vote reads run through @civitai/db-queries (Kysely over the app's own pg pool),
// bypassing the Prisma query engine. Mocked at that seam; the Prisma spies below are kept only to
// prove those reads no longer go through it.
vi.mock('@civitai/db-queries/tag', () => ({
  listImageTagVotes: imageVotes,
  listImageTagVotesMany: imageVotes,
  listModelTagVotes: modelVotes,
}));
// clearCache() fans out to the hidden-preferences caches — stub them so the vote
// mutations don't reach real Redis/DB.
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenImages: { refreshCache: vi.fn() },
  HiddenModels: { refreshCache: vi.fn() },
  ImplicitHiddenImages: { refreshCache: vi.fn() },
}));

import {
  addTagVotes,
  addTags,
  deleteTags,
  disableTags,
  getVotableImageTags,
  getVotableTags,
  removeTagVotes,
} from '~/server/services/tag.service';
// NOT mocked: the real client the service passes to the ported query functions. Asserting it with
// `toBe` is what keeps these reads pinned to the read tier — see the read-tier describe at the
// bottom of this file for why `toBe` and not a structural matcher.
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import type { SessionUser } from '~/types/session';

const WRONG_TIER =
  'ported read was handed a client other than kyselyRead (kyselyWrite / kyselyReadLong routes it ' +
  'at the wrong tier); note kyselyRead and kyselyWrite are deep-equal, so only toBe catches this';

const LOLI = 114467;
const NUDE = 304;

// Shape of a cached ModelTag composite row (what modelVotableTagsCache stores).
function modelTag(tagId: number, tagName: string) {
  return { tagId, tagName, tagType: 'UserGenerated', score: 5, upVotes: 5, downVotes: 0 };
}

// Prime the cache mock for model `id` with the given composite tags.
function primeModelCache(id: number, tags: ReturnType<typeof modelTag>[]) {
  modelVotableTagsFetch.mockResolvedValue({ [id]: { modelId: id, tags } });
}

describe('getVotableTags — model tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelVotes.mockResolvedValue([]);
    primeModelCache(1, [modelTag(NUDE, 'nude'), modelTag(LOLI, 'loli')]);
    tagCacheFetch.mockResolvedValue({
      [NUDE]: { id: NUDE, name: 'nude', unlisted: undefined },
      [LOLI]: { id: LOLI, name: 'loli', unlisted: true },
    });
  });

  // ModelTag has no unlisted filter of its own (unlike the ImageTag view), so the
  // service has to drop them or they reach the votable chips.
  it('drops unlisted tags for a normal user', async () => {
    const tags = await getVotableTags({ type: 'model', id: 1, isModerator: false });
    expect(tags.map((t) => t.id)).toEqual([NUDE]);
  });

  it('keeps unlisted tags for moderators, who need to see what content is flagged as', async () => {
    const tags = await getVotableTags({ type: 'model', id: 1, isModerator: true });
    expect(tags.map((t) => t.id).sort()).toEqual([NUDE, LOLI].sort());
    expect(tagCacheFetch).not.toHaveBeenCalled();
  });

  it('leaves listed tags untouched', async () => {
    primeModelCache(1, [modelTag(NUDE, 'nude')]);
    const tags = await getVotableTags({ type: 'model', id: 1, isModerator: false });
    expect(tags.map((t) => t.id)).toEqual([NUDE]);
  });

  it('does not hit the tag cache when there are no tags', async () => {
    primeModelCache(1, []);
    const tags = await getVotableTags({ type: 'model', id: 1, isModerator: false });
    expect(tags).toEqual([]);
    expect(tagCacheFetch).not.toHaveBeenCalled();
  });

  // The static (user-independent) hierarchy read is now served by the cache, NOT a
  // direct DB read of the ModelTag view. This is the DB-load-reduction lever.
  it('reads the static tags from the cache, never the ModelTag view directly', async () => {
    await getVotableTags({ type: 'model', id: 1, isModerator: false });
    expect(modelVotableTagsFetch).toHaveBeenCalledTimes(1);
    expect(modelVotableTagsFetch).toHaveBeenCalledWith([1]);
    expect(modelTagFindMany).not.toHaveBeenCalled();
  });

  // The output shape (fields + values) must be byte-identical to the pre-cache
  // function: cached composite rows are mapped to the VotableTagModel shape.
  it('produces the unchanged VotableTagModel shape from cached composite rows', async () => {
    primeModelCache(1, [modelTag(NUDE, 'nude')]);
    const tags = await getVotableTags({ type: 'model', id: 1, isModerator: true });
    expect(tags).toEqual([
      {
        id: NUDE,
        name: 'nude',
        type: 'UserGenerated',
        nsfwLevel: 0,
        score: 5,
        upVotes: 5,
        downVotes: 0,
      },
    ]);
  });

  describe('per-user vote merge (no cross-user leakage)', () => {
    beforeEach(() => {
      // Same static tags for the model, cache shared across users.
      primeModelCache(1, [modelTag(NUDE, 'nude')]);
      tagCacheFetch.mockResolvedValue({ [NUDE]: { id: NUDE, name: 'nude' } });
    });

    it('merges each user OWN vote from their own tagsOnModelsVote read, uncached', async () => {
      // User A upvoted; user B downvoted the SAME tag on the SAME model.
      modelVotes.mockImplementation(async (_db: unknown, { userId }: { userId: number }) => {
        if (userId === 111) return [{ tagId: NUDE, vote: 1 }];
        if (userId === 222) return [{ tagId: NUDE, vote: -1 }];
        return [];
      });

      const aTags = await getVotableTags({ type: 'model', id: 1, userId: 111, isModerator: true });
      const bTags = await getVotableTags({ type: 'model', id: 1, userId: 222, isModerator: true });

      // Each user sees THEIR OWN vote — no bleed from the shared static cache.
      expect(aTags.find((t) => t.id === NUDE)?.vote).toBe(1);
      expect(bTags.find((t) => t.id === NUDE)?.vote).toBe(-1);

      // The per-user vote read is scoped to that user + this model (uncached path), and runs on
      // the READ tier. The client is asserted with `toBe` — see the read-tier describe at the
      // bottom of this file for why matcher choice is load-bearing here.
      expect(modelVotes.mock.calls[0][0], WRONG_TIER).toBe(kyselyRead);
      expect(modelVotes.mock.calls[0][1]).toEqual({ modelId: 1, userId: 111 });
      expect(modelVotes.mock.calls[1][0], WRONG_TIER).toBe(kyselyRead);
      expect(modelVotes.mock.calls[1][1]).toEqual({ modelId: 1, userId: 222 });
      expect(modelVotes).toHaveBeenCalledTimes(2);
      // The vote read no longer touches the Prisma engine.
      expect(prismaModelVotes).not.toHaveBeenCalled();
    });

    it('an anonymous request never reads per-user votes', async () => {
      const tags = await getVotableTags({ type: 'model', id: 1, isModerator: true });
      expect(tags.find((t) => t.id === NUDE)?.vote).toBeUndefined();
      expect(modelVotes).not.toHaveBeenCalled();
    });
  });
});

describe('getVotableTags — image tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imageVotes.mockResolvedValue([]);
    imageTagsFetch.mockResolvedValue({
      1: {
        imageId: 1,
        tags: [
          {
            tagId: NUDE,
            tagName: 'nude',
            tagType: 'UserGenerated',
            tagNsfwLevel: 1,
            score: 10,
            upVotes: 10,
            downVotes: 0,
            automated: true,
            needsReview: false,
            concrete: true,
            lastUpvote: null,
            source: 'WD14',
          },
        ],
      },
    });
  });

  // Images need no strip: the ImageTag view the cache reads from already excludes
  // unlisted tags, so one can't reach here. Asserting we don't pay for a redundant
  // cache lookup on the image-detail path.
  it('does not do an unlisted lookup — the ImageTag view already filters them', async () => {
    const tags = await getVotableTags({ type: 'image', id: 1, isModerator: false });
    expect(tags.map((t) => t.id)).toEqual([NUDE]);
    expect(tagCacheFetch).not.toHaveBeenCalled();
  });

  // The image path must not touch the model cache.
  it('does not touch the model votable-tags cache', async () => {
    await getVotableTags({ type: 'image', id: 1, isModerator: false });
    expect(modelVotableTagsFetch).not.toHaveBeenCalled();
  });
});

// The whole "always fresh / no behaviour change" (bucket-A) contract rests on busting
// the model votable-tags cache on EVERY mutation that changes a model's score>0 ModelTag
// rows. Pre-change the model path read the DB on every call, so a dropped bust is a NEW
// ≤TTL staleness regression. These pin each bust so a refactor can't silently drop one.
//
// ModelTag view fact (containers/db/docker-init/02_all_dll.sql): each TagsOnModels row
// contributes a BASE score of 5 (UNION with the vote sums), so an APPLIED tag is score>0
// with no vote — hence addTags must bust, not just the vote paths.
describe('getVotableTags — model votable-tags cache invalidation contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('addTagVotes(model) busts the model cache for the voted model', async () => {
    await addTagVotes({ userId: 111, type: 'model', id: 42, tags: [304], vote: 1 });
    expect(modelVotableTagsBust).toHaveBeenCalledWith(42);
    expect(imageTagsBust).not.toHaveBeenCalled();
  });

  it('removeTagVotes(model) busts the model cache for the voted model', async () => {
    await removeTagVotes({ userId: 111, type: 'model', id: 42, tags: [304] });
    expect(modelVotableTagsBust).toHaveBeenCalledWith(42);
    expect(imageTagsBust).not.toHaveBeenCalled();
  });

  it('addTags(model) busts the model cache for the applied modelIds (base score 5 → visible)', async () => {
    await addTags({ tags: [304], entityIds: [7, 8], entityType: 'model' });
    expect(modelVotableTagsBust).toHaveBeenCalledWith([7, 8]);
  });

  it('disableTags(model) busts the model cache for the affected modelIds', async () => {
    await disableTags({ tags: [304], entityIds: [7, 8], entityType: 'model' });
    expect(modelVotableTagsBust).toHaveBeenCalledWith([7, 8]);
  });

  it('deleteTags busts the model cache for models resolved from the ModelTag view', async () => {
    // deleteTags reads affected images (1st $queryRaw), affected models (2nd), then
    // affected tag names (3rd) before deleting the Tag row.
    dbWriteQueryRaw.mockReset();
    dbWriteQueryRaw
      .mockResolvedValueOnce([]) // affected images
      .mockResolvedValueOnce([{ modelId: 5 }, { modelId: 6 }]) // affected models
      .mockResolvedValueOnce([{ name: 'nude' }]); // affected tag names
    await deleteTags({ tags: [304] });
    expect(modelVotableTagsBust).toHaveBeenCalledWith([5, 6]);
  });

  it('deleteTags busts the per-name getTagWithModelCount cache for the deleted names', async () => {
    // Even when deleteTags is called by ID, the affected NAMES are resolved from the DB
    // (3rd $queryRaw) so the name-keyed cache is busted with the exact stored names. Both
    // are busted regardless of input case — the key is lowercased.
    dbWriteQueryRaw.mockReset();
    dbWriteQueryRaw
      .mockResolvedValueOnce([]) // affected images
      .mockResolvedValueOnce([]) // affected models
      .mockResolvedValueOnce([{ name: 'Anime' }, { name: 'nude' }]); // affected tag names
    await deleteTags({ tags: [304, 305] });
    expect(redisDel).toHaveBeenCalledWith('packed:caches:tag-with-model-count:anime');
    expect(redisDel).toHaveBeenCalledWith('packed:caches:tag-with-model-count:nude');
    // Plus the feed tag bar's chip list, which `deleteTags` also busts — a deleted tag
    // must not keep serving as a chip. The count stays exact rather than becoming a
    // `>=`: it is what catches a bust being dropped, and naming the third key here is
    // what tells the next reader which one arrived.
    expect(redisDel).toHaveBeenCalledWith('system:feed-tag-bar-tags');
    expect(redisDel).toHaveBeenCalledTimes(3);
  });

  it('a vote on an IMAGE does not bust the model cache', async () => {
    await addTagVotes({ userId: 111, type: 'image', id: 42, tags: [304], vote: 1 });
    expect(modelVotableTagsBust).not.toHaveBeenCalled();
    expect(imageTagsBust).toHaveBeenCalledWith(42);
  });

  it('deleteTags also busts the static getTags listing cache', async () => {
    dbWriteQueryRaw.mockReset();
    dbWriteQueryRaw
      .mockResolvedValueOnce([]) // affected images
      .mockResolvedValueOnce([]) // affected models
      .mockResolvedValueOnce([]); // affected tag names
    await deleteTags({ tags: [304] });
    expect(bustCacheTagSpy).toHaveBeenCalledWith('getTags');
  });

  it('a model vote does NOT bust the getTags listing cache (join-table only)', async () => {
    await addTagVotes({ userId: 111, type: 'model', id: 1, tags: [304], vote: 1 });
    expect(bustCacheTagSpy).not.toHaveBeenCalledWith('getTags');
  });
});

/**
 * Read-tier seam.
 *
 * Before the Kysely port these reads were `dbRead.tagsOn*Vote.findMany`, and the mock lived on
 * `dbRead` SPECIFICALLY — so a read routed at the writer had no mock to hit and blew up. Mocking
 * the query-function seam instead moves that property out of the suite unless the client argument
 * is pinned: `expect.anything()` is satisfied by `kyselyWrite`, `kyselyReadLong` or anything else.
 * That loss was measured, not assumed — routing every ported read at `kyselyWrite` failed 1 test
 * on pre-port code and passed the whole suite after the port.
 *
 * 🔴 The matcher matters as much as the argument. `kyselyRead` and `kyselyWrite` are DISTINCT
 * objects but they are `toEqual`-DEEP-EQUAL (same Kysely shape, and in a single-DB environment the
 * same underlying pool), so `toHaveBeenCalledWith(kyselyRead, …)` — which compares structurally —
 * still passes when the read is routed at the writer. Measured, again: the first cut of this fix
 * used `toHaveBeenCalledWith` and the wrong-tier mutant survived it. Only `toBe` discriminates.
 *
 * These pin the tier for the two image-side ports; the model-side port is pinned inline in the
 * per-user vote merge test above.
 */
describe('ported vote reads run on the kyselyRead tier, not the writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imageVotes.mockResolvedValue([]);
    modelVotes.mockResolvedValue([]);
    imageTagsFetch.mockResolvedValue({ 1: { imageId: 1, tags: [] } });
    primeModelCache(1, [modelTag(NUDE, 'nude')]);
    tagCacheFetch.mockResolvedValue({ [NUDE]: { id: NUDE, name: 'nude' } });
  });

  it('getVotableTags(image) reads one image’s votes through kyselyRead', async () => {
    await getVotableTags({ type: 'image', id: 1, userId: 111, isModerator: true });
    expect(imageVotes).toHaveBeenCalledTimes(1);
    expect(imageVotes.mock.calls[0][0], WRONG_TIER).toBe(kyselyRead);
    expect(imageVotes.mock.calls[0][1]).toEqual({ imageId: 1, userId: 111 });
  });

  it('getVotableTags(model) reads one model’s votes through kyselyRead', async () => {
    await getVotableTags({ type: 'model', id: 1, userId: 111, isModerator: true });
    expect(modelVotes).toHaveBeenCalledTimes(1);
    expect(modelVotes.mock.calls[0][0], WRONG_TIER).toBe(kyselyRead);
    expect(modelVotes.mock.calls[0][1]).toEqual({ modelId: 1, userId: 111 });
  });

  it('getVotableImageTags reads the bulk vote overlay through kyselyRead', async () => {
    await getVotableImageTags({ ids: [1], user: { id: 111 } as SessionUser });
    expect(imageVotes).toHaveBeenCalledTimes(1);
    expect(imageVotes.mock.calls[0][0], WRONG_TIER).toBe(kyselyRead);
    expect(imageVotes.mock.calls[0][1]).toEqual({ imageIds: [1], userId: 111 });
  });

  // Negative control on the matcher above: `kyselyWrite` is a DIFFERENT object, so `toBe`
  // separates the tiers — but it is deep-equal, so a structural matcher would not. This pins the
  // reason `toBe` is used, and fails if the two clients ever become the same object (at which
  // point the assertions above would be inert and this seam needs a different pin).
  it('toBe separates the read and write clients even though toEqual does not', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
    expect(kyselyRead).toEqual(kyselyWrite);
  });
});
