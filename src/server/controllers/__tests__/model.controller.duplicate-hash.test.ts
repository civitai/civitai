import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelService from '~/server/services/model.service';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as Caches from '~/server/redis/caches';

/**
 * Every public publish path runs the cross-owner duplicate check before anything is published, and
 * passes whether the caller is a moderator so a restored false positive can be republished.
 */

const {
  mockAssertNotDuplicate,
  mockPublishModelById,
  mockPublishPrivateModel,
  mockPublishModelVersionById,
  mockGetModel,
  mockGetVersionById,
} = vi.hoisted(() => ({
  mockAssertNotDuplicate: vi.fn(),
  mockPublishModelById: vi.fn(),
  mockPublishPrivateModel: vi.fn(),
  mockPublishModelVersionById: vi.fn(),
  mockGetModel: vi.fn(),
  mockGetVersionById: vi.fn(),
}));

vi.mock('~/server/services/duplicate-model-hash.service', () => ({
  assertNotCrossOwnerDuplicate: mockAssertNotDuplicate,
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  publishModelById: mockPublishModelById,
  publishPrivateModel: mockPublishPrivateModel,
  getModel: mockGetModel,
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  getVersionById: mockGetVersionById,
  publishModelVersionById: mockPublishModelVersionById,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: { refresh: vi.fn() },
}));
vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: vi.fn() } }));
vi.mock('~/server/services/text-scan/submit', () => ({ checkModelRulesInBackground: vi.fn() }));
// Reached at import through the orchestrator caller, which throws without a token.
vi.mock('~/server/services/training.service', () => ({}));

import {
  publishModelHandler,
  publishPrivateModelHandler,
} from '~/server/controllers/model.controller';
import { publishModelVersionHandler } from '~/server/controllers/model-version.controller';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODEL_ID = 42;
const VERSION_ID = 100;
const OWNER_ID = 7;
const duplicate = new Error(
  "This model contains a file identical to one in another creator's model"
);

const paths = {
  publishModelHandler: {
    scope: { modelId: MODEL_ID },
    run: (isModerator: boolean) =>
      publishModelHandler({
        input: { id: MODEL_ID, versionIds: [VERSION_ID] },
        ctx: {
          user: { id: OWNER_ID, isModerator },
          track: { modelEvent: vi.fn().mockResolvedValue(undefined) },
        },
      } as never),
    published: () => mockPublishModelById,
  },
  publishPrivateModelHandler: {
    scope: { modelId: MODEL_ID },
    run: (isModerator: boolean) =>
      publishPrivateModelHandler({
        input: { modelId: MODEL_ID, publishVersions: true },
        ctx: { user: { id: OWNER_ID, isModerator } },
      } as never),
    published: () => mockPublishPrivateModel,
  },
  publishModelVersionHandler: {
    scope: { versionId: VERSION_ID },
    run: (isModerator: boolean) =>
      publishModelVersionHandler({
        input: { id: VERSION_ID },
        ctx: {
          user: { id: OWNER_ID, isModerator },
          track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) },
        },
      } as never),
    published: () => mockPublishModelVersionById,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertNotDuplicate.mockResolvedValue(undefined);
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    status: 'Draft',
    meta: {},
    nsfw: false,
    userId: OWNER_ID,
  } as never);
  mockGetModel.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    status: 'Published',
    availability: 'Private',
    meta: {},
  });
  mockGetVersionById.mockResolvedValue({
    id: VERSION_ID,
    status: 'Draft',
    meta: null,
    modelId: MODEL_ID,
    baseModel: 'SDXL 1.0',
    model: { userId: OWNER_ID, nsfw: false, status: 'Draft', availability: 'Public', meta: null },
  });
  mockPublishModelById.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    status: 'Published',
    modelVersions: [],
  });
  mockPublishPrivateModel.mockResolvedValue({ versionIds: [VERSION_ID], held: false });
  mockPublishModelVersionById.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID, model: {} });
});

describe.each(Object.entries(paths))('%s — duplicate model file', (_, path) => {
  it('publishes nothing when the check refuses', async () => {
    mockAssertNotDuplicate.mockRejectedValue(duplicate);

    await expect(path.run(false)).rejects.toThrowError(/identical to one in another creator/);
    expect(path.published()).not.toHaveBeenCalled();
  });

  it.each([false, true])('checks the owner and scope with isModerator=%s', async (isModerator) => {
    await path.run(isModerator).catch(() => undefined);

    expect(mockAssertNotDuplicate).toHaveBeenCalledExactlyOnceWith({
      ...path.scope,
      ownerId: OWNER_ID,
      isModerator,
    });
  });

  // Negative control: the check passing leaves the publish itself untouched.
  it('publishes when the check passes', async () => {
    await path.run(false).catch(() => undefined);

    expect(path.published()).toHaveBeenCalledTimes(1);
  });
});
