import { describe, it, expect, vi, beforeEach } from 'vitest';
// STATIC import, same reasoning as get-models.early-access-query-string.test.ts.
import { getModelsRaw } from '~/server/services/model.service';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const { capturedQueries } = vi.hoisted(() => ({
  capturedQueries: [] as { sql: string; values: unknown[] }[],
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (query: { sql: string; values: unknown[] }) => {
      capturedQueries.push(query);
      return { result: async () => [], cancel: async () => undefined };
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

async function sqlFor(input: Record<string, unknown>) {
  const { cursor, ...parsed } = getAllModelsSchema.parse({ browsingLevel: 1, ...input });
  await getModelsRaw({ input: { ...parsed, take: 10 } as never });
  return capturedQueries[0];
}

describe('getModelsRaw published range', () => {
  beforeEach(() => {
    capturedQueries.length = 0;
  });

  const december = { publishedFrom: '2024-12-01', publishedTo: '2024-12-31' };

  it('bounds publishedAt to [from, day after to)', async () => {
    const { sql, values } = await sqlFor({ types: ['LORA'], sort: 'Newest', ...december });

    expect(sql).toContain('m."publishedAt" >= ?');
    expect(sql).toContain('m."publishedAt" < ?');
    expect(values.map((v) => (v instanceof Date ? v.toISOString() : v))).toEqual(
      expect.arrayContaining(['2024-12-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'])
    );
  });

  it('drives from the materialized range, with the type filter inside it', async () => {
    const { sql } = await sqlFor({ types: ['LORA'], ...december });

    expect(sql).toContain('WITH ranged AS MATERIALIZED');
    expect(sql).toContain('JOIN ranged ON ranged."id" = m."id"');
    const cte = sql.slice(sql.indexOf('ranged AS MATERIALIZED'), sql.indexOf('SELECT\n      mm.'));
    expect(cte).toContain('"type" = ANY(');
  });

  it('keeps the same driver for another sort', async () => {
    const { sql } = await sqlFor({ sort: 'Most Downloaded', ...december });
    expect(sql).toContain('WITH ranged AS MATERIALIZED');
    expect(sql).toContain('ORDER BY');
  });

  it.each([
    ['half a range', { publishedFrom: '2024-12-01' }, /both/],
    ['a reversed range', { publishedFrom: '2024-12-31', publishedTo: '2024-12-01' }, /before/],
    [
      'a range wider than 31 days',
      { publishedFrom: '2024-12-01', publishedTo: '2025-01-02' },
      /31 days/,
    ],
  ])('refuses %s before any query is built', async (_name, range, message) => {
    await expect(sqlFor(range)).rejects.toThrow(message);
    expect(capturedQueries).toHaveLength(0);
  });

  // Control: the assertions above must be able to tell "no range" from "a range".
  it('emits neither the range nor the driver without one', async () => {
    const { sql } = await sqlFor({});
    expect(sql).not.toContain('m."publishedAt" >=');
    expect(sql).not.toContain('m."publishedAt" <');
    expect(sql).not.toContain('ranged');
  });
});
