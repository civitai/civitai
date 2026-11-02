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
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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

  it('adds the samples as server-minted urls', async () => {
    givenSamples([SAMPLE]);

    await createModelVersionPostFromTraining({ modelVersionId: 7, user: USER });

    expect(addPostImageMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ serverMintedUrl: true })
    );
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

  it('skips a sample refused while fetching and posts the rest', async () => {
    const OTHER = 'https://orchestration-new.civitai.com/v2/consumer/blobs/SAMPLE2.png';
    givenSamples([OTHER, SAMPLE]);
    const { TrainingSampleRefusedError } = await import('~/server/services/image.service');
    uploadImageFromUrlMock.mockImplementation(async ({ imageUrl }: { imageUrl: string }) => {
      if (imageUrl === OTHER) throw new TrainingSampleRefusedError();
      return { url: `uploaded:${imageUrl}`, type: 'image', metadata: { width: 1, height: 1 } };
    });

    await createModelVersionPostFromTraining({ modelVersionId: 7, user: USER });

    expect(createPostMock).toHaveBeenCalledTimes(1);
    expect(addPostImageMock).toHaveBeenCalledTimes(1);
  });

  it('still fails when a sample fetch fails for another reason', async () => {
    givenSamples([SAMPLE]);
    uploadImageFromUrlMock.mockRejectedValue(new Error('Failed to fetch image'));

    await expect(
      createModelVersionPostFromTraining({ modelVersionId: 7, user: USER })
    ).rejects.toThrow('Failed to fetch image');
  });

  it('logs only the host of a skipped sample url', async () => {
    givenSamples(['https://image-generation.civitai.com/abc/123/sample.png?token=t', SAMPLE]);

    await createModelVersionPostFromTraining({ modelVersionId: 7, user: USER });

    const skipped = loggingMock.logToAxiom.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry?.name === 'training-sample-skipped');
    expect(skipped).toEqual([
      { type: 'info', name: 'training-sample-skipped', host: 'image-generation.civitai.com' },
    ]);
  });
});
