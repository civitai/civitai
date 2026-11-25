import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The writes to an image's minor flag, which no trigger watches, each queue the articles whose
 * cover or banner the image is, and the models whose showcase can hold it. Rating writes reach the
 * article queue through the image trigger and the update-nsfw-levels job
 * (job-queue-article-cover-reindex.test.ts).
 */

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/services/image-models-reindex.service', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
  queueArticlesAndComicsForImages: vi.fn(async () => undefined),
  queueDocumentsForBlockedImages: vi.fn(async () => undefined),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { applyIngestionSideEffects, type ScanImage } from '../image-scan-pipeline';
import {
  afterCsamImageBlock,
  handleBlockImages,
  toggleImageFlag,
  updateImagesFlag,
} from '~/server/services/image.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import * as searchIndex from '~/server/search-index';
import * as accountDeletionMarkers from '~/server/services/account-deletion-image-markers';
import * as nsfwLevels from '~/server/services/nsfwLevels.service';
import * as postService from '~/server/services/post.service';
import { blockUserImagesAsCsam } from '~/server/services/user.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import {
  queueArticlesAndComicsForImages,
  queueDocumentsForBlockedImages,
  queueDocumentsForImageMinorChanges,
} from '~/server/services/image-models-reindex.service';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const IMAGE_ID = 88;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a scan result, which writes the minor flag', () => {
  const image = {
    id: IMAGE_ID,
    userId: 2,
    type: 'image',
    metadata: {},
    postId: null,
    nsfwLevel: 4,
    ingestion: ImageIngestionStatus.Scanned,
  } as unknown as ScanImage;

  type Outcome = Parameters<typeof applyIngestionSideEffects>[0]['outcome'];
  const audit = (minor: boolean) => ({ minor, poiTags: [], minorTags: [], reviewTags: [] });

  const scan = (minorBefore: boolean, audited?: boolean) =>
    applyIngestionSideEffects({
      image: { ...image, minor: minorBefore } as ScanImage,
      outcome: {
        ingestion: ImageIngestionStatus.Scanned,
        ...(audited !== undefined && { audit: audit(audited) }),
      } as unknown as Outcome,
    });

  it('queues every document showing an image the scan blocked', async () => {
    await applyIngestionSideEffects({
      image: { ...image, minor: false } as ScanImage,
      outcome: { ingestion: ImageIngestionStatus.Blocked } as unknown as Outcome,
    });
    expect(queueDocumentsForBlockedImages).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForBlockedImages).toHaveBeenCalledWith([IMAGE_ID]);
  });

  it('queues no blocked-image requeue for a clean scan (control)', async () => {
    await scan(false);
    expect(queueDocumentsForBlockedImages).not.toHaveBeenCalled();
  });

  it('queues the articles the image covers', async () => {
    await scan(false);
    expect(queueArticlesAndComicsForImages).toHaveBeenCalledTimes(1);
    expect(queueArticlesAndComicsForImages).toHaveBeenCalledWith([IMAGE_ID]);
  });

  it('queues the models of an image the scan flagged minor, and its articles once', async () => {
    await scan(false, true);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({
      levelImageIds: [IMAGE_ID],
      minorImageIds: [IMAGE_ID],
    });
    // The minorImageIds requeue covers the articles and comics.
    expect(queueArticlesAndComicsForImages).not.toHaveBeenCalled();
  });

  it('🔴 queues the models of an image the scan cleared of minor', async () => {
    await scan(true, false);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({
      levelImageIds: [IMAGE_ID],
      minorImageIds: [IMAGE_ID],
    });
    expect(queueArticlesAndComicsForImages).not.toHaveBeenCalled();
  });

  it.each([
    ['stays unflagged', false, false],
    ['stays flagged', true, true],
  ])('leaves an image whose flag %s to the level path (control)', async (_, before, after) => {
    await scan(before, after);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({ levelImageIds: [IMAGE_ID] });
    expect(queueArticlesAndComicsForImages).toHaveBeenCalledTimes(1);
  });
});

describe("a moderator's minor flag write", () => {
  it('queues the models and articles of the images', async () => {
    await updateImagesFlag({ ids: [IMAGE_ID, 89], flag: 'minor', value: true });
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({
      minorImageIds: [IMAGE_ID, 89],
    });
  });

  it('queues the models and articles of a toggled image', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ minor: false } as never);
    await toggleImageFlag({ id: IMAGE_ID, flag: 'minor' });
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({ minorImageIds: [IMAGE_ID] });
  });

  it('queues nothing for a poi flag write (control)', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ poi: false } as never);
    await updateImagesFlag({ ids: [IMAGE_ID], flag: 'poi', value: true });
    await toggleImageFlag({ id: IMAGE_ID, flag: 'poi' });
    expect(queueDocumentsForImageMinorChanges).not.toHaveBeenCalled();
    expect(queueArticlesAndComicsForImages).not.toHaveBeenCalled();
  });
});

describe('a CSAM block', () => {
  // A document of any owner that references a blocked image (a showcase, an article or comic cover)
  // leaves search only through this queue: no trigger watches the block.
  it('queues every document showing the blocked images', async () => {
    await afterCsamImageBlock({ imageIds: [IMAGE_ID] });
    expect(queueDocumentsForBlockedImages).toHaveBeenCalledWith([IMAGE_ID]);
  });

  it('queues nothing for no images (control)', async () => {
    await afterCsamImageBlock({ imageIds: [] });
    expect(queueDocumentsForBlockedImages).not.toHaveBeenCalled();
  });
});

describe('the steps every image block runs after its write', () => {
  const POST_ID = 990000401;
  let steps: {
    search: ReturnType<typeof vi.spyOn>;
    comics: ReturnType<typeof vi.spyOn>;
    markers: ReturnType<typeof vi.spyOn>;
    posts: ReturnType<typeof vi.spyOn>;
  };
  beforeEach(() => {
    steps = {
      search: vi
        .spyOn(searchIndex.imagesMetricsSearchIndex, 'queueUpdate')
        .mockResolvedValue(undefined as never),
      comics: vi
        .spyOn(nsfwLevels, 'queueComicsForPanelImages')
        .mockResolvedValue(undefined as never),
      markers: vi
        .spyOn(accountDeletionMarkers, 'clearAccountDeletionImageMarkers')
        .mockResolvedValue(undefined as never),
      posts: vi.spyOn(postService, 'bustCachesForPosts').mockResolvedValue(undefined as never),
    };
    dbMock.dbRead.image.findMany.mockResolvedValue([
      { id: IMAGE_ID, userId: 990000402, postId: POST_ID, pHash: null, nsfwLevel: 1 },
    ]);
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ id: IMAGE_ID, postId: POST_ID }]);
  });
  const expectEveryStep = () => {
    expect(steps.search).toHaveBeenCalledWith([
      { id: IMAGE_ID, action: SearchIndexUpdateQueueAction.Delete },
    ]);
    expect(redisMock.sysRedis.packed.set).toHaveBeenCalledWith(
      expect.stringContaining(`:${IMAGE_ID}`),
      'false',
      expect.anything()
    );
    expect(steps.comics).toHaveBeenCalledWith([IMAGE_ID]);
    expect(steps.posts).toHaveBeenCalledWith([POST_ID]);
    expect(queueDocumentsForBlockedImages).toHaveBeenCalledWith([IMAGE_ID]);
  };

  it('a moderator block runs each one, and clears the grace breadcrumbs', async () => {
    await handleBlockImages({ ids: [IMAGE_ID], moderatorId: 990000403 });
    expectEveryStep();
    expect(steps.markers).toHaveBeenCalledWith({ ids: [IMAGE_ID] });
  });

  // The filing services clear the breadcrumbs inside the block's transaction.
  it('a CSAM block of listed images runs each one', async () => {
    await afterCsamImageBlock({ imageIds: [IMAGE_ID] });
    expectEveryStep();
  });

  it("a CSAM block of an account runs each one on the account's images, after the clear", async () => {
    await blockUserImagesAsCsam(990000402);
    expect(steps.markers).toHaveBeenCalledWith({ userId: 990000402 });
    expectEveryStep();
  });

  it('a CSAM block of an account fails when the breadcrumb clear fails', async () => {
    steps.markers.mockRejectedValueOnce(new Error('marker clear failed'));
    await expect(blockUserImagesAsCsam(990000402)).rejects.toThrow('marker clear failed');
  });
});
