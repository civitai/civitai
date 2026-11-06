import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getKyselyWithoutLag: vi.fn(async () => (await import('~/server/db/kyselyDb')).kyselyRead),
}));
// The post detail's two Kysely statements; their visibility, against a real database, is pinned in
// hot-reads-6.kysely-parity.test.ts.
const { getPostDetailRow, getUserWithCosmetics } = vi.hoisted(() => ({
  getPostDetailRow: vi.fn(),
  getUserWithCosmetics: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getPostDetailRow,
  getUserWithCosmetics,
}));

const { getPostDetail } = await import('~/server/services/post.service');
const { kyselyRead } = await import('~/server/db/kyselyDb');

const findFirst = dbMock.dbRead.post.findFirst;
const publishedPost = { id: 1, publishedAt: new Date(0), detail: null, tags: [] };

describe('getPostDetail visibility', () => {
  beforeEach(() => {
    findFirst.mockReset().mockResolvedValue(publishedPost as never);
    getPostDetailRow.mockReset().mockResolvedValue({ id: 1, userId: 5 });
    // A post whose user row is gone: the Kysely read answers `undefined`, so the Prisma read runs.
    getUserWithCosmetics.mockReset().mockResolvedValue(undefined);
  });

  it('hands the Kysely read the viewer it scopes the post by', async () => {
    const viewer = { id: 42, isModerator: false };
    await getPostDetail({ id: 1, user: viewer as never });

    expect(getPostDetailRow).toHaveBeenCalledTimes(1);
    expect(getPostDetailRow.mock.calls[0][0]).toBe(kyselyRead);
    expect(getPostDetailRow.mock.calls[0][1]).toEqual({ id: 1, viewer, now: expect.any(Date) });
  });

  it('scopes an anonymous lookup to published, scanned posts only (the Prisma fallback)', async () => {
    await getPostDetail({ id: 1 });

    expect(getPostDetailRow.mock.calls[0][1]).toMatchObject({ id: 1, viewer: undefined });
    const { where } = findFirst.mock.calls[0][0] as { where: unknown };
    expect(where).toEqual({
      id: 1,
      OR: [{ publishedAt: { lt: expect.any(Date) }, nsfwLevel: { not: 0 } }],
    });
  });

  it('scopes the owner and collection-manager branches to the signed-in viewer (the Prisma fallback)', async () => {
    await getPostDetail({ id: 1, user: { id: 42, isModerator: false } as never });

    const { where } = findFirst.mock.calls[0][0] as { where: { OR: unknown[] } };
    expect(where.OR).toContainEqual({ userId: 42 });
    expect(JSON.stringify(where)).toContain('"contributors":{"some":{"userId":42');
  });
});
