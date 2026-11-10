import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Availability, ModelModifier } from '~/shared/utils/prisma/enums';

/**
 * `getPostResourceCovers` reads the covers of a post's resources for the post's owner: one batched
 * read of the shared version-image cache, narrowed to the owner's browsing level, with taken-down
 * and private models left out. The cache already drops unpublished, blocked and unreviewed images.
 */

const { mockFetchCovers } = vi.hoisted(() => ({ mockFetchCovers: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesForModelVersionsCache: { fetch: mockFetchCovers },
}));

import { getPostResourceCovers } from '~/server/services/post.service';

const OWNER = 5;
const POST_ID = 9;
const owner = { id: OWNER } as never;

// nsfwLevel 1 = PG, 4 = R
const cached = (id: number, versionId: number, nsfwLevel = 1) => ({
  id,
  userId: 5,
  name: 'private-name',
  url: `url-${id}`,
  type: 'image',
  nsfwLevel,
  width: 512,
  height: 768,
  hash: `hash-${id}`,
  modelVersionId: versionId,
  availability: 'Public',
  metadata: { secret: true },
  poi: false,
  minor: false,
});

const model = (overrides: Record<string, unknown> = {}) => ({
  mode: null,
  nsfw: false,
  nsfwLevel: 1,
  sfwName: null,
  sfwCoverImageId: null,
  availability: Availability.Public,
  userId: 99,
  ...overrides,
});

function postHas(versions: Record<number, ReturnType<typeof model>>, name = 'lora') {
  dbMock.dbRead.post.findUnique.mockResolvedValue({ userId: OWNER });
  dbMock.dbRead.postResourceHelper.findMany.mockResolvedValue(
    Object.keys(versions).map((id) => ({ postId: POST_ID, modelVersionId: Number(id), name }))
  );
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue(
    Object.entries(versions).map(([id, m]) => ({ id: Number(id), model: m }))
  );
}

const coversFor = (browsingLevel = allBrowsingLevelsFlag, user = owner) =>
  getPostResourceCovers({ id: POST_ID, user, browsingLevel });

beforeEach(() => {
  mockFetchCovers.mockReset().mockResolvedValue({
    1: { modelVersionId: 1, images: [cached(11, 1, 4), cached(12, 1, 1)] },
    3: { modelVersionId: 3, images: [] },
  });
  postHas({ 1: model(), 3: model() });
});

describe('getPostResourceCovers', () => {
  it('serves nothing to a viewer who does not own the post', async () => {
    await expect(coversFor(allBrowsingLevelsFlag, { id: 77 } as never)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockFetchCovers).not.toHaveBeenCalled();
  });

  it('reads every version in one cache call and returns the first image as the cover', async () => {
    const covers = await coversFor();

    expect(mockFetchCovers).toHaveBeenCalledTimes(1);
    expect(mockFetchCovers).toHaveBeenCalledWith([1, 3]);
    expect(covers[1]).toEqual({
      id: 11,
      userId: 5,
      url: 'url-11',
      type: 'image',
      nsfwLevel: 4,
      width: 512,
      height: 768,
      hash: 'hash-11',
      poi: false,
      minor: false,
    });
    expect(covers[3]).toBeNull();
  });

  it('picks the first image the owner’s browsing level allows, or null when none is', async () => {
    expect((await coversFor(publicBrowsingLevelsFlag))[1]?.id).toBe(12);

    mockFetchCovers.mockResolvedValue({
      1: { modelVersionId: 1, images: [cached(11, 1, 4)] },
    });
    expect((await coversFor(publicBrowsingLevelsFlag))[1]).toBeNull();
  });

  it('gives a mature model with a .com face only its PG and PG-13 images at a .com level', async () => {
    postHas({ 1: model({ nsfw: true, nsfwLevel: 1 | 4, sfwName: 'safe', sfwCoverImageId: 12 }) });
    mockFetchCovers.mockResolvedValue({
      1: { modelVersionId: 1, images: [cached(11, 1, 4), cached(12, 1, 2)] },
    });

    expect((await coversFor(sfwBrowsingLevelsFlag))[1]?.id).toBe(12);
    expect((await coversFor(allBrowsingLevelsFlag))[1]?.id).toBe(11);
  });

  it('gives no cover to a version of a taken-down or someone else’s private model', async () => {
    postHas({
      1: model({ mode: ModelModifier.TakenDown }),
      3: model({ availability: Availability.Private }),
      4: model({ availability: Availability.Private, userId: OWNER }),
    });
    mockFetchCovers.mockResolvedValue({
      1: { modelVersionId: 1, images: [cached(11, 1)] },
      3: { modelVersionId: 3, images: [cached(13, 3)] },
      4: { modelVersionId: 4, images: [cached(14, 4)] },
    });

    const covers = await coversFor();

    expect(mockFetchCovers).toHaveBeenCalledWith([4]);
    expect(covers[1]).toBeNull();
    expect(covers[3]).toBeNull();
    expect(covers[4]?.id).toBe(14);
  });

  it('skips images from someone else’s private post', async () => {
    mockFetchCovers.mockResolvedValue({
      1: {
        modelVersionId: 1,
        images: [
          { ...cached(11, 1), availability: Availability.Private, userId: 77 },
          cached(12, 1),
        ],
      },
    });

    expect((await coversFor())[1]?.id).toBe(12);
  });

  it('returns no covers, and does not throw, when the cache fails', async () => {
    mockFetchCovers.mockRejectedValue(new Error('redis down'));

    expect(await coversFor()).toEqual({ 1: null, 3: null });
  });

  it('skips the cache when no version is servable', async () => {
    postHas({ 1: model({ mode: ModelModifier.TakenDown }) });

    expect(await coversFor()).toEqual({ 1: null });
    expect(mockFetchCovers).not.toHaveBeenCalled();
  });

  it('leaves VAEs out', async () => {
    postHas({ 1: model() }, 'vae');

    expect(await coversFor()).toEqual({});
    expect(mockFetchCovers).not.toHaveBeenCalled();
  });
});
