import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggingMock } from '~/__tests__/mocks/logging.mock';

const {
  mockGetVersionById,
  mockPublishModelVersionById,
  checkModelRulesLiteralHold,
  unpublishLiveModelForLiteralRules,
  mockReindex,
  mockRefresh,
  mockProcessEngagement,
  mockScan,
  mockTrack,
} = vi.hoisted(() => ({
  mockGetVersionById: vi.fn(),
  mockPublishModelVersionById: vi.fn(),
  checkModelRulesLiteralHold: vi.fn(),
  unpublishLiveModelForLiteralRules: vi.fn(),
  mockReindex: vi.fn(),
  mockRefresh: vi.fn(),
  mockProcessEngagement: vi.fn(),
  mockScan: vi.fn(),
  mockTrack: vi.fn(),
}));

vi.mock('~/server/services/model-version.service', () => ({
  getVersionById: mockGetVersionById,
  publishModelVersionById: mockPublishModelVersionById,
}));
vi.mock('~/server/services/model.service', () => ({
  queueModelEarlyAccessReindex: mockReindex,
}));
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: mockRefresh } }));
vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: mockProcessEngagement } }));
vi.mock('~/server/services/text-scan/submit', () => ({ scanModelAndRules: mockScan }));
vi.mock('~/server/services/text-scan/model-rules-hold', () => ({ checkModelRulesLiteralHold }));
vi.mock('~/server/services/text-scan/actions/model-rules', () => ({
  unpublishLiveModelForLiteralRules,
}));

import { publishModelVersionHandler } from '~/server/controllers/model-version.controller';

const mockLog = loggingMock.logToAxiom;
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
      track: { modelVersionEvent: mockTrack },
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
  unpublishLiveModelForLiteralRules.mockResolvedValue(true);
  mockReindex.mockResolvedValue(undefined);
  mockTrack.mockResolvedValue(undefined);
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

  it('reports the hold and skips the side effects of a version going live', async () => {
    const result = await call();

    expect(result).toMatchObject({ id: VERSION_ID, held: true });
    expect(mockReindex).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockProcessEngagement).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockScan).toHaveBeenCalledExactlyOnceWith(MODEL_ID, { rules: false });
  });

  it('logs and carries on as a normal publish when the takedown throws', async () => {
    unpublishLiveModelForLiteralRules.mockRejectedValue(new Error('boom'));

    const result = await call();

    expect(result).toMatchObject({ id: VERSION_ID, held: false });
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', type: 'error', entityId: MODEL_ID })
    );
    expect(mockScan).toHaveBeenCalledExactlyOnceWith(MODEL_ID, { rules: false });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith(MODEL_ID);
  });

  it('is not held when the takedown claimed nothing, and the normal publish side effects run', async () => {
    unpublishLiveModelForLiteralRules.mockResolvedValue(false);

    const result = await call();

    expect(result).toMatchObject({ id: VERSION_ID, held: false });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockReindex).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith(MODEL_ID);
  });

  it('does nothing when no literal rule matches', async () => {
    checkModelRulesLiteralHold.mockResolvedValue(null);
    const result = await call();
    expect(unpublishLiveModelForLiteralRules).not.toHaveBeenCalled();
    expect(result).toMatchObject({ held: false });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockScan).toHaveBeenCalledExactlyOnceWith(MODEL_ID, { rules: false });
  });

  it('never checks a moderator', async () => {
    await call({ isModerator: true });
    expect(checkModelRulesLiteralHold).not.toHaveBeenCalled();
    expect(unpublishLiveModelForLiteralRules).not.toHaveBeenCalled();
    // The content scan still runs; the literal check already ran before the publish.
    expect(mockScan).toHaveBeenCalledExactlyOnceWith(MODEL_ID, { rules: false });
  });

  it('counts a Scheduled model as live', async () => {
    await call({ model: { status: 'Scheduled' } });
    expect(checkModelRulesLiteralHold).toHaveBeenCalledTimes(1);
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
