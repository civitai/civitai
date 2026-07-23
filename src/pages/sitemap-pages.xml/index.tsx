import type { GetServerSideProps } from 'next';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithSitemap, type SitemapField } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';
import {
  getEcosystemSeoConfigBySlug,
  getLiveEcosystemSeoPages,
} from '~/shared/constants/ecosystem-seo.constants';

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

// Utility/commercial pages mostly stay canonical on green; the red sitemap
// includes content-browse routes plus the two pages that have a distinct
// red-canonical value: `/pricing` (red has its own pricing) and `/generate`
// (red supports both SFW and NSFW generation, a different value prop than
// green's SFW-only generator).
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
  '/pricing',
  '/generate',
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

  // Ecosystem SEO hub pages — the /ecosystems index plus each live page. These are indexed on
  // civitai.com (green) ONLY (the pages emit noindex on red/blue), so only green's sitemap lists
  // them. Only pages with a built config are emitted, so we never put a 404 into the sitemap.
  // Authoritative source: ECOSYSTEM_SEO_PAGES. lastmod is each config's hand-maintained
  // `updatedAt` (editorial change date — not the daily stats refresh); the index reflects
  // the most recently updated ecosystem.
  if (color === 'green') {
    const liveEcosystems = getLiveEcosystemSeoPages().flatMap((page) => {
      const config = getEcosystemSeoConfigBySlug(page.slug);
      return config ? [{ slug: page.slug, updatedAt: config.updatedAt }] : [];
    });
    const indexLastmod = liveEcosystems.reduce(
      (latest, e) => (e.updatedAt > latest ? e.updatedAt : latest),
      '0000-00-00'
    );
    fields.push({ loc: `${baseUrl}/ecosystems`, lastmod: indexLastmod });
    for (const eco of liveEcosystems) {
      fields.push({ loc: `${baseUrl}/ecosystems/${eco.slug}`, lastmod: eco.updatedAt });
    }
  }

  return respondWithSitemap(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function PagesSitemap() {}
