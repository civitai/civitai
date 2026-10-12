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
  definition: { type: 'content', match },
});
const semantic = {
  id: 9,
  action: 'Block',
  reason: null,
  definition: { type: 'semantic', subject: 'Jane' },
};

const rows = [
  legacy(1, '/(?:\\b|\\s)Jane[\\s\\-_]*Doe(?:\\b|\\s)/gmi'),
  legacy(2, '/Jo+/gi'),
  legacy(3, '/John Roe/i', 'Approve'),
  { id: 4, action: 'Block', reason: null, definition: { type: 'and', rules: [] } },
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
