import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { asJsonbObject } from '~/server/utils/jsonb-object';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

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
  holdModelForLiteralRules,
  modelRulesClearedOnRepublish,
  unpublishLiveModelForLiteralRules,
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
// Prisma.sql inlines a nested fragment and keeps only the bound values, as Prisma does.
const claim = () => {
  const [strings, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0] as unknown[];
  return Prisma.sql(strings as readonly string[], ...values);
};
const claimSql = () => claim().sql.replace(/\s+/g, ' ').trim();

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
      `UPDATE "Model" SET meta = ${asJsonbObject(
        'meta'
      )} || jsonb_build_object('modelRules', ?::jsonb) ` +
        `WHERE id = ? AND status IN ('Published', 'Scheduled') AND availability <> 'Private' ` +
        `AND "deletedAt" IS NULL AND COALESCE(meta->'modelRules'->>'workflowId', '') <> ?`
    );
    const [json, id, workflowId] = claim().values;
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

  it('does nothing for a model that is gone', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null);
    await applyModelRulesTextScan(args([3]));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(unpublishModelById).not.toHaveBeenCalled();
  });

  it('treats a model with no meta as having an empty one and still unpublishes it', async () => {
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

describe('holdModelForLiteralRules', () => {
  it('takes the model to review with the unpublish notice keys and no claim on a public row', async () => {
    await holdModelForLiteralRules({ modelId: 7, ruleIds: [3], textHash: 'h1', meta: { foo: 1 } });

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

  it('is cleared by a moderator republish like an LLM match', async () => {
    await holdModelForLiteralRules({ modelId: 7, ruleIds: [3], textHash: 'h1' });
    const { meta } = unpublishModelById.mock.calls[0][0];
    expect(modelRulesClearedOnRepublish(meta)).toEqual({ ruleIds: [3], textHash: 'h1' });
  });
});

describe('unpublishLiveModelForLiteralRules', () => {
  const run = () => unpublishLiveModelForLiteralRules({ modelId: 7, ruleIds: [3], textHash: 'h1' });

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
  });

  it('claims under an id that changes with the rule set, whatever order the ids arrive in', async () => {
    await unpublishLiveModelForLiteralRules({ modelId: 7, ruleIds: [4, 3], textHash: 'h1' });

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

describe('recording a literal hold where Matches reads', () => {
  const holdRow = () => dbMock.dbWrite.entityModeration.upsert.mock.calls[0][0];

  beforeEach(() => {
    dbMock.dbWrite.moderationRule.findMany.mockResolvedValue([
      { id: 3, definition: { type: 'semantic', subject: 'Example', description: '', aliases: [] } },
    ]);
  });

  it('upserts the ModelRules row as a literal-only match held at publish, with no content hash', async () => {
    await holdModelForLiteralRules({ modelId: 7, ruleIds: [3], textHash: 'h1' });

    const { where, create, update } = holdRow();
    expect(where).toEqual({ entityType_entityId: { entityType: 'ModelRules', entityId: 7 } });
    expect(update).toMatchObject({
      workflowId: 'literal:h1:3',
      contentHash: null,
      status: 'Succeeded',
      triggeredLabels: ['modelRulesLiteral'],
      result: {
        version: 1,
        textHash: 'h1',
        meta: { heldAtPublish: true },
        modelRules: {
          literalRuleIds: [3],
          snapshot: [expect.objectContaining({ id: 3, subject: 'Example' })],
        },
      },
    });
    expect(create).toMatchObject({ entityType: 'ModelRules', entityId: 7, ...update });
  });

  it('records a live takedown only when it happened', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await unpublishLiveModelForLiteralRules({ modelId: 7, ruleIds: [3], textHash: 'h1' });
    await unpublishLiveModelForLiteralRules({ modelId: 7, ruleIds: [3], textHash: 'h1' });
    expect(dbMock.dbWrite.entityModeration.upsert).toHaveBeenCalledTimes(1);
  });

  it('keeps the hold when the record fails', async () => {
    dbMock.dbWrite.entityModeration.upsert.mockRejectedValueOnce(new Error('db down'));
    await expect(
      holdModelForLiteralRules({ modelId: 7, ruleIds: [3], textHash: 'h1' })
    ).resolves.toBeUndefined();
    expect(unpublishModelById).toHaveBeenCalledTimes(1);
  });
});
