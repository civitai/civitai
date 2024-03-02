import { MetricTimeframe } from '@prisma/client';
import { GetServerSideProps } from 'next';
import { ISitemapField, getServerSideSitemapLegacy } from 'next-sitemap';
import { ArticleSort, NsfwLevel } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const data = await getArticles({
    limit: 1000,
    period: MetricTimeframe.AllTime,
    sort: ArticleSort.MostBookmarks,
    periodMode: 'published',
    browsingLevel: NsfwLevel.PG,
  }).catch(() => ({ items: [] }));

  const fields: ISitemapField[] = data.items.map((article) => ({
    loc: `${getBaseUrl()}/articles/${article.id}/${slugit(article.title)}`,
    lastmod: article.publishedAt?.toISOString() ?? new Date().toISOString(),
  }));

  return getServerSideSitemapLegacy(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function ArticlesSitemap() {}
