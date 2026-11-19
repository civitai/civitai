import { describe, it, expect, vi } from 'vitest';
// Static import, same reasoning as get-models-raw.transient-503.test.ts.
import { getModelsRaw, getModelsWithVersions } from '~/server/services/model.service';
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

/**
 * A taken-down model is its owner's and moderators' alone on the site's feeds (model.getAll, profile
 * tabs, showcase sections). The public v1 API keeps listing it with its images dropped, as its docs
 * say; that is `includeWithheld`, which only `getModelsWithVersions` (the v1 path) sets.
 * The predicate's own semantics are pinned in model-withheld.sql.behavior.test.ts.
 */

const TAKEN_DOWN = /"mode" IS DISTINCT FROM \$(\d+)::"ModelModifier"/;

async function feedSql(user?: { id: number; isModerator?: boolean }, includeWithheld?: boolean) {
  capturedQueries.length = 0;
  await getModelsRaw({
    input: { browsingLevel: 1, take: 10, sort: 'Newest' } as never,
    user,
    includeWithheld,
  });
  expect(capturedQueries).toHaveLength(1);
  return capturedQueries[0];
}

const withheldClause = ({ text, values }: { text: string; values: unknown[] }) => {
  const m = text.replace(/\s+/g, ' ').match(TAKEN_DOWN);
  return m ? values[Number(m[1]) - 1] : undefined;
};

describe('getModelsRaw and taken-down models', () => {
  it.each([
    ['a signed-out visitor', undefined],
    ['a signed-in visitor', { id: 7 }],
    ['a moderator', { id: 8, isModerator: true }],
  ])(
    'filters them for %s (the owner/moderator exemption is inside the predicate)',
    async (_n, user) => {
      expect(withheldClause(await feedSql(user))).toBe('TakenDown');
    }
  );

  it('keeps them when the caller opts out', async () => {
    expect(withheldClause(await feedSql({ id: 7 }, true))).toBeUndefined();
  });

  // Control for the clause search: the Archived filter is still found where it always was.
  it('still drops Archived as before', async () => {
    const { text, values } = await feedSql({ id: 7 });
    const archived = text.replace(/\s+/g, ' ').match(/"mode" != \$(\d+)::"ModelModifier"/);
    expect(archived && values[Number(archived[1]) - 1]).toBe('Archived');
  });

  it('the public v1 path (getModelsWithVersions) keeps listing them', async () => {
    capturedQueries.length = 0;
    await getModelsWithVersions({
      input: { browsingLevel: 1, take: 10, sort: 'Newest' } as never,
      user: { id: 7 },
    }).catch(() => undefined); // only the feed query matters here
    expect(capturedQueries.length).toBeGreaterThan(0);
    expect(withheldClause(capturedQueries[0])).toBeUndefined();
  });
});
