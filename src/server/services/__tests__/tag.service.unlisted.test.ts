import { vi, describe, it, expect, beforeEach } from 'vitest';

// Unlisted tags are hidden from tag lists, search and tag pages. They must not
// reach the client on votable chips either — that would advertise the exact tags
// we delisted and invite votes on them.

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

function imageTag(tagId: number, tagName: string) {
  return {
    tagId,
    tagName,
    tagType: 'UserGenerated',
    tagNsfwLevel: 1,
    score: 10,
    upVotes: 10,
    downVotes: 0,
    automated: true,
    needsReview: false,
    concrete: true, // survives the vote-cutoff filter
    lastUpvote: null,
    source: 'WD14',
  };
}

describe('getVotableTags — unlisted tags never reach the client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imageVotes.mockResolvedValue([]);
    modelVotes.mockResolvedValue([]);
    imageTagsFetch.mockResolvedValue({
      1: { imageId: 1, tags: [imageTag(NUDE, 'nude'), imageTag(LOLI, 'loli')] },
    });
    // loli is unlisted; nude is not
    tagCacheFetch.mockResolvedValue({
      [NUDE]: { id: NUDE, name: 'nude', unlisted: undefined },
      [LOLI]: { id: LOLI, name: 'loli', unlisted: true },
    });
  });

  it('drops an unlisted tag for a normal user', async () => {
    const tags = await getVotableTags({ type: 'image', id: 1, isModerator: false });
    expect(tags.map((t) => t.id)).toEqual([NUDE]);
  });

  it('keeps unlisted tags for moderators, who need to see what content is flagged as', async () => {
    const tags = await getVotableTags({ type: 'image', id: 1, isModerator: true });
    expect(tags.map((t) => t.id).sort()).toEqual([NUDE, LOLI].sort());
    // moderators short-circuit the strip — no cache lookup needed
    expect(tagCacheFetch).not.toHaveBeenCalled();
  });

  it('keeps listed tags untouched', async () => {
    imageTagsFetch.mockResolvedValue({ 1: { imageId: 1, tags: [imageTag(NUDE, 'nude')] } });
    const tags = await getVotableTags({ type: 'image', id: 1, isModerator: false });
    expect(tags.map((t) => t.id)).toEqual([NUDE]);
  });

  it('strips unlisted tags on models too, not just images', async () => {
    modelTagFindMany.mockResolvedValue([
      {
        tagId: NUDE,
        tagName: 'nude',
        tagType: 'UserGenerated',
        score: 5,
        upVotes: 5,
        downVotes: 0,
      },
      {
        tagId: LOLI,
        tagName: 'loli',
        tagType: 'UserGenerated',
        score: 5,
        upVotes: 5,
        downVotes: 0,
      },
    ]);
    const tags = await getVotableTags({ type: 'model', id: 1, isModerator: false });
    expect(tags.map((t) => t.id)).toEqual([NUDE]);
  });

  it('does not hit the tag cache when there are no tags', async () => {
    imageTagsFetch.mockResolvedValue({ 1: { imageId: 1, tags: [] } });
    const tags = await getVotableTags({ type: 'image', id: 1, isModerator: false });
    expect(tags).toEqual([]);
    expect(tagCacheFetch).not.toHaveBeenCalled();
  });
});
