import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { PostSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const { issued } = vi.hoisted(() => ({ issued: [] as Prisma.Sql[] }));

class QueryIssued extends Error {}
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  queryCache: () => async (sql: Prisma.Sql) => {
    issued.push(sql);
    throw new QueryIssued();
  },
}));

const { getPostsInfinite } = await import('~/server/services/post.service');

const MARCH_2025 = { start: new Date(Date.UTC(2025, 2, 1)), end: new Date(Date.UTC(2025, 3, 1)) };

async function jumpClause(input: Partial<Parameters<typeof getPostsInfinite>[0]>) {
  await getPostsInfinite({
    limit: 10,
    period: MetricTimeframe.AllTime,
    periodMode: 'published',
    browsingLevel: 1,
    username: 'creator',
    jumpTo: '2025-03',
    ...input,
  } as Parameters<typeof getPostsInfinite>[0]).catch((error) => {
    if (!(error instanceof QueryIssued)) throw error;
  });
  expect(issued).toHaveLength(1);
  const { sql, values } = issued[0];
  // Each `?` is one bound value, in order, so the clause's own placeholder names its value.
  const at = sql.search(/p\."publishedAt" (<|>=) \?/);
  if (at === -1) return undefined;
  const operator = /p\."publishedAt" (<|>=) \?/.exec(sql.slice(at))![1];
  const placeholder = sql.slice(0, at).split('?').length - 1;
  return { operator, edge: values[placeholder] };
}

beforeEach(() => {
  issued.length = 0;
  dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 99 });
});

describe('getPostsInfinite jump to month', () => {
  it('starts Newest before the month ends and Oldest where it starts', async () => {
    expect(await jumpClause({ sort: PostSort.Newest })).toEqual({
      operator: '<',
      edge: MARCH_2025.end,
    });
    issued.length = 0;
    expect(await jumpClause({ sort: PostSort.Oldest })).toEqual({
      operator: '>=',
      edge: MARCH_2025.start,
    });
  });

  it('ignores the jump on a ranked sort, in the drafts queue and off a creator', async () => {
    expect(await jumpClause({ sort: PostSort.MostReactions })).toBeUndefined();
    issued.length = 0;
    expect(await jumpClause({ sort: PostSort.Newest, draftOnly: true })).toBeUndefined();
    issued.length = 0;
    expect(await jumpClause({ sort: PostSort.Newest, username: undefined })).toBeUndefined();
  });
});
