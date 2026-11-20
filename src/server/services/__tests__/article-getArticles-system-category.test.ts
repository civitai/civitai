import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// getArticles hands the article category list to the tag filter: without it a category id would
// match only the author's pick. The predicates themselves run on PGlite in
// article-system-category-filter.behavior.test.ts.

const STORY = 11;

vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  getEventDecorationsForEntity: vi.fn(async () => ({})),
  getCosmeticsForEntity: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCategoryTags: async () => [{ id: STORY, name: 'story' }],
}));

import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const base = { limit: 10, sort: ArticleSort.Newest, period: MetricTimeframe.AllTime };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  dbMock.dbRead.image.findMany.mockResolvedValue([]);
});

const articleQuery = async (filter: Record<string, unknown>) => {
  await getArticles({ ...base, ...filter } as never);
  const [strings, ...values] = dbMock.dbRead.$queryRaw.mock.calls[0] as [
    TemplateStringsArray,
    ...unknown[]
  ];
  return Prisma.sql(strings, ...values);
};

describe('getArticles category filters', () => {
  it("matches a category id on the article's system category", async () => {
    const query = await articleQuery({ tags: [STORY] });
    expect(query.text).toMatch(/a\."systemCategoryId" IN \(\$\d+\) OR/);
    expect(query.values).toContain(STORY);
  });

  it('hides an article whose system category the viewer hides', async () => {
    const query = await articleQuery({ excludedTagIds: [STORY] });
    expect(query.text).toMatch(/a\."systemCategoryId" NOT IN \(\$\d+\)/);
  });
});
