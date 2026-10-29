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
const SAMPLE = 'https://orchestration-new.civitai.com/v2/consumer/blobs/SAMPLE1.png';

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
    givenSamples(['', SAMPLE]);

    await createModelVersionPostFromTraining({ modelVersionId: 7, user: USER });

    expect(uploadImageFromUrlMock).toHaveBeenCalledTimes(1);
    expect(uploadImageFromUrlMock).toHaveBeenCalledWith({ imageUrl: SAMPLE });
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

  it('fetches only orchestrator sample urls', async () => {
    givenSamples([
      'https://image.civitai.com/abc/3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33/original=true/a.jpeg',
      'http://orchestration-new.civitai.com/v2/consumer/blobs/x.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://orchestration-new.civitai.com.example.com/x.png',
      'https://orchestration-new.civitai.com:6379/x.png',
      SAMPLE,
    ]);

    await createModelVersionPostFromTraining({ modelVersionId: 7, user: USER });

    expect(uploadImageFromUrlMock).toHaveBeenCalledTimes(1);
    expect(uploadImageFromUrlMock).toHaveBeenCalledWith({ imageUrl: SAMPLE });
  });
});
