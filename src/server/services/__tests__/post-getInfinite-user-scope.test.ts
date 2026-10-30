import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { PostSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

const { issued, bound } = vi.hoisted(() => ({
  issued: [] as string[],
  bound: [] as unknown[][],
}));

const findFirst = dbMock.dbRead.user.findFirst;

// Records the SQL and stops: what the query selects is the whole question here, and stopping
// keeps the rest of `getPostsInfinite` (images, stats, cosmetics) out of the test.
class QueryIssued extends Error {}
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  queryCache: () => async (sql: Prisma.Sql) => {
    issued.push(sql.sql);
    bound.push(sql.values);
    throw new QueryIssued();
  },
}));

const { getPostsInfinite } = await import('~/server/services/post.service');

const viewer = { id: 7, username: 'Alice', isModerator: false } as SessionUser;

const baseInput = {
  limit: 10,
  sort: PostSort.Newest,
  period: MetricTimeframe.AllTime,
  periodMode: 'published' as const,
  browsingLevel: 1,
};

async function run(input: Partial<Parameters<typeof getPostsInfinite>[0]>) {
  return getPostsInfinite({ ...baseInput, ...input } as Parameters<typeof getPostsInfinite>[0])
    .then((result) => ({ result }))
    .catch((error) => {
      if (error instanceof QueryIssued) return { result: undefined };
      throw error;
    });
}

beforeEach(() => {
  findFirst.mockReset();
  issued.length = 0;
  bound.length = 0;
});

describe('getPostsInfinite user scope', () => {
  it('returns nothing for a username with no account, even one that resembles the viewer', async () => {
    findFirst.mockResolvedValue(null);

    const { result } = await run({ username: 'alice', user: viewer });

    expect(issued).toEqual([]);
    expect(result).toEqual({ items: [] });
  });

  it('returns nothing for a username with no account, for an anonymous viewer', async () => {
    findFirst.mockResolvedValue(null);

    const { result } = await run({ username: 'nobody' });

    expect(issued).toEqual([]);
    expect(result).toEqual({ items: [] });
  });

  it('treats a matching username that belongs to another account as that account', async () => {
    findFirst.mockResolvedValue({ id: 99 });

    await run({ username: 'alice', user: viewer });

    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain(`p."userId" = ?`);
    expect(bound[0]).toContain(99);
    expect(issued[0]).toContain(`p."availability" != 'Private'`);
    expect(issued[0]).toContain(`p."publishedAt" <= NOW()`);
    expect(issued[0]).not.toContain(`p."publishedAt" IS NULL`);
  });

  it('serves the owner their own profile, scoped to them', async () => {
    findFirst.mockResolvedValue({ id: viewer.id });

    await run({ username: 'Alice', user: viewer, draftOnly: true });

    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain(`p."userId" = ?`);
    expect(issued[0]).not.toContain(`p."availability" != 'Private'`);
    expect(issued[0]).toContain(`p."publishedAt" IS NULL`);
  });

  it("searches the owner's own posts by title", async () => {
    findFirst.mockResolvedValue({ id: viewer.id });

    await run({ username: 'Alice', user: viewer, query: 'Cat' });

    expect(issued[0]).toContain('p.title ILIKE ?');
    expect(bound[0]).toContain('Cat%');
  });

  it('keeps the public feed unscoped and public when no username is given', async () => {
    await run({ user: viewer });

    expect(findFirst).not.toHaveBeenCalled();
    expect(issued).toHaveLength(1);
    expect(issued[0]).not.toContain(`p."userId" = ?`);
    expect(issued[0]).toContain(`p."availability" != 'Private'`);
  });
});
