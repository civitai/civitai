import type * as DbClient from '~/server/db/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticleSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const { findUnique, issued, bound } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  issued: [] as string[],
  bound: [] as unknown[][],
}));

// Records the SQL and stops: what the query selects is the whole question here, and stopping
// keeps the rest of `getArticles` (stats, images, cosmetics) out of the test.
vi.mock('~/server/db/client', async (importOriginal) => {
  const { Prisma } = await import('@prisma/client');
  const queryRaw = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    issued.push(sql.sql);
    bound.push(sql.values);
    throw new Error('query issued');
  };
  return {
    ...(await importOriginal<typeof DbClient>()),
    dbRead: { user: { findUnique }, $queryRaw: queryRaw },
    dbWrite: { user: { findUnique } },
  };
});

const { getArticles } = await import('~/server/services/article.service');

const viewer = { id: 7, username: 'john-doe', isModerator: false };

const baseInput = {
  limit: 10,
  sort: ArticleSort.Newest,
  period: MetricTimeframe.AllTime,
  periodMode: 'published' as const,
  browsingLevel: 1,
};

async function run(input: Partial<Parameters<typeof getArticles>[0]>) {
  await getArticles({ ...baseInput, ...input } as Parameters<typeof getArticles>[0]).catch(
    () => undefined
  );
}

beforeEach(() => {
  findUnique.mockReset();
  issued.length = 0;
  bound.length = 0;
});

describe('getArticles user scope', () => {
  it('treats a matching username that belongs to another account as that account', async () => {
    findUnique.mockResolvedValue({ id: 99 });

    await run({ username: 'johndoe', sessionUser: viewer });

    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain(`u.id = ?`);
    expect(bound[0]).toContain(99);
    expect(issued[0]).toContain(`a."status" = ?::"ArticleStatus"`);
    expect(issued[0]).toContain(`a."ingestion" = 'Scanned'::"ArticleIngestionStatus" OR`);
  });

  it('serves the owner their own profile, scoped to them', async () => {
    findUnique.mockResolvedValue({ id: viewer.id });

    await run({ username: 'john-doe', sessionUser: viewer });

    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain(`u.id = ?`);
    expect(bound[0]).toContain(viewer.id);
    expect(issued[0]).not.toContain(`a."status" = ?::"ArticleStatus"`);
    expect(issued[0]).not.toContain(`a."ingestion" = 'Scanned'`);
  });

  it('issues no query for a username with no account', async () => {
    findUnique.mockResolvedValue(null);

    await run({ username: 'nobody', sessionUser: viewer });

    expect(issued).toEqual([]);
  });
});
