import { describe, it, expect, vi } from 'vitest';
// Static import, same reasoning as get-models-raw.transient-503.test.ts.
import { getModelsRaw } from '~/server/services/model.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const { capturedQueries } = vi.hoisted(() => ({
  capturedQueries: [] as { text: string; values: unknown[] }[],
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (query: { text: string; values: unknown[] }) => {
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

/** The feed SQL for a Hot, base-filtered query, with the pin's id restriction applied. */
async function feedSql(pin: { onlyModelIds?: number[]; excludeModelIds?: number[] }) {
  capturedQueries.length = 0;
  await getModelsRaw({
    input: { browsingLevel: 1, take: 10, sort: 'Hot', baseModels: ['Flux.1 D'] } as never,
    ...pin,
  });
  expect(capturedQueries).toHaveLength(1);
  return capturedQueries[0];
}

const bound = ({ text, values }: { text: string; values: unknown[] }, re: RegExp) =>
  [...text.matchAll(re)].map((m) => values[Number(m[1]) - 1]);

describe('getModelsRaw official-checkpoint pin ids', () => {
  it('restricts to onlyModelIds', async () => {
    const q = await feedSql({ onlyModelIds: [10, 11] });
    expect(bound(q, /mm\."modelId" IN \(\$(\d+),\$\d+\)/g)).toEqual([10]);
    expect(bound(q, /mm\."modelId" IN \(\$\d+,\$(\d+)\)/g)).toEqual([11]);
  });

  it('drops excludeModelIds', async () => {
    const q = await feedSql({ excludeModelIds: [10, 11] });
    // One scalar parameter per id: this query path sent a bound array as a string (22P02 in prod).
    expect(bound(q, /mm\."modelId" NOT IN \(\$(\d+),\$\d+\)/g)).toEqual([10]);
    expect(bound(q, /mm\."modelId" NOT IN \(\$\d+,\$(\d+)\)/g)).toEqual([11]);
    expect(q.values.some(Array.isArray)).toBe(false);
  });

  it('adds no id predicate without either', async () => {
    const { text } = await feedSql({});
    expect(text).not.toMatch(/mm\."modelId" (NOT )?IN/);
  });
});
