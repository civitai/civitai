import type { GetServerSideProps } from 'next';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithSitemap, type SitemapField } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';

const greenPaths: string[] = [
  '/',
  '/models',
  '/articles',
  '/images',
  '/posts',
  '/videos',
  '/comics',
  '/comics/browse',
  '/collections',
  '/bounties',
  '/tools',
  '/builds',
  '/challenges',
  '/challenges/winners',
  '/events',
  '/changelog',
  '/newsroom',
  '/creator-program',
  '/safety',
  '/pricing',
  '/support',
  '/shop',
  '/gift-cards',
  '/buzz/marketplace',
  '/generate',
  '/train',
  '/games/chopped',
  '/games/knights-of-new-order',
  '/product/link',
  '/product/odor',
  '/product/vault',
];

// Utility/commercial pages stay canonical on green; only content-browse routes
// appear on the red sitemap.
const redPaths: string[] = [
  '/',
  '/models',
  '/articles',
  '/images',
  '/posts',
  '/videos',
  '/comics',
  '/comics/browse',
  '/collections',
];

const pathsByColor: Record<ColorDomain, string[]> = {
  green: greenPaths,
  blue: redPaths,
  red: redPaths,
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const baseUrl = getBaseUrl(color);
  const paths = pathsByColor[color];

  const fields: SitemapField[] = paths.map((path) => ({
    loc: path === '/' ? baseUrl : `${baseUrl}${path}`,
  }));

  return respondWithSitemap(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function PagesSitemap() {}
