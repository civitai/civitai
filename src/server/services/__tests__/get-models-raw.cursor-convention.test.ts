import { describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import { getModelsRaw } from '~/server/services/model.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const { captured, rowsToReturn } = vi.hoisted(() => ({
  captured: [] as { sql: string; values: unknown[] }[],
  rowsToReturn: [] as Record<string, unknown>[],
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (query: { sql: string; values: unknown[] }) => {
      captured.push(query);
      return {
        result: async () => rowsToReturn.map((r) => ({ ...r })),
        cancel: async () => undefined,
      };
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
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: {
    fetch: vi.fn(async (ids: number[]) =>
      Object.fromEntries(
        ids.map((id) => [
          String(id),
          {
            versions: [
              {
                id: id * 10,
                status: 'Published',
                nsfwLevel: 1,
                baseModel: 'SDXL 1.0',
                availability: 'Public',
              },
            ],
            tags: [],
          },
        ])
      )
    ),
  },
}));

const rank = {
  downloadCount: 0,
  thumbsUpCount: 0,
  thumbsDownCount: 0,
  commentCount: 0,
  collectedCount: 0,
  tippedAmountCount: 0,
};
const row = (id: number) => ({
  id,
  name: `model ${id}`,
  type: 'Checkpoint',
  userId: 1,
  rank,
  meta: null,
  cursorId: `2024-01-15T00:00:00.000Z|${id}`,
});

/**
 * `getModelsRaw` fetches `take + 1` rows and hands the extra one out as `nextCursor`; the keyset
 * predicate in `pagination-helpers.ts` is inclusive on the last sort field for exactly that reason.
 * Either convention works alone — changing one side without the other is the bug, and the cursor
 * side has flipped twice before (db2804499e, 9a76e23b3d). The helper half is pinned in
 * `src/server/utils/pagination-helpers.test.ts`.
 */
describe('getModelsRaw — nextCursor is the lookahead row', () => {
  it('asks for take + 1 rows, returns take, and the cursor is the row it dropped', async () => {
    const take = 3;
    rowsToReturn.splice(0, rowsToReturn.length, ...[11, 12, 13, 14].map(row));
    captured.length = 0;

    const result = await getModelsRaw({
      input: { browsingLevel: 1, take, sort: 'Newest', period: 'AllTime' } as never,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].values).toContain(take + 1);
    expect(result.items.map((m) => m.id)).toEqual([11, 12, 13]);
    expect(result.nextCursor).toBe('2024-01-15T00:00:00.000Z|14');
  });

  it('no extra row means no cursor', async () => {
    rowsToReturn.splice(0, rowsToReturn.length, ...[11, 12].map(row));
    const result = await getModelsRaw({
      input: { browsingLevel: 1, take: 3, sort: 'Newest', period: 'AllTime' } as never,
    });
    expect(result.items.map((m) => m.id)).toEqual([11, 12]);
    expect(result.nextCursor).toBeUndefined();
  });
});
