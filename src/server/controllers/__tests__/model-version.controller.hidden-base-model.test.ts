import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Harness mirrors model-version.controller.generation-only.test.ts.

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
const HIDDEN = 'Fibo 2.0';
const creator = { id: 7, isModerator: false, tier: 'free', meta: {} } as never;
const moderator = { id: 9, isModerator: true, tier: 'free', meta: {} } as never;

const upsert = (baseModel: string, { user = creator, id }: { user?: never; id?: number } = {}) =>
  upsertModelVersionHandler({
    input: { id, modelId: MODEL, name: 'v1.0', baseModel, usageControl: 'Download' },
    ctx: {
      user,
      features: getFeatureFlags({ user }),
      track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ type: 'LORA' });
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(null);
  mockGetModel.mockResolvedValue({ nsfw: false, type: 'LORA' });
  mockGetCapTier.mockResolvedValue(null);
  mockUpsertModelVersion.mockResolvedValue({ id: VERSION, modelId: MODEL });
});

describe('upsertModelVersionHandler — hidden base models', () => {
  it('refuses a creator putting a new version on a hidden base model', async () => {
    await expect(upsert(HIDDEN)).rejects.toThrowError(/not available/);
    expect(mockUpsertModelVersion).not.toHaveBeenCalled();
  });

  it('refuses a creator moving an existing version onto a hidden base model', async () => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
      baseModel: 'SDXL 1.0',
      usageControl: 'Download',
    });
    await expect(upsert(HIDDEN, { id: VERSION })).rejects.toThrowError(/not available/);
    expect(mockUpsertModelVersion).not.toHaveBeenCalled();
  });

  it('lets a creator edit a version that is already on a hidden base model', async () => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
      baseModel: HIDDEN,
      usageControl: 'Download',
    });
    await upsert(HIDDEN, { id: VERSION });
    expect(mockUpsertModelVersion).toHaveBeenCalled();
  });

  it('lets a moderator put a version on a hidden base model', async () => {
    await upsert(HIDDEN, { user: moderator });
    expect(mockUpsertModelVersion).toHaveBeenCalled();
  });

  it('lets a creator use a visible base model', async () => {
    await upsert('SDXL 1.0');
    expect(mockUpsertModelVersion).toHaveBeenCalled();
  });
});
