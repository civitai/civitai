import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetVersionById,
  mockPublishModelVersionById,
  checkModelRulesLiteralHold,
  unpublishLiveModelForLiteralRules,
} = vi.hoisted(() => ({
  mockGetVersionById: vi.fn(),
  mockPublishModelVersionById: vi.fn(),
  checkModelRulesLiteralHold: vi.fn(),
  unpublishLiveModelForLiteralRules: vi.fn(),
}));

vi.mock('~/server/services/model-version.service', () => ({
  getVersionById: mockGetVersionById,
  publishModelVersionById: mockPublishModelVersionById,
}));
vi.mock('~/server/services/model.service', () => ({
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/services/text-scan/model-rules-hold', () => ({ checkModelRulesLiteralHold }));
vi.mock('~/server/services/text-scan/actions/model-rules', () => ({
  unpublishLiveModelForLiteralRules,
}));

import { publishModelVersionHandler } from '~/server/controllers/model-version.controller';

const VERSION_ID = 100;
const MODEL_ID = 42;
const HOLD = { ruleIds: [3], textHash: 'h1' };

const call = ({
  isModerator = false,
  model = {},
}: { isModerator?: boolean; model?: Record<string, unknown> } = {}) => {
  mockGetVersionById.mockResolvedValue({
    id: VERSION_ID,
    status: 'Draft',
    meta: null,
    modelId: MODEL_ID,
    baseModel: 'SDXL 1.0',
    model: {
      userId: 7,
      nsfw: false,
      status: 'Published',
      availability: 'Public',
      meta: { foo: 1 },
      ...model,
    },
  });
  return publishModelVersionHandler({
    input: { id: VERSION_ID },
    ctx: {
      user: { id: 7, isModerator },
      track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPublishModelVersionById.mockResolvedValue({
    id: VERSION_ID,
    modelId: MODEL_ID,
    model: { userId: 7, nsfw: false },
  });
  checkModelRulesLiteralHold.mockResolvedValue(HOLD);
  unpublishLiveModelForLiteralRules.mockResolvedValue(undefined);
});

describe('publishModelVersionHandler — Model rules literal hit on a live model', () => {
  it('publishes the version, then takes the model to review', async () => {
    await call();

    expect(checkModelRulesLiteralHold).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      versionIds: [VERSION_ID],
      meta: { foo: 1 },
    });
    expect(mockPublishModelVersionById).toHaveBeenCalledTimes(1);
    expect(unpublishLiveModelForLiteralRules).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      ...HOLD,
    });
    expect(mockPublishModelVersionById.mock.invocationCallOrder[0]).toBeLessThan(
      unpublishLiveModelForLiteralRules.mock.invocationCallOrder[0]
    );
  });

  it('does nothing when no literal rule matches', async () => {
    checkModelRulesLiteralHold.mockResolvedValue(null);
    await call();
    expect(unpublishLiveModelForLiteralRules).not.toHaveBeenCalled();
  });

  it('never checks a moderator', async () => {
    await call({ isModerator: true });
    expect(checkModelRulesLiteralHold).not.toHaveBeenCalled();
    expect(unpublishLiveModelForLiteralRules).not.toHaveBeenCalled();
  });

  it.each(['Draft', 'Unpublished'])(
    'leaves a model that is not public (%s) to the model-level hold',
    async (status) => {
      await call({ model: { status } });
      expect(checkModelRulesLiteralHold).not.toHaveBeenCalled();
    }
  );

  it('leaves a private model alone', async () => {
    await call({ model: { availability: 'Private' } });
    expect(checkModelRulesLiteralHold).not.toHaveBeenCalled();
  });
});
