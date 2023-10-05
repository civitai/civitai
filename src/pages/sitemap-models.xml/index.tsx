import { MetricTimeframe, ModelStatus } from '@prisma/client';
import { GetServerSideProps } from 'next';
import { ISitemapField, getServerSideSitemapLegacy } from 'next-sitemap';
import { BrowsingMode, ModelSort } from '~/server/common/enums';
import { getModels } from '~/server/services/model.service';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const data = await getModels({
    input: {
      browsingMode: BrowsingMode.SFW,
      take: 1000,
      period: MetricTimeframe.AllTime,
      sort: ModelSort.HighestRated,
      status: [ModelStatus.Published],
      periodMode: 'published',
      favorites: false,
      hidden: false,
    },
    select: {
      id: true,
      name: true,
      publishedAt: true,
    },
  }).catch(() => ({ items: [] }));

  const fields: ISitemapField[] = data.items.map((model) => ({
    loc: `${getBaseUrl()}/models/${model.id}/${slugit(model.name)}`,
    lastmod: model.publishedAt?.toISOString() ?? new Date().toISOString(),
  }));

  return getServerSideSitemapLegacy(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function ModelsSitemap() {}
