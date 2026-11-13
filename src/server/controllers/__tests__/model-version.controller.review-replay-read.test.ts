import { beforeEach, describe, expect, it, vi } from 'vitest';

// The review handlers write the version row back whole. Read from a lagging replica, that write
// would put stale values over a fresh edit, so both read the primary. Scaffold mirrors
// model-version.controller.base-model-attestation.test.ts.

const { mockGetVersionById, mockUpsertModelVersion } = vi.hoisted(() => ({
  mockGetVersionById: vi.fn(),
  mockUpsertModelVersion: vi.fn(),
}));

vi.mock('~/server/services/model-version.service', () => ({
  getVersionById: mockGetVersionById,
  upsertModelVersion: mockUpsertModelVersion,
}));
vi.mock('~/server/services/model.service', () => ({
  getModel: vi.fn(),
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));

import {
  declineReviewHandler,
  requestReviewHandler,
} from '~/server/controllers/model-version.controller';

const VERSION_ID = 100;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVersionById.mockResolvedValue({
    id: VERSION_ID,
    name: 'v1',
    status: 'UnpublishedViolation',
    meta: {},
    modelId: 42,
    baseModel: 'SDXL 1.0',
    trainedWords: [],
  });
  mockUpsertModelVersion.mockResolvedValue({ id: VERSION_ID });
});

describe('model version review handlers', () => {
  it('requestReviewHandler reads the row it replays from the primary', async () => {
    await requestReviewHandler({ input: { id: VERSION_ID } });

    expect(mockUpsertModelVersion).toHaveBeenCalledTimes(1);
    expect(mockGetVersionById).toHaveBeenCalledWith(
      expect.objectContaining({ id: VERSION_ID, forceWriteDb: true })
    );
  });

  it('declineReviewHandler reads the row it replays from the primary', async () => {
    await declineReviewHandler({
      input: { id: VERSION_ID, reason: 'x' },
      ctx: { user: { id: 1, isModerator: true } },
    } as never);

    expect(mockUpsertModelVersion).toHaveBeenCalledTimes(1);
    expect(mockGetVersionById).toHaveBeenCalledWith(
      expect.objectContaining({ id: VERSION_ID, forceWriteDb: true })
    );
  });
});
