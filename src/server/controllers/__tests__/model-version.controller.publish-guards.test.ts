import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Publishing a version is allowed only when both the version and its parent model are in a state an
 * owner may publish from. The two statuses are set independently, and the private-model publish path
 * takes the same rules as the public one — a different audience, not a different rulebook.
 */

const {
  mockGetVersionById,
  mockPublishModelVersionById,
  mockUpdateModelVersionById,
  mockGetModel,
} = vi.hoisted(() => ({
  mockGetVersionById: vi.fn(),
  mockPublishModelVersionById: vi.fn(),
  mockUpdateModelVersionById: vi.fn(),
  mockGetModel: vi.fn(),
}));

vi.mock('~/server/services/model-version.service', () => ({
  getVersionById: mockGetVersionById,
  publishModelVersionById: mockPublishModelVersionById,
  updateModelVersionById: mockUpdateModelVersionById,
}));
vi.mock('~/server/services/model.service', () => ({
  getModel: mockGetModel,
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
// Reached at import through the orchestrator caller, which throws without a token.
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));

import { publishModelVersionHandler } from '~/server/controllers/model-version.controller';

const VERSION_ID = 100;
const OWNER_ID = 7;

const call = (versionStatus: string, modelStatus: string, isModerator = false) => {
  mockGetVersionById.mockResolvedValue({
    id: VERSION_ID,
    status: versionStatus,
    meta: null,
    baseModel: 'SDXL 1.0',
    model: { userId: OWNER_ID, nsfw: false, status: modelStatus },
  });

  return publishModelVersionHandler({
    input: { id: VERSION_ID },
    ctx: {
      user: { id: OWNER_ID, isModerator },
      // Fire-and-forget with a .catch, so the mock has to be thenable.
      track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPublishModelVersionById.mockResolvedValue({ id: VERSION_ID, modelId: 42, model: {} });
});

describe('publishModelVersionHandler — publishable state', () => {
  it.each(['UnpublishedViolation', 'Deleted'])(
    'refuses an owner when the VERSION is at %s',
    async (status) => {
      await expect(call(status, 'Published')).rejects.toThrowError(/not authorized/);
      expect(mockPublishModelVersionById).not.toHaveBeenCalled();
    }
  );

  it.each(['UnpublishedViolation', 'Deleted'])(
    'refuses an owner when the parent MODEL is at %s',
    async (status) => {
      // The two statuses are written independently, so a version can sit at an owner-publishable
      // status under a model that is not. Checking the version alone leaves that unenforced.
      await expect(call('Unpublished', status)).rejects.toThrowError(/not authorized/);
      expect(mockPublishModelVersionById).not.toHaveBeenCalled();
    }
  );

  // Negative control: a check that refused on any non-Published status would block every ordinary
  // republish, and both assertions above would still pass.
  it('lets an owner publish an ordinary unpublished version of a published model', async () => {
    await call('Unpublished', 'Published');

    expect(mockPublishModelVersionById).toHaveBeenCalledTimes(1);
  });

  it('lets a moderator through either way', async () => {
    await call('UnpublishedViolation', 'UnpublishedViolation', true);

    expect(mockPublishModelVersionById).toHaveBeenCalledTimes(1);
  });
});
