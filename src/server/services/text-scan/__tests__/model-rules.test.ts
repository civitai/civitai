import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  bustFetchThroughCache: vi.fn(),
}));

const {
  loadModelRulesUnpublishDetail,
  getModelRuleSubjects,
  MODEL_RULES_UNPUBLISH_MESSAGE,
  modelRulesUnpublishDetail,
  getEnabledModelRules,
} = await import('~/server/services/text-scan/model-rules');

beforeEach(() => vi.clearAllMocks());

describe('getEnabledModelRules', () => {
  it('returns enabled semantic rules, skipping regex rows and rules awaiting review', async () => {
    dbMock.dbWrite.moderationRule.findMany.mockResolvedValue([
      {
        id: 4,
        order: null,
        updatedAt: new Date(5000),
        definition: {
          type: 'semantic',
          subject: 'Jane Doe',
          description: 'Likeness claim',
          category: 'likeness',
          references: [{ url: 'https://example.com/jane', label: 'Profile' }],
        },
      },
      {
        id: 5,
        order: null,
        updatedAt: new Date(6000),
        definition: { type: 'or', rules: [{ type: 'content', match: '/x/gi', target: ['name'] }] },
      },
      {
        id: 6,
        order: null,
        updatedAt: new Date(7000),
        definition: { type: 'semantic', subject: '(?:x|y)+', needsAttention: true },
      },
    ]);

    await expect(getEnabledModelRules()).resolves.toEqual([
      {
        id: 4,
        subject: 'Jane Doe',
        description: 'Likeness claim',
        aliases: [],
        category: 'likeness',
        references: [{ url: 'https://example.com/jane', label: 'Profile' }],
        updatedAt: 5000,
      },
    ]);
    expect(dbMock.dbWrite.moderationRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType: 'Model', enabled: true },
        orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      })
    );
  });
});

describe('naming the rules behind a Model rules unpublish', () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    unpublishedReason: 'other' as const,
    customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
    modelRules: {
      ruleIds: [446, 9],
      workflowId: 'literal:h:9,446',
      textHash: 'h',
      at: 'x',
      source: 'literal' as const,
    },
    ...over,
  });

  it('lists the rules by subject, by id when a subject is unknown', () => {
    expect(modelRulesUnpublishDetail(meta(), new Map([[446, 'Example']]))).toEqual({
      source: 'literal',
      rules: [
        { id: 446, subject: 'Example' },
        { id: 9, subject: null },
      ],
    });
  });

  it('calls an LLM match a scan match', () => {
    const llm = meta({ modelRules: { ruleIds: [1], workflowId: 'wf', textHash: 'h', at: 'x' } });
    expect(modelRulesUnpublishDetail(llm, new Map())?.source).toBe('model');
  });

  it('is null when the unpublish was not the Model rules one', () => {
    expect(
      modelRulesUnpublishDetail(meta({ customMessage: 'something else' }), new Map())
    ).toBeNull();
    expect(modelRulesUnpublishDetail({ unpublishedReason: 'other' }, new Map())).toBeNull();
  });

  it('reads subjects of Model rules in any enabled state, skipping regex rows', async () => {
    dbMock.dbRead.moderationRule.findMany.mockResolvedValue([
      {
        id: 446,
        definition: { type: 'semantic', subject: 'Example', description: '', aliases: [] },
      },
      { id: 9, definition: { match: 'x' } },
    ]);
    expect(await getModelRuleSubjects([446, 9])).toEqual(new Map([[446, 'Example']]));
    expect(dbMock.dbRead.moderationRule.findMany).toHaveBeenCalledWith({
      where: { id: { in: [446, 9] }, entityType: 'Model' },
      select: { id: true, definition: true },
    });
    expect(await getModelRuleSubjects([])).toEqual(new Map());
  });

  it('still names the rules by id when the subject lookup fails', async () => {
    dbMock.dbRead.moderationRule.findMany.mockRejectedValue(new Error('db down'));
    await expect(loadModelRulesUnpublishDetail(meta())).resolves.toEqual({
      source: 'literal',
      rules: [
        { id: 446, subject: null },
        { id: 9, subject: null },
      ],
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'text-scan' })
    );
  });

  it('skips the subject lookup when the unpublish was not the Model rules one', async () => {
    await expect(
      loadModelRulesUnpublishDetail(meta({ customMessage: 'something else' }))
    ).resolves.toBeNull();
    expect(dbMock.dbRead.moderationRule.findMany).not.toHaveBeenCalled();
  });
});
