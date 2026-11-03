import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import type * as NewOrderService from '~/server/services/games/new-order.service';
import type * as Shadow from '~/server/services/shadow-sexual-prompt.service';

const { submit, queueImageSearchIndexUpdate, addImageToQueue } = vi.hoisted(() => ({
  submit: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(() => Promise.resolve()),
  addImageToQueue: vi.fn(() => Promise.resolve()),
}));

vi.mock('~/server/services/shadow-sexual-prompt.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Shadow>()),
  submitShadowSexualPromptScan: submit,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate,
}));
vi.mock('~/server/services/games/new-order.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NewOrderService>()),
  addImageToQueue,
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { applyIngestionSideEffects, type ScanImage } from '../image-scan-pipeline';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const image = {
  id: 77,
  userId: 2,
  type: 'image',
  meta: { prompt: 'a cat' },
  metadata: {},
  postId: null,
  nsfwLevel: 1,
  ingestion: ImageIngestionStatus.Scanned,
} as unknown as ScanImage;

const outcome = {
  ingestion: ImageIngestionStatus.Scanned,
  nsfwLevel: 2,
  blockedFor: null,
  reviewKey: null,
  audit: { nsfw: false, poiTags: [], minorTags: [], reviewTags: [] },
} as unknown as Parameters<typeof applyIngestionSideEffects>[0]['outcome'];

async function run() {
  const result = await applyIngestionSideEffects({ image, outcome });
  return {
    result,
    index: queueImageSearchIndexUpdate.mock.calls,
    queue: addImageToQueue.mock.calls,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyIngestionSideEffects: the shadow sexual-prompt scan', () => {
  it('hands the shadow the image at its final level', async () => {
    submit.mockResolvedValue(undefined);
    await run();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({ id: 77, nsfwLevel: 2 });
  });

  it.each([
    [
      'throws',
      () =>
        submit.mockImplementation(() => {
          throw new Error('boom');
        }),
    ],
    ['rejects', () => submit.mockRejectedValue(new Error('boom'))],
    ['never settles', () => submit.mockReturnValue(new Promise(() => undefined))],
  ])('leaves ingestion unchanged when the submit %s', async (_, arrange) => {
    submit.mockResolvedValue(undefined);
    const baseline = await run();
    vi.clearAllMocks();

    arrange();
    const pending = Symbol('pending');
    const shadowed = await Promise.race([
      run(),
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 1000)),
    ]);

    expect(shadowed).not.toBe(pending);
    expect(shadowed).toEqual(baseline);
    expect(baseline.queue).toHaveLength(1);
  });

  it('does not shadow a blocked image', async () => {
    await applyIngestionSideEffects({
      image,
      outcome: { ...outcome, ingestion: ImageIngestionStatus.Blocked },
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
