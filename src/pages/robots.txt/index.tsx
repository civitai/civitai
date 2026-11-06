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
];

// The Allow/Disallow rules every crawler gets. A crawler obeys only the most specific `User-agent`
// group that matches it and ignores the `*` group entirely, so any named group must repeat these
// rules or the named crawler would be allowed everywhere. Both groups below render from this list
// so they cannot drift apart.
const ruleSections: { comment?: string[]; rules: string[] }[] = [
  { rules: ['Allow: /api/trpc/*', ...disallowPaths.map((path) => `Disallow: ${path}`)] },
  {
    comment: ['# Login pages — high alternate-canonical volume from /login?returnUrl=... variants'],
    rules: ['Disallow: /login'],
  },
  {
    comment: [
      '# Ad/affiliate tracking parameters — canonical handles correctness, but each',
      '# variant wastes crawl budget',
    ],
    rules: ['Disallow: /*?adid=', 'Disallow: /*&adid='],
  },
  {
    comment: ['# Site-search query URLs — thin/duplicate content, low SEO value'],
    rules: ['Disallow: /*?query=', 'Disallow: /*&query='],
  },
  {
    // Each of these tabs is a full server render of a listing that search engines send almost no
    // visitors to. Disallowing the tab does not block the items it lists, which keep their own
    // URLs. The profile page and its models, images, videos, posts and collections tabs stay
    // crawlable: they carry most of the profile search traffic.
    comment: [
      '# Low-value profile tabs — the items they list stay crawlable at their own URLs',
    ],
    rules: [
      'Disallow: /user/*/storylines',
      'Disallow: /user/*/sticker-book',
      'Disallow: /user/*/comics',
      'Disallow: /user/*/3d-models',
      'Disallow: /user/*/articles',
      'Disallow: /user/*/followers',
      'Disallow: /user/*/following',
    ],
  },
  {
    // Image (and video) detail pages are `noindex` on every domain (see ImageDetail2), so a crawl
    // of one is a server render that cannot earn a search result. Image ids are numeric, so one
    // rule per leading digit blocks the detail pages while the `/images` index and the static
    // files in public/images (site logo, app icons, og:images) stay fetchable. Nothing directly
    // under public/images may start with a digit.
    comment: ['# Image detail pages — noindex on every domain, so a crawl only costs a render'],
    rules: Array.from({ length: 10 }, (_, digit) => `Disallow: /images/${digit}`),
  },
];

// AI training crawlers request HTML pages continuously. Crawl-delay asks each of them to wait 30 s
// between requests; it slows them down, it does not block them.
const slowCrawlers = ['GPTBot', 'ClaudeBot', 'Amazonbot', 'meta-externalagent'];
const slowCrawlerDelaySeconds = 30;

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const baseUrl = getBaseUrl(color);

  const lines: string[] = [];

  // One contiguous group (no blank lines inside it): the same rules as `*`, plus the delay.
  lines.push('# AI training crawlers — same rules as *, plus a crawl delay');
  for (const agent of slowCrawlers) lines.push(`User-agent: ${agent}`);
  lines.push(`Crawl-delay: ${slowCrawlerDelaySeconds}`);
  for (const section of ruleSections) lines.push(...section.rules);
  lines.push('');

  lines.push('# *');
  lines.push('User-agent: *');
  for (const section of ruleSections) {
    if (section.comment) lines.push(...section.comment);
    lines.push(...section.rules);
    lines.push('');
  }

  lines.push('# Host');
  lines.push(`Host: ${baseUrl}`);
  lines.push('');

  lines.push('# Sitemaps');
  lines.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  lines.push(`Sitemap: ${baseUrl}/sitemap-pages.xml`);
  lines.push(`Sitemap: ${baseUrl}/sitemap-articles.xml`);
  lines.push(`Sitemap: ${baseUrl}/sitemap-models.xml`);

  return respondWithText(ctx, lines.join('\n') + '\n');
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function Robots() {}
