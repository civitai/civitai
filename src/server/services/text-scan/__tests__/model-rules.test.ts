import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  bustFetchThroughCache: vi.fn(),
}));

const {
  filterModelRuleMatches,
  getModelRuleSnapshots,
  getModelRulesForPrompt,
  modelRulesFingerprint,
  renderModelRulesBlock,
} = await import('~/server/services/text-scan/model-rules');

const rule = (over: Record<string, unknown> = {}) => ({
  id: 1,
  subject: 'Example Franchise',
  description: 'Characters from the Example books',
  aliases: ['Hero One', 'Hero Two'],
  updatedAt: 1000,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('getModelRulesForPrompt', () => {
  it('returns enabled semantic rules and skips rows still holding a regex definition', async () => {
    dbMock.dbRead.moderationRule.findMany.mockResolvedValue([
      {
        id: 4,
        order: null,
        updatedAt: new Date(5000),
        definition: { type: 'semantic', subject: 'Jane Doe', description: 'Likeness claim' },
      },
      {
        id: 5,
        order: null,
        updatedAt: new Date(6000),
        definition: { type: 'or', rules: [{ type: 'content', match: '/x/gi', target: ['name'] }] },
      },
    ]);

    await expect(getModelRulesForPrompt()).resolves.toEqual([
      { id: 4, subject: 'Jane Doe', description: 'Likeness claim', aliases: [], updatedAt: 5000 },
    ]);
    expect(dbMock.dbRead.moderationRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityType: 'Model', enabled: true } })
    );
  });
});

describe('renderModelRulesBlock', () => {
  it('lists each rule by id with its description and aliases', () => {
    expect(
      renderModelRulesBlock([
        rule(),
        rule({ id: 9, subject: 'Solo', description: '', aliases: [] }),
      ])
    ).toBe(
      [
        '### Rules',
        '[1] Example Franchise — Characters from the Example books. Also known as: Hero One, Hero Two.',
        '[9] Solo',
      ].join('\n')
    );
  });
});

describe('modelRulesFingerprint', () => {
  it('changes when a rule is edited, added or removed, and only then', () => {
    const base = modelRulesFingerprint([rule(), rule({ id: 2 })]);
    expect(modelRulesFingerprint([rule(), rule({ id: 2 })])).toBe(base);
    expect(modelRulesFingerprint([rule(), rule({ id: 2, updatedAt: 2000 })])).not.toBe(base);
    expect(modelRulesFingerprint([rule()])).not.toBe(base);
  });
});

describe('filterModelRuleMatches', () => {
  it('drops ids the prompt did not list and duplicate matches', () => {
    const { kept, dropped } = filterModelRuleMatches(
      [
        { ruleId: 1, reason: 'a' },
        { ruleId: 99, reason: 'invented' },
        { ruleId: 1, reason: 'again' },
        { ruleId: 2, reason: 'b' },
      ],
      [1, 2]
    );
    expect(kept).toEqual([
      { ruleId: 1, reason: 'a' },
      { ruleId: 2, reason: 'b' },
    ]);
    expect(dropped).toEqual([99]);
  });

  it('keeps nothing when the submit recorded no rule ids', () => {
    expect(filterModelRuleMatches([{ ruleId: 1, reason: 'a' }], undefined).kept).toEqual([]);
  });
});

describe('getModelRuleSnapshots', () => {
  it('reads the matched rules by id from the primary, enabled only', async () => {
    dbMock.dbWrite.moderationRule.findMany.mockResolvedValue([
      { id: 3, definition: { type: 'semantic', subject: 'S', description: 'D', aliases: ['A'] } },
    ]);
    await expect(getModelRuleSnapshots([3])).resolves.toEqual([
      { id: 3, subject: 'S', description: 'D', aliases: ['A'] },
    ]);
    expect(dbMock.dbWrite.moderationRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [3] }, entityType: 'Model', enabled: true } })
    );
  });

  it('skips the query for no ids', async () => {
    await expect(getModelRuleSnapshots([])).resolves.toEqual([]);
    expect(dbMock.dbWrite.moderationRule.findMany).not.toHaveBeenCalled();
  });
});
