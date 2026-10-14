import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const issued: string[] = [];
const bound: unknown[][] = [];
const findUnique = dbMock.dbRead.user.findUnique;

// Records the SQL and stops: what the query selects is the whole question here, and stopping
// keeps the rest of `getArticles` (stats, images, cosmetics) out of the test.
function recordQuery(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = Prisma.sql(strings, ...values);
  issued.push(sql.sql);
  bound.push(sql.values);
  throw new Error('query issued');
}

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
  dbMock.dbWrite.user.findUnique.mockResolvedValue(null);
  dbMock.dbRead.$queryRaw.mockImplementation(recordQuery);
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
