import type { GetServerSideProps } from 'next';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithSitemapIndex } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const baseUrl = getBaseUrl(color);

  const sitemaps = [
    `${baseUrl}/sitemap-pages.xml`,
    `${baseUrl}/sitemap-models.xml`,
    `${baseUrl}/sitemap-articles.xml`,
  ];

  return respondWithSitemapIndex(ctx, sitemaps);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function SitemapIndex() {}
