import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { unpublishModelById, refreshModelData, bustPublicModelResponseCache } = vi.hoisted(() => ({
  unpublishModelById: vi.fn(),
  refreshModelData: vi.fn(),
  bustPublicModelResponseCache: vi.fn(),
}));

// Hand-listed: the real modules build clients at load.
vi.mock('~/server/services/model.service', () => ({ unpublishModelById }));
vi.mock('~/server/services/model-version.service', () => ({ bustPublicModelResponseCache }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: refreshModelData } }));

const {
  applyModelRulesTextScan,
  modelRulesClearedOnRepublish,
  withModelRulesClearance,
  MODEL_RULES_UNPUBLISH_MESSAGE,
} = await import('~/server/services/text-scan/actions/model-rules');

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
const claimCall = () => dbMock.dbWrite.$executeRaw.mock.calls[0] as unknown[];
const claimSql = () => (claimCall()[0] as readonly string[]).join('?').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ meta: { foo: 1 } });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('applyModelRulesTextScan', () => {
  it('claims a public model, then unpublishes it for review without naming the rule', async () => {
    await applyModelRulesTextScan(args([3, 4]));

    const modelRules = {
      ruleIds: [3, 4],
      workflowId: 'wf-1',
      textHash: 'h1',
      at: expect.any(String),
    };
    expect(claimSql()).toBe(
      `UPDATE "Model" SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('modelRules', ?::jsonb) ` +
        `WHERE id = ? AND status IN ('Published', 'Scheduled') AND availability <> 'Private' ` +
        `AND "deletedAt" IS NULL AND COALESCE(meta->'modelRules'->>'workflowId', '') <> ?`
    );
    const [, json, id, workflowId] = claimCall();
    expect(JSON.parse(json as string)).toEqual(modelRules);
    expect([id, workflowId]).toEqual([7, 'wf-1']);
    expect(unpublishModelById).toHaveBeenCalledTimes(1);
    expect(unpublishModelById).toHaveBeenCalledWith({
      id: 7,
      userId: -1,
      isModerator: true,
      reason: 'other',
      customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
      meta: { foo: 1, needsReview: true, modelRules },
    });
    expect(refreshModelData).toHaveBeenCalledWith(7);
    expect(bustPublicModelResponseCache).toHaveBeenCalledWith(7);
    expect(MODEL_RULES_UNPUBLISH_MESSAGE).not.toMatch(/\d/);
  });

  it('does nothing when no rule matched', async () => {
    await applyModelRulesTextScan(args([]));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(unpublishModelById).not.toHaveBeenCalled();
  });

  it('acts once when the same callback is delivered twice', async () => {
    const claimed = new Set<string>();
    dbMock.dbWrite.$executeRaw.mockImplementation(async (_sql: unknown, _json, _id, wf) => {
      if (claimed.has(wf as string)) return 0;
      claimed.add(wf as string);
      return 1;
    });
    await applyModelRulesTextScan(args([3]));
    await applyModelRulesTextScan(args([3]));
    expect(unpublishModelById).toHaveBeenCalledTimes(1);
  });

  it('stops when the claim matches no row (not public any more)', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    await applyModelRulesTextScan(args([3]));
    expect(unpublishModelById).not.toHaveBeenCalled();
    expect(refreshModelData).not.toHaveBeenCalled();
  });

  it('does nothing for a model that is gone or has no meta', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null);
    await applyModelRulesTextScan(args([3]));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();

    dbMock.dbWrite.model.findUnique.mockResolvedValue({ meta: null });
    await applyModelRulesTextScan(args([3]));
    expect(unpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ needsReview: true }) })
    );
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

describe('withModelRulesClearance', () => {
  const stored = { modelRules: { ruleIds: [3], workflowId: 'w', textHash: 'h1', at: 't' } };

  it('records the approval only for a moderator republishing a rules take-down', () => {
    expect(withModelRulesClearance({ foo: 1 } as never, stored, true)).toEqual({
      foo: 1,
      modelRulesCleared: { ruleIds: [3], textHash: 'h1' },
    });
    expect(withModelRulesClearance({ foo: 1 } as never, stored, false)).toEqual({ foo: 1 });
    expect(withModelRulesClearance({ foo: 1 } as never, {}, true)).toEqual({ foo: 1 });
  });
});
