import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const { unpublishModelById, refreshModelData, bustPublicModelResponseCache, syncModelRulesHold } =
  vi.hoisted(() => ({
    unpublishModelById: vi.fn(),
    refreshModelData: vi.fn(),
    bustPublicModelResponseCache: vi.fn(),
    syncModelRulesHold: vi.fn(),
  }));

// Hand-listed: the real modules build clients at load.
vi.mock('~/server/services/model.service', () => ({ unpublishModelById }));
vi.mock('~/server/services/model-version.service', () => ({ bustPublicModelResponseCache }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: refreshModelData } }));
vi.mock('~/server/services/text-scan/actions/model-rules-hold', () => ({ syncModelRulesHold }));

const {
  holdModelForLiteralRules,
  modelRulesClearedOnRepublish,
  unpublishLiveModelForLiteralRules,
  withModelRulesClearance,
  MODEL_RULES_UNPUBLISH_MESSAGE,
} = await import('~/server/services/text-scan/actions/model-rules');

const hold = (ruleIds: number[] = [3], textHash = 'h1') => ({
  ruleIds,
  textHash,
  userId: 5,
  text: 'Name\nHero One LoRA',
  reason: 'Example Franchise',
  fields: [{ heading: 'Name', text: 'Hero One LoRA' }],
  matches: [{ ruleId: 3, term: 'Hero One', field: 'Name', fieldIndex: 0, start: 0, end: 8 }],
  rules: [{ id: 3, subject: 'Example Franchise', description: '', aliases: ['Hero One'] }],
  mode: 'active' as const,
  applied: false,
});
// Prisma.sql inlines a nested fragment and keeps only the bound values, as Prisma does.
const claim = () => {
  const [strings, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0] as unknown[];
  return Prisma.sql(strings as readonly string[], ...values);
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ meta: { foo: 1 } });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('holdModelForLiteralRules', () => {
  it('takes the model to review with the unpublish notice keys and no claim on a public row', async () => {
    await holdModelForLiteralRules({ modelId: 7, ...hold(), meta: { foo: 1 } });

    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(unpublishModelById).toHaveBeenCalledWith({
      id: 7,
      userId: -1,
      isModerator: true,
      reason: 'other',
      customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
      meta: {
        foo: 1,
        needsReview: true,
        modelRules: {
          ruleIds: [3],
          workflowId: 'literal:h1:3',
          textHash: 'h1',
          at: expect.any(String),
          source: 'literal',
        },
      },
    });
    expect(refreshModelData).toHaveBeenCalledWith(7);
    expect(bustPublicModelResponseCache).toHaveBeenCalledWith(7);
  });

  it('records the hold as applied', async () => {
    await holdModelForLiteralRules({ modelId: 7, ...hold() });
    expect(syncModelRulesHold).toHaveBeenCalledWith(7, expect.objectContaining({ applied: true, ruleIds: [3] }));
  });

  it('still holds the model when the hold cannot be recorded', async () => {
    syncModelRulesHold.mockRejectedValue(new Error('db down'));
    await expect(holdModelForLiteralRules({ modelId: 7, ...hold() })).resolves.toBeUndefined();
    expect(unpublishModelById).toHaveBeenCalledTimes(1);
  });

  it('is cleared by a moderator republish', async () => {
    await holdModelForLiteralRules({ modelId: 7, ...hold() });
    const { meta } = unpublishModelById.mock.calls[0][0];
    expect(modelRulesClearedOnRepublish(meta)).toEqual({ ruleIds: [3], textHash: 'h1' });
  });
});

describe('unpublishLiveModelForLiteralRules', () => {
  const run = () => unpublishLiveModelForLiteralRules({ modelId: 7, ...hold() });

  it('claims the public model under a synthetic workflow id, then unpublishes it for review', async () => {
    await run();

    const [json, id, workflowId] = claim().values;
    expect(JSON.parse(json as string)).toMatchObject({
      ruleIds: [3],
      workflowId: 'literal:h1:3',
      textHash: 'h1',
      source: 'literal',
    });
    expect([id, workflowId]).toEqual([7, 'literal:h1:3']);
    expect(unpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 7,
        reason: 'other',
        customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
        meta: expect.objectContaining({ foo: 1, needsReview: true }),
      })
    );
  });

  it('acts once for the same text, and not at all when the model is no longer public', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(1).mockResolvedValue(0);
    await expect(run()).resolves.toBe(true);
    await expect(run()).resolves.toBe(false);
    expect(unpublishModelById).toHaveBeenCalledTimes(1);
    expect(syncModelRulesHold).toHaveBeenCalledTimes(1);
  });

  it('records the takedown as an applied hold', async () => {
    await run();
    expect(syncModelRulesHold).toHaveBeenCalledWith(7, expect.objectContaining({ applied: true }));
  });

  it('claims under an id that changes with the rule set, whatever order the ids arrive in', async () => {
    await unpublishLiveModelForLiteralRules({ modelId: 7, ...hold([4, 3]) });

    const [, , workflowId] = claim().values;
    expect(workflowId).toBe('literal:h1:3,4');
    expect(workflowId).not.toBe('literal:h1:3');
  });

  it('does nothing for a model that is gone', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null);
    await expect(run()).resolves.toBe(false);
    expect(unpublishModelById).not.toHaveBeenCalled();
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
