import { vi, describe, it, expect, beforeEach } from 'vitest';

const {
  imageTagsFetch,
  tagCacheFetch,
  imageVotes,
  modelTagFindMany,
  modelVotes,
  modelVotableTagsFetch,
} = vi.hoisted(() => ({
  imageTagsFetch: vi.fn(),
  tagCacheFetch: vi.fn(),
  imageVotes: vi.fn().mockResolvedValue([]),
  modelTagFindMany: vi.fn(),
  modelVotes: vi.fn().mockResolvedValue([]),
  modelVotableTagsFetch: vi.fn(),
}));

vi.mock('~/server/redis/caches', () => ({
  imageTagsCache: { fetch: imageTagsFetch, bust: vi.fn() },
  // The model votable-tags cache now backs the static portion of the model path
  // (mirrors imageTagsCache for the image path).
  modelVotableTagsCache: { fetch: modelVotableTagsFetch, bust: vi.fn() },
  tagCache: { fetch: tagCacheFetch },
}));
vi.mock('~/server/db/client', () => ({
  dbRead: {
    tagsOnImageVote: { findMany: imageVotes },
    tagsOnModelsVote: { findMany: modelVotes },
    // Kept only to prove the model path NO LONGER reads the ModelTag view directly.
    modelTag: { findMany: modelTagFindMany },
  },
  dbWrite: {},
}));

import { getVotableTags } from '~/server/services/tag.service';

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
      modelVotes.mockImplementation(async ({ where }: { where: { userId: number } }) => {
        if (where.userId === 111) return [{ tagId: NUDE, vote: 1 }];
        if (where.userId === 222) return [{ tagId: NUDE, vote: -1 }];
        return [];
      });

      const aTags = await getVotableTags({ type: 'model', id: 1, userId: 111, isModerator: true });
      const bTags = await getVotableTags({ type: 'model', id: 1, userId: 222, isModerator: true });

      // Each user sees THEIR OWN vote — no bleed from the shared static cache.
      expect(aTags.find((t) => t.id === NUDE)?.vote).toBe(1);
      expect(bTags.find((t) => t.id === NUDE)?.vote).toBe(-1);

      // The per-user vote read is scoped to that user + this model (uncached path).
      expect(modelVotes).toHaveBeenNthCalledWith(1, {
        where: { modelId: 1, userId: 111 },
        select: { tagId: true, vote: true },
      });
      expect(modelVotes).toHaveBeenNthCalledWith(2, {
        where: { modelId: 1, userId: 222 },
        select: { tagId: true, vote: true },
      });
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
