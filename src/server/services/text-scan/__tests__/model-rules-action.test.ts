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

const args = (ruleIds: number[], textHash = 'h1') => ({
  entityId: 7,
  workflowId: 'wf-1',
  outcome: {
    modelRules: { matched: ruleIds.map((ruleId) => ({ ruleId, reason: 'r' })) },
    triggeredLabels: ruleIds.length ? ['modelRules' as const] : [],
    nsfwLevel: null,
  },
  subject: { fields: [], declared: {} },
  textHash,
});
const claimSql = () =>
  (dbMock.dbWrite.$executeRaw.mock.calls[0]?.[0] as readonly string[] | undefined)?.join('?');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ meta: { foo: 1 } });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('applyModelRulesTextScan', () => {
  it('claims a public model, then unpublishes it for review without naming the rule', async () => {
    await applyModelRulesTextScan(args([3, 4]));

    const sql = claimSql();
    expect(sql).toContain("status IN ('Published', 'Scheduled')");
    expect(sql).toContain("availability <> 'Private'");
    expect(sql).toContain('"deletedAt" IS NULL');
    expect(sql).toContain("meta->'modelRules'->>'workflowId'");
    const modelRules = {
      ruleIds: [3, 4],
      workflowId: 'wf-1',
      textHash: 'h1',
      at: expect.any(String),
    };
    expect(unpublishModelById).toHaveBeenCalledWith({
      id: 7,
      userId: -1,
      isModerator: true,
      reason: 'other',
      customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
      meta: { foo: 1, needsReview: true, modelRules },
    });
    expect(MODEL_RULES_UNPUBLISH_MESSAGE).not.toMatch(/\d/);
  });

  it('does nothing when no rule matched', async () => {
    await applyModelRulesTextScan(args([]));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(unpublishModelById).not.toHaveBeenCalled();
  });

  it('stops when the claim matches no row (not public any more, or already acted on)', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    await applyModelRulesTextScan(args([3]));
    expect(unpublishModelById).not.toHaveBeenCalled();
  });

  it('honours a moderator clearance only for the text that was reviewed', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      meta: { modelRulesCleared: { ruleIds: [3], textHash: 'h1' } },
    });
    await applyModelRulesTextScan(args([3], 'h1'));
    expect(unpublishModelById).not.toHaveBeenCalled();

    await applyModelRulesTextScan(args([3], 'h2'));
    expect(unpublishModelById).toHaveBeenCalledTimes(1);

    await applyModelRulesTextScan(args([3, 5], 'h1'));
    expect(unpublishModelById).toHaveBeenLastCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ modelRules: expect.objectContaining({ ruleIds: [5] }) }),
      })
    );
  });
});

describe('modelRulesClearedOnRepublish', () => {
  const taken = { ruleIds: [3, 4], workflowId: 'w', textHash: 'h1', at: 't' };

  it('approves the rules that took the model down, for that text', () => {
    expect(modelRulesClearedOnRepublish({ modelRules: taken })).toEqual({
      ruleIds: [3, 4],
      textHash: 'h1',
    });
  });

  it('keeps earlier approvals of the same text and drops those of older text', () => {
    expect(
      modelRulesClearedOnRepublish({
        modelRules: taken,
        modelRulesCleared: { ruleIds: [1], textHash: 'h1' },
      })
    ).toEqual({ ruleIds: [1, 3, 4], textHash: 'h1' });
    expect(
      modelRulesClearedOnRepublish({
        modelRules: taken,
        modelRulesCleared: { ruleIds: [1], textHash: 'old' },
      })
    ).toEqual({ ruleIds: [3, 4], textHash: 'h1' });
  });

  it('returns undefined for a model the rules did not take down', () => {
    expect(modelRulesClearedOnRepublish({})).toBeUndefined();
    expect(modelRulesClearedOnRepublish(null)).toBeUndefined();
  });
});
