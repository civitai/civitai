import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { unpublishModelById } = vi.hoisted(() => ({ unpublishModelById: vi.fn() }));

// Hand-listed: the real modules build clients at load.
vi.mock('~/server/services/model.service', () => ({ unpublishModelById }));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));

const { applyModelRulesTextScan, modelRulesClearedOnRepublish, MODEL_RULES_UNPUBLISH_MESSAGE } =
  await import('~/server/services/text-scan/actions/model-rules');

const args = (ruleIds: number[]) => ({
  entityId: 7,
  workflowId: 'wf-1',
  outcome: {
    modelRules: { matched: ruleIds.map((ruleId) => ({ ruleId, reason: 'r' })) },
    triggeredLabels: ruleIds.length ? ['modelRules' as const] : [],
    nsfwLevel: null,
  },
  subject: { fields: [], declared: {} },
  textHash: 'h',
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ status: 'Published', meta: { foo: 1 } });
});

describe('applyModelRulesTextScan', () => {
  it('unpublishes a public model for review, keeping its meta and never naming the rule', async () => {
    await applyModelRulesTextScan(args([3, 4]));

    expect(unpublishModelById).toHaveBeenCalledWith({
      id: 7,
      userId: -1,
      isModerator: true,
      reason: 'other',
      customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
      meta: {
        foo: 1,
        needsReview: true,
        modelRules: { ruleIds: [3, 4], workflowId: 'wf-1', at: expect.any(String) },
      },
    });
    expect(MODEL_RULES_UNPUBLISH_MESSAGE).not.toMatch(/\d/);
  });

  it('does nothing when no rule matched', async () => {
    await applyModelRulesTextScan(args([]));
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
    expect(unpublishModelById).not.toHaveBeenCalled();
  });

  it.each(['Draft', 'Unpublished', 'UnpublishedViolation'])(
    'leaves a %s model alone',
    async (status) => {
      dbMock.dbWrite.model.findUnique.mockResolvedValue({ status, meta: {} });
      await applyModelRulesTextScan(args([3]));
      expect(unpublishModelById).not.toHaveBeenCalled();
    }
  );

  it('ignores matches a moderator already cleared, and acts on the rest', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      status: 'Published',
      meta: { modelRulesCleared: [3] },
    });
    await applyModelRulesTextScan(args([3]));
    expect(unpublishModelById).not.toHaveBeenCalled();

    await applyModelRulesTextScan(args([3, 5]));
    expect(unpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ modelRules: expect.objectContaining({ ruleIds: [5] }) }),
      })
    );
  });
});

describe('modelRulesClearedOnRepublish', () => {
  it('adds the rules that took the model down to the cleared list', () => {
    expect(
      modelRulesClearedOnRepublish({
        modelRules: { ruleIds: [3, 4], workflowId: 'w', at: 't' },
        modelRulesCleared: [1, 3],
      })
    ).toEqual([1, 3, 4]);
  });

  it('returns undefined for a model the rules did not take down', () => {
    expect(modelRulesClearedOnRepublish({})).toBeUndefined();
    expect(modelRulesClearedOnRepublish(null)).toBeUndefined();
  });
});
