import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { REDIS_KEYS } from '~/server/redis/client';

const { bustFetchThroughCache } = vi.hoisted(() => ({ bustFetchThroughCache: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  bustFetchThroughCache,
}));

const { convertLegacyModelRules, countLegacyModelRules } = await import(
  '~/server/services/text-scan/model-rules-convert'
);

const legacy = (id: number, match: string, action = 'Block', reason: string | null = 'Why') => ({
  id,
  action,
  reason,
  enabled: true,
  definition: { type: 'content', match },
});
const semantic = {
  id: 9,
  action: 'Block',
  reason: null,
  enabled: true,
  definition: { type: 'semantic', subject: 'Jane' },
};

const rows = [
  legacy(1, '/(?:\\b|\\s)Jane[\\s\\-_]*Doe(?:\\b|\\s)/gmi'),
  legacy(2, '/Jo+/gi'),
  legacy(3, '/John Roe/i', 'Approve'),
  { id: 4, action: 'Block', reason: null, enabled: true, definition: { type: 'and', rules: [] } },
  semantic,
];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.moderationRule.findMany.mockResolvedValue(rows);
  dbMock.dbWrite.moderationRule.update.mockResolvedValue({});
});

describe('countLegacyModelRules', () => {
  it('counts clean and flagged rules, skips semantic rows and writes nothing', async () => {
    expect(await countLegacyModelRules()).toEqual({ legacy: 4, clean: 1, flagged: 3 });
    expect(dbMock.dbWrite.moderationRule.update).not.toHaveBeenCalled();
    expect(bustFetchThroughCache).not.toHaveBeenCalled();
  });
});

describe('convertLegacyModelRules', () => {
  it('converts in place, keeps the regex, disables flagged and Approve rows as Block', async () => {
    expect(await convertLegacyModelRules()).toEqual({ converted: 4, flagged: 3 });
    const calls = dbMock.dbWrite.moderationRule.update.mock.calls.map(([arg]) => arg);
    expect(calls.map((c) => c.where.id)).toEqual([1, 2, 3, 4]);
    expect(calls[0].data).toMatchObject({
      action: 'Block',
      definition: { type: 'semantic', subject: 'Jane Doe', legacyMatch: rows[0].definition },
    });
    expect(calls[0].data.enabled).toBeUndefined();
    expect(calls[0].data.definition.needsAttention).toBeUndefined();
    for (const flagged of calls.slice(1)) {
      expect(flagged.data).toMatchObject({
        action: 'Block',
        enabled: false,
        definition: { type: 'semantic', needsAttention: true },
      });
    }
    expect(calls.every((c) => c.where.entityType === 'Model')).toBe(true);
  });

  it('appends a version for each converted rule in the same transaction as its update', async () => {
    const order: string[] = [];
    dbMock.dbWrite.moderationRule.update.mockImplementation(async ({ where }) => {
      order.push(`update:${where.id}`);
      return {};
    });
    dbMock.dbWrite.moderationRuleVersion.create.mockImplementation(async ({ data }) => {
      order.push(`version:${data.ruleId}`);
      return {};
    });
    await convertLegacyModelRules(77);
    expect(order).toEqual([
      'update:1',
      'version:1',
      'update:2',
      'version:2',
      'update:3',
      'version:3',
      'update:4',
      'version:4',
    ]);
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(4);
    const versions = dbMock.dbWrite.moderationRuleVersion.create.mock.calls.map(([a]) => a.data);
    expect(versions[0]).toMatchObject({
      ruleId: 1,
      action: 'Block',
      enabled: true,
      createdById: 77,
      definition: { type: 'semantic', subject: 'Jane Doe' },
    });
    expect(versions[1]).toMatchObject({ ruleId: 2, enabled: false });
    expect(versions[2]).toMatchObject({
      ruleId: 3,
      enabled: false,
      definition: { needsAttention: true },
    });
  });

  it('records the system actor when no one is named', async () => {
    await convertLegacyModelRules();
    const [first] = dbMock.dbWrite.moderationRuleVersion.create.mock.calls[0];
    expect(first.data.createdById).toBe(-1);
  });

  it('busts the Model rules cache after writing', async () => {
    await convertLegacyModelRules();
    expect(bustFetchThroughCache).toHaveBeenCalledWith(REDIS_KEYS.CACHES.MOD_RULES.MODELS);
  });

  it('is a no-op, without a cache bust, when nothing is left to convert', async () => {
    dbMock.dbWrite.moderationRule.findMany.mockResolvedValue([semantic]);
    expect(await convertLegacyModelRules()).toEqual({ converted: 0, flagged: 0 });
    expect(dbMock.dbWrite.moderationRule.update).not.toHaveBeenCalled();
    expect(bustFetchThroughCache).not.toHaveBeenCalled();
  });
});
