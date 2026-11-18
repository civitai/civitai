import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import type * as KnightsSources from '~/server/services/knights/sources';
import type * as ModRules from '~/server/utils/mod-rules';
import type * as NewOrderService from '~/server/services/games/new-order.service';
import type * as NotificationService from '~/server/services/notification.service';

// A search upload is never shown: its uploader gets no rule-block notice and it takes no Knights
// intake slot. Each case runs a normal row beside it so a silent skip of both reads red.

const h = vi.hoisted(() => ({
  createNotification: vi.fn(async () => undefined),
  queueScanSampleForKnights: vi.fn(async () => undefined),
  addImageToQueue: vi.fn(async () => undefined),
  isV1KnightsLive: vi.fn(async () => true),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesModRules: vi.fn(async () => [{ id: 1 }]),
}));
vi.mock('~/server/utils/mod-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof ModRules>()),
  evaluateRules: vi.fn(() => ({ id: 1, action: 'Block', reason: 'a rule' })),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: h.createNotification,
}));
vi.mock('~/server/services/knights/sources', async (importOriginal) => ({
  ...(await importOriginal<typeof KnightsSources>()),
  queueScanSampleForKnights: h.queueScanSampleForKnights,
}));
vi.mock('~/server/services/games/new-order.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NewOrderService>()),
  addImageToQueue: h.addImageToQueue,
}));
vi.mock('~/server/games/new-order/v1-gate', () => ({ isV1KnightsLive: h.isV1KnightsLive }));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import {
  applyIngestionSideEffects,
  resolveScanOutcome,
  type ScanImage,
  type ScanOutcome,
} from '../image-scan-pipeline';
import { dbMock } from '~/__tests__/mocks/db.mock';

const SEARCH_UPLOAD = { searchUploadAppId: 'search-upload', searchUploadRef: 'upload:blob-1' };

const image = (metadata: Record<string, unknown>) =>
  ({
    id: 1,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: null,
    type: 'image',
    meta: {},
    metadata,
    postId: null,
    nsfwLevelLocked: false,
    nsfwLevel: 0,
    ingestion: 'Pending',
  } as unknown as ScanImage);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: 1, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    if (text.includes('"blockedFor"')) return [{ blockedFor: 'moderated' }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
});

describe('a moderation rule that blocks the scan', () => {
  it("notifies a normal image's owner", async () => {
    const outcome = await resolveScanOutcome({ image: image({}), workflowId: 'wf' });
    expect(outcome.ingestion).toBe('Blocked');
    expect(h.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'image-block:1', userId: 2 })
    );
  });

  it("does not notify a search upload's uploader", async () => {
    const outcome = await resolveScanOutcome({ image: image(SEARCH_UPLOAD), workflowId: 'wf' });
    expect(outcome.ingestion).toBe('Blocked');
    expect(h.createNotification).not.toHaveBeenCalled();
  });
});

describe('a clean scan with nothing to review', () => {
  const scanned = {
    ingestion: 'Scanned',
    blockedFor: null,
    reviewKey: null,
    audit: { poiTags: [], minorTags: [], reviewTags: [], nsfw: false },
  } as unknown as ScanOutcome;

  it('sends a normal image to Knights intake', async () => {
    await applyIngestionSideEffects({ image: image({}), outcome: scanned });
    expect(h.addImageToQueue).toHaveBeenCalledWith(expect.objectContaining({ imageIds: [1] }));
    expect(h.queueScanSampleForKnights).toHaveBeenCalledWith({ imageId: 1, nsfw: false });
  });

  it('keeps a search upload out of Knights intake', async () => {
    await applyIngestionSideEffects({ image: image(SEARCH_UPLOAD), outcome: scanned });
    expect(h.addImageToQueue).not.toHaveBeenCalled();
    expect(h.queueScanSampleForKnights).not.toHaveBeenCalled();
  });
});
