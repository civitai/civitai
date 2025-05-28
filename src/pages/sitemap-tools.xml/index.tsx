import type { GetServerSideProps } from 'next';
import type { ISitemapField } from 'next-sitemap';
import { getServerSideSitemapLegacy } from 'next-sitemap';
import { ToolSort } from '~/server/common/enums';
import { getAllTools } from '~/server/services/tool.service';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const data = await getAllTools({
    sort: ToolSort.Newest,
    limit: 1000,
  }).catch(() => ({ items: [] }));

  const fields: ISitemapField[] = data.items.map((tool) => ({
    loc: `${getBaseUrl()}/tools/${slugit(tool.name)}`,
    lastmod: tool.createdAt.toISOString(),
  }));

  return getServerSideSitemapLegacy(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function ToolsSitemap() {}
