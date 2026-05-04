import type { GetServerSideProps } from 'next';
import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithSitemap, type SitemapField } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';
import {
  publicBrowsingLevelsFlag,
  sitemapNsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const browsingLevel =
    color === 'green' ? publicBrowsingLevelsFlag : sitemapNsfwBrowsingLevelsFlag;

  const data = await getArticles({
    limit: 1000,
    period: MetricTimeframe.AllTime,
    sort: ArticleSort.MostBookmarks,
    periodMode: 'published',
    browsingLevel,
  }).catch(() => ({ items: [] }));

  const baseUrl = getBaseUrl(color);
  const fields: SitemapField[] = data.items.map((article) => ({
    loc: `${baseUrl}/articles/${article.id}/${slugit(article.title)}`,
    lastmod: article.publishedAt?.toISOString() ?? new Date().toISOString(),
  }));

  return respondWithSitemap(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function ArticlesSitemap() {}
