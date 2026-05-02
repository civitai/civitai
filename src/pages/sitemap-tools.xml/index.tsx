import type { GetServerSideProps } from 'next';
import { ToolSort } from '~/server/common/enums';
import { getAllTools } from '~/server/services/tool.service';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithSitemap, type SitemapField } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';

  // Tools have no nsfwLevel and live on the SFW canonical only.
  if (color !== 'green') return respondWithSitemap(ctx, []);

  const data = await getAllTools({
    sort: ToolSort.Newest,
    limit: 1000,
  }).catch(() => ({ items: [] }));

  const baseUrl = getBaseUrl(color);
  const fields: SitemapField[] = data.items.map((tool) => ({
    loc: `${baseUrl}/tools/${slugit(tool.name)}`,
    lastmod: tool.createdAt.toISOString(),
  }));

  return respondWithSitemap(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function ToolsSitemap() {}
