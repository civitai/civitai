import { describe, it, expect, vi } from 'vitest';
// Static import, same reasoning as get-models-raw.transient-503.test.ts.
import { getModelsRaw } from '~/server/services/model.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
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

const OWNER = 3300;
const STRANGER = 4400;

const MINOR = /\w+\."minor" = false(?: OR mm\."userId" = \$(\d+)\))?/;

/**
 * The minor clause's owner arm, as the id bound into it, or `null` when there is none. `username`
 * scopes the feed to a creator's profile, so the stranger case can tell the viewer from the owner.
 */
async function exemptedIdFor(viewer: { id: number } | undefined, profile?: string) {
  capturedQueries.length = 0;
  if (profile) dbMock.dbRead.user.findUnique.mockResolvedValueOnce({ id: OWNER } as never);
  await getModelsRaw({
    input: { browsingLevel: 1, take: 10, disableMinor: true, username: profile } as never,
    user: viewer ? ({ ...viewer, isModerator: false } as never) : undefined,
  });
  expect(capturedQueries).toHaveLength(1);
  const { text, values } = capturedQueries[0];
  const match = text.match(MINOR);
  expect(match, `no minor clause in: ${text}`).not.toBeNull();
  return match![1] ? values[Number(match![1]) - 1] : null;
}

describe('getModelsRaw minor exclusion', () => {
  it('exempts the signed-in viewer by id', async () => {
    expect(await exemptedIdFor({ id: OWNER })).toBe(OWNER);
  });

  it("exempts the viewer, not the profile owner, on someone else's profile", async () => {
    expect(await exemptedIdFor({ id: STRANGER }, 'owner')).toBe(STRANGER);
  });

  it('exempts no one for a signed-out viewer', async () => {
    expect(await exemptedIdFor(undefined, 'owner')).toBeNull();
  });
});
