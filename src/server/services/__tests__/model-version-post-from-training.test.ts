import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import type * as PostService from '~/server/services/post.service';

const { uploadImageFromUrlMock, createPostMock, addPostImageMock } = vi.hoisted(() => ({
  uploadImageFromUrlMock: vi.fn(),
  createPostMock: vi.fn(),
  addPostImageMock: vi.fn(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  uploadImageFromUrl: uploadImageFromUrlMock,
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  createPost: createPostMock,
  addPostImage: addPostImageMock,
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { createModelVersionPostFromTraining } from '~/server/services/model-version.service';

const USER = { id: 5, isModerator: false } as never;

function givenSamples(sampleImages: string[]) {
  dbMock.dbWrite.modelFile.findMany.mockResolvedValue([
    {
      id: 1,
      metadata: {
        trainingResults: {
          version: 2,
          epochs: [{ epochNumber: 1, modelUrl: 'https://x/e1', modelSize: 1, sampleImages }],
        },
      },
    },
  ] as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadImageFromUrlMock.mockImplementation(async ({ imageUrl }: { imageUrl: string }) => ({
    url: `uploaded:${imageUrl}`,
    type: 'image',
    metadata: { width: 1, height: 1 },
  }));
  createPostMock.mockResolvedValue({ id: 99 });
});

describe('createModelVersionPostFromTraining', () => {
  it("skips a failed sample's empty slot and posts the real ones", async () => {
    givenSamples(['', 'https://x/1.png']);

    await createModelVersionPostFromTraining({ modelVersionId: 7, user: USER });

    expect(uploadImageFromUrlMock).toHaveBeenCalledTimes(1);
    expect(uploadImageFromUrlMock).toHaveBeenCalledWith({ imageUrl: 'https://x/1.png' });
    expect(addPostImageMock).toHaveBeenCalledTimes(1);
  });

  it('creates no post when every sample in the epoch failed', async () => {
    givenSamples(['', '']);

    expect(
      await createModelVersionPostFromTraining({ modelVersionId: 7, user: USER })
    ).toBeUndefined();
    expect(uploadImageFromUrlMock).not.toHaveBeenCalled();
    expect(createPostMock).not.toHaveBeenCalled();
  });
});
