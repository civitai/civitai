import type { GetServerSideProps } from 'next';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithText } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';

const disallowPaths = [
  '/*/create',
  '/api/*',
  '/discord/*',
  '/dmca/*',
  '/intent/*',
  '/models/train',
  '/models/*/wizard',
  '/models/*/model-versions/*/wizard',
  '/moderator/*',
  '/payment/*',
  '/redirect',
  '/search/*',
  '/testing/*',
  '/user/account',
  '/user/downloads',
  '/user/notifications',
  '/user/transactions',
  '/user/buzz-dashboard',
  '/user/vault',
  '/user/membership',
  '/user/stripe-connect/onboard',
  '/user/earn-potential',
  '/tipalti/*',
  '/research/*',
  '/claim/*',
  '/collections/youtube/auth',
  '/questions/*',
];

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const baseUrl = getBaseUrl(color);

  const lines: string[] = [];

  lines.push('# *');
  lines.push('User-agent: *');
  lines.push('Allow: /api/trpc/*');
  for (const path of disallowPaths) lines.push(`Disallow: ${path}`);
  lines.push('');

  lines.push('# Login pages — high alternate-canonical volume from /login?returnUrl=... variants');
  lines.push('Disallow: /login');
  lines.push('');

  lines.push(
    '# Ad/affiliate tracking parameters — canonical handles correctness, but each',
    '# variant wastes crawl budget'
  );
  lines.push('Disallow: /*?adid=');
  lines.push('Disallow: /*&adid=');
  lines.push('');

  lines.push('# Site-search query URLs — thin/duplicate content, low SEO value');
  lines.push('Disallow: /*?query=');
  lines.push('Disallow: /*&query=');
  lines.push('');

  lines.push('# Host');
  lines.push(`Host: ${baseUrl}`);
  lines.push('');

  lines.push('# Sitemaps');
  lines.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  lines.push(`Sitemap: ${baseUrl}/sitemap-pages.xml`);
  lines.push(`Sitemap: ${baseUrl}/sitemap-articles.xml`);
  lines.push(`Sitemap: ${baseUrl}/sitemap-models.xml`);
  // Tools live on the SFW canonical only.
  if (color === 'green') lines.push(`Sitemap: ${baseUrl}/sitemap-tools.xml`);

  return respondWithText(ctx, lines.join('\n') + '\n');
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function Robots() {}
