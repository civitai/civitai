import { vi, describe, it, expect, beforeEach } from 'vitest';

const { imageTagsFetch, tagCacheFetch, imageVotes, modelTagFindMany, modelVotes } = vi.hoisted(
  () => ({
    imageTagsFetch: vi.fn(),
    tagCacheFetch: vi.fn(),
    imageVotes: vi.fn().mockResolvedValue([]),
    modelTagFindMany: vi.fn(),
    modelVotes: vi.fn().mockResolvedValue([]),
  })
);

vi.mock('~/server/redis/caches', () => ({
  imageTagsCache: { fetch: imageTagsFetch, bust: vi.fn() },
  tagCache: { fetch: tagCacheFetch },
}));
vi.mock('~/server/db/client', () => ({
  dbRead: {
    tagsOnImageVote: { findMany: imageVotes },
    tagsOnModelsVote: { findMany: modelVotes },
    modelTag: { findMany: modelTagFindMany },
  },
  dbWrite: {},
}));

import { getVotableTags } from '~/server/services/tag.service';

const LOLI = 114467;
const NUDE = 304;

function modelTag(tagId: number, tagName: string) {
  return { tagId, tagName, tagType: 'UserGenerated', score: 5, upVotes: 5, downVotes: 0 };
}

describe('getVotableTags — model tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelVotes.mockResolvedValue([]);
    modelTagFindMany.mockResolvedValue([modelTag(NUDE, 'nude'), modelTag(LOLI, 'loli')]);
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
    modelTagFindMany.mockResolvedValue([modelTag(NUDE, 'nude')]);
    const tags = await getVotableTags({ type: 'model', id: 1, isModerator: false });
    expect(tags.map((t) => t.id)).toEqual([NUDE]);
  });

  it('does not hit the tag cache when there are no tags', async () => {
    modelTagFindMany.mockResolvedValue([]);
    const tags = await getVotableTags({ type: 'model', id: 1, isModerator: false });
    expect(tags).toEqual([]);
    expect(tagCacheFetch).not.toHaveBeenCalled();
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
});
