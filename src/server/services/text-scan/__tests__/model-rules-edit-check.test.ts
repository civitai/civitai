import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const {
  getTextScanMode,
  getEnabledModelRules,
  loadModelScanSubjects,
  syncModelRulesHold,
  unpublishModelById,
} = vi.hoisted(() => ({
  getTextScanMode: vi.fn(),
  getEnabledModelRules: vi.fn(),
  loadModelScanSubjects: vi.fn(),
  syncModelRulesHold: vi.fn(),
  unpublishModelById: vi.fn(),
}));

// Hand-listed: the real modules build clients at load.
vi.mock('~/server/services/model.service', () => ({ unpublishModelById }));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/services/text-scan/mode', () => ({ getTextScanMode }));
vi.mock('~/server/services/text-scan/model-rules', () => ({
  getEnabledModelRules,
  MODEL_RULES_UNPUBLISH_MESSAGE: 'in review',
}));
vi.mock('~/server/services/text-scan/profiles/model.profile', () => ({ loadModelScanSubjects }));
vi.mock('~/server/services/text-scan/actions/model-rules-hold', () => ({ syncModelRulesHold }));

const { checkModelRulesOnEdit } = await import('~/server/services/text-scan/actions/model-rules');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const subject = (name: string) => ({
  userId: 1,
  declared: {},
  fields: [{ heading: 'Name', text: name }],
});
const RULES = [{ id: 3, subject: 'Example Franchise', description: '', aliases: ['Hero One'] }];

beforeEach(() => {
  vi.clearAllMocks();
  getTextScanMode.mockResolvedValue('shadow');
  getEnabledModelRules.mockResolvedValue(RULES);
  loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Hero One LoRA v2')]]));
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ meta: {} });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('checkModelRulesOnEdit', () => {
  it('in shadow mode records the hold and leaves the model live', async () => {
    await checkModelRulesOnEdit(7);

    expect(loadModelScanSubjects).toHaveBeenCalledWith([7], { publicOnly: true });
    expect(syncModelRulesHold).toHaveBeenCalledTimes(1);
    expect(syncModelRulesHold).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ mode: 'shadow', applied: false, ruleIds: [3] })
    );
    expect(unpublishModelById).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('in active mode takes the model down for review and records the hold as applied', async () => {
    getTextScanMode.mockResolvedValue('active');
    await checkModelRulesOnEdit(7);

    expect(unpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, meta: expect.objectContaining({ needsReview: true }) })
    );
    expect(syncModelRulesHold).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ mode: 'active', applied: true })
    );
  });

  it('records no hold in active mode when the model was not taken down', async () => {
    getTextScanMode.mockResolvedValue('active');
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    await checkModelRulesOnEdit(7);

    expect(unpublishModelById).not.toHaveBeenCalled();
    expect(syncModelRulesHold).not.toHaveBeenCalled();
  });

  it('closes the pending hold when the edited text matches nothing', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Plain LoRA')]]));
    await checkModelRulesOnEdit(7);

    expect(syncModelRulesHold).toHaveBeenCalledWith(7, null);
    expect(unpublishModelById).not.toHaveBeenCalled();
  });

  it('ignores a rule a moderator cleared for this exact text', async () => {
    const textHash = textScanTextHash(subject('Hero One LoRA v2'));
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      meta: { modelRulesCleared: { ruleIds: [3], textHash } },
    });
    await checkModelRulesOnEdit(7);

    expect(syncModelRulesHold).toHaveBeenCalledWith(7, null);
  });

  it('does nothing when model rules are off', async () => {
    getTextScanMode.mockResolvedValue('off');
    await checkModelRulesOnEdit(7);

    expect(loadModelScanSubjects).not.toHaveBeenCalled();
    expect(syncModelRulesHold).not.toHaveBeenCalled();
    expect(unpublishModelById).not.toHaveBeenCalled();
  });

  it('does nothing for a model that is gone', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null);
    await checkModelRulesOnEdit(7);

    expect(syncModelRulesHold).not.toHaveBeenCalled();
  });
});
