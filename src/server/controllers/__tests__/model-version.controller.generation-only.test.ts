import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Harness mirrors model-version.controller.bounty-copy.test.ts. The feature flags are the REAL registry,
// resolved for the acting user, so the test sees the availability list the controller gates on.

const { mockUpsertModelVersion, mockGetModel, mockGetCapTier } = vi.hoisted(() => ({
  mockUpsertModelVersion: vi.fn(),
  mockGetModel: vi.fn(),
  mockGetCapTier: vi.fn(),
}));

vi.mock('~/server/services/model-version.service', () => ({
  upsertModelVersion: mockUpsertModelVersion,
  assertUserEarlyAccessLimits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/model.service', () => ({
  getModel: mockGetModel,
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCapTier: mockGetCapTier,
}));
// Reached at import through the orchestrator caller, which throws without a token.
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));

import { upsertModelVersionHandler } from '~/server/controllers/model-version.controller';
import { getFeatureFlags } from '~/server/services/feature-flags.service';

const MODEL = 1;
const VERSION = 100;
const freeCreator = { id: 7, isModerator: false, tier: 'free', meta: {} } as never;

const moderator = { id: 9, isModerator: true, tier: 'free', meta: {} } as never;

const createVersion = (usageControl: string, user = freeCreator) =>
  upsertModelVersionHandler({
    input: {
      modelId: MODEL,
      name: 'v1.0',
      baseModel: 'SDXL 1.0',
      usageControl,
      licensingFee: null,
    },
    ctx: {
      user,
      features: getFeatureFlags({ user }),
      track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ type: 'LORA' });
  mockGetModel.mockResolvedValue({ nsfw: false, type: 'LORA' });
  mockGetCapTier.mockResolvedValue(null);
  mockUpsertModelVersion.mockResolvedValue({ id: VERSION, modelId: MODEL });
});

describe('upsertModelVersionHandler — usage control for a creator with no membership', () => {
  it('keeps On-Site Generation Only instead of coercing it to Download', async () => {
    await createVersion('Generation');
    expect(mockUpsertModelVersion).toHaveBeenCalledWith(
      expect.objectContaining({ usageControl: 'Generation' })
    );
  });

  it.each(['InternalGeneration', 'ExternalGeneration'])(
    'still refuses the moderator-only %s control',
    async (control) => {
      await expect(createVersion(control)).rejects.toThrowError(/Only moderators/);
      expect(mockUpsertModelVersion).not.toHaveBeenCalled();
    }
  );

  it('lets a moderator set InternalGeneration', async () => {
    await createVersion('InternalGeneration', moderator);
    expect(mockUpsertModelVersion).toHaveBeenCalledWith(
      expect.objectContaining({ usageControl: 'InternalGeneration' })
    );
  });
});
