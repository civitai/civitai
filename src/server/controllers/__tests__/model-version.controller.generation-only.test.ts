import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

// Harness mirrors model-version.controller.bounty-copy.test.ts. The feature flags are the REAL registry,
// resolved for the acting user, so the test sees the availability list the controller gates on.

const { mockUpsertModelVersion, mockGetModel, mockGetCapTier, flagsOff } = vi.hoisted(() => ({
  flagsOff: { value: false },
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
// `flagsOff` stands in for an env override that switches the flag off for this user's tier.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => {
  const actual = await importOriginal<typeof FeatureFlagsService>();
  return {
    ...actual,
    getFeatureFlagsLazy: (...args: Parameters<typeof actual.getFeatureFlagsLazy>) =>
      flagsOff.value ? {} : actual.getFeatureFlagsLazy(...args),
  };
});
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
  flagsOff.value = false;
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

describe('upsertModelVersionHandler — a moderator-set control on an existing version', () => {
  const editVersion = (
    input: Record<string, unknown>,
    features = getFeatureFlags({ user: freeCreator })
  ) =>
    upsertModelVersionHandler({
      input: { id: VERSION, modelId: MODEL, baseModel: 'SDXL 1.0', licensingFee: null, ...input },
      ctx: {
        user: freeCreator,
        features,
        track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) },
      },
    } as never);

  beforeEach(() => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
      usageControl: 'ExternalGeneration',
      licensingFee: null,
      licensingFeeSettlementCurrency: null,
      licensingSourceVersionId: null,
      baseModel: 'SDXL 1.0',
    } as never);
  });

  // The service judges the change against the stored control; here it must arrive unchanged.
  it('passes an owner resubmitting the stored External control through to the service', async () => {
    await editVersion({ name: 'renamed', usageControl: 'ExternalGeneration' });
    expect(mockUpsertModelVersion).toHaveBeenCalledWith(
      expect.objectContaining({ usageControl: 'ExternalGeneration', name: 'renamed' })
    );
  });

  it('does not coerce the stored External control to Download when the flag is off', async () => {
    flagsOff.value = true;
    await editVersion(
      { name: 'renamed', usageControl: 'ExternalGeneration' },
      { ...getFeatureFlags({ user: freeCreator }), generationOnlyModels: false }
    );
    expect(mockUpsertModelVersion).toHaveBeenCalledWith(
      expect.objectContaining({ usageControl: 'ExternalGeneration' })
    );
  });

  it('still refuses External on a templated write, which creates a new version', async () => {
    await expect(
      editVersion({ templateId: VERSION, name: 'copy', usageControl: 'ExternalGeneration' })
    ).rejects.toThrowError(/Only moderators/);
    expect(mockUpsertModelVersion).not.toHaveBeenCalled();
  });
});
